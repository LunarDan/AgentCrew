import { describe, expect, it } from 'vitest'

import { validateEndpointUrl } from './endpoint-url'

describe('validateEndpointUrl', () => {
  it('accepts an empty value as "use the default endpoint"', () => {
    expect(validateEndpointUrl('', 'Base URL')).toBeNull()
    expect(validateEndpointUrl('   ', 'Base URL')).toBeNull()
    expect(validateEndpointUrl(null, 'Base URL')).toBeNull()
    expect(validateEndpointUrl(undefined, 'Base URL')).toBeNull()
  })

  it('accepts http and https URLs', () => {
    expect(validateEndpointUrl('https://api.anthropic.com', 'Base URL')).toBeNull()
    expect(validateEndpointUrl(' http://localhost:8080/v1 ', 'Base URL')).toBeNull()
  })

  it('rejects a value that is not a full URL', () => {
    expect(validateEndpointUrl('anyrouter.top', 'Base URL')).toMatch(/Base URL.*完整 URL/)
    expect(validateEndpointUrl('/v1/chat', 'Base URL')).not.toBeNull()
  })

  it('rejects non-http protocols', () => {
    expect(validateEndpointUrl('ftp://example.com', 'Base URL')).toMatch(/http/)
    expect(validateEndpointUrl('file:///tmp/x', 'Base URL')).toMatch(/http/)
  })
})
