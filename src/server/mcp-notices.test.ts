import { describe, expect, it } from 'vitest'

import { formatResolutionWarnings, formatUnavailableNotice } from './mcp-notices'

describe('formatResolutionWarnings', () => {
  it('returns null when there is nothing to report', () => {
    expect(formatResolutionWarnings([])).toBeNull()
  })

  it('keeps every warning on its own line', () => {
    expect(
      formatResolutionWarnings([
        'MCP server "a" has no command; skipped.',
        'MCP server "b" has no url; skipped.',
      ]),
    ).toBe(
      '[MCP] 外部 MCP server 配置有问题，本次运行已跳过：\n' +
        '- MCP server "a" has no command; skipped.\n' +
        '- MCP server "b" has no url; skipped.',
    )
  })
})

describe('formatUnavailableNotice', () => {
  it('returns null when every server connected', () => {
    expect(formatUnavailableNotice([])).toBeNull()
  })

  it('names each unavailable server with its status', () => {
    expect(
      formatUnavailableNotice([
        { name: 'broken', status: 'failed' },
        { name: 'unauthed', status: 'needs-auth' },
      ]),
    ).toBe(
      '[MCP] 外部 MCP server 未能连接，本次运行不会提供它们的工具：\n' +
        '- broken（failed）\n' +
        '- unauthed（needs-auth）',
    )
  })
})
