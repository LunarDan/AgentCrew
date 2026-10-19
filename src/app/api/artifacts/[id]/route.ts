import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, schema } from '@/db/client'
import { deleteArtifact } from '@/server/artifact-service'

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

export async function DELETE(_req: Request, ctx: RouteContext) {
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
    // 存在但删除失败（DB / 部署目录清理）应报 500，不能伪装成 404
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
