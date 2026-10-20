import type { PendingMcpToolCall } from '@/shared/types'

import { eventBus } from './event-bus'
import { newPendingMcpToolCallId } from './ids'

/**
 * 外部 MCP 工具调用的审批等待队列。与 pendingBashCommands 同构：内存态、按 conversation 查、
 * AbortSignal 由调用方负责。审批记忆（已批准的工具名）见 mcp-approvals.ts。
 */
interface PendingEntry {
  call: PendingMcpToolCall
  resolver: ((decision: { approved: boolean }) => void) | null
}

class PendingMcpToolsStore {
  private map = new Map<string, PendingEntry>()

  register(args: {
    conversationId: string
    agentId: string
    runId: string
    serverName: string
    toolName: string
    args: unknown
  }): PendingMcpToolCall {
    const call: PendingMcpToolCall = {
      id: newPendingMcpToolCallId(),
      conversationId: args.conversationId,
      agentId: args.agentId,
      runId: args.runId,
      serverName: args.serverName,
      toolName: args.toolName,
      args: args.args,
      createdAt: Date.now(),
    }
    this.map.set(call.id, { call, resolver: null })
    eventBus.publish({
      type: 'mcp_tool.pending',
      conversationId: args.conversationId,
      timestamp: call.createdAt,
      pendingCall: call,
    })
    return call
  }

  attachResolver(id: string, resolver: (decision: { approved: boolean }) => void): void {
    const entry = this.map.get(id)
    if (entry) entry.resolver = resolver
  }

  get(id: string): PendingMcpToolCall | undefined {
    return this.map.get(id)?.call
  }

  listByConversation(conversationId: string): PendingMcpToolCall[] {
    return Array.from(this.map.values())
      .filter((entry) => entry.call.conversationId === conversationId)
      .map((entry) => entry.call)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  approve(id: string): boolean {
    if (!this.map.has(id)) return false
    this.finalize(id, true)
    return true
  }

  reject(id: string): boolean {
    if (!this.map.has(id)) return false
    this.finalize(id, false)
    return true
  }

  cancel(id: string): void {
    const entry = this.map.get(id)
    if (!entry) return
    this.finalize(id, false)
  }

  /** 运行结束时的兜底清理：任何收尾路径都不该把审批条目永久留在内存里。 */
  cancelByRun(runId: string): void {
    for (const [id, entry] of [...this.map]) {
      if (entry.call.runId === runId) this.cancel(id)
    }
  }

  private finalize(id: string, approved: boolean): void {
    const entry = this.map.get(id)
    if (!entry) return
    entry.resolver?.({ approved })
    this.map.delete(id)
    eventBus.publish({
      type: 'mcp_tool.resolved',
      conversationId: entry.call.conversationId,
      timestamp: Date.now(),
      pendingId: id,
      approved,
    })
  }
}

const globalForPMT = globalThis as unknown as {
  __agenthubPendingMcpTools?: PendingMcpToolsStore
}

export const pendingMcpTools = globalForPMT.__agenthubPendingMcpTools ?? new PendingMcpToolsStore()

if (!globalForPMT.__agenthubPendingMcpTools) {
  globalForPMT.__agenthubPendingMcpTools = pendingMcpTools
}
