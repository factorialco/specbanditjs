import Redis from 'ioredis'

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000

export class RedisQueue {
  readonly redis: Redis

  constructor(redisUrl: string = 'redis://localhost:6379') {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    })
  }

  /**
   * Push file paths onto the queue and set an expiry on the key.
   * Returns the new length of the list.
   */
  async push(key: string, files: string[], ttl?: number): Promise<number> {
    if (files.length === 0) return 0

    return this.withRetries('push', async () => {
      const count = await this.redis.rpush(key, ...files)
      if (ttl != null) {
        await this.redis.expire(key, ttl)
      }
      return count
    })
  }

  /**
   * Atomically steal up to `count` file paths from the queue.
   * Returns an array of file paths (empty array when exhausted).
   *
   * Uses LPOP with count argument (Redis 6.2+).
   */
  async steal(key: string, count: number): Promise<string[]> {
    return this.withRetries('steal', async () => {
      const result = await this.redis.call('LPOP', key, String(count)) as string[] | string | null

      if (result === null || result === undefined) return []
      if (typeof result === 'string') return [result]
      return Array.isArray(result) ? result : []
    })
  }

  /**
   * Returns the current length of the queue.
   */
  async length(key: string): Promise<number> {
    return this.withRetries('length', async () => {
      return this.redis.llen(key)
    })
  }

  /**
   * Read all file paths from the list non-destructively.
   * Returns an array of file paths (empty array when key doesn't exist).
   */
  async readAll(key: string): Promise<string[]> {
    return this.withRetries('readAll', async () => {
      return this.redis.lrange(key, 0, -1)
    })
  }

  async close(): Promise<void> {
    await this.redis.quit()
  }

  private async withRetries<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn()
      } catch (error) {
        if (attempt === MAX_RETRIES) throw error
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
        console.warn(`[specbandit] Redis ${operation} failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms: ${error}`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    // Unreachable, but TypeScript needs it
    throw new Error('Unreachable')
  }
}
