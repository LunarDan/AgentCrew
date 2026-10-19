'use client'

import { Download, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'

import { AgentAvatar } from '@/components/agent-avatar'
import { CreateAgentDialog } from '@/components/create-agent-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { AgentRow } from '@/db/schema'
import { deleteAgent as deleteAgentAPI } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  agentExportFileName,
  buildAgentExport,
  parseAgentExport,
  type AgentExportAgent,
} from '@/shared/agent-export'
import { useAgentList, useAppStore } from '@/stores/app-store'

/**
 * AgentLibrary — 「Agents」tab 的内容。列出内置 + 自建 Agent，
 * 顶部入口创建新的，自建项 hover 显示编辑 / 删除。
 */
export function AgentLibrary() {
  const agents = useAgentList()
  const removeAgent = useAppStore((s) => s.removeAgent)

  const [formOpen, setFormOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<AgentRow | null>(null)
  const [importedAgent, setImportedAgent] = useState<AgentExportAgent | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const deleteTarget = deleteTargetId ? agents.find((a) => a.id === deleteTargetId) : null

  const openCreate = () => {
    setEditingAgent(null)
    setImportedAgent(null)
    setImportError(null)
    setFormOpen(true)
  }
  const openEdit = (agent: AgentRow) => {
    setEditingAgent(agent)
    setImportedAgent(null)
    setFormOpen(true)
  }
  const handleFormOpenChange = (open: boolean) => {
    setFormOpen(open)
    if (!open) {
      setEditingAgent(null)
      setImportedAgent(null)
    }
  }

  const exportAgent = (agent: AgentRow) => {
    const file = buildAgentExport(agent)
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = agentExportFileName(agent.name)
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const importAgent = async (file: File) => {
    setImportError(null)
    try {
      let raw: unknown
      try {
        raw = JSON.parse(await file.text())
      } catch {
        throw new Error('文件不是有效的 JSON')
      }
      const parsed = parseAgentExport(raw)
      setEditingAgent(null)
      setImportedAgent(parsed.agent)
      setFormOpen(true)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    }
  }

  const confirmDelete = async () => {
    if (!deleteTargetId) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteAgentAPI(deleteTargetId)
      removeAgent(deleteTargetId)
      setDeleteTargetId(null)
    } catch (err) {
      console.error('[AgentLibrary] delete failed', err)
      const message = err instanceof Error ? err.message : String(err)
      setDeleteError(
        /FOREIGN KEY constraint failed/i.test(message)
          ? '这个 Agent 已经参与过会话或产生过产物，数据库外键约束不允许删除。'
          : message,
      )
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pt-3">
        <div className="flex gap-1.5">
          <Button className="flex-1 justify-start gap-2" variant="outline" onClick={openCreate}>
            <Plus className="size-4" />
            创建 Agent
          </Button>
          <Button
            variant="outline"
            size="icon"
            title="导入 Agent 配置"
            aria-label="导入 Agent 配置"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="size-4" />
          </Button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void importAgent(file)
            e.target.value = ''
          }}
        />
        {importError && (
          <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-700 dark:text-red-300">
            {importError}
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-2">
          {agents.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              没有 Agent
            </div>
          ) : (
            agents.map((a) => (
              <div
                key={a.id}
                className="group flex items-start gap-2 rounded-md border bg-card px-2 py-2 transition hover:border-foreground/20"
              >
                <AgentAvatar agent={a} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium">{a.name}</span>
                    {a.isBuiltin && (
                      <span className="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">
                        内置
                      </span>
                    )}
                    {a.isOrchestrator && (
                      <span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 font-mono text-[9px] text-primary">
                        Orchestrator
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">
                    {a.description}
                  </div>
                  <div className="mt-0.5 font-mono text-[9px] text-muted-foreground">
                    {a.adapterName}
                    {a.modelId ? ` · ${a.modelId}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 self-center gap-1 opacity-0 transition group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      exportAgent(a)
                    }}
                    title="导出配置"
                    className="text-muted-foreground transition hover:text-foreground"
                  >
                    <Download className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      openEdit(a)
                    }}
                    title="编辑 Agent"
                    className="text-muted-foreground transition hover:text-foreground"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  {!a.isBuiltin && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteError(null)
                        setDeleteTargetId(a.id)
                      }}
                      title="删除 Agent"
                      className={cn('text-muted-foreground transition hover:text-red-600')}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      <CreateAgentDialog
        open={formOpen}
        onOpenChange={handleFormOpenChange}
        agent={editingAgent ?? undefined}
        importedAgent={importedAgent}
      />

      <Dialog
        open={!!deleteTargetId}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTargetId(null)
            setDeleteError(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 Agent</DialogTitle>
            <DialogDescription>
              确定删除「{deleteTarget?.name}」吗？该操作不可恢复。参与过会话或产生过产物的 Agent
              受数据库外键约束保护，无法删除。
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteTargetId(null)
                setDeleteError(null)
              }}
            >
              取消
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? '删除中...' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
