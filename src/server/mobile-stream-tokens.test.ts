import { afterEach, describe, expect, it } from 'vitest'

import {
  clearMobileStreamTokensForTest,
  consumeMobileStreamToken,
  issueMobileStreamToken,
  MOBILE_STREAM_TOKEN_TTL_MS,
} from './mobile-stream-tokens'

const DEVICE_TOKEN = 'device-token-for-tests'

afterEach(() => {
  clearMobileStreamTokensForTest()
})

describe('mobile stream tokens', () => {
  it('issues a token that can be consumed exactly once', () => {
    const token = issueMobileStreamToken(DEVICE_TOKEN)

    expect(token.length).toBeGreaterThan(20)
    expect(consumeMobileStreamToken(token, DEVICE_TOKEN)).toBe(true)
    expect(consumeMobileStreamToken(token, DEVICE_TOKEN)).toBe(false)
  })

  it('rejects unknown tokens', () => {
    expect(consumeMobileStreamToken('not-a-token', DEVICE_TOKEN)).toBe(false)
  })

  it('rejects tokens issued for a different device token', () => {
    const token = issueMobileStreamToken(DEVICE_TOKEN)

    expect(consumeMobileStreamToken(token, 'rotated-device-token')).toBe(false)
    // 失败也消耗掉，避免拿旧 token 反复试探
    expect(consumeMobileStreamToken(token, DEVICE_TOKEN)).toBe(false)
  })

  it('rejects expired tokens', () => {
    const now = 1_000_000
    const token = issueMobileStreamToken(DEVICE_TOKEN, now)

    expect(
      consumeMobileStreamToken(token, DEVICE_TOKEN, now + MOBILE_STREAM_TOKEN_TTL_MS),
    ).toBe(false)
  })

  it('does not revive an expired token that was never consumed', () => {
    const now = 1_000_000
    const token = issueMobileStreamToken(DEVICE_TOKEN, now)

    expect(
      consumeMobileStreamToken(token, DEVICE_TOKEN, now + MOBILE_STREAM_TOKEN_TTL_MS + 1),
    ).toBe(false)
    expect(consumeMobileStreamToken(token, DEVICE_TOKEN, now)).toBe(false)
  })
})
