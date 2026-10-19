import type { ConnectionConfig } from '../types'

const STORAGE_KEY = 'agenthub.mobile.connection'
const RECENT_HOSTS_KEY = 'agenthub.mobile.recentHosts'
const MAX_RECENT_HOSTS = 5

const EMPTY_CONNECTION: ConnectionConfig = {
  baseUrl: '',
  deviceToken: '',
}

export function loadConnection(): ConnectionConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY_CONNECTION
    const parsed = JSON.parse(raw) as Partial<ConnectionConfig>
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      deviceToken: typeof parsed.deviceToken === 'string' ? parsed.deviceToken : '',
    }
  } catch {
    return EMPTY_CONNECTION
  }
}

export function saveConnection(config: ConnectionConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // 存储被禁用 / 配额满时不该让每次输入都抛错；本会话内仍然可用
  }
}

export function loadRecentHosts(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_HOSTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
  } catch {
    return []
  }
}

export function rememberRecentHost(baseUrl: string): string[] {
  const normalized = normalizeBaseUrl(baseUrl)
  if (!normalized) return loadRecentHosts()

  const next = [normalized, ...loadRecentHosts().filter((host) => host !== normalized)].slice(
    0,
    MAX_RECENT_HOSTS,
  )
  try {
    localStorage.setItem(RECENT_HOSTS_KEY, JSON.stringify(next))
  } catch {
    // 同上：最近地址只是便利功能，写不进去就返回内存里的结果
  }
  return next
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}
