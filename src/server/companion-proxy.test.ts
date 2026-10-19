import { describe, expect, it } from 'vitest'

import { isCompanionProxyPath } from '../../electron/companion-proxy'

describe('isCompanionProxyPath', () => {
  it('allows mobile API paths', () => {
    expect(isCompanionProxyPath('/api/mobile/snapshot')).toBe(true)
    expect(isCompanionProxyPath('/api/mobile/events?streamToken=abc')).toBe(true)
    expect(isCompanionProxyPath('/api/mobile/conversations/c1/messages')).toBe(true)
  })

  it('rejects desktop APIs', () => {
    expect(isCompanionProxyPath('/api/settings')).toBe(false)
    expect(isCompanionProxyPath('/api/mobile')).toBe(false)
    expect(isCompanionProxyPath('/api/mobilefoo')).toBe(false)
    expect(isCompanionProxyPath(undefined)).toBe(false)
  })

  it('rejects dot-segment traversal in any encoding', () => {
    expect(isCompanionProxyPath('/api/mobile/../settings')).toBe(false)
    expect(isCompanionProxyPath('/api/mobile/%2e%2e/settings')).toBe(false)
    expect(isCompanionProxyPath('/api/mobile/%2E%2E%2Fsettings')).toBe(false)
    expect(isCompanionProxyPath('/api/mobile/./snapshot')).toBe(false)
    expect(isCompanionProxyPath('/api/mobile//snapshot')).toBe(false)
  })

  it('rejects backslash and malformed escapes', () => {
    expect(isCompanionProxyPath('/api/mobile\\..\\settings')).toBe(false)
    expect(isCompanionProxyPath('/api/mobile%5C..%5Csettings')).toBe(false)
    expect(isCompanionProxyPath('/api/mobile/snapshot%5C')).toBe(false)
    expect(isCompanionProxyPath('/api/mobile/%E0%A4%A')).toBe(false)
  })
})
