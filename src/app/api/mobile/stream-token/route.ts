import type { NextRequest } from 'next/server'

import { getExpectedMobileToken, requireMobileAuth } from '@/server/mobile-auth'
import { mobileJson, mobileOptions } from '@/server/mobile-cors'
import { issueMobileStreamToken, MOBILE_STREAM_TOKEN_TTL_MS } from '@/server/mobile-stream-tokens'

/**
 * POST /api/mobile/stream-token
 *
 * EventSource 无法携带 Authorization header：先用 Bearer 换一个一次性、
 * 30 秒有效的 token，再拼到 `/api/mobile/events?streamToken=...`。
 */

export const OPTIONS = mobileOptions

export async function POST(req: NextRequest) {
  const authError = await requireMobileAuth(req)
  if (authError) return authError

  // 鉴权通过后 token 仍可能被清掉（关闭伴随模式）；此时签发的流 token 无意义。
  const expectedToken = await getExpectedMobileToken()
  if (!expectedToken) {
    return mobileJson(req, { error: 'Mobile companion is not configured' }, { status: 503 })
  }

  return mobileJson(req, {
    token: issueMobileStreamToken(expectedToken),
    expiresInSeconds: Math.floor(MOBILE_STREAM_TOKEN_TTL_MS / 1000),
  })
}
