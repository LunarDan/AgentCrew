'use client'

import { useEffect } from 'react'

import { useSearchStore } from '@/stores/search-store'
import { useAppStore } from '@/stores/app-store'

/**
 * Listens to searchStore.highlightedMessageId. When set, scrolls the message
 * into view and applies a 2s highlight class. Auto-clears via the store timer.
 *
 * Also handles "pending jump" — when a search hit is clicked, the store
 * records which conversation to switch to. This layer consumes that and
 * calls setActiveConversation.
 */
export function MessageHighlightLayer() {
  const highlightedId = useSearchStore((s) => s.highlightedMessageId)
  const setActive = useAppStore((s) => s.setActiveConversation)
  const pendingConv = useSearchStore((s) => s.pendingJumpConversationId)
  const consume = useSearchStore((s) => s.consumePendingJump)

  // Step 1: switch to the conversation if needed
  useEffect(() => {
    if (pendingConv) {
      setActive(pendingConv)
      consume()
    }
  }, [pendingConv, setActive, consume])

  // Step 2: scroll + flash when a message id is set.
  // 目标会话的消息是异步加载的，第一帧可能还没有 DOM；这里重试到出现为止（最多 5 秒）。
  const clearHighlight = useSearchStore((s) => s.clearHighlight)
  useEffect(() => {
    if (!highlightedId) return
    let cancelled = false
    let raf = 0
    let removeTimer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0

    const tryFlash = () => {
      if (cancelled) return
      const el = document.getElementById(`message-${highlightedId}`)
      if (!el) {
        if (++attempts > 300) {
          clearHighlight()
          return
        }
        raf = requestAnimationFrame(tryFlash)
        return
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('search-highlight-flash')
      removeTimer = setTimeout(() => {
        el.classList.remove('search-highlight-flash')
        clearHighlight()
      }, 2000)
    }

    raf = requestAnimationFrame(tryFlash)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      if (removeTimer) clearTimeout(removeTimer)
    }
  }, [highlightedId, clearHighlight])

  return null
}