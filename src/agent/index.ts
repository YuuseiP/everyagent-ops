/** Standalone file authority; no DSH context, model SDK, shell or network listener. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { FILE_CAPABILITIES } from '../capabilities/registry.js'
import { inside } from '../authority-paths.js'
import { credentialPath, credentialRoots } from '../credential-policy.js'
import { normalizeArguments } from '../file/contract.js'
import { resolveReadFiles } from '../file/read-files.js'
import { renderNative } from '../modes/native/render.js'
import { publicToolName } from '../policy.js'
import { resolveWorker } from '../ptc/runtime.js'
import { record } from '../worker-boundary.js'
import { workerEnvelope, WORKER_TIMEOUT_MS, WORKER_OUTPUT_BYTES } from '../worker-protocol.js'

export interface AgentOptions {
  workspace: string
  mode?: 'read-only' | 'workspace-write'
  binaryPath?: string
}

function failure(code: string, message: string, unknownEffect = false): Record<string, unknown> {
  return {
    status: code === 'POLICY_DENIED' ? 'rejected' : 'error', complete: false,
    error: {
      code, message, effectState: unknownEffect ? 'unknown' : 'none', retryable: false,
      nextAction: unknownEffect ? 'Inspect current state before retrying; an interrupted write may have applied.' : message,
    },
  }
}

/** Partial reads with failing children must not become successful MCP results. */
export function isToolError(value: Record<string, unknown>): boolean {
  return record(value.error) || ['error', 'rejected', 'conflict', 'unknown', 'failed'].includes(String(value.status))
    || (typeof value.failed === 'number' && value.failed > 0)
    || (Array.isArray(value.items) && value.items.some(item => record(item) && isToolError(item)))
}

function workspaceDescription(value: string): string {
  return value.replace(/\b(?:(?:current|DSH) )?session cwd\b/g, 'configured workspace')
}

export function createAgentOps(options: AgentOptions) {
  for (const key of Object.keys(options)) {
    if (!['workspace', 'mode', 'binaryPath'].includes(key)) throw new TypeError(`Unknown agent option: ${key}`)
  }
  if (typeof options.workspace !== 'string' || !path.isAbsolute(options.workspace)) {
    throw new TypeError('workspace must be an absolute existing directory.')
  }
  const workspace = fs.realpathSync.native(options.workspace)
  if (!fs.statSync(workspace).isDirectory()) throw new TypeError('workspace must be a directory.')
  const mode = options.mode ?? 'read-only'
  if (!['read-only', 'workspace-write'].includes(mode)) throw new TypeError('mode must be read-only or workspace-write.')
  const binary = resolveWorker({ binaryPath: options.binaryPath })
  const scope = randomUUID()
  const active = new Map<AbortController, Promise<Record<string, unknown>>>()
  let closed = false
  const available = FILE_CAPABILITIES.filter(entry => mode === 'workspace-write' || !entry.mutates)
  const tools = available.map(entry => ({
    name: publicToolName(entry.rawName),
    description: workspaceDescription(entry.description),
    inputSchema: JSON.parse(JSON.stringify(entry.parameters, (key, value) =>
      key === 'description' && typeof value === 'string' ? workspaceDescription(value) : value)),
    annotations: { readOnlyHint: !entry.mutates, destructiveHint: entry.mutates, openWorldHint: false },
  }))

  function target(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.length || raw.includes('\0')) throw new TypeError('Expected a nonempty path.')
    // Resolve only the operator-owned anchor, never a model-selected symlink.
    const resolved = path.resolve(workspace, raw)
    if (!inside(workspace, resolved)) throw new Error('Paths must stay inside the configured workspace.')
    if (credentialPath(resolved).denied) throw new Error('Credential locations cannot be read or written.')
    return resolved
  }

  async function execute(name: string, input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (closed) return failure('EXECUTOR_UNAVAILABLE', 'This adapter has been closed.')
    const entry = FILE_CAPABILITIES.find(entry => publicToolName(entry.rawName) === name)
    if (!entry) return failure('INVALID_ARGUMENT', 'Unknown file capability.')
    if (entry.mutates && mode === 'read-only') return failure('POLICY_DENIED', 'Restart with workspace-write mode to authorize writes.')
    if (signal?.aborted) return failure('CANCELLED', 'The call was cancelled before execution.')
    if (active.size >= 4) return failure('BUSY', 'At most four worker calls may run at once; wait for a running call to finish.')
    const args = normalizeArguments(entry.rawName, input)
    if (!record(args)) return failure('INVALID_ARGUMENT', 'Arguments must be an object.')
    let resolved: Record<string, unknown>
    try {
      if (entry.rawName === 'read_files') {
        const reads = resolveReadFiles(args, workspace)
        if ('error' in reads) return failure('INVALID_ARGUMENT', reads.error)
        resolved = { ...args, files: reads.files.map(file => ({ ...file, path: target(file.path) })) }
      } else {
        resolved = { ...args, path: target(args.path ?? '.') }
        if (entry.rawName === 'copy' || entry.rawName === 'move') resolved.to = target(args.to)
      }
    } catch (error) {
      return failure(error instanceof TypeError ? 'INVALID_ARGUMENT' : 'POLICY_DENIED', (error as Error).message)
    }
    const envelope = workerEnvelope('file', {
      root: workspace, scope, tool: entry.rawName, args: resolved,
      read_only: mode === 'read-only', write_roots: [workspace],
      deny_roots: credentialRoots(), deny_credential_names: true,
    })
    let data: string
    try { data = JSON.stringify(envelope) }
    catch { return failure('INVALID_ARGUMENT', 'Arguments must be JSON serializable.') }
    if (Buffer.byteLength(data) > 2 * 1024 * 1024) return failure('OUTPUT_LIMIT', 'Request exceeds the 2 MiB byte budget.')

    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const work = new Promise<Record<string, unknown>>(resolve => {
      let result: Record<string, unknown>
      const child = execFile(binary, [], {
        cwd: workspace, windowsHide: true, encoding: 'utf8', signal: controller.signal,
        timeout: WORKER_TIMEOUT_MS, maxBuffer: WORKER_OUTPUT_BYTES,
      }, (error, stdout) => {
        if (error) {
          result = failure(child.pid ? 'RESULT_UNKNOWN' : 'EXECUTOR_UNAVAILABLE',
            child.pid ? 'Worker interrupted or output unavailable.' : 'Worker could not be started.', !!child.pid && entry.mutates)
          return
        }
        try {
          const value: unknown = JSON.parse(stdout)
          result = record(value) && typeof value.status === 'string'
            ? value : failure('RESULT_UNKNOWN', 'Worker returned an invalid result.', entry.mutates)
        } catch { result = failure('RESULT_UNKNOWN', 'Worker returned invalid JSON.', entry.mutates) }
      })
      // Abort emits an error before exit; retain the call slot until the process closes.
      child.once('close', () => resolve(result ?? failure('RESULT_UNKNOWN', 'Worker closed without a receipt.', entry.mutates)))
      // execFile owns termination and the final receipt, including early stdin closure.
      child.stdin?.on('error', () => {})
      child.stdin?.end(data)
    })
    active.set(controller, work)
    try { return await work }
    finally {
      active.delete(controller)
      signal?.removeEventListener('abort', abort)
    }
  }

  return {
    workspace, mode, tools, execute,
    render(name: string, args: unknown, value: unknown): string {
      const entry = available.find(entry => publicToolName(entry.rawName) === name)
      return renderNative(entry?.rawName ?? name, normalizeArguments(entry?.rawName ?? name, args), value)
    },
    async close(): Promise<void> {
      closed = true
      for (const controller of active.keys()) controller.abort()
      await Promise.allSettled(active.values())
    },
  }
}
