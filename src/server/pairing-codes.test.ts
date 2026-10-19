import { afterEach, describe, expect, it } from 'vitest'

import {
  clearPairingCodesForTest,
  consumePairingCode,
  hasActivePairingCode,
  issuePairingCode,
  PAIRING_CODE_MAX_ATTEMPTS,
  PAIRING_CODE_TTL_MS,
} from './pairing-codes'

afterEach(() => {
  clearPairingCodesForTest()
})

describe('pairing codes', () => {
  it('issues a six-digit code that can be consumed once', () => {
    const { code, expiresAt } = issuePairingCode(1_000)

    expect(code).toMatch(/^\d{6}$/)
    expect(expiresAt).toBe(1_000 + PAIRING_CODE_TTL_MS)
    expect(consumePairingCode(code, 1_001)).toEqual({ ok: true })
    expect(consumePairingCode(code, 1_002)).toEqual({ ok: false, reason: 'invalid' })
    expect(hasActivePairingCode(1_002)).toBe(false)
  })

  it('accepts the code with surrounding whitespace (manual entry)', () => {
    const { code } = issuePairingCode(1_000)
    expect(consumePairingCode(` ${code.slice(0, 3)} ${code.slice(3)} `, 1_001)).toEqual({
      ok: true,
    })
  })

  it('rejects expired codes', () => {
    const { code } = issuePairingCode(1_000)
    expect(consumePairingCode(code, 1_000 + PAIRING_CODE_TTL_MS + 1)).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(hasActivePairingCode(1_000 + PAIRING_CODE_TTL_MS + 1)).toBe(false)
  })

  it('invalidates a code after too many wrong guesses', () => {
    const { code } = issuePairingCode(1_000)
    const wrong = code === '000000' ? '111111' : '000000'

    for (let i = 0; i < PAIRING_CODE_MAX_ATTEMPTS - 1; i++) {
      expect(consumePairingCode(wrong, 1_001)).toEqual({ ok: false, reason: 'invalid' })
    }
    expect(consumePairingCode(wrong, 1_001)).toEqual({
      ok: false,
      reason: 'too-many-attempts',
    })
    // 作废后即使猜对也不行
    expect(consumePairingCode(code, 1_001)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rate-limits repeated failures across codes', () => {
    issuePairingCode(1_000)
    const wrong = 'zzzzzz'

    let lastReason: string | null = null
    for (let i = 0; i < 30; i++) {
      // 每次重新生成一个码，隔离「单码 5 次」限制，只观察全局速率限制
      issuePairingCode(1_000)
      const result = consumePairingCode(wrong, 1_000)
      if (!result.ok) lastReason = result.reason
    }
    expect(lastReason).toBe('rate-limited')
  })

  it('still accepts the correct code after an attacker exhausts the global failure budget', () => {
    for (let i = 0; i < 25; i++) {
      issuePairingCode(1_000)
      consumePairingCode('zzzzzz', 1_000)
    }
    const { code } = issuePairingCode(1_000)
    expect(consumePairingCode(code, 1_000)).toEqual({ ok: true })
  })

  it('recovers after the rate-limit window passes', () => {
    issuePairingCode(1_000)
    for (let i = 0; i < 25; i++) consumePairingCode('zzzzzz', 1_000)
    expect(consumePairingCode('zzzzzz', 1_000)).toEqual({ ok: false, reason: 'rate-limited' })

    const later = 1_000 + 61_000
    const { code } = issuePairingCode(later)
    expect(consumePairingCode(code, later + 1)).toEqual({ ok: true })
  })
})
