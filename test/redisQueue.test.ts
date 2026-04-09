import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RedisQueue } from '../src/redisQueue.js'

describe('RedisQueue', () => {
  let queue: RedisQueue
  let mockRedis: {
    rpush: ReturnType<typeof vi.fn>
    expire: ReturnType<typeof vi.fn>
    call: ReturnType<typeof vi.fn>
    llen: ReturnType<typeof vi.fn>
    lrange: ReturnType<typeof vi.fn>
    quit: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    // Create queue and replace the internal redis client with mocks
    queue = new RedisQueue('redis://localhost:6379')

    mockRedis = {
      rpush: vi.fn(),
      expire: vi.fn(),
      call: vi.fn(),
      llen: vi.fn(),
      lrange: vi.fn(),
      quit: vi.fn(),
    }

    // Replace the redis instance with our mock
    ;(queue as any).redis = mockRedis
  })

  describe('#push', () => {
    it('calls RPUSH with the key and files', async () => {
      const files = ['spec/a_spec.rb', 'spec/b_spec.rb', 'spec/c_spec.rb']
      mockRedis.rpush.mockResolvedValue(3)

      const result = await queue.push('my-key', files)

      expect(mockRedis.rpush).toHaveBeenCalledWith('my-key', ...files)
      expect(result).toBe(3)
    })

    it('sets EXPIRE when ttl is provided', async () => {
      const files = ['spec/a_spec.rb']
      mockRedis.rpush.mockResolvedValue(1)
      mockRedis.expire.mockResolvedValue(1)

      await queue.push('my-key', files, 3600)

      expect(mockRedis.rpush).toHaveBeenCalledWith('my-key', ...files)
      expect(mockRedis.expire).toHaveBeenCalledWith('my-key', 3600)
    })

    it('does not set EXPIRE when ttl is undefined', async () => {
      const files = ['spec/a_spec.rb']
      mockRedis.rpush.mockResolvedValue(1)

      await queue.push('my-key', files)

      expect(mockRedis.rpush).toHaveBeenCalled()
      expect(mockRedis.expire).not.toHaveBeenCalled()
    })

    it('returns 0 for empty files without calling Redis', async () => {
      const result = await queue.push('my-key', [])

      expect(mockRedis.rpush).not.toHaveBeenCalled()
      expect(result).toBe(0)
    })
  })

  describe('#steal', () => {
    it('returns an array of files from LPOP', async () => {
      mockRedis.call.mockResolvedValue(['spec/a_spec.rb', 'spec/b_spec.rb', 'spec/c_spec.rb'])

      const result = await queue.steal('my-key', 3)

      expect(mockRedis.call).toHaveBeenCalledWith('LPOP', 'my-key', '3')
      expect(result).toEqual(['spec/a_spec.rb', 'spec/b_spec.rb', 'spec/c_spec.rb'])
    })

    it('returns empty array when LPOP returns null (queue exhausted)', async () => {
      mockRedis.call.mockResolvedValue(null)

      const result = await queue.steal('my-key', 3)
      expect(result).toEqual([])
    })

    it('wraps a single string in an array', async () => {
      mockRedis.call.mockResolvedValue('spec/only_spec.rb')

      const result = await queue.steal('my-key', 1)
      expect(result).toEqual(['spec/only_spec.rb'])
    })

    it('returns empty array for undefined result', async () => {
      mockRedis.call.mockResolvedValue(undefined)

      const result = await queue.steal('my-key', 1)
      expect(result).toEqual([])
    })
  })

  describe('#length', () => {
    it('returns the list length', async () => {
      mockRedis.llen.mockResolvedValue(42)

      const result = await queue.length('my-key')
      expect(result).toBe(42)
    })
  })

  describe('#readAll', () => {
    it('returns all elements via LRANGE non-destructively', async () => {
      const files = ['spec/a_spec.rb', 'spec/b_spec.rb', 'spec/c_spec.rb']
      mockRedis.lrange.mockResolvedValue(files)

      const result = await queue.readAll('my-key')

      expect(mockRedis.lrange).toHaveBeenCalledWith('my-key', 0, -1)
      expect(result).toEqual(files)
    })

    it('returns empty array when key does not exist', async () => {
      mockRedis.lrange.mockResolvedValue([])

      const result = await queue.readAll('missing-key')
      expect(result).toEqual([])
    })
  })

  describe('#close', () => {
    it('quits the Redis connection', async () => {
      mockRedis.quit.mockResolvedValue('OK')

      await queue.close()
      expect(mockRedis.quit).toHaveBeenCalled()
    })
  })
})
