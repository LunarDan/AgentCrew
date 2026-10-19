import type {
  ConnectionConfig,
  MobileAskUserAnswers,
  MobileArtifact,
  MobileConversationDetail,
  MobileSnapshot,
} from '../types'

export interface MobileApiClient {
  getSnapshot(): Promise<MobileSnapshot>
  getConversation(id: string): Promise<MobileConversationDetail>
  getArtifact(id: string): Promise<MobileArtifact>
  sendMessage(id: string, content: string): Promise<void>
  withdrawMessage(conversationId: string, messageId: string): Promise<void>
  editMessage(conversationId: string, messageId: string, content: string): Promise<void>
  regenerate(conversationId: string): Promise<void>
  abortRun(runId: string): Promise<void>
  /** 订阅全局事件流；调用方用 AbortSignal 断开。事件只用于触发刷新，不直接进 store。 */
  subscribeEvents(onEvent: (event: unknown) => void, signal: AbortSignal): Promise<void>
  decidePendingWrite(id: string, action: 'approve' | 'reject'): Promise<void>
  answerPendingQuestion(id: string, answers: MobileAskUserAnswers): Promise<void>
}

export function createMobileApiClient(config: ConnectionConfig): MobileApiClient {
  const baseUrl = normalizeBaseUrl(config.baseUrl)

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!baseUrl) throw new Error('Desktop host is not configured')
    if (!config.deviceToken) throw new Error('Device token is not configured')

    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.deviceToken}`,
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      if (isLoopbackUrl(baseUrl)) {
        throw new Error(
          `Cannot reach ${baseUrl}. If this is running on a real phone, use the desktop LAN/Tailscale IP instead of localhost.`,
        )
      }
      throw new Error(`Cannot reach ${baseUrl}: ${message}`)
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${body || res.statusText}`)
    }
    return res.json() as Promise<T>
  }

  return {
    getSnapshot: () => request<MobileSnapshot>('/api/mobile/snapshot'),
    getConversation: (id) => request<MobileConversationDetail>(`/api/mobile/conversations/${id}`),
    getArtifact: async (id) => {
      const result = await request<{ artifact: MobileArtifact }>(`/api/mobile/artifacts/${id}`)
      return result.artifact
    },
    sendMessage: async (id, content) => {
      await request<{ messageId: string; runIds: string[] }>(
        `/api/mobile/conversations/${id}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({ content }),
        },
      )
    },
    decidePendingWrite: async (id, action) => {
      await request<{ ok: true }>(`/api/mobile/pending-writes/${id}`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
    },
    answerPendingQuestion: async (id, answers) => {
      await request<{ ok: true }>(`/api/mobile/pending-questions/${id}`, {
        method: 'POST',
        body: JSON.stringify({ answers }),
      })
    },
    withdrawMessage: async (conversationId, messageId) => {
      await request(`/api/mobile/conversations/${conversationId}/messages/${messageId}/withdraw`, {
        method: 'POST',
      })
    },
    editMessage: async (conversationId, messageId, content) => {
      await request(`/api/mobile/conversations/${conversationId}/messages/${messageId}/edit`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      })
    },
    regenerate: async (conversationId) => {
      await request(`/api/mobile/conversations/${conversationId}/regenerate`, { method: 'POST' })
    },
    abortRun: async (runId) => {
      await request(`/api/mobile/runs/${runId}/abort`, { method: 'POST' })
    },
    subscribeEvents: async (onEvent, signal) => {
      if (!baseUrl) throw new Error('Desktop host is not configured')
      if (!config.deviceToken) throw new Error('Device token is not configured')

      const res = await fetch(`${baseUrl}/api/mobile/events`, {
        headers: {
          Authorization: `Bearer ${config.deviceToken}`,
          Accept: 'text/event-stream',
        },
        signal,
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${res.statusText}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })

        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = chunk
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (data) {
            try {
              onEvent(JSON.parse(data) as unknown)
            } catch {
              // 心跳 / 非 JSON 行忽略
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
    },
  }
}

function normalizeBaseUrl(value: string): string {
  return withScheme(value).replace(/\/+$/, '')
}

/** 用户常只填 `192.168.1.5:60646`；没有 scheme 时 fetch 会当成相对路径打到 WebView 自身。 */
function withScheme(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(withScheme(value))
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  } catch {
    return false
  }
}
