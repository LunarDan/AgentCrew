import { afterEach, describe, expect, it } from 'vitest'

import {
  clearMobileStreamTokensForTest,
  consumeMobileStreamToken,
  issueMobileStreamToken,
  MOBILE_STREAM_TOKEN_TTL_MS,
} from './mobile-stream-tokens'

afterEach(() => {
  clearMobileStreamTokensForTest()
})

describe('mobile stream tokens', () => {
  it('issues a token that can be consumed exactly once', () => {
    const token = issueMobileStreamToken()

    expect(token.length).toBeGreaterThan(20)
    expect(consumeMobileStreamToken(token)).toBe(true)
    expect(consumeMobileStreamToken(token)).toBe(false)
  })

  it('rejects unknown tokens', () => {
    expect(consumeMobileStreamToken('not-a-token')).toBe(false)
  })

  it('rejects expired tokens', () => {
    const now = 1_000_000
    const token = issueMobileStreamToken(now)

    expect(consumeMobileStreamToken(token, now + MOBILE_STREAM_TOKEN_TTL_MS)).toBe(false)
  })

  it('does not revive an expired token that was never consumed', () => {
    const now = 1_000_000
    const token = issueMobileStreamToken(now)

    expect(consumeMobileStreamToken(token, now + MOBILE_STREAM_TOKEN_TTL_MS + 1)).toBe(false)
    expect(consumeMobileStreamToken(token, now)).toBe(false)
  })
})
