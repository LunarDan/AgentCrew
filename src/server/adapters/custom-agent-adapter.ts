import { readFileSync } from 'node:fs'

import OpenAI from 'openai'

import { newMessageId } from '@/server/ids'
import { isToolApproved, waitForMcpToolApproval } from '@/server/mcp-approvals'
import { toolRegistry } from '@/server/tools/registry'
import type { ToolContext } from '@/server/tools/types'
import type { DeployStatusRecord, ModelProvider, StreamEvent } from '@/shared/types'

import {
  callMcpTool,
  closeMcpConnections,
  connectMcpServers,
  type ConnectedMcpServer,
  type ConnectMcpServersResult,
} from './custom-mcp-client'
import { buildMcpToolTable, type ExposedMcpTool } from './custom-mcp-tools'
import { resolveCustomProviderClientConfig } from './custom-provider-client'
import type { AdapterAttachment, AdapterInput, AgentPlatformAdapter } from './types'

/**
 * CustomAgentAdapter —— 自配置 Agent 的适配器。
 *
 * 通过 openai SDK 调用底层模型（OpenAI Chat Completions 兼容协议），
 * 自己实现 tool loop：流式拉模型输出 → 解析 tool_calls → 调用 ToolExecutor →
 * 把结果回灌到 messages → 续写下一轮，直到模型不再调工具。
 *
 * 详细规格见 specs/05-adapter-interface.md。
 */

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

interface AccumulatingToolCall {
  id: string
  name: string
  argsBuffer: string
}

/** 防止单条 user message 塞太多图片（token 爆炸 + provider 通常有上限） */
const MAX_IMAGES_PER_MESSAGE = 5

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

    const client = buildClient(modelProvider, apiKey, input.apiBaseUrl)

    const toolDefs = toolRegistry.resolve(input.toolNames)
    const mcpToolTable = buildMcpToolTable({
      servers: input.mcpServers ?? [],
      toolsByServer: new Map(mcp.servers.map((server) => [server.server.name, server.tools])),
      reservedNames: toolDefs.map((tool) => tool.name),
    })
    const connectionsByName = new Map(
      mcp.servers.map((connection) => [connection.server.name, connection]),
    )
    const apiTools = [
      ...toolDefs.map(toApiTool),
      ...mcpToolTable.tools.map(toMcpApiTool),
    ]

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
    // 跨 turn 累加 token 用量；run 结束前 yield run.usage 给 AgentRunner 落库
    const runUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      lastInputTokens: 0,
    }

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
        yield baseEvent(input, { type: 'message.end', messageId })
        throw err
      }

      let finishReason: string | null = null
      // 本 turn 单条 message 的 usage（per-message）；与 runUsage 同时维护
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
          runUsage.inputTokens += inp
          runUsage.outputTokens += out
          runUsage.cacheReadTokens += cached
          runUsage.lastInputTokens = inp
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

        if (choice.finish_reason) finishReason = choice.finish_reason
      }

      if (thinkingPartIndex >= 0) {
        yield baseEvent(input, { type: 'part.end', messageId, partIndex: thinkingPartIndex })
      }
      if (textPartIndex >= 0) {
        yield baseEvent(input, { type: 'part.end', messageId, partIndex: textPartIndex })
      }

      const toolCalls = Array.from(toolCallBuffer.values()).filter((tc) => tc.id && tc.name)

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

      if (toolCalls.length === 0 || finishReason === 'stop') {
        if (msgUsage.inputTokens > 0 || msgUsage.outputTokens > 0) {
          yield baseEvent(input, { type: 'message.usage', messageId, usage: msgUsage })
        }
        yield baseEvent(input, { type: 'message.end', messageId })
        yield baseEvent(input, {
          type: 'run.usage',
          runId: input.runId,
          usage: { ...runUsage, model: modelId },
        })
        return
      }

      // 执行工具
      for (const tc of toolCalls) {
        let args: unknown
        try {
          args = tc.argsBuffer ? JSON.parse(tc.argsBuffer) : {}
        } catch {
          args = {}
        }

        yield baseEvent(input, {
          type: 'tool.call',
          messageId,
          callId: tc.id,
          toolName: tc.name,
          args,
        })

        const mcpTool = mcpToolTable.byExposedName.get(tc.name)
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
          const result = await toolRegistry.execute(tc.name, args, ctx)
          toolOk = result.ok
          value = result.ok ? result.value : { error: result.error }
        }

        yield baseEvent(input, {
          type: 'tool.result',
          messageId,
          callId: tc.id,
          result: value,
          isError: !toolOk,
        })

        // 工具结果含 artifactId 视为「创建了产物」的约定，统一由 adapter 发布
        // artifact.create 事件，让上层 AgentRunner 注入 artifact_ref part。
        if (tc.name === 'write_artifact' && toolOk && hasArtifactId(value)) {
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
          (tc.name === 'deploy_artifact' || tc.name === 'deploy_workspace') &&
          toolOk &&
          isDeployStatusRecord(value)
        ) {
          yield baseEvent(input, {
            type: 'deploy.status',
            messageId,
            deployment: value,
          })
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(value),
        })
      }

      if (msgUsage.inputTokens > 0 || msgUsage.outputTokens > 0) {
        yield baseEvent(input, { type: 'message.usage', messageId, usage: msgUsage })
      }
      yield baseEvent(input, { type: 'message.end', messageId })
      // 继续下一轮
    }
    // 到达 MAX_TURNS 兜底：把累计 usage emit 一下（正常路径在 line 232 已 emit 过 + return）
    yield baseEvent(input, {
      type: 'run.usage',
      runId: input.runId,
      usage: { ...runUsage, model: modelId },
    })
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

/**
 * 构造 OpenAI 风格的多模态 user message content：
 *   [{ type: 'text', text: ... }, { type: 'image_url', image_url: { url: 'data:...' } }, ...]
 *
 * DeepSeek 兼容 OpenAI schema；Anthropic 的 image block 形态不同，目前 CustomAgentAdapter
 * 走 openai SDK + OpenAI-compatible endpoint，先只支持这一套。
 */
function buildMultimodalUserContent(
  prompt: string,
  images: AdapterAttachment[],
): OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  const blocks: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: 'text', text: prompt },
  ]
  for (const img of images) {
    try {
      const data = readFileSync(img.absPath).toString('base64')
      blocks.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.mimeType};base64,${data}`,
        },
      })
    } catch (err) {
      console.warn('[CustomAgentAdapter] failed to read image', img.absPath, err)
    }
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
