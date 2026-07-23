import { CLI } from './cli.js'

// Top-level catch: without it, any error escaping CLI.run rejects the
// top-level await and Node kills the process with a raw stack trace —
// including errors thrown while a finally block runs during shutdown.
try {
  const exitCode = await CLI.run(process.argv.slice(2))
  process.exit(exitCode)
} catch (e) {
  const message = e instanceof Error ? e.message : String(e)
  console.error(`[specbandit] Fatal: ${message}`)
  process.exit(1)
}
