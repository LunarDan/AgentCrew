'use client'

import { AlertCircle, Eye, FileText, Loader2, PenLine, RefreshCw, Save } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { CodeBlock } from '@/components/code-block'
import { Button } from '@/components/ui/button'
import { workspaceReadFile, workspaceWriteFile } from '@/lib/api'
import { normalizeLang } from '@/lib/highlighter'
import { cn } from '@/lib/utils'

interface FileState {
  loading: boolean
  saving: boolean
  content: string         // 服务端最近一次的内容（用来比对 dirty）
  draft: string           // 编辑中的草稿
  truncated: boolean
  error: string | null
  size: number
}

/**
 * FileTab —— ChatPanel 内的「文件 tab」。
 *
 * 默认浏览模式（shiki 高亮）；点击编辑按钮切到 textarea；保存调
 * workspaceWriteFile API。文件路径相对 workspace effective cwd。
 */
export function FileTab({
  conversationId,
  relPath,
}: {
  conversationId: string
  relPath: string
}) {
  const [state, setState] = useState<FileState>({
    loading: true,
    saving: false,
    content: '',
    draft: '',
    truncated: false,
    error: null,
    size: 0,
  })
  const [editing, setEditing] = useState(false)

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const result = await workspaceReadFile(conversationId, relPath)
      const saved = readDraft(conversationId, relPath)
      const hasDraft = saved !== null && saved !== result.content
      setState({
        loading: false,
        saving: false,
        content: result.content,
        draft: hasDraft ? saved : result.content,
        truncated: result.truncated,
        error: null,
        size: result.size,
      })
      if (hasDraft) setEditing(true)
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }, [conversationId, relPath])

  // 首次挂载 / 切文件时加载
  useEffect(() => {
    void reload()
  }, [reload])

  const dirty = editing && state.draft !== state.content
  const lang = guessLanguage(relPath)

  const save = async () => {
    if (state.saving || !dirty || state.truncated) return
    setState((s) => ({ ...s, saving: true, error: null }))
    try {
      await workspaceWriteFile(conversationId, relPath, state.draft)
      clearDraft(conversationId, relPath)
      setState((s) => ({ ...s, saving: false, content: s.draft }))
      setEditing(false)
    } catch (err) {
      setState((s) => ({
        ...s,
        saving: false,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  if (state.loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        加载 {relPath}...
      </div>
    )
  }

  if (state.error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertCircle className="size-6 text-red-500" />
        <div className="text-sm font-medium">无法打开文件</div>
        <div className="font-mono text-xs text-muted-foreground">{state.error}</div>
        <Button size="sm" variant="outline" onClick={() => void reload()}>
          <RefreshCw className="mr-1 size-3.5" />
          重试
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 文件 header */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <code className="min-w-0 flex-1 truncate font-mono">{relPath}</code>
        <span className="font-mono text-[10px] text-muted-foreground">
          {(state.size / 1024).toFixed(1)} KB
        </span>
        {dirty && <span className="font-mono text-[10px] text-amber-600">●未保存</span>}
        {state.truncated && (
          <span
            className="font-mono text-[10px] text-amber-600"
            title="文件超出 50,000 字符已截断，不可编辑保存"
          >
            ●已截断
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={() => void reload()} title="重新加载">
          <RefreshCw className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant={editing ? 'default' : 'outline'}
          onClick={() => {
            if (editing) {
              // 退出编辑：如果有 dirty 提示丢弃
              if (dirty && !window.confirm('放弃未保存的修改？')) return
              clearDraft(conversationId, relPath)
              setState((s) => ({ ...s, draft: s.content }))
              setEditing(false)
            } else {
              setEditing(true)
            }
          }}
          disabled={state.truncated}
        >
          {editing ? <Eye className="mr-1 size-3.5" /> : <PenLine className="mr-1 size-3.5" />}
          {editing ? '浏览' : '编辑'}
        </Button>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={!dirty || state.saving || state.truncated}
          className={cn(dirty && 'bg-primary')}
        >
          <Save className="mr-1 size-3.5" />
          {state.saving ? '保存中...' : '保存'}
        </Button>
      </div>

      {/* 主体 */}
      <div
        className="min-h-0 flex-1 overflow-auto"
        data-selection-target={editing ? undefined : 'file'}
        data-selection-label={`文件 ${relPath}`}
        data-selection-file-path={editing ? undefined : relPath}
      >
        {editing ? (
          <textarea
            value={state.draft}
            onChange={(e) => {
              const value = e.target.value
              setState((s) => ({ ...s, draft: value }))
              writeDraft(conversationId, relPath, value)
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault()
                void save()
              }
            }}
            spellCheck={false}
            className="size-full resize-none border-0 bg-background px-4 py-3 font-mono text-xs leading-relaxed outline-none"
          />
        ) : (
          <div className="px-3 py-3">
            <CodeBlock code={state.content} language={lang} />
          </div>
        )}
      </div>
    </div>
  )
}

function guessLanguage(relPath: string): string {
  const ext = relPath.split('.').pop()?.toLowerCase() ?? ''
  // normalizeLang 接受文件扩展名 alias，覆盖大部分场景
  return normalizeLang(ext)
}

// 草稿按会话 + 路径存本标签页，切换 tab / 重挂载后仍能恢复；保存或放弃时清掉
function draftKey(conversationId: string, relPath: string): string {
  return `agenthub:file-draft:${conversationId}:${relPath}`
}

function readDraft(conversationId: string, relPath: string): string | null {
  try {
    return window.sessionStorage.getItem(draftKey(conversationId, relPath))
  } catch {
    return null
  }
}

function writeDraft(conversationId: string, relPath: string, value: string): void {
  try {
    window.sessionStorage.setItem(draftKey(conversationId, relPath), value)
  } catch {
    // 存储不可用时退化为仅内存草稿
  }
}

function clearDraft(conversationId: string, relPath: string): void {
  try {
    window.sessionStorage.removeItem(draftKey(conversationId, relPath))
  } catch {
    // ignore
  }
}
