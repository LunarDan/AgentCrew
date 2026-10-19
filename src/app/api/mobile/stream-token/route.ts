import type { NextRequest } from 'next/server'

import { getBearerToken, requireMobileAuth } from '@/server/mobile-auth'
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

  // 流 token 绑定的是调用方这次实际使用的设备 token（可能是某台配对设备，
  // 而不是全局 token）——否则设备吊销后一次性流 token 仍可换到新。
  const deviceToken = getBearerToken(req)?.trim()
  if (!deviceToken) {
    return mobileJson(req, { error: 'Unauthorized' }, { status: 401 })
  }

  return mobileJson(req, {
    token: issueMobileStreamToken(deviceToken),
    expiresInSeconds: Math.floor(MOBILE_STREAM_TOKEN_TTL_MS / 1000),
  })
}
