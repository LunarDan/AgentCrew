import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireMobileStreamSlot,
  MAX_MOBILE_STREAM_CONNECTIONS,
  MAX_MOBILE_STREAM_CONNECTIONS_PER_TOKEN,
  mobileStreamConnectionCount,
  resetMobileStreamSlotsForTest,
} from './mobile-stream-slots'

afterEach(() => {
  resetMobileStreamSlotsForTest()
})

describe('mobile stream slots', () => {
  it('limits concurrent streams per device token', () => {
    const slots = Array.from({ length: MAX_MOBILE_STREAM_CONNECTIONS_PER_TOKEN }, () =>
      acquireMobileStreamSlot('hash-a'),
    )
    expect(slots.every((slot) => slot !== null)).toBe(true)
    expect(acquireMobileStreamSlot('hash-a')).toBeNull()
    expect(acquireMobileStreamSlot('hash-b')).not.toBeNull()
  })

  it('limits the total across all tokens', () => {
    const held = []
    for (let i = 0; i < MAX_MOBILE_STREAM_CONNECTIONS; i++) {
      const slot = acquireMobileStreamSlot(`hash-${i}`)
      expect(slot).not.toBeNull()
      held.push(slot)
    }
    expect(acquireMobileStreamSlot('hash-extra')).toBeNull()
    expect(mobileStreamConnectionCount()).toBe(MAX_MOBILE_STREAM_CONNECTIONS)
  })

  it('releases a slot exactly once', () => {
    const slot = acquireMobileStreamSlot('hash-a')
    expect(slot).not.toBeNull()
    slot!.release()
    slot!.release()
    expect(mobileStreamConnectionCount()).toBe(0)
    expect(acquireMobileStreamSlot('hash-a')).not.toBeNull()
  })
})
