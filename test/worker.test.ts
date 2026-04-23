import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Worker } from '../src/worker.js'
import { RedisQueue } from '../src/redisQueue.js'
import type { Adapter, BatchResult } from '../src/adapter.js'
import { Writable } from 'node:stream'
import * as childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }),
}))

// ────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────────────────

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

function createMockQueue() {
  return {
    push: vi.fn().mockResolvedValue(0),
    steal: vi.fn().mockResolvedValue([]),
    length: vi.fn().mockResolvedValue(0),
    readAll: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    redis: {} as any,
  } as unknown as RedisQueue
}

/** A mock Adapter whose runBatch returns success by default. */
function createMockAdapter(): Adapter & {
  setup: ReturnType<typeof vi.fn>
  runBatch: ReturnType<typeof vi.fn>
  teardown: ReturnType<typeof vi.fn>
} {
  return {
    setup: vi.fn().mockResolvedValue(undefined),
    runBatch: vi.fn().mockImplementation(
      async (files: string[], batchNum: number): Promise<BatchResult> => ({
        batchNum,
        files,
        exitCode: 0,
        duration: 0.1,
      }),
    ),
    teardown: vi.fn().mockResolvedValue(undefined),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Adapter factory for parameterized tests.
//
// Each factory returns:
//   - adapterOpts:    partial Worker constructor options (either `adapter` or `command`)
//   - failBatch(n):   make the n-th runBatch call fail (1-indexed)
//   - batchCallCount: how many times the adapter actually ran
// ────────────────────────────────────────────────────────────────────────────

interface AdapterFixture {
  name: string
  adapterOpts: Record<string, unknown>
  /** Make the n-th batch call (1-indexed) exit with code 1. Call before .run(). */
  failBatch: (...ns: number[]) => void
  /** Number of times the adapter actually executed a batch. */
  batchCallCount: () => number
}

function cliAdapterFixture(): AdapterFixture {
  return {
    name: 'CliAdapter (legacy)',
    adapterOpts: { command: 'node', commandOpts: [] },
    failBatch(...ns: number[]) {
      const mock = vi.mocked(childProcess.spawnSync)
      // Reset to success first, then set failures
      mock.mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') } as any)
      for (const n of ns) {
        // mockReturnValueOnce stacks sequentially; we need the n-th call to fail.
        // Reset and rebuild the chain.
      }
      // Rebuild: success for all, except the ones in `ns` (1-indexed).
      mock.mockReset()
      let callIdx = 0
      mock.mockImplementation(() => {
        callIdx++
        const status = ns.includes(callIdx) ? 1 : 0
        return { status, stdout: Buffer.from(''), stderr: Buffer.from('') } as any
      })
    },
    batchCallCount: () => vi.mocked(childProcess.spawnSync).mock.calls.length,
  }
}

function mockAdapterFixture(): AdapterFixture {
  const adapter = createMockAdapter()
  const failSet = new Set<number>()

  // Override runBatch to check failSet
  adapter.runBatch.mockImplementation(
    async (files: string[], batchNum: number): Promise<BatchResult> => ({
      batchNum,
      files,
      exitCode: failSet.has(batchNum) ? 1 : 0,
      duration: 0.1,
    }),
  )

  return {
    name: 'MockAdapter (adapter-based)',
    adapterOpts: { adapter },
    failBatch(...ns: number[]) {
      for (const n of ns) failSet.add(n)
    },
    batchCallCount: () => adapter.runBatch.mock.calls.length,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Parameterized Worker tests — all behaviors tested against both adapters
// ────────────────────────────────────────────────────────────────────────────

describe.each([
  { factory: cliAdapterFixture },
  { factory: mockAdapterFixture },
])('Worker [$factory.name]', ({ factory }) => {
  let fixture: AdapterFixture
  let queue: ReturnType<typeof createMockQueue> & {
    push: ReturnType<typeof vi.fn>
    steal: ReturnType<typeof vi.fn>
    readAll: ReturnType<typeof vi.fn>
  }
  let capture: ReturnType<typeof createOutputCapture>
  const key = 'pr-123-run-456'

  // Dynamically set the suite name from the fixture
  beforeEach(() => {
    vi.clearAllMocks()
    fixture = factory()
    queue = createMockQueue() as any
    capture = createOutputCapture()
  })

  function makeWorker(overrides: Record<string, unknown> = {}) {
    return new Worker({
      key,
      batchSize: 2,
      keyRerun: null,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
      ...fixture.adapterOpts,
      ...overrides,
    } as any)
  }

  // ── Steal mode ────────────────────────────────────────────────────────

  describe('steal mode (no key_rerun)', () => {
    it('returns 0 when queue is empty from the start', async () => {
      queue.steal.mockResolvedValue([])
      const exitCode = await makeWorker().run()
      expect(exitCode).toBe(0)
      expect(capture.getOutput()).toContain('Nothing to do')
    })

    it('steals and runs batches until queue is exhausted', async () => {
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts', 'test/b.test.ts'])
        .mockResolvedValueOnce(['test/c.test.ts'])
        .mockResolvedValueOnce([])

      const exitCode = await makeWorker().run()

      expect(exitCode).toBe(0)
      expect(fixture.batchCallCount()).toBe(2)
      expect(capture.getOutput()).toContain('Batch #1: running 2 files')
      expect(capture.getOutput()).toContain('Batch #2: running 1 files')
      expect(capture.getOutput()).toContain('All passed')
    })

    it('returns 1 if any batch fails', async () => {
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts', 'test/b.test.ts'])
        .mockResolvedValueOnce(['test/c.test.ts'])
        .mockResolvedValueOnce([])

      fixture.failBatch(2)

      const exitCode = await makeWorker().run()

      expect(exitCode).toBe(1)
      expect(capture.getOutput()).toContain('Batch #1 passed')
      expect(capture.getOutput()).toContain('Batch #2 FAILED')
      expect(capture.getOutput()).toContain('SOME FAILED')
    })

    it('continues stealing after a batch failure', async () => {
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts'])
        .mockResolvedValueOnce(['test/b.test.ts'])
        .mockResolvedValueOnce([])

      fixture.failBatch(1)

      const exitCode = await makeWorker().run()

      expect(exitCode).toBe(1)
      expect(fixture.batchCallCount()).toBe(2)
    })

    it('does not push to any rerun key', async () => {
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts'])
        .mockResolvedValueOnce([])

      await makeWorker().run()
      expect(queue.push).not.toHaveBeenCalled()
    })
  })

  // ── Failed key mode ───────────────────────────────────────────────────

  describe('key-failed (recording failed test files)', () => {
    const keyFailed = 'pr-123-failed'

    it('pushes failed batch files to the failed key', async () => {
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts', 'test/b.test.ts'])
        .mockResolvedValueOnce(['test/c.test.ts'])
        .mockResolvedValueOnce([])

      fixture.failBatch(1)

      const exitCode = await makeWorker({ keyFailed, keyFailedTtl: 3600 }).run()

      expect(exitCode).toBe(1)
      expect(queue.push).toHaveBeenCalledWith(keyFailed, ['test/a.test.ts', 'test/b.test.ts'], 3600)
      // Batch 2 passed, so should NOT be pushed to failed key
      expect(queue.push).toHaveBeenCalledTimes(1)
    })

    it('pushes multiple failed batches to the failed key', async () => {
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts'])
        .mockResolvedValueOnce(['test/b.test.ts'])
        .mockResolvedValueOnce([])

      fixture.failBatch(1, 2)

      await makeWorker({ keyFailed, keyFailedTtl: 3600 }).run()

      expect(queue.push).toHaveBeenCalledWith(keyFailed, ['test/a.test.ts'], 3600)
      expect(queue.push).toHaveBeenCalledWith(keyFailed, ['test/b.test.ts'], 3600)
      expect(queue.push).toHaveBeenCalledTimes(2)
    })

    it('does not push to failed key when all batches pass', async () => {
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts'])
        .mockResolvedValueOnce([])

      await makeWorker({ keyFailed, keyFailedTtl: 3600 }).run()

      expect(queue.push).not.toHaveBeenCalled()
    })

    it('does not push to failed key when keyFailed is not set', async () => {
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts'])
        .mockResolvedValueOnce([])

      fixture.failBatch(1)

      await makeWorker().run()

      expect(queue.push).not.toHaveBeenCalled()
    })

    it('pushes failed files in replay mode too', async () => {
      queue.readAll.mockResolvedValue(['test/x.test.ts', 'test/y.test.ts', 'test/z.test.ts'])

      fixture.failBatch(2)

      await makeWorker({ keyFailed, keyFailedTtl: 3600, keyRerun: 'pr-123-rerun' }).run()

      // Batch 2 has 1 file (z.test.ts) with batchSize=2: batch1=[x,y], batch2=[z]
      expect(queue.push).toHaveBeenCalledWith(keyFailed, ['test/z.test.ts'], 3600)
    })

    it('works together with keyRerun in record mode', async () => {
      queue.readAll.mockResolvedValue([]) // empty rerun key → record mode
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts'])
        .mockResolvedValueOnce([])

      fixture.failBatch(1)

      const keyRerun = 'pr-123-rerun'
      await makeWorker({ keyFailed, keyFailedTtl: 3600, keyRerun, keyRerunTtl: 604_800 }).run()

      // Should push to both rerun key (record) and failed key
      expect(queue.push).toHaveBeenCalledWith(keyRerun, ['test/a.test.ts'], 604_800)
      expect(queue.push).toHaveBeenCalledWith(keyFailed, ['test/a.test.ts'], 3600)
    })
  })

  // ── Record mode ───────────────────────────────────────────────────────

  describe('record mode (key_rerun set, rerun key empty)', () => {
    const keyRerun = 'pr-123-run-456-runner-3'

    beforeEach(() => {
      queue.readAll.mockResolvedValue([])
    })

    it('steals from the main key and records batches to the rerun key', async () => {
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts', 'test/b.test.ts'])
        .mockResolvedValueOnce(['test/c.test.ts'])
        .mockResolvedValueOnce([])

      const exitCode = await makeWorker({ keyRerun, keyRerunTtl: 604_800 }).run()

      expect(exitCode).toBe(0)
      expect(capture.getOutput()).toContain('Record mode')
      expect(capture.getOutput()).toContain('Recording stolen files to rerun key')

      expect(queue.push).toHaveBeenCalledWith(keyRerun, ['test/a.test.ts', 'test/b.test.ts'], 604_800)
      expect(queue.push).toHaveBeenCalledWith(keyRerun, ['test/c.test.ts'], 604_800)
    })

    it('returns 1 if any batch fails but still records all batches', async () => {
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts'])
        .mockResolvedValueOnce([])

      fixture.failBatch(1)

      const exitCode = await makeWorker({ keyRerun, keyRerunTtl: 604_800 }).run()

      expect(exitCode).toBe(1)
      expect(queue.push).toHaveBeenCalledWith(keyRerun, ['test/a.test.ts'], 604_800)
      expect(capture.getOutput()).toContain('SOME FAILED')
    })
  })

  // ── Replay mode ───────────────────────────────────────────────────────

  describe('replay mode (key_rerun set, rerun key has data)', () => {
    const keyRerun = 'pr-123-run-456-runner-3'
    const recordedFiles = ['test/x.test.ts', 'test/y.test.ts', 'test/z.test.ts']

    beforeEach(() => {
      queue.readAll.mockResolvedValue(recordedFiles)
    })

    it('runs files from the rerun key in batches', async () => {
      const exitCode = await makeWorker({ keyRerun, keyRerunTtl: 604_800 }).run()

      expect(exitCode).toBe(0)
      // 3 files with batch_size 2 = 2 batches
      expect(fixture.batchCallCount()).toBe(2)
      expect(capture.getOutput()).toContain('Replay mode: found 3 files')
      expect(capture.getOutput()).toContain('Batch #1: running 2 files')
      expect(capture.getOutput()).toContain('Batch #2: running 1 files')
      expect(capture.getOutput()).toContain('Replay finished')
    })

    it('never touches the shared queue', async () => {
      await makeWorker({ keyRerun, keyRerunTtl: 604_800 }).run()

      expect(queue.steal).not.toHaveBeenCalled()
      expect(queue.push).not.toHaveBeenCalled()
    })

    it('returns 1 if any replay batch fails', async () => {
      fixture.failBatch(2)

      const exitCode = await makeWorker({ keyRerun, keyRerunTtl: 604_800 }).run()

      expect(exitCode).toBe(1)
      expect(capture.getOutput()).toContain('SOME FAILED')
    })
  })

  // ── Verbose mode ──────────────────────────────────────────────────────

  describe('verbose mode', () => {
    it('shows file list per batch when verbose', async () => {
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts'])
        .mockResolvedValueOnce([])

      await makeWorker({ verbose: true }).run()
      expect(capture.getOutput()).toContain('  test/a.test.ts')
    })

    it('hides file list per batch when quiet', async () => {
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts'])
        .mockResolvedValueOnce([])

      await makeWorker({ verbose: false }).run()
      expect(capture.getOutput()).toContain('Batch #1: running 1 files')
      expect(capture.getOutput()).not.toContain('  test/a.test.ts')
    })
  })

  // ── Summary & reporting ───────────────────────────────────────────────

  describe('summary and reporting', () => {
    it('prints summary with batch count and timing stats', async () => {
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts'])
        .mockResolvedValueOnce(['test/b.test.ts'])
        .mockResolvedValueOnce([])

      await makeWorker().run()

      const output = capture.getOutput()
      expect(output).toContain('[specbandit] Summary')
      expect(output).toContain('Batches:        2')
      expect(output).toContain('Files:          2')
      expect(output).toContain('Failed batches: 0')
      expect(output).toContain('Batch timing: min')
    })

    it('prints failed batches in the summary', async () => {
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts'])
        .mockResolvedValueOnce([])

      fixture.failBatch(1)

      await makeWorker().run()

      const output = capture.getOutput()
      expect(output).toContain('Failed batches (1)')
      expect(output).toContain('Batch #1 (exit code 1)')
    })

    describe('JSON output', () => {
      let tmpDir: string

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specbandit-test-'))
      })

      afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      })

      it('writes JSON results to --json-out file', async () => {
        const jsonOutPath = path.join(tmpDir, 'results.json')
        queue.steal
          .mockResolvedValueOnce(['test/a.test.ts'])
          .mockResolvedValueOnce(['test/b.test.ts'])
          .mockResolvedValueOnce([])

        fixture.failBatch(2)

        await makeWorker({ jsonOut: jsonOutPath }).run()

        expect(fs.existsSync(jsonOutPath)).toBe(true)
        const data = JSON.parse(fs.readFileSync(jsonOutPath, 'utf8'))
        expect(data.summary.total_files).toBe(2)
        expect(data.summary.total_batches).toBe(2)
        expect(data.summary.failed_batches).toBe(1)
        expect(data.summary.passed).toBe(false)
        expect(data.batch_timings.count).toBe(2)
        expect(data.batches).toHaveLength(2)
      })

      it('does not write JSON when --json-out is not set', async () => {
        const jsonOutPath = path.join(tmpDir, 'results.json')
        queue.steal
          .mockResolvedValueOnce(['test/a.test.ts'])
          .mockResolvedValueOnce([])

        await makeWorker().run()
        expect(fs.existsSync(jsonOutPath)).toBe(false)
      })
    })

  })
})

// ────────────────────────────────────────────────────────────────────────────
// Adapter lifecycle tests (specific to the adapter interface)
// ────────────────────────────────────────────────────────────────────────────

describe('Worker adapter lifecycle', () => {
  let queue: ReturnType<typeof createMockQueue> & {
    push: ReturnType<typeof vi.fn>
    steal: ReturnType<typeof vi.fn>
    readAll: ReturnType<typeof vi.fn>
  }
  let capture: ReturnType<typeof createOutputCapture>
  const key = 'pr-123-run-456'

  beforeEach(() => {
    vi.clearAllMocks()
    queue = createMockQueue() as any
    capture = createOutputCapture()
  })

  it('calls setup before batches and teardown after', async () => {
    const adapter = createMockAdapter()
    const callOrder: string[] = []

    adapter.setup.mockImplementation(async () => { callOrder.push('setup') })
    adapter.runBatch.mockImplementation(async (files: string[], batchNum: number) => {
      callOrder.push(`batch-${batchNum}`)
      return { batchNum, files, exitCode: 0, duration: 0.1 }
    })
    adapter.teardown.mockImplementation(async () => { callOrder.push('teardown') })

    queue.steal
      .mockResolvedValueOnce(['test/a.test.ts'])
      .mockResolvedValueOnce([])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 2,
      keyRerun: null,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    await worker.run()

    expect(callOrder).toEqual(['setup', 'batch-1', 'teardown'])
  })

  it('calls teardown even when a batch fails', async () => {
    const adapter = createMockAdapter()
    adapter.runBatch.mockResolvedValueOnce({
      batchNum: 1, files: ['test/a.test.ts'], exitCode: 1, duration: 0.5,
    } as BatchResult)

    queue.steal
      .mockResolvedValueOnce(['test/a.test.ts'])
      .mockResolvedValueOnce([])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 2,
      keyRerun: null,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    const exitCode = await worker.run()

    expect(exitCode).toBe(1)
    expect(adapter.teardown).toHaveBeenCalledOnce()
  })

  it('calls teardown even when adapter.runBatch throws', async () => {
    const adapter = createMockAdapter()
    adapter.runBatch.mockRejectedValueOnce(new Error('adapter crash'))

    queue.steal
      .mockResolvedValueOnce(['test/a.test.ts'])
      .mockResolvedValueOnce([])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 2,
      keyRerun: null,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    await expect(worker.run()).rejects.toThrow('adapter crash')
    expect(adapter.teardown).toHaveBeenCalledOnce()
  })

  describe('rerun safety flag', () => {
    const keyRerun = 'pr-123-run-456-runner-3'

    it('exits 1 with error when rerun=true and rerun key is empty', async () => {
      queue.readAll.mockResolvedValue([])
      const adapter = createMockAdapter()

      const worker = new Worker({
        key,
        adapter,
        batchSize: 2,
        keyRerun,
        keyRerunTtl: 604_800,
        rerun: true,
        queue: queue as unknown as RedisQueue,
        output: capture.stream,
      })

      const exitCode = await worker.run()

      expect(exitCode).toBe(1)
      expect(capture.getOutput()).toContain('ERROR: --rerun flag is set but rerun key')
      expect(capture.getOutput()).toContain(keyRerun)
      expect(capture.getOutput()).toContain('Cannot replay')
      expect(queue.steal).not.toHaveBeenCalled()
      expect(adapter.runBatch).not.toHaveBeenCalled()
    })

    it('replays normally when rerun=true and rerun key has data', async () => {
      queue.readAll.mockResolvedValue(['test/x.test.ts', 'test/y.test.ts'])
      const adapter = createMockAdapter()

      const worker = new Worker({
        key,
        adapter,
        batchSize: 2,
        keyRerun,
        keyRerunTtl: 604_800,
        rerun: true,
        queue: queue as unknown as RedisQueue,
        output: capture.stream,
      })

      const exitCode = await worker.run()

      expect(exitCode).toBe(0)
      expect(capture.getOutput()).toContain('Replay mode: found 2 files')
      expect(queue.steal).not.toHaveBeenCalled()
    })

    it('falls through to record mode when rerun=false and rerun key is empty', async () => {
      queue.readAll.mockResolvedValue([])
      queue.steal
        .mockResolvedValueOnce(['test/a.test.ts'])
        .mockResolvedValueOnce([])
      const adapter = createMockAdapter()

      const worker = new Worker({
        key,
        adapter,
        batchSize: 2,
        keyRerun,
        keyRerunTtl: 604_800,
        rerun: false,
        queue: queue as unknown as RedisQueue,
        output: capture.stream,
      })

      const exitCode = await worker.run()

      expect(exitCode).toBe(0)
      expect(capture.getOutput()).toContain('Record mode')
      expect(queue.steal).toHaveBeenCalled()
    })
  })

  it('spawnSync is never called when using a custom adapter', async () => {
    const adapter = createMockAdapter()
    queue.steal
      .mockResolvedValueOnce(['test/a.test.ts'])
      .mockResolvedValueOnce([])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 2,
      keyRerun: null,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    await worker.run()
    expect(childProcess.spawnSync).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Legacy constructor (backward compat)
// ────────────────────────────────────────────────────────────────────────────

describe('Worker legacy constructor', () => {
  let queue: ReturnType<typeof createMockQueue> & {
    steal: ReturnType<typeof vi.fn>
  }
  let capture: ReturnType<typeof createOutputCapture>
  const key = 'pr-123-run-456'

  beforeEach(() => {
    vi.clearAllMocks()
    queue = createMockQueue() as any
    capture = createOutputCapture()
  })

  it('passes command and commandOpts to spawnSync via CliAdapter', async () => {
    queue.steal
      .mockResolvedValueOnce(['test/a.test.ts'])
      .mockResolvedValueOnce([])

    const worker = new Worker({
      key,
      command: 'npx jest',
      commandOpts: ['--coverage'],
      batchSize: 2,
      keyRerun: null,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    await worker.run()

    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      'npx',
      ['jest', '--coverage', 'test/a.test.ts'],
      expect.objectContaining({ shell: false }),
    )
  })
})
