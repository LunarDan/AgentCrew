'use client'

import { Check, Loader2, Plug, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { AgentAvatar } from '@/components/agent-avatar'
import { Button } from '@/components/ui/button'
import {
  approvePendingMcpToolCall,
  fetchPendingMcpToolCalls,
  rejectPendingMcpToolCall,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAppStore, usePendingMcpToolCalls } from '@/stores/app-store'
import type { PendingMcpToolCall } from '@/shared/types'

/**
 * 外部 MCP 工具调用的审批卡片（`trust: 'ask'`）。
 * 批准后本会话内同一工具不再询问，见 src/server/mcp-approvals.ts。
 */
export function PendingMcpToolsPanel({ conversationId }: { conversationId: string }) {
  const pending = usePendingMcpToolCalls(conversationId)
  const setPendingMcpToolCallsForConversation = useAppStore(
    (s) => s.setPendingMcpToolCallsForConversation,
  )

  const resyncNonce = useAppStore((s) => s.resyncNonce)
  const handledResyncRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    // SSE 重连后断线期间的 approve/deny 不会补发，必须用快照覆盖本地状态
    const forced = resyncNonce !== handledResyncRef.current
    handledResyncRef.current = resyncNonce
    fetchPendingMcpToolCalls(conversationId)
      .then((list) => {
        if (cancelled) return
        // 请求期间 SSE 可能已经推来新的 pending；此时快照可能更旧，不能覆盖
        if (!forced && useAppStore.getState().pendingMcpToolCallsByConv[conversationId]?.length) return
        setPendingMcpToolCallsForConversation(conversationId, list)
      })
      .catch((err) => {
        console.warn('[PendingMcpToolsPanel] fetch failed', err)
      })
    return () => {
      cancelled = true
    }
  }, [conversationId, resyncNonce, setPendingMcpToolCallsForConversation])

  if (pending.length === 0) return null

  return (
    <div className="shrink-0 space-y-2 border-t bg-violet-50/45 px-4 py-2.5 dark:bg-violet-950/10">
      {pending.map((call) => (
        <PendingMcpToolCallCard key={call.id} conversationId={conversationId} pending={call} />
      ))}
    </div>
  )
}

function PendingMcpToolCallCard({
  conversationId,
  pending,
}: {
  conversationId: string
  pending: PendingMcpToolCall
}) {
  const agent = useAppStore((s) => s.agents[pending.agentId])
  const removePendingMcpToolCall = useAppStore((s) => s.removePendingMcpToolCall)
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null)
  const [error, setError] = useState<string | null>(null)

  const handleApprove = useCallback(async () => {
    setBusy('approve')
    setError(null)
    try {
      await approvePendingMcpToolCall(conversationId, pending.id)
      // 断线时 SSE 可能收不到 resolved，卡片要自己退场
      removePendingMcpToolCall(conversationId, pending.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(null)
    }
  }, [conversationId, pending.id, removePendingMcpToolCall])

  const handleReject = useCallback(async () => {
    setBusy('reject')
    setError(null)
    try {
      await rejectPendingMcpToolCall(conversationId, pending.id)
      removePendingMcpToolCall(conversationId, pending.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(null)
    }
  }, [conversationId, pending.id, removePendingMcpToolCall])

  const argsPreview = (() => {
    try {
      const text = JSON.stringify(pending.args ?? {})
      return text.length > 160 ? `${text.slice(0, 160)}…` : text
    } catch {
      return '(unserializable args)'
    }
  })()

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border border-violet-200 bg-card px-3 py-2 text-xs shadow-sm',
        'dark:border-violet-900/50',
      )}
    >
      <div className="flex shrink-0 items-center gap-2">
        {agent ? <AgentAvatar agent={agent} size="sm" /> : <div className="size-6 rounded-md bg-muted" />}
        <Plug className="size-4 text-violet-600" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 font-medium">{agent?.name ?? 'Agent'}</span>
          <span className="shrink-0 text-muted-foreground">请求调用外部工具</span>
          <code className="truncate font-mono text-[11px]">{pending.toolName}</code>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="shrink-0">server：{pending.serverName}</span>
          <span>·</span>
          <span className="truncate font-mono">{argsPreview}</span>
          {error && <span className="text-destructive">· {error}</span>}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={handleReject}
          disabled={!!busy}
          className="h-7 px-2.5 text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/30"
          title="拒绝"
        >
          {busy === 'reject' ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
          拒绝
        </Button>
        <Button
          size="sm"
          onClick={handleApprove}
          disabled={!!busy}
          className="h-7 bg-[#3370FF] px-2.5 text-white hover:bg-[#2860e5]"
          title="本会话内允许该工具"
        >
          {busy === 'approve' ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          允许
        </Button>
      </div>
    </div>
  )
}
