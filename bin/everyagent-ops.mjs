#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { serveStdio } from '../lib/agent/mcp.js'

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      workspace: { type: 'string' },
      mode: { type: 'string', default: 'read-only' },
      worker: { type: 'string' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(`everyagent-ops - standalone MCP file tools

Usage:
  everyagent-ops --workspace <absolute-directory> [--mode read-only|workspace-write] [--worker <absolute-executable>]

The workspace must exist. Reads and writes stay inside it. Default: read-only.
stdin/stdout carry MCP; diagnostics use stderr. No DSH installation is required.
Build from source with npm run build and npm run build:ptc.
This is a trusted local file service, not an OS sandbox or arbitrary shell runner.`)
  } else {
    if (positionals.length) throw new Error('Unexpected positional arguments.')
    if (!values.workspace) throw new Error('--workspace is required; use --help.')
    await serveStdio({ workspace: values.workspace, mode: values.mode, binaryPath: values.worker })
  }
} catch (error) {
  console.error(`everyagent-ops: ${error.message}`)
  process.exitCode = 1
}
