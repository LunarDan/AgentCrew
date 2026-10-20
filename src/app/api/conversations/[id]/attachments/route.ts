import { NextRequest, NextResponse } from 'next/server'

import { listAttachments, uploadAttachment } from '@/server/attachment-service'
import { rejectCrossOriginWrite } from '@/server/local-origin'

interface RouteContext {
  params: Promise<{ id: string }>
}

/** 与 attachment-service 的 20MB 文件上限对齐，多留 1MB 给 multipart 边界与头部。 */
const MAX_UPLOAD_BYTES = 21 * 1024 * 1024

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params
  const attachments = await listAttachments(id)
  return NextResponse.json({ attachments })
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const { id } = await ctx.params
  // 先按 Content-Length 拒绝超大包：req.formData() 会把整个 body 读进内存。
  const contentLength = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 })
  }
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
  }
  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file' }, { status: 400 })
  }

  try {
    const attachment = await uploadAttachment({ conversationId: id, file })
    return NextResponse.json({ attachment }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 落盘 / 入库失败是服务端问题，不能伪装成 400 把内部错误串回给调用方
    if (message === 'Failed to store attachment') {
      return NextResponse.json({ error: message }, { status: 500 })
    }
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
