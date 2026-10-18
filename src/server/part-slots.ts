import type { MessagePart, StreamEvent } from '@/shared/types'

/**
 * partIndex 翻译表：适配器的「流内逻辑序号」→ parts 数组的真实槽位。
 *
 * 适配器的 partIndex 只在它自己发出的 part.start 上递增，而 tool.call / tool.result 由
 * AgentRunner 另走 push 追加进同一个 parts 数组、不占该序号。两者混用会让 part.start 的下标
 * 赋值覆盖掉已被 push 的 tool_use 槽位，工具卡片随之消失。这里由 Runner 统一分配槽位，使
 * Runner 成为唯一索引权威（`specs/02-stream-events.md`「AgentRunner 是唯一持有 message 流的角色」）。
 *
 * 生命周期：per-run 内存态，键为 messageId，随 `consumeStream` 的作用域回收。Runner 自己合成
 * 的 `message.end`（工具调用中止路径）不走这里，只会让一个条目活到 run 结束，无副作用。
 */
export type PartSlotsByMessage = Map<string, Map<number, number>>

/** 把事件携带的流内序号翻译为 parts 下标；非 part.* 事件原样返回。 */
export function translatePartIndex(
  event: StreamEvent,
  partsBuffer: Map<string, MessagePart[]>,
  slotsByMessage: PartSlotsByMessage,
): StreamEvent {
  switch (event.type) {
    case 'message.start':
    case 'message.end':
      // partsBuffer 在 message.start 重置、message.end 释放，槽位映射跟着换代。
      slotsByMessage.delete(event.messageId)
      return event
    case 'part.start':
    case 'part.delta':
    case 'part.end':
      return {
        ...event,
        partIndex: resolveSlot(event.messageId, event.partIndex, partsBuffer, slotsByMessage),
      }
    default:
      return event
  }
}

function resolveSlot(
  messageId: string,
  streamIndex: number,
  partsBuffer: Map<string, MessagePart[]>,
  slotsByMessage: PartSlotsByMessage,
): number {
  const slots = slotsByMessage.get(messageId) ?? new Map<number, number>()
  slotsByMessage.set(messageId, slots)

  const known = slots.get(streamIndex)
  if (known !== undefined) return known

  // 数组恒稠密（只由 push 与「落到 length 处」增长），length 永远是空闲槽位，不会碰撞。
  const slot = partsBuffer.get(messageId)?.length ?? 0
  slots.set(streamIndex, slot)
  return slot
}
