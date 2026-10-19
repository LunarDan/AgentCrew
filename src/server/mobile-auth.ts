import { timingSafeEqual } from 'node:crypto'

import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import { mobileJson } from './mobile-cors'
import { getAppSettings } from './settings-service'
import type { CompanionMode } from './companion-config'

const MOBILE_DEV_TOKEN_ENV = 'AGENTHUB_MOBILE_DEV_TOKEN'
const MOBILE_TOKEN_ENV = 'AGENTHUB_MOBILE_TOKEN'

export interface MobileAuthSettings {
  companionMode: CompanionMode
  mobileDeviceToken: string | null
}

/**
 * 期望的 token：环境变量（dev / Electron bootstrap 注入）优先，否则用设置面板里存的
 * `app_settings.mobile_device_token`——它才是 P0 配对的持久来源（spec 14 §4.1）。
 * companion mode 关闭时 DB token 不再放行，避免关掉功能后旧设备还能访问。
 */
export function resolveExpectedMobileToken(
  envToken: string | undefined,
  settings: MobileAuthSettings,
): string | null {
  const fromEnv = envToken?.trim()
  if (fromEnv) return fromEnv
  if (settings.companionMode === 'off') return null
  return settings.mobileDeviceToken?.trim() || null
}

/** 当前生效的期望 token（事件流需要在连接存续期间复用它判断是否被吊销）。 */
export async function getExpectedMobileToken(): Promise<string | null> {
  const settings = await getAppSettings()
  return resolveExpectedMobileToken(
    process.env[MOBILE_TOKEN_ENV] ?? process.env[MOBILE_DEV_TOKEN_ENV],
    settings,
  )
}

export async function requireMobileAuth(req: NextRequest): Promise<NextResponse | null> {
  const expectedToken = await getExpectedMobileToken()
  if (!expectedToken) {
    return mobileJson(
      req,
      { error: 'Mobile companion is not configured on the desktop host' },
      { status: 503 },
    )
  }

  const actualToken = readBearerToken(req.headers.get('authorization'))
  if (!actualToken || !isSameToken(actualToken, expectedToken)) {
    return mobileJson(req, { error: 'Unauthorized' }, { status: 401 })
  }

  return null
}

function readBearerToken(header: string | null): string | null {
  if (!header) return null
  const [scheme, token] = header.trim().split(/\s+/, 2)
  if (scheme !== 'Bearer' || !token) return null
  return token
}

function isSameToken(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(actualBuffer, expectedBuffer)
}
