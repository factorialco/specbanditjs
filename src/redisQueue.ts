import Redis from 'ioredis'

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

    const count = await this.redis.rpush(key, ...files)
    if (ttl != null) {
      await this.redis.expire(key, ttl)
    }
    return count
  }

  /**
   * Atomically steal up to `count` file paths from the queue.
   * Returns an array of file paths (empty array when exhausted).
   *
   * Uses LPOP with count argument (Redis 6.2+).
   */
  async steal(key: string, count: number): Promise<string[]> {
    // ioredis lpop with count: use call() for the raw LPOP key count form
    const result = await this.redis.call('LPOP', key, String(count)) as string[] | string | null

    if (result === null || result === undefined) return []
    if (typeof result === 'string') return [result]
    return Array.isArray(result) ? result : []
  }

  /**
   * Returns the current length of the queue.
   */
  async length(key: string): Promise<number> {
    return this.redis.llen(key)
  }

  /**
   * Read all file paths from the list non-destructively.
   * Returns an array of file paths (empty array when key doesn't exist).
   */
  async readAll(key: string): Promise<string[]> {
    return this.redis.lrange(key, 0, -1)
  }

  async close(): Promise<void> {
    await this.redis.quit()
  }
}
