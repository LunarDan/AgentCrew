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
  if (origin && !isSameOrigin(origin, req.nextUrl)) {
    return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 })
  }
  return null
}

function isSameOrigin(origin: string, expected: URL): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== expected.protocol || parsed.port !== expected.port) return false
  // 同一台机器的 localhost / 127.0.0.1 / [::1] 是同一来源；Next 也会把 loopback 归一成 localhost
  if (parsed.hostname === expected.hostname) return true
  return isLoopbackHost(parsed.hostname) && isLoopbackHost(expected.hostname)
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}
