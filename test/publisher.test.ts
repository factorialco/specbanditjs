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
    length: vi.fn(),
    readAll: vi.fn(),
    close: vi.fn(),
    redis: {} as any,
  } as unknown as RedisQueue
}

describe('Publisher', () => {
  let queue: ReturnType<typeof createMockQueue> & { push: ReturnType<typeof vi.fn> }
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
        expect(capture.output.join('')).toContain('Enqueued 2 files')
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
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
      }
    })
  })
})
