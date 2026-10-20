import { describe, expect, it } from 'vitest'

import { getToolDisplayName, isBashToolName } from './tool-display'

describe('tool display helpers', () => {
  it('formats AgentHub tool names', () => {
    expect(getToolDisplayName('read_artifact')).toBe('读取产物')
    expect(getToolDisplayName('read_attachment')).toBe('读取附件')
  })

  it('formats MCP-prefixed AgentHub tool names', () => {
    expect(getToolDisplayName('mcp__agenthub__read_attachment')).toBe('读取附件')
    expect(getToolDisplayName('codex_mcp_agenthub_write_artifact')).toBe('创建产物')
  })

  it('formats common external tool names', () => {
    expect(getToolDisplayName('Bash')).toBe('执行命令')
    expect(getToolDisplayName('Grep')).toBe('搜索文本')
  })

  it('detects direct and prefixed bash tools', () => {
    expect(isBashToolName('bash')).toBe(true)
    expect(isBashToolName('mcp__agenthub__bash')).toBe(true)
    expect(isBashToolName('read_attachment')).toBe(false)
  })

  it('does not resolve prototype-chain keys to non-string labels', () => {
    // 外部 MCP server 可以用 __proto__ / constructor 当工具名（LLM 输出不可信）
    expect(getToolDisplayName('__proto__')).toBe('__proto__')
    expect(getToolDisplayName('constructor')).toBe('constructor')
    expect(typeof getToolDisplayName('mcp__x__toString')).toBe('string')
  })
})
