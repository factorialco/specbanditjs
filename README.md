![specbandit logo](specbanditjs.png)

# specbandit

Distributed test runner using Redis as a work queue. One process pushes test file paths to a Redis list; multiple CI runners atomically steal batches and execute them via a configurable command.

```
CI Job 1 (push):    RPUSH key f1 f2 f3 ... fN  -->  [Redis List]
CI Job 2 (worker):  LPOP key 5  <--  [Redis List]  -->  npx jest
CI Job 3 (worker):  LPOP key 5  <--  [Redis List]  -->  npx jest
CI Job N (worker):  LPOP key 5  <--  [Redis List]  -->  npx jest
```

`LPOP` with a count argument (Redis 6.2+) is atomic -- multiple workers calling it concurrently will never receive the same file.

This is a TypeScript port of [specbandit](https://github.com/factorialco/specbandit) (Ruby/RSpec). Instead of running RSpec in-process, the worker spawns any command you provide (jest, vitest, node, etc.) with the stolen file paths as arguments.

## Installation

```bash
npm install specbandit
```

Or run directly:

```bash
npx specbandit --help
```

**Requirements**: Node.js >= 18, Redis >= 6.2

## Usage

### 1. Push test files to Redis

A single CI job enqueues all test file paths before workers start.

```bash
# Via glob pattern
specbandit push --key pr-123-run-456 --pattern 'test/**/*.test.ts'

# Via stdin pipe (for large file lists or custom filtering)
find test -name '*.test.ts' | specbandit push --key pr-123-run-456

# Via direct arguments (for small lists)
specbandit push --key pr-123-run-456 test/models/user.test.ts test/models/order.test.ts
```

File input priority: **stdin > --pattern > direct args**.

### 2. Steal and run from multiple workers

Each CI runner steals batches and runs them. Start as many runners as you want -- they'll divide the work automatically.

```bash
specbandit work --key pr-123-run-456 --command "npx jest" --batch-size 10
```

Each worker loops:

1. `LPOP` N file paths from Redis (atomic)
2. Spawn the command with the file paths as arguments
3. Repeat until the queue is empty
4. Exit 0 if all batches passed, 1 if any failed

A failing batch does **not** stop the worker. It continues stealing remaining work so other runners aren't blocked waiting on files that will never be consumed.

### CLI reference

```
specbandit push [options] [files...]
  --key KEY              Redis queue key (required)
  --pattern PATTERN      Glob pattern for file discovery
  --redis-url URL        Redis URL (default: redis://localhost:6379)
  --key-ttl SECONDS      TTL for the Redis key (default: 21600 / 6 hours)

specbandit work [options]
  --key KEY              Redis queue key (required)
  --command CMD          Command to run with file paths (required, e.g. "npx jest")
  --command-opts OPTS    Extra options forwarded to the command (space-separated)
  --batch-size N         Files per batch (default: 5)
  --redis-url URL        Redis URL (default: redis://localhost:6379)
  --key-rerun KEY        Per-runner rerun key for re-run support (see below)
  --key-rerun-ttl SECS   TTL for rerun key (default: 604800 / 1 week)
  --verbose              Show per-batch file list and full command output
  --json-out PATH        Write merged JSON results to file
```

### Environment variables

All CLI options can be set via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `SPECBANDIT_KEY` | Redis queue key | *(required)* |
| `SPECBANDIT_REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `SPECBANDIT_COMMAND` | Command to run | *(required for work)* |
| `SPECBANDIT_COMMAND_OPTS` | Space-separated command options | *(none)* |
| `SPECBANDIT_BATCH_SIZE` | Files per steal | `5` |
| `SPECBANDIT_KEY_TTL` | Key expiry in seconds | `21600` (6 hours) |
| `SPECBANDIT_KEY_RERUN` | Per-runner rerun key | *(none)* |
| `SPECBANDIT_KEY_RERUN_TTL` | Rerun key expiry in seconds | `604800` (1 week) |
| `SPECBANDIT_VERBOSE` | Enable verbose output (1/true/yes) | `false` |

CLI flags take precedence over environment variables.

### Node.js API

```typescript
import { Configuration, Publisher, Worker, RedisQueue } from 'specbandit'

// Push
const queue = new RedisQueue('redis://my-redis:6379')
const publisher = new Publisher({
  key: 'pr-123-run-456',
  keyTtl: 7200,
  queue,
})
await publisher.publish({ pattern: 'test/**/*.test.ts' })

// Work
const worker = new Worker({
  key: 'pr-123-run-456',
  command: 'npx jest',
  commandOpts: ['--coverage'],
  batchSize: 10,
  queue,
})
const exitCode = await worker.run()

await queue.close()
process.exit(exitCode)
```

## Example: GitHub Actions (basic)

```yaml
jobs:
  push-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: |
          npx specbandit push \
            --key "pr-${{ github.event.number }}-${{ github.run_id }}" \
            --redis-url "${{ secrets.REDIS_URL }}" \
            --pattern 'test/**/*.test.ts'
  run-tests:
    runs-on: ubuntu-latest
    needs: push-tests
    strategy:
      matrix:
        runner: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: |
          npx specbandit work \
            --key "pr-${{ github.event.number }}-${{ github.run_id }}" \
            --redis-url "${{ secrets.REDIS_URL }}" \
            --command "npx jest" \
            --batch-size 10
```

## Re-running failed CI jobs

### The problem

When you use specbandit to distribute tests across multiple CI runners (e.g. a GitHub Actions matrix with 4 runners), each runner **steals** a random subset of test files from the shared Redis queue. The distribution is non-deterministic.

This creates a problem with CI re-runs:

1. **First run**: Runner #3 steals and executes files X, Y, Z. File Y fails. The shared queue is now empty.
2. **Re-run of runner #3**: GitHub Actions re-runs only the failed runner. It starts `specbandit work` again with the same `--key`, but the queue is already empty. Runner #3 sees nothing to do and **exits 0 -- the failing test silently passes**.

### The solution: `--key-rerun`

The `--key-rerun` flag gives each matrix runner its own "memory" in Redis. It enables specbandit to **record** which files each runner executed, and **replay** exactly those files on a re-run.

```bash
specbandit work \
  --key "pr-42-run-100" \
  --key-rerun "pr-42-run-100-runner-3" \
  --command "npx jest" \
  --batch-size 10
```

### How it works: three operating modes

| `--key-rerun` provided? | Rerun key in Redis | Mode | Behavior |
|--------------------------|-------------------|------|----------|
| No | -- | **Steal** | Original behavior. Steal from shared queue, run, done. |
| Yes | Empty | **Record** | Steal from shared queue + record each batch to the rerun key. |
| Yes | Has data | **Replay** | Ignore shared queue entirely. Re-run exactly the recorded files. |

### Complete GitHub Actions example with re-run support

```yaml
jobs:
  push-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: |
          npx specbandit push \
            --key "pr-${{ github.event.number }}-${{ github.run_id }}" \
            --redis-url "${{ secrets.REDIS_URL }}" \
            --pattern 'test/**/*.test.ts'
  run-tests:
    runs-on: ubuntu-latest
    needs: push-tests
    strategy:
      matrix:
        runner: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: |
          npx specbandit work \
            --key "pr-${{ github.event.number }}-${{ github.run_id }}" \
            --key-rerun "pr-${{ github.event.number }}-${{ github.run_id }}-runner-${{ matrix.runner }}" \
            --redis-url "${{ secrets.REDIS_URL }}" \
            --command "npx jest" \
            --batch-size 10
```

## How it works

- **Push** uses `RPUSH` to append all file paths to a Redis list in a single command, then sets `EXPIRE` on the key (default: 6 hours).
- **Steal** uses `LPOP key count` (Redis 6.2+), which atomically pops up to N elements. No Lua scripts, no locks, no race conditions.
- **Record** (when `--key-rerun` is set): after each steal, the batch is also `RPUSH`ed to the per-runner rerun key with its own TTL (default: 1 week).
- **Replay** (when `--key-rerun` has data): reads all files from the rerun key via `LRANGE` (non-destructive), splits into batches, and runs them locally.
- **Run** spawns the configured command via `child_process.spawnSync()` with file paths as arguments. No shell expansion overhead.
- **Exit code** is 0 if every batch passed (or the queue was already empty), 1 if any batch had failures.

## Development

```bash
npm install
npm test              # unit tests (no Redis needed)
npm run build         # compile TypeScript
npm run typecheck     # type-check without emitting
```

## License

MIT
