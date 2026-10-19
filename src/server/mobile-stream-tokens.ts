import { randomBytes } from 'node:crypto'

import { hashMobileDeviceToken } from '@/server/mobile-token-hash'

/**
 * 一次性的移动端事件流 token（specs/14-mobile-remote.md §6.3 fallback）。
 *
 * EventSource 不能带 Authorization header，所以先用 Bearer 换一个 30 秒有效的
 * 一次性 token，再把它放到 URL 上。纯内存，进程重启即失效。
 */

export const MOBILE_STREAM_TOKEN_TTL_MS = 30_000

interface StreamTokenEntry {
  expiresAt: number
  /** 签发时设备 token 的哈希；取值落在 URL 上，不能把设备 token 明文留在内存表里 */
  deviceTokenHash: string
}

const globalForTokens = globalThis as unknown as {
  __agenthubMobileStreamTokens?: Map<string, StreamTokenEntry>
}

const tokens = globalForTokens.__agenthubMobileStreamTokens ?? new Map<string, StreamTokenEntry>()
if (!globalForTokens.__agenthubMobileStreamTokens) {
  globalForTokens.__agenthubMobileStreamTokens = tokens
}

export function issueMobileStreamToken(deviceToken: string, now = Date.now()): string {
  pruneExpired(now)
  const token = randomBytes(24).toString('base64url')
  tokens.set(token, {
    expiresAt: now + MOBILE_STREAM_TOKEN_TTL_MS,
    deviceTokenHash: hashMobileDeviceToken(deviceToken),
  })
  return token
}

/**
 * 一次性：校验通过立即删除，重复使用失败。
 * 返回签发时绑定的设备 token 哈希（`null` = 未知 / 过期）；调用方再复核该哈希
 * 是否仍对应一个有效设备（token 轮换、设备吊销都会让旧流失效）。
 */
export function consumeMobileStreamToken(token: string, now = Date.now()): string | null {
  pruneExpired(now)
  const entry = tokens.get(token)
  if (entry === undefined) return null
  tokens.delete(token)
  if (entry.expiresAt <= now) return null
  return entry.deviceTokenHash
}

export function clearMobileStreamTokensForTest(): void {
  tokens.clear()
}

function pruneExpired(now: number): void {
  for (const [token, entry] of tokens) {
    if (entry.expiresAt <= now) tokens.delete(token)
  }
}
