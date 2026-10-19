import { describe, expect, it } from 'vitest'

import type { ResolvedMcpServer } from '@/shared/types'

import {
  MAX_TOOL_RESULT_CHARS,
  buildExposedToolName,
  buildMcpToolTable,
  clampToolResult,
  mcpResultToValue,
  sanitizeFunctionNamePart,
  type McpToolDefinition,
} from './custom-mcp-tools'

function stdioServer(name: string): ResolvedMcpServer {
  return { name, trust: 'ask', transport: 'stdio', command: 'node', args: [] }
}

function tool(name: string): McpToolDefinition {
  return { name, description: '', inputSchema: { type: 'object', properties: {} } }
}

describe('sanitizeFunctionNamePart', () => {
  it('replaces characters OpenAI function names reject', () => {
    expect(sanitizeFunctionNamePart('my.tool:v 2')).toBe('my_tool_v_2')
  })

  it('leaves legal characters alone', () => {
    expect(sanitizeFunctionNamePart('read_file-2')).toBe('read_file-2')
  })
})

describe('buildExposedToolName', () => {
  it('keeps a legal namespaced name unchanged', () => {
    expect(buildExposedToolName('fs', 'read', () => false)).toBe('mcp__fs__read')
  })

  it('sanitizes illegal characters and still routes by table', () => {
    expect(buildExposedToolName('fs', 'read.file', () => false)).toBe('mcp__fs__read_file')
  })

  it('caps the name at 64 characters with a stable hash suffix', () => {
    const longTool = 't'.repeat(80)
    const first = buildExposedToolName('server', longTool, () => false)
    const second = buildExposedToolName('server', longTool, () => false)

    expect(first.length).toBe(64)
    expect(first).toMatch(/_[0-9a-f]{8}$/)
    expect(second).toBe(first)
  })

  it('disambiguates names that collide after sanitization', () => {
    const first = buildExposedToolName('fs', 'read.file', () => false)
    const second = buildExposedToolName('fs', 'read_file', (candidate) => candidate === first)

    expect(second).not.toBe(first)
    expect(second.length).toBeLessThanOrEqual(64)
  })

  it('yields to reserved built-in names', () => {
    const name = buildExposedToolName('fs', 'read', (candidate) => candidate === 'mcp__fs__read')
    expect(name).not.toBe('mcp__fs__read')
  })
})

describe('buildMcpToolTable', () => {
  it('maps an exposed name back to the original server and tool', () => {
    const server = stdioServer('fs')
    const table = buildMcpToolTable({
      servers: [server],
      toolsByServer: new Map([['fs', [tool('read')]]]),
    })

    expect(table.tools).toHaveLength(1)
    expect(table.byExposedName.get('mcp__fs__read')).toMatchObject({
      serverName: 'fs',
      toolName: 'read',
      trust: 'ask',
    })
  })

  it('gives built-in tools precedence on a collision', () => {
    const server = stdioServer('fs')
    const table = buildMcpToolTable({
      servers: [server],
      toolsByServer: new Map([['fs', [tool('read')]]]),
      reservedNames: ['mcp__fs__read'],
    })

    expect(table.byExposedName.has('mcp__fs__read')).toBe(false)
    expect(table.tools[0].exposedName).not.toBe('mcp__fs__read')
  })
})

describe('mcpResultToValue', () => {
  it('prefers structuredContent over content', () => {
    expect(
      mcpResultToValue({
        structuredContent: { ok: true },
        content: [{ type: 'text', text: 'ignored' }],
      }),
    ).toEqual({ ok: true })
  })

  it('joins text content', () => {
    expect(
      mcpResultToValue({
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'text', text: 'line 2' },
        ],
      }),
    ).toBe('line 1\nline 2')
  })

  it('describes binary content without inlining the bytes', () => {
    const value = mcpResultToValue({
      content: [{ type: 'image', data: 'AAAB', mimeType: 'image/png' }],
    })

    expect(value).toEqual([{ type: 'image', mimeType: 'image/png', dataOmitted: true }])
    expect(JSON.stringify(value)).not.toContain('AAAB')
  })

  it('omits resource blobs but keeps text resources', () => {
    const value = mcpResultToValue({
      content: [
        {
          type: 'resource',
          resource: { uri: 'file:///secret.bin', mimeType: 'application/octet-stream', blob: 'SECRET' },
        },
        {
          type: 'resource',
          resource: { uri: 'file:///readme.txt', mimeType: 'text/plain', text: 'hello' },
        },
      ],
    })

    const serialized = JSON.stringify(value)
    expect(serialized).not.toContain('SECRET')
    expect(serialized).toContain('blobOmitted')
    expect(serialized).toContain('hello')
  })

  it('does not treat isError as a value transformation', () => {
    expect(
      mcpResultToValue({ isError: true, content: [{ type: 'text', text: 'boom' }] }),
    ).toBe('boom')
  })
})

describe('clampToolResult', () => {
  it('leaves short values untouched', () => {
    expect(clampToolResult('short')).toBe('short')
  })

  it('truncates long strings at the cap', () => {
    const value = clampToolResult('x'.repeat(MAX_TOOL_RESULT_CHARS + 10))
    expect(typeof value).toBe('string')
    expect((value as string).length).toBe(MAX_TOOL_RESULT_CHARS + '\n[truncated]'.length)
    expect(value).toMatch(/\[truncated\]$/)
  })

  it('truncates oversized structured values', () => {
    const value = clampToolResult([{ text: 'y'.repeat(MAX_TOOL_RESULT_CHARS) }])
    expect(typeof value).toBe('string')
    expect(value).toMatch(/\[truncated\]$/)
  })
})
