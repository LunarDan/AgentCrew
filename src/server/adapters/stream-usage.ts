import type { RunUsage } from '@/db/schema'

export interface DeltaUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  lastInputTokens: number
}

/**
 * 从 Anthropic 的 `message_delta` 流事件里取本次 API 调用的 token 用量。
 * 计划阶段在 `plan_tasks` 处提前结束、拿不到 SDK 的 `result`，只能靠这个补齐。
 * 字段可能为 null（部分兼容网关不返回缓存桶），一律按 0 处理。
 */
export function extractMessageDeltaUsage(event: unknown): DeltaUsage | null {
  if (typeof event !== 'object' || event === null) return null
  const { type, usage } = event as { type?: unknown; usage?: unknown }
  if (type !== 'message_delta' || typeof usage !== 'object' || usage === null) return null
  const u = usage as {
    input_tokens?: unknown
    output_tokens?: unknown
    cache_creation_input_tokens?: unknown
    cache_read_input_tokens?: unknown
  }
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const inputTokens = num(u.input_tokens)
  const outputTokens = num(u.output_tokens)
  const cacheCreationTokens = num(u.cache_creation_input_tokens)
  const cacheReadTokens = num(u.cache_read_input_tokens)
  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheCreationTokens === 0 &&
    cacheReadTokens === 0
  ) {
    return null
  }
  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    // 实际 prompt 大小 = 三桶之和（Anthropic 把 prompt 拆成 input / cache_creation / cache_read）
    lastInputTokens: inputTokens + cacheCreationTokens + cacheReadTokens,
  }
}

/** 计划阶段可能多次调用模型（先侦察再出计划）：按调用累加，供 message.usage 覆盖写。 */
export function accumulateUsage(previous: RunUsage | null, next: DeltaUsage): RunUsage {
  return {
    inputTokens: (previous?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + next.outputTokens,
    cacheCreationTokens: (previous?.cacheCreationTokens ?? 0) + next.cacheCreationTokens,
    cacheReadTokens: (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
    lastInputTokens: next.lastInputTokens || previous?.lastInputTokens,
  }
}
