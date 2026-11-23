import fs from 'node:fs'
import { RedisQueue } from './redisQueue.js'
import { VERSION } from './configuration.js'
import type { Adapter, BatchResult } from './adapter.js'
import { CliAdapter } from './cliAdapter.js'

export interface WorkerOptions {
  key: string
  adapter: Adapter
  batchSize?: number
  keyRerun?: string | null
  keyFailed?: string | null
  keyTtl?: number
  verbose?: boolean
  /** Stop at the first failed batch and prune the shared queue. */
  failFast?: boolean
  queue?: RedisQueue
  output?: NodeJS.WritableStream
  report?: string | null
}

/**
 * Legacy options for backward compatibility.
 * When `command` is provided instead of `adapter`, a CliAdapter is created automatically.
 */
export interface WorkerOptionsLegacy {
  key: string
  command: string
  commandOpts?: string[]
  batchSize?: number
  keyRerun?: string | null
  keyFailed?: string | null
  keyTtl?: number
  verbose?: boolean
  /** Stop at the first failed batch and prune the shared queue. */
  failFast?: boolean
  queue?: RedisQueue
  output?: NodeJS.WritableStream
  report?: string | null
}

export class Worker {
  readonly queue: RedisQueue
  readonly key: string
  readonly adapter: Adapter
  readonly batchSize: number
  readonly keyRerun: string | null
  readonly keyFailed: string | null
  readonly keyTtl: number
  readonly verbose: boolean
  readonly failFast: boolean
  readonly output: NodeJS.WritableStream
  readonly report: string | null

  private batchResults: BatchResult[] = []
  private startTime: number = 0

  constructor(options: WorkerOptions | WorkerOptionsLegacy) {
    this.key = options.key
    this.batchSize = options.batchSize ?? 5
    this.keyRerun = options.keyRerun ?? null
    this.keyFailed = options.keyFailed ?? null
    this.keyTtl = options.keyTtl ?? 604_800
    this.verbose = options.verbose ?? false
    this.failFast = options.failFast ?? false
    this.queue = options.queue ?? new RedisQueue()
    this.output = options.output ?? process.stdout
    this.report = options.report ?? null

    // Support both new adapter-based and legacy command-based options
    if ('adapter' in options) {
      this.adapter = options.adapter
    } else {
      this.adapter = new CliAdapter({
        command: options.command,
        commandOpts: options.commandOpts,
      })
    }
  }

  /**
   * Main entry point. Detects the operating mode from the published marker
   * and the state of the shared queue / rerun keys, then dispatches.
   *
   * The decision follows this truth table (all "empty" states are
   * indistinguishable in Redis, which is why the published marker exists):
   *
   *   Published | Shared queue | Rerun key | Result
   *   ----------|--------------|-----------|-------------------------------
   *   No        | any          | any       | Crash — nothing was published
   *   Yes       | empty        | empty     | Ok — worker arriving late
   *   Yes       | populated    | empty     | Ok — classic run (steal + record)
   *   Yes       | any          | populated | Ok — rerun (requeue, steal + record)
   *
   * A populated rerun key means this runner took those files in an earlier
   * attempt. That attempt may have stopped before the queue drained, so the
   * queue plus every runner's rerun key is what still holds the files nobody
   * has run. The runner puts its rerun files back on the queue (skipping any
   * the queue already holds, as after a fresh push) and steals with the
   * runners re-run alongside it, so they share the work instead of each
   * running only its own share again. A runner re-run alone steals its files back.
   *
   * Returns 0 if all batches passed (or nothing to do), 1 on failure or crash.
   */
  async run(): Promise<number> {
    await this.adapter.setup()
    this.startTime = Date.now()

    let exitCode: number

    try {
      const published = await this.queue.isPublished(this.key)
      if (!published) {
        this.log(`[specbandit] ERROR: no work published for key '${this.key}'. Run 'specbandit push' first, or the publish marker expired (TTL).`)
        return 1
      }

      const rerunFiles = this.keyRerun ? await this.queue.readAll(this.keyRerun) : []

      if (rerunFiles.length > 0) {
        const requeued = await this.queue.requeue(this.key, this.keyRerun!, this.keyTtl)
        this.log(`[specbandit] Rerun: rerun key '${this.keyRerun}' holds ${rerunFiles.length} files from an earlier attempt. Put ${requeued} back on '${this.key}' (the rest were still queued).`)
        exitCode = await this.runSteal(true)
      } else {
        // No rerun data: steal from the shared queue, recording each batch to
        // the rerun key when one is configured. Handles both the classic run
        // and a worker arriving after the queue was drained (nothing to do).
        exitCode = await this.runSteal(Boolean(this.keyRerun))
      }

      if (this.batchResults.length > 0) {
        this.printSummary()
      }
      this.writeReport()
    } finally {
      await this.adapter.teardown()
    }

    return exitCode
  }

  /**
   * Steal mode: atomically pop batches from the shared queue.
   * When record is true, each stolen batch is also pushed to the
   * rerun key so this runner can run them again on a re-run.
   *
   * Once the queue is exhausted, a recording runner also runs any file its
   * rerun key holds that it has not run: a steal whose reply was lost (a
   * command timeout, then a retry) recorded files this process never saw.
   */
  private async runSteal(record: boolean): Promise<number> {
    const modeLabel = record ? 'Record' : 'Steal'
    this.log(`[specbandit] ${modeLabel} mode: stealing batches from '${this.key}'.`)
    if (record) {
      this.log(`[specbandit] Recording stolen files to rerun key '${this.keyRerun}'.`)
    }

    let failed = false
    let batchNum = 0
    const ran = new Set<string>()

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let files =
        record && this.keyRerun
          ? await this.queue.stealAndRecord(this.key, this.keyRerun, this.batchSize, this.keyTtl)
          : await this.queue.steal(this.key, this.batchSize)

      if (files.length === 0 && record && this.keyRerun) {
        const unseen = (await this.queue.readAll(this.keyRerun)).filter((f) => !ran.has(f))
        if (unseen.length > 0) {
          this.log(`[specbandit] Rerun key '${this.keyRerun}' holds ${unseen.length} files this runner has not run (a lost steal reply). Running them.`)
          files = unseen.slice(0, this.batchSize)
        }
      }

      if (files.length === 0) {
        this.log('[specbandit] Queue exhausted. No more files to run.')
        break
      }

      for (const f of files) ran.add(f)
      batchNum++
      // The batch is listed unconditionally, not behind --verbose. A runner that
      // dies mid-batch (an OOM kill takes the whole process) prints nothing after
      // this line, so these names are the only record of what was in flight — and
      // that is exactly the run where nobody thought to turn verbose on.
      this.log(`[specbandit] Batch #${batchNum}: running ${files.length} files`)
      for (const f of files) this.log(`  ${f}`)

      const result = await this.adapter.runBatch(files, batchNum)
      this.batchResults.push(result)

      if (result.exitCode !== 0) {
        this.log(`[specbandit] Batch #${batchNum} FAILED (exit code: ${result.exitCode})`)
        failed = true
        await this.recordFailed(result)
        if (this.failFast) {
          await this.pruneQueue(batchNum)
          break
        }
      } else {
        this.log(`[specbandit] Batch #${batchNum} passed.`)
      }
    }

    if (batchNum === 0) {
      this.log('[specbandit] Nothing to do (queue was empty).')
    } else {
      this.log(
        `[specbandit] Finished ${batchNum} batches. ${failed ? 'SOME FAILED' : 'All passed.'}`
      )
    }

    return failed ? 1 : 0
  }

  /**
   * Fail-fast: empty the shared queue so no worker steals more files.
   *
   * Only the list is deleted. The published marker stays, so a worker that
   * checks the queue after this sees "published but drained" and exits 0,
   * instead of crashing with "no work published". Workers with a batch in
   * flight finish it, then find the queue empty and stop.
   */
  private async pruneQueue(batchNum: number): Promise<void> {
    const pending = await this.queue.length(this.key)
    await this.queue.delete(this.key)
    this.log(
      `[specbandit] Fail-fast: batch #${batchNum} failed. Pruned ${pending} pending files from '${this.key}'. Stopping.`
    )
  }

  // --- Reporting helpers ---

  private async recordFailed(result: BatchResult): Promise<void> {
    if (!this.keyFailed) return
    // When the adapter can't name specific failing files (e.g. a suite failed
    // to load, so numFailingTests is 0), `failedFiles` is [] — fall back to the
    // whole batch so a failed batch always records at least one file to retry.
    const files =
      result.failedFiles && result.failedFiles.length > 0 ? result.failedFiles : result.files
    await this.queue.push(this.keyFailed, files, this.keyTtl)
    // The failed key is later consumed by a retry `work` pass, which requires a
    // published marker (RedisQueue.isPublished). `push` alone doesn't set it, so
    // mark it here — otherwise the retry crashes with "no work published".
    await this.queue.markPublished(this.keyFailed, this.keyTtl)
  }

  private printSummary(): void {
    const durations = this.batchResults.map((r) => r.duration)
    const totalFiles = this.batchResults.reduce((sum, r) => sum + r.files.length, 0)
    const failedBatches = this.batchResults.filter((r) => r.exitCode !== 0)
    const minDuration = Math.min(...durations)
    const maxDuration = Math.max(...durations)
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length

    this.log('')
    this.log('='.repeat(60))
    this.log('[specbandit] Summary')
    this.log('='.repeat(60))
    this.log(`  Batches:        ${this.batchResults.length}`)
    this.log(`  Files:          ${totalFiles}`)
    this.log(`  Failed batches: ${failedBatches.length}`)
    this.log('')
    this.log(
      `  Batch timing: min ${minDuration.toFixed(1)}s | avg ${avgDuration.toFixed(1)}s | max ${maxDuration.toFixed(1)}s`
    )

    if (failedBatches.length > 0) {
      this.log('')
      this.log(`  Failed batches (${failedBatches.length}):`)
      for (const batch of failedBatches) {
        this.log(`    Batch #${batch.batchNum} (exit code ${batch.exitCode}): ${batch.files.join(', ')}`)
      }
    }

    this.log('='.repeat(60))
    this.log('')
  }

  private writeReport(): void {
    const reportPath = this.report
    if (!reportPath || this.batchResults.length === 0) return

    const durations = this.batchResults.map((r) => r.duration)
    const totalFiles = this.batchResults.reduce((sum, r) => sum + r.files.length, 0)
    const failedBatches = this.batchResults.filter((r) => r.exitCode !== 0)
    // Fall back to the whole batch when the adapter couldn't name failing files
    // (`failedFiles` is [] for a suite that failed to load), mirroring recordFailed.
    const failedFiles = failedBatches.flatMap((r) =>
      r.failedFiles && r.failedFiles.length > 0 ? r.failedFiles : r.files
    )
    const totalWallTime = (Date.now() - this.startTime) / 1000

    const merged = {
      specbandit_version: VERSION,
      summary: {
        total_files: totalFiles,
        total_batches: this.batchResults.length,
        passed_batches: this.batchResults.length - failedBatches.length,
        failed_batches: failedBatches.length,
        passed: failedBatches.length === 0,
      },
      failed_files: failedFiles,
      total_wall_time: parseFloat(totalWallTime.toFixed(2)),
      batch_timings: {
        count: durations.length,
        min: Math.min(...durations).toFixed(2),
        avg: (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2),
        max: Math.max(...durations).toFixed(2),
        all: durations.map((d) => parseFloat(d.toFixed(2))),
      },
      batches: this.batchResults.map((r) => ({
        batch_num: r.batchNum,
        files: r.files,
        exit_code: r.exitCode,
        duration: parseFloat(r.duration.toFixed(2)),
        passed: r.exitCode === 0,
      })),
    }

    fs.writeFileSync(reportPath, JSON.stringify(merged, null, 2) + '\n')
  }

  private log(message: string): void {
    this.output.write(message + '\n')
  }
}
