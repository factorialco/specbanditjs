import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Worker } from '../src/worker.js'
import { RedisQueue } from '../src/redisQueue.js'
import { Writable } from 'node:stream'
import * as childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }),
}))

function createOutputCapture(): { stream: Writable; getOutput: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  })
  return { stream, getOutput: () => chunks.join('') }
}

function createMockQueue() {
  return {
    push: vi.fn().mockResolvedValue(0),
    steal: vi.fn().mockResolvedValue([]),
    length: vi.fn().mockResolvedValue(0),
    readAll: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    redis: {} as any,
  } as unknown as RedisQueue
}

describe('Worker', () => {
  let queue: ReturnType<typeof createMockQueue> & {
    push: ReturnType<typeof vi.fn>
    steal: ReturnType<typeof vi.fn>
    readAll: ReturnType<typeof vi.fn>
  }
  let capture: ReturnType<typeof createOutputCapture>
  const key = 'pr-123-run-456'
  const command = 'node'

  beforeEach(() => {
    vi.clearAllMocks()
    queue = createMockQueue() as any
    capture = createOutputCapture()
  })

  describe('#run', () => {
    describe('steal mode (no key_rerun)', () => {
      function makeWorker(opts: Partial<ConstructorParameters<typeof Worker>[0]> = {}) {
        return new Worker({
          key,
          command,
          batchSize: 2,
          commandOpts: [],
          keyRerun: null,
          queue: queue as unknown as RedisQueue,
          output: capture.stream,
          ...opts,
        })
      }

      it('returns 0 when queue is empty from the start', async () => {
        queue.steal.mockResolvedValue([])

        const exitCode = await makeWorker().run()

        expect(exitCode).toBe(0)
        expect(capture.getOutput()).toContain('Nothing to do')
      })

      it('steals and runs batches until queue is exhausted', async () => {
        queue.steal
          .mockResolvedValueOnce(['test/a.test.ts', 'test/b.test.ts'])
          .mockResolvedValueOnce(['test/c.test.ts'])
          .mockResolvedValueOnce([])

        const exitCode = await makeWorker().run()

        expect(exitCode).toBe(0)
        expect(childProcess.spawnSync).toHaveBeenCalledTimes(2)
        expect(capture.getOutput()).toContain('Batch #1: running 2 files')
        expect(capture.getOutput()).toContain('Batch #2: running 1 files')
        expect(capture.getOutput()).toContain('All passed')
      })

      it('returns 1 if any batch fails', async () => {
        queue.steal
          .mockResolvedValueOnce(['test/a.test.ts', 'test/b.test.ts'])
          .mockResolvedValueOnce(['test/c.test.ts'])
          .mockResolvedValueOnce([])

        vi.mocked(childProcess.spawnSync)
          .mockReturnValueOnce({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') } as any)
          .mockReturnValueOnce({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('') } as any)

        const exitCode = await makeWorker().run()

        expect(exitCode).toBe(1)
        expect(capture.getOutput()).toContain('Batch #1 passed')
        expect(capture.getOutput()).toContain('Batch #2 FAILED')
        expect(capture.getOutput()).toContain('SOME FAILED')
      })

      it('continues stealing after a batch failure', async () => {
        queue.steal
          .mockResolvedValueOnce(['test/a.test.ts'])
          .mockResolvedValueOnce(['test/b.test.ts'])
          .mockResolvedValueOnce([])

        vi.mocked(childProcess.spawnSync)
          .mockReturnValueOnce({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('') } as any)
          .mockReturnValueOnce({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') } as any)

        const exitCode = await makeWorker().run()

        expect(exitCode).toBe(1)
        expect(childProcess.spawnSync).toHaveBeenCalledTimes(2)
      })

      it('passes command and commandOpts along with files to spawnSync', async () => {
        queue.steal
          .mockResolvedValueOnce(['test/a.test.ts'])
          .mockResolvedValueOnce([])

        const worker = makeWorker({ command: 'npx jest', commandOpts: ['--coverage'] })
        await worker.run()

        expect(childProcess.spawnSync).toHaveBeenCalledWith(
          'npx',
          ['jest', '--coverage', 'test/a.test.ts'],
          expect.objectContaining({ shell: false })
        )
      })

      it('does not push to any rerun key', async () => {
        queue.steal
          .mockResolvedValueOnce(['test/a.test.ts'])
          .mockResolvedValueOnce([])

        await makeWorker().run()

        expect(queue.push).not.toHaveBeenCalled()
      })
    })

    describe('record mode (key_rerun set, rerun key empty)', () => {
      const keyRerun = 'pr-123-run-456-runner-3'

      function makeWorker() {
        return new Worker({
          key,
          command,
          batchSize: 2,
          commandOpts: [],
          keyRerun,
          keyRerunTtl: 604_800,
          queue: queue as unknown as RedisQueue,
          output: capture.stream,
        })
      }

      beforeEach(() => {
        queue.readAll.mockResolvedValue([])
      })

      it('steals from the main key and records batches to the rerun key', async () => {
        queue.steal
          .mockResolvedValueOnce(['test/a.test.ts', 'test/b.test.ts'])
          .mockResolvedValueOnce(['test/c.test.ts'])
          .mockResolvedValueOnce([])

        const exitCode = await makeWorker().run()

        expect(exitCode).toBe(0)
        expect(capture.getOutput()).toContain('Record mode')
        expect(capture.getOutput()).toContain('Recording stolen files to rerun key')

        // Check both batches were recorded
        expect(queue.push).toHaveBeenCalledWith(
          keyRerun,
          ['test/a.test.ts', 'test/b.test.ts'],
          604_800
        )
        expect(queue.push).toHaveBeenCalledWith(
          keyRerun,
          ['test/c.test.ts'],
          604_800
        )
      })

      it('returns 1 if any batch fails but still records all batches', async () => {
        queue.steal
          .mockResolvedValueOnce(['test/a.test.ts'])
          .mockResolvedValueOnce([])

        vi.mocked(childProcess.spawnSync)
          .mockReturnValueOnce({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('') } as any)

        const exitCode = await makeWorker().run()

        expect(exitCode).toBe(1)
        expect(queue.push).toHaveBeenCalledWith(
          keyRerun,
          ['test/a.test.ts'],
          604_800
        )
        expect(capture.getOutput()).toContain('SOME FAILED')
      })
    })

    describe('replay mode (key_rerun set, rerun key has data)', () => {
      const keyRerun = 'pr-123-run-456-runner-3'
      const recordedFiles = ['test/x.test.ts', 'test/y.test.ts', 'test/z.test.ts']

      function makeWorker() {
        return new Worker({
          key,
          command,
          batchSize: 2,
          commandOpts: [],
          keyRerun,
          keyRerunTtl: 604_800,
          queue: queue as unknown as RedisQueue,
          output: capture.stream,
        })
      }

      beforeEach(() => {
        queue.readAll.mockResolvedValue(recordedFiles)
      })

      it('runs files from the rerun key in batches', async () => {
        const exitCode = await makeWorker().run()

        expect(exitCode).toBe(0)
        // 3 files with batch_size 2 = 2 batches
        expect(childProcess.spawnSync).toHaveBeenCalledTimes(2)
        expect(capture.getOutput()).toContain('Replay mode: found 3 files')
        expect(capture.getOutput()).toContain('Batch #1: running 2 files')
        expect(capture.getOutput()).toContain('Batch #2: running 1 files')
        expect(capture.getOutput()).toContain('Replay finished')
      })

      it('never touches the shared queue', async () => {
        await makeWorker().run()

        expect(queue.steal).not.toHaveBeenCalled()
        expect(queue.push).not.toHaveBeenCalled()
      })

      it('returns 1 if any replay batch fails', async () => {
        vi.mocked(childProcess.spawnSync)
          .mockReturnValueOnce({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') } as any)
          .mockReturnValueOnce({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('') } as any)

        const exitCode = await makeWorker().run()

        expect(exitCode).toBe(1)
        expect(capture.getOutput()).toContain('SOME FAILED')
      })
    })

    describe('verbose mode', () => {
      it('shows file list per batch when verbose', async () => {
        queue.steal
          .mockResolvedValueOnce(['test/a.test.ts'])
          .mockResolvedValueOnce([])

        const worker = new Worker({
          key,
          command,
          batchSize: 2,
          keyRerun: null,
          verbose: true,
          queue: queue as unknown as RedisQueue,
          output: capture.stream,
        })

        await worker.run()
        expect(capture.getOutput()).toContain('  test/a.test.ts')
      })

      it('hides file list per batch when quiet', async () => {
        queue.steal
          .mockResolvedValueOnce(['test/a.test.ts'])
          .mockResolvedValueOnce([])

        const worker = new Worker({
          key,
          command,
          batchSize: 2,
          keyRerun: null,
          verbose: false,
          queue: queue as unknown as RedisQueue,
          output: capture.stream,
        })

        await worker.run()
        expect(capture.getOutput()).toContain('Batch #1: running 1 files')
        expect(capture.getOutput()).not.toContain('  test/a.test.ts')
      })
    })

    describe('summary and reporting', () => {
      it('prints summary with batch count and timing stats', async () => {
        queue.steal
          .mockResolvedValueOnce(['test/a.test.ts'])
          .mockResolvedValueOnce(['test/b.test.ts'])
          .mockResolvedValueOnce([])

        const worker = new Worker({
          key,
          command,
          batchSize: 2,
          keyRerun: null,
          queue: queue as unknown as RedisQueue,
          output: capture.stream,
        })

        await worker.run()

        const output = capture.getOutput()
        expect(output).toContain('[specbandit] Summary')
        expect(output).toContain('Batches:        2')
        expect(output).toContain('Files:          2')
        expect(output).toContain('Failed batches: 0')
        expect(output).toContain('Batch timing: min')
      })

      it('prints failed batches in the summary', async () => {
        queue.steal
          .mockResolvedValueOnce(['test/a.test.ts'])
          .mockResolvedValueOnce([])

        vi.mocked(childProcess.spawnSync)
          .mockReturnValueOnce({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('') } as any)

        const worker = new Worker({
          key,
          command,
          batchSize: 2,
          keyRerun: null,
          queue: queue as unknown as RedisQueue,
          output: capture.stream,
        })

        await worker.run()

        const output = capture.getOutput()
        expect(output).toContain('Failed batches (1)')
        expect(output).toContain('Batch #1 (exit code 1)')
      })

      describe('JSON output', () => {
        let tmpDir: string

        beforeEach(() => {
          tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specbandit-test-'))
        })

        afterEach(() => {
          fs.rmSync(tmpDir, { recursive: true, force: true })
        })

        it('writes JSON results to --json-out file', async () => {
          const jsonOutPath = path.join(tmpDir, 'results.json')
          queue.steal
            .mockResolvedValueOnce(['test/a.test.ts'])
            .mockResolvedValueOnce(['test/b.test.ts'])
            .mockResolvedValueOnce([])

          vi.mocked(childProcess.spawnSync)
            .mockReturnValueOnce({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') } as any)
            .mockReturnValueOnce({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('') } as any)

          const worker = new Worker({
            key,
            command,
            batchSize: 2,
            keyRerun: null,
            queue: queue as unknown as RedisQueue,
            output: capture.stream,
            jsonOut: jsonOutPath,
          })

          await worker.run()

          expect(fs.existsSync(jsonOutPath)).toBe(true)
          const data = JSON.parse(fs.readFileSync(jsonOutPath, 'utf8'))
          expect(data.summary.total_files).toBe(2)
          expect(data.summary.total_batches).toBe(2)
          expect(data.summary.failed_batches).toBe(1)
          expect(data.summary.passed).toBe(false)
          expect(data.batch_timings.count).toBe(2)
          expect(data.batches).toHaveLength(2)
        })

        it('does not write JSON when --json-out is not set', async () => {
          const jsonOutPath = path.join(tmpDir, 'results.json')
          queue.steal
            .mockResolvedValueOnce(['test/a.test.ts'])
            .mockResolvedValueOnce([])

          const worker = new Worker({
            key,
            command,
            batchSize: 2,
            keyRerun: null,
            queue: queue as unknown as RedisQueue,
            output: capture.stream,
          })

          await worker.run()

          expect(fs.existsSync(jsonOutPath)).toBe(false)
        })
      })

      describe('GitHub step summary', () => {
        let tmpDir: string
        let stepSummaryPath: string
        let originalEnv: string | undefined

        beforeEach(() => {
          tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specbandit-test-'))
          stepSummaryPath = path.join(tmpDir, 'step_summary.md')
          originalEnv = process.env.GITHUB_STEP_SUMMARY
          process.env.GITHUB_STEP_SUMMARY = stepSummaryPath
        })

        afterEach(() => {
          if (originalEnv !== undefined) {
            process.env.GITHUB_STEP_SUMMARY = originalEnv
          } else {
            delete process.env.GITHUB_STEP_SUMMARY
          }
          fs.rmSync(tmpDir, { recursive: true, force: true })
        })

        it('writes markdown summary to GITHUB_STEP_SUMMARY', async () => {
          queue.steal
            .mockResolvedValueOnce(['test/a.test.ts'])
            .mockResolvedValueOnce([])

          const worker = new Worker({
            key,
            command,
            batchSize: 2,
            keyRerun: null,
            queue: queue as unknown as RedisQueue,
            output: capture.stream,
          })

          await worker.run()

          expect(fs.existsSync(stepSummaryPath)).toBe(true)
          const md = fs.readFileSync(stepSummaryPath, 'utf8')
          expect(md).toContain('Specbandit Results')
          expect(md).toContain('Batches')
          expect(md).toContain('Files')
          expect(md).toContain('Batch time (min)')
          expect(md).toContain('Batch time (avg)')
          expect(md).toContain('Batch time (max)')
        })

        it('includes failed batches in the step summary', async () => {
          queue.steal
            .mockResolvedValueOnce(['test/a.test.ts'])
            .mockResolvedValueOnce([])

          vi.mocked(childProcess.spawnSync)
            .mockReturnValueOnce({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('') } as any)

          const worker = new Worker({
            key,
            command,
            batchSize: 2,
            keyRerun: null,
            queue: queue as unknown as RedisQueue,
            output: capture.stream,
          })

          await worker.run()

          const md = fs.readFileSync(stepSummaryPath, 'utf8')
          expect(md).toContain('1 failed batches')
          expect(md).toContain('test/a.test.ts')
        })

        it('does not write when GITHUB_STEP_SUMMARY is not set', async () => {
          delete process.env.GITHUB_STEP_SUMMARY

          queue.steal
            .mockResolvedValueOnce(['test/a.test.ts'])
            .mockResolvedValueOnce([])

          const worker = new Worker({
            key,
            command,
            batchSize: 2,
            keyRerun: null,
            queue: queue as unknown as RedisQueue,
            output: capture.stream,
          })

          await worker.run()

          expect(fs.existsSync(stepSummaryPath)).toBe(false)
        })
      })
    })
  })
})
