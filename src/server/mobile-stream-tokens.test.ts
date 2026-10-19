import { afterEach, describe, expect, it } from 'vitest'

import { hashMobileDeviceToken } from './mobile-token-hash'
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
  it('issues a token bound to the device token, consumable exactly once', () => {
    const token = issueMobileStreamToken(DEVICE_TOKEN)

    expect(token.length).toBeGreaterThan(20)
    expect(consumeMobileStreamToken(token)).toBe(hashMobileDeviceToken(DEVICE_TOKEN))
    expect(consumeMobileStreamToken(token)).toBeNull()
  })

  it('rejects unknown tokens', () => {
    expect(consumeMobileStreamToken('not-a-token')).toBeNull()
  })

  it('rejects expired tokens', () => {
    const now = 1_000_000
    const token = issueMobileStreamToken(DEVICE_TOKEN, now)

    expect(consumeMobileStreamToken(token, now + MOBILE_STREAM_TOKEN_TTL_MS)).toBeNull()
  })

  it('does not revive an expired token that was never consumed', () => {
    const now = 1_000_000
    const token = issueMobileStreamToken(DEVICE_TOKEN, now)

    expect(consumeMobileStreamToken(token, now + MOBILE_STREAM_TOKEN_TTL_MS + 1)).toBeNull()
    expect(consumeMobileStreamToken(token, now)).toBeNull()
  })
})
