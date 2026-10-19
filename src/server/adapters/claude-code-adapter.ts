import {
  AbortError,
  createSdkMcpServer,
  query,
  tool,
  type McpServerConfigForProcessTransport,
  type Options,
} from '@anthropic-ai/claude-agent-sdk'
import { and, eq } from 'drizzle-orm'
import { statSync } from 'node:fs'
import { z } from 'zod'

import { classifyBashApproval, waitForBashApproval } from '@/server/bash-command-approval'
import { db, schema } from '@/db/client'
import type { WorkspaceRow } from '@/db/schema'
import { recordRunFileWrite } from '@/server/dispatch-run-evidence'
import { readIfExists } from '@/server/fs-service'
import { newMessageId, newToolCallId } from '@/server/ids'
import {
  isExternalMcpTool,
  isToolApproved,
  parseMcpToolName,
  waitForMcpToolApproval,
} from '@/server/mcp-approvals'
import { pendingWrites } from '@/server/pending-writes'
import { currentPlatform } from '@/server/platform'
import { findBannedPattern } from '@/server/security'
import { REPORT_TASK_RESULT_TOOL_NAME } from '@/server/task-result-report'
import { toolRegistry } from '@/server/tools/registry'
import type { ToolContext } from '@/server/tools/types'
import { assertPathWithinWorkspace, getEffectiveCwd } from '@/server/workspace-utils'
import type {
  DeployStatusRecord,
  ResolvedMcpServer,
  StreamEvent,
} from '@/shared/types'

import { buildChildProcessEnv, createAdapterEvent } from './adapter-utils'
import { clampToolResult } from './custom-mcp-tools'
import { composeSystemPrompt, projectMemoryPath, readProjectMemory } from './project-memory'
import { sdkIsolationOptions } from './sdk-isolation'
import { adapterSessionKey, claudeCodeSessions } from './session-store'
import { collectUnavailableServers } from './mcp-status'
import { isShellTool } from './shell-tool'
import type { AdapterInput, AgentPlatformAdapter } from './types'

/**
 * ClaudeCodeAdapter —— 使用 `@anthropic-ai/claude-agent-sdk`，复用 Claude Code 一整套能力：
 *  - 内置工具集（Bash / Read / Write / Edit / Grep / Glob / WebFetch / WebSearch / Task / TodoWrite…）
 *  - 子 agent (Task) 嵌套调度
 *  - 自动 agent loop（多轮思考 + 工具调用，无需我们手写）
 *
 * 桥接策略：
 *  - 路径沙箱、Bash 黑名单、fs_write 审批都在 `canUseTool` 里拦截
 *  - 用户应用 Edit/Write 后由 SDK 自己写盘（pendingWrites.register 传 skipWrite: true）
 *  - 事件流翻译：SDK 的 SDKMessage → 我们的 StreamEvent (message.start/end + part.* + tool.*)
 *
 * 详见 specs/05-adapter-interface.md「ClaudeCodeAdapter」一节。
 */

/**
 * 每个 conversation 的 SDK session_id 缓存。SDK 默认每次 query() 是新 session，
 * 不传 resume 时下一轮 agent 不会记得上一轮内容。我们把 init system message 里的
 * session_id 缓存起来，下次同 conversation 再 query 时传 resume = sessionId。
 *
 * HMR-safe singleton。dev server 重启会丢失 —— 但 SDK 本身持久化到磁盘 (~/.claude
 * sessions)，所以即使我们丢了 id，SDK 数据还在；只是接下来的会话变成新 session。
 */
const DEFAULT_MODEL = 'claude-opus-4-7'
/** SDK 各写盘工具的目标字段不同：NotebookEdit 用 notebook_path，其余是 file_path / path。 */
function toolInputPath(toolInput: Record<string, unknown> | undefined): string | null {
  if (!toolInput) return null
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = toolInput[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

/** SDK 内置工具中会改文件的，需要走审批 */
const FS_WRITE_TOOLS = new Set(['Write', 'Edit'])
/** 需要路径沙箱检查的工具（Bash 单独走黑名单 + cwd 限定） */
const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit'])
const PLAN_TASKS_TOOL_NAME = 'plan_tasks'
const CLAUDE_PLAN_STAGE_BUILTIN_TOOLS = ['Read', 'Grep', 'Glob']
const CLAUDE_PLAN_STAGE_AGENTHUB_TOOLS = new Set([
  PLAN_TASKS_TOOL_NAME,
  'ask_user',
  'fs_list',
  'read_artifact',
  'read_attachment',
])

type CanUseToolFn = NonNullable<Options['canUseTool']>
type PermissionResult = Awaited<ReturnType<CanUseToolFn>>

export class ClaudeCodeAdapter implements AgentPlatformAdapter {
  readonly name = 'claude-code' as const

  async *stream(input: AdapterInput, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const messageId = newMessageId()
    const baseEvent = createAdapterEvent(input.conversationId)

    yield baseEvent({
      type: 'message.start' as const,
      messageId,
      agentId: input.agentId,
      runId: input.runId,
    }) as StreamEvent

    // 取 workspace + 审批模式（用于 canUseTool）
    const workspace = await db.query.workspaces.findFirst({
      where: eq(schema.workspaces.conversationId, input.conversationId),
    })
    if (!workspace) {
      throw new Error(`Workspace not found for conversation ${input.conversationId}`)
    }
    const conv = await db.query.conversations.findFirst({
      where: eq(schema.conversations.id, input.conversationId),
    })
    const approvalMode = conv?.fsWriteApprovalMode ?? 'review'

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })

    // 翻译状态
    let nextPartIndex = 0
    let activeTextPartIndex = -1 // -1 表示当前没有开放的 text part
    // partial streaming 是否已经产出过文本。完整 assistant 消息的兜底只在它为 false 时启用：
    // 否则 [tool_use, text] 顺序下，tool_use 先把 activeTextPartIndex 重置为 -1，
    // 已由 delta 流出的 text 会被整段再发一次，同一段文字渲染两遍。
    let sawStreamedText = false
    const toolCallIdByUseId = new Map<string, string>()
    const toolInputByUseId = new Map<string, Record<string, unknown>>()
    // 同步记录 tool name —— 让 tool_result 阶段能判断「这个结果是 write_artifact 来的，要 yield artifact.create」
    const toolNameByUseId = new Map<string, string>()

    const toolCtx: ToolContext = {
      conversationId: input.conversationId,
      workspacePath: getEffectiveCwd(workspace),
      agentId: input.agentId,
      runId: input.runId,
      abortSignal: signal,
    }
    const isPlanStage = input.toolNames.includes(PLAN_TASKS_TOOL_NAME)
    const mcpTools = [
        tool(
          PLAN_TASKS_TOOL_NAME,
          'Create the AgentHub Orchestrator dispatch plan. Call this exactly once when the plan is ready; AgentHub will stop the planning stage and execute the plan after user review.',
          {
            reasoning: z.string(),
            tasks: z
              .array(
                z.object({
                  id: z.string(),
                  agentId: z.string(),
                  task: z.string(),
                  taskKind: z.enum(['code', 'test', 'review', 'design', 'doc', 'analysis']).optional(),
                  dependsOn: z.array(z.string()).optional(),
                  expectedOutputs: z
                    .array(
                      z.object({
                        id: z.string(),
                        type: z.enum(['web_app', 'document', 'image', 'ppt', 'project']),
                        required: z.boolean().optional(),
                        description: z.string().optional(),
                      }),
                    )
                    .optional(),
                  inputs: z
                    .array(
                      z.object({
                        fromTaskId: z.string(),
                        outputId: z.string(),
                        required: z.boolean().optional(),
                        description: z.string().optional(),
                      }),
                    )
                    .optional(),
                  acceptanceCriteria: z.array(z.string()).optional(),
                  targetPaths: z.array(z.string()).optional(),
                  expectedWorkspaceChanges: z.array(z.string()).optional(),
                  requiredCommands: z
                    .array(
                      z.object({
                        command: z.string(),
                        description: z.string().optional(),
                        cwd: z.string().optional(),
                        timeoutMs: z.number().int().positive().optional(),
                      }),
                    )
                    .optional(),
                  requiredEvidence: z.array(z.string()).optional(),
                }),
              )
              .min(1),
          },
          async (args) => {
            const result = await toolRegistry.execute(PLAN_TASKS_TOOL_NAME, args, toolCtx)
            if (!result.ok) {
              return {
                content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
                isError: true,
              }
            }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result.value) }],
            }
          },
        ),
        tool(
          'write_artifact',
          'Create a previewable artifact (web_app / document / image / ppt / diagram) in the current conversation, or a new version of an existing one (pass parentArtifactId; version auto-increments). For diagram, pass content { syntax: "mermaid", source: "flowchart TD..." }; quote labels containing Chinese/math/symbols as A["..."], omit Markdown fences, and retry with corrected source if validation returns Invalid Mermaid diagram. For ppt, prefer structured slides with semantic blocks: heading, paragraph, bullets, metric, quote, timeline, columns, callout, divider, spacer. Do not embed raw base64/data URI assets in ppt JSON. Use outputKey when a dispatched task declares an expected output id. Use this for content that should be previewed in a card — NOT for files in the workspace.',
          {
            type: z.enum(['web_app', 'document', 'image', 'ppt', 'diagram']),
            title: z.string(),
            content: z.unknown(),
            outputKey: z.string().optional(),
            parentArtifactId: z.string().optional(),
          },
          async (args) => {
            const result = await toolRegistry.execute('write_artifact', args, toolCtx)
            if (!result.ok) {
              return {
                content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
                isError: true,
              }
            }
            // 不在这里 publish artifact.create —— 由 adapter 主循环检测到对应 tool_result 时
            // 从 generator yield 出去，让 AgentRunner.consumeStream 触发 artifact_ref 注入。
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result.value) }],
            }
          },
        ),
        tool(
          'read_artifact',
          'Read the full content of an existing artifact in the current conversation by id.',
          { artifactId: z.string() },
          async (args) => {
            const result = await toolRegistry.execute('read_artifact', args, toolCtx)
            if (!result.ok) {
              return {
                content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
                isError: true,
              }
            }
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    typeof result.value === 'string'
                      ? result.value
                      : JSON.stringify(result.value),
                },
              ],
            }
          },
        ),
        tool(
          'read_attachment',
          'Read a user-uploaded attachment in the current conversation by attachmentId. Use this when planning depends on uploaded file contents.',
          { attachmentId: z.string() },
          async (args) => {
            const result = await toolRegistry.execute('read_attachment', args, toolCtx)
            if (!result.ok) {
              return {
                content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
                isError: true,
              }
            }
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    typeof result.value === 'string'
                      ? result.value
                      : JSON.stringify(result.value),
                },
              ],
            }
          },
        ),
        tool(
          'fs_list',
          'List files and directories inside the current AgentHub workspace. Prefer this before reading files when exploring project structure.',
          { path: z.string().optional() },
          async (args) => {
            const result = await toolRegistry.execute('fs_list', args, toolCtx)
            if (!result.ok) {
              return {
                content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
                isError: true,
              }
            }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result.value) }],
            }
          },
        ),
        tool(
          'deploy_artifact',
          'Create a ready local preview deployment for a web_app artifact. The returned previewPath is a relative path for the current AgentHub instance; do not invent or print a public hostname. Use this after write_artifact when the user should receive a deployment card with open/copy/download actions.',
          { artifactId: z.string() },
          async (args) => {
            const result = await toolRegistry.execute('deploy_artifact', args, toolCtx)
            if (!result.ok) {
              return {
                content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
                isError: true,
              }
            }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result.value) }],
            }
          },
        ),
        tool(
          'deploy_workspace',
          'Create a deployment card from an existing static output directory inside the current workspace, such as dist, build, out, or client/dist. Use this after building a local project. It copies files only; it does not run build commands.',
          {
            path: z.string(),
            title: z.string().optional(),
            entry: z.string().optional(),
          },
          async (args) => {
            const result = await toolRegistry.execute('deploy_workspace', args, toolCtx)
            if (!result.ok) {
              return {
                content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
                isError: true,
              }
            }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result.value) }],
            }
          },
        ),
        tool(
          REPORT_TASK_RESULT_TOOL_NAME,
          'Report the final semantic outcome of the current AgentHub sub-task. Call exactly once at the end of a dispatched child task. Use complete only when the assigned task is fully accomplished and every acceptance criterion passed; never report complete for partial work, failing tests, unresolved errors, or missing files/dependencies.',
          {
            status: z.enum(['complete', 'failed', 'blocked']),
            summary: z.string(),
            acceptanceResults: z
              .array(
                z.object({
                  criterion: z.string(),
                  passed: z.boolean(),
                  evidence: z.string(),
                }),
              )
              .optional(),
            filesChanged: z
              .array(
                z.object({
                  path: z.string(),
                  action: z.enum(['created', 'modified', 'deleted', 'verified']).optional(),
                }),
              )
              .optional(),
            commandsRun: z
              .array(
                z.object({
                  command: z.string(),
                  exitCode: z.number().int().nullable(),
                  cwd: z.string().optional(),
                  timedOut: z.boolean().optional(),
                  summary: z.string().optional(),
                }),
              )
              .optional(),
            tests: z
              .array(
                z.object({
                  command: z.string(),
                  passed: z.boolean(),
                  summary: z.string().optional(),
                }),
              )
              .optional(),
            blockers: z.array(z.string()).optional(),
          },
          async (args) => {
            const result = await toolRegistry.execute(REPORT_TASK_RESULT_TOOL_NAME, args, toolCtx)
            if (!result.ok) {
              return {
                content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
                isError: true,
              }
            }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result.value) }],
            }
          },
        ),
        tool(
          'ask_user',
          'Ask the user one or more structured multiple-choice questions with 2-4 options. Prefer this over plain text when progress depends on a finite user choice, such as scope, target platform, design direction, implementation route, destructive action, or acceptance criteria. Do not use it for open-ended discussion or non-blocking details. Returns answers keyed by question text.',
          {
            questions: z
              .array(
                z.object({
                  question: z.string(),
                  header: z.string(),
                  multiSelect: z.boolean().optional(),
                  options: z
                    .array(
                      z.object({
                        label: z.string(),
                        description: z.string().optional(),
                        preview: z.string().optional(),
                      }),
                    )
                    .min(2)
                    .max(4),
                }),
              )
              .min(1)
              .max(4),
          },
          async (args) => {
            const result = await toolRegistry.execute('ask_user', args, toolCtx)
            if (!result.ok) {
              return {
                content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
                isError: true,
              }
            }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result.value) }],
            }
          },
        ),
      ]
    const agenthubMcpServer = createSdkMcpServer({
      name: 'agenthub',
      version: '1.0.0',
      instructions: isPlanStage
        ? 'AgentHub Orchestrator planning tools: inspect context with fs_list/read_artifact/read_attachment when needed, ask finite blocking questions with ask_user, then call plan_tasks exactly once. Do not write files, run commands, deploy, or complete child work in the planning stage.'
        : '内置 AgentHub 工具：用 write_artifact 创建可预览产物（网页 / 文档 / 图片 / PPT / Mermaid 图），流程、架构、时序、依赖关系优先用 type="diagram" 且 content 为 { syntax: "mermaid", source }；Mermaid 图会在写入时做预检，中文/数学/括号等 label 写成 A["..."]，不要传 ```mermaid fence，若工具返回 Invalid Mermaid diagram 必须修正 source 后重试；PPT 优先使用 semantic blocks（heading、paragraph、bullets、metric、quote、timeline、columns、callout、divider、spacer），不要在 PPT JSON 中嵌入 base64/data URI 大资产；用 read_artifact 读其他 Agent 的产物，用 fs_list 查看 AgentHub workspace 目录，用 deploy_artifact 为 web_app artifact 生成本地预览路径，用 deploy_workspace 为当前 workspace 内 dist/build/out 等静态目录生成部署卡。需要用户在有限方案中选择时，用 ask_user 发起结构化问答，不要只在普通文本里提问。被分派为子任务时，结束前必须调用 report_task_result 上报真实任务结果。部署工具返回的 previewPath 是当前 AgentHub 实例下的相对路径；不要把它改写成公网域名或自造完整 URL，面向用户时让用户点击部署卡片按钮或原样引用 previewPath。',
      tools: filterAgentHubMcpToolsForRun(input.toolNames, mcpTools),
    })

    // 同一 conversation 的多轮 query 共享 session（resume）—— 否则每轮都是新对话上下文，
    // agent 就不记得上一轮说了什么。按 agent 分键：群聊里多个 claude-code agent 不能共用一份 SDK 记录。
    const sessionKey = adapterSessionKey(input.conversationId, input.agentId)
    const previousSessionId = claudeCodeSessions.get(sessionKey)

    // init 消息到达后填入，canUseTool 用它识别 shell 工具（SDK 按平台命名，不能写死 Bash）
    let sdkToolNames: readonly string[] | null = null

    const effectiveCwd = getEffectiveCwd(workspace)
    // 项目记忆得自己读：SDK 里「加载项目 CLAUDE.md」与「加载项目 settings」是同一个开关，
    // 而后者必须关掉（见 sdkIsolationOptions），所以两者只能一起关、再从这里补回来。
    const systemPromptAppend = composeSystemPrompt(
      input.systemPrompt,
      readProjectMemory(effectiveCwd),
      projectMemoryPath(effectiveCwd),
    )

    const options: Options = {
      cwd: effectiveCwd,
      abortController: controller,
      model: input.modelId ?? DEFAULT_MODEL,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: systemPromptAppend,
      },
      tools: isPlanStage ? CLAUDE_PLAN_STAGE_BUILTIN_TOOLS : { type: 'preset', preset: 'claude_code' },
      // 禁用 SDK 内置 AskUserQuestion —— 我们用统一的 mcp__agenthub__ask_user 提供等价 UI
      disallowedTools: ['AskUserQuestion'],
      mcpServers: { agenthub: agenthubMcpServer, ...toSdkMcpServers(input.mcpServers) },
      includePartialMessages: true,
      // 隔离启动：workspace 的 .claude/settings.json / 项目 hooks / .mcp.json 都不参与本次 run，
      // 否则它们会在 canUseTool 之前放行工具。代价与取舍见 sdk-isolation.ts
      ...sdkIsolationOptions(),
      permissionMode: 'default', // 自己 canUseTool 接管
      env: buildSdkEnv(input.apiKey, input.apiBaseUrl),
      ...(previousSessionId ? { resume: previousSessionId } : {}),
      canUseTool: (toolName, toolInput) =>
        bridgePermission(toolName, toolInput, {
          workspace,
          approvalMode,
          input,
          signal,
          sdkToolNames,
        }),
    }

    try {
      const q = query({ prompt: input.prompt, options })
      for await (const m of q) {
        // SDKSystemMessage init 携带 session_id / 工具表 / 外部 MCP 连接状态
        if (m.type === 'system') {
          const sid = (m as { session_id?: string }).session_id
          if (sid) claudeCodeSessions.set(sessionKey, sid)
          if ((m as { subtype?: string }).subtype !== 'init') continue

          const tools = (m as { tools?: unknown }).tools
          if (Array.isArray(tools)) {
            sdkToolNames = tools.filter((t): t is string => typeof t === 'string')
          }

          // 只报告本次 run 传入的外部 server；内置 agenthub 桥不在名单里。
          const mcpStatuses = (m as { mcp_servers?: unknown }).mcp_servers
          if (Array.isArray(mcpStatuses)) {
            const unavailable = collectUnavailableServers(
              mcpStatuses,
              (input.mcpServers ?? []).map((server) => server.name),
            )
            if (unavailable.length > 0) {
              yield baseEvent({
                type: 'mcp_server.unavailable' as const,
                runId: input.runId,
                servers: unavailable,
              })
            }
          }
          continue
        }

        // partial streaming：includePartialMessages=true 时优先用这个推 delta
        if (m.type === 'stream_event') {
          const ev = m.event as { type?: string; delta?: { type?: string; text?: string } }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            sawStreamedText = true
            if (activeTextPartIndex === -1) {
              activeTextPartIndex = nextPartIndex++
              yield baseEvent({
                type: 'part.start' as const,
                messageId,
                partIndex: activeTextPartIndex,
                part: { type: 'text' as const, content: '' },
              }) as StreamEvent
            }
            yield baseEvent({
              type: 'part.delta' as const,
              messageId,
              partIndex: activeTextPartIndex,
              delta: { type: 'text.append' as const, text: ev.delta.text },
            }) as StreamEvent
          }
          continue
        }

        if (m.type === 'assistant') {
          // 完整 assistant 消息 —— 处理 tool_use 块（text 已经在 stream_event 里增量过）
          const content = m.message?.content as Array<{
            type: string
            id?: string
            name?: string
            input?: Record<string, unknown>
            text?: string
          }>
          if (!Array.isArray(content)) continue
          for (const block of content) {
            if (block.type === 'tool_use' && block.id && block.name) {
              // tool_use 出现 → 关闭当前 text part 上下文
              activeTextPartIndex = -1
              const callId = newToolCallId()
              toolCallIdByUseId.set(block.id, callId)
              toolNameByUseId.set(block.id, block.name)
              toolInputByUseId.set(block.id, block.input ?? {})
              yield baseEvent({
                type: 'tool.call' as const,
                messageId,
                callId,
                toolName: block.name,
                args: block.input ?? {},
              }) as StreamEvent
            } else if (
              block.type === 'text' &&
              activeTextPartIndex === -1 &&
              block.text &&
              !sawStreamedText
            ) {
              // 整轮都没收到 partial text 时的兜底：把整段 text 作为一个 part
              const idx = nextPartIndex++
              yield baseEvent({
                type: 'part.start' as const,
                messageId,
                partIndex: idx,
                part: { type: 'text' as const, content: block.text },
              }) as StreamEvent
            }
          }
          continue
        }

        if (m.type === 'user') {
          // tool_result 块（SDK 内部执行完工具后的返回）
          const content = m.message?.content as
            | Array<{
                type: string
                tool_use_id?: string
                content?: unknown
                is_error?: boolean
              }>
            | undefined
          if (!Array.isArray(content)) continue
          for (const block of content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const callId = toolCallIdByUseId.get(block.tool_use_id)
              if (!callId) continue
              yield baseEvent({
                type: 'tool.result' as const,
                messageId,
                callId,
                // 外部 MCP server 可能返回任意大的文本 / base64；不限长会撑爆消息行、SSE 与后续上下文
                result: clampToolResult(block.content ?? null),
                isError: !!block.is_error,
              }) as StreamEvent

              // 检测 agenthub MCP write_artifact 的成功结果 → 取出 artifact 并 yield artifact.create
              // 让 AgentRunner.consumeStream 给当前 message 注入 artifact_ref part（产物卡片）
              const toolName = toolNameByUseId.get(block.tool_use_id) ?? ''
              if (
                !block.is_error &&
                (FS_WRITE_TOOLS.has(toolName) || toolName === 'NotebookEdit')
              ) {
                recordClaudeSdkFileWrite(input.runId, workspace, toolInputByUseId.get(block.tool_use_id))
              }

              if (!block.is_error && toolName === 'mcp__agenthub__write_artifact') {
                const artifactId = parseArtifactIdFromMcpResult(block.content)
                if (artifactId) {
                  const row = await db.query.artifacts.findFirst({
                    where: and(
                      eq(schema.artifacts.id, artifactId),
                      eq(schema.artifacts.conversationId, input.conversationId),
                    ),
                  })
                  if (row) {
                    yield baseEvent({
                      type: 'artifact.create' as const,
                      artifact: {
                        id: row.id,
                        conversationId: row.conversationId,
                        type: row.type,
                        title: row.title,
                        content: row.content,
                        version: row.version,
                        parentArtifactId: row.parentArtifactId ?? undefined,
                        createdByAgentId: row.createdByAgentId,
                        createdAt: row.createdAt,
                      },
                    }) as StreamEvent
                  }
                }
              }

              if (
                !block.is_error &&
                (toolName === 'mcp__agenthub__deploy_artifact' ||
                  toolName === 'mcp__agenthub__deploy_workspace')
              ) {
                const deployment = parseDeploymentFromMcpResult(block.content)
                if (deployment) {
                  yield baseEvent({
                    type: 'deploy.status' as const,
                    messageId,
                    deployment,
                  }) as StreamEvent
                }
              }
            }
          }
          continue
        }

        if (m.type === 'result') {
          // 终止信号 —— 顺便采集 usage（success / error subtypes 都带 usage 字段）
          const resultMsg = m as unknown as {
            subtype?: string
            is_error?: boolean
            errors?: string[]
            usage?: {
              input_tokens?: number
              output_tokens?: number
              cache_creation_input_tokens?: number
              cache_read_input_tokens?: number
            }
            modelUsage?: Record<string, unknown>
          }
          if (resultMsg.usage) {
            const u = resultMsg.usage
            const model =
              resultMsg.modelUsage && Object.keys(resultMsg.modelUsage).length > 0
                ? Object.keys(resultMsg.modelUsage)[0]
                : (input.modelId ?? DEFAULT_MODEL)
            const input_tokens = u.input_tokens ?? 0
            const output_tokens = u.output_tokens ?? 0
            const cache_creation = u.cache_creation_input_tokens ?? 0
            const cache_read = u.cache_read_input_tokens ?? 0
            // Anthropic 把 prompt 拆成 input / cache_creation / cache_read 三桶；实际 prompt 大小是它们之和
            const fullPromptSize = input_tokens + cache_creation + cache_read
            // ClaudeCode 一个 run 当作一条 message 渲染（同 messageId），所以 message.usage 等于 run usage
            yield baseEvent({
              type: 'message.usage' as const,
              messageId,
              usage: {
                inputTokens: input_tokens,
                outputTokens: output_tokens,
                cacheReadTokens: cache_read,
              },
            }) as StreamEvent
            yield baseEvent({
              type: 'run.usage' as const,
              runId: input.runId,
              usage: {
                inputTokens: input_tokens,
                outputTokens: output_tokens,
                cacheCreationTokens: cache_creation,
                cacheReadTokens: cache_read,
                lastInputTokens: fullPromptSize,
                model,
              },
            }) as StreamEvent
          }

          // SDK 把 max turns / 执行错误也放在 result 里：不能当成正常完成。
          if (resultMsg.is_error || resultMsg.subtype?.startsWith('error')) {
            const details = resultMsg.errors?.filter((item) => item.trim()).join('; ')
            throw new Error(
              details || `Claude Code finished with ${resultMsg.subtype ?? 'an error result'}`,
            )
          }
          break
        }
        // 其他系统消息（init / status / hook 事件 / task notification 等）暂时忽略
      }
    } catch (err) {
      if (err instanceof AbortError || signal.aborted) {
        // 主动中止：吞掉，run.end 状态由 AgentRunner 决定
      } else {
        throw err
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }

    // 主动中止时不要把消息收尾：留给 runner 按 aborted 标记，而不是留下一条 complete 消息。
    if (!signal.aborted) {
      yield baseEvent({ type: 'message.end' as const, messageId }) as StreamEvent
    }
  }
}

export function filterAgentHubMcpToolsForRun<T extends { name: string }>(
  toolNames: readonly string[],
  tools: readonly T[],
): T[] {
  const isPlanStage = toolNames.includes(PLAN_TASKS_TOOL_NAME)
  if (!isPlanStage) {
    return tools.filter((entry) => getSdkMcpToolName(entry) !== PLAN_TASKS_TOOL_NAME)
  }
  return tools.filter((entry) => CLAUDE_PLAN_STAGE_AGENTHUB_TOOLS.has(getSdkMcpToolName(entry)))
}

function getSdkMcpToolName(entry: { name?: string }): string {
  return entry.name ?? ''
}

function recordClaudeSdkFileWrite(
  runId: string,
  workspace: WorkspaceRow,
  toolInput: Record<string, unknown> | undefined,
): void {
  const target = toolInputPath(toolInput)
  if (!target) return

  let absolutePath: string
  try {
    absolutePath = assertPathWithinWorkspace(workspace, target)
  } catch {
    return
  }

  let bytes = 0
  try {
    bytes = statSync(absolutePath).size
  } catch {
    bytes = Buffer.byteLength(readIfExists(workspace, target) ?? '', 'utf8')
  }

  recordRunFileWrite(runId, {
    path: target,
    absolutePath,
    bytes,
    applied: 'auto',
  })
}

// ─── canUseTool 桥 ────────────────────────────────────────

/**
 * 构造给 SDK 子进程的 env：
 *  - 配了 apiBaseUrl（第三方网关如 anyrouter）：设 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN，
 *    并清空 ANTHROPIC_API_KEY（避免 process env 覆盖 AUTH_TOKEN）
 *  - 只配了 apiKey：当 ANTHROPIC_API_KEY 传给 SDK
 *  - 都没配：透传 process.env，SDK fallback 到 env / ~/.claude OAuth
 */
function parseArtifactIdFromMcpResult(content: unknown): string | null {
  // MCP tool_result.content 可能是字符串 / 数组 of {type:'text', text} / object
  // 我们在 handler 里返回的是 [{type:'text', text: JSON.stringify(value)}]
  const tryParse = (s: string): string | null => {
    try {
      const obj = JSON.parse(s) as { artifactId?: unknown }
      return typeof obj.artifactId === 'string' ? obj.artifactId : null
    } catch {
      return null
    }
  }
  if (typeof content === 'string') return tryParse(content)
  if (Array.isArray(content)) {
    for (const blk of content) {
      if (blk && typeof blk === 'object' && 'text' in blk && typeof (blk as { text: unknown }).text === 'string') {
        const r = tryParse((blk as { text: string }).text)
        if (r) return r
      }
    }
  }
  return null
}

function parseDeploymentFromMcpResult(content: unknown): DeployStatusRecord | null {
  const tryParse = (s: string): DeployStatusRecord | null => {
    try {
      const obj = JSON.parse(s) as unknown
      return isDeployStatusRecord(obj) ? obj : null
    } catch {
      return null
    }
  }
  if (typeof content === 'string') return tryParse(content)
  if (Array.isArray(content)) {
    for (const blk of content) {
      if (blk && typeof blk === 'object' && 'text' in blk && typeof (blk as { text: unknown }).text === 'string') {
        const r = tryParse((blk as { text: string }).text)
        if (r) return r
      }
    }
  }
  return null
}

function isDeployStatusRecord(value: unknown): value is DeployStatusRecord {
  return (
    value !== null &&
    typeof value === 'object' &&
    'id' in value &&
    typeof (value as { id: unknown }).id === 'string' &&
    'artifactId' in value &&
    typeof (value as { artifactId: unknown }).artifactId === 'string' &&
    'previewPath' in value &&
    typeof (value as { previewPath: unknown }).previewPath === 'string' &&
    'status' in value &&
    ((value as { status: unknown }).status === 'ready' ||
      (value as { status: unknown }).status === 'failed') &&
    'createdAt' in value &&
    typeof (value as { createdAt: unknown }).createdAt === 'number'
  )
}

function buildSdkEnv(
  apiKey: string | null,
  apiBaseUrl: string | null,
): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = buildChildProcessEnv()
  if (apiBaseUrl) {
    return {
      ...base,
      ANTHROPIC_BASE_URL: apiBaseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey ?? '',
      ANTHROPIC_API_KEY: '',
    }
  }
  if (apiKey) {
    return { ...base, ANTHROPIC_API_KEY: apiKey }
  }
  return base
}

/**
 * 外部 MCP server → SDK 的 `mcpServers` 条目（specs/15-external-mcp.md）。
 * 纯形状翻译：DB 读取、`enabled` 过滤、`${ENV}` 展开都已在 L3 完成，adapter 不碰 DB。
 * stdio 的 `env` 不传时子进程继承 CLI 的环境（即 buildSdkEnv 的结果）。
 */
function toSdkMcpServers(
  servers: ResolvedMcpServer[] | undefined,
): Record<string, McpServerConfigForProcessTransport> {
  const map: Record<string, McpServerConfigForProcessTransport> = {}
  for (const s of servers ?? []) {
    if (s.transport === 'stdio') {
      map[s.name] = {
        type: 'stdio',
        command: s.command,
        args: s.args,
        ...(s.env ? { env: s.env } : {}),
      }
    } else {
      map[s.name] = {
        type: s.transport,
        url: s.url,
        ...(s.headers ? { headers: s.headers } : {}),
      }
    }
  }
  return map
}

interface PermissionCtx {
  workspace: WorkspaceRow
  approvalMode: 'auto' | 'review'
  input: AdapterInput
  signal: AbortSignal
  /** 本次 run 的 init 工具表；未到达时为 null（见 isShellTool 的失败关闭规则） */
  sdkToolNames: readonly string[] | null
}

async function bridgePermission(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: PermissionCtx,
): Promise<PermissionResult> {
  // SDK 的运行时 Zod schema 要求 allow 必带 updatedInput（TypeScript type 标 optional 但运行时必填）；
  // 无修改场景下回填原 input 即可。deny 必带 message。
  const allow = (updated: Record<string, unknown> = toolInput): PermissionResult => ({
    behavior: 'allow',
    updatedInput: updated,
  })
  const deny = (message: string): PermissionResult => ({ behavior: 'deny', message })

  // 1. 路径沙箱检查（Read/Write/Edit/NotebookEdit）
  if (PATH_TOOLS.has(toolName)) {
    const target = toolInputPath(toolInput)
    if (target) {
      try {
        assertPathWithinWorkspace(ctx.workspace, target)
      } catch (e) {
        return deny(e instanceof Error ? e.message : `Path is outside workspace: ${target}`)
      }
    }
  }

  // 2. shell 黑名单（工具名由 SDK 按平台提供：POSIX 为 Bash，Windows 为 PowerShell）
  if (isShellTool(toolName, toolInput, ctx.sdkToolNames)) {
    const cmd = typeof toolInput.command === 'string' ? toolInput.command : ''
    // 认得出是 shell 却读不出命令 → 失败关闭，不能落到默认放行
    if (!cmd.trim()) {
      return deny(`Unrecognized shell tool input for "${toolName}"; refusing to run it untracked.`)
    }
    const banned = findBannedPattern(cmd)
    if (banned) {
      return deny(`Command blocked by safety policy (matches ${banned}): ${cmd.slice(0, 100)}`)
    }
    const approval = classifyBashApproval(cmd, currentPlatform())
    if (approval.required) {
      const approved = await waitForBashApproval({
        conversationId: ctx.input.conversationId,
        agentId: ctx.input.agentId,
        runId: ctx.input.runId,
        command: cmd,
        cwd: getEffectiveCwd(ctx.workspace),
        reason: approval.reason,
        signal: ctx.signal,
      })
      if (!approved) return deny(`User rejected command execution: ${approval.reason}`)
    }
    return allow()
  }

  // 3. fs_write 审批 (Write / Edit)
  if (FS_WRITE_TOOLS.has(toolName)) {
    if (ctx.approvalMode === 'auto') return allow()
    const target = toolInputPath(toolInput)
    if (!target) return deny('Missing file_path/path')

    const oldContent = readIfExists(ctx.workspace, target)
    const newContent = computeNewContent(toolName, toolInput, oldContent)
    if (newContent instanceof Error) {
      return deny(newContent.message)
    }

    let absPath: string
    try {
      absPath = assertPathWithinWorkspace(ctx.workspace, target)
    } catch (e) {
      return deny(e instanceof Error ? e.message : 'Path outside workspace')
    }

    const pending = pendingWrites.register({
      conversationId: ctx.input.conversationId,
      agentId: ctx.input.agentId,
      runId: ctx.input.runId,
      path: target,
      absolutePath: absPath,
      oldContent,
      newContent,
      workspace: ctx.workspace,
      skipWrite: true, // SDK 自己写盘
    })

    const decision = await new Promise<{ applied: boolean }>((resolve) => {
      let settled = false
      const finish = (decision: { applied: boolean }) => {
        if (settled) return
        settled = true
        ctx.signal.removeEventListener('abort', onAbort)
        resolve(decision)
      }
      const onAbort = () => {
        pendingWrites.cancel(pending.id)
        finish({ applied: false })
      }

      pendingWrites.attachResolver(pending.id, finish)
      if (ctx.signal.aborted) onAbort()
      else ctx.signal.addEventListener('abort', onAbort, { once: true })
    })
    if (!decision.applied) {
      return deny('User rejected the file change')
    }
    return allow()
  }

  // 4. NotebookEdit：MVP 不支持审批 diff，直接 deny 让用户切 Auto
  if (toolName === 'NotebookEdit') {
    if (ctx.approvalMode === 'auto') return allow()
    return deny('NotebookEdit approval not yet supported in Review mode; switch to Auto mode.')
  }

  // 5. 外部 MCP 工具审批（specs/15-external-mcp.md，决策 §11.2）
  // 必须排在默认放行之前：`mcp__<server>__<tool>` 不匹配 1–4 任何一类，否则会静默执行第三方代码。
  if (isExternalMcpTool(toolName)) {
    const parsed = parseMcpToolName(toolName)
    // 解析不出 server 名 = 名字不来自已注册的 server（server 名校验禁止 `__`）。拒绝比放行安全。
    if (!parsed) return deny(`Unrecognized external MCP tool name: ${toolName}`)
    const trust = ctx.input.mcpServers?.find((s) => s.name === parsed.serverName)?.trust
    // trust='always' 显式放行；trust='ask' 且本会话已批准过同一工具则不再打扰。
    if (trust === 'always' || isToolApproved(ctx.input.conversationId, toolName)) return allow()
    const approved = await waitForMcpToolApproval({
      conversationId: ctx.input.conversationId,
      agentId: ctx.input.agentId,
      runId: ctx.input.runId,
      serverName: parsed.serverName,
      toolName,
      toolArgs: toolInput,
      signal: ctx.signal,
    })
    if (!approved) {
      return deny(
        `User rejected the external MCP tool call "${toolName}" (server "${parsed.serverName}"). ` +
          'Do not retry it; continue without it or ask the user how to proceed.',
      )
    }
    return allow()
  }

  // 6. 默认放行（Read / Grep / Glob / WebFetch / WebSearch / Task / TodoWrite / ...）
  return allow()
}

/** 把 Write/Edit 的输入转成「应用后的完整文件内容」用于 diff viewer。 */
function computeNewContent(
  toolName: string,
  input: Record<string, unknown>,
  oldContent: string | null,
): string | Error {
  if (toolName === 'Write') {
    return (input.content as string | undefined) ?? ''
  }
  if (toolName === 'Edit') {
    const old = (input.old_string as string | undefined) ?? ''
    const fresh = (input.new_string as string | undefined) ?? ''
    const all = !!input.replace_all
    if (oldContent === null) {
      return new Error('Edit requires an existing file (use Write to create)')
    }
    if (!all) {
      const count = oldContent.split(old).length - 1
      if (count === 0) {
        return new Error(`old_string not found in ${input.file_path}`)
      }
      if (count > 1) {
        return new Error(
          `old_string matches ${count} occurrences; use replace_all=true or include more context`,
        )
      }
    }
    return all ? oldContent.split(old).join(fresh) : oldContent.replace(old, fresh)
  }
  return new Error(`Unsupported write tool: ${toolName}`)
}
