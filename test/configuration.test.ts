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
    'SPECBANDIT_KEY_TTL',
    'SPECBANDIT_KEY_RERUN',
    'SPECBANDIT_KEY_RERUN_TTL',
    'SPECBANDIT_VERBOSE',
    'SPECBANDIT_RERUN',
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

    it('uses default key_ttl of 6 hours', () => {
      const config = new Configuration()
      expect(config.keyTtl).toBe(21_600)
    })

    it('has null key_rerun by default', () => {
      const config = new Configuration()
      expect(config.keyRerun).toBeNull()
    })

    it('uses default key_rerun_ttl of 1 week', () => {
      const config = new Configuration()
      expect(config.keyRerunTtl).toBe(604_800)
    })

    it('has verbose false by default', () => {
      const config = new Configuration()
      expect(config.verbose).toBe(false)
    })

    it('has rerun false by default', () => {
      const config = new Configuration()
      expect(config.rerun).toBe(false)
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

    it('reads key_rerun_ttl from SPECBANDIT_KEY_RERUN_TTL', () => {
      process.env.SPECBANDIT_KEY_RERUN_TTL = '86400'
      const config = new Configuration()
      expect(config.keyRerunTtl).toBe(86_400)
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

    it('reads rerun from SPECBANDIT_RERUN', () => {
      process.env.SPECBANDIT_RERUN = '1'
      const config = new Configuration()
      expect(config.rerun).toBe(true)
    })

    it('accepts 1/yes/true for rerun', () => {
      for (const val of ['1', 'yes', 'true', 'TRUE', 'Yes']) {
        process.env.SPECBANDIT_RERUN = val
        const config = new Configuration()
        expect(config.rerun).toBe(true)
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

    it('throws when key_rerun_ttl is not positive', () => {
      const config = new Configuration({ key: 'valid-key', keyRerunTtl: 0 })
      expect(() => config.validate()).toThrow(/key_rerun_ttl must be a positive integer/)
    })

    it('throws when rerun is true but keyRerun is not set', () => {
      const config = new Configuration({ key: 'valid-key', rerun: true })
      expect(() => config.validate()).toThrow(/--rerun requires --key-rerun/)
    })

    it('passes when rerun is true and keyRerun is set', () => {
      const config = new Configuration({ key: 'valid-key', rerun: true, keyRerun: 'some-key' })
      expect(() => config.validate()).not.toThrow()
    })

    it('passes when key and batch_size are valid', () => {
      const config = new Configuration({ key: 'valid-key', batchSize: 3 })
      expect(() => config.validate()).not.toThrow()
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
