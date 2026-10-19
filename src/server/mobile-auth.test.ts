import { describe, expect, it, vi } from 'vitest'

// 阻断 settings-service → db/client 的建库副作用：这个测试只验证纯 token 解析。
vi.mock('./settings-service', () => ({ getAppSettings: vi.fn() }))

import { resolveExpectedMobileToken } from './mobile-auth'

describe('resolveExpectedMobileToken', () => {
  it('prefers an injected environment token', () => {
    expect(
      resolveExpectedMobileToken('  env-token  ', {
        companionMode: 'off',
        mobileDeviceToken: 'stored-token',
      }),
    ).toBe('env-token')
  })

  it('falls back to the stored companion token when companion mode is on', () => {
    expect(
      resolveExpectedMobileToken(undefined, {
        companionMode: 'lan',
        mobileDeviceToken: 'stored-token',
      }),
    ).toBe('stored-token')
    expect(
      resolveExpectedMobileToken(undefined, {
        companionMode: 'tailnet',
        mobileDeviceToken: ' stored-token ',
      }),
    ).toBe('stored-token')
  })

  it('does not accept the stored token while companion mode is off', () => {
    expect(
      resolveExpectedMobileToken(undefined, {
        companionMode: 'off',
        mobileDeviceToken: 'stored-token',
      }),
    ).toBeNull()
  })

  it('treats a blank or missing stored token as unconfigured', () => {
    expect(
      resolveExpectedMobileToken(undefined, {
        companionMode: 'lan',
        mobileDeviceToken: null,
      }),
    ).toBeNull()
    expect(
      resolveExpectedMobileToken(undefined, {
        companionMode: 'lan',
        mobileDeviceToken: '   ',
      }),
    ).toBeNull()
  })

  it('treats a blank environment token as absent', () => {
    expect(
      resolveExpectedMobileToken('   ', {
        companionMode: 'tailnet',
        mobileDeviceToken: 'stored-token',
      }),
    ).toBe('stored-token')
  })
})
