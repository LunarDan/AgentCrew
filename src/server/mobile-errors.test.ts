import type { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

import { mobileErrorJson, MobileNotFoundError, mobileUserErrorJson } from './mobile-errors'

function fakeRequest(): NextRequest {
  return { headers: new Headers() } as unknown as NextRequest
}

describe('mobileErrorJson', () => {
  it('maps not-found errors to 404', async () => {
    const res = mobileErrorJson(fakeRequest(), new MobileNotFoundError('gone'), 'test')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'gone' })
  })

  it('never echoes internal error text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = mobileErrorJson(fakeRequest(), new Error("EPERM: open 'C:\\secret\\file'"), 'test')
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'Internal error' })
      expect(log).toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })
})

describe('mobileUserErrorJson', () => {
  it('keeps actionable conversation errors at 400', async () => {
    const res = mobileUserErrorJson(
      fakeRequest(),
      new Error('Only the latest user message can be withdrawn'),
      'withdraw',
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'Only the latest user message can be withdrawn',
    })
  })

  it('treats unknown errors as internal', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = mobileUserErrorJson(fakeRequest(), new Error('SQLITE_BUSY: database is locked'), 'edit')
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'Internal error' })
    } finally {
      log.mockRestore()
    }
  })
})
