# Everyagent OPS: standalone agent adapter

Chinese: [通用 Agent 适配](everyagent.zh.md).

This checkout adds a local MCP stdio server and a JavaScript execution API to
dsh-ops. Neither requires a DSH installation or a model-provider API key.
The upstream package identity and DSH entries remain unchanged; `everyagent-ops`
is the new executable, not a separately published npm package.

## How dsh-ops works

Source baseline: `T-Auto/dsh-ops`, commit
`dfafddc941695090df2c6e2e323193785aec4eb6` (cloned October 26, 2026).

```text
DSH registration / discovery / session policy
                   |
          TypeScript worker bridge
                   |
        versioned JSON request on stdin
                   |
      Rust one-shot dsh-ops-worker
                   |
   files / search / documents / results / batch
                   |
     canonical, bounded execution receipt
          /                         \
 compact Native text          typed PTC values
```

- `src/capabilities/registry.ts` is the shared catalogue: names, schemas,
  mutation classification, presentation and discovery metadata.
- `src/file/worker.ts` resolves DSH authority, paths and credential exclusions,
  then invokes the worker through host subprocess services. It also updates
  DSH read observations and manages session-bound result storage.
- `src/worker-protocol.ts` creates the versioned request, unique request ID and
  budgets. `native/src/main.rs` decodes one request and emits one JSON result.
- `native/src/lib.rs` dispatches to the Rust workspace crates. File operations
  use no-follow traversal, revision checks and atomic publication. Search
  distinguishes full-scan coverage from page completeness.
- `src/modes/native/` renders compact, line-numbered model text; PTC consumes
  structured values instead. These are two presentations of the same kernel,
  not two competing implementations.
- DSH discovery keeps the resident tool surface small; bounded output,
  multi-file reads and actionable error receipts reduce context growth and
  repeated calls. These mechanisms do not establish a measured speed or token
  improvement for this new adapter.

## What the adapter changes

```text
MCP-compatible agent -> MCP SDK / stdio -> createAgentOps -> existing Rust worker
Custom JS agent -----------------------> createAgentOps -> existing Rust worker
```

`src/agent/index.ts` owns an explicit workspace and read/write mode instead of
impersonating DSH services. It reuses the existing catalogue, argument
normalization, credential fence, worker resolver, envelope and compact renderer.
`src/agent/mcp.ts` translates tool listing/calls and request cancellation using
the official MCP SDK. No custom JSON-RPC implementation is added.

The default read-only mode publishes nine tools:

| Task | Tools |
| --- | --- |
| Read | `ops_read_files`, `ops_inspect_local_file`, `ops_stat` |
| Search / preview | `ops_glob`, `ops_grep`, `ops_diff` |
| Documents | `ops_read_table`, `ops_read_docx`, `ops_read_pdf` |

`workspace-write` additionally publishes six tools:
`ops_write_file`, `ops_edit_file`, `ops_replace`, `ops_copy`, `ops_move`, `ops_remove`.
Mutations require the existing worker contracts; for example, `expectedRevision`
is a SHA-256 revision, while `absent` permits only creation, never overwriting.

## Build and start

Requires Node.js `^22.19 || >=24`, npm and a compatible Rust toolchain.
The existing worker supports Windows x64, Linux x64 and macOS arm64/x64.
This adapter has been exercised locally on Windows x64, not all those targets.

```powershell
Set-Location 'D:\CodeFile\everyagent-ops'
npm ci --ignore-scripts --omit=optional
npm run build
npm run build:ptc
npm run test:agent
node .\bin\everyagent-ops.mjs --workspace 'D:\CodeFile\my-project'
```

The last command waits for MCP messages on stdin; it is not an interactive chat
or HTTP server. `--help` prints CLI usage. Diagnostics go to stderr, never the
protocol channel. `--worker` or `DSH_OPS_WORKER_BIN` can select an absolute
executable path; explicit selection is trusted and never silently falls back.

Generic configuration for a client using the `mcpServers` shape:

```json
{
  "mcpServers": {
    "everyagent-ops": {
      "command": "node",
      "args": [
        "D:\\CodeFile\\everyagent-ops\\bin\\everyagent-ops.mjs",
        "--workspace",
        "D:\\CodeFile\\my-project"
      ]
    }
  }
}
```

Replace both paths. If the client does not inherit Node on PATH, use the absolute
Node executable. Add `"--mode", "workspace-write"` only when workspace writes
are intended. Clients with a different config format need the same command and
arguments in their own format. No client or global configuration is modified
automatically.

## Direct JavaScript integration

```javascript
import { createAgentOps } from 'dsh-ops/agent'

const ops = createAgentOps({ workspace: 'D:\\CodeFile\\my-project' })
try {
  // Register ops.tools with your agent's tool registry, translating its schema format.
  const value = await ops.execute('ops_read_files', {
    files: [{ path: 'README.md', offset: 1, limit: 60 }],
  })
  console.log(value) // Canonical structured result, including failures.
} finally {
  await ops.close()
}
```

`execute(name, arguments, signal?)` returns a structured result, not thrown tool
errors. Invalid startup configuration throws before serving tools.
`render(name, arguments, value)` produces the original compact presentation.
MCP returns that compact text and `isError`, without duplicating the full JSON in
model context. Direct callers use the canonical values for programmatic work.

## Authority and limits

- Workspace must be an explicit, existing absolute directory. Both reads and
  writes, including copy/move destinations and multi-file ranges, are confined
  to that workspace. Model arguments cannot change the mode or workspace.
- The operator-owned root is canonicalized once; model-selected descendants
  are not realpathed away. The Rust engine rejects symlinks, Windows junctions,
  reparse points, special files and ambiguous paths.
- Credential exclusions remain enabled for reads and writes. Extra denied paths
  can be supplied through the existing `DSH_OPS_DENY_READ` environment variable.
  This is a path fence, not a content-level secret detector.
- Defaults: read-only, at most four active workers, 30-second calls, 2 MiB
  requests, 128 KiB worker output, 64 KiB compact text. There is no automatic
  retry. Cancellation/transport failures after a write starts report unknown
  effects; inspect postconditions before another write.
- This is a trusted local file service, **not an OS sandbox**. It runs with the
  launching account's permissions. MCP client approval UI, DSH session
  authority and another agent's sandbox are not automatically inherited.
  Root ownership, hard links and concurrent hostile filesystem changes are not
  isolated by a separate kernel security boundary.
- The catalogue is static: 9 or 15 tools according to startup mode. This first
  adapter does not reproduce DSH's dynamic discovery, read deduplication,
  durable result references, batch jobs, PTC code sandbox, shell/job services,
  panels or official-tool hiding. Existing range/search paging remains usable.
  Large results without durable storage require narrower queries/ranges.
- DOCX/PDF support keeps the upstream bounded parser scope; it is not OCR or
  full document conversion. Search exclusions and metadata limitations also
  remain unchanged.

## Verification and dependency choice

`test/agent.test.mjs` exercises real worker reads, paging, writes/CAS, dry-run,
credential/path/junction denial, cancellation, concurrency bounds, CLI shutdown
and an official SDK client over stdio, including write-receipt revisions used by
a subsequent edit. `test/agent-cancellation.test.mjs` uses a ready signal from a
controlled child process to test in-flight MCP cancellation, slot release and
disconnect cleanup without timing races. Run both with `npm run test:agent`.

Run `npm run test:agent:package` to build and pack this checkout, install only
production dependencies in a temporary consumer, and check the JS API, MCP module
and CLI with no DSH packages installed. It also clears the worker-path override
for the consumer, so the check must use the packaged runtime. Stage the native
worker first with `npm run build:ptc`; npm registry access is required.

Initial acceptance on October 26, 2026 (Windows x64, Node 24.12.0, Cargo 1.96.0):
10 new adapter checks plus 37 existing capability/file/render checks passed
across five suites, with no skips. TypeScript/build and all 133 manifest checks
passed. A packed tarball installed with production dependencies only successfully
called the native worker with no `@deepseek-ai` packages installed.
`npm audit --omit=optional` reported zero vulnerabilities at that time.
The full upstream release gate and Linux/macOS runs were not performed.

Review follow-up acceptance on October 26, 2026, on the same Windows host:
all 13 adapter checks passed across two suites. The complete Windows gate
(`node scripts/verify-gate.mjs --skip-install`) passed: 147 JavaScript suites
passed, 133 manifest checks passed, and Rust workspace tests passed. Four suites
were explicitly skipped: `linux-attributes`, `linux-shell`, `tui-host` and
`tui-native`; the optional Rust UNC test was ignored without a configured share.
The staged and packed Windows runtime closure checks passed. The production-only
adapter package check passed independently. Linux/macOS execution remains untested
locally.

The one new direct runtime dependency is `@modelcontextprotocol/sdk@1.32.1`
(published October 5, 2026): it supplies protocol negotiation, transport,
cancellation and client interoperability rather than a home-grown protocol.
The lock also updates compatible `zod`, `fast-uri` and `undici` transitive
patches to resolve the audit findings encountered during installation.
No remote server, automatic shell provisioning or model-specific dependency
is added.
