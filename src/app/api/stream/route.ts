import type { NextRequest } from 'next/server'

import { eventBus } from '@/server/event-bus'

/**
 * GET /api/stream
 *
 * 全局 SSE 端点。所有会话的事件都从这一条流推出，事件携带 conversationId，
 * 前端按 id 分发到对应桶。详见 specs/02-stream-events.md。
 */
export async function GET(req: NextRequest) {
  const encoder = new TextEncoder()
  let cleanup: (() => void) | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let heartbeat: ReturnType<typeof setInterval> | null = null

      const unsubscribeRef: { fn: (() => void) | null } = { fn: null }
      const close = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        unsubscribeRef.fn?.()
        try {
          controller.close()
        } catch {
          // 已关闭
        }
      }

      const send = (data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          // 控制器已出错 / 关闭：一并摘掉订阅与心跳，否则这条连接会永远空转
          close()
        }
      }

      // 推送一条 hello 让客户端立即知道连接 OK
      send({ type: 'connected', timestamp: Date.now() })

      unsubscribeRef.fn = eventBus.subscribe((event) => {
        send(event)
      })

      // 15s 心跳防止中间代理 / 浏览器空闲断连
      heartbeat = setInterval(() => {
        send({ type: 'heartbeat', timestamp: Date.now() })
      }, 15000)

      cleanup = close
      req.signal.addEventListener('abort', close)
    },
    cancel() {
      cleanup?.()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
