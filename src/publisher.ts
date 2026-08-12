import fg from 'fast-glob'
import { RedisQueue } from './redisQueue.js'

export interface PublisherOptions {
  key: string
  keyTtl?: number
  queue?: RedisQueue
  output?: NodeJS.WritableStream
}

export class Publisher {
  readonly queue: RedisQueue
  readonly key: string
  readonly keyTtl: number
  readonly output: NodeJS.WritableStream

  constructor(options: PublisherOptions) {
    this.key = options.key
    this.keyTtl = options.keyTtl ?? 604_800
    this.queue = options.queue ?? new RedisQueue()
    this.output = options.output ?? process.stdout
  }

  /**
   * Resolve files from the three input sources (priority: stdin > pattern > args)
   * and push them onto the Redis queue.
   *
   * With `reset: true` the key is emptied first, so the queue ends up holding
   * exactly this work list even if an earlier attempt already pushed one.
   *
   * Returns the number of files enqueued.
   */
  async publish(options: { files?: string[]; pattern?: string; reset?: boolean } = {}): Promise<number> {
    const resolved = await this.resolveFiles(options.files ?? [], options.pattern)

    if (resolved.length === 0) {
      this.log('[specbandit] No files to enqueue.')
      return 0
    }

    // Only reset once there is something to put in its place. Clearing on an
    // empty push would drop the marker too and leave workers crashing on a key
    // that looks like it was never published.
    if (options.reset) await this.resetKey()

    // Time each Redis write so latency is visible in CI logs.
    const pushStart = performance.now()
    await this.queue.push(this.key, resolved, this.keyTtl)
    const pushMs = performance.now() - pushStart

    // Mark the key as published so workers can distinguish a drained queue
    // (nothing to do) from one that was never published (a real error).
    const markStart = performance.now()
    await this.queue.markPublished(this.key, this.keyTtl)
    const markMs = performance.now() - markStart

    this.log(`[specbandit] Enqueued ${resolved.length} files onto key '${this.key}' (TTL: ${this.keyTtl}s).`)
    this.log(`[specbandit] Redis latency: push ${pushMs.toFixed(1)}ms, mark published ${markMs.toFixed(1)}ms.`)
    return resolved.length
  }

  /**
   * Empty the key before pushing. The leftover count is reported because a
   * non-zero one means an earlier attempt pushed a list that no worker ever
   * consumed, which is worth seeing in the producer's log.
   */
  private async resetKey(): Promise<void> {
    const stale = await this.queue.length(this.key)
    await this.queue.clear(this.key)

    this.log(
      stale > 0
        ? `[specbandit] Reset key '${this.key}': discarded ${stale} queued files from a previous push.`
        : `[specbandit] Reset key '${this.key}': nothing left over.`
    )
  }

  private async resolveFiles(files: string[], pattern?: string): Promise<string[]> {
    // Priority 1: stdin (only when data is actually piped in)
    if (!process.stdin.isTTY) {
      const stdinFiles = await this.readStdin()
      if (stdinFiles.length > 0) return stdinFiles
    }

    // Priority 2: --pattern flag (glob resolution)
    if (pattern && pattern.trim() !== '') {
      const globbed = await fg(pattern, { onlyFiles: true })
      return globbed.sort()
    }

    // Priority 3: direct file arguments
    return files
  }

  private readStdin(): Promise<string[]> {
    return new Promise((resolve) => {
      // If stdin has no data ready, don't block
      if (process.stdin.isTTY) {
        resolve([])
        return
      }

      const chunks: Buffer[] = []
      let resolved = false

      // Set a short timeout so we don't block if stdin is connected
      // but nothing is piped
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          process.stdin.removeAllListeners()
          process.stdin.pause()
          resolve([])
        }
      }, 100)

      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk))
      })
      process.stdin.on('end', () => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        const content = Buffer.concat(chunks).toString('utf8')
        const lines = content
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '')
        resolve(lines)
      })
      process.stdin.on('error', () => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        resolve([])
      })
      process.stdin.resume()
    })
  }

  private log(message: string): void {
    this.output.write(message + '\n')
  }
}
