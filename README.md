<p align="center">
  <img src="specbanditjs.png" alt="specbandit logo" width="200" />
</p>

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
npm install @factorialco/specbandit
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

Add `--reset` when the producer can run more than once for the same key:

```bash
specbandit push --key pr-123-run-456 --reset --pattern 'test/**/*.test.ts'
```

See [Repeated pushes: `--reset`](#repeated-pushes---reset).

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

By default, a failing batch does **not** stop the worker. It continues stealing remaining work so other runners aren't blocked waiting on files that will never be consumed. To stop the whole run at the first failure, use [`--fail-fast`](#fail-fast---fail-fast).

### CLI reference

```
specbandit push [options] [files...]
  --key KEY              Redis queue key (required)
  --pattern PATTERN      Glob pattern for file discovery
  --redis-url URL        Redis URL (default: redis://localhost:6379)
  --key-ttl SECONDS      TTL for all Redis keys (default: 604800 / 1 week)
  --reset                Empty the key before pushing (see below)

specbandit reset [options]
  --key KEY              Redis queue key (required)
  --redis-url URL        Redis URL (default: redis://localhost:6379)

specbandit work [options]
  --key KEY              Redis queue key (required)
  --command CMD          Command to run with file paths (required, e.g. "npx jest")
  --command-opts OPTS    Extra options forwarded to the command (space-separated)
  --batch-size N         Files per batch (default: 5)
  --redis-url URL        Redis URL (default: redis://localhost:6379)
  --key-rerun KEY        Per-runner rerun key for re-run support (see below)
  --key-ttl SECONDS      TTL for all Redis keys (default: 604800 / 1 week)
  --verbose              Show per-batch file list and full command output
  --json-out PATH        Write merged JSON results to file
  --fail-fast            Stop at the first failed batch and empty the shared queue (see below)
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
| `SPECBANDIT_KEY_RERUN` | Per-runner rerun key | *(none)* |
| `SPECBANDIT_KEY_FAILED` | Redis key for failed test files | *(none)* |
| `SPECBANDIT_KEY_TTL` | Expiry for all Redis keys in seconds | `604800` (1 week) |
| `SPECBANDIT_VERBOSE` | Enable verbose output (1/true/yes) | `false` |
| `SPECBANDIT_FAIL_FAST` | Stop at the first failed batch (1/true/yes) | `false` |
| `SPECBANDIT_JEST_BATCH_TIMEOUT` | Jest adapter idle (no-progress) timeout in seconds; a batch with no Jest output for this long is treated as hung and failed. `0` disables it. | `600` |

CLI flags take precedence over environment variables.

### Node.js API

```typescript
import { Configuration, Publisher, Worker, RedisQueue } from '@factorialco/specbandit'

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

The `--key-rerun` flag gives each matrix runner its own "memory" in Redis. It enables specbandit to **record** which files each runner took, and to run them again on a re-run.

```bash
specbandit work \
  --key "pr-42-run-100" \
  --key-rerun "pr-42-run-100-runner-3" \
            --command "npx jest" \
            --batch-size 10
```

### The published marker prevents silent false passes

Redis deletes a list once its last element is popped, so a **drained** queue and a
queue that was **never published** look identical. To tell them apart, `push` sets a
companion marker key (`<key>:published`) with the same TTL as the queue. The marker
outlives the drained list, so `work` can trust that work really was published.

If the marker expires (TTL) or Redis is flushed between the first run and a re-run,
`work` finds no marker and **fails immediately** instead of running zero tests and
exiting 0. This replaces the old `--rerun` flag -- the protection is now automatic and
needs no per-attempt configuration.

### How it works: the operating modes

`work` reads the published marker plus the state of the shared queue and rerun key, then
follows this truth table:

| Published | Shared queue | Rerun key | Result |
|-----------|--------------|-----------|--------|
| No | any | any | **Crash (exit 1)** -- nothing was published (never pushed, or TTL expired). |
| Yes | empty | empty | **Ok** -- worker arriving late. Queue already drained, nothing to do (exit 0). |
| Yes | populated | empty | **Ok. Classic run** -- steal from the shared queue, recording each batch to the rerun key when `--key-rerun` is set. |
| Yes | any | populated | **Ok. Rerun** -- put the recorded files back on the shared queue (skipping any it already holds), then steal and record like a classic run. |

A populated rerun key means the runner took those files in an earlier attempt. That attempt may have been killed (a job timeout, a cancel) before the shared queue drained, so the files nobody has run are spread over the queue and every runner's rerun key. Putting the rerun files back covers every case:

- **One runner re-run** (a failed shard): it puts its own files back and steals them again, so it runs exactly what it ran before.
- **Several runners re-run, queue half drained**: each puts its files back and they share the queue, so no runner is left with more than its share and every file runs.
- **Queue pushed again** (`push --reset` on a full re-run): the recorded files are already queued, so none are added twice and the stale memory is dropped.

Deleting the rerun key instead would lose the files a killed runner had taken from a queue that was not pushed again: the job would pass with those files never run.

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

## Repeated pushes: `--reset`

The queue key is scoped by CI run, not by CI attempt. It has to be: re-running a single failed runner does not re-run the job that pushed, so that runner must still find the queue and the published marker the first attempt created.

The cost is that the producer is not idempotent. A producer that pushes and then fails, or that is re-run as part of the whole workflow, appends a second copy of the work list to the same key. Every file is then enqueued twice, so the suite runs twice, and any two copies that reach the same worker are loaded twice in one process. For test files that define constants at module scope, the second load is fatal.

`--reset` makes the push idempotent:

```bash
specbandit push --key "pr-42-run-100" --reset --pattern 'test/**/*.test.ts'
```

The queue and its `<key>:published` marker are deleted, then the work list is pushed, so the key holds exactly one copy however many times the producer runs. The leftover count is logged, and a non-zero one tells you an earlier attempt pushed a list nobody consumed:

```
[specbandit] Reset key 'pr-42-run-100': discarded 4213 queued files from a previous push.
```

There is also a standalone command, for callers that clean up separately from the push:

```bash
specbandit reset --key "pr-42-run-100"
```

Both leave the per-runner rerun keys and the failed keys alone, so a single-runner re-run can still run its own files again. A runner with data in its rerun key puts those files back on the queue, skipping the ones the new push already holds (the **rerun** row in the table above).

A reset with nothing to reset is not an error. Neither command clears the key when there is nothing to push in its place: dropping the marker on its own would make every worker on that key crash as "never published".

## Fail-fast: `--fail-fast`

Use `--fail-fast` when a single failure makes the rest of the run useless, and you want CI to report it as soon as possible.

```bash
specbandit work --key pr-123-run-456 --command "npx jest" --fail-fast
```

When a batch fails, the worker:

1. Records the batch in the summary and in the `--report` file, as usual.
2. Deletes the shared queue list (`DEL <key>`), so no worker can steal the pending files.
3. Stops and exits 1.

The `<key>:published` marker stays. A worker that checks the queue after the prune sees "published but drained" and exits 0, instead of crashing with "never published". A worker that has a batch in flight finishes that batch, then finds the queue empty and stops. Specbandit does not interrupt a batch in flight.

Specbandit sees results per batch, so the worker stops after the failing batch, not after the failing test. To also stop inside a batch, forward the option of your test runner, for example `-- --bail` for Jest.

`--fail-fast` cannot be used with `--key-failed`. The failed key feeds a later retry pass, and fail-fast stops before most files run, so that list would be incomplete. Specbandit rejects the combination at startup and exits 1. An empty `--key-failed ""` counts as not set.

## How it works

- **Push** uses `RPUSH` to append all file paths to a Redis list in a single command, then sets `EXPIRE` on the key (default: 1 week). It also sets a `<key>:published` marker with the same TTL so workers can tell a drained queue from one that was never published.
- **Steal** uses `LPOP key count` (Redis 6.2+), which atomically pops up to N elements.
- **Record** (when `--key-rerun` is set): the steal and the `RPUSH` to the per-runner rerun key run in one Lua script, so no file is ever out of both keys, even if the runner is killed between the two. Once the queue is exhausted, the runner also runs any file its rerun key holds that it has not run: a steal whose reply was lost to a command timeout, then retried, recorded files the runner never received.
- **Rerun** (when `--key-rerun` has data): one Lua script appends the rerun files the shared queue does not already hold to it and deletes the rerun key. The runner then steals and records as in a classic run.
- **Reset** (`push --reset` or `specbandit reset`) removes the queue and its `<key>:published` marker in a single `DEL`, so a producer that runs twice cannot enqueue the work list twice. Rerun and failed keys are untouched.
- **Run** spawns the configured command via `child_process.spawnSync()` with file paths as arguments. No shell expansion overhead.
- **Fail-fast** (`--fail-fast`): after the first failed batch, the shared queue list is removed with `DEL` (the `<key>:published` marker stays), and the worker stops.
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
