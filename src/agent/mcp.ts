import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createAgentOps, isToolError, type AgentOptions } from './index.js'

export function createMcpServer(options: AgentOptions) {
  const ops = createAgentOps(options)
  // The low-level SDK accepts the existing JSON Schemas without a second Zod catalogue.
  const server = new Server({ name: 'everyagent-ops', version: '0.1.0' }, {
    capabilities: { tools: {} },
    instructions: [
      'File operations are relative to the operator-configured workspace, not the client cwd.',
      'Use read_files for bounded multi-file reads; grep/glob for search.',
      'Reuse observed SHA-256 revisions for CAS writes; absent means create-only.',
      'Check completeness and continuation notices. Never retry unknown write effects blindly.',
      'No shell, arbitrary code, durable result store or DSH policy inheritance is provided.',
    ].join('\n'),
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ops.tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {}
    const value = await ops.execute(request.params.name, args, extra.signal)
    return {
      isError: isToolError(value),
      content: [{ type: 'text' as const, text: ops.render(request.params.name, args, value) }],
    }
  })
  server.onclose = () => { void ops.close() }
  return { server, ops }
}

export async function serveStdio(options: AgentOptions): Promise<void> {
  const { server, ops } = createMcpServer(options)
  server.onerror = error => console.error(`everyagent-ops: ${error.message}`)
  const stop = async () => {
    await ops.close()
    await server.close()
  }
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
  // stdin EOF means the agent has disconnected; do not leave owned workers running.
  process.stdin.once('end', () => { void stop() })
  try {
    await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 2 * 1024 * 1024 }))
  } catch (error) {
    await stop()
    throw error
  }
}
