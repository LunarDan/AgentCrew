import { randomBytes } from 'node:crypto'

/**
 * 一次性的移动端事件流 token（specs/14-mobile-remote.md §6.3 fallback）。
 *
 * EventSource 不能带 Authorization header，所以先用 Bearer 换一个 30 秒有效的
 * 一次性 token，再把它放到 URL 上。纯内存，进程重启即失效。
 */

export const MOBILE_STREAM_TOKEN_TTL_MS = 30_000

const globalForTokens = globalThis as unknown as {
  __agenthubMobileStreamTokens?: Map<string, number>
}

const tokens = globalForTokens.__agenthubMobileStreamTokens ?? new Map<string, number>()
if (!globalForTokens.__agenthubMobileStreamTokens) {
  globalForTokens.__agenthubMobileStreamTokens = tokens
}

export function issueMobileStreamToken(now = Date.now()): string {
  pruneExpired(now)
  const token = randomBytes(24).toString('base64url')
  tokens.set(token, now + MOBILE_STREAM_TOKEN_TTL_MS)
  return token
}

/** 一次性：校验通过立即删除，重复使用失败。 */
export function consumeMobileStreamToken(token: string, now = Date.now()): boolean {
  pruneExpired(now)
  const expiresAt = tokens.get(token)
  if (expiresAt === undefined) return false
  tokens.delete(token)
  return expiresAt > now
}

export function clearMobileStreamTokensForTest(): void {
  tokens.clear()
}

function pruneExpired(now: number): void {
  for (const [token, expiresAt] of tokens) {
    if (expiresAt <= now) tokens.delete(token)
  }
}
