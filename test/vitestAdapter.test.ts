import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VitestAdapter } from '../src/vitestAdapter.js'
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

describe('VitestAdapter', () => {
  let capture: ReturnType<typeof createOutputCapture>

  beforeEach(() => {
    vi.clearAllMocks()
    capture = createOutputCapture()
  })

  describe('constructor', () => {
    it('uses defaults when no options provided', () => {
      const adapter = new VitestAdapter()
      expect(adapter.projectRoot).toBe(process.cwd())
      expect(adapter.vitestConfig).toBeUndefined()
      expect(adapter.verbose).toBe(false)
    })

    it('accepts custom options', () => {
      const adapter = new VitestAdapter({
        projectRoot: '/my/project',
        vitestConfig: './vitest.config.ts',
        verbose: true,
        output: capture.stream,
      })
      expect(adapter.projectRoot).toBe('/my/project')
      expect(adapter.vitestConfig).toBe('./vitest.config.ts')
      expect(adapter.verbose).toBe(true)
    })
  })

  describe('#setup', () => {
    it('throws when Vitest is not installed', async () => {
      // Use a non-existent project root so vitest/node can't be resolved
      const adapter = new VitestAdapter({
        projectRoot: '/non-existent-path',
        output: capture.stream,
      })

      await expect(adapter.setup()).rejects.toThrow(
        /Failed to initialize Vitest adapter/,
      )
    })
  })

  describe('#runBatch without setup', () => {
    it('throws when adapter is not initialized', async () => {
      const adapter = new VitestAdapter({ output: capture.stream })

      await expect(adapter.runBatch(['test.ts'], 1)).rejects.toThrow(
        /Adapter not initialized/,
      )
    })
  })

  describe('#teardown', () => {
    it('can be called even without setup', async () => {
      const adapter = new VitestAdapter({ output: capture.stream })
      await expect(adapter.teardown()).resolves.toBeUndefined()
    })
  })
})
