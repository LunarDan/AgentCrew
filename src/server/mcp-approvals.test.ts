import { afterEach, describe, expect, it } from 'vitest'

import {
  forgetConversation,
  isExternalMcpTool,
  isToolApproved,
  parseMcpToolName,
  rememberApproval,
} from './mcp-approvals'

// 审批记忆是跨测试共享的 globalThis 单例，每个用例后自行清理，避免顺序耦合。
const CONVS = ['conv_a', 'conv_b', 'conv_c']
afterEach(() => {
  for (const id of CONVS) forgetConversation(id)
})

describe('isExternalMcpTool', () => {
  it('recognizes third-party server tools', () => {
    expect(isExternalMcpTool('mcp__fs__read_file')).toBe(true)
    expect(isExternalMcpTool('mcp__github__create_issue')).toBe(true)
  })

  it('excludes AgentHub own bridge tools', () => {
    expect(isExternalMcpTool('mcp__agenthub__write_artifact')).toBe(false)
    expect(isExternalMcpTool('mcp__agenthub__ask_user')).toBe(false)
  })

  it('does not treat a server merely starting with the bridge name as the bridge', () => {
    expect(isExternalMcpTool('mcp__agenthub_extra__x')).toBe(true)
  })

  it('ignores built-in tool names', () => {
    expect(isExternalMcpTool('Read')).toBe(false)
    expect(isExternalMcpTool('Bash')).toBe(false)
    expect(isExternalMcpTool('fs_write')).toBe(false)
    expect(isExternalMcpTool('')).toBe(false)
  })
})

describe('parseMcpToolName', () => {
  it('splits server and tool on the first separator', () => {
    expect(parseMcpToolName('mcp__fs__read_file')).toEqual({
      serverName: 'fs',
      bareToolName: 'read_file',
    })
  })

  it('keeps underscores inside the server name', () => {
    expect(parseMcpToolName('mcp__my_server__do_thing')).toEqual({
      serverName: 'my_server',
      bareToolName: 'do_thing',
    })
  })

  it('treats only the first __ as the separator', () => {
    expect(parseMcpToolName('mcp__fs__read__all')).toEqual({
      serverName: 'fs',
      bareToolName: 'read__all',
    })
  })

  it('returns null for anything that cannot yield a server and a tool', () => {
    expect(parseMcpToolName('mcp__noseparator')).toBeNull()
    expect(parseMcpToolName('mcp__')).toBeNull()
    expect(parseMcpToolName('mcp__fs__')).toBeNull()
    expect(parseMcpToolName('mcp____read')).toBeNull()
    expect(parseMcpToolName('Read')).toBeNull()
    expect(parseMcpToolName('')).toBeNull()
  })
})

describe('approval memory', () => {
  it('starts unapproved', () => {
    expect(isToolApproved('conv_a', 'mcp__fs__read_file')).toBe(false)
  })

  it('remembers an approval', () => {
    rememberApproval('conv_a', 'mcp__fs__read_file')
    expect(isToolApproved('conv_a', 'mcp__fs__read_file')).toBe(true)
  })

  it('does not leak an approval across conversations or tools', () => {
    rememberApproval('conv_a', 'mcp__fs__read_file')
    // 粒度就是 per-tool-per-conversation：新会话重新问，同会话的另一工具也重新问。
    expect(isToolApproved('conv_b', 'mcp__fs__read_file')).toBe(false)
    expect(isToolApproved('conv_a', 'mcp__fs__write_file')).toBe(false)
  })

  it('forgets everything for a deleted conversation', () => {
    rememberApproval('conv_a', 'mcp__fs__read_file')
    forgetConversation('conv_a')
    expect(isToolApproved('conv_a', 'mcp__fs__read_file')).toBe(false)
  })

  it('is idempotent', () => {
    rememberApproval('conv_a', 'mcp__fs__read_file')
    rememberApproval('conv_a', 'mcp__fs__read_file')
    expect(isToolApproved('conv_a', 'mcp__fs__read_file')).toBe(true)
  })
})
