import fs from 'node:fs'
import fg from 'fast-glob'
import { RedisQueue } from './redisQueue.js'
import { VERSION } from './configuration.js'
import type { Adapter, BatchResult } from './adapter.js'
import { CliAdapter } from './cliAdapter.js'

/**
 * Connection-level Redis failures (host down, DNS gone, retries exhausted).
 * Command-level errors (e.g. WRONGTYPE) are NOT connection errors and must
 * keep propagating: only an unreachable Redis justifies the static fallback.
 */
function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'MaxRetriesPerRequestError') return true
  const code = (error as NodeJS.ErrnoException).code
  if (code && ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH', 'EPIPE'].includes(code)) {
    return true
  }
  return error.message.includes('Connection is closed')
}

export interface WorkerOptions {
  key: string
  adapter: Adapter
  batchSize?: number
  keyRerun?: string | null
  keyRerunTtl?: number
  keyFailed?: string | null
  keyFailedTtl?: number
  rerun?: boolean
  verbose?: boolean
  queue?: RedisQueue
  output?: NodeJS.WritableStream
  report?: string | null
  fallbackPattern?: string | null
  nodeIndex?: number | null
  nodeTotal?: number | null
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
  keyRerunTtl?: number
  keyFailed?: string | null
  keyFailedTtl?: number
  rerun?: boolean
  verbose?: boolean
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
  readonly keyRerunTtl: number
  readonly keyFailed: string | null
  readonly keyFailedTtl: number
  readonly rerun: boolean
  readonly verbose: boolean
  readonly output: NodeJS.WritableStream
  readonly report: string | null
  readonly fallbackPattern: string | null
  readonly nodeIndex: number | null
  readonly nodeTotal: number | null

  private batchResults: BatchResult[] = []
  private startTime: number = 0
  private fallbackActive = false

  constructor(options: WorkerOptions | WorkerOptionsLegacy) {
    this.key = options.key
    this.batchSize = options.batchSize ?? 5
    this.keyRerun = options.keyRerun ?? null
    this.keyRerunTtl = options.keyRerunTtl ?? 604_800
    this.keyFailed = options.keyFailed ?? null
    this.keyFailedTtl = options.keyFailedTtl ?? 604_800
    this.rerun = options.rerun ?? false
    this.verbose = options.verbose ?? false
    this.queue = options.queue ?? new RedisQueue()
    this.output = options.output ?? process.stdout
    this.report = options.report ?? null
    this.fallbackPattern = ('fallbackPattern' in options ? options.fallbackPattern : null) ?? null
    this.nodeIndex = ('nodeIndex' in options ? options.nodeIndex : null) ?? null
    this.nodeTotal = ('nodeTotal' in options ? options.nodeTotal : null) ?? null

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
   * Main entry point. Detects the operating mode and dispatches accordingly.
   *
   * Returns 0 if all batches passed (or nothing to do), 1 if any batch failed.
   */
  async run(): Promise<number> {
    await this.adapter.setup()
    this.startTime = Date.now()

    let exitCode: number

    try {
      exitCode = await this.dispatch()

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
   * Decide the operating mode and execute it, returning the exit code.
   */
  private async dispatch(): Promise<number> {
    if (!this.keyRerun) {
      return this.runSteal(false)
    }

    let rerunFiles: string[]
    try {
      rerunFiles = await this.queue.readAll(this.keyRerun)
    } catch (error) {
      // Replay integrity cannot be guaranteed without the recorded file list:
      // a static slice may differ from what this runner originally executed,
      // so an explicit re-run must still fail hard.
      if (this.rerun || !this.fallbackEnabled() || !isConnectionError(error)) throw error
      return this.enterFallback(error, false)
    }

    if (rerunFiles.length > 0) {
      return this.runReplay(rerunFiles)
    }
    if (this.rerun) {
      this.log(`ERROR: --rerun flag is set but rerun key '${this.keyRerun}' is empty. The rerun key may have expired (TTL) or Redis was flushed. Cannot replay — failing to prevent silent false pass.`)
      return 1
    }
    return this.runSteal(true)
  }

  /**
   * Replay mode: run a known list of files in local batches.
   * Used when re-running a failed CI job -- the rerun key already
   * contains the exact files this runner executed previously.
   */
  private async runReplay(files: string[]): Promise<number> {
    this.log(`[specbandit] Replay mode: found ${files.length} files in rerun key '${this.keyRerun}'.`)
    this.log('[specbandit] Running previously recorded files (not touching shared queue).')

    const { failed, batchNum } = await this.runLocalBatches(files)

    this.log(
      `[specbandit] Replay finished: ${batchNum} batches. ${failed ? 'SOME FAILED' : 'All passed.'}`
    )
    return failed ? 1 : 0
  }

  /**
   * Run a known list of files in local batches (no shared-queue interaction).
   * Used by replay mode and by the static-split fallback.
   */
  private async runLocalBatches(files: string[]): Promise<{ failed: boolean; batchNum: number }> {
    let failed = false
    let batchNum = 0

    for (let i = 0; i < files.length; i += this.batchSize) {
      const batch = files.slice(i, i + this.batchSize)
      batchNum++
      this.log(`[specbandit] Batch #${batchNum}: running ${batch.length} files`)
      if (this.verbose) {
        for (const f of batch) this.log(`  ${f}`)
      }

      const result = await this.adapter.runBatch(batch, batchNum)
      this.batchResults.push(result)

      if (result.exitCode !== 0) {
        this.log(`[specbandit] Batch #${batchNum} FAILED (exit code: ${result.exitCode})`)
        failed = true
        await this.recordFailed(result)
      } else {
        this.log(`[specbandit] Batch #${batchNum} passed.`)
      }
    }

    return { failed, batchNum }
  }

  /**
   * Steal mode: atomically pop batches from the shared queue.
   * When record is true, each stolen batch is also pushed to the
   * rerun key so this runner can replay them on a re-run.
   */
  private async runSteal(record: boolean): Promise<number> {
    const modeLabel = record ? 'Record' : 'Steal'
    this.log(`[specbandit] ${modeLabel} mode: stealing batches from '${this.key}'.`)
    if (record) {
      this.log(`[specbandit] Recording stolen files to rerun key '${this.keyRerun}'.`)
    }

    let failed = false
    let batchNum = 0

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let files: string[]
      try {
        files = await this.queue.steal(this.key, this.batchSize)
      } catch (error) {
        if (!this.fallbackEnabled() || !isConnectionError(error)) throw error
        return this.enterFallback(error, failed)
      }

      if (files.length === 0) {
        this.log('[specbandit] Queue exhausted. No more files to run.')
        break
      }

      // Record the stolen batch so this runner can replay on re-run.
      // Best-effort when fallback is enabled: losing rerun bookkeeping is
      // better than losing the whole shard, and if Redis is really down the
      // next steal will trigger the fallback anyway.
      if (record && this.keyRerun) {
        try {
          await this.queue.push(this.keyRerun, files, this.keyRerunTtl)
        } catch (error) {
          if (!this.fallbackEnabled() || !isConnectionError(error)) throw error
          this.log(`[specbandit] WARNING: could not record rerun batch (${error}). Continuing.`)
        }
      }

      batchNum++
      this.log(`[specbandit] Batch #${batchNum}: running ${files.length} files`)
      if (this.verbose) {
        for (const f of files) this.log(`  ${f}`)
      }

      const result = await this.adapter.runBatch(files, batchNum)
      this.batchResults.push(result)

      if (result.exitCode !== 0) {
        this.log(`[specbandit] Batch #${batchNum} FAILED (exit code: ${result.exitCode})`)
        failed = true
        await this.recordFailed(result)
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

  // --- Fallback ---

  /**
   * Fallback is opt-in: it requires a glob pattern plus the node index/total
   * of this runner (validated in Configuration.validate()).
   */
  private fallbackEnabled(): boolean {
    return this.fallbackPattern != null && this.fallbackPattern !== '' && this.nodeIndex != null && this.nodeTotal != null
  }

  /**
   * Redis is unreachable: degrade to a deterministic static split instead of
   * failing the shard. Every file belongs to exactly one node's slice, so the
   * union over all nodes covers the whole suite even when some nodes already
   * stole batches from the queue (duplicates are possible, misses are not).
   */
  private async enterFallback(error: unknown, priorFailed: boolean): Promise<number> {
    this.fallbackActive = true
    const nodeIndex = this.nodeIndex!
    const nodeTotal = this.nodeTotal!
    this.output.write(`[specbandit] WARNING: Redis unreachable (${error}).\n`)
    this.output.write(
      `[specbandit] Falling back to static split: node ${nodeIndex + 1}/${nodeTotal} of '${this.fallbackPattern}'.\n`
    )

    // Mirror the publisher's glob (fast-glob, onlyFiles, sorted) so the file
    // paths match the form that was pushed to the queue.
    const allFiles = (await fg(this.fallbackPattern!, { onlyFiles: true })).sort()
    if (allFiles.length === 0) {
      this.output.write(
        `[specbandit] ERROR: fallback pattern '${this.fallbackPattern}' matched no files. Refusing to silently skip the suite.\n`
      )
      return 1
    }

    const slice = allFiles.filter((_, i) => i % nodeTotal === nodeIndex)
    const alreadyRun = new Set(this.batchResults.flatMap((r) => r.files))
    const remaining = slice.filter((f) => !alreadyRun.has(f))
    this.output.write(
      `[specbandit] Fallback slice: ${slice.length} files, ${remaining.length} not yet run by this node.\n`
    )

    const { failed: fallbackFailed, batchNum } = await this.runLocalBatches(remaining)
    this.log(
      `[specbandit] Fallback finished: ${batchNum} batches. ${fallbackFailed ? 'SOME FAILED' : 'All passed.'}`
    )
    return priorFailed || fallbackFailed ? 1 : 0
  }

  // --- Reporting helpers ---

  private async recordFailed(result: BatchResult): Promise<void> {
    if (!this.keyFailed) return

    const files = result.failedFiles ?? result.files

    // In fallback mode Redis is known to be down: skip the write instead of
    // crashing. Failed files still reach the local JSON report.
    if (this.fallbackActive) {
      this.log(`[specbandit] Skipping failed-files Redis write (fallback mode): ${files.length} files.`)
      return
    }

    await this.queue.push(this.keyFailed, files, this.keyFailedTtl)
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
    const failedFiles = failedBatches.flatMap((r) => r.failedFiles ?? r.files)
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
