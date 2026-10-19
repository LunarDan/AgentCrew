import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'

import { killProcessTreeByPid } from '@/server/child-process'
import { currentPlatform } from '@/server/platform'
import type { McpServerRunStatus, ResolvedMcpServer } from '@/shared/types'

import { buildChildProcessEnv } from './adapter-utils'
import { mcpResultToValue, type McpToolDefinition } from './custom-mcp-tools'

/**
 * custom adapter 的外部 MCP 客户端层（specs/15-external-mcp.md P1）。
 *
 * 生命周期与 `stream()` 对齐：进入时并行建连，结束时（含 abort / 抛错）由调用方 closeAll。
 * 单个 server 失败只加入 unavailable 名单，不影响其余 server 或整个 run。
 */

const CONNECT_TIMEOUT_MS = 30_000
const LIST_TOOLS_TIMEOUT_MS = 30_000
export const MCP_CALL_TIMEOUT_MS = 120_000

type AnyTransport =
  | StdioClientTransport
  | SSEClientTransport
  | StreamableHTTPClientTransport

export interface ConnectedMcpServer {
  server: ResolvedMcpServer
  client: Client
  transport: AnyTransport
  /** stdio transport 的子进程 pid；远程 transport 为 null。 */
  pid: number | null
  tools: McpToolDefinition[]
}

export interface ConnectMcpServersResult {
  servers: ConnectedMcpServer[]
  unavailable: McpServerRunStatus[]
}

type ConnectOutcome =
  | { kind: 'connected'; connection: ConnectedMcpServer }
  | { kind: 'unavailable'; status: McpServerRunStatus }
  | { kind: 'aborted' }

export async function connectMcpServers(
  servers: readonly ResolvedMcpServer[],
  args: { signal: AbortSignal; workspacePath: string },
): Promise<ConnectMcpServersResult> {
  if (servers.length === 0) return { servers: [], unavailable: [] }

  const outcomes = await Promise.all(
    servers.map((server) => connectOne(server, args)),
  )

  const connected: ConnectedMcpServer[] = []
  const unavailable: McpServerRunStatus[] = []
  for (const outcome of outcomes) {
    if (outcome.kind === 'connected') connected.push(outcome.connection)
    else if (outcome.kind === 'unavailable') unavailable.push(outcome.status)
  }
  return { servers: connected, unavailable }
}

async function connectOne(
  server: ResolvedMcpServer,
  args: { signal: AbortSignal; workspacePath: string },
): Promise<ConnectOutcome> {
  if (args.signal.aborted) return { kind: 'aborted' }

  const client = new Client({ name: 'agenthub-custom', version: '0.1.0' }, { capabilities: {} })

  let transport: AnyTransport
  try {
    transport = createTransport(server, args.workspacePath)
  } catch {
    return { kind: 'unavailable', status: { name: server.name, status: 'failed' } }
  }

  try {
    await client.connect(transport, { signal: args.signal, timeout: CONNECT_TIMEOUT_MS })
    const listed = await client.listTools(undefined, {
      signal: args.signal,
      timeout: LIST_TOOLS_TIMEOUT_MS,
    })
    return {
      kind: 'connected',
      connection: {
        server,
        client,
        transport,
        pid: readPid(transport),
        tools: normalizeTools(listed.tools),
      },
    }
  } catch (err) {
    await closeMcpConnection({
      server,
      client,
      transport,
      pid: readPid(transport),
      tools: [],
    })
    if (args.signal.aborted) return { kind: 'aborted' }
    return {
      kind: 'unavailable',
      status: { name: server.name, status: isUnauthorized(err) ? 'needs-auth' : 'failed' },
    }
  }
}

function createTransport(server: ResolvedMcpServer, workspacePath: string): AnyTransport {
  if (server.transport === 'stdio') {
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: { ...buildChildProcessEnv(), ...server.env },
      cwd: workspacePath,
    })
  }

  const url = new URL(server.url)
  const requestInit =
    server.headers && Object.keys(server.headers).length > 0
      ? { headers: server.headers }
      : undefined
  return server.transport === 'sse'
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit })
}

function normalizeTools(raw: unknown): McpToolDefinition[] {
  if (!Array.isArray(raw)) return []
  const tools: McpToolDefinition[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const { name, description, inputSchema } = item
    if (typeof name !== 'string' || name.length === 0) continue
    tools.push({
      name,
      description: typeof description === 'string' ? description : '',
      inputSchema: isRecord(inputSchema) ? inputSchema : { type: 'object', properties: {} },
    })
  }
  return tools
}

export async function callMcpTool(
  connection: ConnectedMcpServer,
  toolName: string,
  args: unknown,
  signal: AbortSignal,
): Promise<{ ok: boolean; value: unknown }> {
  try {
    const result = await connection.client.callTool(
      { name: toolName, arguments: isRecord(args) ? args : {} },
      undefined,
      { signal, timeout: MCP_CALL_TIMEOUT_MS },
    )
    const isError = isRecord(result) && result.isError === true
    return { ok: !isError, value: mcpResultToValue(result) }
  } catch (err) {
    return {
      ok: false,
      value: {
        error: `External MCP tool "${toolName}" on server "${connection.server.name}" failed: ${errorMessage(err)}`,
      },
    }
  }
}

export async function closeMcpConnections(
  connections: readonly ConnectedMcpServer[],
): Promise<void> {
  await Promise.all(connections.map((connection) => closeMcpConnection(connection)))
}

/** 先杀进程树再 close：父进程先退会让子进程被 reparent，之后按 pid 就找不到了。 */
async function closeMcpConnection(connection: ConnectedMcpServer): Promise<void> {
  if (connection.pid !== null) {
    killProcessTreeByPid(connection.pid, currentPlatform())
  }
  try {
    await connection.client.close()
  } catch {
    // 连接可能已经断开；清理是尽力而为。
  }
}

function readPid(transport: AnyTransport): number | null {
  if (transport instanceof StdioClientTransport) return transport.pid ?? null
  return null
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof UnauthorizedError || (err instanceof Error && err.name === 'UnauthorizedError')
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
