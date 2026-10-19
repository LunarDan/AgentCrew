import type { NextRequest } from 'next/server'

import { eventBus } from '@/server/event-bus'
import { requireMobileAuth } from '@/server/mobile-auth'
import { mobileCorsHeaders, mobileJson, mobileOptions } from '@/server/mobile-cors'
import { consumeMobileStreamToken } from '@/server/mobile-stream-tokens'

/**
 * GET /api/mobile/events
 *
 * 移动端全局事件流（specs/14-mobile-remote.md §6.3）。优先用 fetch streaming +
 * `Authorization: Bearer`；WebView 不支持时可用一次性 `streamToken` 走 EventSource。
 */

export const OPTIONS = mobileOptions

export async function GET(req: NextRequest) {
  const streamToken = req.nextUrl.searchParams.get('streamToken')
  if (streamToken) {
    if (!consumeMobileStreamToken(streamToken)) {
      return mobileJson(req, { error: 'Invalid or expired stream token' }, { status: 401 })
    }
  } else {
    const authError = await requireMobileAuth(req)
    if (authError) return authError
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false

      const send = (data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          // 控制器已关闭，忽略
        }
      }

      send({ type: 'connected', timestamp: Date.now() })

      const unsubscribe = eventBus.subscribe((event) => {
        send(event)
      })

      const heartbeat = setInterval(() => {
        send({ type: 'heartbeat', timestamp: Date.now() })
      }, 15000)

      const close = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        unsubscribe()
        try {
          controller.close()
        } catch {
          // 已关闭
        }
      }

      req.signal.addEventListener('abort', close)
    },
  })

  const headers = mobileCorsHeaders(req)
  headers.set('Content-Type', 'text/event-stream; charset=utf-8')
  headers.set('Cache-Control', 'no-cache, no-transform')
  headers.set('Connection', 'keep-alive')
  headers.set('X-Accel-Buffering', 'no')
  return new Response(stream, { headers })
}
