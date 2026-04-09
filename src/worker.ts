import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import fs from 'node:fs'
import { RedisQueue } from './redisQueue.js'
import { VERSION } from './configuration.js'

export interface WorkerOptions {
  key: string
  command: string
  commandOpts?: string[]
  batchSize?: number
  keyRerun?: string | null
  keyRerunTtl?: number
  verbose?: boolean
  queue?: RedisQueue
  output?: NodeJS.WritableStream
  jsonOut?: string | null
}

interface BatchResult {
  batchNum: number
  files: string[]
  exitCode: number
  duration: number
}

export class Worker {
  readonly queue: RedisQueue
  readonly key: string
  readonly command: string
  readonly commandOpts: string[]
  readonly batchSize: number
  readonly keyRerun: string | null
  readonly keyRerunTtl: number
  readonly verbose: boolean
  readonly output: NodeJS.WritableStream
  readonly jsonOut: string | null

  private batchResults: BatchResult[] = []

  constructor(options: WorkerOptions) {
    this.key = options.key
    this.command = options.command
    this.commandOpts = options.commandOpts ?? []
    this.batchSize = options.batchSize ?? 5
    this.keyRerun = options.keyRerun ?? null
    this.keyRerunTtl = options.keyRerunTtl ?? 604_800
    this.verbose = options.verbose ?? false
    this.queue = options.queue ?? new RedisQueue()
    this.output = options.output ?? process.stdout
    this.jsonOut = options.jsonOut ?? null
  }

  /**
   * Main entry point. Detects the operating mode and dispatches accordingly.
   *
   * Returns 0 if all batches passed (or nothing to do), 1 if any batch failed.
   */
  async run(): Promise<number> {
    let exitCode: number

    if (this.keyRerun) {
      const rerunFiles = await this.queue.readAll(this.keyRerun)
      if (rerunFiles.length > 0) {
        exitCode = await this.runReplay(rerunFiles)
      } else {
        exitCode = await this.runSteal(true)
      }
    } else {
      exitCode = await this.runSteal(false)
    }

    if (this.batchResults.length > 0) {
      this.printSummary()
    }
    this.writeJsonResults()
    this.writeGitHubStepSummary()

    return exitCode
  }

  /**
   * Replay mode: run a known list of files in local batches.
   * Used when re-running a failed CI job -- the rerun key already
   * contains the exact files this runner executed previously.
   */
  private async runReplay(files: string[]): Promise<number> {
    this.log(`[specbandit] Replay mode: found ${files.length} files in rerun key '${this.keyRerun}'.`)
    this.log('[specbandit] Running previously recorded files (not touching shared queue).')

    let failed = false
    let batchNum = 0

    for (let i = 0; i < files.length; i += this.batchSize) {
      const batch = files.slice(i, i + this.batchSize)
      batchNum++
      this.log(`[specbandit] Batch #${batchNum}: running ${batch.length} files`)
      if (this.verbose) {
        for (const f of batch) this.log(`  ${f}`)
      }

      const result = this.runCommandBatch(batch, batchNum)
      this.batchResults.push(result)

      if (result.exitCode !== 0) {
        this.log(`[specbandit] Batch #${batchNum} FAILED (exit code: ${result.exitCode})`)
        failed = true
      } else {
        this.log(`[specbandit] Batch #${batchNum} passed.`)
      }
    }

    this.log(
      `[specbandit] Replay finished: ${batchNum} batches. ${failed ? 'SOME FAILED' : 'All passed.'}`
    )
    return failed ? 1 : 0
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
      const files = await this.queue.steal(this.key, this.batchSize)

      if (files.length === 0) {
        this.log('[specbandit] Queue exhausted. No more files to run.')
        break
      }

      // Record the stolen batch so this runner can replay on re-run
      if (record && this.keyRerun) {
        await this.queue.push(this.keyRerun, files, this.keyRerunTtl)
      }

      batchNum++
      this.log(`[specbandit] Batch #${batchNum}: running ${files.length} files`)
      if (this.verbose) {
        for (const f of files) this.log(`  ${f}`)
      }

      const result = this.runCommandBatch(files, batchNum)
      this.batchResults.push(result)

      if (result.exitCode !== 0) {
        this.log(`[specbandit] Batch #${batchNum} FAILED (exit code: ${result.exitCode})`)
        failed = true
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
   * Run a single batch of files using the configured command.
   *
   * Spawns: <command> [...commandOpts] [...files]
   */
  private runCommandBatch(files: string[], batchNum: number): BatchResult {
    // Parse command into parts to handle "npx jest" style commands
    const commandParts = this.command.split(/\s+/)
    const executable = commandParts[0]
    const args = [...commandParts.slice(1), ...this.commandOpts, ...files]

    const startTime = performance.now()
    const result = spawnSync(executable, args, {
      stdio: this.verbose ? 'inherit' : 'pipe',
      shell: false,
      env: process.env,
    })
    const duration = (performance.now() - startTime) / 1000 // seconds

    const exitCode = result.status ?? 1

    // If not verbose but command produced stderr on failure, print it
    if (!this.verbose && exitCode !== 0 && result.stderr) {
      const stderr = result.stderr.toString()
      if (stderr.trim()) {
        this.log(stderr)
      }
    }

    return { batchNum, files, exitCode, duration }
  }

  // --- Reporting helpers ---

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

  private writeJsonResults(): void {
    const path = this.jsonOut
    if (!path || this.batchResults.length === 0) return

    const durations = this.batchResults.map((r) => r.duration)
    const totalFiles = this.batchResults.reduce((sum, r) => sum + r.files.length, 0)
    const failedBatches = this.batchResults.filter((r) => r.exitCode !== 0)

    const merged = {
      specbandit_version: VERSION,
      command: this.command,
      summary: {
        total_files: totalFiles,
        total_batches: this.batchResults.length,
        failed_batches: failedBatches.length,
        passed: failedBatches.length === 0,
      },
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
      })),
    }

    fs.writeFileSync(path, JSON.stringify(merged, null, 2) + '\n')
  }

  private writeGitHubStepSummary(): void {
    const path = process.env.GITHUB_STEP_SUMMARY
    if (!path || this.batchResults.length === 0) return

    try {
      const durations = this.batchResults.map((r) => r.duration)
      const totalFiles = this.batchResults.reduce((sum, r) => sum + r.files.length, 0)
      const failedBatches = this.batchResults.filter((r) => r.exitCode !== 0)
      const minDuration = Math.min(...durations)
      const maxDuration = Math.max(...durations)
      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length

      const lines: string[] = []
      lines.push('### Specbandit Results')
      lines.push('')
      lines.push('| Metric | Value |')
      lines.push('|--------|-------|')
      lines.push(`| Command | \`${this.command}\` |`)
      lines.push(`| Batches | ${this.batchResults.length} |`)
      lines.push(`| Files | ${totalFiles} |`)
      lines.push(`| Failed batches | ${failedBatches.length} |`)
      lines.push(`| Batch time (min) | ${minDuration.toFixed(1)}s |`)
      lines.push(`| Batch time (avg) | ${avgDuration.toFixed(1)}s |`)
      lines.push(`| Batch time (max) | ${maxDuration.toFixed(1)}s |`)
      lines.push('')

      if (failedBatches.length > 0) {
        lines.push(`<details><summary>${failedBatches.length} failed batches</summary>`)
        lines.push('')
        lines.push('| Batch | Exit Code | Files |')
        lines.push('|-------|-----------|-------|')
        for (const batch of failedBatches) {
          const filesStr = batch.files.map((f) => `\`${f}\``).join(', ')
          lines.push(`| #${batch.batchNum} | ${batch.exitCode} | ${filesStr} |`)
        }
        lines.push('')
        lines.push('</details>')
      }

      fs.appendFileSync(path, lines.join('\n') + '\n')
    } catch {
      // Never fail the build because of summary writing
    }
  }

  private log(message: string): void {
    this.output.write(message + '\n')
  }
}
