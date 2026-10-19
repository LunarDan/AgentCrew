import { NextRequest, NextResponse } from 'next/server'

import { abortRun } from '@/server/conversation-service'
import { rejectCrossOriginWrite } from '@/server/local-origin'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const { id } = await ctx.params
  const ok = await abortRun(id)
  if (!ok) {
    return NextResponse.json({ error: 'Run not found or already finished' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
