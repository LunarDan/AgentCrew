import { NextResponse } from 'next/server'

import { pendingMcpTools } from '@/server/pending-mcp-tools'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params
  return NextResponse.json({ pendingCalls: pendingMcpTools.listByConversation(id) })
}
