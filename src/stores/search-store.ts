'use client'

import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

import { searchMessagesApi } from '@/lib/api'
import type { SearchHit } from '@/shared/types'

import { useAppStore } from './app-store'

const DEBOUNCE_MS = 200
const CHINESE_RE = /\p{Script=Han}/gu

function chineseCharCount(s: string): number {
  return (s.match(CHINESE_RE) ?? []).length
}

interface SearchState {
  isOpen: boolean
  query: string
  hits: SearchHit[]
  total: number
  loading: boolean
  error: string | null
  highlightedMessageId: string | null
  /** Conversation that should be active after a jump (consumed by ChatWindow). */
  pendingJumpConversationId: string | null
  /** 仅在当前打开的会话里搜；会话由 app-store 的 activeConversationId 决定。 */
  onlyCurrentConversation: boolean

  openSearch: () => void
  closeSearch: () => void
  setQuery: (q: string) => void
  setOnlyCurrentConversation: (on: boolean) => void
  runSearch: () => Promise<void>
  jumpToHit: (hit: SearchHit) => void
  consumePendingJump: () => string | null
  clearHighlight: () => void
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let requestSeq = 0

export const useSearchStore = create<SearchState>()(
  immer((set, get) => ({
    isOpen: false,
    query: '',
    hits: [],
    total: 0,
    loading: false,
    error: null,
    highlightedMessageId: null,
    pendingJumpConversationId: null,
    onlyCurrentConversation: false,

    openSearch: () => set((s) => { s.isOpen = true }),
    closeSearch: () => set((s) => { s.isOpen = false }),

    setQuery: (q) => {
      set((s) => { s.query = q })
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        void get().runSearch()
      }, DEBOUNCE_MS)
    },

    setOnlyCurrentConversation: (on) => {
      if (get().onlyCurrentConversation === on) return
      set((s) => { s.onlyCurrentConversation = on })
      if (get().query.trim().length >= 2) void get().runSearch()
    },

    runSearch: async () => {
      const q = get().query.trim()
      const seq = ++requestSeq
      if (q.length < 2) {
        set((s) => { s.hits = []; s.total = 0; s.loading = false; s.error = null })
        return
      }
      const fallback = chineseCharCount(q) < 3 ? 'like' as const : undefined
      const conversationId = get().onlyCurrentConversation
        ? useAppStore.getState().activeConversationId ?? undefined
        : undefined
      // 没有打开任何会话时退回全局搜索，避免出现永远为空的「仅当前会话」
      if (get().onlyCurrentConversation && !conversationId) {
        set((s) => { s.onlyCurrentConversation = false })
      }
      set((s) => { s.loading = true; s.error = null })
      try {
        const r = await searchMessagesApi(q, { fallback, conversationId })
        // 输入已变化 / 有更新的请求：丢弃这次结果，避免旧查询覆盖新查询
        if (seq !== requestSeq) return
        set((s) => { s.hits = r.hits; s.total = r.total; s.loading = false })
      } catch (err) {
        if (seq !== requestSeq) return
        set((s) => {
          s.hits = []
          s.total = 0
          s.loading = false
          s.error = err instanceof Error ? err.message : 'Search failed'
        })
      }
    },

    jumpToHit: (hit) => {
      set((s) => {
        s.isOpen = false
        s.pendingJumpConversationId = hit.conversationId
        s.highlightedMessageId = hit.messageId
      })
      // 由 MessageHighlightLayer 在真正闪烁后清除高亮：目标会话可能要等消息加载完才渲染
    },

    consumePendingJump: () => {
      const id = get().pendingJumpConversationId
      if (id) set((s) => { s.pendingJumpConversationId = null })
      return id
    },

    clearHighlight: () => set((s) => { s.highlightedMessageId = null }),
  })),
)