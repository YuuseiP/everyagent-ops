import childProcess from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { mock } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../lib/agent/mcp.js'
import { publicToolName } from '../lib/policy.js'
import { assert, test, report, withTempDir, waitFor, tick } from './lib/harness.mjs'
import { requireWorker } from './lib/boundary.mjs'

requireWorker('agent-cancellation')
const realExecFile = childProcess.execFile

async function fixture(body) {
  await withTempDir('agent-cancellation', async workspace => {
    fs.writeFileSync(path.join(workspace, 'sample.txt'), 'sample\n')
    const { server, ops } = createMcpServer({ workspace })
    const client = new Client({ name: 'agent-cancellation-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    let child, workerSignal, ready = false, closed = false
    // A real child announces readiness and waits, so cancellation never races a fast stat.
    const replacement = mock.method(childProcess, 'execFile', (_binary, _args, options, callback) => {
      workerSignal = options.signal
      child = realExecFile(process.execPath, ['-e',
        'process.stdin.resume(); process.stderr.write("ready"); setInterval(() => {}, 1000)',
      ], options, callback)
      child.stderr.on('data', () => { ready = true })
      child.once('close', () => { closed = true })
      return child
    })
    syncBuiltinESMExports()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      await body({ client, ops, waitReady: () => waitFor(() => ready, { timeoutMs: 5000 }),
        waitStopped: () => waitFor(() => workerSignal?.aborted && closed, { timeoutMs: 5000 }),
        restoreWorker() { replacement.mock.restore(); syncBuiltinESMExports() },
      })
    } finally {
      await ops.close()
      await client.close()
      await server.close()
      replacement.mock.restore()
      syncBuiltinESMExports()
    }
  })
}

await test('MCP cancellation stops an in-flight worker and releases its call slot', async () => {
  await fixture(async ({ client, ops, waitReady, waitStopped, restoreWorker }) => {
    const controller = new AbortController()
    const pending = client.callTool({ name: publicToolName('stat'), arguments: { path: 'sample.txt' } },
      undefined, { signal: controller.signal })
    const cancelled = assert.rejects(pending, /cancelled by test/)
    await waitReady()
    controller.abort(new Error('cancelled by test'))
    await cancelled
    await waitStopped()
    await tick()
    restoreWorker()
    const values = await Promise.all(Array.from({ length: 4 }, () =>
      ops.execute(publicToolName('stat'), { path: 'sample.txt' })))
    for (const value of values) assert.equal(value.status, 'completed', JSON.stringify(value))
    const next = await client.callTool({ name: publicToolName('stat'), arguments: { path: 'sample.txt' } })
    assert.equal(next.isError, false)
  })
})

await test('disconnecting an MCP client stops its active worker and closes the adapter', async () => {
  await fixture(async ({ client, ops, waitReady, waitStopped }) => {
    const pending = client.callTool({ name: publicToolName('stat'), arguments: { path: 'sample.txt' } })
    const disconnected = assert.rejects(pending, /closed/i)
    await waitReady()
    await client.close()
    await disconnected
    await waitStopped()
    assert.equal((await ops.execute(publicToolName('stat'), { path: 'sample.txt' })).error.code,
      'EXECUTOR_UNAVAILABLE')
  })
})

report('agent-cancellation')
