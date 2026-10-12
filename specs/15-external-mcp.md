# Spec 15 — 外部 MCP 工具接入

> 让**任意 adapter** 的 Agent 接入「用户配置的外部 MCP server」,把工具扩展统一到 MCP 协议上,而不必为每个能力手写内置工具。
>
> **状态:P0 已实现(2026-10-09),已端到端验证(2026-10-10)。** P0 = 数据模型 + `claude-code`/`codex` 接线 + 设置面板与 Agent builder + `trust='ask'` 审批门(仅 Claude Code)。`custom` 的 MCP 客户端层仍是 **P1,未实现**(见 §10)。
> 实现记录与四项与本文原稿的偏差(现场核查得出)见 **§12**。改动安全约束(§6)已经讨论并记录。

源文件:`src/server/mcp-server-service.ts`(服务层)· `src/server/mcp-approvals.ts` + `src/server/pending-mcp-tools.ts`(审批门) · `src/shared/mcp.ts`(支持矩阵) · `src/app/api/mcp-servers/**` · 改动 `src/server/adapters/**`

---

## 1. 现状与动机

| Adapter | 工具机制 | 是不是 MCP client | 能接外部 MCP 吗 |
|---|---|---|---|
| `custom` | OpenAI function-calling + 内部 `toolRegistry` | ❌ 无 MCP | ❌ |
| `claude-code` | SDK 预置工具 + 进程内 `createSdkMcpServer`(只挂 `agenthub`) | ✅(SDK 自带) | ❌(没接线) |
| `codex` | Codex 内置 + 外部 stdio MCP(只挂 `agenthub`) | ✅(SDK 自带) | ❌(没接线) |

**问题**:三者目前都**只挂了内部 `agenthub` 一个 MCP server**,没有「让用户接第三方 MCP server(filesystem / github / postgres / 自建…)」的路径;`custom` 连 MCP client 底子都没有。

**动机**:① 接入 MCP 生态 → 工具扩展不再靠手写;② 统一三个 adapter 的扩展入口;③ 复用现有 `tool.call`/`tool.result` 事件,不破坏契约。

---

## 2. 目标 / 非目标

**目标**
- 用户可在「设置」里登记外部 MCP server(stdio / SSE / HTTP),并在 Agent 上勾选启用(像勾 `toolNames`)。
- **claude-code / codex 统一支持**(P0);custom 需新建一个 MCP 客户端层(P1)。
- MCP 工具调用复用现有 `tool.call` / `tool.result` 事件;审批另用一对 `mcp_tool.*` 事件(见 §5)。
- 有明确的**信任/沙箱**模型(外部 MCP 会绕过现有沙箱,见 §6)。

**非目标(首版)**
- 不替换内置工具(`agenthub` server 仍是内部桥接,见 spec 05/07)。
- 不做 MCP server 的**发布/托管**(AgentHub 仍只作为 MCP client)。
- 首版不做 OAuth-flow 鉴权的远程 MCP(只支持 stdio 命令 + 带静态 header 的 SSE/HTTP)。

---

## 3. 数据模型(推荐方案)

镜像「工具」的模型:**全局定义 server,Agent 按需 opt-in**。

**新表 `mcp_servers`**(详见 spec 08 待补):

```
id            text PK       // mcp_xxx
name          text unique   // 命名空间用,见 §5;仅 [a-z0-9_],且不得含 '__'(见 §12)
transport     'stdio' | 'sse' | 'http'
command       text?         // stdio: 可执行(不做硬白名单,见 §11.4)
args          json string[] // stdio
env           json record?  // stdio: 附加环境变量(继承本进程环境,见 §6.3)
url           text?         // sse / http: 端点
headers       json record?  // sse / http: 静态请求头(放 API key 等)
trust         'always' | 'ask'   // 默认 'ask',见 §6
enabled       boolean       // 全局开关,默认 false(两道 opt-in,见 §6.1)
createdAt     integer
```

**`agents` 增列**:`mcpServerIds: json string[]`(默认 `[]`)——该 Agent 启用哪些 server,语义同 `toolNames`。

> **已定**:全局 `mcp_servers` 表 + per-agent `mcpServerIds` 引用(define-once-reuse、密钥集中管理、与 `toolNames` 模型一致)。不用 per-agent 内联(会重复配置 + 密钥分散)。

---

## 4. 各 Adapter 的接入方式

```
                       启用的 mcp_servers(按 agent.mcpServerIds 解析)
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
  claude-code:接线              codex:接线                custom:造客户端
  query() 的 mcpServers        config.mcp_servers          新建 MCP client 层
  里追加这些 server            里追加这些 server           (见下;P1,未实现)
  (SDK 自管连接+工具暴露)      (Codex 自管)               
```

- **claude-code**:把启用的 server 转成 SDK 的 `mcpServers` 配置项,与现有 `agenthub`(进程内)并列传入 `query()`。stdio server 由 SDK 自管子进程。**主要是格式转换 + 接线**。
- **codex**:把启用的 server 加进 `config.mcp_servers`(与现有 `agenthub` 并列)。Codex runtime 自管。**接线**。
- **custom**:**新建 MCP 客户端层**(`@modelcontextprotocol/sdk` 已是依赖)。**P1,尚未实现**:
  1. run 开始:对每个启用的 server 建 `Client` + transport(`StdioClientTransport` / `SSEClientTransport`)并 `connect`。
  2. `listTools()` → 转成 OpenAI function-calling tool(名字加命名空间前缀,见 §5),**合并进**现有 `apiTools`。
  3. tool loop 里:工具名命中 `mcp__` 前缀 → 路由到对应 `client.callTool(...)`;否则走 `toolRegistry.execute`(现状不变)。
  4. run 结束 / abort:`close()` 所有 client,stdio 杀进程树(复用 `killProcessTree`,spec 11)。

---

## 5. 工具命名与事件

- **命名空间**:外部 MCP 工具统一命名 `mcp__<serverName>__<toolName>`(对齐 claude-code/codex SDK 既有约定,如 `mcp__agenthub__write_artifact`),避免与内置工具冲突。
- **调用事件**:MCP 工具调用复用现有 `tool.call` / `tool.result`(`specs/02`),`toolName` 用命名空间名。**不为「上报一次调用」新增任何 StreamEvent,不破坏前端 reducer**。
- **审批事件**:审批是另一件事,用独立的一对 `mcp_tool.pending` / `mcp_tool.resolved`(镜像 `bash_command.*`,见 spec 02 / 09)。这是本特性**唯一**的 StreamEvent 新增。
- **artifact**:外部 MCP 工具一般不产 AgentHub 产物;不触发 `artifact.create`(除非它显式返回 `artifactId` 并被约定识别——首版不做)。
- **支持矩阵**(实测结论,前后端共用 `src/shared/mcp.ts`):

  | transport | Claude Code | Codex |
  |---|---|---|
  | `stdio` | ✅ | ✅ |
  | `http`(streamable) | ✅ | ✅ |
  | `sse` | ✅ | ❌ |

  Codex CLI 0.149.1 只提供 `<COMMAND>...`(stdio)或 `--url`(streamable HTTP)两种形态,**没有 SSE**。因此 `sse` 的 server 在 Codex agent 上被跳过并记一条警告,而不是带病传给 Codex。

---

## 6. 安全 / 信任模型（重点,§5 张力点）

外部 MCP server **运行任意代码(stdio)或访问外部网络(sse)**,**绕过 AgentHub 的 workspace 沙箱 + Bash 黑名单**。这是本特性最大的安全口子,必须显式设计:

1. **显式 opt-in 两道**:server 由用户**手动登记**(默认 `enabled=false`);Agent 由用户**手动勾选**。默认不启用任何外部 MCP。
2. **trust 级别**:
   - `always`:直接放行(用户明确信任的 server)。
   - `ask`(默认):MCP 工具调用走**审批门**。**粒度 = per-tool-per-conversation**:某 `mcp__server__tool` 在一次会话内**首次**调用时弹审批,批准后该会话内该工具免再问;拒绝则该次调用返回 `isError`,run 继续。被拒时返回给模型的文案明确要求「不要重试」。(每次都问太吵;整个 server 一次批又太粗——同一 server 可能既有安全的读、又有危险的写。)
   - **生效范围**:审批门**只在 Claude Code** 落地(P0)。Codex 有自己的一套审批策略与沙箱,AgentHub 拦截不到它的工具决策,所以 `trust` 对 Codex 是**建议性的**,UI 必须如实标注而不是把它显示成一道生效的保护。custom 的 MCP 客户端是 P1。
3. **stdio 收敛**:`cwd` 未强制到 workspace(见 §12 D3 说明);`env` **继承本进程完整环境**(`buildChildProcessEnv`)——这**不是白名单**,见 §6.3 下方。
4. **失败隔离**:某 server 连接/调用失败 → 跳过该 server 并记警告(`console.warn('[mcp] ...')`),**不崩整个 run**。
5. **中止**:`AbortSignal` 触发时关闭所有 MCP 连接、杀 stdio 进程树(复用 `killProcessTree` / spec 11)。
6. **明确告知**:文档与 UI 必须写明「**外部 MCP 不在 AgentHub 的沙箱保证范围内**」,这是用户授予的信任。

### 6.3 stdio 子进程的环境:完整继承,不是白名单

原稿写的「`env` 走白名单(复用 `buildChildProcessEnv`)」**说错了这个函数的行为**:`buildChildProcessEnv()` 是把 `process.env` **整体透传**(`adapters/adapter-utils.ts`)。

**决定(2026-10-09):照旧复用它。** 后果是明确接受的,不是疏忽:第三方 stdio MCP server 因此**能读到 AgentHub 自己存的 provider API Key 和其他内部 token**。由此产生的义务是:

- 这是**安全约束的放松**,登记 UI 必须同时说明两件事:该 server 在沙箱与命令黑名单之外运行,**且**能读到已存的凭据;
- 文档(本节、`CLAUDE.md §5`、`specs/11-platform.md`)只能描述为「完整环境继承」,**不得**再称其为白名单或隔离;
- 对外配置的 stdio server 与 `agenthub` 桥接子进程走的是同一套环境构造,没有额外收敛。

> 注:claude-code/codex 把沙箱委托给各自 SDK(canUseTool / Codex sandbox);custom 的 MCP 工具**不经我们的沙箱**——这是 custom 接 MCP 的固有代价,§6.2 的审批门是主要缓解。

---

## 7. 生命周期 / 并发

- **custom**:首版 **per-run 连接 + 结束 teardown**(干净、无跨 run 状态,符合 adapter「不持久状态」原则);连接池化(per-conversation)作为 P2 优化。
- **claude-code / codex**:连接由 SDK 自管(随 query / thread)。
- stdio server 是子进程 → 必须保证 run 结束/中止时清理(否则泄漏进程),复用 spec 11 的子进程清理。

---

## 8. 配置 UI(出口,细节另议)

- **设置面板**(spec 09):MCP server 管理——增/删/改 + 「测试连接」(connect + listTools 预览)。敏感字段(headers 里的 key)按现有 key 管理思路存 DB(不引 keychain,见 CLAUDE.md §5.4)。
- **Agent builder**(spec 10):勾选本 Agent 启用哪些 server(形如 `AVAILABLE_TOOLS` 的多选)。

---

## 9. 影响面 / 需同步的 spec（✅ 均已于 2026-10-09 同步）

- `01-core-entities` — `Agent` 实体新增 `mcpServerIds` 字段（`CLAUDE.md §3.2` 要求实体字段改动必须同步本 spec）
- `02-stream-events` — `mcp_tool.pending` / `mcp_tool.resolved` 两个事件 + 持久化表
- `05-adapter-interface` — `AdapterInput.mcpServers` + 三 adapter 的 MCP 接入方式
- `07-tools` — MCP 工具命名空间 + 与内置工具/`toolRegistry` 的关系
- `08-db-schema` — `mcp_servers` 表 + `agents.mcp_server_ids` 列（实际按 `bootstrap.ts` DDL + `safeAlter` + `migrate-add-mcp-servers.ts` 落地，**不是** `pnpm db:push` —— 原因见 `specs/08` 迁移规范）
- `09-frontend-architecture` — 设置面板 MCP 管理 + `McpServerPicker` + 两个 reducer
- `10-agent-builder` — Agent 勾选 MCP server
- `11-platform` — stdio MCP 子进程的跨平台启动/清理 + 环境继承
- `CLAUDE.md §5.5` — 安全约束新增「外部 MCP 信任模型」(已讨论)
- `openspec/specs/external-mcp/` — 新建能力契约；其余 7 个能力的 delta 已折入 `openspec/specs/`

---

## 10. 分期建议

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0** | 数据模型(`mcp_servers` + `agents.mcpServerIds`)+ **claude-code/codex 接线** + 全局 server 配置 + agent 选用 + **`ask` 审批门(仅 Claude Code)** | ✅ 已完成 2026-10-09 |
| **P1** | **custom 的 MCP 客户端层**(连接 / listTools / 名字空间 / loop 路由 / 清理) | 未实现 |
| **P2** | **Codex/custom 的审批门**、OAuth、连接池、危险命令提示 | 未实现 |

> 即「先让真 agent 平台(claude-code/codex)接上外部 MCP(便宜),再补 custom(贵)」。
> `ask` 审批门从 P2 提前到 P0:理由是**存了 `trust='ask'` 却不拦**,比没有这个字段更糟——UI 会暗示一层并不存在的保护。详见 §12 D1。

---

## 11. 决策记录（已定 2026-06-04;实现仍按 §6 安全约束讨论后进行）

1. **配置模型** → 全局 `mcp_servers` 表 + `agents.mcpServerIds` 引用。define-once-reuse、密钥集中、与 `toolNames` 一致;不用 per-agent 内联。
2. **`ask` 审批粒度** → **per-tool-per-conversation**(见 §6.2):首次调用某工具弹审批,本会话内记住。兼顾安全与可用(每次问太吵、整 server 批太粗)。
3. **custom 是否首版做** → **否**。首版只上 **P0(claude-code/codex 接线 + 数据模型 + UI)**;custom 的 MCP 客户端(P1)等 P0 跑通、安全模型经实践验证后再投入——它成本高、且最受「沙箱被绕过」影响。
4. **stdio 命令白名单** → **不做硬白名单**(MCP server 命令五花八门,枚举不现实)。改为登记时**完整展示 command/args/env** + 要求显式「我信任此 server」确认 + 明确警告「它在沙箱外、以 app 权限运行」。本地单用户场景下「用户登记 = 知情同意」(等价于自己在终端跑),符合 §5.4 不过度加固的取向。
5. **密钥脱敏** → headers/env 密钥**存 DB**(同 `app_settings`,不引 keychain,§5.4);UI **脱敏显示**(只露后几位,列表接口不回明文);并支持值里写 `${ENV_NAME}` 占位以引用 `.env.local`(免在 DB 存明文)。MCP 密钥是 per-server 维度,**不**套用 LLM 的三层 key 优先级。

---

## 12. 实现记录与偏差(2026-10-09)

P0 落地时对着工作树逐条核查,发现原稿有四处与代码事实不符。四条都已决策并记录,不留在代码里当惊喜。

### D1 — `trust` 审批门原本不存在(P0 前)

`bridgePermission`(`src/server/adapters/claude-code-adapter.ts`)的顺序是:① 路径沙箱 → ② Bash 黑名单 → ③ fs_write 审批 → ④ NotebookEdit → **⑤ 默认放行**。外部工具名 `mcp__<server>__<tool>` 不匹配 ①–④,直接落到 ⑤ —— 即**静默放行**。原稿把审批门放到 P2,等于 P0 会存一个 `trust='ask'` 却毫无作用。

**决定:审批门提前到 P0**(选项 B)。新增第 ⑤ 步之前的 `isExternalMcpTool` 分支:

- `trust='always'` → 放行;
- 本会话该工具已批准 → 放行;
- 否则弹审批卡片,结果通过 `mcp_tool.pending` / `mcp_tool.resolved` 传递;
- 名字解析不出 server(结构不合法)→ **拒绝**(失败关闭,而不是失败打开)。

批准记忆在 `src/server/mcp-approvals.ts`,**内存态、按 conversation 分桶、按工具名去重**,不落库;会话被删除时清理。dev server 重启 / HMR 会清空,代价只是重新弹一次。这与 `pendingWrites` / pending bash 的既有做法一致。

**已知边界(未修,记录在案)**:Claude Code adapter 以 `settingSources: ['project']` 启动,因此 workspace 里的 `.claude/settings.json` 若写了 `permissions.allow` 规则,可以在 CLI 侧先行放行 `mcp__*`,使 `canUseTool` 根本不被询问。这不是本特性引入的,而是项目级设置被加载的既有后果(同样的写法也能预放行 `Bash`)。缓解方向(去掉 `settingSources`,或把 `.claude/` 纳入写保护)属 P2。

### D2 — `transport` 增加 `http`

原稿只有 `stdio | sse`。实测 `codex mcp add --help`(Codex CLI 0.149.1)只给两种形态:`<COMMAND>...` 与 `--url`(streamable HTTP),**没有 SSE**。两值枚举要么把 Codex 困在 stdio,要么把 SSE server 错标成 Codex 可用。

**决定:枚举增加 `http`**,矩阵见 §5,前后端共用 `src/shared/mcp.ts` 一份。

### D3 — `buildChildProcessEnv` 不是白名单

见 §6.3。**决定:复用**,后果明确接受并写入文档与 UI 义务。

### D4 — `killProcessTree` 提为共享模块

原为 `src/server/tools/bash.ts` 的私有函数。MCP stdio 子进程清理也要用它,故提到 `src/server/child-process.ts`(`taskkill /F /T` on Windows,POSIX 负 pid 进程组)。纯搬运,无行为变更。

### 其他落地细节

- **`${ENV_NAME}` 占位在 run 启动时展开**,不在写入时:DB 只存占位文本,`.env.local` 改了立刻生效,且明文密钥不落库。变量缺失时**带变量名抛错**,让坏 server 在 spawn 前被诊断出来。
- **MCP 密钥读接口一律脱敏**:`env` / `headers` 只返回 `{ masked: '••••abcd' }` 或 `{ placeholder: 'NAME' }`;更新走**合并**语义(省略=不动,字面=覆盖,`null`=清除)。前端编辑表单**不回填**脱敏预览,避免「改个名字」把密钥写成 `••••abcd`。
- **`mcpServerIds` 与 `toolNames` 的规则不同**:SDK adapter 下 `toolNames` 会被强制清空(内置工具集才是它们的工具来源),`mcpServerIds` **必须保留** —— 那正是 SDK agent 拿到用户自选工具的唯一途径。`agent-service.ts` 里这条处理刻意放在 custom/SDK 分支**之外**。
- **server 名校验**除 `^[a-z0-9_]+$` 外**禁止包含 `__`**:工具名分隔符是 `__`,名字里带它会破坏 `mcp__<server>__<tool>` 的解析。
- **Codex 的配置翻译**:SDK 的 `config` 是自由格式,会被拍平成点号 TOML(`-c mcp_servers.<n>.command=...`)。**值为 `null` 会抛**,所以可选字段(`env` / `headers`)必须缺省而不是传 `null`。Codex 靠 `command` / `url` 的存在推断传输方式,没有 `type` 字段。
- **Codex 的 `config.mcp_servers` 写的是 AgentHub 隔离的 `CODEX_HOME`**,不碰用户本机 `~/.codex/config.toml`(spec 05 / CLAUDE.md §5.4)。

### D5 — 「测试连接」超时从 15s 提到 60s（回归验证中发现并修掉）

对着真实 stdio server 跑 `POST /api/mcp-servers/:id/test` 时暴露:登记里最常见的形态是 `npx -y <pkg>`,**冷缓存下首次探测要先下载包**,实测轻松超过 15s。于是 15s 会把一个完全正确的配置报成 `{ ok:false, error:'timed out after 15000ms' }` —— 假故障,而且正好落在最常用的路径上。

**改为 60s**,并把错误文案带上阶段(`... while connecting` / `... while listing tools`),便于区分「连不上」和「连上了但不答 `tools/list`」。这是用户显式点按钮触发的探测,60s 的等待可接受;`testMcpServerConnection` 只在设置面板手动调用,不在 run 路径上。

### 已实测（无模型参与的 API 级验证,2026-10-09）

对真实 stdio server(`npx -y @modelcontextprotocol/server-filesystem`)经 HTTP API 走通:登记 → 启用 → 列表 → 改 → 删;`test` 返回 `ok:true` + 14 个工具名;坏配置返回 `{ok:false,error}` 且 HTTP 200(不 500);探测结束**无孤儿 `server-filesystem` 子进程**;密钥读接口不回明文,且「只改名字」的 PATCH 之后库里密钥原样保留;非 ASCII 路径在 JSON body 里往返无损;`${ENV_NAME}` 落库为占位文本。

### 已实测（真模型参与,2026-10-10）

用 claude-code adapter(`claude-sonnet-4-6`,经中转)对一个自建 stdio server 跑通:工具以 `mcp__<server>__<tool>` 出现在模型工具表里(`mcp__agenthub__*` 8 个 bridge 工具 + `mcp__mcpv__{add,boom,echo,slow}`);`agenthub` bridge 的 `write_artifact` / `ask_user` 均无回归,且**不经过**外部工具审批门;停用 / 未勾选 / 起不来的 server 都不在工具表里;run 中止时 stdio 子进程被回收(子进程侧日志证明工具确实执行中,中止后 ~6s 内停止,无孤儿进程);`trust='ask'` 首次弹审批、批准后同会话同工具不再弹、新会话重新弹;`trust='always'` 直接执行不弹;拒绝后模型收到 `isError` 结果且 run 正常结束。

**两处未达预期**(均非本次改动引入,详见 `openspec/changes/add-external-mcp/tasks.md` §9 Findings):

1. **工具卡片渲染后消失。** `part.start` 按 `partIndex` 赋值,而 `tool.call` / `tool.result` 是另一条 `push` 路径写入**同一个** `parts` 数组,两者共用一套索引但不互通 —— 模型在工具调用**之后**输出的 text 会覆盖掉工具调用占的那个槽位(服务端 `agent-runner.ts:1688` 与前端 `app-store.ts:680` 对称)。于是持久化结果恒为 `["text","tool_result"]`,而 UI 把孤立的 `tool_result` 丢弃,卡片在 run 进行中可见、text 一到就消失。这是 claude-code adapter 下**所有**工具调用的既有缺陷,与外部 MCP 无关。**后续(2026-10-12)**:已由 `openspec/changes/fix-part-index-collision/` 修复 —— 索引分配权收归 AgentRunner,不再由适配器自报序号;已落库的旧消息不回填(丢失的 `toolName` / `args` 无法重建)。
2. **spawn 失败没有任何提示(9.7 只算半个)。** `resolveMcpServersForAgent` 只对**解析**阶段的失败告警;`command` 不存在这类问题能通过解析、到 SDK spawn 时才失败,而这条路径 AgentHub 完全不上报 —— 用户看到的是「server 已启用、已勾选、就是没有」,且没有任何解释。run 本身不失败这一点成立。
