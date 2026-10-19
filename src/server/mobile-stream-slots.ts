/**
 * 移动端事件流的并发上限。每条 SSE 连接都会订阅全局 eventBus 并常驻内存，
 * 一个已经配对的设备（或共享 token 的多台设备）反复重连就能把宿主拖垮；
 * 手机端本来只需要一条流，留一点重连余量即可。
 */

export const MAX_MOBILE_STREAM_CONNECTIONS = 8
export const MAX_MOBILE_STREAM_CONNECTIONS_PER_TOKEN = 2

export interface MobileStreamSlot {
  release(): void
}

interface SlotState {
  total: number
  perToken: Map<string, number>
}

const globalForSlots = globalThis as unknown as {
  __agenthubMobileStreamSlots?: SlotState
}

const state: SlotState = globalForSlots.__agenthubMobileStreamSlots ?? {
  total: 0,
  perToken: new Map(),
}
if (!globalForSlots.__agenthubMobileStreamSlots) {
  globalForSlots.__agenthubMobileStreamSlots = state
}

/** 占一个并发位；超额返回 null（调用方回 429）。 */
export function acquireMobileStreamSlot(tokenHash: string): MobileStreamSlot | null {
  const current = state.perToken.get(tokenHash) ?? 0
  if (state.total >= MAX_MOBILE_STREAM_CONNECTIONS) return null
  if (current >= MAX_MOBILE_STREAM_CONNECTIONS_PER_TOKEN) return null

  state.total += 1
  state.perToken.set(tokenHash, current + 1)

  let released = false
  return {
    release() {
      if (released) return
      released = true
      state.total -= 1
      const remaining = (state.perToken.get(tokenHash) ?? 1) - 1
      if (remaining <= 0) state.perToken.delete(tokenHash)
      else state.perToken.set(tokenHash, remaining)
    },
  }
}

export function mobileStreamConnectionCount(): number {
  return state.total
}

export function resetMobileStreamSlotsForTest(): void {
  state.total = 0
  state.perToken.clear()
}
