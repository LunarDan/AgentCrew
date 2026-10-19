import { NextResponse, type NextRequest } from 'next/server'

/**
 * 桌面 API 监听 loopback，但仍会被用户浏览的任意网页以跨站简单请求打到（CSRF）。
 * 写路由统一用它拒绝非 same-origin 的浏览器请求；没有 Origin / Sec-Fetch-Site 的
 * 非浏览器调用（curl、移动端 Bearer）不受影响。
 */
export function rejectCrossOriginWrite(req: NextRequest): NextResponse | null {
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') {
    return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 })
  }
  const origin = req.headers.get('origin')
  if (origin && origin !== req.nextUrl.origin) {
    return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 })
  }
  return null
}
