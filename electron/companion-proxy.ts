import path from 'node:path'

export const COMPANION_ROUTE_PREFIX = '/api/mobile/'

/**
 * 只有移动端 API 允许越过 loopback 边界；desktop API 一律不转发。
 *
 * 不能只看原始字符串前缀：`/api/mobile/../settings` 前缀命中，但 Next 解析时
 * 会归一化成 `/api/settings`（未鉴权的桌面 API）。这里先解码、再按 POSIX 规则
 * 归一化，归一化改变了路径就拒绝。
 */
export function isCompanionProxyPath(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false
  const rawPath = rawUrl.split('?', 1)[0].split('#', 1)[0]
  if (rawPath.includes('\\')) return false

  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return false
  }
  // 编码过的反斜杠（%5C）解码后不是合法 URL 路径；Windows 上 path.posix 也不会归一化它。
  if (decoded.includes('\\')) return false
  const normalized = path.posix.normalize(decoded)
  if (normalized !== decoded) return false
  return normalized.startsWith(COMPANION_ROUTE_PREFIX)
}
