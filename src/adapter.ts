/**
 * Adapter interface for executing test batches.
 *
 * specbandit supports pluggable execution strategies:
 * - CliAdapter: spawns a shell command for each batch (works with any test runner)
 * - JestAdapter: runs Jest programmatically with haste map reuse (maximum performance)
 */
export interface BatchResult {
  batchNum: number
  files: string[]
  exitCode: number
  duration: number
}

export interface Adapter {
  /**
   * One-time initialization. Called before any batches are run.
   * For CLI adapter this is a no-op.
   * For Jest adapter this builds the haste map and config.
   */
  setup(): Promise<void>

  /**
   * Run a single batch of test files.
   * Returns a BatchResult with the exit code and timing.
   */
  runBatch(files: string[], batchNum: number): Promise<BatchResult>

  /**
   * Cleanup after all batches are done.
   * For CLI adapter this is a no-op.
   * For Jest adapter this closes haste map watchers.
   */
  teardown(): Promise<void>
}
