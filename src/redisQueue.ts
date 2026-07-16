import Redis from 'ioredis'

const DEFAULT_MAX_RETRIES = 5
const BASE_DELAY_MS = 1000
// Cap the exponential backoff so a real outage degrades/fails within a bounded
// window instead of sleeping for minutes on the last attempts.
const MAX_BACKOFF_MS = 10_000

const DEFAULT_CONNECT_TIMEOUT_MS = 3000
const DEFAULT_COMMAND_TIMEOUT_MS = 5000
const DEFAULT_RECONNECT_ATTEMPTS = 3

export interface RedisQueueOptions {
  /** Application-level retry attempts on a connection failure. */
  maxAttempts?: number
  /** ioredis connect timeout, in milliseconds. */
  connectTimeout?: number
  /** ioredis per-command timeout, in milliseconds. */
  commandTimeout?: number
  /** ioredis reconnect / per-request retry budget. */
  reconnectAttempts?: number
}

/** Companion marker key signalling that work was published for `key`. */
function publishedMarkerKey(key: string): string {
  return `${key}:published`
}

export class RedisQueue {
  readonly redis: Redis
  private readonly maxAttempts: number

  constructor(redisUrl: string = 'redis://localhost:6379', options: RedisQueueOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_RETRIES
    const reconnectAttempts = options.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS,
      commandTimeout: options.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
      maxRetriesPerRequest: reconnectAttempts,
      // Bounded reconnection backoff; give up (null) after the reconnect budget
      // so a dead endpoint surfaces as an error the caller can degrade on.
      retryStrategy: (times: number) => (times > reconnectAttempts ? null : Math.min(times * 200, 2000)),
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
   * Mark that work has been published for `key` by setting a companion
   * marker key with the given TTL. The marker outlives the shared queue
   * list (which Redis deletes once fully drained), so workers can tell a
   * drained queue apart from one that was never published.
   */
  async markPublished(key: string, ttl: number): Promise<void> {
    await this.withRetries('markPublished', async () => {
      await this.redis.set(publishedMarkerKey(key), '1', 'EX', ttl)
    })
  }

  /**
   * Returns true when work has been published for `key` (its marker exists).
   */
  async isPublished(key: string): Promise<boolean> {
    return this.withRetries('isPublished', async () => {
      const exists = await this.redis.exists(publishedMarkerKey(key))
      return exists === 1
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
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await fn()
      } catch (error) {
        if (attempt === this.maxAttempts) throw error
        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS)
        console.warn(`[specbandit] Redis ${operation} failed (attempt ${attempt}/${this.maxAttempts}), retrying in ${delay}ms: ${error}`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    // Unreachable, but TypeScript needs it
    throw new Error('Unreachable')
  }
}
