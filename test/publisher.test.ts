import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Publisher } from '../src/publisher.js'
import { RedisQueue } from '../src/redisQueue.js'
import { Writable } from 'node:stream'

vi.mock('fast-glob', () => ({
  default: vi.fn().mockResolvedValue([]),
}))

function createOutputCapture(): { stream: Writable; output: string[] } {
  const output: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output.push(chunk.toString())
      callback()
    },
  })
  return { stream, output }
}

function createMockQueue() {
  return {
    push: vi.fn().mockResolvedValue(0),
    steal: vi.fn(),
    length: vi.fn().mockResolvedValue(0),
    readAll: vi.fn(),
    markPublished: vi.fn().mockResolvedValue(undefined),
    isPublished: vi.fn().mockResolvedValue(true),
    clear: vi.fn().mockResolvedValue(0),
    close: vi.fn(),
    redis: {} as any,
  } as unknown as RedisQueue
}

describe('Publisher', () => {
  let queue: ReturnType<typeof createMockQueue> & {
    push: ReturnType<typeof vi.fn>
    length: ReturnType<typeof vi.fn>
    markPublished: ReturnType<typeof vi.fn>
    clear: ReturnType<typeof vi.fn>
  }
  let capture: ReturnType<typeof createOutputCapture>
  const key = 'pr-123-run-456'

  beforeEach(() => {
    vi.clearAllMocks()
    queue = createMockQueue() as any
    capture = createOutputCapture()
  })

  describe('#publish with direct file arguments', () => {
    it('pushes files to the queue with ttl and returns count', async () => {
      const files = ['test/a.test.ts', 'test/b.test.ts']
      queue.push.mockResolvedValue(2)

      // Make stdin look like a TTY so direct args path is taken
      const origIsTTY = process.stdin.isTTY
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

      try {
        const publisher = new Publisher({
          key,
          keyTtl: 21_600,
          queue: queue as unknown as RedisQueue,
          output: capture.stream,
        })

        const count = await publisher.publish({ files })

        expect(count).toBe(2)
        expect(queue.push).toHaveBeenCalledWith(key, files, 21_600)
        expect(queue.markPublished).toHaveBeenCalledWith(key, 21_600)
        expect(capture.output.join('')).toContain('Enqueued 2 files')
        // Redis write latency is surfaced for both operations
        expect(capture.output.join('')).toMatch(/Redis latency: push [\d.]+ms, mark published [\d.]+ms/)
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
      }
    })
  })

  describe('#publish with pattern', () => {
    it('resolves files via fast-glob', async () => {
      const fg = (await import('fast-glob')).default as unknown as ReturnType<typeof vi.fn>
      fg.mockResolvedValue([
        'test/a.test.ts',
        'test/b.test.ts',
        'test/c.test.ts',
      ])
      queue.push.mockResolvedValue(3)

      const origIsTTY = process.stdin.isTTY
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

      try {
        const publisher = new Publisher({
          key,
          keyTtl: 21_600,
          queue: queue as unknown as RedisQueue,
          output: capture.stream,
        })

        const count = await publisher.publish({ pattern: 'test/**/*.test.ts' })

        expect(count).toBe(3)
        expect(queue.push).toHaveBeenCalledWith(
          key,
          ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'],
          21_600
        )
        expect(capture.output.join('')).toContain('Enqueued 3 files')
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
      }
    })
  })

  describe('#publish with no files', () => {
    it('returns 0 and prints a message', async () => {
      const origIsTTY = process.stdin.isTTY
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

      try {
        const publisher = new Publisher({
          key,
          keyTtl: 21_600,
          queue: queue as unknown as RedisQueue,
          output: capture.stream,
        })

        const count = await publisher.publish({ files: [] })

        expect(count).toBe(0)
        expect(capture.output.join('')).toContain('No files to enqueue')
        // An empty push must NOT mark the key published — workers should
        // crash ("nothing published") rather than silently pass.
        expect(queue.markPublished).not.toHaveBeenCalled()
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
      }
    })
  })

  describe('#publish with reset', () => {
    const files = ['test/a.test.ts', 'test/b.test.ts']

    // Every case here takes the direct-args path, so stdin must look like a TTY.
    async function publish(options: { files?: string[]; reset?: boolean }): Promise<number> {
      const origIsTTY = process.stdin.isTTY
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

      try {
        const publisher = new Publisher({
          key,
          keyTtl: 21_600,
          queue: queue as unknown as RedisQueue,
          output: capture.stream,
        })

        return await publisher.publish(options)
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
      }
    }

    it('clears the key before pushing', async () => {
      const order: string[] = []
      queue.clear.mockImplementation(async () => {
        order.push('clear')
        return 2
      })
      queue.push.mockImplementation(async () => {
        order.push('push')
        return 2
      })

      await publish({ files, reset: true })

      expect(queue.clear).toHaveBeenCalledWith(key)
      expect(order).toEqual(['clear', 'push'])
    })

    it('reports how many files an earlier push left behind', async () => {
      queue.length.mockResolvedValue(4213)

      await publish({ files, reset: true })

      expect(capture.output.join('')).toContain(
        `Reset key '${key}': discarded 4213 queued files from a previous push.`
      )
    })

    it('says so when the key was already empty', async () => {
      queue.length.mockResolvedValue(0)

      await publish({ files, reset: true })

      expect(capture.output.join('')).toContain(`Reset key '${key}': nothing left over.`)
    })

    it('does not clear when reset is not requested', async () => {
      await publish({ files })

      expect(queue.clear).not.toHaveBeenCalled()
    })

    // Clearing here would drop the published marker with nothing to replace
    // it, and every worker on the key would then crash as "never published".
    it('does not clear when there is nothing to push', async () => {
      expect(await publish({ files: [], reset: true })).toBe(0)

      expect(queue.clear).not.toHaveBeenCalled()
    })
  })
})
