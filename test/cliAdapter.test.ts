import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CliAdapter } from '../src/cliAdapter.js'
import * as childProcess from 'node:child_process'
import { Writable } from 'node:stream'

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

describe('CliAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('#setup and #teardown', () => {
    it('setup is a no-op', async () => {
      const adapter = new CliAdapter({ command: 'node' })
      await expect(adapter.setup()).resolves.toBeUndefined()
    })

    it('teardown is a no-op', async () => {
      const adapter = new CliAdapter({ command: 'node' })
      await expect(adapter.teardown()).resolves.toBeUndefined()
    })
  })

  describe('#runBatch', () => {
    it('spawns the command with file paths appended', async () => {
      const adapter = new CliAdapter({ command: 'npx jest' })
      await adapter.setup()

      const result = await adapter.runBatch(['test/a.test.ts', 'test/b.test.ts'], 1)

      expect(childProcess.spawnSync).toHaveBeenCalledWith(
        'npx',
        ['jest', 'test/a.test.ts', 'test/b.test.ts'],
        expect.objectContaining({ shell: false }),
      )
      expect(result.exitCode).toBe(0)
      expect(result.batchNum).toBe(1)
      expect(result.files).toEqual(['test/a.test.ts', 'test/b.test.ts'])
      expect(result.duration).toBeGreaterThanOrEqual(0)
    })

    it('includes commandOpts between command args and file paths', async () => {
      const adapter = new CliAdapter({
        command: 'npx jest',
        commandOpts: ['--coverage', '--silent'],
      })
      await adapter.setup()

      await adapter.runBatch(['test/a.test.ts'], 1)

      expect(childProcess.spawnSync).toHaveBeenCalledWith(
        'npx',
        ['jest', '--coverage', '--silent', 'test/a.test.ts'],
        expect.objectContaining({ shell: false }),
      )
    })

    it('returns exit code from the spawned process', async () => {
      vi.mocked(childProcess.spawnSync).mockReturnValueOnce({
        status: 42,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as any)

      const adapter = new CliAdapter({ command: 'node' })
      const result = await adapter.runBatch(['test.ts'], 1)

      expect(result.exitCode).toBe(42)
    })

    it('defaults to exit code 1 when status is null', async () => {
      vi.mocked(childProcess.spawnSync).mockReturnValueOnce({
        status: null,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as any)

      const adapter = new CliAdapter({ command: 'node' })
      const result = await adapter.runBatch(['test.ts'], 1)

      expect(result.exitCode).toBe(1)
    })

    it('prints stderr on failure when not verbose', async () => {
      vi.mocked(childProcess.spawnSync).mockReturnValueOnce({
        status: 1,
        stdout: Buffer.from(''),
        stderr: Buffer.from('Some error occurred'),
      } as any)

      const capture = createOutputCapture()
      const adapter = new CliAdapter({
        command: 'node',
        verbose: false,
        output: capture.stream,
      })
      await adapter.runBatch(['test.ts'], 1)

      expect(capture.getOutput()).toContain('Some error occurred')
    })

    it('uses inherit stdio when verbose', async () => {
      const adapter = new CliAdapter({ command: 'node', verbose: true })
      await adapter.runBatch(['test.ts'], 1)

      expect(childProcess.spawnSync).toHaveBeenCalledWith(
        'node',
        ['test.ts'],
        expect.objectContaining({ stdio: 'inherit' }),
      )
    })

    it('uses pipe stdio when not verbose', async () => {
      const adapter = new CliAdapter({ command: 'node', verbose: false })
      await adapter.runBatch(['test.ts'], 1)

      expect(childProcess.spawnSync).toHaveBeenCalledWith(
        'node',
        ['test.ts'],
        expect.objectContaining({ stdio: 'pipe' }),
      )
    })
  })
})
