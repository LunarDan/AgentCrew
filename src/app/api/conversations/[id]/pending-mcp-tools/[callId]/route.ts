import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { pendingMcpTools } from '@/server/pending-mcp-tools'

interface RouteContext {
  params: Promise<{ id: string; callId: string }>
}

const Body = z.object({
  action: z.enum(['approve', 'reject']),
})

export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id, callId } = await ctx.params
  const raw = await req.json().catch(() => null)
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  const existing = pendingMcpTools.get(callId)
  if (!existing || existing.conversationId !== id) {
    return NextResponse.json({ error: 'Pending MCP tool call not found' }, { status: 404 })
  }

  const ok =
    parsed.data.action === 'approve'
      ? pendingMcpTools.approve(callId)
      : pendingMcpTools.reject(callId)

  if (!ok) {
    return NextResponse.json({ error: 'Failed to process pending MCP tool call' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
