'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { MessageItem } from '@/components/message-item'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { MessageRow } from '@/db/schema'
import { fetchMessages } from '@/lib/api'
import { useAppStore, useMessagesForConversation } from '@/stores/app-store'

const STICKY_BOTTOM_THRESHOLD_PX = 120
const STREAM_SCROLL_THROTTLE_MS = 80

export function MessageList({ conversationId }: { conversationId: string }) {
  const messages = useMessagesForConversation(conversationId)
  const setMessagesForConversation = useAppStore((s) => s.setMessagesForConversation)
  const resyncNonce = useAppStore((s) => s.resyncNonce)
  const fetchedConversationsRef = useRef<Set<string>>(new Set())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [loaded, setLoaded] = useState(false)

  const viewportRef = useRef<HTMLDivElement>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const scrollTimerRef = useRef<number | null>(null)
  const stickToBottomRef = useRef(true)
  const initialScrolledConvRef = useRef<string | null>(null)
  const lastMessageIdRef = useRef<string | null>(null)
  const lastMessage = messages[messages.length - 1]
  const lastMessageId = lastMessage?.id ?? null
  const lastMessageRole = lastMessage?.role ?? null
  const lastMessageStatus = lastMessage?.status ?? null
  const lastMessagePartCount = lastMessage?.parts.length ?? 0
  const lastMessageContentLength = getMessageContentLength(lastMessage)
  const hasMessages = messages.length > 0

  const cancelScheduledScroll = useCallback(() => {
    if (scrollTimerRef.current !== null) {
      window.clearTimeout(scrollTimerRef.current)
      scrollTimerRef.current = null
    }
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
  }, [])

  const scheduleScrollToBottom = useCallback(
    (force = false) => {
      if (!force && !stickToBottomRef.current) return
      if (force) cancelScheduledScroll()
      if (scrollTimerRef.current !== null || scrollFrameRef.current !== null) return

      const delay = force ? 0 : STREAM_SCROLL_THROTTLE_MS
      scrollTimerRef.current = window.setTimeout(() => {
        scrollTimerRef.current = null
        scrollFrameRef.current = window.requestAnimationFrame(() => {
          scrollFrameRef.current = null
          const viewport = viewportRef.current
          if (!viewport) return

          viewport.scrollTop = viewport.scrollHeight
          stickToBottomRef.current = true
        })
      }, delay)
    },
    [cancelScheduledScroll],
  )

  useLayoutEffect(() => {
    stickToBottomRef.current = true
    initialScrolledConvRef.current = null
    lastMessageIdRef.current = null
    cancelScheduledScroll()
    return cancelScheduledScroll
  }, [cancelScheduledScroll, conversationId])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const updateStickiness = () => {
      stickToBottomRef.current = isNearBottom(viewport)
    }

    viewport.addEventListener('scroll', updateStickiness, { passive: true })
    updateStickiness()
    return () => {
      viewport.removeEventListener('scroll', updateStickiness)
    }
  }, [conversationId, hasMessages])

  // SSE 重连后补拉一次快照，修复断线期间漏掉的 message.end / message.removed
  useEffect(() => {
    if (resyncNonce === 0) return
    // 断线影响所有缓存过的会话：只失效当前会话会让切回去的旧会话继续显示过期消息
    fetchedConversationsRef.current.clear()
    setRetryNonce((n) => n + 1)
  }, [resyncNonce])

  useEffect(() => {
    if (fetchedConversationsRef.current.has(conversationId)) {
      setLoaded(true)
      return
    }
    let cancelled = false
    setLoadError(null)
    setLoaded(false)
    // 快照只能判死「请求发出前」就存在的消息 / run；请求期间才到的不算
    const snapshotStartedAt = Date.now()
    fetchMessages(conversationId)
      .then((list) => {
        if (cancelled) return
        setMessagesForConversation(conversationId, list, snapshotStartedAt)
        fetchedConversationsRef.current.add(conversationId)
        setLoaded(true)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[MessageList] fetch failed', err)
        setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [conversationId, retryNonce, setMessagesForConversation])

  useLayoutEffect(() => {
    if (messages.length === 0) return

    const needsInitialScroll = initialScrolledConvRef.current !== conversationId
    const previousLastMessageId = lastMessageIdRef.current
    const isNewUserMessage =
      lastMessageRole === 'user' &&
      previousLastMessageId !== null &&
      previousLastMessageId !== lastMessageId

    if (needsInitialScroll) {
      initialScrolledConvRef.current = conversationId
      scheduleScrollToBottom(true)
    } else if (isNewUserMessage) {
      scheduleScrollToBottom(true)
    } else {
      scheduleScrollToBottom()
    }

    lastMessageIdRef.current = lastMessageId
  }, [
    conversationId,
    lastMessageContentLength,
    lastMessageId,
    lastMessagePartCount,
    lastMessageRole,
    lastMessageStatus,
    messages.length,
    scheduleScrollToBottom,
  ])

  if (messages.length === 0) {
    if (loadError) {
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
          <span>消息加载失败：{loadError}</span>
          <button
            type="button"
            className="rounded border px-2 py-1 text-xs hover:bg-accent"
            onClick={() => setRetryNonce((n) => n + 1)}
          >
            重试
          </button>
        </div>
      )
    }
    if (!loaded) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          加载消息中…
        </div>
      )
    }
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        还没有消息，发一条试试。
      </div>
    )
  }

  return (
    <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
      <div className="space-y-4 p-4">
        {messages.map((m) => (
          <MessageItem key={m.id} message={m} />
        ))}
      </div>
    </ScrollArea>
  )
}

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICKY_BOTTOM_THRESHOLD_PX
}

function getMessageContentLength(message: MessageRow | undefined): number {
  if (!message) return 0
  let length = 0
  for (const part of message.parts) {
    switch (part.type) {
      case 'text':
      case 'thinking':
      case 'code':
        length += part.content.length
        break
      default:
        break
    }
  }
  return length
}
