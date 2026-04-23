import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Worker } from '../src/worker.js'
import { CliAdapter } from '../src/cliAdapter.js'
import { RedisQueue } from '../src/redisQueue.js'
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
