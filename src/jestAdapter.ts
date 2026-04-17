import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Adapter, BatchResult } from './adapter.js'

/**
 * Walk up from a resolved module path to find the package directory
 * containing a package.json with the expected name. This is more robust
 * than assuming a fixed depth (e.g. dirname twice) which can break under
 * pnpm's strict hoisting or non-standard package layouts.
 */
function findPackageDir(resolvedPath: string, expectedName: string): string {
  let dir = path.dirname(resolvedPath)
  const root = path.parse(dir).root
  while (dir !== root) {
    const pkgJsonPath = path.join(dir, 'package.json')
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
        if (pkg.name === expectedName) {
          return dir
        }
      } catch {
        // malformed package.json, keep walking
      }
    }
    dir = path.dirname(dir)
  }
  // Fallback: assume 2 levels up from main entry (original behavior)
  return path.dirname(path.dirname(resolvedPath))
}

/**
 * Options for the Jest adapter.
 */
export interface JestAdapterOptions {
  /**
   * Path to the jest config file (e.g. './jest.config.ts').
   * If not provided, Jest uses its default config resolution.
   */
  jestConfig?: string

  /**
   * Project root directory. Defaults to process.cwd().
   */
  projectRoot?: string

  /**
   * Extra CLI flags to pass to Jest (e.g. ['--silent', '--runInBand']).
   */
  jestOpts?: string[]

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
 * Jest adapter: runs Jest programmatically with haste map reuse.
 *
 * On setup(), it reads the Jest config and builds the haste map once.
 * On each runBatch(), it reuses the cached contexts and only changes
 * the testPathPattern to match the batch files. This eliminates the
 * ~2-5s haste map build overhead per batch.
 *
 * This adapter uses Jest internal APIs (pinned to Jest 29.x):
 * - readConfigs from jest-config
 * - Runtime.createHasteMap from jest-runtime
 * - runJest (default export) from @jest/core/build/runJest.js
 * - createContext from @jest/core/build/lib/createContext.js
 *
 * @requires jest@^29.0.0 as a peer dependency
 */
export class JestAdapter implements Adapter {
  readonly projectRoot: string
  readonly jestConfig: string | undefined
  readonly jestOpts: string[]
  readonly verbose: boolean
  readonly output: NodeJS.WritableStream

  // Cached from setup() — typed as `any` since these are Jest internals
  private contexts: any[] | null = null
  private baseGlobalConfig: Record<string, any> | null = null

  // Cached dynamic imports
  private runJestFn: ((args: any) => Promise<void>) | null = null
  private TestWatcherClass: (new (opts: { isWatchMode: boolean }) => any) | null = null

  // Require function rooted at projectRoot for resolving Jest packages
  private projectRequire: NodeRequire

  // Require function rooted at @jest/core for resolving sibling Jest packages
  private coreRequire: NodeRequire | null = null

  constructor(options: JestAdapterOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd()
    this.jestConfig = options.jestConfig
    this.jestOpts = options.jestOpts ?? []
    this.verbose = options.verbose ?? false
    this.output = options.output ?? process.stdout

    // Create a require function rooted at the project root.
    // This ensures Jest packages are resolved from the project's node_modules,
    // not from specbandit's installation directory.
    const requireBase = path.resolve(this.projectRoot, '__specbandit_resolve__.js')
    this.projectRequire = createRequire(requireBase)
  }

  async setup(): Promise<void> {
    this.log('[specbandit:jest] Initializing Jest adapter...')

    try {
      // Require Jest packages from the project root's node_modules.
      // Using createRequire ensures resolution happens from projectRoot,
      // not from specbandit's installation directory.
      //
      // For internal files of Jest packages, we resolve @jest/core's main
      // entry to find its package directory, then require internal files by
      // absolute path. This bypasses the "exports" field in package.json
      // which blocks deep imports.
      //
      // IMPORTANT: We must resolve @jest/core through jest's own directory,
      // not directly from the project root. In pnpm monorepos, the project
      // root may resolve @jest/core to a different major version (e.g. @27
      // from another workspace like webpage) instead of the expected @29.
      // First resolve `jest` itself, then resolve `@jest/core` from jest's
      // directory. This guarantees we get the @jest/core version that matches
      // the installed jest (e.g. @jest/core@29 for jest@29), even when pnpm
      // hoisting makes a different major version (e.g. @jest/core@27 from
      // another workspace) visible from the project root.
      const jestMainPath = this.projectRequire.resolve('jest')
      const jestPkgDir = findPackageDir(jestMainPath, 'jest')
      const jestRequire = createRequire(path.join(jestPkgDir, 'index.js'))
      const coreMainPath = jestRequire.resolve('@jest/core')

      // Find @jest/core's package directory by locating its package.json.
      // We walk up from the resolved main entry until we find package.json
      // with name "@jest/core". This is more robust than assuming a fixed
      // directory depth (e.g. build/index.js being 2 levels deep), which
      // can break under different package managers or resolution strategies.
      const corePkgDir = findPackageDir(coreMainPath, '@jest/core')

      // Create a require function rooted at @jest/core's location so all
      // sibling Jest packages resolve to the same major version.
      const coreRequire = createRequire(path.join(corePkgDir, 'index.js'))
      this.coreRequire = coreRequire

      const jestConfigMod = coreRequire('jest-config')
      const runtimeMod = coreRequire('jest-runtime')

      const createContextMod = this.projectRequire(path.join(corePkgDir, 'build', 'lib', 'createContext.js'))
      const runJestMod = this.projectRequire(path.join(corePkgDir, 'build', 'runJest.js'))

      const readConfigs = jestConfigMod.readConfigs
      const Runtime = runtimeMod.default ?? runtimeMod
      const createContext = createContextMod.default ?? createContextMod.createContext
      this.runJestFn = runJestMod.default

      // Resolve TestWatcher from @jest/core's jest-watcher dependency (not
      // the project root's, which may be a different major version under pnpm).
      const watcherMod = coreRequire('jest-watcher')
      this.TestWatcherClass = watcherMod.TestWatcher ?? watcherMod.default?.TestWatcher ?? watcherMod.default
      if (!this.TestWatcherClass) {
        // Absolute path fallback — bypasses the "exports" field
        const watcherMainPath = coreRequire.resolve('jest-watcher')
        const watcherPkgDir = findPackageDir(watcherMainPath, 'jest-watcher')
        const testWatcherMod = this.projectRequire(path.join(watcherPkgDir, 'build', 'TestWatcher.js'))
        this.TestWatcherClass = testWatcherMod.default ?? testWatcherMod.TestWatcher ?? testWatcherMod
      }

      // Build argv for Jest config reading
      const argv = this.buildArgv()

      const startTime = performance.now()
      const { globalConfig, configs } = await readConfigs(argv, [this.projectRoot])
      this.baseGlobalConfig = globalConfig

      // Build haste maps and contexts (the expensive part — done only once)
      // Use a unique temp directory for the haste map cache to avoid race conditions
      // when multiple workers build the haste map concurrently for the same project.
      const uniqueCacheDir = path.join(os.tmpdir(), `specbandit_jest_${process.pid}_${Date.now()}`)
      mkdirSync(uniqueCacheDir, { recursive: true })

      this.contexts = await Promise.all(
        configs.map(async (config: any) => {
          // Override cacheDirectory to avoid sharing with other concurrent workers
          const isolatedConfig = { ...config, cacheDirectory: uniqueCacheDir }
          const hasteMapInstance = await Runtime.createHasteMap(isolatedConfig, {
            maxWorkers: 1,
            resetCache: false,
            watch: false,
            watchman: globalConfig.watchman ?? false,
          })

          const { hasteFS, moduleMap } = await hasteMapInstance.build()
          return createContext(config, { hasteFS, moduleMap })
        }),
      )

      const duration = ((performance.now() - startTime) / 1000).toFixed(2)
      this.log(
        `[specbandit:jest] Setup complete in ${duration}s (${this.contexts.length} project(s), haste map built)`,
      )
      this.log(
        `[specbandit:jest] Post-setup state: contexts=${this.contexts ? 'set' : 'null'}, ` +
        `globalConfig=${this.baseGlobalConfig ? 'set' : 'null'}, ` +
        `runJestFn=${typeof this.runJestFn}, ` +
        `TestWatcher=${typeof this.TestWatcherClass}`,
      )
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `[specbandit:jest] Failed to initialize Jest adapter: ${message}\n` +
          'Make sure jest@^29.0.0 is installed as a dependency.',
      )
    }
  }

  async runBatch(files: string[], batchNum: number): Promise<BatchResult> {
    // Capture all references locally at the start of the batch.
    // This protects against teardown() nullifying instance fields if it
    // runs concurrently (e.g. due to the `exit` npm package used by Jest
    // internals triggering early promise resolution in the worker).
    const contexts = this.contexts
    const baseGlobalConfig = this.baseGlobalConfig
    const runJest = this.runJestFn
    const TestWatcher = this.TestWatcherClass

    if (!contexts || !baseGlobalConfig || !runJest || !TestWatcher) {
      throw new Error(
        `[specbandit:jest] Adapter not initialized. Call setup() first.`,
      )
    }

    // Build a testPathPattern that matches exactly these files
    const testPathPattern = files.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')

    // Create a modified globalConfig for this batch
    const batchGlobalConfig = {
      ...baseGlobalConfig,
      testPathPattern,
      passWithNoTests: true,
    }

    const startTime = performance.now()
    let exitCode = 0

    // Intercept process.exit for this batch only.
    // Jest's `exit` npm package (used in runJest.js) replaces stdout/stderr
    // write functions with no-ops and then calls process.exit(). We must:
    //   1. Prevent the exit from killing our process
    //   2. Restore stdout/stderr write functions that `exit` clobbered
    const origExit = process.exit
    const origStdoutWrite = process.stdout.write
    const origStderrWrite = process.stderr.write
    let exitIntercepted = false

    process.exit = ((code?: number) => {
      exitIntercepted = true
      // The `exit` npm package replaces stdout/stderr.write with no-ops
      // before calling process.exit. Restore them immediately.
      process.stdout.write = origStdoutWrite
      process.stderr.write = origStderrWrite
      this.log(`[specbandit:jest] Intercepted process.exit(${code}) in batch #${batchNum}`)
    }) as typeof process.exit

    try {
      interface RunJestResult {
        success: boolean
        testResults: Array<{
          testFilePath: string
          numPassingTests: number
          numFailingTests: number
          failureMessage?: string
        }>
      }

      const result = await new Promise<RunJestResult>((resolve, reject) => {
        // Safety timeout: if onComplete is never called (e.g. because
        // the `exit` package killed stdout before Jest could report),
        // resolve with a failure after 5 minutes.
        const timeout = setTimeout(() => {
          resolve({ success: false, testResults: [] })
          this.log(`[specbandit:jest] Batch #${batchNum} timed out waiting for onComplete`)
        }, 300_000)

        runJest({
          contexts,
          globalConfig: batchGlobalConfig,
          outputStream: this.verbose ? process.stderr : new NullWritable(),
          testWatcher: new TestWatcher({ isWatchMode: false }),
          onComplete: (results: RunJestResult) => {
            clearTimeout(timeout)
            resolve(results)
          },
        }).catch((err: unknown) => {
          clearTimeout(timeout)
          reject(err)
        })
      })

      if (!result.success) {
        exitCode = 1
        if (this.verbose) {
          for (const testResult of result.testResults) {
            if (testResult.numFailingTests > 0 && testResult.failureMessage) {
              this.log(testResult.failureMessage)
            }
          }
        }
      }
    } catch (error: unknown) {
      exitCode = 1
      const message = error instanceof Error ? error.message : String(error)
      this.log(`[specbandit:jest] Batch #${batchNum} error: ${message}`)
    } finally {
      // Always restore process.exit and stdio after each batch
      process.exit = origExit
      // Restore stdout/stderr in case `exit` package clobbered them
      // and our interceptor didn't fire (edge case)
      process.stdout.write = origStdoutWrite
      process.stderr.write = origStderrWrite
    }

    if (exitIntercepted) {
      exitCode = 1
    }

    // Clear the resolver cache between batches
    try {
      const resolverMod = (this.coreRequire ?? this.projectRequire)('jest-resolve')
      const Resolver = resolverMod.default ?? resolverMod
      if (typeof Resolver.clearDefaultResolverCache === 'function') {
        Resolver.clearDefaultResolverCache()
      }
    } catch {
      // Resolver cache clearing is optional
    }

    // Force garbage collection between batches when --expose-gc is enabled.
    // Without this, V8 lazily expands the heap up to --max-old-space-size before
    // collecting, which can cause OOM in long-running in-process Jest sessions
    // even when the actual live set is well within limits.
    if (typeof global.gc === 'function') {
      global.gc()
      const mem = process.memoryUsage()
      this.log(
        `[specbandit:jest] Post-GC heap: ${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB used / ${(mem.heapTotal / 1024 / 1024).toFixed(0)} MB total`
      )
    }

    const duration = (performance.now() - startTime) / 1000

    return { batchNum, files, exitCode, duration }
  }

  async teardown(): Promise<void> {
    this.log('[specbandit:jest] Tearing down Jest adapter...')
    this.contexts = null
    this.baseGlobalConfig = null
    this.runJestFn = null
    this.TestWatcherClass = null
    this.coreRequire = null
    this.log('[specbandit:jest] Teardown complete.')
  }

  /**
   * Build a yargs-style argv object for Jest config reading.
   */
  private buildArgv(): Record<string, unknown> {
    const argv: Record<string, unknown> = {
      _: [],
      $0: 'jest',
      runInBand: true,
      passWithNoTests: true,
    }

    if (this.jestConfig) {
      argv.config = this.jestConfig
    }

    // Parse jestOpts into argv
    for (let i = 0; i < this.jestOpts.length; i++) {
      const opt = this.jestOpts[i]
      if (opt.startsWith('--')) {
        const key = opt.slice(2).replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase())
        const nextOpt = this.jestOpts[i + 1]
        if (nextOpt && !nextOpt.startsWith('--')) {
          argv[key] = nextOpt
          i++
        } else {
          argv[key] = true
        }
      }
    }

    return argv
  }

  private log(message: string): void {
    this.output.write(message + '\n')
  }
}

/**
 * A writable stream that discards all input.
 * Used to suppress Jest output when not in verbose mode.
 */
class NullWritable {
  write(_chunk: unknown, _encoding?: unknown, _callback?: unknown): boolean {
    if (typeof _encoding === 'function') {
      ;(_encoding as () => void)()
    } else if (typeof _callback === 'function') {
      ;(_callback as () => void)()
    }
    return true
  }
  end(): this {
    return this
  }
  on(): this {
    return this
  }
  once(): this {
    return this
  }
  emit(): boolean {
    return false
  }
  removeListener(): this {
    return this
  }
}
