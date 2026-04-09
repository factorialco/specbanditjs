import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RedisQueue } from '../../src/redisQueue.js'
import { Publisher } from '../../src/publisher.js'
import { Worker } from '../../src/worker.js'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Writable } from 'node:stream'
import Redis from 'ioredis'

// Integration test that exercises the full push -> steal -> run cycle
// using a real Redis connection. Skip if Redis is not available.
//
// Port of spec/integration/full_cycle_spec.rb from the Ruby specbandit gem.

const redisUrl = process.env.SPECBANDIT_REDIS_URL ?? 'redis://localhost:6379'

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

// Check Redis availability before running the suite
let redisAvailable = false
try {
  const probe = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  })
  probe.on('error', () => {}) // suppress noisy ioredis error events
  await probe.connect()
  await probe.ping()
  await probe.quit()
  redisAvailable = true
} catch {
  // Redis not available — tests will be skipped
}

const describeFn = redisAvailable ? describe : describe.skip

describeFn('Full cycle integration', () => {
  let redis: Redis
  let key: string

  beforeEach(async () => {
    key = `specbandit-test-${randomBytes(8).toString('hex')}`
    redis = new Redis(redisUrl, { lazyConnect: false })
    await redis.ping()
  })

  afterEach(async () => {
    try {
      await redis?.del(key)
    } catch {
      // ignore
    }
    try {
      await redis?.quit()
    } catch {
      // ignore
    }
  })

  it('pushes files and steals them back in batches', async () => {
    const files = Array.from({ length: 7 }, (_, i) => `spec/fake_${i + 1}_spec.rb`)

    // Push phase
    const queue = new RedisQueue(redisUrl)
    try {
      await queue.push(key, files)
      expect(await queue.length(key)).toBe(7)

      // Steal phase — simulate two workers stealing batches of 3
      const batch1 = await queue.steal(key, 3)
      expect(batch1).toHaveLength(3)
      expect(await queue.length(key)).toBe(4)

      const batch2 = await queue.steal(key, 3)
      expect(batch2).toHaveLength(3)
      expect(await queue.length(key)).toBe(1)

      const batch3 = await queue.steal(key, 3)
      expect(batch3).toHaveLength(1) // Last batch is smaller

      const batch4 = await queue.steal(key, 3)
      expect(batch4).toEqual([]) // Queue exhausted

      // All files were distributed exactly once
      const allStolen = [...batch1, ...batch2, ...batch3]
      expect(allStolen.sort()).toEqual(files.sort())
    } finally {
      await queue.close()
    }
  })

  it('publisher and worker work end-to-end', async () => {
    // Create temporary script files that pass
    const dir = mkdtempSync(join(tmpdir(), 'specbandit-test-'))

    try {
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(dir, `pass_${i}.js`), 'process.exit(0)')
      }

      const specFiles = Array.from({ length: 3 }, (_, i) => join(dir, `pass_${i}.js`)).sort()

      // Push
      const capture = createOutputCapture()
      const publisherQueue = new RedisQueue(redisUrl)
      const publisher = new Publisher({
        key,
        queue: publisherQueue,
        output: capture.stream,
      })
      const count = await publisher.publish({ files: specFiles })
      expect(count).toBe(3)
      await publisherQueue.close()

      // Work
      const workerQueue = new RedisQueue(redisUrl)
      const worker = new Worker({
        key,
        command: 'node',
        batchSize: 2,
        queue: workerQueue,
        output: capture.stream,
      })
      const exitCode = await worker.run()
      await workerQueue.close()

      expect(exitCode).toBe(0)

      const output = capture.getOutput()
      expect(output).toContain('Batch #1: running 2 files')
      expect(output).toContain('Batch #2: running 1 files')
      expect(output).toContain('All passed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
