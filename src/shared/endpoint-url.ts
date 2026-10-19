/**
 * 通用的 endpoint 格式校验（不含 provider 协议兼容性判断）。
 * 空值视为「使用默认 endpoint」，交给调用方决定是否必填。
 */
export function validateEndpointUrl(
  value: string | null | undefined,
  label: string,
): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return `${label} 必须是完整 URL（含 http:// 或 https://），例如 https://api.anthropic.com`
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `${label} 只支持 http:// 或 https://`
  }

  return null
}
