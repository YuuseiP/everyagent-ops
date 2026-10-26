import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createAgentOps, isToolError } from '../lib/agent/index.js'
import { FILE_CAPABILITIES } from '../lib/capabilities/registry.js'
import { publicToolName } from '../lib/policy.js'
import { assert, test, report, withTempDir, PACKAGE_ROOT } from './lib/harness.mjs'
import { requireWorker } from './lib/boundary.mjs'

requireWorker('agent')
const name = publicToolName
const cli = path.join(PACKAGE_ROOT, 'bin/everyagent-ops.mjs')
const call = (ops, tool, args, signal) => ops.execute(name(tool), args, signal)
const completed = result => assert.equal(result.status, 'completed', JSON.stringify(result))
const error = (result, code) => {
  assert.equal(result.error?.code, code, JSON.stringify(result))
  assert.equal(isToolError(result), true)
}
async function fixture(body, mode = 'read-only') {
  return withTempDir('agent', async workspace => {
    fs.writeFileSync(path.join(workspace, 'sample.txt'), 'first\nsecond\nthird\n')
    const ops = createAgentOps({ workspace, mode })
    try { await body(ops, workspace) }
    finally { await ops.close() }
  })
}

await test('independent catalogue and read-only authority require no DSH context', async () => {
  const originalSchemas = JSON.stringify(FILE_CAPABILITIES.map(entry => entry.parameters))
  await fixture(async ops => {
    assert.deepEqual(ops.tools.map(tool => tool.name),
      FILE_CAPABILITIES.filter(entry => !entry.mutates).map(entry => name(entry.rawName)))
    for (const tool of ops.tools) {
      assert.equal(tool.inputSchema.additionalProperties, false)
      assert.equal(tool.annotations.readOnlyHint, true)
      assert.equal(tool.annotations.openWorldHint, false)
      assert.doesNotMatch(JSON.stringify(tool), /session cwd/)
      const original = FILE_CAPABILITIES.find(entry => name(entry.rawName) === tool.name)
      assert.notEqual(tool.inputSchema, original.parameters)
    }
    completed(await call(ops, 'stat', { path: 'sample.txt' }))
    error(await call(ops, 'write_file', { path: 'new.txt', content: 'no', expectedRevision: 'absent' }), 'POLICY_DENIED')
    error(await ops.execute('not_a_tool', {}), 'INVALID_ARGUMENT')
  })
  assert.equal(JSON.stringify(FILE_CAPABILITIES.map(entry => entry.parameters)), originalSchemas)
})

await test('bounded reads, compact text, partial failures and search continuation survive projection', async () => {
  await fixture(async ops => {
    const read = await call(ops, 'inspect_local_file', { path: 'sample.txt', limit: 1 })
    completed(read)
    assert.equal(read.complete, false)
    assert.equal(read.nextOffset, 2)
    assert.match(ops.render(name('inspect_local_file'), { path: 'sample.txt' }, read), /1 \| first/)
    const many = await call(ops, 'read_files', { files: [{ path: 'sample.txt', offset: 2, limit: 1 }, { path: 'missing.txt' }] })
    assert.equal(isToolError(many), true)
    assert.match(ops.render(name('read_files'), {}, many), /second/)
    const search = await call(ops, 'grep', { pattern: '.', limit: 1 })
    completed(search)
    assert.equal(search.complete, false)
    assert.equal(search.pageComplete, true, 'the requested page is intact, but more pages remain')
    assert.equal(typeof search.continuation, 'string')
    const next = await call(ops, 'grep', { pattern: '.', limit: 1, continuation: search.continuation })
    completed(next)
    assert.equal(next.items[0].line, 2)
    completed(await call(ops, 'glob', { pattern: ['*.txt'] }))
    const diff = await call(ops, 'diff', { path: 'sample.txt', content: 'changed' })
    completed(diff)
  })
})

await test('path, destination, credential and raw authority injection are denied', async () => {
  await fixture(async (ops, workspace) => {
    for (const file of ['../outside.txt', path.join(workspace + '-other', 'file'), '.env', 'nested/.env.local']) {
      error(await call(ops, 'stat', { path: file }), 'POLICY_DENIED')
    }
    error(await call(ops, 'stat', { path: 'bad\0path' }), 'INVALID_ARGUMENT')
    error(await call(ops, 'read_files', { files: [{ path: '../outside.txt' }] }), 'POLICY_DENIED')
    error(await call(ops, 'stat', { path: 'sample.txt', read_only: false }), 'INVALID_ARGUMENT')
    error(await call(ops, 'copy', { path: 'sample.txt', to: '../outside.txt', expectedRevision: '0'.repeat(64) }), 'POLICY_DENIED')
    error(await call(ops, 'write_file', { path: '.env', content: 'secret', expectedRevision: 'absent' }), 'POLICY_DENIED')
    assert.equal(fs.existsSync(path.join(workspace, '.env')), false)
  }, 'workspace-write')
})

await test('linked directories cannot read or write outside the workspace', async () => {
  await withTempDir('agent-outside', async outside => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside')
    await fixture(async (ops, workspace) => {
      const link = path.join(workspace, 'linked')
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      error(await call(ops, 'inspect_local_file', { path: 'linked/secret.txt' }), 'PATH_RESTRICTED')
      error(await call(ops, 'write_file', { path: 'linked/new.txt', content: 'bad', expectedRevision: 'absent' }), 'PATH_RESTRICTED')
      assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false)
      const found = await call(ops, 'glob', { pattern: ['**/*.txt'] })
      assert.equal(JSON.stringify(found).includes('secret.txt'), false)
    }, 'workspace-write')
  })
})

await test('real create/edit/copy/move/remove and replace retain CAS and dry-run semantics', async () => {
  await fixture(async (ops, workspace) => {
    assert.equal(ops.tools.length, 15)
    const created = await call(ops, 'write_file', { path: 'new.txt', content: 'alpha\n', expectedRevision: 'absent' })
    completed(created)
    error(await call(ops, 'write_file', { path: 'new.txt', content: 'lost', expectedRevision: 'absent' }), 'REVISION_CONFLICT')
    const edited = await call(ops, 'edit_file', {
      path: 'new.txt', expectedRevision: created.revision, edits: [{ oldText: 'alpha', newText: 'beta' }],
    })
    completed(edited)
    completed(await call(ops, 'copy', { path: 'new.txt', to: 'copy.txt', expectedRevision: edited.revision }))
    completed(await call(ops, 'move', { path: 'copy.txt', to: 'moved.txt', expectedRevision: edited.revision }))
    completed(await call(ops, 'remove', { path: 'moved.txt', expectedRevision: edited.revision }))
    const preview = await call(ops, 'replace', { pattern: 'beta', replacement: 'gamma', glob: ['new.txt'], dryRun: true })
    completed(preview)
    assert.equal(fs.readFileSync(path.join(workspace, 'new.txt'), 'utf8'), 'beta\n')
    completed(await call(ops, 'replace', { pattern: 'beta', replacement: 'gamma', glob: ['new.txt'] }))
    assert.equal(fs.readFileSync(path.join(workspace, 'new.txt'), 'utf8'), 'gamma\n')
  }, 'workspace-write')
})

await test('table reader is reusable without host SDK; unsupported document input is an error', async () => {
  await fixture(async (ops, workspace) => {
    fs.writeFileSync(path.join(workspace, 'table.csv'), 'name,value\none,1\n')
    const table = await call(ops, 'read_table', { path: 'table.csv' })
    completed(table)
    assert.match(JSON.stringify(table), /one/)
    for (const tool of ['read_docx', 'read_pdf']) {
      assert.equal(isToolError(await call(ops, tool, { path: 'sample.txt' })), true)
    }
  })
})

await test('cancel, bounded concurrency, close and oversized requests do not silently succeed', async () => {
  await fixture(async ops => {
    error(await call(ops, 'stat', { path: 'sample.txt' }, AbortSignal.abort()), 'CANCELLED')
    const pending = Array.from({ length: 4 }, () => call(ops, 'stat', { path: 'sample.txt' }))
    error(await call(ops, 'stat', { path: 'sample.txt' }), 'BUSY')
    for (const result of await Promise.all(pending)) completed(result)
    error(await call(ops, 'diff', { path: 'sample.txt', content: 'x'.repeat(2 * 1024 * 1024) }), 'OUTPUT_LIMIT')
    const duringClose = call(ops, 'stat', { path: 'sample.txt' })
    await ops.close()
    error(await duringClose, 'RESULT_UNKNOWN')
    error(await call(ops, 'stat', { path: 'sample.txt' }), 'EXECUTOR_UNAVAILABLE')
  })
})

await test('invalid configuration and missing worker fail at startup, not on the first model turn', async () => {
  await fixture(async (_ops, workspace) => {
    assert.throws(() => createAgentOps({ workspace: '.' }), /absolute/)
    assert.throws(() => createAgentOps({ workspace, mode: 'danger-full-access' }), /mode/)
    assert.throws(() => createAgentOps({ workspace, extra: true }), /extra/)
    assert.throws(() => createAgentOps({ workspace, binaryPath: path.join(workspace, 'missing-worker') }), /unavailable/)
    const invalid = spawnSync(process.execPath, [cli, '--mode', 'workspace-write'], { encoding: 'utf8', windowsHide: true })
    assert.notEqual(invalid.status, 0)
    assert.equal(invalid.stdout, '')
    assert.match(invalid.stderr, /workspace/)
    const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', windowsHide: true })
    assert.equal(help.status, 0)
    assert.match(help.stdout, /read-only/)
  })
})

await test('official MCP client negotiates stdio, lists tools, reads and receives tool errors', async () => {
  await fixture(async (_ops, workspace) => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [cli, '--workspace', workspace], stderr: 'pipe',
    })
    const client = new Client({ name: 'agent-test', version: '1.0.0' })
    try {
      await client.connect(transport)
      const { tools } = await client.listTools()
      assert.equal(tools.length, 9)
      const read = await client.callTool({ name: name('read_files'), arguments: { files: [{ path: 'sample.txt', limit: 1 }] } })
      assert.equal(read.isError, false)
      assert.match(read.content[0].text, /first/)
      assert.match(read.content[0].text, /more lines; nextOffset=2/)
      assert.equal(read.structuredContent, undefined, 'do not duplicate full JSON in the model context')
      const denied = await client.callTool({ name: name('stat'), arguments: { path: '../outside' } })
      assert.equal(denied.isError, true)
      assert.match(denied.content[0].text, /POLICY_DENIED/)
      const unknown = await client.callTool({ name: 'unknown', arguments: {} })
      assert.equal(unknown.isError, true)
    } finally { await client.close() }
  })
})

await test('MCP write receipts supply the revision for a subsequent edit', async () => {
  await fixture(async (_ops, workspace) => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [cli, '--workspace', workspace, '--mode', 'workspace-write'], stderr: 'pipe',
    })
    const client = new Client({ name: 'agent-write-test', version: '1.0.0' })
    try {
      await client.connect(transport)
      assert.equal((await client.listTools()).tools.length, 15)
      const created = await client.callTool({ name: name('write_file'),
        arguments: { path: 'created.txt', content: 'alpha\n', expectedRevision: 'absent' } })
      assert.equal(created.isError, false)
      const revision = created.content[0].text.match(/\brevision=([a-f0-9]{64})\b/)?.[1]
      assert.ok(revision, 'the compact receipt must retain the revision')
      const edited = await client.callTool({ name: name('edit_file'), arguments: {
        path: 'created.txt', expectedRevision: revision, edits: [{ oldText: 'alpha', newText: 'beta' }],
      } })
      assert.equal(edited.isError, false)
      assert.equal(fs.readFileSync(path.join(workspace, 'created.txt'), 'utf8'), 'beta\n')
    } finally { await client.close() }
  })
})

await test('stdin EOF shuts down the CLI without a leftover event loop', async () => {
  await fixture(async (_ops, workspace) => {
    const child = spawn(process.execPath, [cli, '--workspace', workspace], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const status = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    const timer = setTimeout(() => child.kill(), 5000)
    child.stdin.end()
    try { assert.equal(await status, 0) }
    finally { clearTimeout(timer) }
  })
})

report('agent')
