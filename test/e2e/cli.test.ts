import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { VERSION } from '../../src/configuration.js'

// CLI-level tests that exercise the built binary (dist/bin.js).
// These test CLI argument parsing (help, version, unknown command).
//
// Full push+work multi-worker E2E scenarios are tested in CI
// via .github/workflows/ci.yml (matching the Ruby specbandit CI).

const binPath = join(import.meta.dirname, '..', '..', 'dist', 'bin.js')

function runCLI(...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [binPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 10_000,
  })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

const binExists = existsSync(binPath)
const describeFn = binExists ? describe : describe.skip

describeFn('CLI', () => {
  beforeAll(() => {
    if (!binExists) {
      console.warn(`dist/bin.js not found at ${binPath}. Run "npm run build" first.`)
    }
  })

  it('--help returns usage information', () => {
    const result = runCLI('--help')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Usage:')
    expect(result.stdout).toContain('specbandit push')
    expect(result.stdout).toContain('specbandit work')
  })

  it('--version returns the version', () => {
    const result = runCLI('--version')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`specbandit ${VERSION}`)
  })

  it('unknown command returns error', () => {
    const result = runCLI('unknown')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Unknown command: unknown')
  })

  it('push --help returns push usage', () => {
    const result = runCLI('push', '--help')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--key KEY')
    expect(result.stdout).toContain('--pattern PATTERN')
  })

  it('work --help returns work usage', () => {
    const result = runCLI('work', '--help')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--key KEY')
    expect(result.stdout).toContain('--command CMD')
    expect(result.stdout).toContain('--batch-size N')
  })
})
