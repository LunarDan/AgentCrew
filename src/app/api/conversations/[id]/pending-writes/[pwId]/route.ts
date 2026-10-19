import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { rejectCrossOriginWrite } from '@/server/local-origin'
import { pendingWrites } from '@/server/pending-writes'

interface RouteContext {
  params: Promise<{ id: string; pwId: string }>
}

const Body = z.object({
  action: z.enum(['approve', 'reject']),
})

/** POST /api/conversations/:id/pending-writes/:pwId  body { action } —— 应用或拒绝一个 pending fs_write。 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const { id, pwId } = await ctx.params
  const raw = await req.json().catch(() => null)
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  const existing = pendingWrites.get(pwId)
  if (!existing || existing.conversationId !== id) {
    return NextResponse.json({ error: 'Pending write not found' }, { status: 404 })
  }

  if (parsed.data.action === 'reject') {
    return pendingWrites.reject(pwId)
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: 'Pending write not found' }, { status: 404 })
  }

  const result = pendingWrites.approve(pwId)
  if (!result.ok) {
    if (result.reason === 'not_found') {
      return NextResponse.json({ error: 'Pending write not found' }, { status: 404 })
    }
    return NextResponse.json({ error: result.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
