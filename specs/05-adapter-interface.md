# Spec 05 — AgentPlatformAdapter 接口

> 适配器层屏蔽不同 Agent 平台（Claude Code、Codex、自配置 Agent）的 API 差异，对上层提供统一的事件流。**修改接口需先讨论。**

源文件：`src/server/adapters/`

---

## 现状说明（先读这段）

| Adapter | 状态 |
|---|---|
| `MockAdapter` | ✅ 已实现，用于开发期不烧 token |
| `CustomAgentAdapter` | ✅ 已实现，覆盖 DeepSeek / OpenAI / 火山方舟 / per-agent OpenAI-compatible Base URL（OpenAI Chat Completions 兼容协议）与 Anthropic（Messages API，见下方「Anthropic Messages API 路径」） |
| `ClaudeCodeAdapter` | ✅ 已实现，基于 `@anthropic-ai/claude-agent-sdk` `query()` + `canUseTool` 审批桥 |
| `CodexAdapter` | ✅ 已实现，基于 `@openai/codex-sdk` `runStreamed()`；Review 模式只读，Auto 模式 workspace-write；自定义 Base URL 必须支持 Codex/Responses |

---

## 定位

```
应用层 (AgentRunner)
       │
       │ stream(input, signal) → AsyncIterable<StreamEvent>
       ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  ┌──────────────┐
│ ClaudeCode   │  │ Codex        │  │ CustomAgent      │  │ Mock         │
│ Adapter      │  │ Adapter      │  │ Adapter          │  │ Adapter      │
│ ✅ 已实现     │  │ ✅ 已实现     │  │ ✅ 已实现         │  │ ✅ 已实现     │
└──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  └──────┬───────┘
       │                 │                   │                    │
   @anthropic-ai/    @openai/           OpenAI SDK            预设脚本
   claude-agent-sdk  codex-sdk          (DeepSeek / 火山方舟 / OpenAI /
                    (Responses)         自定义 OpenAI-compatible
                                        均走 Chat Completions 兼容协议)
                                        + 自写 tool loop
```

**Adapter 的唯一职责**：把厂商 SDK 的输出翻译成 Spec 02 定义的 `StreamEvent`。

**Adapter 不做的事**：
- 不写数据库
- 不发 SSE
- 不持有跨调用的状态（除厂商 SDK 的 client 实例）

**Adapter 现状放宽的事**（与 CLAUDE.md §3.1 铁律有张力）：
- **直接 import `toolRegistry` 自跑 tool loop** —— CustomAgentAdapter 模块顶部 `import { toolRegistry } from '@/server/tools/registry'`，loop 内 `toolRegistry.execute(name, args, ctx)`。设计上工具执行属 L3，但代码现状是 Adapter 自调。本 spec 承认放宽，原因见下方「工具执行」一节

---

## 接口定义

```typescript
interface AgentPlatformAdapter {
  readonly name: AdapterName

  stream(
    input: AdapterInput,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent>
}

interface AdapterInput {
  agentId: string               // 用于事件 tag
  conversationId: string
  runId: string
  parentRunId?: string          // Orchestrator 派出的子 run

  prompt: string                // 已被外层拼好的完整 prompt（群聊场景含 XML 包装，详见 Spec 06）
  workspacePath: string         // 该会话的 workspace 绝对路径

  // 系统提示，AgentRunner 已注入 <workspace_info> 块。所有 adapter 共用
  systemPrompt: string

  // 该 agent 单独的 API key；null 时 adapter 走环境 / OAuth fallback
  apiKey: string | null

  // 当前 agent 可用的工具名。Custom adapter 用 toolRegistry.resolve(toolNames) 拿 ToolDef；
  // Claude Code / Codex adapter 忽略此字段（用 SDK 内置工具集）
  toolNames: string[]

  // 本 run 启用的外部 MCP server（详见 Spec 15）。已由 AgentRunner 在 L3 完成
  // DB 读取 + enabled 过滤 + ${ENV} 展开 —— adapter 只做形状翻译，不读 DB、不展开占位符。
  // 只有 Claude Code / Codex / custom 三个 adapter 消费；mock 不支持。
  mcpServers?: ResolvedMcpServer[]

  // 附件（用户上传的文件/图片）— 用于 multimodal 投递
  attachments?: Array<{
    id: string                  // att_<nanoid>
    fileName: string
    mimeType: string
    kind: 'image' | 'file'
    absPath: string             // 服务端绝对路径，Adapter 自读
  }>

  // 跨 run 对话历史（OpenAI ChatMessage 格式），不含当前触发消息。
  // 由 AgentRunner 通过 conversation-context.buildHistoryFor 序列化，详见 Spec 13。
  // - CustomAgentAdapter：拼到 [system, ...history, currentUser] 中间
  // - ClaudeCodeAdapter / CodexAdapter：忽略（走 SDK 自己的 session resume）
  // - MockAdapter：忽略
  history?: ChatCompletionMessageParam[]

  // 仅 CustomAgentAdapter 使用（OpenAI 兼容协议特有的模型选择）
  customConfig?: {
    modelProvider: 'anthropic' | 'openai' | 'deepseek' | 'volcano-ark' | 'openai-compatible'
    modelId: string
    supportsVision: boolean     // 决定是否把图片附件以 image_url block 投递给 LLM
  }
}
```

**变更点（与早期 spec 差异）**：
- `tools: ToolDef[]` → `toolNames: string[]`：避免把 handler 函数引用塞进 input；Adapter 用 `toolRegistry.resolve` 自查
- 新增 `attachments`：multimodal 路径
- 新增 `customConfig.modelProvider: 'volcano-ark'`：OpenAI-compat 接入
- 新增 `customConfig.modelProvider: 'openai-compatible'`：per-agent `apiBaseUrl` + `apiKey` 的通用 Chat Completions 兼容接入
- `systemPrompt` / `apiKey` 提升到根字段（不再嵌 `customConfig`）：所有 adapter 都需要，ClaudeCodeAdapter 也读这两个
- 新增 `customConfig.apiKey`：per-agent API key（优先级高于 env，见 Spec 08）
- 新增 `customConfig.supportsVision`：决定是否把图片以 multimodal 投递
- 新增 `parentRunId`：Orchestrator 子 run 的父引用
- 新增 `mcpServers`：外部 MCP server（run 内已解析的 `ResolvedMcpServer[]`，详见 Spec 15 与下方「外部 MCP server 接线」一节）

---

## CustomAgentAdapter

源文件：`src/server/adapters/custom-agent-adapter.ts`

最复杂的 adapter：自己实现 tool loop，覆盖 DeepSeek / OpenAI / 火山方舟 / 通用 OpenAI-compatible provider（走 Chat Completions）与 Anthropic（走 Messages API）。

### 高层流程

```
1. buildClient(provider, apiKey, apiBaseUrl) → 客户端
   apiKey 来自 AdapterInput.apiKey（已由 AgentRunner 按四层链解析，
   见下方顶级章节「API key 解析（共四层）」）。
   provider → 客户端映射：
     deepseek    → OpenAI 兼容，https://api.deepseek.com/v1
     volcano-ark → OpenAI 兼容，https://ark.cn-beijing.volces.com/api/v3
     openai      → OpenAI 兼容，SDK 默认 endpoint
     openai-compatible → OpenAI 兼容，agent.apiBaseUrl（必填）
     anthropic   → @anthropic-ai/sdk Messages API，默认 endpoint；
                   agent.apiBaseUrl 可指向 Anthropic 兼容网关
   
2. 外部 MCP（`AdapterInput.mcpServers` 非空时，见「外部 MCP server 接线」）:
   custom 自己创建 MCP client（`@modelcontextprotocol/sdk`）:
     - 每个 server 并行 connect + listTools（各自 30s 超时）
     - 失败的 server 跳过，发 mcp_server.unavailable，run 继续
     - 工具暴露为 mcp__<server>__<tool>，清洗到 OpenAI function name
       约束 `^[A-Za-z0-9_-]{1,64}$`；路由用运行期 Map，不反解析名字
     - 合并进下面的 tools 数组；与内置工具重名时内置优先
   
3. 初始化 messages:
   [
     { role: 'system', content: customConfig.systemPrompt },
     { role: 'user',   content: buildMultimodalUserContent(prompt, attachments) },
   ]
   
   buildMultimodalUserContent: 
     - supportsVision=true 且有图片附件：用 OpenAI content blocks 数组
       [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:<mime>;base64,...' } }, ...]
     - 否则纯文本字符串
   
4. tool loop（最多 MAX_TURNS=8 轮）:
   每轮：
     yield message.start (新 partIndex 重置)
     client.chat.completions.create({ model, messages, tools, stream: true })
     for await chunk:
       - delta.content → text part
       - delta.reasoning_content → thinking part (DeepSeek 思维链)
       - delta.tool_calls → 累积 tool_calls
     yield message.end
     
     若无 tool_calls：跳出循环
     若有 tool_calls：
       内置工具 → 并行 toolRegistry.execute(name, args, ctx)
       外部工具 → 审批门（trust='ask' 且本会话未批准 → 等审批）→ client.callTool(120s)
       逐个 yield tool.result（外部调用失败 / 超时 / 被拒 → isError，loop 继续）
        write_artifact 检测 result.value.artifactId 存在 → yield artifact.create (拉 DB 详情)
        deploy_artifact / deploy_workspace 检测 DeployStatusRecord → yield deploy.status
       把 assistant 消息（含 tool_calls + reasoning_content）和 tool result 推回 messages
       继续下一轮

5. 清理（finally，覆盖正常结束 / abort / 抛错）:
   close 所有 MCP client；stdio 先按 pid 杀进程树（killProcessTreeByPid）
```

### Reasoning 内容（DeepSeek thinking mode）

DeepSeek 等支持思考链的模型在 stream 中会单独输出 `delta.reasoning_content`。Adapter 处理：

1. 第一次见到 reasoning_content 时 emit `part.start` (type='thinking', content='')
2. 后续累积到 `reasoningBuffer`，emit `part.delta` (type='thinking.append')
3. **关键**：assistant 消息推回 messages 时必须带上 `reasoning_content` 字段，否则 DeepSeek 会报：

> `400 The reasoning_content in the thinking mode must be passed back to the API.`

这是 DeepSeek 特殊协议要求；其它 provider 忽略此字段。

### Multimodal

`buildMultimodalUserContent`（`custom-agent-adapter.ts:337-358`）：

- agent `supportsVision=true` 且 attachments 含 `kind='image'`：把 prompt 包成 OpenAI content blocks 数组，图片走 `image_url` block（base64 data URI），mimeType 来自 attachment row
- agent `supportsVision=false` 或无图片：纯文本字符串（沿用 OpenAI legacy 单字符串 content）

DeepSeek 的多模态模型（`deepseek-v4-flash`）走标准 OpenAI image_url 协议。

### Anthropic Messages API 路径

`provider === 'anthropic'` 时不走 OpenAI client，而是 `runAnthropicToolLoop`（`@anthropic-ai/sdk` 的 `messages.stream`）：

- system prompt 走顶层 `system` 字段；历史（OpenAI ChatMessage）经 `toAnthropicMessages` 只保留 user / assistant 文本，丢弃 system / tool，合并连续同角色，并丢弃开头孤立的 assistant 消息。
- 工具声明为 `{ name, description, input_schema }`；流式事件 `content_block_start/delta/stop` 映射到现有 `part.start` / `part.delta` / `part.end`（text / thinking）。
- 工具调用从 `tool_use` block 的 `partial_json` 累加解析；执行后以 `tool_result` block（`tool_use_id` + JSON 字符串，失败带 `is_error`）回传，继续下一轮。
- `max_tokens` 固定 8192（Agent 实体暂无该字段）；usage 记录 `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`。
- 图片附件只发送 Anthropic 支持的 `image/jpeg|png|gif|webp`；key 回退顺序 `agent.apiKey → ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN`。
- 外部 MCP 工具与 OpenAI 路径共用同一份工具表与执行器（`runToolCall`），审批门行为不变。

### Artifact / Deploy 注入路径

不在 Adapter 自己发 `artifact_ref` / `deploy_status` part。流程：

1. Adapter 检测 `tool_result.value.artifactId` 非空 → `yield { type: 'artifact.create', artifact: <DB row> }`
2. AgentRunner 接到 `artifact.create` 事件 → 在当前 message 末尾插入 `artifact_ref` part 并补发 `part.start`
3. Adapter 检测 `DeployStatusRecord`（来自 `deploy_artifact` / `deploy_workspace`）→ `yield { type:'deploy.status', messageId, deployment }`
4. AgentRunner 接到 `deploy.status` → 插入 `deploy_status` part 并补发 `part.start`
5. 这样 message.parts 里 tool_use → tool_result → artifact_ref / deploy_status 顺序排列，前端按 callId 合并工具卡片，其它结构化 part 单独渲染为卡片

详见 Spec 02 的「artifact_ref / deploy_status 注入路径」一节。

---

## 工具执行：Adapter 与 Runner 的边界

源文件：`src/server/adapters/custom-agent-adapter.ts:47`

```typescript
import { toolRegistry } from '@/server/tools/registry'
// ...
const result = await toolRegistry.execute(name, args, ctx)
```

**为什么放宽 §3.1 铁律**：

| 方案 | 描述 | 取舍 |
|---|---|---|
| **A. Adapter 自调 toolRegistry**（现状） | 模块顶部 import，loop 中直接 execute | 代码简单；Adapter 多一个依赖 |
| **B. Adapter 只 yield 事件，Runner 执行后注入** | Adapter 必须支持「暂停-等待 result-继续」 | 干净；async iterator 双向通信复杂 |

---

## Token usage 采集

所有 adapter 在 run 结束前 yield 一次 `run.usage` 事件（见 Spec 02），AgentRunner 收到后写入 `agent_runs.usage` JSON 列（见 Spec 08）。

| Adapter | usage 来源 |
|---|---|
| `ClaudeCodeAdapter` | `SDKResultMessage.usage`（success / error 都有）+ `modelUsage` 拿实际模型 id |
| `CodexAdapter` | `runStreamed()` 的 `turn.completed.usage` |
| `CustomAgentAdapter` | 调用时设 `stream_options: { include_usage: true }`，stream 末尾会有一个携 `usage` 的特殊 chunk；跨 turn 累加（一个 run 内可能 ≤ MAX_TURNS=8 次 chat.completions.create） |
| `MockAdapter` | 不上报 usage（agent_runs.usage = null） |

**字段映射**（OpenAI 协议 → 我们的 `RunUsage`）：
- `prompt_tokens` → `inputTokens`
- `completion_tokens` → `outputTokens`
- `prompt_cache_hit_tokens` (DeepSeek) / `cached_tokens` (OpenAI) → `cacheReadTokens`
- DeepSeek 不报 cache_creation；保持 0

**字段映射**（Anthropic SDK → 我们的 `RunUsage`）：
- `input_tokens` → `inputTokens`
- `output_tokens` → `outputTokens`
- `cache_creation_input_tokens` → `cacheCreationTokens`
- `cache_read_input_tokens` → `cacheReadTokens`

`lastInputTokens` 取本次 run 的 input prompt 长度，UI 用作「当前 context 大小」仪表。`model` 字段记录实际使用模型，按模型聚合用。

仅记 token 数量，**不算成本**（不同 provider / 第三方网关价格差异大，价格表难维护准确）。Cache hit 数量本身就足够看出节约程度。


方案 A 已落地。本 spec 承认放宽 —— Adapter **可以**调用 `toolRegistry`，但仍不**直接写 DB / 发 SSE**。Runner 仍是唯一的「event → 持久化 + 广播」入口。

如果未来要重新隔离（比如要给 Adapter 跑在 worker thread / 子进程），再切方案 B。

---

## MockAdapter

源文件：`src/server/adapters/mock-adapter.ts`

不调用任何 LLM，按输入特征选择脚本吐事件流。四条路径：

| 触发条件 | 行为 |
|---|---|
| `toolNames` 含 `plan_tasks` | **PLAN 阶段**：从 plan system prompt 的「## 可用 Agent」列表解析真实 agentId，发一条 `plan_tasks` tool.call（`taskKind: 'doc'`，避免命中 code 任务的验证命令门禁）。发完即结束 —— `tool.result` / `message.end` 由 AgentRunner 拦截后补齐 |
| `systemPrompt` 含聚合阶段标记 | **AGGREGATE 阶段**：只发一条总结文本 |
| `toolNames` 含 `report_task_result` | **子任务**：发文本 + 一次 `report_task_result`（status=complete），满足子任务完成门禁 |
| 其它 | **普通 run**：按 prompt 关键词选脚本（问候 / 代码 / 工具演示 / **产物**） |

**产物场景**：prompt 命中 `产物|artifact|ppt|幻灯片` **且** 该 agent 的 `tool_names` 含 `write_artifact` 时，脚本里的 `tool_exec` 步骤会经 `toolRegistry` 真调 `write_artifact` —— 产物真落库，再发 `artifact.create`，所以消息里会出现可预览 / 可导出的产物卡片（与 CustomAgentAdapter 同一约定）。没有该工具的 agent 不会冒充能产出产物。

**用途**：开发期不烧 token、单元测试、演示环境备份、Playwright E2E 的确定性假 agent（`e2e/artifacts.spec.ts`、`e2e/dispatch.spec.ts`）。普通脚本仍是纯文本，只有 `tool_exec` 步骤有副作用。

---

## API key 解析（共四层）

所有 adapter 走同一套 key 解析链，由 `AgentRunner.buildAdapterInput`（`src/server/agent-runner.ts`）执行。Adapter 只看 `AdapterInput.apiKey` 一个字段，不关心来源。

```
1. agents.api_key                   per-agent override（最高优先级）
2. app_settings.<provider>          用户在「设置」面板自填（Spec 08 §8）
3. process.env.<PROVIDER>_API_KEY   .env.local 兜底（dev / CI）
4. ~/.claude/.credentials.json      仅 ClaudeCodeAdapter，SDK 内部读 OAuth
```

**Provider 字段映射**（用于第 2 / 3 层选具体字段）：

| agent.adapterName | agent.modelProvider | app_settings 字段 | env var |
|---|---|---|---|
| `claude-code` | — | `anthropicApiKey` | `ANTHROPIC_API_KEY` |
| `codex` | — | `openaiApiKey` | `CODEX_API_KEY` → `OPENAI_API_KEY` |
| `custom` | `anthropic` | `anthropicApiKey` | `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` |
| `custom` | `openai` | `openaiApiKey` | `OPENAI_API_KEY` |
| `custom` | `deepseek` | `deepseekApiKey` | `DEEPSEEK_API_KEY` |
| `custom` | `volcano-ark` | `arkApiKey` | `ARK_API_KEY` |
| `custom` | `openai-compatible` | —（per-agent only） | — |

**`apiBaseUrl` 按 adapter 分协议**：
- Claude Code：`agent.apiBaseUrl` → `app_settings.anthropicBaseUrl` → `process.env.ANTHROPIC_BASE_URL` → SDK 默认。非空时 ClaudeCodeAdapter 改用 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` env 注入（详见 Spec 01 §agents）。
- Codex：只使用 `agent.apiBaseUrl` → SDK 默认，不读 CC Switch / `~/.codex/config.toml` / 全局 Codex base URL。非空时必须是 Codex/Responses 兼容 endpoint；DeepSeek 等 Chat Completions-only endpoint 会在运行前被拒绝。
- Custom：命名 provider 使用 adapter 内置默认 base URL；`anthropic` 允许 per-agent `apiBaseUrl` 指向 Messages API 兼容网关；`openai-compatible` provider 必须使用 per-agent `apiBaseUrl`，该 URL 必须是 OpenAI Chat Completions 兼容 endpoint，不是 Codex/Responses endpoint。

**优化点**：`buildAdapterInput` 只在 `agent.apiKey` 为空（或 Claude Code agent 的 `apiBaseUrl` 也为空）时才查 `app_settings`，避免每次构造 input 都打 DB。

**Adapter 视角**：
- **ClaudeCodeAdapter**：把 `input.apiKey` 通过 `options.env.ANTHROPIC_API_KEY` 传 SDK 子进程；为空时落到第 4 层 OAuth
- **CodexAdapter**：把 `input.apiKey` 通过 SDK `apiKey` 注入 `CODEX_API_KEY`；默认使用 AgentHub 隔离的 `CODEX_HOME`，不读取用户本机 `~/.codex`。`baseUrl` 对应 Codex runtime 的 `openai_base_url`，要求后端支持 `/responses`
- **CustomAgentAdapter**：命名 provider 把 `input.apiKey` 传 `new OpenAI({ apiKey })` 或 provider 默认 `baseURL`；`openai-compatible` 传 `new OpenAI({ apiKey, baseURL: input.apiBaseUrl })`，缺 key/base URL 时在调用上游前抛清晰错误
- **MockAdapter**：忽略

**用户什么都不配，本机装过 Claude Code 并 login 过就能直接用**（第 4 层兜底）。

---

## ClaudeCodeAdapter

源文件：`src/server/adapters/claude-code-adapter.ts`

封装 `@anthropic-ai/claude-agent-sdk` 的 `query()` API。SDK 自身就是 Claude Code CLI 的底层（同一 codebase 拆出的库），所以 ClaudeCodeAdapter 等价于把整个 Claude Code 接进来当一个 AgentHub agent。

```typescript
import { AbortError, query, type Options } from '@anthropic-ai/claude-agent-sdk'
import { pendingWrites } from '@/server/pending-writes'
import { findBannedPattern } from '@/server/security'
import { assertPathWithinWorkspace, getEffectiveCwd } from '@/server/workspace-utils'

class ClaudeCodeAdapter implements AgentPlatformAdapter {
  readonly name = 'claude-code' as const
  async *stream(input, signal) {
    const controller = new AbortController()
    signal.addEventListener('abort', () => controller.abort(), { once: true })

    // 本次 run 实际提供的工具名，由 init 消息填入；canUseTool 用它识别 shell 工具
    let sdkToolNames: string[] | null = null

    const options: Options = {
      cwd: getEffectiveCwd(workspace),
      abortController: controller,
      model: input.customConfig?.modelId ?? 'claude-opus-4-7',
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: composeSystemPrompt(input.systemPrompt, memory), // ← 见「项目记忆」
      },
      tools: { type: 'preset', preset: 'claude_code' },
      mcpServers: { agenthub: agenthubMcpServer, ...toSdkMcpServers(input.mcpServers) },
      includePartialMessages: true,
      settingSources: [],        // 隔离 mode：不读任何**文件系统**设置源 —— workspace 的
                                 // .claude/settings.json（permissions.allow 会先于 canUseTool
                                 // 求值）、项目 hooks、plugins / skills / 自定义命令。
                                 // managed / policy 层仍读盘，企业 deny 规则保留
      strictMcpConfig: true,     // MCP server 只来自上面的 mcpServers，忽略 workspace 的 .mcp.json
      permissionMode: 'default', // 自己 canUseTool 接管
      env: input.apiKey ? { ...process.env, ANTHROPIC_API_KEY: input.apiKey } : process.env,
      // 注意：这里的对象字面量在「每次工具调用时」求值，所以 sdkToolNames 读到的是
      // init 之后的当前值，而不是 options 创建时的 null
      canUseTool: (toolName, toolInput) =>
        bridgePermission(toolName, toolInput, { sdkToolNames, workspace, input }), // ↓ 见下方
    }

    const q = query({ prompt: input.prompt, options })
    for await (const m of q) {
      // init 携带 session_id 与本次 run 的工具表（shell 工具识别依赖后者）
      if (m.type === 'system' && m.subtype === 'init') sdkToolNames = m.tools
      // 翻译 SDKMessage → StreamEvent
    }
  }
}
```

### 事件翻译

| SDK 消息 | 对应 StreamEvent |
|---|---|
| `SDKSystemMessage subtype:'init'` | 读取 `session_id`（resume）、`tools`（本次 run 的工具表，供 shell 工具识别）与 `mcp_servers`（外部 server 连接状态）；仅当外部 server 报 `failed` / `needs-auth` / `disabled` 时 emit `mcp_server.unavailable`（详见 Spec 15） |
| `SDKPartialAssistantMessage` (开 `includePartialMessages: true`) `content_block_delta + text_delta` | 第一次开 text part：`part.start({type:'text',content:''})`；后续：`part.delta({type:'text.append',text})` |
| `SDKAssistantMessage.message.content` 里的 `text` 块 | 兜底：若 partial 没投递过，整段开一个 text part |
| `SDKAssistantMessage.message.content` 里的 `tool_use` 块 | `tool.call({callId,toolName,args})`；本地 `Map<sdk_id, ourCallId>` 记账 |
| `SDKUserMessage.message.content` 里的 `tool_result` 块 | 用 `Map` 查回 `callId`，`tool.result({callId,result,isError})` |
| `SDKResultMessage` (success / error variants) | 跳出 for-await，最后 emit `message.end` |
| 其他（task progress / hook events / status / notification） | 忽略（MVP） |

`message.start` / `message.end` 由 adapter 自己起止；`run.start` / `run.end` 仍由 AgentRunner 包外发。

### canUseTool 桥（审批 / 沙箱 / 黑名单）

SDK 提供 `canUseTool(toolName, toolInput, options) => PermissionResult` 钩子，每次工具调用前回调。AgentHub 在这里集中处理所有安全策略：

> ⚠️ **这条桥成立的前提是上面的 `settingSources: []`。** CLI 先求值项目设置里的 `permissions.allow`，命中就不再回调 `canUseTool` —— 把 `'project'` 加回去，下面每一条策略都能被 workspace 里一个 JSON 文件绕过（Bash 审批门、外部 MCP 的 `trust='ask'` 门都在其中）。改动本行必须同时改「项目记忆」一节与 `specs/11-platform.md`「SDK 子进程不加载项目设置」。

> ⚠️ **shell 工具不能按 `Bash` 字面量识别。** 工具名由 SDK 按平台提供：POSIX 上是 `Bash`，Windows 上实测是 `PowerShell`（2026-10-18）。按字面量匹配会让第 2 步整个跳过，命令直接落到第 6 步的默认 allow —— 黑名单与审批分类器都不再被咨询。识别规则：`mcp__*` 排除；已知 shell 名直接命中；否则，若工具出现在本次 run 的 `tools` 表里且输入带非空 `command`，按 shell 处理；工具表尚未到达时按「带 `command` 即 shell」失败关闭。已知 shell 名但输入解析不出 `command` → deny，不 allow。

1. **路径沙箱**（Read / Write / Edit / NotebookEdit）：`assertPathWithinWorkspace(workspace, toolInput.file_path)`，越界 `{ behavior: 'deny', message }`
2. **shell 黑名单与关键命令审批**（POSIX `Bash`、Windows `PowerShell` 等）：`findBannedPattern(toolInput.command)` 命中 deny；未命中但 `classifyBashApproval(toolInput.command)` 命中时，注册 `PendingBashCommand` 并等待用户批准；通过后 allow（cwd 已限定）
3. **fs_write 审批**（Write / Edit；Auto 模式直接 allow）：
   - `oldContent = readIfExists(workspace, path)`
   - `newContent = computeNewContent(...)` —— Write 取 `content`；Edit 用 `oldContent.split(old_string).join(new_string)` 计算应用后文件（`replace_all=false` 时要求 1 次匹配，跟 SDK 行为对齐）
   - `pendingWrites.register({ ..., skipWrite: true })` —— **关键**：传 `skipWrite: true`，approve 时 store 不调 `writeFileInWorkspace`，让 SDK 自己写
   - `await new Promise(resolve => pendingWrites.attachResolver(pending.id, resolve))` 阻塞等用户决定
   - applied → `{ behavior: 'allow' }`；rejected → `{ behavior: 'deny', message: 'User rejected the file change' }`
4. **NotebookEdit**：MVP 不做 diff 审批，Review 模式直接 deny；Auto 模式 allow
5. **其它工具**（Read / Grep / Glob / WebFetch / WebSearch / Task / TodoWrite / ...）：默认 allow

### 项目记忆（CLAUDE.md）

`settingSources: []` 同时也放弃了 SDK 自带的项目记忆加载 —— 在这个 SDK 里「不加载项目设置」与「不加载项目 `CLAUDE.md`」是同一个开关，没有只关一半的选项。所以 adapter 自己读（`src/server/adapters/project-memory.ts`）：

| 方面 | 约定 |
|---|---|
| 路径 | 只读 `getEffectiveCwd(workspace)` 下的 `CLAUDE.md` |
| 上限 | `MAX_PROJECT_MEMORY_CHARS = 50_000`（对齐 `fs-service.ts` 的 `MAX_READ_CHARS`，同为「文件内容进上下文」），超限在最后一个换行处截断并带可见标记 |
| 失败 | 不存在 / 读失败 / 是目录 / 去空白后为空 → `null`，system prompt 就是 agent 自己的 prompt，**run 不因此 fail** |
| 标注 | 注入块带标题与文件绝对路径，并写明这是 workspace 内容而非用户指令（workspace 是不可信输入） |

**不加载**：父目录的 `CLAUDE.md`、`CLAUDE.local.md`、`.claude/rules/`、`@import`，以及 workspace 的 plugins / skills / 自定义命令、`.claude/settings.json`、`.mcp.json`、项目 hooks。

隔离是**安全边界**，项目记忆只是**功能对齐**：读不到不影响任何安全性质。

### 工具集

完全用 SDK preset `'claude_code'`（即 Claude Code CLI 自带的全套），不消费 `AdapterInput.toolNames`。AgentHub 通过 SDK in-process MCP server 额外暴露 `write_artifact` / `read_artifact` / `deploy_artifact` / `deploy_workspace` / `ask_user` / `report_task_result`。`fs_write` 审批流通过 `pendingWrites` store 共享，关键 Bash 命令审批通过 `pendingBashCommands` store 共享，UI 层（`PendingWritesPanel` / `PendingWriteDiffTab` / `PendingBashCommandsPanel`）、`bash.ts` 和 `claude-code-adapter.ts` 共享命令安全策略（`src/server/security.ts`、`src/server/bash-command-approval.ts`）。

### Subagent (Task)

SDK Task 工具开子 agent 后，子 agent 的 `tool_use` / `tool_result` 块默认在同一个 `query()` 流上推回（`parent_tool_use_id` 非 null）。MVP 不把子 agent 抽成独立 `AgentRun`，UI 把这些 tool_use 直接作为父 message 里的 `ToolUsePart` 渲染就行。后续可通过 `Options.forwardSubagentText: true` + `SubagentStart`/`SubagentStop` hooks 升级成独立 child run。

### API key fallback

详见上方顶级章节「API key 解析（共四层）」。ClaudeCodeAdapter 视角：
- 第 1-3 层由 `AgentRunner.buildAdapterInput` 解析后塞进 `AdapterInput.apiKey`，adapter 把它注入 `options.env.ANTHROPIC_API_KEY` 传 SDK 子进程
- 第 4 层（OAuth `~/.claude/.credentials.json`）是 SDK 自动 fallback，AgentHub 不参与

### Abort

`Options.abortController` 接收 AbortSignal。AgentRunner 给每个 run 的 `signal` 透传到 SDK：

```typescript
const controller = new AbortController()
signal.addEventListener('abort', () => controller.abort(), { once: true })
```

捕获 `AbortError` 区分主动中止和真错误（中止时静默 return，run.end 状态由 AgentRunner 决定为 `'aborted'`）。

### 不做 / 推迟

- Subagent 独立 child run（MVP 同流够用）
- MCP server 配置 UI
- Skills / Plugins：**不是推迟，是强制不加载**（`settingSources: []`，见「项目记忆」）；Worktree SDK 高级特性仍推迟
- `write_artifact` 给 Claude Code agent（绑本地项目时文件就是产物）
- NotebookEdit 审批 diff
- Thinking 块翻译（需要开 Anthropic betas）

---

## CodexAdapter

源文件：`src/server/adapters/codex-adapter.ts`

封装 OpenAI 官方 `@openai/codex-sdk`，不手写 `spawn('codex')`。SDK 内部会使用 npm 依赖里的 `@openai/codex` runtime 并输出结构化 JSONL 事件；Adapter 只消费 SDK 的 `runStreamed()` 事件，不要求用户额外全局安装 Codex CLI。

CodexAdapter 不是「任意 OpenAI-compatible Chat Completions」入口。Codex SDK 的 `baseUrl` 最终传给 Codex runtime 的 `openai_base_url`，runtime 会连接 Responses/Codex 所需的 `/responses` 端点（含 WebSocket 流）。DeepSeek 官方 endpoint 当前没有 `/responses`，因此 `https://api.deepseek.com` / `https://api.deepseek.com/v1` 必须走 `CustomAgentAdapter`，不能走 CodexAdapter。

官方 Codex SDK 形态：
- TypeScript：`@openai/codex-sdk`，服务端 Node.js 18+ 使用；支持 `Codex().startThread()` / `resumeThread(threadId)` / `thread.runStreamed(prompt)`。
- Python：`openai-codex`，通过本地 Codex app-server / JSON-RPC 控制 Codex。AgentHub 是 Next.js/Node 服务端，除非后续有明确理由，不走 Python SDK。

```typescript
import { Codex } from '@openai/codex-sdk'

const codex = new Codex({
  apiKey: input.apiKey ?? undefined,
  baseUrl: input.apiBaseUrl ?? undefined,
  config: { developer_instructions: input.systemPrompt },
})
const thread = cachedThreadId
  ? codex.resumeThread(cachedThreadId, threadOptions)
  : codex.startThread(threadOptions)

const { events } = await thread.runStreamed(input.prompt, { signal })
// 将 SDK thread / turn / item / usage 事件翻译为 StreamEvent
```

### 接入原则

1. **SDK first**：CodexAdapter 使用 `@openai/codex-sdk`。`codex exec --json` 或 `codex mcp-server` 只作为自动化 / MCP 参考，不是主路径。
2. **线程续接**：按 `conversationId + agentId` 缓存 Codex threadId；撤回 / 编辑重发 / 重新生成 / 删除会话 / context compact 时清理对应 thread，模式参考 `ClaudeCodeAdapter` 的 session 缓存。
3. **运行时环境隔离**：Codex 子进程使用 AgentHub 管理的 `CODEX_HOME=<dataDir>/codex-home` 和 `CODEX_SQLITE_HOME=<dataDir>/codex-home`。继承 PATH / HOME / 代理等普通环境，但剥离外部 `CODEX_*`（保留 `CODEX_CA_CERTIFICATE`），避免 CC Switch 或用户 `~/.codex/config.toml` 影响 AgentHub 调试。
4. **AgentHub MCP bridge**：Codex config 注入 `mcp_servers.agenthub`，启动 `scripts/agenthub-codex-mcp.mjs` stdio server。bridge 只暴露 `write_artifact` / `read_artifact` / `deploy_artifact` / `deploy_workspace` / `ask_user` / `report_task_result`，通过带 token 的内部 API 调用 `toolRegistry`。
5. **Base URL 兼容性**：`apiBaseUrl` 只接受 Codex/Responses 兼容 endpoint。运行前拦截已知不支持的 DeepSeek host；如果运行时出现 `/responses` 404 / Not Found，也归因为协议不兼容并提示用户改用 Custom adapter。
6. **Workspace 与 sandbox**：`workingDirectory = AdapterInput.workspacePath`，`skipGitRepoCheck=true`（sandbox workspace 可能不是 git repo）。Review 模式用 `sandboxMode='read-only'`；Auto 模式用 `sandboxMode='workspace-write'`。不启用 `danger-full-access`。
7. **审批与安全**：当前 TypeScript SDK 没有 Claude `canUseTool` 等价 hook，所以 Review 模式不允许自动写盘。Auto 模式下由 Codex 自己的 workspace-write sandbox 限制边界；`approvalPolicy='never'`、`networkAccessEnabled=false`、`webSearchMode='disabled'`，避免产生 AgentHub 无法接管的交互式审批请求。
8. **事件翻译**：SDK 的 `thread.started` 缓存 threadId；`agent_message` → text part；`reasoning` / `todo_list` → thinking part；`command_execution` / `file_change` / `mcp_tool_call` / `web_search` → tool call/result；`turn.completed.usage` → `message.usage` + `run.usage`。AgentHub MCP 的 `write_artifact` / `deploy_artifact` / `deploy_workspace` 结果额外翻译成 `artifact.create` / `deploy.status`。
9. **图片附件**：`kind='image'` 的 attachment 通过 SDK `local_image` 输入传给 Codex。普通文件附件暂不直传；需要文件内容时让 Codex 在 workspace 里读取，或后续通过 AgentHub MCP 工具扩展。

### CLI fallback（当前不实现）

CodexAdapter 当前必须走 `@openai/codex-sdk`。如果后续 SDK 缺少实现必需能力，才另写补充 spec 评估 CLI fallback；不能把 CLI spawn 作为默认 adapter 设计。

**后续增强**：如果 Codex SDK 暴露可拦截的 patch / exec approval hook，再把 Review 模式桥到 AgentHub `pendingWrites` 和命令黑名单。否则可做 shadow workspace：Codex 在临时副本里写，run 结束后把 diff 转成 `pendingWrites` 给用户审批。

---

## 外部 MCP server 接线（Spec 15）

用户登记的外部 MCP server 与 adapter 自己的 `agenthub` MCP bridge 并列接入。**分层**（CLAUDE.md §3.1，adapter 不写 / 不读 DB）：

```
mcp_servers（DB，L1）
  → mcp-server-service.resolveMcpServersForAgent()   // L3：纯 DB 读 + enabled 过滤
  → agent-runner.buildAdapterInput()                 // L3：展开 ${ENV}、按 adapter 过滤 transport、记警告
  → AdapterInput.mcpServers（ResolvedMcpServer[]）    // L2 边界：plain config
  → ClaudeCodeAdapter / CodexAdapter                 // L2：只翻译成 SDK 配置
  → CustomAgentAdapter                               // L2：自建 MCP client，见下
```

`buildAdapterInput` 里的解析失败（server 被删、`${ENV}` 缺变量、transport 不兼容）**只丢弃该 server 并记一条警告，不 fail 整个 run**（`ResolvedMcpServer` 的 warning 语义，Spec 15 §6.4）。占位符在 **run 启动时**展开、不在写入时，因此 DB 只存占位文本。

**三个 adapter 的形状映射**：

| transport | Claude Code（`mcpServers` option） | Codex（`config.mcp_servers.<name>`） | custom（MCP SDK transport） |
|---|---|---|---|
| `stdio` | `{ type:'stdio', command, args, env? }` | `{ command, args, env? }` | `StdioClientTransport({ command, args, env, cwd })` |
| `sse` | `{ type:'sse', url, headers? }` | ❌ 不支持的 transport，L3 已过滤 | `SSEClientTransport(url, { requestInit })` |
| `http` | `{ type:'http', url, headers? }` | `{ url, http_headers? }` | `StreamableHTTPClientTransport(url, { requestInit })` |

- **Claude Code**：`mcpServers: { agenthub: <in-process bridge>, ...<每个外部 server> }`，与现有 `agenthub` 并列传入 `query()`；stdio 子进程由 SDK 自管。同一次 `query()` 还带 `strictMcpConfig: true`，因此 MCP server **只**来自这个 map —— workspace 里的 `.mcp.json` 不会被加载（见「ClaudeCodeAdapter / 项目记忆」）。
- **Codex**：写进 `config.mcp_servers`，与 `agenthub` 并列。Codex **靠 `command` / `url` 的存在推断传输方式，没有 `type` 字段**；可选字段（`env` / `headers`）必须**缺省而不是传 `null`** —— SDK 的 TOML 序列化器遇 `null` 会抛。Codex 侧只接受 `stdio` / `http`（无 SSE）。
- **Codex 的 `config.mcp_servers` 写入的是 AgentHub 隔离的 `CODEX_HOME`**，不碰用户本机 `~/.codex/config.toml`（见本 spec「接入原则 3」与 CLAUDE.md §5.4）。

**transport 支持矩阵**（前后端共用 `src/shared/mcp.ts` 一份）：

| transport | Claude Code | Codex | custom |
|---|---|---|---|
| `stdio` | ✅ | ✅ | ✅ |
| `http`（streamable） | ✅ | ✅ | ✅ |
| `sse` | ✅ | ❌ | ✅ |

不支持的 pairing 在 **L3 过滤时就打个警告并跳过**，绝不会带病传给 SDK。

**审批（Claude Code + custom）**：外部工具名 `mcp__<server>__<tool>` 在 `bridgePermission` 里排在默认放行之前（见「ClaudeCodeAdapter / canUseTool 桥」第 5 步）：`trust='always'` 或本会话已批准过该工具 → 直接 allow；否则弹审批（`mcp_tool.pending` / `mcp_tool.resolved`），批准后按 per-tool-per-conversation 记忆（`src/server/mcp-approvals.ts`）。custom 的 tool loop 在调用 `client.callTool` 之前走**同一套**队列与记忆，因此两个 adapter 的审批语义一致；被拒的调用返回 `isError` 结果，模型被明确要求不要重试。Codex 有自己的一套审批策略与沙箱，AgentHub 拦截不到它的工具决策，故 `trust` 对 Codex 只是**建议性**的。Claude Code 的审批门以「隔离启动」为前提：CLI 先求值项目设置的 `permissions.allow`，命中就不会回调 `canUseTool`（见「canUseTool 桥」的提示）。

**custom 的连接与清理**：每个 `stream()` 创建自己的 `McpClients`，对所有 server 并行 `connect` + `listTools`（30s 超时），失败者跳过并发 `mcp_server.unavailable`；run 结束 / abort 的 `finally` 中先按 `transport.pid` 杀 stdio 进程树（`killProcessTreeByPid`，因为 SDK 的 stdio 子进程不是 `detached`，拿不到进程组），再 `close()` 所有 client。stdio 以 `{ ...buildChildProcessEnv(), ...server.env }` 为环境、workspace 路径为 `cwd`。`mock` adapter 不支持外部 MCP。

---

## AgentRegistry：根据 Agent 路由到 Adapter

源文件：`src/server/adapters/registry.ts`

```typescript
class AgentRegistry {
  private adapters: Map<AdapterName, AgentPlatformAdapter>

  getAdapter(agent: Agent): AgentPlatformAdapter {
    const adapter = this.adapters.get(agent.adapterName)
    if (!adapter) throw new Error(`Unknown adapter: ${agent.adapterName}`)
    return adapter
  }
}
```

当前注册的 adapter：`mock`、`custom`、`claude-code`、`codex`。

---

## 错误处理

- Adapter 内部捕获厂商 SDK 异常 → throw 出 stream；AgentRunner 接住后为该 run 内未配对 `tool_result` 的 `tool_use` 补发 `isError=true` 结果，写 `run.end({ status: 'failed', error })`，并通过 `emitErrorVisualisation` 注入一条 `msg_err_*` 错误消息让用户在对话里看到（见 Spec 09 / Spec 02）
- **网络/速率限制类错误的重试**：CustomAgentAdapter 通过 OpenAI SDK 的 `maxRetries=2`（在 `buildClient` 中显式声明，常量 `MAX_API_RETRIES`）自动重试，对 408 / 429 / >= 500 / `APIConnectionError` 走指数退避。注意：**重试只对初始连接生效**，stream 一旦开始 emit chunks 就不再重试。如果要按 provider 调整次数（比如火山方舟更宽松），改这个常量
- LLM 输出 JSON Schema 不符 / tool args 解析失败 → 由 `toolRegistry.execute` 内部 catch 成 `tool.result.isError=true`，**不**视作 Adapter 错误

---

## 新增 Adapter 的步骤

1. 在 `src/server/adapters/` 创建 `<name>-adapter.ts`
2. 实现 `AgentPlatformAdapter` 接口
3. 在 `src/shared/types.ts` 的 `AdapterName` 联合类型加新值
4. 在 `adapters/registry.ts` 注册
5. （UI 路径）在 `src/components/create-agent-dialog.tsx` 加新 provider 选项
6. （seed）若是内置 agent，在 `src/db/seed.ts` 加种子
7. 写至少 1 个单元测试覆盖事件翻译核心路径
8. 更新本 spec 的「现状说明」表格

---

## 与其它 spec 的关系

- Spec 01：Agent.adapterName 决定路由到哪个 Adapter
- Spec 02：StreamEvent 是 Adapter 的输出 schema
- Spec 06：Orchestrator 给子 agent 拼 prompt 时也走 CustomAgentAdapter（Orchestrator 本身也是一个 custom agent）
- Spec 07：toolNames 引用的工具定义
- Spec 08：agents.api_key / api_base_url 字段；app_settings 表（全局 key 兜底）
- Spec 15：外部 MCP server 的解析与接入（`AdapterInput.mcpServers`、transport 矩阵、`trust` 审批门）
