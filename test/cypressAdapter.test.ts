import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CypressAdapter } from '../src/cypressAdapter.js'
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

describe('CypressAdapter', () => {
  let capture: ReturnType<typeof createOutputCapture>

  beforeEach(() => {
    vi.clearAllMocks()
    capture = createOutputCapture()
  })

  describe('constructor', () => {
    it('uses defaults when no options provided', () => {
      const adapter = new CypressAdapter()
      expect(adapter.projectRoot).toBe(process.cwd())
      expect(adapter.configFile).toBeUndefined()
      expect(adapter.browser).toBeUndefined()
      expect(adapter.testingType).toBe('e2e')
      expect(adapter.verbose).toBe(false)
    })

    it('accepts custom options', () => {
      const adapter = new CypressAdapter({
        projectRoot: '/my/project',
        configFile: './cypress.config.ts',
        browser: 'chrome',
        testingType: 'component',
        verbose: true,
        output: capture.stream,
      })
      expect(adapter.projectRoot).toBe('/my/project')
      expect(adapter.configFile).toBe('./cypress.config.ts')
      expect(adapter.browser).toBe('chrome')
      expect(adapter.testingType).toBe('component')
      expect(adapter.verbose).toBe(true)
    })
  })

  describe('#setup', () => {
    it('throws when Cypress is not installed', async () => {
      const adapter = new CypressAdapter({ output: capture.stream })

      await expect(adapter.setup()).rejects.toThrow(
        /Failed to initialize Cypress adapter/,
      )
    })
  })

  describe('#runBatch without setup', () => {
    it('throws when adapter is not initialized', async () => {
      const adapter = new CypressAdapter({ output: capture.stream })

      await expect(adapter.runBatch(['test.cy.ts'], 1)).rejects.toThrow(
        /Adapter not initialized/,
      )
    })
  })

  describe('#teardown', () => {
    it('can be called even without setup', async () => {
      const adapter = new CypressAdapter({ output: capture.stream })
      await expect(adapter.teardown()).resolves.toBeUndefined()
    })
  })
})
