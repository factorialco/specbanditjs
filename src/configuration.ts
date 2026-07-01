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
  ttl?: number
  verbose?: boolean
}

const DEFAULT_REDIS_URL = 'redis://localhost:6379'
const DEFAULT_BATCH_SIZE = 5
const DEFAULT_TTL = 604_800 // 1 week in seconds

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
  keyRerun: string | null
  keyFailed: string | null
  ttl: number
  verbose: boolean

  constructor(options: ConfigurationOptions = {}) {
    this.redisUrl = options.redisUrl ?? process.env.SPECBANDIT_REDIS_URL ?? DEFAULT_REDIS_URL
    this.batchSize = options.batchSize ?? parseInt(process.env.SPECBANDIT_BATCH_SIZE ?? String(DEFAULT_BATCH_SIZE), 10)
    this.key = options.key ?? process.env.SPECBANDIT_KEY ?? null
    this.command = options.command ?? process.env.SPECBANDIT_COMMAND ?? null
    this.commandOpts = options.commandOpts ?? parseCommandOpts(process.env.SPECBANDIT_COMMAND_OPTS)
    this.keyRerun = options.keyRerun ?? process.env.SPECBANDIT_KEY_RERUN ?? null
    this.keyFailed = options.keyFailed ?? process.env.SPECBANDIT_KEY_FAILED ?? null
    this.ttl = options.ttl ?? parseInt(process.env.SPECBANDIT_TTL ?? String(DEFAULT_TTL), 10)
    this.verbose = options.verbose ?? envTruthy('SPECBANDIT_VERBOSE')
  }

  validate(): void {
    if (!this.key || this.key === '') {
      throw new SpecbanditError('key is required (set via --key or SPECBANDIT_KEY)')
    }
    if (!Number.isInteger(this.batchSize) || this.batchSize <= 0) {
      throw new SpecbanditError('batch_size must be a positive integer')
    }
    if (!Number.isInteger(this.ttl) || this.ttl <= 0) {
      throw new SpecbanditError('ttl must be a positive integer')
    }
  }

  validateForWork(): void {
    this.validate()
    if (!this.command || this.command === '') {
      throw new SpecbanditError('command is required for work (set via --command or SPECBANDIT_COMMAND)')
    }
  }
}
