import { createHash } from 'node:crypto'

import type { McpTrust, ResolvedMcpServer } from '@/shared/types'

/**
 * 把外部 MCP 工具翻译成 OpenAI function-calling 的纯函数集合。
 *
 * 暴露名必须满足 `^[A-Za-z0-9_-]{1,64}$`（OpenAI 兼容 provider 的共同约束），
 * 而 server/tool 名未必满足；路由**不反解析**暴露名，而是用这里的运行期表回到原始名。
 */

/** OpenAI-compatible function name 上限。 */
const MAX_FUNCTION_NAME_LENGTH = 64

/** 单条工具结果回灌给模型的上限，避免一条消息撑爆上下文。 */
export const MAX_TOOL_RESULT_CHARS = 50_000

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ExposedMcpTool {
  exposedName: string
  serverName: string
  toolName: string
  description: string
  inputSchema: Record<string, unknown>
  trust: McpTrust
}

export interface McpToolTable {
  tools: ExposedMcpTool[]
  byExposedName: Map<string, ExposedMcpTool>
}

export function sanitizeFunctionNamePart(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * 冲突或超长时追加 `_<hash>`：保留可读前缀，同时让同名/截断后的名字仍然唯一。
 * hash 基于原始 server/tool，避免两个不同工具截断成同一前缀后互相覆盖。
 */
export function buildExposedToolName(
  serverName: string,
  toolName: string,
  isTaken: (candidate: string) => boolean,
): string {
  const base = `mcp__${sanitizeFunctionNamePart(serverName) || 'server'}__${
    sanitizeFunctionNamePart(toolName) || 'tool'
  }`
  if (base.length <= MAX_FUNCTION_NAME_LENGTH && !isTaken(base)) return base

  for (let attempt = 0; ; attempt++) {
    const digest = createHash('sha256')
      .update(`${serverName}\u0000${toolName}\u0000${attempt}`)
      .digest('hex')
      .slice(0, 8)
    const suffix = `_${digest}`
    const candidate = `${base.slice(0, MAX_FUNCTION_NAME_LENGTH - suffix.length)}${suffix}`
    if (!isTaken(candidate)) return candidate
  }
}

/**
 * `reservedNames` 是内置工具名：内置工具优先，外部工具在冲突时改用 hash 名。
 */
export function buildMcpToolTable(args: {
  servers: readonly ResolvedMcpServer[]
  toolsByServer: ReadonlyMap<string, readonly McpToolDefinition[]>
  reservedNames?: readonly string[]
}): McpToolTable {
  const used = new Set<string>(args.reservedNames ?? [])
  const tools: ExposedMcpTool[] = []
  const byExposedName = new Map<string, ExposedMcpTool>()

  for (const server of args.servers) {
    for (const tool of args.toolsByServer.get(server.name) ?? []) {
      const exposedName = buildExposedToolName(server.name, tool.name, (candidate) =>
        used.has(candidate),
      )
      used.add(exposedName)
      const exposed: ExposedMcpTool = {
        exposedName,
        serverName: server.name,
        toolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        trust: server.trust,
      }
      tools.push(exposed)
      byExposedName.set(exposedName, exposed)
    }
  }

  return { tools, byExposedName }
}

/**
 * MCP `CallToolResult` → 回灌给模型的紧凑值。
 *
 * 优先 `structuredContent`（MCP 2025-06-18 起的结构化结果）；否则拼接 content。
 * image/audio 的 base64 与 resource 的 blob **不内联**，否则一张图就能塞进几十 MB token。
 */
export function mcpResultToValue(result: unknown): unknown {
  if (!isRecord(result)) return clampToolResult(result)

  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return clampToolResult(result.structuredContent)
  }

  const content = result.content
  if (!Array.isArray(content)) return clampToolResult(result)

  const values: unknown[] = content.map(contentItemToValue)
  if (values.length === 0) return ''
  if (values.every((value): value is string => typeof value === 'string')) {
    return clampToolResult(values.join('\n'))
  }
  return clampToolResult(values)
}

export function clampToolResult(value: unknown): unknown {
  const text = typeof value === 'string' ? value : safeStringify(value)
  if (typeof text !== 'string' || text.length <= MAX_TOOL_RESULT_CHARS) return value
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated]`
}

function contentItemToValue(item: unknown): unknown {
  if (!isRecord(item)) return item
  switch (item.type) {
    case 'text':
      return typeof item.text === 'string' ? item.text : ''
    case 'image':
      return { type: 'image', mimeType: stringOr(item.mimeType, 'unknown'), dataOmitted: true }
    case 'audio':
      return { type: 'audio', mimeType: stringOr(item.mimeType, 'unknown'), dataOmitted: true }
    case 'resource':
      return resourceToValue(item.resource)
    case 'resource_link':
      return {
        type: 'resource_link',
        uri: stringOr(item.uri, ''),
        ...(typeof item.name === 'string' ? { name: item.name } : {}),
      }
    default:
      return { type: stringOr(item.type, 'unknown') }
  }
}

function resourceToValue(resource: unknown): unknown {
  if (!isRecord(resource)) return resource
  const descriptor: Record<string, unknown> = {
    type: 'resource',
    uri: stringOr(resource.uri, ''),
    mimeType: stringOr(resource.mimeType, 'unknown'),
  }
  if (typeof resource.text === 'string') descriptor.text = resource.text
  if (resource.blob !== undefined) descriptor.blobOmitted = true
  return descriptor
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
