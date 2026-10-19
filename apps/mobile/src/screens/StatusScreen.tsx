import { CheckCircle2, Link } from "lucide-react"

import { formatRelative, formatTime } from "../lib/format"
import type { MobileSnapshot } from "../types"
import { ConversationRow } from "./ConversationRow"

export function StatusScreen({
  connected,
  snapshot,
  lastSyncedAt,
  error,
  busyRunId,
  onOpenSettings,
  onOpenConversation,
  onAbortRun,
}: {
  connected: boolean
  snapshot: MobileSnapshot | null
  lastSyncedAt: number | null
  error: string | null
  busyRunId: string | null
  onOpenSettings: () => void
  onOpenConversation: (id: string) => void
  onAbortRun: (runId: string) => void
}) {
  const hasSnapshot = snapshot !== null
  const running = snapshot?.runningRuns.length ?? 0
  const pendingWrites = snapshot?.pendingWrites.length ?? 0
  const pendingQuestions = snapshot?.pendingQuestions.length ?? 0
  const conversations = snapshot?.conversations ?? []
  const allClear = hasSnapshot && running === 0 && pendingWrites === 0 && pendingQuestions === 0

  return (
    <div className="screen-stack">
      <section className="panel hero-panel">
        <div>
          <h2>{connected ? "桌面端已连接" : "未连接桌面端"}</h2>
          <p className="row-sub">{connectionSubtitle(connected, snapshot)}</p>
        </div>
        {connected ? (
          <span className="status-pill online">在线</span>
        ) : (
          <button type="button" className="primary-action small" onClick={onOpenSettings}>
            <Link className="button-icon" aria-hidden="true" />
            去配对
          </button>
        )}
      </section>

      {error && <div className="error-banner">{error}</div>}

      <section className="metric-grid">
        <Metric label="运行中" value={running} loading={!hasSnapshot} tone={running > 0 ? "accent" : undefined} />
        <Metric label="待审批" value={pendingWrites} loading={!hasSnapshot} tone={pendingWrites > 0 ? "orange" : undefined} />
        <Metric label="待回答" value={pendingQuestions} loading={!hasSnapshot} tone={pendingQuestions > 0 ? "accent" : undefined} />
      </section>

      {running > 0 && (
        <section className="card-list">
          <h2 className="section-title">运行中</h2>
          {(snapshot?.runningRuns ?? []).map((run) => {
            const agentName =
              snapshot?.agents.find((agent) => agent.id === run.agentId)?.name ?? "Agent"
            const busy = busyRunId === run.id
            return (
              <article key={run.id} className="approval-card">
                <div>
                  <h3>{agentName}</h3>
                  <p>开始于 {formatTime(run.startedAt)}</p>
                </div>
                <div className="approval-actions">
                  <button
                    type="button"
                    className="danger-action"
                    disabled={busy}
                    onClick={() => onAbortRun(run.id)}
                  >
                    {busy ? "停止中" : "停止"}
                  </button>
                </div>
              </article>
            )
          })}
        </section>
      )}

      {allClear && (
        <div className="all-clear">
          <CheckCircle2 className="button-icon" aria-hidden="true" />
          全部完成，暂无待办
        </div>
      )}

      <section className="list-section">
        <h2 className="section-title">会话</h2>
        {!hasSnapshot ? (
          <div className="group-card">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        ) : conversations.length > 0 ? (
          <div className="group-card">
            {conversations.map((conv) => (
              <ConversationRow key={conv.id} conv={conv} onOpen={onOpenConversation} />
            ))}
          </div>
        ) : (
          <div className="empty-state">{connected ? "还没有会话" : "请先连接桌面端"}</div>
        )}
      </section>

      {hasSnapshot && lastSyncedAt !== null && (
        <p className="sync-caption">最近同步 · {formatRelative(lastSyncedAt)}</p>
      )}
    </div>
  )
}

function connectionSubtitle(connected: boolean, snapshot: MobileSnapshot | null): string {
  if (!connected) return "在设置里填写桌面端地址和设备 token"
  if (!snapshot?.server) return "数据同步中"
  const channel = snapshot.server.companionMode === "tailnet" ? "Tailscale" : "局域网"
  return `${channel} · v${snapshot.server.version}`
}

function Metric({
  label,
  value,
  loading,
  tone,
}: {
  label: string
  value: number
  loading: boolean
  tone?: "accent" | "orange"
}) {
  const toneClass = tone === "orange" ? " is-orange" : tone === "accent" ? " is-accent" : ""
  return (
    <div className={`metric-card${toneClass}`}>
      <div className="metric-value">{loading ? "–" : value}</div>
      <div className="metric-label">{label}</div>
    </div>
  )
}

function SkeletonRow() {
  return (
    <div className="row">
      <div className="skeleton skeleton-avatar" />
      <div className="row-main">
        <div className="skeleton skeleton-line long" />
        <div className="skeleton skeleton-line short" />
      </div>
    </div>
  )
}
