import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'

import { rejectCrossOriginWrite } from './local-origin'

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest(new URL('http://127.0.0.1:3000/api/settings'), {
    method: 'POST',
    headers,
  })
}

describe('rejectCrossOriginWrite', () => {
  it('allows same-origin writes', () => {
    expect(
      rejectCrossOriginWrite(request({ origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' })),
    ).toBeNull()
  })

  it('allows non-browser calls without origin headers', () => {
    expect(rejectCrossOriginWrite(request({}))).toBeNull()
  })

  it('rejects a cross-site origin', () => {
    const res = rejectCrossOriginWrite(request({ origin: 'http://evil.example' }))
    expect(res?.status).toBe(403)
  })

  it('rejects browser cross-site fetches even without an origin', () => {
    const res = rejectCrossOriginWrite(request({ 'sec-fetch-site': 'cross-site' }))
    expect(res?.status).toBe(403)
  })
})
