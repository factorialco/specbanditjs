export const VERSION = '0.17.0'

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
  fallbackPattern?: string | null
  nodeIndex?: number | null
  nodeTotal?: number | null
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

function parseOptionalInt(value: string | undefined | null): number | null {
  if (value == null || value === '') return null
  return parseInt(value, 10)
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
  fallbackPattern: string | null
  nodeIndex: number | null
  nodeTotal: number | null

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
    this.fallbackPattern = options.fallbackPattern ?? process.env.SPECBANDIT_FALLBACK_PATTERN ?? null
    this.nodeIndex =
      options.nodeIndex ?? parseOptionalInt(process.env.SPECBANDIT_NODE_INDEX ?? process.env.CI_NODE_INDEX)
    this.nodeTotal =
      options.nodeTotal ?? parseOptionalInt(process.env.SPECBANDIT_NODE_TOTAL ?? process.env.CI_NODE_TOTAL)
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
    if (this.fallbackPattern) {
      if (this.nodeIndex == null || this.nodeTotal == null || !Number.isInteger(this.nodeIndex) || !Number.isInteger(this.nodeTotal)) {
        throw new SpecbanditError(
          'fallback requires node index/total (set --node-index/--node-total, SPECBANDIT_NODE_INDEX/SPECBANDIT_NODE_TOTAL or CI_NODE_INDEX/CI_NODE_TOTAL)'
        )
      }
      if (this.nodeTotal <= 0) {
        throw new SpecbanditError('node_total must be a positive integer')
      }
      if (this.nodeIndex < 0 || this.nodeIndex >= this.nodeTotal) {
        throw new SpecbanditError('node_index must be in 0...node_total')
      }
    }
  }

  validateForWork(): void {
    this.validate()
    if (!this.command || this.command === '') {
      throw new SpecbanditError('command is required for work (set via --command or SPECBANDIT_COMMAND)')
    }
  }
}
