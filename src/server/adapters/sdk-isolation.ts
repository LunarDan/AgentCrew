import type { Options } from '@anthropic-ai/claude-agent-sdk'

/**
 * Claude Code SDK 的隔离启动参数 —— 审批门与命令黑名单真正生效的前提。
 *
 * `settingSources: []` 关掉的是**文件系统**设置源，被排除的是：
 *  - workspace 的 .claude/settings.json：permissions.allow 在 CLI 侧先于 canUseTool 求值，
 *    命中就不再回调，于是 Bash 审批门与外部 MCP 的 trust='ask' 门都会被绕过
 *  - 项目 hooks：hook 直接在宿主上执行命令，不经过 canUseTool，也不经过命令黑名单
 *  - workspace 的 plugins / skills / 自定义命令
 * managed / policy 层**仍然读盘** —— 企业下发的 deny 规则应当保留。
 *
 * `strictMcpConfig` 独立再关一次 workspace 的 .mcp.json：否则工作区放一个文件就能让 CLI
 * 自己 spawn 任意 MCP server，绕开 mcp_servers 登记表与审批门。
 *
 * 改动这里等于改安全边界，先读 CLAUDE.md §5.5。
 */
export function sdkIsolationOptions(): Pick<Options, 'settingSources' | 'strictMcpConfig'> {
  return { settingSources: [], strictMcpConfig: true }
}
