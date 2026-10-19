import { AGENTHUB_MCP_SERVER_NAME, type McpServerRunStatus } from '@/shared/types'

/** SDK 明确报告「这个 server 不可用」的状态。pending 与未知状态不告警，避免连接未就绪时误报。 */
const UNAVAILABLE_STATUSES = new Set(['failed', 'needs-auth', 'disabled'])

/**
 * 从 SDK init 的 `mcp_servers` 里挑出本次 run 真正需要、但不可用的外部 server。
 * 只认传入的 `expectedNames`（外部 server），因此内置的 `agenthub` 桥天然被排除。
 */
export function collectUnavailableServers(
  statuses: readonly unknown[],
  expectedNames: readonly string[],
): McpServerRunStatus[] {
  const expected = new Set(expectedNames.filter((name) => name !== AGENTHUB_MCP_SERVER_NAME))
  const seen = new Set<string>()
  const unavailable: McpServerRunStatus[] = []

  for (const raw of statuses) {
    if (typeof raw !== 'object' || raw === null) continue
    const { name, status } = raw as { name?: unknown; status?: unknown }
    if (typeof name !== 'string' || typeof status !== 'string') continue
    if (!expected.has(name) || !UNAVAILABLE_STATUSES.has(status)) continue
    if (seen.has(name)) continue
    seen.add(name)
    unavailable.push({ name, status })
  }

  return unavailable
}
