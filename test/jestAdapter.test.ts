import { describe, it, expect, vi, beforeEach } from 'vitest'
import { JestAdapter } from '../src/jestAdapter.js'
import { Writable } from 'node:stream'

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

describe('JestAdapter', () => {
  let capture: ReturnType<typeof createOutputCapture>

  beforeEach(() => {
    vi.clearAllMocks()
    capture = createOutputCapture()
  })

  describe('constructor', () => {
    it('uses defaults when no options provided', () => {
      const adapter = new JestAdapter()
      expect(adapter.projectRoot).toBe(process.cwd())
      expect(adapter.jestConfig).toBeUndefined()
      expect(adapter.jestOpts).toEqual([])
      expect(adapter.verbose).toBe(false)
    })

    it('accepts custom options', () => {
      const adapter = new JestAdapter({
        projectRoot: '/my/project',
        jestConfig: './jest.config.ts',
        jestOpts: ['--silent', '--coverage'],
        verbose: true,
        output: capture.stream,
      })
      expect(adapter.projectRoot).toBe('/my/project')
      expect(adapter.jestConfig).toBe('./jest.config.ts')
      expect(adapter.jestOpts).toEqual(['--silent', '--coverage'])
      expect(adapter.verbose).toBe(true)
    })
  })

  describe('#setup', () => {
    it('throws when Jest is not installed', async () => {
      const adapter = new JestAdapter({ output: capture.stream })

      await expect(adapter.setup()).rejects.toThrow(
        /Failed to initialize Jest adapter/,
      )
    })
  })

  describe('#runBatch without setup', () => {
    it('throws when adapter is not initialized', async () => {
      const adapter = new JestAdapter({ output: capture.stream })

      await expect(adapter.runBatch(['test.ts'], 1)).rejects.toThrow(
        /Adapter not initialized/,
      )
    })
  })

  describe('#teardown', () => {
    it('can be called even without setup', async () => {
      const adapter = new JestAdapter({ output: capture.stream })
      await expect(adapter.teardown()).resolves.toBeUndefined()
    })

    it('does not touch process.exit', async () => {
      const adapter = new JestAdapter({ output: capture.stream })
      const originalExit = process.exit
      await adapter.teardown()
      // process.exit should be untouched — teardown no longer manages it
      expect(process.exit).toBe(originalExit)
    })
  })
})
