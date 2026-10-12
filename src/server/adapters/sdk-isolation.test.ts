import { describe, expect, it } from 'vitest'

import { sdkIsolationOptions } from './sdk-isolation'

/**
 * 这两条钉住的是安全不变量，不是实现细节：任何一条被改，workspace 里的
 * .claude/settings.json / 项目 hooks / .mcp.json 就能替 AgentHub 做权限决定。
 * 详见 CLAUDE.md §5.5 与 specs/11-platform.md。
 */
describe('sdkIsolationOptions', () => {
  it('不加载任何文件系统设置源', () => {
    expect(sdkIsolationOptions().settingSources).toEqual([])
  })

  it('MCP server 只来自 adapter 显式传入的 mcpServers', () => {
    expect(sdkIsolationOptions().strictMcpConfig).toBe(true)
  })
})
