import { currentPlatform, type Platform } from '@/server/platform'

/**
 * 跨 adapter / 工具共享的安全策略。
 *
 * 黑名单来自 specs/11-platform.md「命令黑名单」节，按宿主平台分支：
 * POSIX (macOS/Linux) 与 Windows 各一套。Bash 工具 (`src/server/tools/bash.ts`)
 * 与 Claude Code adapter (`src/server/adapters/claude-code-adapter.ts`)
 * 在执行 / 放行 shell 命令前都要走一遍。
 *
 * 新增 / 调整规则时同步 specs/11-platform.md 与 CLAUDE.md §5.2。
 */

const SHARED_BANNED: RegExp[] = []

const POSIX_BANNED: RegExp[] = [
  /\brm\s+-rf\s+\//,
  /\bsudo\b/,
  /\bchmod\s+\d{3,4}\s+\//,
  /:\(\)\{\s*:\|:&\s*\}/, // fork bomb
  /curl\s+[^|]*\|\s*(bash|sh)/,
  /wget\s+[^|]*\|\s*(bash|sh)/,
  /\beval\b/,
  /\bexec\b\s+/,
]

// PowerShell 接受无歧义参数前缀：`-r` / `-Rec` / `-Fo` 与全称等价
const PS_RECURSIVE = '-(?:r|rec(?:urse)?)\\b'
const PS_FORCE = '-fo(?:rce)?\\b'
// PowerShell 上 Remove-Item 的别名；del/erase/rd 在 cmd 与 PowerShell 里都常见
const PS_DELETE_VERB = '(?:remove-item|ri|rm|rmdir|del|erase|rd)'

const WINDOWS_BANNED: RegExp[] = [
  /\b(del|erase)\s+\/[fsq\s/"']*[a-z]:[\\/]?/i,
  /\b(rd|rmdir)\s+\/[sq\s/"']*[a-z]:[\\/]?/i,
  new RegExp(`\\b${PS_DELETE_VERB}\\b[^|;]*${PS_RECURSIVE}[^|;]*${PS_FORCE}`, 'i'),
  new RegExp(`\\b${PS_DELETE_VERB}\\b[^|;]*${PS_FORCE}[^|;]*${PS_RECURSIVE}`, 'i'),
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bstop-computer\b/i,
  /\breg\s+delete\b/i,
  /\bRemove-ItemProperty\b/i,
  /\btaskkill\b[^|;]*\/im\s*\*/i,
  /\bStop-Process\b[^|;]*-Force[^|;]*\*/i,
  /Invoke-Expression\s*\(\s*(Invoke-WebRequest|iwr|curl|wget)/i,
  /\biex\b\s*\(\s*(iwr|curl|wget|Invoke-WebRequest)/i,
  /Set-ExecutionPolicy\s+(Unrestricted|Bypass)/i,
  /\bbcdedit\b/i,
  /\bdiskpart\b/i,
  /\bcipher\s+\/w/i,
]

export function getBannedPatterns(platform: Platform = currentPlatform()): RegExp[] {
  return [...SHARED_BANNED, ...(platform === 'windows' ? WINDOWS_BANNED : POSIX_BANNED)]
}

/** 命中黑名单的返回值；调用方据此 deny。null 表示未命中。 */
export function findBannedPattern(command: string, platform?: Platform): RegExp | null {
  for (const pat of getBannedPatterns(platform)) {
    if (pat.test(command)) return pat
  }
  return null
}
