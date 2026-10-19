import { timingSafeEqual } from 'node:crypto'

import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import type { CompanionMode } from './companion-config'
import { mobileJson } from './mobile-cors'
import { hashMobileDeviceToken } from './mobile-token-hash'
import { getAppSettings } from './settings-service'

const MOBILE_DEV_TOKEN_ENV = 'AGENTHUB_MOBILE_DEV_TOKEN'
const MOBILE_TOKEN_ENV = 'AGENTHUB_MOBILE_TOKEN'
/** 设备 token 是 24 字节 base64url；超长输入没有合法来源，直接拒绝，避免无谓的哈希。 */
const MAX_TOKEN_LENGTH = 512

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

/** 配对（device_sessions）只在伴随模式打开时有效；env token 是 dev 例外。 */
function isCompanionEnabled(settings: MobileAuthSettings, envToken: string | undefined): boolean {
  return settings.companionMode !== 'off' || !!envToken?.trim()
}

export async function requireMobileAuth(req: NextRequest): Promise<NextResponse | null> {
  const settings = await getAppSettings()
  if (!isCompanionEnabled(settings, getEnvMobileToken())) {
    return mobileJson(
      req,
      { error: 'Mobile companion is not configured on the desktop host' },
      { status: 503 },
    )
  }

  const actualToken = getBearerToken(req)
  if (!actualToken || !(await isValidMobileToken(actualToken))) {
    return mobileJson(req, { error: 'Unauthorized' }, { status: 401 })
  }

  return null
}

/**
 * Bearer 凭据是否仍然有效：全局 token（设置 / env）或一台未吊销的配对设备。
 * 吊销在每次请求都生效，因此「丢手机」时不必等长连接自然断开。
 */
export async function isValidMobileToken(actual: string, now = Date.now()): Promise<boolean> {
  const token = actual.trim()
  if (!token || token.length > MAX_TOKEN_LENGTH) return false

  const settings = await getAppSettings()
  const env = getEnvMobileToken()
  const expected = resolveExpectedMobileToken(env, settings)
  if (expected && isSameToken(token, expected)) return true
  if (!isCompanionEnabled(settings, env)) return false

  const hash = hashMobileDeviceToken(token)
  return validateDeviceSessionHash(hash, now)
}

/** 事件流需要在不持有明文 token 的情况下复核（流 token 只带哈希）。 */
export async function isMobileTokenHashValid(hash: string, now = Date.now()): Promise<boolean> {
  const settings = await getAppSettings()
  const env = getEnvMobileToken()
  const expected = resolveExpectedMobileToken(env, settings)
  if (!isCompanionEnabled(settings, env)) return false
  if (expected && hash === hashMobileDeviceToken(expected.trim())) return true
  return validateDeviceSessionHash(hash, now)
}

export function getBearerToken(req: NextRequest): string | null {
  return readBearerToken(req.headers.get('authorization'))
}

async function validateDeviceSessionHash(hash: string, now: number): Promise<boolean> {
  // 动态 import：mobile-auth 的纯函数测试不应因此初始化 SQLite
  const { findActiveDeviceSessionByHash, touchDeviceSession } = await import('./device-sessions')
  const session = await findActiveDeviceSessionByHash(hash)
  if (!session) return false
  await touchDeviceSession(session.id, now)
  return true
}

function getEnvMobileToken(): string | undefined {
  return process.env[MOBILE_TOKEN_ENV] ?? process.env[MOBILE_DEV_TOKEN_ENV]
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
