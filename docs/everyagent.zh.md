# Everyagent OPS：通用 Agent 适配

English: [Standalone agent adapter](everyagent.md).

本仓库在 dsh-ops 上增加本地 MCP stdio 服务和 JavaScript 调用接口，无需安装 DSH，
也无需模型 API Key。保留上游包名及 DSH 插件入口；`everyagent-ops` 是新增的可执行入口，
不是已经发布的独立 npm 包。

## 原理分析

源码基线：`T-Auto/dsh-ops`，
提交 `dfafddc941695090df2c6e2e323193785aec4eb6`，于 2026 年 10 月 26 日克隆。

```text
DSH 工具注册 / 动态发现 / 会话权限
                  |
         TypeScript worker 桥接
                  |
        stdin：版本化 JSON 请求
                  |
      Rust 单次进程 dsh-ops-worker
                  |
    文件 / 搜索 / 文档 / 结果 / 批处理
                  |
           有界的规范执行结果
            /             \
    Native 紧凑文本       PTC 类型化数据
```

- `src/capabilities/registry.ts` 是统一工具目录，声明名称、schema、写入属性、
  展示方式和发现元数据，不依赖运行中的 DSH。
- `src/file/worker.ts` 负责原 DSH 桥接：读取会话权限、解析路径、拦截凭据路径，
  使用宿主进程服务启动 worker，并更新宿主读前写观察和会话结果存储。
- `src/worker-protocol.ts` 生成版本化 envelope、请求 ID 和预算；
  `native/src/main.rs` 每次读取一个请求、输出一个 JSON 结果。
- `native/src/lib.rs` 将请求分发给 Rust 各 crate。文件工具保留 no-follow 路径遍历、
  修订哈希校验、原子发布；搜索区分“完整扫描”和“当前页完整”。
- `src/modes/native/` 将结果渲染为带行号的紧凑文本，PTC 则消费结构化数据。
  两者是同一内核的不同呈现，不是两套文件操作实现。
- 上游通过动态发现减少常驻 schema，通过批量读取、有界输出和可操作的错误反馈
  减少上下文膨胀与重复调用。这些机制不等于本适配已经测得 token 或速度收益。

## 适配方式

```text
支持 MCP 的 agent -> MCP SDK / stdio -> createAgentOps -> 原 Rust worker
自定义 JS agent --------------------> createAgentOps -> 原 Rust worker
```

`src/agent/index.ts` 使用明确的工作区及只读/可写模式，不伪造 DSH Context。
工具目录、参数规范化、凭据拦截、worker 定位、请求协议和紧凑渲染全部复用。
`src/agent/mcp.ts` 用官方 MCP SDK 处理工具列表、调用和取消，不自行实现 JSON-RPC。

默认只读模式提供 9 个工具：

| 用途 | 工具 |
| --- | --- |
| 读取 | `ops_read_files`、`ops_inspect_local_file`、`ops_stat` |
| 搜索与预览 | `ops_glob`、`ops_grep`、`ops_diff` |
| 文档 | `ops_read_table`、`ops_read_docx`、`ops_read_pdf` |

`workspace-write` 模式额外提供 6 个工具：
`ops_write_file`、`ops_edit_file`、`ops_replace`、`ops_copy`、`ops_move`、`ops_remove`。
保留上游写入协议：例如 `expectedRevision` 使用观察到的 SHA-256；
`absent` 只能创建新文件，不能当作覆盖通配符。

## 构建与启动

需要 Node.js `^22.19 || >=24`、npm 和兼容的 Rust 工具链。
原 worker 支持 Windows x64、Linux x64、macOS arm64/x64。
本次适配只在本机 Windows x64 验证，未验证所有目标平台。

```powershell
Set-Location 'D:\CodeFile\everyagent-ops'
npm ci --ignore-scripts --omit=optional
npm run build
npm run build:ptc
npm run test:agent
node .\bin\everyagent-ops.mjs --workspace 'D:\CodeFile\my-project'
```

最后一条命令等待 stdin 上的 MCP 消息，不是交互聊天或 HTTP 服务。
`--help` 查看参数；诊断写入 stderr，不污染协议 stdout。
`--worker` 或 `DSH_OPS_WORKER_BIN` 可指定绝对 worker 路径；
显式路径由操作者信任，失败不会悄悄换另一份程序。

对于使用 `mcpServers` 格式的客户端，可配置：

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

替换两个路径。客户端 PATH 中没有 Node 时，`command` 改为 Node 的绝对路径。
确实需要写入工作区时，再添加 `"--mode", "workspace-write"`。
其他配置格式的客户端填写相同启动命令及参数即可。本实现不自动修改客户端或全局配置。

## 自定义 JavaScript Agent

```javascript
import { createAgentOps } from 'dsh-ops/agent'

const ops = createAgentOps({ workspace: 'D:\\CodeFile\\my-project' })
try {
  const value = await ops.execute('ops_read_files', {
    files: [{ path: 'README.md', offset: 1, limit: 60 }],
  })
  console.log(value)
} finally {
  await ops.close()
}
```

将 `ops.tools` 转换为目标 agent 的工具注册格式，
执行时调用 `execute(name, arguments, signal?)`。它返回规范结构化结果，
工具失败也是返回值；启动配置错误则在开始服务前抛出。
`render(name, arguments, value)` 提供原有紧凑展示。
MCP 返回紧凑文本及 `isError`，不再附上一份完整 JSON 重复占用上下文；
程序化集成直接使用 JS 返回的结构化值。

## 权限与边界

- 必须明确指定已存在的绝对工作区目录。读取和写入均限制在其中，包括
  copy/move 目标、多文件读取的每个路径；模型参数不能修改模式或工作区。
- 仅规范化操作者指定的根目录，不把模型选择的链接提前 realpath 成普通路径。
  Rust 内核拒绝符号链接、Windows junction、reparse point、特殊文件和歧义路径。
- 读取和写入均启用凭据路径拦截；可通过原有 `DSH_OPS_DENY_READ` 环境变量
  额外添加拒绝路径。这是路径规则，不是内容级密钥识别。
- 默认只读；最多 4 个并行 worker；单次 30 秒；请求 2 MiB；
  worker 输出 128 KiB；紧凑文本 64 KiB。不自动重试。
  写入启动后遇到中断或传输失败会报告效果未知，重试前必须检查实际文件状态。
- 这是受信任的本地文件服务，**不是操作系统沙箱**，使用启动账户的权限。
  不会自动继承 MCP 客户端审批 UI、DSH 会话权限或其他 agent 的沙箱。
  根目录所有权、硬链接及恶意并发文件系统变更不受独立内核安全边界隔离。
- 当前按启动模式静态公布 9 或 15 个工具；未迁移 DSH 动态发现、读取去重、
  持久结果引用、批处理任务、PTC 代码沙箱、shell/后台任务、面板和官方工具隐藏。
  原有范围读取和搜索续页可继续使用；没有持久结果存储时，大结果需要缩小查询范围。
- DOCX/PDF 保持上游有界解析范围，不提供 OCR 或完整格式转换；
  搜索排除规则和文件元数据限制也保持不变。

## 验证与依赖

`test/agent.test.mjs` 使用真实 worker 验证读取、分页、写入/CAS、预演、
凭据/越界/junction 拒绝、取消、并发限制、CLI 退出，以及官方 SDK 客户端的
stdio 握手、调用，以及从写入回执取得 revision 后继续编辑。
`test/agent-cancellation.test.mjs` 通过受控子进程的就绪信号，
验证执行中的 MCP 请求取消、调用槽位释放和断开连接后的清理，避免时间竞态。
通过 `npm run test:agent` 运行这两套测试。

`npm run test:agent:package` 构建并打包当前源码，在临时目录仅安装生产依赖，
验证没有 DSH 包时的 JS API、MCP 模块和 CLI。检查会清除消费进程中的
worker 路径覆盖，确保调用打包后的运行时。
请先运行 `npm run build:ptc` 准备 worker；此检查需要访问 npm registry。

2026 年 10 月 26 日首次实现验收（Windows x64、Node 24.12.0、Cargo 1.96.0）：
新增 10 项检查及原有工具目录/文件/渲染 37 项检查全部通过，共 5 套测试、零跳过。
TypeScript 检查、构建及 133 项 manifest 检查通过。
打包后仅安装生产依赖，在没有 `@deepseek-ai` 包的独立目录成功调用原生 worker。
当次 `npm audit --omit=optional` 为零告警；未运行上游全量发布验收或 Linux/macOS 测试。

2026 年 10 月 26 日同机评审修补验收：两套适配测试共 13 项检查通过。
完整 Windows 门禁 `node scripts/verify-gate.mjs --skip-install` 通过：
147 个 JavaScript 套件通过、133 项 manifest 检查通过，Rust workspace 测试通过。
明确跳过 `linux-attributes`、`linux-shell`、`tui-host`、`tui-native` 四个套件；
未配置 UNC 共享的可选 Rust 测试按原规则忽略。
已暂存和打包后的 Windows 运行时闭包检查通过，仅生产依赖的适配打包检查独立通过。
本机仍未执行 Linux/macOS 验证。

新增一个直接运行依赖：`@modelcontextprotocol/sdk@1.32.1`，
发布于 2026 年 10 月 5 日，用于复用协议协商、传输和取消能力。
安装时发现的审计告警通过锁文件中兼容的 `zod`、`fast-uri`、`undici`
传递依赖补丁解决。未增加远程服务、自动 shell 安装或模型厂商专用依赖。
