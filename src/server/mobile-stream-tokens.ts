import { createHash, randomBytes } from 'node:crypto'

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
    deviceTokenHash: hashDeviceToken(deviceToken),
  })
  return token
}

/**
 * 一次性：校验通过立即删除，重复使用失败。
 * 同时要求设备 token 与签发时一致，token 轮换后旧流 token 立即作废。
 */
export function consumeMobileStreamToken(
  token: string,
  currentDeviceToken: string,
  now = Date.now(),
): boolean {
  pruneExpired(now)
  const entry = tokens.get(token)
  if (entry === undefined) return false
  tokens.delete(token)
  if (entry.expiresAt <= now) return false
  return entry.deviceTokenHash === hashDeviceToken(currentDeviceToken)
}

export function clearMobileStreamTokensForTest(): void {
  tokens.clear()
}

function hashDeviceToken(deviceToken: string): string {
  return createHash('sha256').update(deviceToken).digest('hex')
}

function pruneExpired(now: number): void {
  for (const [token, entry] of tokens) {
    if (entry.expiresAt <= now) tokens.delete(token)
  }
}
