import type { NextRequest } from 'next/server'

import { eventBus } from '@/server/event-bus'
import { getExpectedMobileToken, requireMobileAuth } from '@/server/mobile-auth'
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
    // 流 token 与设备 token 绑定：轮换后旧 token 直接判废。
    const expected = await getExpectedMobileToken()
    if (!expected || !consumeMobileStreamToken(streamToken, expected)) {
      return mobileJson(req, { error: 'Invalid or expired stream token' }, { status: 401 })
    }
  } else {
    const authError = await requireMobileAuth(req)
    if (authError) return authError
  }

  // 连接期间定期用它比对：token 轮换 / 关闭伴随模式后必须让已建立的流失效。
  const authorizedToken = await getExpectedMobileToken()
  if (!authorizedToken) {
    return mobileJson(req, { error: 'Mobile companion is not configured' }, { status: 503 })
  }

  const encoder = new TextEncoder()
  // start 里创建，cancel 在别的闭包里调用：通过它退订，避免客户端断开后订阅泄漏。
  let closeStream: (() => void) | undefined

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      // close 在 send / 心跳里互引；用可变 holder 避免 TDZ，也让清理函数始终拿到最新句柄。
      const handles: {
        heartbeat?: ReturnType<typeof setInterval>
        unsubscribe?: () => void
      } = {}

      const close = () => {
        if (closed) return
        closed = true
        if (handles.heartbeat !== undefined) clearInterval(handles.heartbeat)
        handles.unsubscribe?.()
        req.signal.removeEventListener('abort', close)
        try {
          controller.close()
        } catch {
          // 已关闭
        }
      }
      closeStream = close

      const send = (data: unknown) => {
        if (closed) return
        // 手机侧读得慢时不要无限堆内存；丢事件由重连后的快照兜底。
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          // 控制器已关闭
          close()
        }
      }

      send({ type: 'connected', timestamp: Date.now() })

      handles.unsubscribe = eventBus.subscribe((event) => {
        // 手机只需要「有事发生」来触发快照刷新。原始事件带 host 绝对路径、文件内容、
        // 工具参数与结果，不能整包发给局域网设备（数据最小化）。
        send({
          type: event.type,
          conversationId: event.conversationId,
          timestamp: event.timestamp,
        })
      })

      let revalidating = false
      handles.heartbeat = setInterval(() => {
        if (closed || revalidating) return
        revalidating = true
        void getExpectedMobileToken()
          .then((current) => {
            if (current !== authorizedToken) {
              close()
              return
            }
            send({ type: 'heartbeat', timestamp: Date.now() })
          })
          .catch(() => close())
          .finally(() => {
            revalidating = false
          })
      }, 15000)

      req.signal.addEventListener('abort', close)

      // 上面的鉴权读是异步的，期间客户端可能已经断开。
      if (req.signal.aborted) close()
    },
    cancel() {
      closeStream?.()
    },
  }, {
    // 默认 highWaterMark=1 会让刚连上时的几个事件直接命中「读得慢」分支被丢掉；
    // 放宽到 256 个 chunk，真正积压时才丢。
    highWaterMark: 256,
  })

  const headers = mobileCorsHeaders(req)
  headers.set('Content-Type', 'text/event-stream; charset=utf-8')
  headers.set('Cache-Control', 'no-cache, no-transform')
  headers.set('Connection', 'keep-alive')
  headers.set('X-Accel-Buffering', 'no')
  return new Response(stream, { headers })
}
