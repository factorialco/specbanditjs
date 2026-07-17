import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Configuration, SpecbanditError } from '../src/configuration.js'

describe('Configuration', () => {
  // Save and restore env vars
  const envVars = [
    'SPECBANDIT_REDIS_URL',
    'SPECBANDIT_BATCH_SIZE',
    'SPECBANDIT_KEY',
    'SPECBANDIT_COMMAND',
    'SPECBANDIT_COMMAND_OPTS',
    'SPECBANDIT_KEY_RERUN',
    'SPECBANDIT_KEY_FAILED',
    'SPECBANDIT_KEY_TTL',
    'SPECBANDIT_VERBOSE',
    'SPECBANDIT_REDIS_MAX_ATTEMPTS',
    'SPECBANDIT_REDIS_CONNECT_TIMEOUT',
    'SPECBANDIT_REDIS_TIMEOUT',
    'SPECBANDIT_REDIS_RECONNECT_ATTEMPTS',
    'SPECBANDIT_JEST_BATCH_TIMEOUT',
  ]
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    savedEnv = {}
    for (const key of envVars) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of envVars) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
  })

  describe('defaults', () => {
    it('uses default redis_url', () => {
      const config = new Configuration()
      expect(config.redisUrl).toBe('redis://localhost:6379')
    })

    it('uses default batch_size', () => {
      const config = new Configuration()
      expect(config.batchSize).toBe(5)
    })

    it('has null key by default', () => {
      const config = new Configuration()
      expect(config.key).toBeNull()
    })

    it('has null command by default', () => {
      const config = new Configuration()
      expect(config.command).toBeNull()
    })

    it('has empty commandOpts by default', () => {
      const config = new Configuration()
      expect(config.commandOpts).toEqual([])
    })

    it('uses a single default key_ttl of 1 week', () => {
      const config = new Configuration()
      expect(config.keyTtl).toBe(604_800)
    })

    it('has null key_rerun by default', () => {
      const config = new Configuration()
      expect(config.keyRerun).toBeNull()
    })

    it('has null key_failed by default', () => {
      const config = new Configuration()
      expect(config.keyFailed).toBeNull()
    })

    it('has verbose false by default', () => {
      const config = new Configuration()
      expect(config.verbose).toBe(false)
    })
  })

  describe('environment variable overrides', () => {
    it('reads redis_url from SPECBANDIT_REDIS_URL', () => {
      process.env.SPECBANDIT_REDIS_URL = 'redis://custom:6380'
      const config = new Configuration()
      expect(config.redisUrl).toBe('redis://custom:6380')
    })

    it('reads batch_size from SPECBANDIT_BATCH_SIZE', () => {
      process.env.SPECBANDIT_BATCH_SIZE = '10'
      const config = new Configuration()
      expect(config.batchSize).toBe(10)
    })

    it('reads key from SPECBANDIT_KEY', () => {
      process.env.SPECBANDIT_KEY = 'pr-42-run-99'
      const config = new Configuration()
      expect(config.key).toBe('pr-42-run-99')
    })

    it('reads command from SPECBANDIT_COMMAND', () => {
      process.env.SPECBANDIT_COMMAND = 'npx jest'
      const config = new Configuration()
      expect(config.command).toBe('npx jest')
    })

    it('parses command_opts from SPECBANDIT_COMMAND_OPTS', () => {
      process.env.SPECBANDIT_COMMAND_OPTS = '--coverage --verbose'
      const config = new Configuration()
      expect(config.commandOpts).toEqual(['--coverage', '--verbose'])
    })

    it('reads key_ttl from SPECBANDIT_KEY_TTL', () => {
      process.env.SPECBANDIT_KEY_TTL = '3600'
      const config = new Configuration()
      expect(config.keyTtl).toBe(3600)
    })

    it('reads key_rerun from SPECBANDIT_KEY_RERUN', () => {
      process.env.SPECBANDIT_KEY_RERUN = 'pr-42-run-99-runner-3'
      const config = new Configuration()
      expect(config.keyRerun).toBe('pr-42-run-99-runner-3')
    })

    it('reads key_failed from SPECBANDIT_KEY_FAILED', () => {
      process.env.SPECBANDIT_KEY_FAILED = 'pr-42-failed'
      const config = new Configuration()
      expect(config.keyFailed).toBe('pr-42-failed')
    })

    it('reads verbose from SPECBANDIT_VERBOSE', () => {
      process.env.SPECBANDIT_VERBOSE = 'true'
      const config = new Configuration()
      expect(config.verbose).toBe(true)
    })

    it('accepts 1/yes/true for verbose', () => {
      for (const val of ['1', 'yes', 'true', 'TRUE', 'Yes']) {
        process.env.SPECBANDIT_VERBOSE = val
        const config = new Configuration()
        expect(config.verbose).toBe(true)
      }
    })
  })

  describe('constructor options override env vars', () => {
    it('prefers explicit options over env vars', () => {
      process.env.SPECBANDIT_KEY = 'env-key'
      process.env.SPECBANDIT_REDIS_URL = 'redis://env:6379'

      const config = new Configuration({
        key: 'explicit-key',
        redisUrl: 'redis://explicit:6380',
      })

      expect(config.key).toBe('explicit-key')
      expect(config.redisUrl).toBe('redis://explicit:6380')
    })
  })

  describe('validate()', () => {
    it('throws when key is null', () => {
      const config = new Configuration()
      config.key = null
      expect(() => config.validate()).toThrow(SpecbanditError)
      expect(() => config.validate()).toThrow(/key is required/)
    })

    it('throws when key is empty string', () => {
      const config = new Configuration({ key: '' })
      expect(() => config.validate()).toThrow(SpecbanditError)
      expect(() => config.validate()).toThrow(/key is required/)
    })

    it('throws when batch_size is not positive', () => {
      const config = new Configuration({ key: 'valid-key', batchSize: 0 })
      expect(() => config.validate()).toThrow(/batch_size must be a positive integer/)
    })

    it('throws when key_ttl is not positive', () => {
      const config = new Configuration({ key: 'valid-key', keyTtl: 0 })
      expect(() => config.validate()).toThrow(/key_ttl must be a positive integer/)
    })

    it('passes when key and batch_size are valid', () => {
      const config = new Configuration({ key: 'valid-key', batchSize: 3 })
      expect(() => config.validate()).not.toThrow()
    })
  })

  describe('resilience settings', () => {
    it('has sensible resilience defaults', () => {
      const config = new Configuration()
      expect(config.redisMaxAttempts).toBe(5)
      expect(config.redisConnectTimeout).toBe(3000)
      expect(config.redisCommandTimeout).toBe(5000)
      expect(config.redisReconnectAttempts).toBe(3)
    })

    it('reads resilience settings from the environment (timeouts in seconds → ms)', () => {
      process.env.SPECBANDIT_REDIS_MAX_ATTEMPTS = '8'
      process.env.SPECBANDIT_REDIS_CONNECT_TIMEOUT = '2.5'
      process.env.SPECBANDIT_REDIS_TIMEOUT = '7'
      process.env.SPECBANDIT_REDIS_RECONNECT_ATTEMPTS = '1'
      const config = new Configuration()
      expect(config.redisMaxAttempts).toBe(8)
      expect(config.redisConnectTimeout).toBe(2500)
      expect(config.redisCommandTimeout).toBe(7000)
      expect(config.redisReconnectAttempts).toBe(1)
    })

    it('throws when redis_max_attempts is not positive', () => {
      const config = new Configuration({ key: 'valid-key', redisMaxAttempts: 0 })
      expect(() => config.validate()).toThrow(/redis_max_attempts must be a positive integer/)
    })
  })

  describe('jest batch timeout', () => {
    it('defaults to 600 seconds (600000 ms)', () => {
      const config = new Configuration()
      expect(config.jestBatchTimeout).toBe(600_000)
    })

    it('reads SPECBANDIT_JEST_BATCH_TIMEOUT from the environment (seconds → ms)', () => {
      process.env.SPECBANDIT_JEST_BATCH_TIMEOUT = '90'
      const config = new Configuration()
      expect(config.jestBatchTimeout).toBe(90_000)
    })

    it('supports 0 to disable the timeout', () => {
      process.env.SPECBANDIT_JEST_BATCH_TIMEOUT = '0'
      const config = new Configuration()
      expect(config.jestBatchTimeout).toBe(0)
    })

    it('clamps negative values to 0 (disabled) rather than firing immediately', () => {
      process.env.SPECBANDIT_JEST_BATCH_TIMEOUT = '-5'
      const config = new Configuration()
      expect(config.jestBatchTimeout).toBe(0)
    })

    it('prefers an explicit option over the environment', () => {
      process.env.SPECBANDIT_JEST_BATCH_TIMEOUT = '90'
      const config = new Configuration({ jestBatchTimeout: 12_345 })
      expect(config.jestBatchTimeout).toBe(12_345)
    })
  })

  describe('validateForWork()', () => {
    it('throws when command is null', () => {
      const config = new Configuration({ key: 'valid-key' })
      expect(() => config.validateForWork()).toThrow(/command is required/)
    })

    it('throws when command is empty string', () => {
      const config = new Configuration({ key: 'valid-key', command: '' })
      expect(() => config.validateForWork()).toThrow(/command is required/)
    })

    it('passes when key and command are valid', () => {
      const config = new Configuration({ key: 'valid-key', command: 'npx jest' })
      expect(() => config.validateForWork()).not.toThrow()
    })
  })
})
