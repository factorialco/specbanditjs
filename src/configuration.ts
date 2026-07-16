export const VERSION = '0.10.0'

export class SpecbanditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpecbanditError'
  }
}

export interface ConfigurationOptions {
  redisUrl?: string
  batchSize?: number
  key?: string | null
  command?: string | null
  commandOpts?: string[]
  keyRerun?: string | null
  keyFailed?: string | null
  keyTtl?: number
  verbose?: boolean
  redisMaxAttempts?: number
  redisConnectTimeout?: number
  redisCommandTimeout?: number
  redisReconnectAttempts?: number
}

const DEFAULT_REDIS_URL = 'redis://localhost:6379'
const DEFAULT_BATCH_SIZE = 5
const DEFAULT_KEY_TTL = 604_800 // 1 week in seconds

// Redis connection resilience. Redis is a best-effort coordination store for a
// distributed test run, and CI runners can sit a WAN hop away from it (e.g. a
// cross-datacenter mesh), so a transient blip must not red the build. Timeouts
// are expressed in SECONDS in the env (matching the Ruby gem) and converted to
// milliseconds for ioredis.
const DEFAULT_REDIS_MAX_ATTEMPTS = 5
const DEFAULT_REDIS_CONNECT_TIMEOUT_S = 3
const DEFAULT_REDIS_COMMAND_TIMEOUT_S = 5
const DEFAULT_REDIS_RECONNECT_ATTEMPTS = 3

function envTruthy(name: string): boolean {
  const val = process.env[name]?.toLowerCase() ?? ''
  return ['1', 'true', 'yes'].includes(val)
}

function parseCommandOpts(opts: string | undefined | null): string[] {
  if (!opts || opts.trim() === '') return []
  return opts.split(/\s+/)
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = parseInt(raw, 10)
  return Number.isNaN(n) ? fallback : n
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = parseFloat(raw)
  return Number.isNaN(n) ? fallback : n
}


export class Configuration {
  redisUrl: string
  batchSize: number
  key: string | null
  command: string | null
  commandOpts: string[]
  keyRerun: string | null
  keyFailed: string | null
  keyTtl: number
  verbose: boolean
  /** Application-level retry attempts on a Redis connection failure. */
  redisMaxAttempts: number
  /** ioredis connect timeout, in milliseconds. */
  redisConnectTimeout: number
  /** ioredis per-command timeout, in milliseconds. */
  redisCommandTimeout: number
  /** ioredis reconnect / per-request retry budget. */
  redisReconnectAttempts: number

  constructor(options: ConfigurationOptions = {}) {
    this.redisUrl = options.redisUrl ?? process.env.SPECBANDIT_REDIS_URL ?? DEFAULT_REDIS_URL
    this.batchSize = options.batchSize ?? parseInt(process.env.SPECBANDIT_BATCH_SIZE ?? String(DEFAULT_BATCH_SIZE), 10)
    this.key = options.key ?? process.env.SPECBANDIT_KEY ?? null
    this.command = options.command ?? process.env.SPECBANDIT_COMMAND ?? null
    this.commandOpts = options.commandOpts ?? parseCommandOpts(process.env.SPECBANDIT_COMMAND_OPTS)
    this.keyRerun = options.keyRerun ?? process.env.SPECBANDIT_KEY_RERUN ?? null
    this.keyFailed = options.keyFailed ?? process.env.SPECBANDIT_KEY_FAILED ?? null
    this.keyTtl = options.keyTtl ?? parseInt(process.env.SPECBANDIT_KEY_TTL ?? String(DEFAULT_KEY_TTL), 10)
    this.verbose = options.verbose ?? envTruthy('SPECBANDIT_VERBOSE')

    this.redisMaxAttempts =
      options.redisMaxAttempts ?? envInt('SPECBANDIT_REDIS_MAX_ATTEMPTS', DEFAULT_REDIS_MAX_ATTEMPTS)
    this.redisConnectTimeout =
      options.redisConnectTimeout ??
      Math.round(envFloat('SPECBANDIT_REDIS_CONNECT_TIMEOUT', DEFAULT_REDIS_CONNECT_TIMEOUT_S) * 1000)
    this.redisCommandTimeout =
      options.redisCommandTimeout ??
      Math.round(envFloat('SPECBANDIT_REDIS_TIMEOUT', DEFAULT_REDIS_COMMAND_TIMEOUT_S) * 1000)
    this.redisReconnectAttempts =
      options.redisReconnectAttempts ?? envInt('SPECBANDIT_REDIS_RECONNECT_ATTEMPTS', DEFAULT_REDIS_RECONNECT_ATTEMPTS)
  }

  validate(): void {
    if (!this.key || this.key === '') {
      throw new SpecbanditError('key is required (set via --key or SPECBANDIT_KEY)')
    }
    if (!Number.isInteger(this.batchSize) || this.batchSize <= 0) {
      throw new SpecbanditError('batch_size must be a positive integer')
    }
    if (!Number.isInteger(this.keyTtl) || this.keyTtl <= 0) {
      throw new SpecbanditError('key_ttl must be a positive integer')
    }
    if (!Number.isInteger(this.redisMaxAttempts) || this.redisMaxAttempts <= 0) {
      throw new SpecbanditError('redis_max_attempts must be a positive integer')
    }
  }

  validateForWork(): void {
    this.validate()
    if (!this.command || this.command === '') {
      throw new SpecbanditError('command is required for work (set via --command or SPECBANDIT_COMMAND)')
    }
  }
}
