import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { getWorkspaceForConversation, writeFileInWorkspace } from '@/server/fs-service'
import { rejectCrossOriginWrite } from '@/server/local-origin'

interface RouteContext {
  params: Promise<{ id: string }>
}

const Body = z.object({
  path: z.string().min(1).max(4096),
  content: z.string(),
})

/** 真正的 100KB 上限由 writeFileInWorkspace 判定；这里先挡住异常超大包，别等到解析完才拒绝。 */
const MAX_REQUEST_BYTES = 1024 * 1024

export async function POST(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const contentLength = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 })
  }
  const { id } = await ctx.params
  const raw = await req.json().catch(() => null)
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  const workspace = await getWorkspaceForConversation(id)
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  }

  try {
    const result = writeFileInWorkspace(workspace, parsed.data.path, parsed.data.content)
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = msg.includes('outside')
      ? 403
      : msg.includes('too large') || msg.includes('quota')
        ? 413
        : 500
    if (status === 500) {
      console.error('[fs/write] failed', err)
      return NextResponse.json({ error: 'Internal error' }, { status })
    }
    return NextResponse.json({ error: msg }, { status })
  }
}
