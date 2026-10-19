const MAX_UNWRAP_DEPTH = 4

/**
 * 从适配器上报的 tool.result 中读出 write_artifact 的交接信息。
 * Claude Code 的 MCP 结果是 [{type:'text', text:'{...}'}]，Codex 是 {result, status}，
 * 这里统一按数组 / 包装对象递归解包，否则跨任务产物交接会静默丢失。
 */
export function readArtifactHandoffResult(
  result: unknown,
): { artifactId: string; outputKey: string } | null {
  const value = unwrapToolResultValue(result)
  if (!value) return null
  if (typeof value.artifactId !== 'string' || typeof value.outputKey !== 'string') return null
  if (!value.outputKey.trim()) return null
  return { artifactId: value.artifactId, outputKey: value.outputKey }
}

function unwrapToolResultValue(
  result: unknown,
  depth = 0,
): Record<string, unknown> | null {
  if (depth > MAX_UNWRAP_DEPTH) return null

  if (typeof result === 'string') {
    const parsed = parseJsonRecord(result)
    return parsed ? unwrapToolResultValue(parsed, depth + 1) : null
  }

  if (Array.isArray(result)) {
    for (const item of result) {
      const found = unwrapToolResultValue(item, depth + 1)
      if (found) return found
    }
    return null
  }

  if (!result || typeof result !== 'object') return null

  const obj = result as Record<string, unknown>
  if (typeof obj.artifactId === 'string' && typeof obj.outputKey === 'string') return obj

  if (typeof obj.text === 'string') {
    const parsed = parseJsonRecord(obj.text)
    if (parsed) {
      const found = unwrapToolResultValue(parsed, depth + 1)
      if (found) return found
    }
  }

  for (const key of ['result', 'value', 'content', 'output']) {
    if (key in obj) {
      const found = unwrapToolResultValue(obj[key], depth + 1)
      if (found) return found
    }
  }

  return null
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
