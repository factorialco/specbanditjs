import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import Redis from 'ioredis'
import { VERSION } from '../../src/configuration.js'

// CLI-level E2E tests that exercise the built binary (dist/bin.js)
// via spawnSync, testing push/work subcommands end-to-end.

const redisUrl = process.env.SPECBANDIT_REDIS_URL ?? 'redis://localhost:6379'
const binPath = join(import.meta.dirname, '..', '..', 'dist', 'bin.js')

function runCLI(...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [binPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 20_000,
  })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

// Check prerequisites before running the suite
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

const binExists = existsSync(binPath)

const describeFn = redisAvailable && binExists ? describe : describe.skip

describeFn('CLI integration', () => {
  let redis: Redis
  let key: string

  beforeAll(() => {
    if (!binExists) {
      console.warn(`dist/bin.js not found at ${binPath}. Run "npm run build" first.`)
    }
  })

  beforeEach(async () => {
    key = `specbandit-cli-test-${randomBytes(8).toString('hex')}`
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

  it('push and work via CLI - all pass', () => {
    // Create temporary script files that pass
    const dir = mkdtempSync(join(tmpdir(), 'specbandit-cli-test-'))

    try {
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(dir, `pass_${i}.js`), 'process.exit(0)')
      }

      const specFiles = Array.from({ length: 3 }, (_, i) => join(dir, `pass_${i}.js`)).sort()

      // Push via CLI
      const pushResult = runCLI(
        'push',
        '--key', key,
        '--redis-url', redisUrl,
        ...specFiles,
      )
      expect(pushResult.exitCode).toBe(0)
      expect(pushResult.stdout).toContain('Enqueued 3 files')

      // Work via CLI
      const workResult = runCLI(
        'work',
        '--key', key,
        '--redis-url', redisUrl,
        '--command', 'node',
        '--batch-size', '2',
      )
      expect(workResult.exitCode).toBe(0)
      expect(workResult.stdout).toContain('Batch #1: running 2 files')
      expect(workResult.stdout).toContain('Batch #2: running 1 files')
      expect(workResult.stdout).toContain('All passed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('push and work via CLI - with failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'specbandit-cli-test-'))

    try {
      writeFileSync(join(dir, 'pass.js'), 'process.exit(0)')
      writeFileSync(join(dir, 'fail.js'), 'process.exit(1)')

      const specFiles = [join(dir, 'fail.js'), join(dir, 'pass.js')].sort()

      // Push via CLI
      const pushResult = runCLI(
        'push',
        '--key', key,
        '--redis-url', redisUrl,
        ...specFiles,
      )
      expect(pushResult.exitCode).toBe(0)
      expect(pushResult.stdout).toContain('Enqueued 2 files')

      // Work via CLI — batch size 1 so each file is its own batch
      const workResult = runCLI(
        'work',
        '--key', key,
        '--redis-url', redisUrl,
        '--command', 'node',
        '--batch-size', '1',
      )
      expect(workResult.exitCode).toBe(1)
      expect(workResult.stdout).toContain('FAILED')
      expect(workResult.stdout).toContain('SOME FAILED')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('help and version flags', () => {
    it('--help returns usage information', () => {
      const result = runCLI('--help')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Usage:')
      expect(result.stdout).toContain('specbandit push')
      expect(result.stdout).toContain('specbandit work')
    })

    it('--version returns the version', () => {
      const result = runCLI('--version')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(`specbandit ${VERSION}`)
    })

    it('unknown command returns error', () => {
      const result = runCLI('unknown')
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Unknown command: unknown')
    })
  })
})
