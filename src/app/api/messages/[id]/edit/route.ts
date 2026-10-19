import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { editAndResendLatestUserMessage } from '@/server/conversation-service'
import { MAX_MESSAGE_CHARS } from '@/shared/constants'

interface RouteContext {
  params: Promise<{ id: string }>
}

const Body = z.object({
  conversationId: z.string().min(1),
  content: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
})

export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params
  const raw = await req.json().catch(() => null)
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const result = await editAndResendLatestUserMessage(
      parsed.data.conversationId,
      id,
      parsed.data.content,
    )
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = message.includes('not found')
      ? 404
      : message.startsWith('A newer user message arrived')
        ? 409
        : /Only the latest user message|Only user messages|Content cannot be empty|Message is too long|Attachments/.test(
              message,
            )
          ? 400
          : 500
    if (status === 500) {
      console.error('[edit] failed', err)
      return NextResponse.json({ error: 'Internal error' }, { status })
    }
    return NextResponse.json({ error: message }, { status })
  }
}
