import type { McpServerRunStatus } from '@/shared/types'

/** 解析阶段（run 开始前）的跳过原因 → 一条用户可见提示；没有警告时返回 null。 */
export function formatResolutionWarnings(warnings: readonly string[]): string | null {
  if (warnings.length === 0) return null
  return ['[MCP] 外部 MCP server 配置有问题，本次运行已跳过：', ...warnings.map((w) => `- ${w}`)].join(
    '\n',
  )
}

/** SDK 连接阶段失败的 server 名单 → 一条用户可见提示；全部健康时返回 null（不产生假阳性）。 */
export function formatUnavailableNotice(servers: readonly McpServerRunStatus[]): string | null {
  if (servers.length === 0) return null
  return [
    '[MCP] 外部 MCP server 未能连接，本次运行不会提供它们的工具：',
    ...servers.map((s) => `- ${s.name}（${s.status}）`),
  ].join('\n')
}
