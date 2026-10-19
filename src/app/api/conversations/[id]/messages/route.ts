import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { clearConversationHistory, listMessages, sendMessage } from '@/server/conversation-service'
import { rejectCrossOriginWrite } from '@/server/local-origin'
import { MAX_ID_CHARS, MAX_ID_LIST_LENGTH, MAX_MESSAGE_CHARS } from '@/shared/constants'

interface RouteContext {
  params: Promise<{ id: string }>
}

const SendBody = z
  .object({
    content: z.string().max(MAX_MESSAGE_CHARS).default(''),
    mentionedAgentIds: z
      .array(z.string().max(MAX_ID_CHARS))
      .max(MAX_ID_LIST_LENGTH)
      .optional(),
    parentMessageId: z.string().max(MAX_ID_CHARS).optional(),
    attachmentIds: z.array(z.string().max(MAX_ID_CHARS)).max(MAX_ID_LIST_LENGTH).optional(),
  })
  .refine(
    (d) => d.content.trim().length > 0 || (d.attachmentIds && d.attachmentIds.length > 0),
    { message: '必须提供 content 或 attachmentIds 之一' },
  )

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params
  const messages = await listMessages(id)
  return NextResponse.json({ messages })
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const { id } = await ctx.params
  const raw = await req.json().catch(() => null)
  const parsed = SendBody.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const result = await sendMessage({
      conversationId: id,
      content: parsed.data.content,
      mentionedAgentIds: parsed.data.mentionedAgentIds,
      parentMessageId: parsed.data.parentMessageId,
      attachmentIds: parsed.data.attachmentIds,
    })
    return NextResponse.json(result, { status: 202 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = message.startsWith('Conversation not found')
      ? 404
      : /Message is too long|Attachments|群聊缺少协调者|No available agent/.test(message)
        ? 400
        : 500
    if (status === 500) {
      console.error('[messages] send failed', err)
      return NextResponse.json({ error: 'Internal error' }, { status })
    }
    return NextResponse.json({ error: message }, { status })
  }
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const { id } = await ctx.params
  try {
    const result = await clearConversationHistory(id)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = message.startsWith('Conversation not found')
      ? 404
      : message.includes('agent runs are active')
        ? 409
        : 400
    return NextResponse.json({ error: message }, { status })
  }
}
