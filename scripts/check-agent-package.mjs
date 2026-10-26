#!/usr/bin/env node
/** Exercise the shipped adapter outside this checkout, with production dependencies only. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run this check with npm run test:agent:package.')
const temporaryRoot = fs.realpathSync.native(os.tmpdir())
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'everyagent-package-'))
const consumer = path.join(directory, 'consumer')
fs.mkdirSync(consumer)
const env = { ...process.env }
delete env.DSH_OPS_WORKER_BIN

function run(args, cwd) {
  const result = spawnSync(process.execPath, args, {
    cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}

try {
  const [packed] = JSON.parse(run([npmCli, 'pack', '--ignore-scripts', '--json',
    '--pack-destination', directory], root))
  assert.equal(path.basename(packed.filename), packed.filename)
  run([npmCli, 'install', '--prefix', consumer, path.join(directory, packed.filename),
    '--ignore-scripts', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'], consumer)
  assert.equal(fs.existsSync(path.join(consumer, 'node_modules', '@deepseek-ai')), false,
    'the production consumer must not install DSH packages')
  fs.writeFileSync(path.join(consumer, 'sample.txt'), 'standalone\n')
  run(['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { createAgentOps } from 'dsh-ops/agent'
    import { createMcpServer } from 'dsh-ops/agent/mcp'
    import { publicToolName } from 'dsh-ops/policy'
    const ops = createAgentOps({ workspace: process.cwd() })
    try {
      assert.equal(ops.tools.length, 9)
      const result = await ops.execute(publicToolName('read_files'), { files: [{ path: 'sample.txt' }] })
      assert.equal(result.status, 'completed')
      assert.equal(result.items[0].items[0].text, 'standalone')
    } finally { await ops.close() }
    const mcp = createMcpServer({ workspace: process.cwd() })
    assert.equal(mcp.ops.tools.length, 9)
    await mcp.ops.close()
    await mcp.server.close()
  `], consumer)
  const help = run([path.join(consumer, 'node_modules', 'dsh-ops', 'bin', 'everyagent-ops.mjs'),
    '--help'], consumer)
  assert.match(help, /standalone MCP file tools/)
  console.log('agent-package: packed JS API, MCP entry and CLI passed without DSH or devDependencies')
} finally {
  const relative = path.relative(temporaryRoot, directory)
  assert.ok(relative.startsWith('everyagent-package-') && !relative.includes(path.sep))
  fs.rmSync(directory, { recursive: true, force: true })
}
