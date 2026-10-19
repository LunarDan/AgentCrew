'use client'

import { AlertTriangle, Check, Loader2, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  createMcpServer,
  deleteMcpServer,
  fetchMcpServers,
  testMcpServer,
  updateMcpServer,
  type McpServerBody,
  type McpTestResult,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import type { MaskedSecret, McpServerView, McpTransport, McpTrust } from '@/shared/types'

/**
 * 外部 MCP server 管理（设置面板第四个 tab，specs/15-external-mcp.md）。
 *
 * 这些 server **不在** AgentHub 的 workspace 沙箱与 Bash 黑名单之内运行，且 stdio server
 * 继承本进程环境（能读到 AgentHub 自己存的 provider key）——所以注册时必须显式确认。
 */

const TRANSPORT_LABEL: Record<McpTransport, string> = {
  stdio: 'stdio（本地子进程）',
  sse: 'SSE（仅 Claude Code）',
  http: 'HTTP（streamable，Claude Code + Codex）',
}

interface FormState {
  id: string | null
  name: string
  transport: McpTransport
  command: string
  /** 每行一个参数，避免让用户写 JSON。 */
  argsText: string
  envText: string
  url: string
  headersText: string
  trust: McpTrust
  enabled: boolean
  trusted: boolean
  /** 打开编辑时的 transport；切 transport 才允许顺带清空旧密钥。 */
  originalTransport: McpTransport | null
}

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  headersText: '',
  trust: 'ask',
  // 默认停用：注册（写进 DB）与启用（允许在任何 run 中启动）是两次独立的决定。
  enabled: false,
  trusted: false,
  originalTransport: null,
}

export function McpServersSettings() {
  const [servers, setServers] = useState<McpServerView[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<FormState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testByServer, setTestByServer] = useState<Record<string, McpTestResult | 'running'>>({})
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const reload = useCallback(async () => {
    const list = await fetchMcpServers()
    setServers(list)
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchMcpServers()
      .then((list) => {
        if (!cancelled) setServers(list)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSave = useCallback(async () => {
    if (!form) return
    setBusy(true)
    setError(null)
    try {
      const body: McpServerBody = {
        name: form.name.trim(),
        transport: form.transport,
        command: form.transport === 'stdio' ? form.command.trim() : null,
        args: form.transport === 'stdio' ? splitLines(form.argsText) : [],
        env: form.transport === 'stdio' ? parseKeyValueLines(form.envText) : null,
        url: form.transport === 'stdio' ? null : form.url.trim(),
        headers: form.transport === 'stdio' ? null : parseKeyValueLines(form.headersText),
        trust: form.trust,
        enabled: form.enabled,
      }
      // 编辑时两个密钥框留空 = 不改动已存密钥（服务端 merge 语义），不能把 null 发出去当「清空」。
      if (form.id && form.originalTransport === form.transport) {
        if (!form.envText.trim()) delete body.env
        if (!form.headersText.trim()) delete body.headers
      }
      if (form.id) await updateMcpServer(form.id, body)
      else await createMcpServer(body)
      await reload()
      setForm(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [form, reload])

  const handleDelete = useCallback(
    async (id: string) => {
      setError(null)
      setDeleting(true)
      try {
        await deleteMcpServer(id)
        await reload()
        setDeleteTargetId(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setDeleting(false)
      }
    },
    [reload],
  )

  const handleToggleEnabled = useCallback(
    async (server: McpServerView) => {
      setError(null)
      try {
        await updateMcpServer(server.id, { enabled: !server.enabled })
        await reload()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [reload],
  )

  const handleTest = useCallback(async (id: string) => {
    setTestByServer((prev) => ({ ...prev, [id]: 'running' }))
    try {
      const result = await testMcpServer(id)
      setTestByServer((prev) => ({ ...prev, [id]: result }))
    } catch (err) {
      setTestByServer((prev) => ({
        ...prev,
        [id]: { ok: false, error: err instanceof Error ? err.message : String(err) },
      }))
    }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 py-1">
      <div className={cn('flex gap-2 rounded-md border border-amber-300/70 bg-amber-50/60 px-3 py-2 text-[11px] leading-5 text-amber-900', 'dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200')}>
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <div>
          外部 MCP server 是<strong>受信任的第三方程序</strong>，运行在 AgentHub 的 workspace 沙箱与命令黑名单
          <strong>之外</strong>；stdio server 还会继承本进程环境，因此
          <strong>可以读到 AgentHub 里存的其他 API Key</strong>。只注册你自己信任的 server。
        </div>
      </div>

      {servers.length === 0 && !form && (
        <p className="text-xs text-muted-foreground">还没有注册任何外部 MCP server。</p>
      )}

      {servers.map((server) => {
        const test = testByServer[server.id]
        return (
          <div key={server.id} className="rounded-md border px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-medium">{server.name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {server.transport}
              </span>
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px]',
                  server.trust === 'always'
                    ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
                    : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
                )}
                title={
                  server.transport === 'stdio'
                    ? undefined
                    : 'Codex 自带的审批策略由 Codex 运行时决定，此处的 ask 对 Codex 不生效'
                }
              >
                {server.trust === 'always' ? '免审批（信任）' : '每次询问'}
              </span>
              {!server.enabled && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  已停用
                </span>
              )}

              <div className="ml-auto flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => void handleTest(server.id)}
                  disabled={test === 'running'}
                >
                  {test === 'running' ? <Loader2 className="size-3 animate-spin" /> : null}
                  测试连接
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => void handleToggleEnabled(server)}
                >
                  {server.enabled ? '停用' : '启用'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => setForm(formFromServer(server))}
                >
                  编辑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-rose-600 hover:text-rose-700"
                  onClick={() => setDeleteTargetId(server.id)}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            </div>

            <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
              {server.transport === 'stdio' ? server.command : server.url}
              {server.transport === 'stdio' && server.args.length > 0 ? ` ${server.args.join(' ')}` : ''}
            </div>

            {(server.env || server.headers) && (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                {Object.entries(server.env ?? {}).map(([k, v]) => (
                  <span key={`env-${k}`} className="font-mono">
                    {k}={formatSecret(v)}
                  </span>
                ))}
                {Object.entries(server.headers ?? {}).map(([k, v]) => (
                  <span key={`hdr-${k}`} className="font-mono">
                    {k}: {formatSecret(v)}
                  </span>
                ))}
              </div>
            )}

            {test && test !== 'running' && (
              <div
                className={cn(
                  'mt-1 flex items-start gap-1 text-[10px]',
                  test.ok ? 'text-emerald-600' : 'text-destructive',
                )}
              >
                {test.ok ? <Check className="mt-0.5 size-3 shrink-0" /> : <X className="mt-0.5 size-3 shrink-0" />}
                <span className="break-all">
                  {test.ok
                    ? `连接成功，发现 ${test.toolNames?.length ?? 0} 个工具${test.toolNames?.length ? `：${test.toolNames.join(', ')}` : ''}`
                    : `连接失败：${test.error ?? '未知错误'}`}
                </span>
              </div>
            )}
          </div>
        )
      })}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {form ? (
        <div className="flex flex-col gap-2 rounded-md border px-3 py-2.5">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px]">
              名称（会被用作工具前缀 mcp__&lt;name&gt;__）
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="filesystem"
                className="h-7 text-xs"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px]">
              传输方式
              <select
                value={form.transport}
                onChange={(e) => setForm({ ...form, transport: e.target.value as McpTransport })}
                className="h-7 rounded-md border border-input bg-transparent px-2 text-xs"
              >
                {(Object.keys(TRANSPORT_LABEL) as McpTransport[]).map((t) => (
                  <option key={t} value={t}>
                    {TRANSPORT_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {form.transport === 'stdio' ? (
            <>
              <label className="flex flex-col gap-1 text-[11px]">
                命令
                <Input
                  value={form.command}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                  placeholder="npx"
                  className="h-7 font-mono text-xs"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px]">
                参数（每行一个）
                <textarea
                  value={form.argsText}
                  onChange={(e) => setForm({ ...form, argsText: e.target.value })}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\nD:\\work'}
                  className="min-h-16 rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px]">
                环境变量（每行 KEY=VALUE，值可写 <code>{'${ENV_NAME}'}</code> 引用本机环境）
                <textarea
                  value={form.envText}
                  onChange={(e) => setForm({ ...form, envText: e.target.value })}
                  placeholder={'GITHUB_TOKEN=${GITHUB_TOKEN}'}
                  className="min-h-12 rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs"
                />
              </label>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-[11px]">
                URL
                <Input
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="https://example.com/mcp"
                  className="h-7 font-mono text-xs"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px]">
                请求头（每行 KEY: VALUE）
                <textarea
                  value={form.headersText}
                  onChange={(e) => setForm({ ...form, headersText: e.target.value })}
                  placeholder={'Authorization: Bearer ${MY_MCP_TOKEN}'}
                  className="min-h-12 rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs"
                />
              </label>
            </>
          )}

          <div className="flex items-center gap-4 text-[11px]">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={form.trust === 'always'}
                onChange={(e) => setForm({ ...form, trust: e.target.checked ? 'always' : 'ask' })}
              />
              免审批执行（Claude Code 下不再逐次询问）
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              启用
            </label>
          </div>

          {!form.id && (
            <label className="flex items-start gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-[11px]">
              <input
                type="checkbox"
                checked={form.trusted}
                onChange={(e) => setForm({ ...form, trusted: e.target.checked })}
                className="mt-0.5"
              />
              我信任此 server：它会绕过 AgentHub 的沙箱与命令黑名单，stdio 模式下还能读取本进程环境（含已存的 API Key）。
            </label>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setForm(null)}>
              取消
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={busy || !canSubmit(form)}
              onClick={() => void handleSave()}
            >
              {busy && <Loader2 className="size-3 animate-spin" />}
              保存
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-fit text-xs"
          onClick={() => setForm({ ...EMPTY_FORM })}
        >
          <Plus className="size-3.5" />
          注册外部 MCP server
        </Button>
      )}

      <Dialog open={!!deleteTargetId} onOpenChange={(open) => !open && setDeleteTargetId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 MCP server</DialogTitle>
            <DialogDescription>
              确定删除「
              {servers.find((s) => s.id === deleteTargetId)?.name ?? deleteTargetId}
              」吗？已勾选它的 Agent 下次运行将不再提供它的工具。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTargetId(null)}>
              取消
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700"
              disabled={deleting}
              onClick={() => deleteTargetId && void handleDelete(deleteTargetId)}
            >
              {deleting ? '删除中...' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function canSubmit(form: FormState): boolean {
  if (!form.name.trim() || !/^[a-z0-9_]+$/.test(form.name.trim())) return false
  if (form.id) return true
  if (!form.trusted) return false
  return form.transport === 'stdio' ? form.command.trim().length > 0 : form.url.trim().length > 0
}

function formFromServer(server: McpServerView): FormState {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    argsText: server.args.join('\n'),
    // 脱敏预览不回填：留空即表示不改动已存的密钥（服务端 merge 语义）。
    envText: '',
    url: server.url ?? '',
    headersText: '',
    trust: server.trust,
    enabled: server.enabled,
    trusted: true,
    originalTransport: server.transport,
  }
}

function formatSecret(secret: MaskedSecret): string {
  return 'placeholder' in secret ? `\${${secret.placeholder}}` : secret.masked
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** `KEY=VALUE` 或 `KEY: VALUE` 每行一条。空值解析为 ''（服务端把 '' 当删除）。 */
function parseKeyValueLines(text: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const line of splitLines(text)) {
    const match = /^([^=:]+)[=:]\s*(.*)$/.exec(line)
    if (!match) continue
    out[match[1].trim()] = match[2].trim()
  }
  return Object.keys(out).length > 0 ? out : null
}
