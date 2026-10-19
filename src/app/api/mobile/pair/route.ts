import type { NextRequest } from 'next/server'
import { z } from 'zod'

import { consumePairingCode } from '@/server/pairing-codes'
import { createDeviceSession } from '@/server/device-sessions'
import { mobileJson, mobileOptions } from '@/server/mobile-cors'
import { getAppSettings } from '@/server/settings-service'

/**
 * POST /api/mobile/pair —— 用桌面设置页生成的一次性配对码换取设备 token
 * （specs/14-mobile-remote.md §5.3）。
 *
 * 这是唯一不要求 Bearer 的移动端接口；安全性完全依赖配对码：5 分钟、一次性、
 * 错 5 次作废、全局每分钟限流。伴随模式关闭时一律拒绝。
 */

export const OPTIONS = mobileOptions

const Body = z.object({
  code: z.string().min(1).max(32),
  deviceName: z.string().min(1).max(64),
})

const FAILURE_STATUS = {
  invalid: 401,
  expired: 410,
  'too-many-attempts': 429,
  'rate-limited': 429,
} as const

const FAILURE_MESSAGE = {
  invalid: 'Invalid pairing code',
  expired: 'Pairing code expired',
  'too-many-attempts': 'Too many attempts for this pairing code',
  'rate-limited': 'Too many failed pairing attempts; try again later',
} as const

export async function POST(req: NextRequest) {
  const settings = await getAppSettings()
  if (settings.companionMode === 'off') {
    return mobileJson(
      req,
      { error: 'Mobile companion is not enabled on the desktop host' },
      { status: 503 },
    )
  }

  const raw = await req.json().catch(() => null)
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return mobileJson(req, { error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  const result = consumePairingCode(parsed.data.code)
  if (!result.ok) {
    return mobileJson(
      req,
      { error: FAILURE_MESSAGE[result.reason], reason: result.reason },
      { status: FAILURE_STATUS[result.reason] },
    )
  }

  const { session, deviceToken } = await createDeviceSession(parsed.data.deviceName)
  return mobileJson(req, {
    deviceToken,
    device: session,
  })
}
