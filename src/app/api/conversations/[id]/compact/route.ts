import { NextRequest, NextResponse } from 'next/server'

import { compactConversation } from '@/server/context-compaction-service'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params
  try {
    const result = await compactConversation(id, req.signal)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = message.startsWith('Conversation not found')
      ? 404
      : /No compactable|Compaction is already in progress|History changed/.test(message)
        ? 409
        : 500
    if (status === 500) {
      console.error('[compact] failed', err)
      return NextResponse.json({ error: 'Internal error' }, { status })
    }
    return NextResponse.json({ error: message }, { status })
  }
}
