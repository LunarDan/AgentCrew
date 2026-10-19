import { describe, expect, it } from 'vitest'

import type { ToolContext } from './types'
import { isPublicIpAddress, parseFetchUrl, webFetchTool } from './web-fetch'

const ctx: ToolContext = {
  conversationId: 'conv_1',
  workspacePath: '/tmp/workspace',
  agentId: 'agent_1',
  runId: 'run_1',
  abortSignal: new AbortController().signal,
}

describe('isPublicIpAddress', () => {
  it.each([
    '127.0.0.1',
    '127.10.20.30',
    '10.0.0.1',
    '172.16.5.4',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '192.0.2.10',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
  ])('blocks private or reserved IPv4 %s', (address) => {
    expect(isPublicIpAddress(address)).toBe(false)
  })

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1'])(
    'allows public IPv4 %s',
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true)
    },
  )

  it.each([
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.5',
    '2002:7f00:1::',
    '64:ff9b::7f00:1',
  ])('blocks private or reserved IPv6 %s', (address) => {
    expect(isPublicIpAddress(address)).toBe(false)
  })

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'])(
    'allows public IPv6 %s',
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true)
    },
  )

  it('rejects unparseable addresses', () => {
    expect(isPublicIpAddress('example.com')).toBe(false)
    expect(isPublicIpAddress('999.1.1.1')).toBe(false)
    expect(isPublicIpAddress('')).toBe(false)
  })
})

describe('parseFetchUrl', () => {
  it.each([
    'https://example.com/docs',
    'http://example.com:8080/path?q=1',
    'http://8.8.8.8/',
    'http://[2606:4700:4700::1111]/',
  ])('accepts public http(s) URL %s', (raw) => {
    expect(parseFetchUrl(raw).toString()).toBeTruthy()
  })

  it.each([
    ['file:///etc/passwd', /Only http/],
    ['ftp://example.com/file', /Only http/],
    ['javascript:alert(1)', /Only http|Invalid URL/],
    ['not a url', /Invalid URL/],
    ['http://user:pass@example.com/', /credentials/],
    ['http://localhost/', /Blocked host/],
    ['http://LOCALHOST./', /Blocked host/],
    ['http://api.localhost/', /Blocked host/],
    ['http://127.0.0.1/', /not a public address/],
    ['http://[::1]/', /not a public address/],
    ['http://169.254.169.254/latest/meta-data/', /not a public address/],
    ['http://2130706433/', /not a public address/],
    ['http://0x7f000001/', /not a public address/],
    ['http://127.1/', /not a public address/],
  ])('rejects %s', (raw, message) => {
    expect(() => parseFetchUrl(raw)).toThrow(message)
  })
})

describe('webFetchTool handler', () => {
  it('rejects malformed args', async () => {
    const result = await webFetchTool.handler({}, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/Invalid args/)
  })

  it('rejects non-http protocols before any request', async () => {
    const result = await webFetchTool.handler({ url: 'file:///etc/passwd' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/Only http/)
  })

  it('rejects private targets before any request', async () => {
    const result = await webFetchTool.handler({ url: 'http://127.0.0.1:3000/' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not a public address/)
  })

  it('returns an error when the run is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await webFetchTool.handler(
      { url: 'https://example.com/' },
      { ...ctx, abortSignal: controller.signal },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/aborted/)
  })
})
