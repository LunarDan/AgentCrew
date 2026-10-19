import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { rejectCrossOriginWrite } from '@/server/local-origin'
import {
  deleteMcpServer,
  getMcpServer,
  toMcpServerView,
  updateMcpServer,
} from '@/server/mcp-server-service'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params
  const server = await getMcpServer(id)
  if (!server) return NextResponse.json({ error: `MCP server not found: ${id}` }, { status: 404 })
  return NextResponse.json({ server: toMcpServerView(server) })
}

const PatchBody = z
  .object({
    name: z.string().min(1).max(64).optional(),
    transport: z.enum(['stdio', 'sse', 'http']).optional(),
    command: z.union([z.string(), z.null()]).optional(),
    args: z.array(z.string()).optional(),
    url: z.union([z.string(), z.null()]).optional(),
    /**
     * 密钥按 key 合并：不给 = 完全不动；给 null = 清空整张 map；
     * 给 { KEY: 'v' } = 设置；给 { KEY: null } 或 { KEY: '' } = 删除该 key。
     * 前端只回传用户真正改过的 key，**不要**把掩码回传。
     */
    env: z.union([z.record(z.string(), z.union([z.string(), z.null()])), z.null()]).optional(),
    headers: z.union([z.record(z.string(), z.union([z.string(), z.null()])), z.null()]).optional(),
    trust: z.enum(['always', 'ask']).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const { id } = await ctx.params
  const raw = await req.json().catch(() => null)
  const parsed = PatchBody.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const server = await updateMcpServer(id, parsed.data)
    return NextResponse.json({ server: toMcpServerView(server) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const { id } = await ctx.params
  try {
    await deleteMcpServer(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
