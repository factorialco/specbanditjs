import { CLI } from './cli.js'

const exitCode = await CLI.run(process.argv.slice(2))
process.exit(exitCode)
