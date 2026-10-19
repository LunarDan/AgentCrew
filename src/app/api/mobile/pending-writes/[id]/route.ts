import type { NextRequest } from 'next/server'
import { z } from 'zod'

import { mobileJson, mobileOptions } from '@/server/mobile-cors'
import { requireMobileAuth } from '@/server/mobile-auth'
import { pendingWrites } from '@/server/pending-writes'

interface RouteContext {
  params: Promise<{ id: string }>
}

const Body = z.object({
  action: z.enum(['approve', 'reject']),
})

export const OPTIONS = mobileOptions

export async function POST(req: NextRequest, ctx: RouteContext) {
  const authError = await requireMobileAuth(req)
  if (authError) return authError

  const raw = await req.json().catch(() => null)
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return mobileJson(req, { error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  const { id } = await ctx.params
  const existing = pendingWrites.get(id)
  if (!existing) {
    return mobileJson(req, { error: 'Pending write not found' }, { status: 404 })
  }

  if (parsed.data.action === 'reject') {
    return pendingWrites.reject(id)
      ? mobileJson(req, { ok: true })
      : mobileJson(req, { error: 'Pending write not found' }, { status: 404 })
  }

  const result = pendingWrites.approve(id)
  if (!result.ok) {
    if (result.reason === 'not_found') {
      return mobileJson(req, { error: 'Pending write not found' }, { status: 404 })
    }
    // 写盘失败原因可能带宿主绝对路径 / errno，不能回给局域网设备
    console.error('[mobile] pending write approve failed', result.message)
    return mobileJson(req, { error: 'Failed to write file' }, { status: 500 })
  }
  return mobileJson(req, { ok: true })
}
