import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Adapter, BatchResult } from './adapter.js'

/**
 * Options for the Vitest adapter.
 */
export interface VitestAdapterOptions {
  /**
   * Path to the Vitest config file (e.g. './vitest.config.ts').
   * If not provided, Vitest uses its default config resolution.
   */
  vitestConfig?: string

  /**
   * Project root directory. Defaults to process.cwd().
   */
  projectRoot?: string

  /**
   * Whether to show verbose output.
   */
  verbose?: boolean

  /**
   * Output stream for logging.
   */
  output?: NodeJS.WritableStream
}

/**
 * Vitest adapter: runs Vitest programmatically via the `vitest/node` API.
 *
 * On setup(), it creates a Vitest instance via `createVitest()` which is
 * reused across all batches. This avoids the overhead of re-initializing
 * the test runner for each batch.
 *
 * On each runBatch(), it calls `vitest.start()` with the batch files
 * filtered via `testNamePattern` / include, then extracts results.
 *
 * @requires vitest as a peer dependency (installed in the consumer project)
 */
export class VitestAdapter implements Adapter {
  readonly projectRoot: string
  readonly vitestConfig: string | undefined
  readonly verbose: boolean
  readonly output: NodeJS.WritableStream

  // Cached Vitest instance from setup()
  private vitest: VitestInstance | null = null

  // Require function rooted at projectRoot for resolving Vitest
  private projectRequire: NodeRequire

  // Cached createVitest function
  private createVitestFn: CreateVitestFn | null = null

  constructor(options: VitestAdapterOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd()
    this.vitestConfig = options.vitestConfig
    this.verbose = options.verbose ?? false
    this.output = options.output ?? process.stdout

    // Create a require function rooted at the project root.
    // This ensures vitest is resolved from the project's node_modules,
    // not from specbandit's installation directory.
    const requireBase = path.resolve(this.projectRoot, '__specbandit_resolve__.js')
    this.projectRequire = createRequire(requireBase)
  }

  async setup(): Promise<void> {
    this.log('[specbandit:vitest] Initializing Vitest adapter...')

    try {
      // Resolve vitest/node from the project root's node_modules.
      // vitest/node exports `createVitest` for programmatic usage.
      const vitestNodePath = this.projectRequire.resolve('vitest/node')
      const vitestNodeMod = await import(vitestNodePath)
      const createVitest: CreateVitestFn = vitestNodeMod.createVitest

      if (typeof createVitest !== 'function') {
        throw new Error('createVitest is not exported from vitest/node')
      }

      this.createVitestFn = createVitest

      // Build Vitest options
      const options: Record<string, unknown> = {
        root: this.projectRoot,
        watch: false,
        reporters: [new SilentReporter()],
        passWithNoTests: true,
      }

      if (this.vitestConfig) {
        options.config = this.vitestConfig
      }

      // Create the Vitest instance — this is reused across all batches
      this.vitest = await createVitest('test', options)

      this.log('[specbandit:vitest] Setup complete (Vitest instance created).')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `[specbandit:vitest] Failed to initialize Vitest adapter: ${message}\n` +
          'Make sure vitest is installed as a dependency in your project.',
      )
    }
  }

  async runBatch(files: string[], batchNum: number): Promise<BatchResult> {
    const vitest = this.vitest

    if (!vitest) {
      throw new Error('[specbandit:vitest] Adapter not initialized. Call setup() first.')
    }

    const startTime = performance.now()
    let exitCode = 0
    let failedFiles: string[] | undefined

    try {
      // Resolve file paths to absolute paths for Vitest
      const absoluteFiles = files.map((f) => path.resolve(this.projectRoot, f))

      // Use the project API to provide files and run
      await vitest.setTestFiles(absoluteFiles)
      await vitest.start()

      // Extract results from the Vitest state
      const testModules = vitest.state?.getTestModules() ?? []
      const failed: string[] = []

      for (const mod of testModules) {
        const result = mod.result()
        if (result && result.state === 'failed') {
          const filePath = mod.moduleId
          failed.push(path.relative(this.projectRoot, filePath))
        }
      }

      if (failed.length > 0) {
        exitCode = 1
        failedFiles = failed
        if (this.verbose) {
          for (const f of failed) {
            this.log(`[specbandit:vitest] Failed: ${f}`)
          }
        }
      }
    } catch (error: unknown) {
      exitCode = 1
      const message = error instanceof Error ? error.message : String(error)
      this.log(`[specbandit:vitest] Batch #${batchNum} error: ${message}`)
    }

    const duration = (performance.now() - startTime) / 1000

    return { batchNum, files, exitCode, duration, failedFiles }
  }

  async teardown(): Promise<void> {
    if (this.vitest) {
      await this.vitest.close()
    }
    this.vitest = null
    this.createVitestFn = null
    this.log('[specbandit:vitest] Teardown complete.')
  }

  private log(message: string): void {
    this.output.write(message + '\n')
  }
}

// ── Minimal type definitions for Vitest programmatic API ──

interface VitestInstance {
  start(): Promise<void>
  close(): Promise<void>
  setTestFiles(files: string[]): Promise<void>
  state?: {
    getTestModules(): Array<{
      moduleId: string
      result(): { state: string } | undefined
    }>
  }
}

type CreateVitestFn = (
  mode: 'test' | 'bench',
  options: Record<string, unknown>,
) => Promise<VitestInstance>

/**
 * A silent reporter that suppresses all Vitest output.
 * Used when verbose mode is disabled.
 */
class SilentReporter {
  onInit() {}
  onPathsCollected() {}
  onCollected() {}
  onFinished() {}
  onTaskUpdate() {}
  onTestRemoved() {}
  onWatcherStart() {}
  onWatcherRerun() {}
  onServerRestart() {}
  onUserConsoleLog() {}
}
