/**
 * SDK 按平台给 shell 工具起名：POSIX 上是 `Bash`，Windows 上实测是 `PowerShell`。
 * 按单个字面量判断会让 Windows 上的黑名单与审批分类器整条失效，所以按「身份」识别。
 */

/** 已知的 shell 工具名（小写；比较时统一转小写）。 */
export const SHELL_TOOL_NAMES = new Set(['bash', 'powershell', 'pwsh', 'cmd', 'shell'])

/** 外部 MCP 工具前缀；它们有自己的 trust 审批门，不能落进 shell 分支。 */
const MCP_TOOL_PREFIX = 'mcp__'

export function hasCommandString(input: Record<string, unknown>): boolean {
  const command = input.command
  return typeof command === 'string' && command.trim().length > 0
}

/**
 * `sdkToolNames` 是本次 run 的 init 消息报告的工具表；尚未到达时为 null。
 * 工具表未到达时按「带 command 即 shell」失败关闭 —— 宁可多问一次，不可静默放行。
 */
export function isShellTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  sdkToolNames: readonly string[] | null,
): boolean {
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return false
  if (SHELL_TOOL_NAMES.has(toolName.toLowerCase())) return true
  if (sdkToolNames === null) return hasCommandString(toolInput)
  if (!sdkToolNames.includes(toolName)) return false
  return hasCommandString(toolInput)
}
