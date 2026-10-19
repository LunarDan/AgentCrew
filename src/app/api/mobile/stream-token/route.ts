import type { NextRequest } from 'next/server'

import { requireMobileAuth } from '@/server/mobile-auth'
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

  return mobileJson(req, {
    token: issueMobileStreamToken(),
    expiresInSeconds: Math.floor(MOBILE_STREAM_TOKEN_TTL_MS / 1000),
  })
}
