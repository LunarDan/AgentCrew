import type { AdapterName, McpTransport } from '@/shared/types'

/**
 * adapter × transport 支持矩阵（specs/15-external-mcp.md §3）。
 *
 * 事实依据（已实测）：Claude Agent SDK 三种传输都支持；Codex CLI 0.149.1 只有 stdio
 * 与 streamable HTTP（`codex mcp add --help` 只给 `<COMMAND>...` 或 `--url`），没有 SSE。
 *
 * 服务端（按 adapter 过滤要注册的 server）与前端（agent 编辑时只列出该 adapter 能跑的
 * server）共用这一份，避免两边各写一遍矩阵。
 */
export const ADAPTER_TRANSPORTS: Record<AdapterName, McpTransport[]> = {
  'claude-code': ['stdio', 'sse', 'http'],
  codex: ['stdio', 'http'],
  custom: [],
  mock: [],
}

export function adapterSupportsTransport(
  adapterName: AdapterName,
  transport: McpTransport,
): boolean {
  return ADAPTER_TRANSPORTS[adapterName].includes(transport)
}
