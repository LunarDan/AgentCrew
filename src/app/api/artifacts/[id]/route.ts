import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, schema } from '@/db/client'
import { deleteArtifact } from '@/server/artifact-service'
import { rejectCrossOriginWrite } from '@/server/local-origin'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params
  const artifact = await db.query.artifacts.findFirst({
    where: eq(schema.artifacts.id, id),
  })
  if (!artifact) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json({ artifact })
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const { id } = await ctx.params
  const existing = await db.query.artifacts.findFirst({
    where: eq(schema.artifacts.id, id),
    columns: { id: true },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  try {
    await deleteArtifact(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 预检与删除之间被另一个标签页删掉了：这是并发，不是服务端故障
    if (message.startsWith('Artifact not found')) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    // 真正删除失败（DB / 部署目录清理）应报 500，且不回内部错误串
    console.error('[artifacts] delete failed', err)
    return NextResponse.json({ error: 'Failed to delete artifact' }, { status: 500 })
  }
}
