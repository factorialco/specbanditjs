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
  keyTtl?: number
  keyRerun?: string | null
  keyRerunTtl?: number
  keyFailed?: string | null
  keyFailedTtl?: number
  rerun?: boolean
  verbose?: boolean
}

const DEFAULT_REDIS_URL = 'redis://localhost:6379'
const DEFAULT_BATCH_SIZE = 5
const DEFAULT_KEY_TTL = 21_600 // 6 hours in seconds
const DEFAULT_KEY_RERUN_TTL = 604_800 // 1 week in seconds

function envTruthy(name: string): boolean {
  const val = process.env[name]?.toLowerCase() ?? ''
  return ['1', 'true', 'yes'].includes(val)
}

function parseCommandOpts(opts: string | undefined | null): string[] {
  if (!opts || opts.trim() === '') return []
  return opts.split(/\s+/)
}

export class Configuration {
  redisUrl: string
  batchSize: number
  key: string | null
  command: string | null
  commandOpts: string[]
  keyTtl: number
  keyRerun: string | null
  keyRerunTtl: number
  keyFailed: string | null
  keyFailedTtl: number
  rerun: boolean
  verbose: boolean

  constructor(options: ConfigurationOptions = {}) {
    this.redisUrl = options.redisUrl ?? process.env.SPECBANDIT_REDIS_URL ?? DEFAULT_REDIS_URL
    this.batchSize = options.batchSize ?? parseInt(process.env.SPECBANDIT_BATCH_SIZE ?? String(DEFAULT_BATCH_SIZE), 10)
    this.key = options.key ?? process.env.SPECBANDIT_KEY ?? null
    this.command = options.command ?? process.env.SPECBANDIT_COMMAND ?? null
    this.commandOpts = options.commandOpts ?? parseCommandOpts(process.env.SPECBANDIT_COMMAND_OPTS)
    this.keyTtl = options.keyTtl ?? parseInt(process.env.SPECBANDIT_KEY_TTL ?? String(DEFAULT_KEY_TTL), 10)
    this.keyRerun = options.keyRerun ?? process.env.SPECBANDIT_KEY_RERUN ?? null
    this.keyRerunTtl = options.keyRerunTtl ?? parseInt(process.env.SPECBANDIT_KEY_RERUN_TTL ?? String(DEFAULT_KEY_RERUN_TTL), 10)
    this.keyFailed = options.keyFailed ?? process.env.SPECBANDIT_KEY_FAILED ?? null
    this.keyFailedTtl = options.keyFailedTtl ?? parseInt(process.env.SPECBANDIT_KEY_FAILED_TTL ?? String(DEFAULT_KEY_RERUN_TTL), 10)
    this.rerun = options.rerun ?? envTruthy('SPECBANDIT_RERUN')
    this.verbose = options.verbose ?? envTruthy('SPECBANDIT_VERBOSE')
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
    if (!Number.isInteger(this.keyRerunTtl) || this.keyRerunTtl <= 0) {
      throw new SpecbanditError('key_rerun_ttl must be a positive integer')
    }
    if (this.rerun && !this.keyRerun) {
      throw new SpecbanditError('--rerun requires --key-rerun to be set')
    }
  }

  validateForWork(): void {
    this.validate()
    if (!this.command || this.command === '') {
      throw new SpecbanditError('command is required for work (set via --command or SPECBANDIT_COMMAND)')
    }
  }
}
