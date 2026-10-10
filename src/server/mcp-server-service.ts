import { and, eq, inArray } from 'drizzle-orm'

import { ADAPTER_TRANSPORTS, adapterSupportsTransport } from '@/shared/mcp'
import type {
  AdapterName,
  MaskedSecret,
  McpServerView,
  McpTransport,
  McpTrust,
  ResolvedMcpServer,
} from '@/shared/types'
import { AGENTHUB_MCP_SERVER_NAME, MCP_TOOL_PREFIX } from '@/shared/types'

import { db, schema } from '@/db/client'
import type { McpServerRow } from '@/db/schema'
import { buildChildProcessEnv } from '@/server/adapters/adapter-utils'
import { newMcpServerId } from '@/server/ids'

/**
 * 外部 MCP server 的服务层（specs/15-external-mcp.md）。
 *
 * 安全前提：这些 server 在 AgentHub 的 workspace 沙箱 + Bash 黑名单**之外**运行；
 * stdio server 还继承本进程环境（可读到 provider key）。见 CLAUDE.md §5。
 *
 * 分层：DB 读取 / `enabled` 过滤 / `${ENV}` 展开**全部**在本层完成，adapter 只拿到
 * 已解析好的 ResolvedMcpServer —— adapter 不碰 DB（CLAUDE.md §3.1）。
 */

const NAME_PATTERN = /^[a-z0-9_]+$/
const ENV_PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const PURE_PLACEHOLDER_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/

/** 保留名：`agenthub` 是 adapter 自己的 bridge，不允许外部 server 占用。 */
const RESERVED_NAMES = new Set([AGENTHUB_MCP_SERVER_NAME])

// ─── 校验 ────────────────────────────────────────────────────

export interface McpServerInput {
  name: string
  transport: McpTransport
  command?: string | null
  args?: string[]
  env?: Record<string, string> | null
  url?: string | null
  headers?: Record<string, string> | null
  trust?: McpTrust
  enabled?: boolean
}

/** 返回错误信息；null 表示通过。 */
export function validateMcpServerInput(input: McpServerInput): string | null {
  const name = input.name.trim()
  if (!NAME_PATTERN.test(name)) {
    return 'Server name must match ^[a-z0-9_]+$ (it becomes part of the tool namespace)'
  }
  if (RESERVED_NAMES.has(name)) {
    return `Server name "${name}" is reserved by AgentHub`
  }
  if (name.startsWith(MCP_TOOL_PREFIX)) {
    return `Server name must not start with "${MCP_TOOL_PREFIX}"`
  }
  // `__` 是 `mcp__<server>__<tool>` 的分隔符，名字里带它会让解析出的 server 名对不上。
  if (name.includes('__')) {
    return 'Server name must not contain "__" (it separates server and tool in the tool name)'
  }
  if (input.transport === 'stdio') {
    if (!input.command?.trim()) return 'stdio servers require a command'
    if (input.url?.trim()) return 'stdio servers must not set a url'
  } else {
    if (!input.url?.trim()) return `${input.transport} servers require a url`
    if (input.command?.trim()) return `${input.transport} servers must not set a command`
  }
  return null
}

// ─── CRUD ────────────────────────────────────────────────────

export async function listMcpServers(): Promise<McpServerRow[]> {
  return db.query.mcpServers.findMany({ orderBy: [schema.mcpServers.createdAt] })
}

export async function getMcpServer(id: string): Promise<McpServerRow | null> {
  const row = await db.query.mcpServers.findFirst({ where: eq(schema.mcpServers.id, id) })
  return row ?? null
}

export async function createMcpServer(input: McpServerInput): Promise<McpServerRow> {
  const error = validateMcpServerInput(input)
  if (error) throw new Error(error)
  await assertNameAvailable(input.name.trim())

  const row: McpServerRow = {
    id: newMcpServerId(),
    name: input.name.trim(),
    transport: input.transport,
    command: input.transport === 'stdio' ? (input.command?.trim() ?? null) : null,
    args: input.transport === 'stdio' ? (input.args ?? []) : [],
    env: input.transport === 'stdio' ? (input.env ?? null) : null,
    url: input.transport === 'stdio' ? null : (input.url?.trim() ?? null),
    headers: input.transport === 'stdio' ? null : (input.headers ?? null),
    trust: input.trust ?? 'ask',
    enabled: input.enabled ?? false,
    createdAt: Date.now(),
  }

  await db.insert(schema.mcpServers).values(row)
  return row
}

export interface UpdateMcpServerPatch {
  name?: string
  /** 改 transport 必须同时给对应字段，否则校验不过。 */
  transport?: McpTransport
  command?: string | null
  args?: string[]
  url?: string | null
  /** 传 null 清空整个 map；不给则完全不动。 */
  env?: Record<string, string | null> | null
  headers?: Record<string, string | null> | null
  trust?: McpTrust
  enabled?: boolean
}

export async function updateMcpServer(id: string, patch: UpdateMcpServerPatch): Promise<McpServerRow> {
  const current = await getMcpServer(id)
  if (!current) throw new Error(`MCP server not found: ${id}`)

  const transport = patch.transport ?? current.transport
  // 先按「合并后」的形态校验，避免校验的是中间态
  const merged: McpServerInput = {
    name: patch.name ?? current.name,
    transport,
    command: patch.command !== undefined ? patch.command : current.command,
    args: patch.args ?? current.args,
    url: patch.url !== undefined ? patch.url : current.url,
    trust: patch.trust ?? current.trust,
  }
  const error = validateMcpServerInput(merged)
  if (error) throw new Error(error)
  if (patch.name !== undefined && patch.name.trim() !== current.name) {
    await assertNameAvailable(patch.name.trim())
  }

  const updates: Record<string, unknown> = {}
  if (patch.name !== undefined) updates.name = patch.name.trim()
  if (patch.transport !== undefined) updates.transport = transport
  if (patch.command !== undefined) updates.command = patch.command?.trim() || null
  if (patch.args !== undefined) updates.args = patch.args
  if (patch.url !== undefined) updates.url = patch.url?.trim() || null
  if (patch.trust !== undefined) updates.trust = patch.trust
  if (patch.enabled !== undefined) updates.enabled = patch.enabled

  // 密钥按 key 合并：省略的 key 保留原值（前端只回传用户真正改过的 key，不回传掩码）。
  // 显式传 null 则清空整个 map。
  if (patch.env !== undefined) {
    updates.env = patch.env === null ? null : mergeSecretMap(current.env, patch.env)
  }
  if (patch.headers !== undefined) {
    updates.headers = patch.headers === null ? null : mergeSecretMap(current.headers, patch.headers)
  }

  if (Object.keys(updates).length === 0) return current

  await db.update(schema.mcpServers).set(updates).where(eq(schema.mcpServers.id, id))
  const updated = await getMcpServer(id)
  if (!updated) throw new Error('Update succeeded but row missing afterwards')
  return updated
}

export async function deleteMcpServer(id: string): Promise<void> {
  const deleted = await db
    .delete(schema.mcpServers)
    .where(eq(schema.mcpServers.id, id))
    .returning({ id: schema.mcpServers.id })
  if (deleted.length === 0) throw new Error(`MCP server not found: ${id}`)
}

async function assertNameAvailable(name: string): Promise<void> {
  const existing = await db.query.mcpServers.findFirst({
    where: eq(schema.mcpServers.name, name),
  })
  if (existing) throw new Error(`MCP server name already in use: ${name}`)
}

/** null 表示清空整个 map；否则逐 key 合并，`null`/`''` 表示删除该 key。 */
function mergeSecretMap(
  current: Record<string, string> | null,
  patch: Record<string, string | null>,
): Record<string, string> | null {
  const next: Record<string, string> = { ...(current ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value.trim() === '') delete next[key]
    else next[key] = value
  }
  return Object.keys(next).length > 0 ? next : null
}

// ─── 密钥脱敏（读接口用）─────────────────────────────────────

/** 只露后 4 位；纯 `${ENV_NAME}` 占位原样显示（它不是密钥，是引用）。 */
export function maskSecretValue(value: string): MaskedSecret {
  if (PURE_PLACEHOLDER_PATTERN.test(value)) {
    return { placeholder: value.slice(2, -1) }
  }
  const tail = value.length > 4 ? value.slice(-4) : value
  return { masked: `••••${tail}` }
}

/** 列表 / 详情接口的唯一出口 —— 保证明文密钥不出服务端。 */
export function toMcpServerView(row: McpServerRow): McpServerView {
  const mask = (map: Record<string, string> | null): Record<string, MaskedSecret> | null => {
    if (!map) return null
    return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, maskSecretValue(v)]))
  }
  return { ...row, env: mask(row.env), headers: mask(row.headers) }
}

// ─── `${ENV_NAME}` 展开 ──────────────────────────────────────

/**
 * 展开 `${NAME}`。在 run 启动时调用，DB 只存占位符文本 —— 这样 `.env.local`
 * 改了无需重新保存 server，且明文密钥不落库。
 *
 * 未解析到的变量直接抛错（带变量名），让 server 在启动前就被诊断出来，而不是
 * 带着缺失的密钥去 spawn。
 */
export function expandEnvPlaceholders(
  values: Record<string, string> | null,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> | undefined {
  if (!values) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(values)) {
    out[key] = raw.replace(ENV_PLACEHOLDER_PATTERN, (_match, name: string) => {
      const resolved = env[name]
      if (resolved === undefined) {
        throw new Error(`MCP env placeholder \${${name}} is not set in the environment`)
      }
      return resolved
    })
  }
  return out
}

// ─── 按 Agent 解析 ──────────────────────────────────────────

export interface ResolvedMcpServers {
  servers: ResolvedMcpServer[]
  /** 单个 server 失败只降级为警告，不 fail 整个 run（spec §6.4）。 */
  warnings: string[]
}

export async function resolveMcpServersForAgent(
  mcpServerIds: string[],
  adapterName: AdapterName,
): Promise<ResolvedMcpServers> {
  if (mcpServerIds.length === 0) return { servers: [], warnings: [] }
  if (ADAPTER_TRANSPORTS[adapterName].length === 0) {
    return { servers: [], warnings: [] }
  }

  const rows = await db.query.mcpServers.findMany({
    where: and(inArray(schema.mcpServers.id, mcpServerIds), eq(schema.mcpServers.enabled, true)),
  })

  const servers: ResolvedMcpServer[] = []
  const warnings: string[] = []

  for (const row of rows) {
    if (!adapterSupportsTransport(adapterName, row.transport)) {
      warnings.push(
        `MCP server "${row.name}" uses transport "${row.transport}", which ${adapterName} does not support; skipped.`,
      )
      continue
    }
    try {
      if (row.transport === 'stdio') {
        if (!row.command) {
          warnings.push(`MCP server "${row.name}" has no command; skipped.`)
          continue
        }
        servers.push({
          name: row.name,
          trust: row.trust,
          transport: 'stdio',
          command: row.command,
          args: row.args,
          env: expandEnvPlaceholders(row.env),
        })
      } else if (!row.url) {
        warnings.push(`MCP server "${row.name}" has no url; skipped.`)
      } else {
        servers.push({
          name: row.name,
          trust: row.trust,
          transport: row.transport,
          url: row.url,
          headers: expandEnvPlaceholders(row.headers),
        })
      }
    } catch (err) {
      warnings.push(
        `MCP server "${row.name}" could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return { servers, warnings }
}

// ─── 测试连接 ────────────────────────────────────────────────

export interface McpServerTestResult {
  ok: boolean
  toolNames?: string[]
  error?: string
}

// 60s 而非 15s：最常见的登记形态是 `npx -y <pkg>`，首次探测要先把包下下来，
// 冷缓存下轻松超过 15s。15s 会让一个完全正确的配置报「超时」假故障。
const TEST_TIMEOUT_MS = 60_000

/**
 * connect + listTools + close。登记时就能发现坏配置，而不是等到 run 中途。
 * 探测进程与实际 run 一样继承本进程环境（见 CLAUDE.md §5）。
 */
export async function testMcpServerConnection(
  id: string,
  cwd?: string,
): Promise<McpServerTestResult> {
  const row = await getMcpServer(id)
  if (!row) return { ok: false, error: `MCP server not found: ${id}` }

  let client: { close: () => Promise<void> } | null = null
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const transport = await buildProbeTransport(row, cwd)
    const mcpClient = new Client({ name: 'agenthub-probe', version: '1.0.0' })
    client = mcpClient

    await withTimeout(mcpClient.connect(transport), TEST_TIMEOUT_MS, row.name, 'connecting')
    const listed = await withTimeout(mcpClient.listTools(), TEST_TIMEOUT_MS, row.name, 'listing tools')
    return { ok: true, toolNames: listed.tools.map((t) => t.name) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (client) await client.close().catch(() => {})
  }
}

async function buildProbeTransport(row: McpServerRow, cwd?: string) {
  if (row.transport === 'stdio') {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    return new StdioClientTransport({
      command: row.command ?? '',
      args: row.args,
      // 必须显式传 env：SDK 默认只继承 getDefaultEnvironment() 的白名单变量，
      // 与本项目「继承完整进程环境」的约定不一致。
      env: { ...buildChildProcessEnv(), ...(expandEnvPlaceholders(row.env) ?? {}) },
      ...(cwd ? { cwd } : {}),
    })
  }
  const headers = expandEnvPlaceholders(row.headers)
  if (row.transport === 'sse') {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
    return new SSEClientTransport(new URL(row.url ?? ''), {
      requestInit: headers ? { headers } : undefined,
    })
  }
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  )
  return new StreamableHTTPClientTransport(new URL(row.url ?? ''), {
    requestInit: headers ? { headers } : undefined,
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string, phase: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`MCP server "${label}" timed out after ${ms}ms while ${phase}`)),
      ms,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
