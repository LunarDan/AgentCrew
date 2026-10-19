import { randomInt } from 'node:crypto'

/**
 * 一次性配对码（specs/14-mobile-remote.md §5.3）。
 *
 * 只存在内存里：进程重启后旧码失效，符合「5 分钟 / 一次性」的预期。
 * 猜测防护：每个码最多错 5 次即作废；全局每分钟最多接受 20 次失败。
 */

export const PAIRING_CODE_TTL_MS = 5 * 60_000
export const PAIRING_CODE_MAX_ATTEMPTS = 5

const RATE_WINDOW_MS = 60_000
const RATE_MAX_FAILURES = 20
const CODE_LENGTH = 6

interface PairingState {
  active: { code: string; expiresAt: number; attempts: number } | null
  failures: number[]
}

const globalForPairing = globalThis as unknown as {
  __agenthubPairing?: PairingState
}
const state: PairingState = globalForPairing.__agenthubPairing ?? {
  active: null,
  failures: [],
}
if (!globalForPairing.__agenthubPairing) {
  globalForPairing.__agenthubPairing = state
}

export type PairingFailureReason =
  | 'invalid'
  | 'expired'
  | 'too-many-attempts'
  | 'rate-limited'

export type PairingResult = { ok: true } | { ok: false; reason: PairingFailureReason }

export function issuePairingCode(now = Date.now()): { code: string; expiresAt: number } {
  const code = randomInt(0, 10 ** CODE_LENGTH).toString().padStart(CODE_LENGTH, '0')
  state.active = { code, expiresAt: now + PAIRING_CODE_TTL_MS, attempts: 0 }
  return { code, expiresAt: state.active.expiresAt }
}

/** 成功即作废；失败按次数与全局速率限制记录。 */
export function consumePairingCode(input: string, now = Date.now()): PairingResult {
  pruneFailures(now)
  if (state.failures.length >= RATE_MAX_FAILURES) return { ok: false, reason: 'rate-limited' }

  const active = state.active
  if (!active) {
    recordFailure(now)
    return { ok: false, reason: 'invalid' }
  }
  if (active.expiresAt <= now) {
    state.active = null
    recordFailure(now)
    return { ok: false, reason: 'expired' }
  }

  if (input.replace(/\s+/g, '') !== active.code) {
    active.attempts += 1
    recordFailure(now)
    if (active.attempts >= PAIRING_CODE_MAX_ATTEMPTS) {
      state.active = null
      return { ok: false, reason: 'too-many-attempts' }
    }
    return { ok: false, reason: 'invalid' }
  }

  state.active = null
  return { ok: true }
}

export function hasActivePairingCode(now = Date.now()): boolean {
  return !!state.active && state.active.expiresAt > now
}

/** 仅测试用：清空内存状态，避免用例互相影响。 */
export function clearPairingCodesForTest(): void {
  state.active = null
  state.failures = []
}

function recordFailure(now: number): void {
  state.failures.push(now)
  pruneFailures(now)
}

function pruneFailures(now: number): void {
  const cutoff = now - RATE_WINDOW_MS
  state.failures = state.failures.filter((at) => at > cutoff)
}
