import { describe, expect, it } from 'vitest'

import { hasCommandString, isShellTool, SHELL_TOOL_NAMES } from './shell-tool'

const command = { command: 'Get-ChildItem' }

describe('isShellTool', () => {
  it('treats Bash as a shell tool', () => {
    expect(isShellTool('Bash', command, null)).toBe(true)
  })

  it('treats PowerShell as a shell tool — the Windows regression', () => {
    expect(isShellTool('PowerShell', command, ['PowerShell', 'Read', 'Write'])).toBe(true)
  })

  it('matches known names case-insensitively', () => {
    expect(isShellTool('powershell', command, null)).toBe(true)
    expect(isShellTool('BASH', command, null)).toBe(true)
  })

  it('never treats an external MCP tool as a shell tool, even with a command', () => {
    expect(isShellTool('mcp__probe__run', command, ['mcp__probe__run'])).toBe(false)
  })

  it('does not treat a tool without a command as a shell tool', () => {
    expect(isShellTool('Write', { file_path: 'x' }, ['Write', 'Read'])).toBe(false)
  })

  it('treats an unknown name with a command as shell when it is in the run tool table', () => {
    expect(isShellTool('RunCommand', command, ['RunCommand', 'Read'])).toBe(true)
  })

  it('does not treat an unknown name as shell when it is absent from the tool table', () => {
    expect(isShellTool('RunCommand', command, ['Bash', 'Read'])).toBe(false)
  })

  it('fails closed before the tool table arrives', () => {
    expect(isShellTool('RunCommand', command, null)).toBe(true)
  })

  it('does not treat an unknown name without a command as shell before init', () => {
    expect(isShellTool('RunCommand', { query: 'x' }, null)).toBe(false)
  })
})

describe('hasCommandString', () => {
  it('requires a non-blank command string', () => {
    expect(hasCommandString({ command: 'ls' })).toBe(true)
    expect(hasCommandString({ command: '   ' })).toBe(false)
    expect(hasCommandString({ command: 42 })).toBe(false)
    expect(hasCommandString({})).toBe(false)
  })
})

describe('SHELL_TOOL_NAMES', () => {
  it('covers the platform names observed so far', () => {
    expect(SHELL_TOOL_NAMES.has('bash')).toBe(true)
    expect(SHELL_TOOL_NAMES.has('powershell')).toBe(true)
  })
})
