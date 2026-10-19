import { describe, expect, it } from 'vitest'

import type { McpServerRow } from '@/db/schema'
import { adapterSupportsTransport } from '@/shared/mcp'
import {
  expandEnvPlaceholders,
  maskSecretValue,
  toMcpServerView,
  validateMcpServerInput,
} from './mcp-server-service'

describe('validateMcpServerInput', () => {
  it('accepts a well-formed stdio server', () => {
    expect(
      validateMcpServerInput({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'x'] }),
    ).toBeNull()
  })

  it('accepts a well-formed remote server', () => {
    expect(validateMcpServerInput({ name: 'remote', transport: 'sse', url: 'https://x/mcp' })).toBeNull()
    expect(validateMcpServerInput({ name: 'remote2', transport: 'http', url: 'https://x/mcp' })).toBeNull()
  })

  it('rejects names that cannot form a tool namespace', () => {
    expect(validateMcpServerInput({ name: 'My Server', transport: 'stdio', command: 'x' })).toMatch(
      /\^\[a-z0-9_\]\+\$/,
    )
    expect(validateMcpServerInput({ name: 'has-dash', transport: 'stdio', command: 'x' })).not.toBeNull()
  })

  it('rejects names containing the tool-namespace separator', () => {
    expect(
      validateMcpServerInput({ name: 'foo__bar', transport: 'stdio', command: 'x' }),
    ).toMatch(/__/)
  })

  it('reserves the adapter-owned bridge name', () => {
    expect(validateMcpServerInput({ name: 'agenthub', transport: 'stdio', command: 'x' })).toMatch(
      /reserved/,
    )
  })

  it('requires the fields the transport actually uses', () => {
    expect(validateMcpServerInput({ name: 'a', transport: 'stdio' })).toMatch(/require a command/)
    expect(validateMcpServerInput({ name: 'a', transport: 'sse' })).toMatch(/require a url/)
    expect(validateMcpServerInput({ name: 'a', transport: 'http' })).toMatch(/require a url/)
  })

  it('rejects mixing command and url', () => {
    expect(
      validateMcpServerInput({ name: 'a', transport: 'stdio', command: 'x', url: 'https://y' }),
    ).toMatch(/must not set a url/)
    expect(
      validateMcpServerInput({ name: 'a', transport: 'http', url: 'https://y', command: 'x' }),
    ).toMatch(/must not set a command/)
  })
})

describe('adapterSupportsTransport', () => {
  it('matches the verified SDK support matrix', () => {
    // Claude Agent SDK has stdio/sse/http; Codex has stdio/streamable-http but no sse.
    expect(adapterSupportsTransport('claude-code', 'stdio')).toBe(true)
    expect(adapterSupportsTransport('claude-code', 'sse')).toBe(true)
    expect(adapterSupportsTransport('claude-code', 'http')).toBe(true)

    expect(adapterSupportsTransport('codex', 'stdio')).toBe(true)
    expect(adapterSupportsTransport('codex', 'http')).toBe(true)
    expect(adapterSupportsTransport('codex', 'sse')).toBe(false)

    // custom uses the MCP SDK's own transports, so it matches Claude Code.
    expect(adapterSupportsTransport('custom', 'stdio')).toBe(true)
    expect(adapterSupportsTransport('custom', 'sse')).toBe(true)
    expect(adapterSupportsTransport('custom', 'http')).toBe(true)
  })

  it('reports no external MCP support for the mock adapter', () => {
    expect(adapterSupportsTransport('mock', 'stdio')).toBe(false)
  })
})

describe('expandEnvPlaceholders', () => {
  it('substitutes ${NAME} from the given environment', () => {
    const out = expandEnvPlaceholders({ TOKEN: '${GH_TOKEN}', PLAIN: 'literal' }, { GH_TOKEN: 'abc' })
    expect(out).toEqual({ TOKEN: 'abc', PLAIN: 'literal' })
  })

  it('substitutes every placeholder in a value', () => {
    const out = expandEnvPlaceholders({ URL: 'https://${HOST}/${PATH}' }, { HOST: 'h', PATH: 'p' })
    expect(out).toEqual({ URL: 'https://h/p' })
  })

  it('returns undefined for an absent map so adapters can omit the field', () => {
    expect(expandEnvPlaceholders(null, {})).toBeUndefined()
    expect(expandEnvPlaceholders({}, {})).toEqual({})
  })

  it('fails with the variable name when a placeholder cannot be resolved', () => {
    expect(() => expandEnvPlaceholders({ TOKEN: '${MISSING_VAR}' }, {})).toThrow(/MISSING_VAR/)
  })

  it('resolves at call time, not at storage time', () => {
    const stored = { TOKEN: '${ROTATING}' }
    expect(expandEnvPlaceholders(stored, { ROTATING: 'first' })).toEqual({ TOKEN: 'first' })
    expect(expandEnvPlaceholders(stored, { ROTATING: 'second' })).toEqual({ TOKEN: 'second' })
  })
})

describe('maskSecretValue', () => {
  it('shows only the tail of a literal secret', () => {
    expect(maskSecretValue('sk-1234567890abcd')).toEqual({ masked: '••••abcd' })
    expect(maskSecretValue('sk-1234567890abcd')).not.toEqual(expect.objectContaining({ masked: expect.stringContaining('1234567890') }))
  })

  it('does not pretend a short secret is hidden', () => {
    expect(maskSecretValue('abc')).toEqual({ masked: '••••abc' })
  })

  it('reports a placeholder as a reference rather than masking it', () => {
    expect(maskSecretValue('${GITHUB_TOKEN}')).toEqual({ placeholder: 'GITHUB_TOKEN' })
  })
})

describe('toMcpServerView', () => {
  const row: McpServerRow = {
    id: 'mcp_1',
    name: 'fs',
    transport: 'stdio',
    command: 'npx',
    args: ['-y'],
    env: { SUPER_SECRET_TOKEN: 'sk-verysecretvalue' },
    url: null,
    headers: null,
    trust: 'ask',
    enabled: false,
    createdAt: 1,
  }

  it('never returns plaintext secrets', () => {
    const view = toMcpServerView(row)
    expect(JSON.stringify(view)).not.toContain('sk-verysecretvalue')
    expect(JSON.stringify(view)).not.toContain('verysecretvalue')
  })

  it('preserves non-secret fields and marks presence', () => {
    const view = toMcpServerView(row)
    expect(view.name).toBe('fs')
    expect(view.command).toBe('npx')
    expect(view.env).toEqual({ SUPER_SECRET_TOKEN: { masked: '••••alue' } })
    expect(view.headers).toBeNull()
  })
})
