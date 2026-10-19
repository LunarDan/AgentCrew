import { readFileSync } from 'node:fs'

import { NextResponse } from 'next/server'

import { deleteAttachment, getAttachment, getAttachmentAbsolutePath } from '@/server/attachment-service'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * 只有常见位图允许 inline。SVG 是 active content（内嵌 script / onload 会在
 * 应用同源下执行），上传者又能自报 mimeType，所以一律按附件下载。
 */
const INLINE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/**
 * GET → 下载（或在浏览器内嵌预览，按 mimeType inline）
 * DELETE → 从文件库移除
 */
export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params
  const row = await getAttachment(id)
  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const abs = await getAttachmentAbsolutePath(id)
  if (!abs) {
    return NextResponse.json({ error: 'File missing on disk' }, { status: 410 })
  }

  const buf = readFileSync(abs)
  const inline = INLINE_IMAGE_TYPES.has(row.mimeType)
  const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.fileName)}`

  // Next.js 16 expects BodyInit; Buffer is acceptable
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': row.mimeType,
      'Content-Length': String(buf.length),
      'Content-Disposition': disposition,
      'Cache-Control': 'private, max-age=3600',
      // mimeType 来自上传者；禁止浏览器嗅探成 HTML，并给可能的直接打开再加一层沙箱。
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    },
  })
}

export async function DELETE(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params
  try {
    await deleteAttachment(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith('Attachment not found')) {
      return NextResponse.json({ error: message }, { status: 404 })
    }
    console.error('[attachments/delete] failed', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
