# Spec 08 — 数据库 Schema

> Drizzle ORM + SQLite。本 spec 描述 10 张表的字段、索引、外键级联策略，是 Spec 01 实体的物理映射。**修改字段需先讨论。**
>
> 7 张「业务表」（agents / conversations / messages / artifacts / workspaces / attachments / agent_runs）映射 Spec 01 的 7 个实体；`conversation_context_summaries` 是上下文压缩基础设施表；`app_settings` 是单行配置表；`mcp_servers` 是外部 MCP server 登记表，均不对应实体。

源文件：`src/db/schema.ts`

---

## 设计原则

1. **SQLite 本地文件数据库**，单进程读写，文件位于 `.agenthub-data/agenthub.db`（gitignored）
2. **timestamps 用 `INTEGER` 存 unix ms**（不用 ISO 字符串，省存储 + 比较快）
3. **结构化列用 JSON 文本**（drizzle 的 `text(..., { mode: 'json' })`）。SQLite 不支持原生 JSON 列约束，依赖应用层 zod / 类型校验
4. **boolean 用 `INTEGER 0/1`**（drizzle `mode: 'boolean'`）
5. **外键 + cascade**：会话是 aggregate root，删除时级联清掉 messages / artifacts / workspaces / attachments / agent_runs / conversation_context_summaries
6. **不引入复合主键 / 多列唯一约束**（除 workspaces 的 unique conversationId），关系通过 ID 字段维护

---

## 1. agents

```ts
agents {
  id              text PK           // ag_<nanoid>
  name            text NOT NULL
  avatar          text NOT NULL     // emoji 字面量 or URL
  description     text NOT NULL
  capabilities    text JSON         // string[]
  system_prompt   text NOT NULL
  adapter_name    text NOT NULL     // 'claude-code'|'codex'|'custom'|'mock'
  model_provider  text              // 仅 adapter_name='custom' 时填
  model_id        text              // 同上
  api_key         text              // 该 agent 单独的 key；NULL 走 env
  api_base_url    text              // 该 agent 单独的 endpoint；NULL 走 SDK 默认
  tool_names      text JSON         // string[]，引用 Spec 07
  mcp_server_ids  text JSON NOT NULL default '[]'  // string[]，引用的外部 MCP server id（Spec 15）
  is_builtin      int  bool default 0
  is_orchestrator int  bool default 0
  supports_vision int  bool default 0
  created_at      int  NOT NULL
}
```

**约束**：
- `adapter_name='custom'` 时 `model_provider` + `model_id` 必填；`adapter_name='claude-code' | 'codex'` 时 `model_provider=NULL`，`model_id` 可选
- `is_builtin=1` 的 agent 可修改、不可删除（service 层 enforce）
- `api_key` 优先级高于 env var；按 provider / adapter 路由：`deepseek→DEEPSEEK_API_KEY` / `openai→OPENAI_API_KEY` / `volcano-ark→ARK_API_KEY` / `anthropic→ANTHROPIC_API_KEY` / `codex→CODEX_API_KEY 或 OPENAI_API_KEY` / `openai-compatible→per-agent only`
- `api_base_url` 非空时（Claude Code adapter），`api_key` 作为 `ANTHROPIC_AUTH_TOKEN` 传 SDK；`ANTHROPIC_BASE_URL` 设为 `api_base_url`；同时清空 `ANTHROPIC_API_KEY` 防覆盖（详见 Spec 05 ClaudeCodeAdapter）
- `api_base_url` 非空时（Codex adapter），作为 `@openai/codex-sdk` 的 `baseUrl` 传入；`api_key` 作为 SDK `apiKey`（内部 `CODEX_API_KEY`）传入；endpoint 必须支持 Codex/Responses，DeepSeek 等 Chat Completions-only endpoint 走 Custom adapter
- `model_provider='openai-compatible'` 时（Custom adapter），`api_key` 与 `api_base_url` 必填；`api_base_url` 作为 OpenAI SDK `baseURL` 传入，endpoint 必须支持 Chat Completions
- `mcp_server_ids` 与 `tool_names` 规则不同：`adapter_name='claude-code' | 'codex'` 时 `tool_names` 被强制清空（内置工具集才是它们的工具来源），但 `mcp_server_ids` **必须保留** —— 那正是 SDK agent 拿到用户自选外部工具的途径（Spec 15）。该字段默认 `'[]'`，与 `tool_names` 无关

**索引**：无（agent 数量小，全表扫描可接受）

---

## 2. conversations

```ts
conversations {
  id                       text PK           // conv_<nanoid>
  title                    text NOT NULL
  mode                     text NOT NULL     // 'single'|'group'
  agent_ids                text JSON         // string[]
  pinned_message_ids       text JSON         // string[]，default '[]'
  archived                 int  bool default 0
  fs_write_approval_mode   text NOT NULL default 'review'  // 'auto'|'review'，agent fs_write 审批策略
  created_at               int  NOT NULL
  updated_at               int  NOT NULL
}
INDEX idx_conv_updated ON (updated_at)
```

**约束**：
- `mode='single'` 时 `agent_ids.length === 1`，`group` 时 `>= 2`
- 群聊里 `is_orchestrator=1` 的 agent 最多 1 个（service 层 enforce）
- `fs_write_approval_mode`：详见 Spec 07「fs_write 审批模式」。人手编辑文件不走审批，只控制 agent
- `pinned_message_ids` 上限 5（`PIN_LIMIT_PER_CONVERSATION`，service 层 enforce）；toggle 时**不**更新 `updated_at`（pin 不算「会话活跃」）。UI 入口见 Spec 09

**索引说明**：`idx_conv_updated` 用于侧边栏「按最近活跃排序」列表。

---

## 3. messages

```ts
messages {
  id                  text PK           // msg_<nanoid> / msg_err_<nanoid>
  conversation_id     text NOT NULL  FK→conversations.id  ON DELETE CASCADE
  role                text NOT NULL     // 'user'|'agent'|'system'
  agent_id            text  FK→agents.id  (no cascade)
  parts               text JSON         // MessagePart[]，见 Spec 03
  status              text NOT NULL     // 'streaming'|'complete'|'error'|'aborted'
  parent_message_id   text              // 引用回复目标（同会话内自由引用，不建外键以容忍删除）
  mentioned_agent_ids text JSON         // string[]，default '[]'
  run_id              text              // 关联 agent_runs.id（不建外键，agent run 删除不影响消息保留）
  created_at          int  NOT NULL
}
INDEX idx_messages_conv_created ON (conversation_id, created_at)
```

**约束**：
- `role='agent'` 时 `agent_id` 必填
- `parts` 是数组，类型见 Spec 03（每种 part 的字段）

**特殊 ID 命名**：错误降级消息 ID 用 `msg_err_<nanoid>` 前缀（由 `AgentRunner.emitErrorVisualisation` 生成），便于日志区分。

**索引说明**：`idx_messages_conv_created` 是 hot path —— `MessageList` 拉取一个会话的全部消息按时间排。

---

## 4. artifacts

```ts
artifacts {
  id                  text PK           // art_<nanoid>
  conversation_id     text NOT NULL  FK→conversations.id  ON DELETE CASCADE
  type                text NOT NULL     // 'web_app'|'code_file'|'diff'|'document'|'image'|'ppt'|'project'
  title               text NOT NULL
  content             text JSON NOT NULL // ArtifactContent，见 Spec 04
  version             int  NOT NULL default 1
  parent_artifact_id  text              // 版本链（v2 引用 v1），不建外键
  created_by_agent_id text NOT NULL FK→agents.id
  created_at          int  NOT NULL
}
INDEX idx_artifacts_conv ON (conversation_id)
```

**索引说明**：`ArtifactLibrary` 列表 + 单会话 artifact 卡片渲染都走这个索引。

---

## 5. workspaces

```ts
workspaces {
  id              text PK              // ws_<nanoid>
  conversation_id text NOT NULL UNIQUE FK→conversations.id  ON DELETE CASCADE
  root_path       text NOT NULL        // 绝对路径，物理位于 .agenthub-data/workspaces/<conversationId>/
  mode            text NOT NULL default 'sandbox'  // 'sandbox' | 'local'
  bound_path      text                 // mode='local' 时填，绝对路径；sandbox 时为 null
  created_at      int  NOT NULL
}
```

**1:1 与 conversations**：`UNIQUE(conversation_id)` 保证。

**mode 语义**（详见 Spec 01 + Spec 07）：
- `sandbox`：bash / fs_read / fs_write 的 cwd 用 `root_path`（隔离目录），强制 100MB / 1000 文件配额
- `local`：cwd 用 `bound_path`（用户本机真实目录），不强制配额

**物理目录**：DB 行删除时 cascade 由 SQLite 处理；`root_path` 目录由 `conversation-service.deleteConversation` 手动 `rmSync(...)` 清除（容错：失败仅 warn）。`bound_path` 不删（那是用户的真实项目）。

---

## 6. attachments

```ts
attachments {
  id              text PK              // att_<nanoid>
  conversation_id text NOT NULL FK→conversations.id  ON DELETE CASCADE
  kind            text NOT NULL        // 'image'|'file'
  file_name       text NOT NULL
  file_path       text NOT NULL        // 相对 workspace.root_path，例如 'attachments/<id>-<filename>'
  size            int  NOT NULL
  mime_type       text NOT NULL
  created_at      int  NOT NULL
}
INDEX idx_attachments_conv ON (conversation_id)
```

**约束**：
- `file_path` 始终在 `workspace.rootPath` 子树内（防越权，由上传 handler enforce）
- 单会话上限：100MB / 1000 文件（详见 CLAUDE.md §5.3）

**与 Message 的关系**：发消息时把附件 ID 传给 `sendMessage`，service 把每个附件转成对应的 `image_attachment` / `file_attachment` MessagePart 塞到 message.parts 里（见 Spec 03）。附件本身不删除，可被多条消息引用。

---

## 7. agent_runs

```ts
agent_runs {
  id                  text PK           // run_<nanoid>
  conversation_id     text NOT NULL FK→conversations.id  ON DELETE CASCADE
  agent_id            text NOT NULL FK→agents.id
  trigger_message_id  text              // 可空：错误降级 run 没有触发消息
  status              text NOT NULL     // 'queued'|'running'|'complete'|'failed'|'aborted'
  error               text              // failed 时存错误概要
  parent_run_id       text              // Orchestrator 派出的子 run 指向父 run
  usage               text JSON         // RunUsage：{ inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, lastInputTokens?, model? }；null = 该 run 未上报（mock / 中途失败）
  started_at          int  NOT NULL
  finished_at         int               // null = 仍在 running
}
INDEX idx_runs_parent ON (parent_run_id)
```

**索引说明**：`idx_runs_parent` 用于 DispatchPlanCard 聚合子 run 状态（按 parent_run_id 拿子 run 列表）。

**生命周期**：`queued → running → (complete|failed|aborted)`，单向流转，service 层 enforce 不允许回退。

**进程重启收口**：runner 在进程内，进程退出后 `queued` / `running` 的 run 不可能再继续。`src/instrumentation.ts` 在 Node server 启动时把这类行改成 `failed`（`error` 说明是重启中断、`finished_at` 补当前时间），同时把仍是 `streaming` 的消息改成 `aborted`。不清理的话会话会永远显示「运行中」，删除会话 / 清空历史也会被 409 永久挡住。

---

## 8. conversation_context_summaries

```ts
conversation_context_summaries {
  id                       text PK           // ctx_<nanoid>
  conversation_id          text NOT NULL FK→conversations.id ON DELETE CASCADE
  summary                  text NOT NULL     // 压缩后的长期上下文摘要
  covered_until_message_id text NOT NULL     // 摘要覆盖到的最后一条 message
  covered_until_created_at int  NOT NULL     // 对应 message.created_at，查询候选消息时用
  source_message_count     int  NOT NULL     // 本次参与压缩的 message 数
  token_estimate           int  NOT NULL     // summary 粗略 token 估算
  model_provider           text              // 生成摘要的 provider；启发式 fallback 时为 NULL
  model_id                 text              // 生成摘要的模型；启发式 fallback 时为 NULL
  created_at               int  NOT NULL
}
INDEX idx_context_summaries_conv_created ON (conversation_id, created_at)
```

**语义**：该表是上下文基础设施，不是聊天记录。用户聊天原文仍完整保留在 `messages` 表；summary 只在 LLM 上下文注入时消费。多次 compact 时保留历史 summary 行，读取时默认只取同一 conversation 最新一条。

**覆盖范围**：`covered_until_created_at` 之前且非 pinned 的普通历史可由 summary 代表；pinned messages 仍按 Spec 13 永远注入原文占位版本。

**为什么不放进 messages**：summary 不是用户/agent 发言，混进聊天消息会污染会话时间线、撤回/编辑语义和未读逻辑。UI 需要反馈时由 service 额外写一条 `role='system'` 的提示消息，但真实可消费摘要仍以本表为准。

---

## 9. app_settings

```ts
app_settings {
  id                  text PK             // 固定 'singleton'，单行表
  anthropic_api_key   text                // Anthropic / Claude Code 用
  anthropic_base_url  text                // 第三方网关（anyrouter 等）；非空时 anthropic_api_key 作 AUTH_TOKEN
  openai_api_key      text                // OpenAI provider
  deepseek_api_key    text                // DeepSeek provider
  ark_api_key         text                // 火山方舟 provider
  companion_mode      text NOT NULL       // 'off' | 'lan' | 'tailnet'，默认 'off'
  mobile_device_token text                // 移动端 P0 设备 token；后续替换为 device_sessions
  deployment_publish_enabled int NOT NULL // boolean，默认 false
  deployment_publish_dir     text         // 外部静态发布目录，绝对路径
  deployment_public_base_url text         // 外部静态服务公开根 URL
  updated_at          int  NOT NULL
}
```

**为什么单行表**：本地单用户场景，全局只有一份 API 配置。建表是为了让用户走 UI 改而不是编辑 `.env.local`；用 KV 表会让每个 key 一行查询，反而麻烦。`id='singleton'` 是约定常量（`src/server/settings-service.ts:SINGLETON_ID`），insert / upsert 都走它。

**约束**：
- 所有字段可空。空 / 空串归一为 `NULL`（`settings-service.normalize` 处理）
- 与 `agents.api_key` / `agents.api_base_url` 不冲突：per-agent 字段优先级最高，本表是「全局兜底」
- **不**外键关联 agents（provider 与 agent 是多对多关系，agent 通过 `model_provider` / `adapter_name` 选 key）
- `deployment_publish_enabled=true` 只有在 `deployment_publish_dir` 与 `deployment_public_base_url` 均非空时才会让 `deploy_artifact` / `deploy_workspace` 尝试外部静态发布；否则仍只生成本地静态部署。

**Key 解析优先级**（详见 Spec 05「API key fallback」与 `agent-runner.ts:buildAdapterInput`）：

```
1. agents.api_key           — per-agent override（最高）
2. app_settings.<provider>  — 用户在设置面板自填
3. process.env.<PROVIDER>   — .env.local 兜底
4. ~/.claude/.credentials.json — 仅 Claude Code adapter 的 OAuth fallback；Codex adapter 默认使用 AgentHub 隔离的 `<dataDir>/codex-home`，不读取用户本机 `~/.codex`
```

`anthropic_base_url` 的解析同链：`agents.api_base_url` → `app_settings.anthropic_base_url` → `process.env.ANTHROPIC_BASE_URL` → SDK 默认。Codex 不读全局 base URL，只接受 per-agent `agents.api_base_url` 或 SDK 默认 endpoint，避免 CC Switch / 本机 `~/.codex` 配置影响 AgentHub。Custom `openai-compatible` 也不读全局 base URL，必须由 agent 自己携带 `api_base_url`。

**索引**：无（单行查询不需要）。

**桌面版（Electron）兼容**：本表是「全局 key」的唯一持久化点，**不**引入 keychain / safeStorage 等第三方存储，详见 CLAUDE.md §5.4 与 Spec 11。Electron 下 DB 文件位置改为 `app.getPath('userData')`，本表语义不变。

---

## 10. mcp_servers

用户登记的外部 MCP server。全局一张表，Agent 通过 `agents.mcp_server_ids` 引用（不内联到 agent）。字段与 `design.md §2` 一致。

```ts
mcp_servers {
  id          text PK               // mcp_<nanoid>
  name        text NOT NULL UNIQUE  // ^[a-z0-9_]+$，禁止含 '__'，保留名 agenthub；工具命名空间用
  transport   text NOT NULL         // 'stdio'|'sse'|'http'
  command     text                  // stdio：可执行命令
  args        text JSON NOT NULL default '[]'  // stdio：string[]
  env         text JSON             // stdio：Record<string,string> 附加环境变量，可含 ${ENV_NAME} 占位
  url         text                  // sse / http：端点
  headers     text JSON             // sse / http：Record<string,string> 静态请求头，可含 ${ENV_NAME} 占位
  trust       text NOT NULL default 'ask'     // 'always'|'ask'，Claude Code 与 custom adapter 实际拦截（Codex 不受此门约束）
  enabled     int  bool NOT NULL default 0    // 全局开关，默认 false
  created_at  int  NOT NULL
}
```

**约束**：
- `name` 唯一，匹配 `^[a-z0-9_]+$`，且**不得包含 `__`**（`__` 是工具名 `mcp__<server>__<tool>` 的分隔符）；`agenthub` 为保留名，登记时拒绝（`src/server/mcp-server-service.ts`）
- transport 与字段互斥：`stdio` 必须有 `command`、不得有 `url`；`sse` / `http` 必须有 `url`、不得有 `command`
- `enabled` 默认 **false** —— 生效要两道 opt-in：登记 + 启用（再加上 agent 勾选，见 Spec 15 §6.1）
- `env` / `headers` 里的密钥按 `app_settings` 同样的本地存储模型存**明文**（不引 keychain，CLAUDE.md §5.4），但**任何读接口只返回脱敏预览**（`{ masked }` 或 `{ placeholder }`），更新走**合并**语义（省略=不动，字面=覆盖，`null`=清除），详见 Spec 15 §12
- `env` / `headers` 值里的 `${ENV_NAME}` 占位在 **run 启动时**从进程环境展开，DB 只存占位文本
- 本表**不与任何业务表建外键**；`agents.mcp_server_ids` 是弱引用（与 `messages.agent_id` 同理），解析时找不到 / 已禁用的 id 直接跳过

**索引**：无（server 数量小，全表扫描可接受；`name` 的唯一约束自带索引）。

**迁移（spec 12 桌面版契约）**：`specs/12-desktop-electron.md` 要求新表 / 新列同时镜像到打包版运行的 `src/db/bootstrap.ts`：`DDL` 里加 `CREATE TABLE IF NOT EXISTS mcp_servers (...)`，老库上加 `safeAlter('ALTER TABLE agents ADD COLUMN mcp_server_ids TEXT NOT NULL DEFAULT \'[]\'')`。一次性补数据脚本为 `src/db/migrate-add-mcp-servers.ts`（沿用 `migrate-add-app-settings.ts` + `migrate-add-bookmarks.ts` 的 `IF NOT EXISTS` 可重入模式）。

---

## Cascade 关系图

```
conversations  ─── CASCADE ──┬─► messages
                             ├─► artifacts
                             ├─► workspaces  (1:1)
                             ├─► attachments
                             ├─► agent_runs
                             └─► conversation_context_summaries

agents ──(no cascade)──── messages.agent_id
                          artifacts.created_by_agent_id
                          agent_runs.agent_id

app_settings ──(独立，无外键)── 单行表，与任何业务表都无 FK 关系
mcp_servers  ──(独立，无外键)── 全局登记表；agents.mcp_server_ids 以 id 弱引用它（找不到 / 未启用即跳过）
```

**为什么 agents 不 cascade**：删除 agent 不应抹掉历史消息/产物（用户期望「已停用 agent」的灰态保留记录）。前端展示时检测 `agentId` 找不到 → 渲染 stub。

---

## JSON 列规范

所有 `text JSON` 列存的是 **trusted internal data**，由服务端写入，前端读出。不存任意用户输入；用户输入（message content / agent description）走单独的 text 列。

| 列 | 类型 | 说明 |
|---|---|---|
| `agents.capabilities` | `string[]` | 能力标签 |
| `agents.tool_names` | `string[]` | 引用 Spec 07 的工具名 |
| `agents.mcp_server_ids` | `string[]` | 该 agent 启用的外部 MCP server id（默认 `'[]'`，见 Spec 15） |
| `conversations.agent_ids` | `string[]` | 参与的 agent |
| `conversations.pinned_message_ids` | `string[]` | 用户 pin 的消息 |
| `messages.parts` | `MessagePart[]` | 见 Spec 03 |
| `messages.mentioned_agent_ids` | `string[]` | @ 的 agent |
| `artifacts.content` | `ArtifactContent` | 见 Spec 04，按 type 分发的可辨联合 |
| `mcp_servers.args` | `string[]` | stdio 参数 |
| `mcp_servers.env` | `Record<string,string>` | stdio 附加环境变量 |
| `mcp_servers.headers` | `Record<string,string>` | sse / http 静态请求头 |

**修改 JSON 列结构时**：旧数据按旧 schema 解析仍合法（向后兼容），否则需要写 migration 脚本（见下节）。

---

## 迁移规范

**开发期**：直接 `pnpm db:push` 让 drizzle-kit 推 schema 到 SQLite。**注意**：drizzle-kit 对带 FK 的列类型变更有时会失败（SQLite 限制），此时写一次性 ALTER TABLE 脚本，命名格式 `src/db/migrate-<topic>.ts`（如 `migrate-add-read-attachment.ts`），用 `tsx src/db/migrate-xxx.ts` 跑。这些脚本跑完不删除（留作历史 + 用 `IF NOT EXISTS` 可重入）。

> **实测（2026-10-09，排查外部 MCP 时）**：当前开发库上 `pnpm db:push` **跑不通，且与具体改动无关**。对数据库副本做 push 会：① 重建 `app_settings`（列序 / NOT NULL 表示差异）；② 重建 `mcp_servers`（表级 `UNIQUE` vs drizzle 的独立唯一索引，两者等价但 drizzle 认作差异）；③ 同一索引重复生成两次 `CREATE INDEX`；最后死在 `SqliteError: index idx_conv_updated already exists`。所以**本项目实际的 schema 落地路径是 `bootstrap.ts` DDL + `safeAlter` + 一次性 migrate 脚本**（也正是 spec 12 对打包版的硬要求），而不是 db:push。新增表 / 列时按这个路径走，不要去动 db:push 也不要对真实库直接 `push --force`（它会在重建表之后中途失败，留下半迁移的库）。

**生产期**：暂无（项目为本地运行）。如未来要 ship 给用户，应改用 drizzle-kit 的 generate + journal 模式。

---

## ID 前缀对照表

| 实体 | 前缀 | 例 |
|---|---|---|
| Agent | `ag_` | `ag_uQp4Vs8z` |
| Conversation | `conv_` | `conv_KbN6xq2L` |
| Message | `msg_` / `msg_err_` | `msg_xY3w...` |
| Artifact | `art_` | `art_OPbgvF9x` |
| Workspace | `ws_` | `ws_h7Ld...` |
| Attachment | `att_` | `att_qWeR...` |
| AgentRun | `run_` | `run_xT9m...` |
| ContextSummary | `ctx_` | `ctx_mN4p...` |
| ToolCall (内存中) | `call_` | `call_aBc...` |
| AppSettings | `'singleton'` | 不用 nanoid，固定字面量 |
| McpServer | `mcp_` | `mcp_xY3w...` |

ID 生成器统一在 `src/server/ids.ts`，nanoid 长度 12，URL-safe alphabet。`app_settings.id` 不走 nanoid，由 `settings-service.SINGLETON_ID` 直接写入。
