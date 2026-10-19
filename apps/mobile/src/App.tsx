import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, Home, Loader2, Menu, RefreshCw, Settings, X } from 'lucide-react'

import { createMobileApiClient, pairMobileDevice } from './api/client'
import { ApprovalsScreen } from './screens/ApprovalsScreen'
import { ArtifactPreviewSheet } from './screens/ArtifactPreviewSheet'
import { ConversationsScreen } from './screens/ConversationsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { StatusScreen } from './screens/StatusScreen'
import { usePullToRefresh } from './lib/usePullToRefresh'
import { loadConnection, loadRecentHosts, rememberRecentHost, saveConnection } from './storage/connection'
import type {
  ConnectionConfig,
  MobileAskUserAnswers,
  MobileArtifact,
  MobileConversationDetail,
  MobileSnapshot,
} from './types'

const initialConnection = loadConnection()
const initialRecentHosts = loadRecentHosts()

type AppView = 'home' | 'settings'

export function App() {
  const [activeView, setActiveView] = useState<AppView>('home')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [connection, setConnection] = useState<ConnectionConfig>(initialConnection)
  const [recentHosts, setRecentHosts] = useState<string[]>(initialRecentHosts)
  const [lastSuccessfulConnection, setLastSuccessfulConnection] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null)
  const [conversationDetail, setConversationDetail] = useState<MobileConversationDetail | null>(null)
  const [artifactPreview, setArtifactPreview] = useState<MobileArtifact | null>(null)
  const [artifactCache, setArtifactCache] = useState<
    Record<string, { artifact: MobileArtifact; cachedAt: number }>
  >({})
  const [artifactLoadingId, setArtifactLoadingId] = useState<string | null>(null)
  const [artifactError, setArtifactError] = useState<string | null>(null)
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [operationId, setOperationId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)

  const selectedConversationRef = useRef<string | null>(null)
  const snapshotSeq = useRef(0)
  const artifactSeq = useRef(0)
  const detailSeq = useRef(0)
  const snapshotInFlight = useRef(false)
  const detailInFlight = useRef(false)
  const busyRef = useRef(false)

  const api = useMemo(() => createMobileApiClient(connection), [connection])
  const configured = !!normalizeBaseUrl(connection.baseUrl) && !!connection.deviceToken.trim()
  const connectionFingerprint = `${normalizeBaseUrl(connection.baseUrl)}\n${connection.deviceToken.trim()}`
  const connectionOk = configured && lastSuccessfulConnection === connectionFingerprint

  const applySnapshot = useCallback(
    (next: MobileSnapshot) => {
      setSnapshot(next)
      setLastSuccessfulConnection(connectionFingerprint)
      setRecentHosts(rememberRecentHost(connection.baseUrl))
      setLastSyncedAt(Date.now())
      setError(null)
    },
    [connection.baseUrl, connectionFingerprint],
  )

  /** 所有快照刷新都走这里：只接受最后发出的那次响应，避免旧响应覆盖新状态。 */
  const loadSnapshot = useCallback(async () => {
    const seq = ++snapshotSeq.current
    const next = await api.getSnapshot()
    if (seq === snapshotSeq.current) applySnapshot(next)
    return next
  }, [api, applySnapshot])

  const selectConversation = useCallback((id: string | null) => {
    selectedConversationRef.current = id
    setSelectedConversationId(id)
    if (id === null) setConversationDetail(null)
  }, [])

  useEffect(() => {
    saveConnection(connection)
  }, [connection])

  // 换 host / token 后旧数据一律作废：不能把上一个桌面端的会话或产物缓存显示/发送到新 host。
  useEffect(() => {
    snapshotSeq.current++
    artifactSeq.current++
    setSnapshot(null)
    setConversationDetail(null)
    setArtifactPreview(null)
    setArtifactCache({})
    setArtifactError(null)
    setArtifactLoadingId(null)
    setLastSyncedAt(null)
    setLastSuccessfulConnection(null)
    setError(null)
  }, [connectionFingerprint])

  useEffect(() => {
    if (!configured || activeView === 'settings') return

    let cancelled = false

    async function refreshMobileSnapshot() {
      // 上一次还没回来（弱网 / 黑洞）就不要再叠一个请求
      if (snapshotInFlight.current) return
      snapshotInFlight.current = true
      try {
        await loadSnapshot()
      } catch (err) {
        if (!cancelled) {
          // 连不上时状态页不能继续显示「在线」
          setLastSuccessfulConnection(null)
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        snapshotInFlight.current = false
      }
    }

    const timer = window.setInterval(() => {
      void refreshMobileSnapshot()
    }, 3000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeView, configured, loadSnapshot])

  useEffect(() => {
    if (!configured || activeView === 'settings') return

    const controller = new AbortController()
    let timer: number | null = null

    // 事件流只用来「尽快刷新」；轮询仍保留为兜底（WebView 不支持 streaming 时）。
    const scheduleRefresh = () => {
      if (timer !== null) return
      timer = window.setTimeout(() => {
        timer = null
        void loadSnapshot().catch(() => {})
      }, 500)
    }

    void api
      .subscribeEvents((event) => {
        const type = (event as { type?: string } | null)?.type
        if (type === 'heartbeat' || type === 'connected') return
        scheduleRefresh()
      }, controller.signal)
      .catch(() => {})

    return () => {
      controller.abort()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [activeView, api, configured, loadSnapshot])

  useEffect(() => {
    if (!configured || !selectedConversationId) return
    let cancelled = false
    const conversationId = selectedConversationId

    async function refreshConversationDetail() {
      if (detailInFlight.current) return
      detailInFlight.current = true
      const seq = ++detailSeq.current
      try {
        const next = await api.getConversation(conversationId)
        if (
          !cancelled &&
          selectedConversationRef.current === conversationId &&
          seq === detailSeq.current
        ) {
          setConversationDetail(next)
          setLastSuccessfulConnection(connectionFingerprint)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        detailInFlight.current = false
      }
    }

    const timer = window.setInterval(() => {
      void refreshConversationDetail()
    }, 2000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [api, configured, selectedConversationId, connectionFingerprint])

  async function refreshSnapshot() {
    if (!configured) {
      setError('请先在设置里填写桌面端地址和设备 token。')
      return
    }
    setLoading(true)
    setError(null)
    try {
      await loadSnapshot()
    } catch (err) {
      setLastSuccessfulConnection(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function runMobileAction(id: string, action: () => Promise<void>): Promise<boolean> {
    if (!configured) {
      setError('请先在设置里填写桌面端地址和设备 token。')
      return false
    }
    if (busyRef.current) return false
    busyRef.current = true
    setOperationId(id)
    setError(null)
    let succeeded = false
    try {
      await action()
      succeeded = true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      busyRef.current = false
      setOperationId(null)
    }
    if (!succeeded) return false
    // 操作已经落库：后续刷新失败只提示，不能返回 false 让用户重试一次（会重复发送 / 重新生成）
    try {
      await loadSnapshot()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    return true
  }

  /** 操作后的详情刷新是可选的：失败不能把「已经成功」说成失败。 */
  async function refreshDetailBestEffort(conversationId: string): Promise<void> {
    try {
      const detail = await api.getConversation(conversationId)
      if (selectedConversationRef.current === conversationId) setConversationDetail(detail)
    } catch {
      // 周期轮询 / 事件流会补上
    }
  }

  async function openConversation(id: string) {
    if (!configured) {
      setError('请先在设置里填写桌面端地址和设备 token。')
      return
    }
    selectConversation(id)
    setActiveView('home')
    setDrawerOpen(false)
    setLoading(true)
    setError(null)
    const seq = ++detailSeq.current
    try {
      const detail = await api.getConversation(id)
      // 慢请求返回时用户可能已经返回列表或打开了别的会话：丢弃过期响应。
      if (selectedConversationRef.current !== id || seq !== detailSeq.current) return
      setConversationDetail(detail)
      setLastSuccessfulConnection(connectionFingerprint)
    } catch (err) {
      if (selectedConversationRef.current === id) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      // 只清自己这次导航的 spinner，别把后来者刚点开的会话 spinner 提前关掉
      if (selectedConversationRef.current === id) setLoading(false)
    }
  }

  function openHome() {
    setActiveView('home')
    selectConversation(null)
    closeArtifactPreview()
    setDrawerOpen(false)
  }

  function backToList() {
    selectConversation(null)
    closeArtifactPreview()
  }

  function openSettings() {
    setActiveView('settings')
    selectConversation(null)
    closeArtifactPreview()
    setDrawerOpen(false)
  }

  async function sendMessageFromMobile(content: string): Promise<boolean> {
    const conversationId = selectedConversationId
    if (!conversationId) return false
    return runMobileAction('send-message', async () => {
      await api.sendMessage(conversationId, content)
      await refreshDetailBestEffort(conversationId)
    })
  }

  async function withdrawMessageFromMobile(messageId: string) {
    const conversationId = selectedConversationId
    if (!conversationId) return
    await runMobileAction(`withdraw-${messageId}`, async () => {
      await api.withdrawMessage(conversationId, messageId)
      await refreshDetailBestEffort(conversationId)
    })
  }

  async function editMessageFromMobile(messageId: string, content: string) {
    const conversationId = selectedConversationId
    if (!conversationId) return
    await runMobileAction(`edit-${messageId}`, async () => {
      await api.editMessage(conversationId, messageId, content)
      await refreshDetailBestEffort(conversationId)
    })
  }

  async function regenerateFromMobile() {
    const conversationId = selectedConversationId
    if (!conversationId) return
    await runMobileAction('regenerate', async () => {
      await api.regenerate(conversationId)
      await refreshDetailBestEffort(conversationId)
    })
  }

  async function openArtifactPreview(artifactId: string) {
    if (!configured) {
      setError('请先在设置里填写桌面端地址和设备 token。')
      return
    }
    const cached = artifactCache[artifactId]
    if (cached && Date.now() - cached.cachedAt < ARTIFACT_CACHE_TTL_MS) {
      artifactSeq.current++
      // 命中即刷新时间戳：缓存按最近使用淘汰，而不是按写入顺序
      setArtifactCache((current) => ({
        ...current,
        [artifactId]: { artifact: cached.artifact, cachedAt: Date.now() },
      }))
      setArtifactPreview(cached.artifact)
      setArtifactError(null)
      setArtifactLoadingId(null)
      return
    }

    const seq = ++artifactSeq.current
    setArtifactLoadingId(artifactId)
    setArtifactError(null)
    setArtifactPreview(null)
    try {
      const artifact = await api.getArtifact(artifactId)
      if (seq !== artifactSeq.current) return
      setArtifactCache((current) =>
        cacheArtifact(current, { artifact, cachedAt: Date.now() }),
      )
      setArtifactPreview(artifact)
    } catch (err) {
      if (seq === artifactSeq.current) {
        setArtifactError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (seq === artifactSeq.current) setArtifactLoadingId(null)
    }
  }

  function closeArtifactPreview() {
    artifactSeq.current++
    setArtifactPreview(null)
    setArtifactError(null)
    setArtifactLoadingId(null)
  }

  /** host 变了就丢弃旧 token：不能把 A 的长效 token 发给 B（可能只是共享/不可信的地址）。 */
  function updateConnection(next: ConnectionConfig) {
    setConnection((current) =>
      normalizeBaseUrl(next.baseUrl) !== normalizeBaseUrl(current.baseUrl)
        ? { ...next, deviceToken: '' }
        : next,
    )
  }

  /** 一次性配对码换设备 token；返回 null 表示成功，否则是给用户看的错误文案。 */
  async function pairDeviceFromMobile(code: string): Promise<string | null> {
    try {
      const result = await pairMobileDevice(connection.baseUrl, code, defaultMobileDeviceName())
      updateConnection({ ...connection, deviceToken: result.deviceToken })
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  usePullToRefresh(() => {
    void refreshSnapshot()
  }, configured && !selectedConversationId && activeView === 'home')

  const hasPending = !!snapshot && (snapshot.pendingWrites.length > 0 || snapshot.pendingQuestions.length > 0)
  const detailForSelected =
    conversationDetail && conversationDetail.conversation.id === selectedConversationId
      ? conversationDetail
      : null

  const content = selectedConversationId ? (
      <ConversationsScreen
        connected={configured}
        loading={loading}
        snapshot={snapshot}
        detail={detailForSelected}
        selectedConversationId={selectedConversationId}
        onOpenConversation={(id) => void openConversation(id)}
        onOpenArtifact={(id) => void openArtifactPreview(id)}
        onSendMessage={(content) => sendMessageFromMobile(content)}
        onWithdrawMessage={(messageId) => void withdrawMessageFromMobile(messageId)}
        onEditMessage={(messageId, content) => void editMessageFromMobile(messageId, content)}
        onRegenerate={() => void regenerateFromMobile()}
        busy={operationId !== null}
      />
    ) : activeView === 'settings' ? (
      <SettingsScreen
        connection={connection}
        loading={loading}
        error={error}
        connectionOk={connectionOk}
        recentHosts={recentHosts}
        onChange={updateConnection}
        onSelectHost={(baseUrl) => updateConnection({ ...connection, baseUrl })}
        onPairDevice={pairDeviceFromMobile}
        onTest={() => void refreshSnapshot()}
      />
    ) : (
      <div className="screen-stack">
        <StatusScreen
          connected={connectionOk}
          error={error}
          snapshot={snapshot}
          lastSyncedAt={lastSyncedAt}
          busyRunId={operationId}
          onOpenSettings={openSettings}
          onOpenConversation={(id) => void openConversation(id)}
          onAbortRun={(runId) =>
            void runMobileAction(runId, () => api.abortRun(runId))
          }
        />
        {hasPending && (
          <ApprovalsScreen
            connected={configured}
            busyId={operationId}
            snapshot={snapshot}
            onWriteDecision={(id, action) =>
              void runMobileAction(id, () => api.decidePendingWrite(id, action))
            }
            onQuestionAnswer={(id, answers: MobileAskUserAnswers) =>
              void runMobileAction(id, () => api.answerPendingQuestion(id, answers))
            }
          />
        )}
      </div>
    )

  const inConversation = !!selectedConversationId
  const navTitle = inConversation
    ? conversationDetail?.conversation.title ?? '会话'
    : activeView === 'settings'
      ? '设置'
      : '主页'

  let navRight: ReactNode = <span className="nav-bar-spacer" aria-hidden="true" />
  if (!inConversation && activeView === 'home') {
    if (!configured) {
      navRight = (
        <button type="button" className="nav-bar-button" aria-label="设置" onClick={openSettings}>
          <Settings className="chrome-icon" aria-hidden="true" />
        </button>
      )
    } else if (error && !loading) {
      navRight = (
        <span className="nav-bar-reconnect">
          <Loader2 className="inline-icon" aria-hidden="true" />
          重连
        </span>
      )
    } else {
      navRight = (
        <button type="button" className="nav-bar-button" aria-label="刷新" onClick={() => void refreshSnapshot()}>
          <RefreshCw className="chrome-icon" aria-hidden="true" />
        </button>
      )
    }
  }

  return (
    <main className="app-shell">
      <nav className="nav-bar">
        {inConversation ? (
          <button type="button" className="nav-bar-button" aria-label="返回会话列表" onClick={backToList}>
            <ChevronLeft className="chrome-icon" aria-hidden="true" />
          </button>
        ) : (
          <button type="button" className="nav-bar-button" aria-label="打开侧边栏" onClick={() => setDrawerOpen(true)}>
            <Menu className="chrome-icon" aria-hidden="true" />
          </button>
        )}
        <div className="nav-bar-title">{navTitle}</div>
        {navRight}
      </nav>

      <div className="screen-frame">{content}</div>

      <ArtifactPreviewSheet
        artifact={artifactPreview}
        loading={artifactLoadingId !== null}
        error={artifactError}
        onClose={closeArtifactPreview}
      />

      {drawerOpen && (
        <>
          <button type="button" className="drawer-backdrop" aria-label="关闭侧边栏" onClick={() => setDrawerOpen(false)} />
          <aside className="side-drawer" aria-label="侧边栏">
            <div className="drawer-header">
              <div>
                <p className="eyebrow">AgentHub</p>
                <h2>Companion</h2>
              </div>
              <button type="button" className="chrome-button" aria-label="关闭侧边栏" onClick={() => setDrawerOpen(false)}>
                <X className="chrome-icon" aria-hidden="true" />
              </button>
            </div>

            <div className="drawer-section">
              <button
                type="button"
                className={`drawer-item ${activeView === 'home' ? 'active' : ''}`}
                onClick={openHome}
              >
                <Home className="drawer-icon" aria-hidden="true" />
                主页
              </button>
              <button
                type="button"
                className={`drawer-item ${activeView === 'settings' ? 'active' : ''}`}
                onClick={openSettings}
              >
                <Settings className="drawer-icon" aria-hidden="true" />
                设置
              </button>
            </div>

            <div className="drawer-status">
              <span className={connectionOk ? 'status-pill online' : 'status-pill'}>
                {connectionOk ? '已连接' : configured ? '已配置' : '未配对'}
              </span>
              <p>
                {snapshot
                  ? `${snapshot.conversations.length} 个会话 · ${snapshot.runningRuns.length} 个运行中`
                  : '数据同步中'}
              </p>
            </div>
          </aside>
        </>
      )}
    </main>
  )
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/** 设备名会显示在桌面设置页的已配对列表里。 */
function defaultMobileDeviceName(): string {
  const match = /iPhone|iPad|Android/i.exec(navigator.userAgent)
  return match ? `${match[0]} 上的 AgentHub` : '移动设备'
}

/** 产物缓存的有效期：过期后重新拉取，避免一直显示桌面端已经改过的旧版本。 */
const ARTIFACT_CACHE_TTL_MS = 30_000
/** 缓存条数上限；超出按最近使用淘汰，防止长会话里无限增长。 */
const ARTIFACT_CACHE_MAX = 5

function cacheArtifact(
  current: Record<string, { artifact: MobileArtifact; cachedAt: number }>,
  entry: { artifact: MobileArtifact; cachedAt: number },
): Record<string, { artifact: MobileArtifact; cachedAt: number }> {
  const next = { ...current, [entry.artifact.id]: entry }
  const keys = Object.keys(next)
  if (keys.length > ARTIFACT_CACHE_MAX) {
    keys
      .sort((a, b) => next[a].cachedAt - next[b].cachedAt)
      .slice(0, keys.length - ARTIFACT_CACHE_MAX)
      .forEach((key) => delete next[key])
  }
  return next
}
