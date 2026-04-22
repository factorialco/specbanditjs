import { Configuration, SpecbanditError, VERSION } from './configuration.js'
import { Publisher } from './publisher.js'
import { RedisQueue } from './redisQueue.js'
import { Worker } from './worker.js'
import { CliAdapter } from './cliAdapter.js'
import { JestAdapter } from './jestAdapter.js'
import { CypressAdapter } from './cypressAdapter.js'
import type { Adapter } from './adapter.js'

function parseArgs(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {}
  const positional: string[] = []
  let i = 0

  while (i < argv.length) {
    const arg = argv[i]

    if (arg === '--') {
      // Everything after -- goes to positional
      positional.push(...argv.slice(i + 1))
      break
    }

    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      // Boolean flags
      if (key === 'verbose' || key === 'help' || key === 'rerun') {
        flags[key] = 'true'
        i++
        continue
      }
      // Flags with values
      const value = argv[i + 1]
      if (value !== undefined && !value.startsWith('--')) {
        flags[key] = value
        i += 2
      } else {
        flags[key] = 'true'
        i++
      }
    } else if (arg === '-h') {
      flags['help'] = 'true'
      i++
    } else if (arg === '-v') {
      flags['version'] = 'true'
      i++
    } else {
      positional.push(arg)
      i++
    }
  }

  return { flags, positional }
}

async function runPush(argv: string[]): Promise<number> {
  const { flags, positional } = parseArgs(argv)

  if (flags.help) {
    console.log(`Usage: specbandit push [options] [files...]

Options:
  --key KEY            Redis queue key (required, or set SPECBANDIT_KEY)
  --pattern PATTERN    Glob pattern for file discovery (e.g. 'src/**/*.test.ts')
  --redis-url URL      Redis URL (default: redis://localhost:6379)
  --key-ttl SECONDS    TTL for the Redis key (default: 21600 / 6 hours)
  -h, --help           Show this help`)
    return 0
  }

  const config = new Configuration({
    key: flags.key,
    redisUrl: flags['redis-url'],
    keyTtl: flags['key-ttl'] ? parseInt(flags['key-ttl'], 10) : undefined,
  })
  config.validate()

  const queue = new RedisQueue(config.redisUrl)
  try {
    const publisher = new Publisher({
      key: config.key!,
      keyTtl: config.keyTtl,
      queue,
    })

    const count = await publisher.publish({
      files: positional.length > 0 ? positional : undefined,
      pattern: flags.pattern,
    })

    return count > 0 ? 0 : 1
  } finally {
    await queue.close()
  }
}

/**
 * Build the appropriate adapter based on CLI flags.
 *
 * --adapter jest    → JestAdapter (runs Jest programmatically, haste map reuse)
 * --adapter cypress → CypressAdapter (runs Cypress programmatically via Module API)
 * --adapter cli     → CliAdapter (default, spawns shell commands)
 * (no --adapter)    → CliAdapter (backward compatible)
 */
function buildAdapter(flags: Record<string, string>, config: Configuration): Adapter {
  const adapterType = (flags.adapter ?? process.env.SPECBANDIT_ADAPTER ?? 'cli').toLowerCase()

  switch (adapterType) {
    case 'jest':
      return new JestAdapter({
        jestConfig: flags['jest-config'] ?? process.env.SPECBANDIT_JEST_CONFIG,
        projectRoot: flags['project-root'] ?? process.env.SPECBANDIT_PROJECT_ROOT,
        jestOpts: config.commandOpts, // Reuse commandOpts as jestOpts
        verbose: config.verbose,
      })

    case 'cypress':
      return new CypressAdapter({
        configFile: flags['cypress-config'] ?? process.env.SPECBANDIT_CYPRESS_CONFIG,
        projectRoot: flags['project-root'] ?? process.env.SPECBANDIT_PROJECT_ROOT,
        browser: flags['cypress-browser'] ?? process.env.SPECBANDIT_CYPRESS_BROWSER,
        testingType: (flags['cypress-testing-type'] ?? process.env.SPECBANDIT_CYPRESS_TESTING_TYPE ?? 'e2e') as 'e2e' | 'component',
        verbose: config.verbose,
      })

    case 'cli':
      if (!config.command) {
        throw new SpecbanditError('command is required for CLI adapter (set via --command or SPECBANDIT_COMMAND)')
      }
      return new CliAdapter({
        command: config.command,
        commandOpts: config.commandOpts,
      })

    default:
      throw new SpecbanditError(`Unknown adapter: ${adapterType}. Supported: cli, jest, cypress`)
  }
}

async function runWork(argv: string[]): Promise<number> {
  const { flags, positional } = parseArgs(argv)

  if (flags.help) {
    console.log(`Usage: specbandit work [options] [-- extra-opts...]

Options:
  --key KEY              Redis queue key (required, or set SPECBANDIT_KEY)
  --adapter TYPE         Adapter type: 'cli' (default), 'jest', or 'cypress'
  --command CMD          Command to run with file paths (required for cli adapter)
  --command-opts OPTS    Extra options forwarded to the command/jest (space-separated)
  --jest-config PATH     Path to jest config file (for jest adapter)
  --cypress-config PATH  Path to cypress config file (for cypress adapter)
  --cypress-browser B    Browser to use (for cypress adapter, e.g. chrome, firefox)
  --cypress-testing-type Testing type: 'e2e' (default) or 'component' (for cypress adapter)
  --project-root PATH    Project root directory (for jest/cypress adapters, default: cwd)
  --batch-size N         Files per batch (default: 5)
  --redis-url URL        Redis URL (default: redis://localhost:6379)
  --key-rerun KEY        Per-runner rerun key for re-run support
   --key-rerun-ttl SECS   TTL for rerun key (default: 604800 / 1 week)
  --rerun                Safety flag: fail if rerun key is empty (prevents silent false passes)
  --verbose              Show per-batch file list and full command output
  --json-out PATH        Write merged JSON results to file
  -h, --help             Show this help

Arguments after -- are forwarded to the adapter (jest opts, command opts, etc.).

Adapters:
  cli     (default) Spawns a shell command for each batch. Works with any test runner.
          Requires --command.
  jest    Runs Jest programmatically with haste map reuse. No process startup overhead.
          Requires jest@^29.0.0 installed as a dependency.
  cypress Runs Cypress programmatically via Module API. Each batch launches a fresh browser.
          Requires cypress@^13.0.0 installed as a dependency.`)
    return 0
  }

  const adapterType = (flags.adapter ?? process.env.SPECBANDIT_ADAPTER ?? 'cli').toLowerCase()

  // Merge --command-opts and positional args after `--` into a single list.
  // This supports both `--command-opts "--silent --json"` and `-- --silent --json`.
  const explicitOpts = flags['command-opts'] ? flags['command-opts'].split(/\s+/) : []
  const mergedOpts = [...explicitOpts, ...positional]

  // For the jest adapter, command is not required
  const config = new Configuration({
    key: flags.key,
    command: flags.command,
    commandOpts: mergedOpts.length > 0 ? mergedOpts : undefined,
    batchSize: flags['batch-size'] ? parseInt(flags['batch-size'], 10) : undefined,
    redisUrl: flags['redis-url'],
    keyRerun: flags['key-rerun'],
    keyRerunTtl: flags['key-rerun-ttl'] ? parseInt(flags['key-rerun-ttl'], 10) : undefined,
    rerun: flags.rerun === 'true' ? true : undefined,
    verbose: flags.verbose === 'true' ? true : undefined,
  })

  // Only validate command requirement for CLI adapter
  if (adapterType === 'cli') {
    config.validateForWork()
  } else if (adapterType === 'jest' || adapterType === 'cypress') {
    config.validate()
  } else {
    config.validateForWork()
  }

  const adapter = buildAdapter(flags, config)
  const queue = new RedisQueue(config.redisUrl)

  try {
    const worker = new Worker({
      key: config.key!,
      adapter,
      batchSize: config.batchSize,
      keyRerun: config.keyRerun,
      keyRerunTtl: config.keyRerunTtl,
      rerun: config.rerun,
      verbose: config.verbose,
      queue,
      jsonOut: flags['json-out'] ?? null,
    })

    return await worker.run()
  } finally {
    await queue.close()
  }
}

function printUsage(): void {
  console.log(`specbandit v${VERSION} - Distributed test runner using Redis

Usage:
  specbandit push [options] [files...]           Enqueue test files into Redis
  specbandit work [options] [-- extra-opts...]   Steal and run test file batches

Push options:
  --key KEY              Redis queue key (required, or set SPECBANDIT_KEY)
  --pattern PATTERN      Glob pattern for file discovery (e.g. 'src/**/*.test.ts')
  --redis-url URL        Redis URL (default: redis://localhost:6379)
  --key-ttl SECONDS      TTL for the Redis key (default: 21600 / 6 hours)

Work options:
  --key KEY              Redis queue key (required, or set SPECBANDIT_KEY)
  --adapter TYPE         Adapter type: 'cli' (default), 'jest', or 'cypress'
  --command CMD          Command to run with file paths (required for cli adapter)
  --command-opts OPTS    Extra options forwarded to the command/jest (space-separated)
  --jest-config PATH     Path to jest config file (for jest adapter)
  --cypress-config PATH  Path to cypress config file (for cypress adapter)
  --cypress-browser B    Browser to use (for cypress adapter, e.g. chrome, firefox)
  --cypress-testing-type Testing type: 'e2e' (default) or 'component' (for cypress adapter)
  --project-root PATH    Project root directory (for jest/cypress adapters, default: cwd)
  --batch-size N         Files per batch (default: 5, or set SPECBANDIT_BATCH_SIZE)
  --redis-url URL        Redis URL (default: redis://localhost:6379)
  --key-rerun KEY        Per-runner rerun key for re-run support
  --key-rerun-ttl N      TTL for rerun key (default: 604800 / 1 week)
  --rerun                Safety flag: fail if rerun key is empty
  --verbose              Show per-batch file list and full command output
  --json-out PATH        Write merged JSON results to file

  Arguments after -- are forwarded to the adapter (jest opts, command opts, etc.).
  They are merged with --command-opts if both are provided.

Environment variables:
  SPECBANDIT_KEY              Queue key
  SPECBANDIT_REDIS_URL        Redis URL
  SPECBANDIT_ADAPTER          Adapter type (cli/jest/cypress)
  SPECBANDIT_COMMAND          Command to run (cli adapter)
  SPECBANDIT_COMMAND_OPTS     Command/jest options (space-separated)
  SPECBANDIT_JEST_CONFIG      Jest config path (jest adapter)
  SPECBANDIT_CYPRESS_CONFIG   Cypress config path (cypress adapter)
  SPECBANDIT_CYPRESS_BROWSER  Browser name (cypress adapter)
  SPECBANDIT_CYPRESS_TESTING_TYPE  Testing type: e2e or component (cypress adapter)
  SPECBANDIT_PROJECT_ROOT     Project root (jest/cypress adapters)
  SPECBANDIT_BATCH_SIZE       Batch size
  SPECBANDIT_KEY_TTL          Key TTL in seconds (default: 21600)
  SPECBANDIT_KEY_RERUN        Per-runner rerun key
  SPECBANDIT_KEY_RERUN_TTL    Rerun key TTL in seconds (default: 604800)
  SPECBANDIT_RERUN            Safety flag for reruns (1/true/yes)
  SPECBANDIT_VERBOSE          Enable verbose output (1/true/yes)

File input priority for push:
  1. stdin (piped)     echo "test/a.test.ts" | specbandit push --key KEY
  2. --pattern         specbandit push --key KEY --pattern 'test/**/*.test.ts'
  3. direct args       specbandit push --key KEY test/a.test.ts test/b.test.ts

Adapters:
  cli     (default) Spawns a shell command for each batch. Works with any test runner.
  jest    Runs Jest programmatically with haste map reuse. No process startup overhead.
          Requires jest@^29.0.0 installed as a project dependency.
  cypress Runs Cypress programmatically via Module API. Each batch launches a fresh browser.
          Requires cypress@^13.0.0 installed as a project dependency.`)
}

export class CLI {
  static async run(argv: string[]): Promise<number> {
    const args = argv.slice()
    const command = args.shift()

    try {
      switch (command) {
        case 'push':
          return await runPush(args)

        case 'work':
          return await runWork(args)

        case undefined:
        case '-h':
        case '--help':
          printUsage()
          return 0

        case '-v':
        case '--version':
          console.log(`specbandit ${VERSION}`)
          return 0

        default:
          console.error(`Unknown command: ${command}`)
          printUsage()
          return 1
      }
    } catch (e) {
      if (e instanceof SpecbanditError) {
        console.error(`[specbandit] Error: ${e.message}`)
        return 1
      }
      throw e
    }
  }
}
