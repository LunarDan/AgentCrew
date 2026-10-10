import { AGENTHUB_MCP_SERVER_NAME, MCP_TOOL_PREFIX } from '@/shared/types'

import { pendingMcpTools } from './pending-mcp-tools'

/**
 * 外部 MCP 工具的审批门（specs/15-external-mcp.md，决策 §11.2）。
 *
 * 记忆粒度：**每个 conversation 每个工具名一次**。用户在会话 A 批准了 `mcp__fs__read`，
 * 会话 A 后续 run 不再问；新会话重新问。
 *
 * 刻意不落库：这是「本次使用」的意图，不是配置。dev server 重启 / HMR 会清空，代价只是重新弹一次。
 */

const globalForApprovals = globalThis as unknown as {
  __agenthubMcpApprovals?: Map<string, Set<string>>
}

const approvedByConversation =
  globalForApprovals.__agenthubMcpApprovals ?? new Map<string, Set<string>>()

if (!globalForApprovals.__agenthubMcpApprovals) {
  globalForApprovals.__agenthubMcpApprovals = approvedByConversation
}

/** 是否为外部 server 的工具名（`mcp__*`，且不是 AgentHub 自己的 agenthub bridge）。 */
export function isExternalMcpTool(toolName: string): boolean {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return false
  return !toolName.startsWith(`${MCP_TOOL_PREFIX}${AGENTHUB_MCP_SERVER_NAME}__`)
}

/** `mcp__<server>__<tool>` → server 名。取不出时返回 null（调用方跳过审批）。 */
export function parseMcpToolName(toolName: string): { serverName: string; bareToolName: string } | null {
  const rest = toolName.slice(MCP_TOOL_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return null
  const serverName = rest.slice(0, sep)
  const bareToolName = rest.slice(sep + 2)
  if (!serverName || !bareToolName) return null
  return { serverName, bareToolName }
}

export function isToolApproved(conversationId: string, toolName: string): boolean {
  return approvedByConversation.get(conversationId)?.has(toolName) ?? false
}

export function rememberApproval(conversationId: string, toolName: string): void {
  const set = approvedByConversation.get(conversationId)
  if (set) set.add(toolName)
  else approvedByConversation.set(conversationId, new Set([toolName]))
}

/** 会话被删除时清理，避免长期运行下 Map 无界增长。 */
export function forgetConversation(conversationId: string): void {
  approvedByConversation.delete(conversationId)
}

export async function waitForMcpToolApproval(args: {
  conversationId: string
  agentId: string
  runId: string
  serverName: string
  toolName: string
  toolArgs: unknown
  signal: AbortSignal
}): Promise<boolean> {
  const pending = pendingMcpTools.register({
    conversationId: args.conversationId,
    agentId: args.agentId,
    runId: args.runId,
    serverName: args.serverName,
    toolName: args.toolName,
    args: args.toolArgs,
  })
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (approved: boolean) => {
      if (settled) return
      settled = true
      args.signal.removeEventListener('abort', onAbort)
      resolve(approved)
    }
    const onAbort = () => {
      pendingMcpTools.cancel(pending.id)
      finish(false)
    }
    pendingMcpTools.attachResolver(pending.id, (decision) => {
      // 批准即记住（§11.2 的粒度就是「本会话此工具一次」），后续轮次不再问。
      if (decision.approved) rememberApproval(args.conversationId, args.toolName)
      finish(decision.approved)
    })
    if (args.signal.aborted) onAbort()
    else args.signal.addEventListener('abort', onAbort, { once: true })
  })
}
