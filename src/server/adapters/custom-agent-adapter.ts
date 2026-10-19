import { readFileSync } from 'node:fs'

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

import { newMessageId } from '@/server/ids'
import { isToolApproved, waitForMcpToolApproval } from '@/server/mcp-approvals'
import { toolRegistry } from '@/server/tools/registry'
import type { ToolContext, ToolDef } from '@/server/tools/types'
import type { DeployStatusRecord, ModelProvider, StreamEvent } from '@/shared/types'

import {
  callMcpTool,
  closeMcpConnections,
  connectMcpServers,
  type ConnectedMcpServer,
  type ConnectMcpServersResult,
} from './custom-mcp-client'
import { buildMcpToolTable, type ExposedMcpTool, type McpToolTable } from './custom-mcp-tools'
import { resolveCustomProviderClientConfig } from './custom-provider-client'
import type { AdapterAttachment, AdapterInput, AgentPlatformAdapter } from './types'

/**
 * CustomAgentAdapter —— 自配置 Agent 的适配器。
 *
 * OpenAI 兼容 provider 走 Chat Completions；Anthropic provider 走 Messages API。
 * 两条路径共用同一套 AgentHub 工具表与 tool loop：流式拉模型输出 → 解析工具调用 →
 * 调用 ToolExecutor → 把结果回灌 → 续写，直到模型不再调工具。
 *
 * 详细规格见 specs/05-adapter-interface.md。
 */

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

interface AccumulatingToolCall {
  id: string
  name: string
  argsBuffer: string
}

interface ToolCallOutcome {
  ok: boolean
  value: unknown
}

/** 防止单条 user message 塞太多图片（token 爆炸 + provider 通常有上限） */
const MAX_IMAGES_PER_MESSAGE = 5
const ANTHROPIC_MAX_TOKENS = 8192
/** 各家 vision 接口共同支持的格式；不支持的格式直接跳过，避免 provider 400 掉整个 run */
const SUPPORTED_VISION_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
/** 原图字节上限；base64 会再膨胀 4/3，太大的图跳过而不是把请求撑爆 */
const MAX_VISION_IMAGE_BYTES = 5 * 1024 * 1024
type AnthropicImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

export class CustomAgentAdapter implements AgentPlatformAdapter {
  readonly name = 'custom' as const

  async *stream(input: AdapterInput, signal: AbortSignal): AsyncIterable<StreamEvent> {
    if (!input.customConfig) {
      throw new Error('CustomAgentAdapter requires customConfig')
    }
    if (!input.modelId) {
      throw new Error('CustomAgentAdapter requires modelId')
    }

    // 外部 MCP 连接必须早于 message.start：连接失败只降级为事件，不打断 run（spec 15 §6.4）。
    const mcp = await connectMcpServers(input.mcpServers ?? [], {
      signal,
      workspacePath: input.workspacePath,
    })
    try {
      if (mcp.unavailable.length > 0) {
        yield baseEvent(input, {
          type: 'mcp_server.unavailable',
          runId: input.runId,
          servers: mcp.unavailable,
        })
      }
      if (signal.aborted) return
      yield* this.runToolLoop(input, signal, mcp)
    } finally {
      // 正常结束 / abort / 抛错都走这里，避免泄漏 stdio 子进程。
      await closeMcpConnections(mcp.servers)
    }
  }

  private async *runToolLoop(
    input: AdapterInput,
    signal: AbortSignal,
    mcp: ConnectMcpServersResult,
  ): AsyncIterable<StreamEvent> {
    const customConfig = input.customConfig
    if (!customConfig) {
      throw new Error('CustomAgentAdapter requires customConfig')
    }
    const { modelProvider, supportsVision } = customConfig
    const modelId = input.modelId
    if (!modelId) {
      throw new Error('CustomAgentAdapter requires modelId')
    }
    const systemPrompt = input.systemPrompt
    const apiKey = input.apiKey

    const toolDefs = toolRegistry.resolve(input.toolNames)
    const mcpToolTable = buildMcpToolTable({
      servers: input.mcpServers ?? [],
      toolsByServer: new Map(mcp.servers.map((server) => [server.server.name, server.tools])),
      reservedNames: toolDefs.map((tool) => tool.name),
    })
    const connectionsByName = new Map(
      mcp.servers.map((connection) => [connection.server.name, connection]),
    )

    const ctx: ToolContext = {
      conversationId: input.conversationId,
      workspacePath: input.workspacePath,
      agentId: input.agentId,
      runId: input.runId,
      abortSignal: signal,
    }

    // 构造 user message content：若 agent 声明 vision + 实际有图片，走 multimodal blocks
    const imageAttachments =
      input.attachments?.filter((a) => a.kind === 'image').slice(0, MAX_IMAGES_PER_MESSAGE) ?? []

    if (modelProvider === 'anthropic') {
      yield* this.runAnthropicToolLoop(input, signal, ctx, toolDefs, mcpToolTable, connectionsByName)
      return
    }

    const client = buildClient(modelProvider, apiKey, input.apiBaseUrl)
    const apiTools = [
      ...toolDefs.map(toApiTool),
      ...mcpToolTable.tools.map(toMcpApiTool),
    ]

    const useMultimodal = !!supportsVision && imageAttachments.length > 0

    const userContent: ChatMessage['content'] = useMultimodal
      ? buildMultimodalUserContent(input.prompt, imageAttachments)
      : input.prompt

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      // 跨 run 历史：spec 13 序列化的对话上下文。空数组时行为与旧版一致（向后兼容）。
      ...(input.history ?? []),
      { role: 'user', content: userContent },
    ]

    const MAX_TURNS = 8
    let turn = 0

    while (turn < MAX_TURNS) {
      if (signal.aborted) return
      turn++

      const messageId = newMessageId()
      yield baseEvent(input, {
        type: 'message.start',
        messageId,
        agentId: input.agentId,
        runId: input.runId,
      })

      let textPartIndex = -1
      let textBuffer = ''
      let thinkingPartIndex = -1
      let reasoningBuffer = ''
      let nextPartIndex = 0
      const toolCallBuffer = new Map<number, AccumulatingToolCall>()

      let stream: Awaited<ReturnType<typeof client.chat.completions.create>>
      try {
        stream = await client.chat.completions.create(
          {
            model: modelId,
            messages,
            tools: apiTools.length > 0 ? apiTools : undefined,
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal },
        )
      } catch (err) {
        // 请求没有建立起来：不要发出 message.end，否则会在会话里留下一条空的 complete 消息。
        throw err
      }

      // 本 turn 单条 message 的 usage（per-message）
      const msgUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }

      for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
        if (signal.aborted) return
        // Final usage chunk (stream_options.include_usage)：choices 通常空，只携 usage。
        // DeepSeek 还附带 prompt_cache_hit_tokens / prompt_cache_miss_tokens。
        const usage = (chunk as { usage?: Record<string, number> | null }).usage
        if (usage) {
          const inp = usage.prompt_tokens ?? 0
          const out = usage.completion_tokens ?? 0
          const cached = usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0
          msgUsage.inputTokens += inp
          msgUsage.outputTokens += out
          msgUsage.cacheReadTokens += cached
        }
        const choice = chunk.choices[0]
        if (!choice) continue
        // DeepSeek V4/R1 等 thinking-mode 模型在 delta 上加了 reasoning_content
        // 字段，OpenAI SDK 的官方类型不含，这里宽放成扩展形态。
        const delta = choice.delta as OpenAI.Chat.Completions.ChatCompletionChunk['choices'][number]['delta'] & {
          reasoning_content?: string
        }

        // —— reasoning_content (thinking mode) —— 先 yield 出来让 UI 渲染 thinking part
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          if (thinkingPartIndex < 0) {
            thinkingPartIndex = nextPartIndex++
            yield baseEvent(input, {
              type: 'part.start',
              messageId,
              partIndex: thinkingPartIndex,
              part: { type: 'thinking', content: '' },
            })
          }
          reasoningBuffer += delta.reasoning_content
          yield baseEvent(input, {
            type: 'part.delta',
            messageId,
            partIndex: thinkingPartIndex,
            delta: { type: 'thinking.append', text: delta.reasoning_content },
          })
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          if (textPartIndex < 0) {
            textPartIndex = nextPartIndex++
            yield baseEvent(input, {
              type: 'part.start',
              messageId,
              partIndex: textPartIndex,
              part: { type: 'text', content: '' },
            })
          }
          textBuffer += delta.content
          yield baseEvent(input, {
            type: 'part.delta',
            messageId,
            partIndex: textPartIndex,
            delta: { type: 'text.append', text: delta.content },
          })
        }

        if (delta.tool_calls) {
          for (const tcd of delta.tool_calls) {
            const idx = tcd.index
            let entry = toolCallBuffer.get(idx)
            if (!entry) {
              entry = { id: '', name: '', argsBuffer: '' }
              toolCallBuffer.set(idx, entry)
            }
            if (tcd.id) entry.id = tcd.id
            if (tcd.function?.name) entry.name = tcd.function.name
            if (tcd.function?.arguments) entry.argsBuffer += tcd.function.arguments
          }
        }

      }

      if (thinkingPartIndex >= 0) {
        yield baseEvent(input, { type: 'part.end', messageId, partIndex: thinkingPartIndex })
      }
      if (textPartIndex >= 0) {
        yield baseEvent(input, { type: 'part.end', messageId, partIndex: textPartIndex })
      }

      const toolCalls = Array.from(toolCallBuffer.values()).filter((tc) => tc.id && tc.name)

      // 本 turn 的 usage 必须在执行工具之前发出：plan 阶段会在 plan_tasks 的
      // tool.call 处停下来，之后再发就永远发不出去。AgentRunner 按 runId 累加。
      if (msgUsage.inputTokens > 0 || msgUsage.outputTokens > 0) {
        yield baseEvent(input, { type: 'message.usage', messageId, usage: msgUsage })
        yield baseEvent(input, {
          type: 'run.usage',
          runId: input.runId,
          usage: {
            inputTokens: msgUsage.inputTokens,
            outputTokens: msgUsage.outputTokens,
            cacheCreationTokens: 0,
            cacheReadTokens: msgUsage.cacheReadTokens,
            lastInputTokens: msgUsage.inputTokens,
            model: modelId,
          },
        })
      }

      // 写回 assistant message
      // DeepSeek thinking-mode 模型要求把 reasoning_content 一起回传到下一轮，
      // 否则 API 返回 "The reasoning_content in the thinking mode must be passed back".
      // OpenAI SDK 类型不识 reasoning_content，用扩展 cast。
      const assistantMsg = {
        role: 'assistant' as const,
        content: textBuffer || null,
        tool_calls:
          toolCalls.length > 0
            ? toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.argsBuffer || '{}' },
              }))
            : undefined,
        ...(reasoningBuffer ? { reasoning_content: reasoningBuffer } : {}),
      }
      messages.push(assistantMsg as ChatMessage)

      // 只按「有没有工具调用」判断结束：有些 provider 在带 tool_calls 时也会给 finish_reason = 'stop'，
      // 不能因此丢掉已经累积的工具调用。
      if (toolCalls.length === 0) {
        yield baseEvent(input, { type: 'message.end', messageId })
        return
      }

      // 执行工具
      for (const tc of toolCalls) {
        if (signal.aborted) return
        let args: unknown
        try {
          args = tc.argsBuffer ? JSON.parse(tc.argsBuffer) : {}
        } catch {
          args = {}
        }

        const outcome = yield* this.runToolCall({
          input,
          messageId,
          callId: tc.id,
          toolName: tc.name,
          args,
          mcpToolTable,
          connectionsByName,
          ctx,
          signal,
        })

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(outcome.value),
        })
      }

      if (signal.aborted) return
      yield baseEvent(input, { type: 'message.end', messageId })
      // 继续下一轮
    }

    throw new Error(`Tool-turn limit reached after ${MAX_TURNS} turns; the model was still requesting tools`)
  }

  /** 执行一次工具调用，产出 tool.call / tool.result 与产物副作用事件；两条 provider 循环共用。 */
  private async *runToolCall(params: {
    input: AdapterInput
    messageId: string
    callId: string
    toolName: string
    args: unknown
    mcpToolTable: McpToolTable
    connectionsByName: Map<string, ConnectedMcpServer>
    ctx: ToolContext
    signal: AbortSignal
  }): AsyncGenerator<StreamEvent, ToolCallOutcome> {
    const { input, messageId, callId, toolName, args, mcpToolTable, connectionsByName, ctx, signal } =
      params

    yield baseEvent(input, { type: 'tool.call', messageId, callId, toolName, args })

    const mcpTool = mcpToolTable.byExposedName.get(toolName)
    let toolOk: boolean
    let value: unknown
    if (mcpTool) {
      const outcome = await executeMcpTool(mcpTool, args, {
        input,
        signal,
        connection: connectionsByName.get(mcpTool.serverName),
      })
      toolOk = outcome.ok
      value = outcome.value
    } else {
      const result = await toolRegistry.execute(toolName, args, ctx)
      toolOk = result.ok
      value = result.ok ? result.value : { error: result.error }
    }

    yield baseEvent(input, {
      type: 'tool.result',
      messageId,
      callId,
      result: value,
      isError: !toolOk,
    })

    // 工具结果含 artifactId 视为「创建了产物」的约定，统一由 adapter 发布
    // artifact.create 事件，让上层 AgentRunner 注入 artifact_ref part。
    if (toolName === 'write_artifact' && toolOk && hasArtifactId(value)) {
      const artifactId = (value as { artifactId: string }).artifactId
      const { db, schema } = await import('@/db/client')
      const { eq } = await import('drizzle-orm')
      const artifact = await db.query.artifacts.findFirst({
        where: eq(schema.artifacts.id, artifactId),
      })
      if (artifact) {
        yield baseEvent(input, {
          type: 'artifact.create',
          artifact: {
            id: artifact.id,
            conversationId: artifact.conversationId,
            type: artifact.type,
            title: artifact.title,
            content: artifact.content,
            version: artifact.version,
            parentArtifactId: artifact.parentArtifactId ?? undefined,
            createdByAgentId: artifact.createdByAgentId,
            createdAt: artifact.createdAt,
          },
        })
      }
    }

    if (
      (toolName === 'deploy_artifact' || toolName === 'deploy_workspace') &&
      toolOk &&
      isDeployStatusRecord(value)
    ) {
      yield baseEvent(input, { type: 'deploy.status', messageId, deployment: value })
    }

    return { ok: toolOk, value }
  }

  /** Anthropic Messages API：内容块 / tool_use 与 OpenAI tool_calls 的形状不同，其余语义一致。 */
  private async *runAnthropicToolLoop(
    input: AdapterInput,
    signal: AbortSignal,
    ctx: ToolContext,
    toolDefs: ToolDef[],
    mcpToolTable: McpToolTable,
    connectionsByName: Map<string, ConnectedMcpServer>,
  ): AsyncIterable<StreamEvent> {
    const modelId = input.modelId
    if (!modelId) throw new Error('CustomAgentAdapter requires modelId')
    const clientConfig = resolveCustomProviderClientConfig('anthropic', input.apiKey, input.apiBaseUrl)
    const client = new Anthropic({
      apiKey: clientConfig.apiKey,
      baseURL: clientConfig.baseURL,
      maxRetries: MAX_API_RETRIES,
    })

    const tools: Anthropic.Tool[] = [
      ...toolDefs.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters as Anthropic.Tool.InputSchema,
      })),
      ...mcpToolTable.tools.map((tool) => ({
        name: tool.exposedName,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
      })),
    ]

    const images = input.customConfig?.supportsVision
      ? (input.attachments?.filter((a) => a.kind === 'image').slice(0, MAX_IMAGES_PER_MESSAGE) ?? [])
      : []
    const userBlocks = buildAnthropicUserContent(input.prompt, images)

    const messages = toAnthropicMessages(input.history ?? [])
    const lastMessage = messages[messages.length - 1]
    if (lastMessage && lastMessage.role === 'user') {
      lastMessage.content = [...toAnthropicBlocks(lastMessage.content), ...userBlocks]
    } else {
      messages.push({ role: 'user', content: userBlocks })
    }

    const MAX_TURNS = 8
    let turn = 0

    while (turn < MAX_TURNS) {
      if (signal.aborted) return
      turn++

      const messageId = newMessageId()
      yield baseEvent(input, {
        type: 'message.start',
        messageId,
        agentId: input.agentId,
        runId: input.runId,
      })

      let nextPartIndex = 0
      const textBlocks = new Map<number, { partIndex: number; text: string }>()
      const thinkingBlocks = new Map<number, { partIndex: number; text: string }>()
      const toolBlocks = new Map<number, { id: string; name: string; json: string }>()
      let stopReason: string | null = null
      const msgUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
      let cacheCreationTokens = 0

      const stream = client.messages.stream(
        {
          model: modelId,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          system: input.systemPrompt || undefined,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
        },
        { signal },
      )

      for await (const event of stream) {
        if (signal.aborted) return
        switch (event.type) {
          case 'message_start': {
            const usage = event.message.usage
            msgUsage.inputTokens = usage.input_tokens
            msgUsage.cacheReadTokens = usage.cache_read_input_tokens ?? 0
            cacheCreationTokens = usage.cache_creation_input_tokens ?? 0
            break
          }
          case 'content_block_start': {
            const block = event.content_block
            if (block.type === 'text') {
              const partIndex = nextPartIndex++
              textBlocks.set(event.index, { partIndex, text: '' })
              yield baseEvent(input, {
                type: 'part.start',
                messageId,
                partIndex,
                part: { type: 'text', content: '' },
              })
            } else if (block.type === 'thinking') {
              const partIndex = nextPartIndex++
              thinkingBlocks.set(event.index, { partIndex, text: '' })
              yield baseEvent(input, {
                type: 'part.start',
                messageId,
                partIndex,
                part: { type: 'thinking', content: '' },
              })
            } else if (block.type === 'tool_use') {
              toolBlocks.set(event.index, { id: block.id, name: block.name, json: '' })
            }
            break
          }
          case 'content_block_delta': {
            const delta = event.delta
            if (delta.type === 'text_delta') {
              const block = textBlocks.get(event.index)
              if (block) {
                block.text += delta.text
                yield baseEvent(input, {
                  type: 'part.delta',
                  messageId,
                  partIndex: block.partIndex,
                  delta: { type: 'text.append', text: delta.text },
                })
              }
            } else if (delta.type === 'thinking_delta') {
              const block = thinkingBlocks.get(event.index)
              if (block) {
                block.text += delta.thinking
                yield baseEvent(input, {
                  type: 'part.delta',
                  messageId,
                  partIndex: block.partIndex,
                  delta: { type: 'thinking.append', text: delta.thinking },
                })
              }
            } else if (delta.type === 'input_json_delta') {
              const block = toolBlocks.get(event.index)
              if (block) block.json += delta.partial_json
            }
            break
          }
          case 'content_block_stop': {
            const text = textBlocks.get(event.index)
            if (text) {
              yield baseEvent(input, { type: 'part.end', messageId, partIndex: text.partIndex })
            }
            const thinking = thinkingBlocks.get(event.index)
            if (thinking) {
              yield baseEvent(input, { type: 'part.end', messageId, partIndex: thinking.partIndex })
            }
            break
          }
          case 'message_delta': {
            stopReason = event.delta.stop_reason ?? stopReason
            msgUsage.outputTokens = event.usage.output_tokens
            break
          }
        }
      }

      const assistantContent: Anthropic.ContentBlockParam[] = []
      for (const block of textBlocks.values()) {
        if (block.text) assistantContent.push({ type: 'text', text: block.text })
      }
      const toolUses: Array<{ id: string; name: string; input: unknown }> = []
      for (const block of toolBlocks.values()) {
        if (!block.id || !block.name) continue
        let parsed: unknown = {}
        try {
          parsed = block.json ? JSON.parse(block.json) : {}
        } catch {
          parsed = {}
        }
        toolUses.push({ id: block.id, name: block.name, input: parsed })
        assistantContent.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: parsed as Anthropic.ToolUseBlockParam['input'],
        })
      }
      if (assistantContent.length > 0) {
        messages.push({ role: 'assistant', content: assistantContent })
      }

      if (msgUsage.inputTokens > 0 || msgUsage.outputTokens > 0) {
        yield baseEvent(input, { type: 'message.usage', messageId, usage: msgUsage })
        // 每 turn 报告增量；必须在执行工具前发出（plan 阶段会在 tool.call 处停下）。
        yield baseEvent(input, {
          type: 'run.usage',
          runId: input.runId,
          usage: {
            inputTokens: msgUsage.inputTokens,
            outputTokens: msgUsage.outputTokens,
            cacheCreationTokens,
            cacheReadTokens: msgUsage.cacheReadTokens,
            lastInputTokens: msgUsage.inputTokens + msgUsage.cacheReadTokens + cacheCreationTokens,
            model: modelId,
          },
        })
      }

      if (toolUses.length === 0 || stopReason !== 'tool_use') {
        yield baseEvent(input, { type: 'message.end', messageId })
        return
      }

      // tool.call / tool.result 属于本条 assistant 消息：必须在 message.end 之前发出，
      // 否则 runner 会先清掉 currentMessageId，后续 part 落不到已结束的消息上。
      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const use of toolUses) {
        if (signal.aborted) return
        const outcome = yield* this.runToolCall({
          input,
          messageId,
          callId: use.id,
          toolName: use.name,
          args: use.input,
          mcpToolTable,
          connectionsByName,
          ctx,
          signal,
        })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: serializeToolResult(outcome.value),
          ...(outcome.ok ? {} : { is_error: true }),
        })
      }
      messages.push({ role: 'user', content: toolResults })
      if (signal.aborted) return
      yield baseEvent(input, { type: 'message.end', messageId })
    }

    throw new Error(`Tool-turn limit reached after ${MAX_TURNS} turns; the model was still requesting tools`)
  }
}

// ─── 辅助 ────────────────────────────────────────────────

/**
 * OpenAI SDK 默认 maxRetries=2，对 408 / 429 / >= 500 / APIConnectionError 自动指数退避重试。
 * 这里显式声明同样的 2 次重试，让 spec 05 §「错误处理」承诺的「网络/速率限制重试」在代码层
 * 可见且可调（未来按 provider 调整时只动这一个常量）。
 *
 * 注意：重试只对「初始连接」生效；stream 一旦开始 emit chunks 就不会再重试。
 */
const MAX_API_RETRIES = 2

function buildClient(
  provider: ModelProvider,
  overrideKey?: string | null,
  apiBaseUrl?: string | null,
): OpenAI {
  return new OpenAI({
    ...resolveCustomProviderClientConfig(provider, overrideKey, apiBaseUrl),
    maxRetries: MAX_API_RETRIES,
  })
}

function toApiTool(t: {
  name: string
  description: string
  parameters: Record<string, unknown>
}): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }
}

function toMcpApiTool(t: ExposedMcpTool): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: t.exposedName,
      description: t.description || `External MCP tool ${t.serverName}/${t.toolName}`,
      parameters: t.inputSchema,
    },
  }
}

/** 审批门与调用都在这里：被拒 / server 已断开 / 调用失败都变成 isError 结果，不中断 loop。 */
async function executeMcpTool(
  tool: ExposedMcpTool,
  args: unknown,
  deps: {
    input: AdapterInput
    signal: AbortSignal
    connection: ConnectedMcpServer | undefined
  },
): Promise<{ ok: boolean; value: unknown }> {
  const { input, signal, connection } = deps

  if (tool.trust === 'ask' && !isToolApproved(input.conversationId, tool.exposedName)) {
    const approved = await waitForMcpToolApproval({
      conversationId: input.conversationId,
      agentId: input.agentId,
      runId: input.runId,
      serverName: tool.serverName,
      toolName: tool.exposedName,
      toolArgs: args,
      signal,
    })
    if (!approved) {
      return {
        ok: false,
        value: {
          error: `User rejected the external MCP tool call "${tool.exposedName}" (server "${tool.serverName}"). Do not retry it; continue without it or ask the user how to proceed.`,
        },
      }
    }
  }

  if (!connection) {
    return {
      ok: false,
      value: { error: `External MCP server "${tool.serverName}" is not connected.` },
    }
  }

  return callMcpTool(connection, tool.toolName, args, signal)
}

function hasArtifactId(value: unknown): value is { artifactId: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'artifactId' in value &&
    typeof (value as { artifactId: unknown }).artifactId === 'string'
  )
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

/** 把历史消息的 content 归一成 Anthropic content block 数组，便于在当前 user message 上追加图片。 */
function toAnthropicBlocks(content: Anthropic.MessageParam['content']): Anthropic.ContentBlockParam[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

function extractHistoryText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (
        part &&
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string'
      ) {
        return part.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** OpenAI ChatMessage → Anthropic MessageParam：只保留 user/assistant 文本，合并连续同角色。 */
export function toAnthropicMessages(history: ChatMessage[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = []
  for (const message of history) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = extractHistoryText(message.content)
    if (!text) continue
    // Anthropic 要求首条是 user；用户视角的历史一般也以 user 开头。
    if (messages.length === 0 && message.role === 'assistant') continue
    const last = messages[messages.length - 1]
    if (last && last.role === message.role) {
      const previous =
        typeof last.content === 'string' ? last.content : extractHistoryText(last.content)
      last.content = previous ? `${previous}\n\n${text}` : text
    } else {
      messages.push({ role: message.role, content: text })
    }
  }
  return messages
}

function buildAnthropicUserContent(
  prompt: string,
  images: AdapterAttachment[],
): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [{ type: 'text', text: prompt }]
  for (const img of images) {
    const loaded = readVisionImage(img)
    if (!loaded) continue
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: loaded.mimeType as AnthropicImageMediaType,
        data: loaded.base64,
      },
    })
  }
  return blocks
}

/** 读图前先过格式 + 体积；不满足的图直接跳过（附 warn），调用方无需再判。 */
function readVisionImage(img: AdapterAttachment): { mimeType: string; base64: string } | null {
  if (!SUPPORTED_VISION_IMAGE_TYPES.has(img.mimeType)) {
    console.warn(`[CustomAgentAdapter] skip image with unsupported mime type ${img.mimeType}`)
    return null
  }
  try {
    const buf = readFileSync(img.absPath)
    if (buf.byteLength > MAX_VISION_IMAGE_BYTES) {
      console.warn(
        `[CustomAgentAdapter] skip image ${buf.byteLength} bytes > ${MAX_VISION_IMAGE_BYTES}`,
        img.absPath,
      )
      return null
    }
    return { mimeType: img.mimeType, base64: buf.toString('base64') }
  } catch (err) {
    console.warn('[CustomAgentAdapter] failed to read image', img.absPath, err)
    return null
  }
}

function serializeToolResult(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * 构造 OpenAI 风格的多模态 user message content：
 *   [{ type: 'text', text: ... }, { type: 'image_url', image_url: { url: 'data:...' } }, ...]
 *
 * DeepSeek / 火山方舟 / OpenAI-compatible 都兼容这套 schema；Anthropic 走
 * buildAnthropicUserContent 的 image block。
 */
function buildMultimodalUserContent(
  prompt: string,
  images: AdapterAttachment[],
): OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  const blocks: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: 'text', text: prompt },
  ]
  for (const img of images) {
    const loaded = readVisionImage(img)
    if (!loaded) continue
    blocks.push({
      type: 'image_url',
      image_url: {
        url: `data:${loaded.mimeType};base64,${loaded.base64}`,
      },
    })
  }
  return blocks
}

function baseEvent<T extends Omit<StreamEvent, 'conversationId' | 'timestamp'>>(
  input: AdapterInput,
  body: T,
): StreamEvent {
  return {
    ...body,
    conversationId: input.conversationId,
    timestamp: Date.now(),
  } as StreamEvent
}
