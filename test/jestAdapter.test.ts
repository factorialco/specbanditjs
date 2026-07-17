import { describe, it, expect, vi, beforeEach } from 'vitest'
import { JestAdapter } from '../src/jestAdapter.js'
import { Writable } from 'node:stream'

function createOutputCapture(): { stream: Writable; getOutput: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  })
  return { stream, getOutput: () => chunks.join('') }
}

/** A minimal stand-in for Jest's TestWatcher that records interruption. */
class FakeTestWatcher {
  interrupted = false
  setState = vi.fn((state: { interrupted?: boolean }) => {
    if (state?.interrupted) this.interrupted = true
  })
  isInterrupted(): boolean {
    return this.interrupted
  }
}

interface FakeRunJestArgs {
  outputStream: { write(chunk: string): boolean }
  onComplete: (results: { success: boolean; testResults: unknown[] }) => void
}

/**
 * Inject the private fields that `setup()` would normally populate so we can
 * drive `runBatch()` against a fake Jest without a real Jest install.
 * Returns the list of TestWatcher instances created inside runBatch.
 */
function primeAdapter(
  adapter: JestAdapter,
  runJestFn: (args: FakeRunJestArgs) => Promise<void>,
): FakeTestWatcher[] {
  const watchers: FakeTestWatcher[] = []
  const a = adapter as unknown as Record<string, unknown>
  a.contexts = [{}]
  a.baseGlobalConfig = {}
  a.runJestFn = runJestFn
  a.TestWatcherClass = class extends FakeTestWatcher {
    constructor() {
      super()
      watchers.push(this)
    }
  }
  // Skip the optional resolver-cache clearing (require('jest-resolve')).
  a.coreRequire = () => {
    throw new Error('no resolver in test')
  }
  return watchers
}

describe('JestAdapter', () => {
  let capture: ReturnType<typeof createOutputCapture>

  beforeEach(() => {
    vi.clearAllMocks()
    capture = createOutputCapture()
  })

  describe('constructor', () => {
    it('uses defaults when no options provided', () => {
      const adapter = new JestAdapter()
      expect(adapter.projectRoot).toBe(process.cwd())
      expect(adapter.jestConfig).toBeUndefined()
      expect(adapter.jestOpts).toEqual([])
      expect(adapter.verbose).toBe(false)
    })

    it('accepts custom options', () => {
      const adapter = new JestAdapter({
        projectRoot: '/my/project',
        jestConfig: './jest.config.ts',
        jestOpts: ['--silent', '--coverage'],
        verbose: true,
        output: capture.stream,
      })
      expect(adapter.projectRoot).toBe('/my/project')
      expect(adapter.jestConfig).toBe('./jest.config.ts')
      expect(adapter.jestOpts).toEqual(['--silent', '--coverage'])
      expect(adapter.verbose).toBe(true)
    })
  })

  describe('#setup', () => {
    it('throws when Jest is not installed', async () => {
      const adapter = new JestAdapter({ output: capture.stream })

      await expect(adapter.setup()).rejects.toThrow(
        /Failed to initialize Jest adapter/,
      )
    })
  })

  describe('#runBatch without setup', () => {
    it('throws when adapter is not initialized', async () => {
      const adapter = new JestAdapter({ output: capture.stream })

      await expect(adapter.runBatch(['test.ts'], 1)).rejects.toThrow(
        /Adapter not initialized/,
      )
    })
  })

  describe('#teardown', () => {
    it('can be called even without setup', async () => {
      const adapter = new JestAdapter({ output: capture.stream })
      await expect(adapter.teardown()).resolves.toBeUndefined()
    })

    it('does not touch process.exit', async () => {
      const adapter = new JestAdapter({ output: capture.stream })
      const originalExit = process.exit
      await adapter.teardown()
      // process.exit should be untouched — teardown no longer manages it
      expect(process.exit).toBe(originalExit)
    })
  })

  describe('idle (no-progress) timeout', () => {
    it('passes a slow batch that keeps making progress (no false failure)', async () => {
      const adapter = new JestAdapter({ output: capture.stream, batchIdleTimeoutMs: 120 })
      // Emit output every 40ms (well under the 120ms idle window) for ~200ms —
      // total run > idle window, but no single gap exceeds it — then complete
      // successfully. This is the regression scenario: a 336s batch failing
      // under a 300s *total* cap even though every test passed.
      const watchers = primeAdapter(adapter, (args) => {
        const iv = setInterval(() => args.outputStream.write('PASS some.spec.ts (0.04 s)\n'), 40)
        setTimeout(() => {
          clearInterval(iv)
          args.onComplete({ success: true, testResults: [] })
        }, 200)
        return new Promise((resolve) => setTimeout(resolve, 200))
      })

      const result = await adapter.runBatch(['a.spec.ts'], 1)

      expect(result.exitCode).toBe(0)
      expect(watchers[0]?.setState).not.toHaveBeenCalled()
    })

    it('fails and interrupts a hung batch that produces no output', async () => {
      const adapter = new JestAdapter({ output: capture.stream, batchIdleTimeoutMs: 60 })
      // Never write, never call onComplete: simulate a genuinely stuck run.
      const watchers = primeAdapter(adapter, () => new Promise<void>(() => {}))

      const result = await adapter.runBatch(['a.spec.ts', 'b.spec.ts'], 3)

      expect(result.exitCode).toBe(1)
      // The run must be interrupted so it stops scheduling files and does not
      // leak into the next batch.
      expect(watchers[0]?.setState).toHaveBeenCalledWith({ interrupted: true })
      expect(capture.getOutput()).toMatch(/Batch #3: no test activity for \d+s — treating batch as hung/)
    })

    it('does not time out when disabled (batchIdleTimeoutMs = 0)', async () => {
      const adapter = new JestAdapter({ output: capture.stream, batchIdleTimeoutMs: 0 })
      // Silent for longer than any tiny timeout would allow, then succeeds.
      const watchers = primeAdapter(adapter, (args) => {
        setTimeout(() => args.onComplete({ success: true, testResults: [] }), 150)
        return new Promise((resolve) => setTimeout(resolve, 150))
      })

      const result = await adapter.runBatch(['a.spec.ts'], 1)

      expect(result.exitCode).toBe(0)
      expect(watchers[0]?.setState).not.toHaveBeenCalled()
    })
  })
})
