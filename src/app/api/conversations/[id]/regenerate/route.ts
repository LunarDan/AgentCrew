import { NextRequest, NextResponse } from 'next/server'

import { regenerateLatestResponse } from '@/server/conversation-service'
import { rejectCrossOriginWrite } from '@/server/local-origin'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * POST /api/conversations/:id/regenerate
 * 删除最后一条 user 之后的所有 agent message + run + artifact_ref，
 * 然后以同一条 user 消息为触发重起 AgentRunner。
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const { id } = await ctx.params
  try {
    const result = await regenerateLatestResponse(id)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = message.startsWith('Conversation not found')
      ? 404
      : message.startsWith('A newer user message arrived') ||
          message.startsWith('Regeneration already in progress')
        ? 409
        : message.startsWith('No user message')
          ? 400
          : 500
    if (status === 500) {
      console.error('[regenerate] failed', err)
      return NextResponse.json({ error: 'Internal error' }, { status })
    }
    return NextResponse.json({ error: message }, { status })
  }
}
