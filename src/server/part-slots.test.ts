import { describe, expect, it } from 'vitest'

import type { MessagePart, StreamEvent } from '@/shared/types'

import { translatePartIndex, type PartSlotsByMessage } from './part-slots'

const CONV = 'conv_1'
const MSG = 'msg_1'

function harness(): {
  partsBuffer: Map<string, MessagePart[]>
  slots: PartSlotsByMessage
} {
  return { partsBuffer: new Map(), slots: new Map() }
}

function partStart(messageId: string, partIndex: number, content = ''): StreamEvent {
  return {
    type: 'part.start',
    conversationId: CONV,
    timestamp: 0,
    messageId,
    partIndex,
    part: { type: 'text', content },
  }
}

function partDelta(messageId: string, partIndex: number, text: string): StreamEvent {
  return {
    type: 'part.delta',
    conversationId: CONV,
    timestamp: 0,
    messageId,
    partIndex,
    delta: { type: 'text.append', text },
  }
}

function messageStart(messageId: string): StreamEvent {
  return {
    type: 'message.start',
    conversationId: CONV,
    timestamp: 0,
    messageId,
    agentId: 'agent_1',
    runId: 'run_1',
  }
}

function messageEnd(messageId: string): StreamEvent {
  return { type: 'message.end', conversationId: CONV, timestamp: 0, messageId }
}

function toolCall(messageId: string): StreamEvent {
  return {
    type: 'tool.call',
    conversationId: CONV,
    timestamp: 0,
    messageId,
    callId: 'call_1',
    toolName: 'Bash',
    args: {},
  }
}

/** 取翻译后的槽位；避免在断言里散落类型断言。 */
function slotOf(event: StreamEvent): number {
  if (event.type !== 'part.start' && event.type !== 'part.delta' && event.type !== 'part.end') {
    throw new Error(`expected a part event, got ${event.type}`)
  }
  return event.partIndex
}

describe('translatePartIndex', () => {
  it('assigns the next free slot to a stream index seen for the first time', () => {
    const { partsBuffer, slots } = harness()
    partsBuffer.set(MSG, [])

    expect(slotOf(translatePartIndex(partStart(MSG, 0), partsBuffer, slots))).toBe(0)

    partsBuffer.get(MSG)?.push({ type: 'text', content: 'a' })
    expect(slotOf(translatePartIndex(partStart(MSG, 1), partsBuffer, slots))).toBe(1)
  })

  it('keeps a stream index on its slot so part.delta lands on the same part', () => {
    const { partsBuffer, slots } = harness()
    partsBuffer.set(MSG, [])

    translatePartIndex(partStart(MSG, 0), partsBuffer, slots)
    // 中途有别的写者 push 了一个 part —— 槽位 0 的归属不能被改写。
    partsBuffer.get(MSG)?.push({ type: 'tool_use', callId: 'c1', toolName: 'Bash', args: {} })

    expect(slotOf(translatePartIndex(partDelta(MSG, 0, 'x'), partsBuffer, slots))).toBe(0)
  })

  it('does not collide with a part the Runner pushed (F1 regression)', () => {
    const { partsBuffer, slots } = harness()
    partsBuffer.set(MSG, [])

    // 适配器先发 tool.call，Runner 走 push 占掉槽位 0，适配器的计数器毫不知情。
    partsBuffer.get(MSG)?.push({ type: 'tool_use', callId: 'c1', toolName: 'Bash', args: {} })

    // 随后 text 的 part.start 流内序号仍是 0 —— 必须落到槽位 1，而不是覆盖 tool_use。
    const translated = translatePartIndex(partStart(MSG, 0, 'done'), partsBuffer, slots)
    expect(slotOf(translated)).toBe(1)

    const parts = partsBuffer.get(MSG) ?? []
    parts[slotOf(translated)] = { type: 'text', content: 'done' }

    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatchObject({ type: 'tool_use' })
    expect(parts[1]).toMatchObject({ type: 'text', content: 'done' })
  })

  it('keeps messages independent of each other', () => {
    const { partsBuffer, slots } = harness()
    partsBuffer.set('msg_a', [])

    expect(slotOf(translatePartIndex(partStart('msg_a', 0), partsBuffer, slots))).toBe(0)
    // 另一个 message 尚无缓冲区：从 0 重新开始，不受 msg_a 影响。
    expect(slotOf(translatePartIndex(partStart('msg_b', 0), partsBuffer, slots))).toBe(0)
  })

  it('resets the mapping on message.start so a reused id starts over', () => {
    const { partsBuffer, slots } = harness()
    partsBuffer.set(MSG, [{ type: 'text', content: 'old' }])
    expect(slotOf(translatePartIndex(partStart(MSG, 0), partsBuffer, slots))).toBe(1)

    translatePartIndex(messageStart(MSG), partsBuffer, slots)
    partsBuffer.set(MSG, [])
    expect(slotOf(translatePartIndex(partStart(MSG, 0), partsBuffer, slots))).toBe(0)
  })

  it('releases the mapping on message.end', () => {
    const { partsBuffer, slots } = harness()
    partsBuffer.set(MSG, [{ type: 'text', content: 'old' }])
    expect(slotOf(translatePartIndex(partStart(MSG, 0), partsBuffer, slots))).toBe(1)

    translatePartIndex(messageEnd(MSG), partsBuffer, slots)
    partsBuffer.set(MSG, [])
    expect(slotOf(translatePartIndex(partStart(MSG, 0), partsBuffer, slots))).toBe(0)
  })

  it('returns non-part events untouched', () => {
    const { partsBuffer, slots } = harness()
    const event = toolCall(MSG)

    expect(translatePartIndex(event, partsBuffer, slots)).toBe(event)
  })
})
