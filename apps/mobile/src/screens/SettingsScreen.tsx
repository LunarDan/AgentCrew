import { CheckCircle2, Clock, Link, Wifi } from 'lucide-react'
import { useState } from 'react'

import type { ConnectionConfig } from '../types'

export function SettingsScreen({
  connection,
  loading,
  error,
  connectionOk,
  recentHosts,
  onChange,
  onTest,
  onSelectHost,
  onPairDevice,
}: {
  connection: ConnectionConfig
  loading: boolean
  error: string | null
  connectionOk: boolean
  recentHosts: string[]
  onChange: (next: ConnectionConfig) => void
  onTest: () => void
  onSelectHost: (host: string) => void
  /** 返回 null 表示成功，否则是给用户看的错误文案。 */
  onPairDevice: (code: string) => Promise<string | null>
}) {
  const usingLoopback = isLoopbackUrl(connection.baseUrl)
  const [pairingCode, setPairingCode] = useState('')
  const [pairingBusy, setPairingBusy] = useState(false)
  const [pairingError, setPairingError] = useState<string | null>(null)
  const [pairingOk, setPairingOk] = useState(false)

  async function handlePair() {
    if (pairingBusy || !pairingCode.trim()) return
    setPairingBusy(true)
    setPairingError(null)
    setPairingOk(false)
    try {
      const message = await onPairDevice(pairingCode)
      if (message) {
        setPairingError(message)
      } else {
        setPairingOk(true)
        setPairingCode('')
      }
    } finally {
      setPairingBusy(false)
    }
  }

  return (
    <div className="screen-stack">
      <section className="panel vertical">
        <div className="settings-heading">
          <h2>桌面端连接</h2>
          <span className={connectionOk ? 'status-pill online' : 'status-pill'}>
            {connectionOk ? '桌面端已连接' : '请连接桌面端'}
          </span>
        </div>

        <label className="field">
          <span>桌面端地址</span>
          <input
            value={connection.baseUrl}
            placeholder="http://192.168.x.y:60646"
            inputMode="url"
            autoCapitalize="none"
            onChange={(e) => onChange({ ...connection, baseUrl: e.target.value })}
          />
        </label>

        {usingLoopback && (
          <div className="warning-banner">
            <Link className="inline-icon" aria-hidden="true" />
            真机请填写电脑的局域网或 Tailscale 地址
          </div>
        )}

        {recentHosts.length > 0 && (
          <div className="recent-hosts">
            <div className="recent-hosts-title">
              <Clock className="inline-icon" aria-hidden="true" />
              最近地址
            </div>
            <div className="recent-hosts-list">
              {recentHosts.map((host) => (
                <button
                  key={host}
                  type="button"
                  className="recent-host-button"
                  onClick={() => onSelectHost(host)}
                >
                  {host}
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="field">
          <span>设备 token</span>
          <input
            value={connection.deviceToken}
            placeholder="从桌面端「设置」里复制设备 token"
            autoCapitalize="none"
            autoComplete="off"
            onChange={(e) => onChange({ ...connection, deviceToken: e.target.value })}
          />
        </label>

        <label className="field">
          <span>或用一次性配对码</span>
          <input
            value={pairingCode}
            placeholder="桌面设置页「生成」的 6 位数字"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={12}
            onChange={(e) => {
              setPairingCode(e.target.value)
              setPairingOk(false)
            }}
          />
        </label>
        <button
          type="button"
          className="primary-action full"
          disabled={pairingBusy || !pairingCode.trim()}
          onClick={() => void handlePair()}
        >
          {pairingBusy ? '配对中' : '用配对码连接'}
        </button>
        {pairingError && <div className="error-banner">{pairingError}</div>}
        {pairingOk && (
          <p className="muted-text">配对成功，设备 token 已填入。请点「测试连接」。</p>
        )}

        {error && <div className="error-banner">{error}</div>}

        <button type="button" className="primary-action full" onClick={onTest}>
          {connectionOk ? (
            <CheckCircle2 className="button-icon" aria-hidden="true" />
          ) : (
            <Wifi className="button-icon" aria-hidden="true" />
          )}
          {loading ? '测试中' : '测试连接'}
        </button>
      </section>
    </div>
  )
}

function isLoopbackUrl(value: string): boolean {
  try {
    const trimmed = value.trim()
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
    const url = new URL(withScheme)
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  } catch {
    return false
  }
}
