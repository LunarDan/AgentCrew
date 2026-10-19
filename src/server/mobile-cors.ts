import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

const BUILTIN_ALLOWED_ORIGINS = new Set([
  'capacitor://localhost',
  'ionic://localhost',
  'https://localhost',
  'http://localhost',
])

export function mobileOptions(req: NextRequest): NextResponse {
  return withMobileCors(req, new NextResponse(null, { status: 204 }))
}

export function mobileJson(
  req: NextRequest,
  body: unknown,
  init?: ResponseInit,
): NextResponse {
  return withMobileCors(req, NextResponse.json(body, init))
}

export function withMobileCors(req: NextRequest, res: NextResponse): NextResponse {
  for (const [name, value] of mobileCorsHeaders(req)) res.headers.set(name, value)
  return res
}

/** 流式响应不能用 NextResponse，单独给出 header 集合。 */
export function mobileCorsHeaders(req: NextRequest): Headers {
  const headers = new Headers()
  const origin = req.headers.get('origin')
  if (origin && isAllowedOrigin(origin)) {
    headers.set('Access-Control-Allow-Origin', origin)
  }
  headers.set('Vary', 'Origin')
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept')
  headers.set('Access-Control-Max-Age', '600')
  return headers
}

function isAllowedOrigin(origin: string): boolean {
  if (BUILTIN_ALLOWED_ORIGINS.has(origin)) return true
  if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(origin)) return true

  const configured = process.env.AGENTHUB_MOBILE_ALLOWED_ORIGINS
  if (!configured) return false
  return configured
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(origin)
}
