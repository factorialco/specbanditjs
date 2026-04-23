import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Worker } from '../src/worker.js'
import { CliAdapter } from '../src/cliAdapter.js'
import { RedisQueue } from '../src/redisQueue.js'
import type { Adapter, BatchResult } from '../src/adapter.js'
import { Writable } from 'node:stream'

/**
 * E2E-style tests for the --key-failed feature.
 *
 * These tests exercise the full Worker → CliAdapter pipeline with a mocked
 * Redis queue, verifying that failed test file paths are recorded in the
 * failed key across different scenarios.
 */

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

describe('E2E: --key-failed', () => {
  let queue: ReturnType<typeof createMockQueue> & {
    push: ReturnType<typeof vi.fn>
    steal: ReturnType<typeof vi.fn>
    readAll: ReturnType<typeof vi.fn>
  }
  let capture: ReturnType<typeof createOutputCapture>
  const key = 'e2e-run-123'
  const keyFailed = 'e2e-run-123-failed'

  beforeEach(() => {
    vi.clearAllMocks()
    queue = createMockQueue() as any
    capture = createOutputCapture()
  })

  it('records failed files to the failed key using CliAdapter with a failing command', async () => {
    // Use `false` as command — always exits with code 1
    const adapter = new CliAdapter({ command: 'false' })

    queue.steal
      .mockResolvedValueOnce(['spec/models/user_spec.rb', 'spec/models/post_spec.rb'])
      .mockResolvedValueOnce(['spec/controllers/api_spec.rb'])
      .mockResolvedValueOnce([])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 2,
      keyFailed,
      keyFailedTtl: 7200,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    const exitCode = await worker.run()

    expect(exitCode).toBe(1)

    // Both batches failed → both pushed to failed key
    expect(queue.push).toHaveBeenCalledWith(
      keyFailed,
      ['spec/models/user_spec.rb', 'spec/models/post_spec.rb'],
      7200,
    )
    expect(queue.push).toHaveBeenCalledWith(
      keyFailed,
      ['spec/controllers/api_spec.rb'],
      7200,
    )
    expect(queue.push).toHaveBeenCalledTimes(2)

    const output = capture.getOutput()
    expect(output).toContain('Batch #1 FAILED')
    expect(output).toContain('Batch #2 FAILED')
    expect(output).toContain('Failed batches: 2')
  })

  it('does not record anything to the failed key when all tests pass', async () => {
    // Use `true` as command — always exits with code 0
    const adapter = new CliAdapter({ command: 'true' })

    queue.steal
      .mockResolvedValueOnce(['spec/models/user_spec.rb'])
      .mockResolvedValueOnce([])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 2,
      keyFailed,
      keyFailedTtl: 7200,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    const exitCode = await worker.run()

    expect(exitCode).toBe(0)
    expect(queue.push).not.toHaveBeenCalled()
  })

  it('records only the failing batch when some pass and some fail', async () => {
    // Batch 1: `true` (pass), Batch 2: `false` (fail)
    // We use a command that fails based on file content.
    // Simpler approach: use CliAdapter with a script that exits based on args.
    // `node -e "process.exit(process.argv.includes('fail.test.ts') ? 1 : 0)"`
    const adapter = new CliAdapter({
      command: 'node',
      commandOpts: ['-e', "process.exit(process.argv.some(a => a.includes('fail')) ? 1 : 0)"],
    })

    queue.steal
      .mockResolvedValueOnce(['pass.test.ts'])
      .mockResolvedValueOnce(['fail.test.ts'])
      .mockResolvedValueOnce([])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 1,
      keyFailed,
      keyFailedTtl: 7200,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    const exitCode = await worker.run()

    expect(exitCode).toBe(1)

    // Only the failing batch is recorded
    expect(queue.push).toHaveBeenCalledTimes(1)
    expect(queue.push).toHaveBeenCalledWith(keyFailed, ['fail.test.ts'], 7200)

    const output = capture.getOutput()
    expect(output).toContain('Batch #1 passed')
    expect(output).toContain('Batch #2 FAILED')
  })

  it('records failed files in replay mode', async () => {
    const adapter = new CliAdapter({ command: 'false' })
    const keyRerun = 'e2e-run-123-rerun'

    queue.readAll.mockResolvedValue(['spec/a_spec.rb', 'spec/b_spec.rb'])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 2,
      keyRerun,
      keyRerunTtl: 604_800,
      keyFailed,
      keyFailedTtl: 7200,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    const exitCode = await worker.run()

    expect(exitCode).toBe(1)
    expect(capture.getOutput()).toContain('Replay mode')
    expect(queue.push).toHaveBeenCalledWith(
      keyFailed,
      ['spec/a_spec.rb', 'spec/b_spec.rb'],
      7200,
    )
  })

  it('works with both --key-failed and --key-rerun in record mode', async () => {
    const adapter = new CliAdapter({ command: 'false' })
    const keyRerun = 'e2e-run-123-rerun'

    queue.readAll.mockResolvedValue([]) // empty rerun → record mode
    queue.steal
      .mockResolvedValueOnce(['spec/a_spec.rb'])
      .mockResolvedValueOnce([])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 2,
      keyRerun,
      keyRerunTtl: 604_800,
      keyFailed,
      keyFailedTtl: 7200,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    const exitCode = await worker.run()

    expect(exitCode).toBe(1)
    expect(capture.getOutput()).toContain('Record mode')

    // Pushed to rerun key (record) and to failed key
    expect(queue.push).toHaveBeenCalledWith(keyRerun, ['spec/a_spec.rb'], 604_800)
    expect(queue.push).toHaveBeenCalledWith(keyFailed, ['spec/a_spec.rb'], 7200)
  })

  it('uses default TTL of 1 week when keyFailedTtl is not specified', async () => {
    const adapter = new CliAdapter({ command: 'false' })

    queue.steal
      .mockResolvedValueOnce(['spec/a_spec.rb'])
      .mockResolvedValueOnce([])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 2,
      keyFailed,
      // keyFailedTtl not set — should default to 604_800
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    await worker.run()

    expect(queue.push).toHaveBeenCalledWith(keyFailed, ['spec/a_spec.rb'], 604_800)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// E2E: per-file failedFiles support
//
// When an adapter (e.g. Jest, Cypress) can report which individual files
// failed within a batch, only those specific files should be pushed to the
// failed key — not the entire batch.
// ────────────────────────────────────────────────────────────────────────────

describe('E2E: --key-failed with per-file failedFiles', () => {
  let queue: ReturnType<typeof createMockQueue> & {
    push: ReturnType<typeof vi.fn>
    steal: ReturnType<typeof vi.fn>
    readAll: ReturnType<typeof vi.fn>
  }
  let capture: ReturnType<typeof createOutputCapture>
  const key = 'e2e-run-456'
  const keyFailed = 'e2e-run-456-failed'

  beforeEach(() => {
    vi.clearAllMocks()
    queue = createMockQueue() as any
    capture = createOutputCapture()
  })

  /**
   * Creates a mock adapter that simulates per-file failure reporting
   * (like Jest or Cypress adapters). The failedFilesByBatch map specifies
   * which files fail in each batch (1-indexed).
   */
  function createPerFileAdapter(failedFilesByBatch: Record<number, string[]>): Adapter {
    return {
      setup: vi.fn().mockResolvedValue(undefined),
      runBatch: vi.fn().mockImplementation(
        async (files: string[], batchNum: number): Promise<BatchResult> => {
          const failedFiles = failedFilesByBatch[batchNum] ?? []
          const exitCode = failedFiles.length > 0 ? 1 : 0
          return { batchNum, files, exitCode, duration: 0.1, failedFiles: failedFiles.length > 0 ? failedFiles : undefined }
        },
      ),
      teardown: vi.fn().mockResolvedValue(undefined),
    }
  }

  it('records only the individual failed files, not the entire batch', async () => {
    // Batch of 3 files where only 1 fails
    const adapter = createPerFileAdapter({
      1: ['test/models/user.test.ts'], // only user.test.ts fails out of 3
    })

    queue.steal
      .mockResolvedValueOnce(['test/models/user.test.ts', 'test/models/post.test.ts', 'test/models/comment.test.ts'])
      .mockResolvedValueOnce([])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 3,
      keyFailed,
      keyFailedTtl: 7200,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    const exitCode = await worker.run()

    expect(exitCode).toBe(1)
    // Only the single failed file is pushed, NOT all 3 batch files
    expect(queue.push).toHaveBeenCalledTimes(1)
    expect(queue.push).toHaveBeenCalledWith(keyFailed, ['test/models/user.test.ts'], 7200)
  })

  it('records multiple failed files from the same batch', async () => {
    // Batch of 4 files where 2 fail
    const adapter = createPerFileAdapter({
      1: ['test/a.test.ts', 'test/c.test.ts'],
    })

    queue.steal
      .mockResolvedValueOnce(['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/d.test.ts'])
      .mockResolvedValueOnce([])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 4,
      keyFailed,
      keyFailedTtl: 7200,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    const exitCode = await worker.run()

    expect(exitCode).toBe(1)
    expect(queue.push).toHaveBeenCalledTimes(1)
    expect(queue.push).toHaveBeenCalledWith(keyFailed, ['test/a.test.ts', 'test/c.test.ts'], 7200)
  })

  it('records per-file failures across multiple batches', async () => {
    // Batch 1: 1 of 2 fails. Batch 2: all pass. Batch 3: 2 of 3 fail.
    const adapter = createPerFileAdapter({
      1: ['test/a.test.ts'],
      // batch 2: no failures
      3: ['test/e.test.ts', 'test/f.test.ts'],
    })

    queue.steal
      .mockResolvedValueOnce(['test/a.test.ts', 'test/b.test.ts'])
      .mockResolvedValueOnce(['test/c.test.ts', 'test/d.test.ts'])
      .mockResolvedValueOnce(['test/e.test.ts', 'test/f.test.ts', 'test/g.test.ts'])
      .mockResolvedValueOnce([])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 3,
      keyFailed,
      keyFailedTtl: 7200,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    const exitCode = await worker.run()

    expect(exitCode).toBe(1)
    // 2 pushes: batch 1 and batch 3 (batch 2 passed)
    expect(queue.push).toHaveBeenCalledTimes(2)
    expect(queue.push).toHaveBeenCalledWith(keyFailed, ['test/a.test.ts'], 7200)
    expect(queue.push).toHaveBeenCalledWith(keyFailed, ['test/e.test.ts', 'test/f.test.ts'], 7200)
  })

  it('falls back to all batch files when adapter does not report failedFiles (CLI adapter)', async () => {
    // Adapter that does NOT set failedFiles (simulates CliAdapter behavior)
    const adapter: Adapter = {
      setup: vi.fn().mockResolvedValue(undefined),
      runBatch: vi.fn().mockImplementation(
        async (files: string[], batchNum: number): Promise<BatchResult> => ({
          batchNum, files, exitCode: 1, duration: 0.1,
          // no failedFiles field
        }),
      ),
      teardown: vi.fn().mockResolvedValue(undefined),
    }

    queue.steal
      .mockResolvedValueOnce(['test/a.test.ts', 'test/b.test.ts'])
      .mockResolvedValueOnce([])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 2,
      keyFailed,
      keyFailedTtl: 7200,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    const exitCode = await worker.run()

    expect(exitCode).toBe(1)
    // Falls back to all batch files since failedFiles is undefined
    expect(queue.push).toHaveBeenCalledWith(keyFailed, ['test/a.test.ts', 'test/b.test.ts'], 7200)
  })

  it('records per-file failures in replay mode', async () => {
    const adapter = createPerFileAdapter({
      1: ['test/b.test.ts'], // only b fails in the replayed batch
    })

    queue.readAll.mockResolvedValue(['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 3,
      keyRerun: 'e2e-run-456-rerun',
      keyFailed,
      keyFailedTtl: 7200,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    const exitCode = await worker.run()

    expect(exitCode).toBe(1)
    expect(capture.getOutput()).toContain('Replay mode')
    expect(queue.push).toHaveBeenCalledWith(keyFailed, ['test/b.test.ts'], 7200)
  })

  it('does not record when failedFiles is an empty array', async () => {
    // Edge case: exitCode=1 but failedFiles is empty (adapter bug or crash)
    const adapter: Adapter = {
      setup: vi.fn().mockResolvedValue(undefined),
      runBatch: vi.fn().mockImplementation(
        async (files: string[], batchNum: number): Promise<BatchResult> => ({
          batchNum, files, exitCode: 1, duration: 0.1, failedFiles: [],
        }),
      ),
      teardown: vi.fn().mockResolvedValue(undefined),
    }

    queue.steal
      .mockResolvedValueOnce(['test/a.test.ts'])
      .mockResolvedValueOnce([])

    const worker = new Worker({
      key,
      adapter,
      batchSize: 2,
      keyFailed,
      keyFailedTtl: 7200,
      queue: queue as unknown as RedisQueue,
      output: capture.stream,
    })

    await worker.run()

    // failedFiles is empty → push is called with empty array, RedisQueue.push handles it (returns 0)
    expect(queue.push).toHaveBeenCalledWith(keyFailed, [], 7200)
  })
})
