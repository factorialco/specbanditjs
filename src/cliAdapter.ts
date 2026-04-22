import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import type { Adapter, BatchResult } from './adapter.js'

export interface CliAdapterOptions {
  command: string
  commandOpts?: string[]
}

/**
 * CLI adapter: spawns a shell command for each batch.
 *
 * Works with any test runner. The command string is split on whitespace,
 * and file paths are appended as arguments:
 *
 *   <executable> [...commandArgs] [...commandOpts] [...filePaths]
 *
 * Example: command="npx jest", commandOpts=["--coverage"]
 *   -> spawnSync("npx", ["jest", "--coverage", "file1.ts", "file2.ts"])
 */
export class CliAdapter implements Adapter {
  readonly command: string
  readonly commandOpts: string[]

  constructor(options: CliAdapterOptions) {
    this.command = options.command
    this.commandOpts = options.commandOpts ?? []
  }

  async setup(): Promise<void> {
    // No-op for CLI adapter
  }

  async runBatch(files: string[], batchNum: number): Promise<BatchResult> {
    const commandParts = this.command.split(/\s+/)
    const executable = commandParts[0]
    const args = [...commandParts.slice(1), ...this.commandOpts, ...files]

    const startTime = performance.now()
    const result = spawnSync(executable, args, {
      stdio: 'inherit',
      shell: false,
      env: process.env,
    })
    const duration = (performance.now() - startTime) / 1000

    const exitCode = result.status ?? 1

    return { batchNum, files, exitCode, duration }
  }

  async teardown(): Promise<void> {
    // No-op for CLI adapter
  }
}
