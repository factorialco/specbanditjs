import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RedisQueue } from '../src/redisQueue.js'

describe('RedisQueue', () => {
  let queue: RedisQueue
  let mockRedis: {
    rpush: ReturnType<typeof vi.fn>
    expire: ReturnType<typeof vi.fn>
    call: ReturnType<typeof vi.fn>
    llen: ReturnType<typeof vi.fn>
    lrange: ReturnType<typeof vi.fn>
    set: ReturnType<typeof vi.fn>
    exists: ReturnType<typeof vi.fn>
    quit: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
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
      set: vi.fn(),
      exists: vi.fn(),
      quit: vi.fn(),
      disconnect: vi.fn(),
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

  describe('#markPublished', () => {
    it('sets the published marker key with a TTL via SET EX', async () => {
      mockRedis.set.mockResolvedValue('OK')

      await queue.markPublished('my-key', 3600)

      expect(mockRedis.set).toHaveBeenCalledWith('my-key:published', '1', 'EX', 3600)
    })
  })

  describe('#isPublished', () => {
    it('returns true when the marker key exists', async () => {
      mockRedis.exists.mockResolvedValue(1)

      const result = await queue.isPublished('my-key')

      expect(mockRedis.exists).toHaveBeenCalledWith('my-key:published')
      expect(result).toBe(true)
    })

    it('returns false when the marker key does not exist', async () => {
      mockRedis.exists.mockResolvedValue(0)

      const result = await queue.isPublished('my-key')
      expect(result).toBe(false)
    })
  })

  describe('retry behavior', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('retries on failure and succeeds on second attempt', async () => {
      mockRedis.llen
        .mockRejectedValueOnce(new Error('Connection lost'))
        .mockResolvedValueOnce(5)

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const promise = queue.length('my-key')
      await vi.advanceTimersByTimeAsync(1000)
      const result = await promise

      expect(result).toBe(5)
      expect(mockRedis.llen).toHaveBeenCalledTimes(2)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0][0]).toMatch(/Redis length failed \(attempt 1\/5\)/)

      warnSpy.mockRestore()
    })

    it('retries with exponential backoff', async () => {
      mockRedis.llen
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValueOnce(10)

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const promise = queue.length('my-key')
      await vi.advanceTimersByTimeAsync(1000) // 1st retry: 1s
      await vi.advanceTimersByTimeAsync(2000) // 2nd retry: 2s
      const result = await promise

      expect(result).toBe(10)
      expect(mockRedis.llen).toHaveBeenCalledTimes(3)
      expect(warnSpy).toHaveBeenCalledTimes(2)

      warnSpy.mockRestore()
    })

    it('throws after exhausting all retries (default 5 attempts)', async () => {
      const error = new Error('persistent failure')
      mockRedis.llen.mockRejectedValue(error)

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const promise = queue.length('my-key').catch((e: Error) => e)
      // Capped exponential backoff between the 5 attempts: 1s, 2s, 4s, 8s.
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(2000)
      await vi.advanceTimersByTimeAsync(4000)
      await vi.advanceTimersByTimeAsync(8000)

      const result = await promise
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toBe('Redis length failed after 5 attempts: persistent failure')
      expect(mockRedis.llen).toHaveBeenCalledTimes(5)
      expect(warnSpy).toHaveBeenCalledTimes(4)

      warnSpy.mockRestore()
    })

    it('honours a custom maxAttempts', async () => {
      const q = new RedisQueue('redis://localhost:6379', { maxAttempts: 2 })
      const local = { llen: vi.fn().mockRejectedValue(new Error('down')) }
      ;(q as any).redis = local
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const promise = q.length('my-key').catch((e: Error) => e)
      await vi.advanceTimersByTimeAsync(1000)

      const result = await promise
      expect(result).toBeInstanceOf(Error)
      expect(local.llen).toHaveBeenCalledTimes(2)

      warnSpy.mockRestore()
    })

    it('retries work for push', async () => {
      mockRedis.rpush
        .mockRejectedValueOnce(new Error('Connection lost'))
        .mockResolvedValueOnce(2)

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const promise = queue.push('my-key', ['a', 'b'])
      await vi.advanceTimersByTimeAsync(1000)
      const result = await promise

      expect(result).toBe(2)
      expect(mockRedis.rpush).toHaveBeenCalledTimes(2)

      warnSpy.mockRestore()
    })

    it('retries work for steal', async () => {
      mockRedis.call
        .mockRejectedValueOnce(new Error('Connection lost'))
        .mockResolvedValueOnce(['a', 'b'])

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const promise = queue.steal('my-key', 2)
      await vi.advanceTimersByTimeAsync(1000)
      const result = await promise

      expect(result).toEqual(['a', 'b'])
      expect(mockRedis.call).toHaveBeenCalledTimes(2)

      warnSpy.mockRestore()
    })

    it('retries work for readAll', async () => {
      mockRedis.lrange
        .mockRejectedValueOnce(new Error('Connection lost'))
        .mockResolvedValueOnce(['a', 'b'])

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const promise = queue.readAll('my-key')
      await vi.advanceTimersByTimeAsync(1000)
      const result = await promise

      expect(result).toEqual(['a', 'b'])
      expect(mockRedis.lrange).toHaveBeenCalledTimes(2)

      warnSpy.mockRestore()
    })
  })

  describe('#close', () => {
    it('quits the Redis connection', async () => {
      mockRedis.quit.mockResolvedValue('OK')

      await queue.close()
      expect(mockRedis.quit).toHaveBeenCalled()
      expect(mockRedis.disconnect).not.toHaveBeenCalled()
    })

    it('falls back to disconnect and does not throw when QUIT fails', async () => {
      mockRedis.quit.mockRejectedValue(new Error('Command timed out'))

      await expect(queue.close()).resolves.toBeUndefined()
      expect(mockRedis.disconnect).toHaveBeenCalled()
    })
  })
})
