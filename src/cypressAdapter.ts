import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Adapter, BatchResult } from './adapter.js'

/**
 * Options for the Cypress adapter.
 */
export interface CypressAdapterOptions {
  /**
   * Path to the Cypress config file (e.g. './cypress.config.ts').
   * If not provided, Cypress uses its default config resolution.
   */
  configFile?: string

  /**
   * Project root directory. Defaults to process.cwd().
   */
  projectRoot?: string

  /**
   * Browser to use (e.g. 'chrome', 'firefox', 'electron').
   * If not provided, Cypress uses its default (Electron).
   */
  browser?: string

  /**
   * Testing type: 'e2e' (default) or 'component'.
   */
  testingType?: 'e2e' | 'component'

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
 * Cypress adapter: runs Cypress programmatically via the Module API.
 *
 * On setup(), it dynamically loads the `cypress` package (resolved from
 * the project root's node_modules) and validates that it is available.
 * On each runBatch(), it calls `cypress.run()` with the batch files
 * joined as a comma-separated `spec` string.
 *
 * Unlike the Jest adapter, there is no reusable state between batches —
 * each `cypress.run()` call launches a fresh browser instance. Consumers
 * should choose a batch size that amortizes this startup cost.
 *
 * @requires cypress as a peer dependency (installed in the consumer project)
 */
export class CypressAdapter implements Adapter {
  readonly projectRoot: string
  readonly configFile: string | undefined
  readonly browser: string | undefined
  readonly testingType: 'e2e' | 'component'
  readonly verbose: boolean
  readonly output: NodeJS.WritableStream

  // Cached from setup()
  private cypressModule: CypressModule | null = null

  // Require function rooted at projectRoot for resolving Cypress
  private projectRequire: NodeRequire

  constructor(options: CypressAdapterOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd()
    this.configFile = options.configFile
    this.browser = options.browser
    this.testingType = options.testingType ?? 'e2e'
    this.verbose = options.verbose ?? false
    this.output = options.output ?? process.stdout

    // Create a require function rooted at the project root.
    // This ensures cypress is resolved from the project's node_modules,
    // not from specbandit's installation directory.
    const requireBase = path.resolve(this.projectRoot, '__specbandit_resolve__.js')
    this.projectRequire = createRequire(requireBase)
  }

  async setup(): Promise<void> {
    this.log('[specbandit:cypress] Initializing Cypress adapter...')

    try {
      // Resolve cypress from the project root's node_modules using require().
      // This avoids compile-time dependency on cypress and ensures it is
      // resolved from the consumer project, not specbandit's own deps.
      const mod = this.projectRequire('cypress')
      this.cypressModule = mod.default ?? mod

      this.log('[specbandit:cypress] Setup complete (Cypress module loaded).')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `[specbandit:cypress] Failed to initialize Cypress adapter: ${message}\n` +
          'Make sure cypress is installed as a dependency in your project.',
      )
    }
  }

  async runBatch(files: string[], batchNum: number): Promise<BatchResult> {
    if (!this.cypressModule) {
      throw new Error('[specbandit:cypress] Adapter not initialized. Call setup() first.')
    }

    const spec = files.join(',')
    const startTime = performance.now()
    let exitCode = 0
    let failedFiles: string[] | undefined

    try {
      const runOptions: CypressRunOptions = {
        spec,
        project: this.projectRoot,
        testingType: this.testingType,
        quiet: !this.verbose,
      }

      if (this.configFile) {
        runOptions.configFile = this.configFile
      }

      if (this.browser) {
        runOptions.browser = this.browser
      }

      const result = await this.cypressModule.run(runOptions)

      // CypressFailedRunResult has status === 'failed' when Cypress can't start
      if (isCypressFailedResult(result)) {
        exitCode = 1
        this.log(`[specbandit:cypress] Batch #${batchNum} failed to start: ${result.message}`)
      } else if (result.totalFailed > 0) {
        exitCode = 1
        failedFiles = (result.runs ?? [])
          .filter((run) => (run.stats?.failures ?? 0) > 0)
          .map((run) => run.spec?.relative ?? run.spec?.name ?? '')
          .filter((f) => f !== '')
        if (this.verbose) {
          for (const run of result.runs ?? []) {
            if ((run.stats?.failures ?? 0) > 0) {
              this.log(`[specbandit:cypress] Failed: ${run.spec?.relative ?? run.spec?.name ?? 'unknown'}`)
            }
          }
        }
      }
    } catch (error: unknown) {
      exitCode = 1
      const message = error instanceof Error ? error.message : String(error)
      this.log(`[specbandit:cypress] Batch #${batchNum} error: ${message}`)
    }

    const duration = (performance.now() - startTime) / 1000

    return { batchNum, files, exitCode, duration, failedFiles }
  }

  async teardown(): Promise<void> {
    this.cypressModule = null
    this.log('[specbandit:cypress] Teardown complete.')
  }

  private log(message: string): void {
    this.output.write(message + '\n')
  }
}

// ── Minimal type definitions for Cypress Module API ──

interface CypressRunOptions {
  spec?: string
  project?: string
  configFile?: string
  browser?: string
  testingType?: 'e2e' | 'component'
  quiet?: boolean
}

interface CypressRunResult {
  totalFailed: number
  totalPassed: number
  totalTests: number
  totalPending: number
  totalSkipped: number
  totalDuration: number
  runs?: Array<{
    spec?: { name?: string; relative?: string }
    stats?: { failures: number; passes: number }
  }>
}

interface CypressFailedRunResult {
  status: 'failed'
  failures: number
  message: string
}

interface CypressModule {
  run(options?: CypressRunOptions): Promise<CypressRunResult | CypressFailedRunResult>
}

function isCypressFailedResult(
  result: CypressRunResult | CypressFailedRunResult,
): result is CypressFailedRunResult {
  return 'status' in result && result.status === 'failed'
}
