import type { NextRequest } from 'next/server'

import { mobileJson, mobileOptions } from '@/server/mobile-cors'
import { requireMobileAuth } from '@/server/mobile-auth'
import { abortRun } from '@/server/conversation-service'

interface RouteContext {
  params: Promise<{ id: string }>
}

export const OPTIONS = mobileOptions

/** 与桌面端 /api/runs/:id/abort 同一服务函数；移动端只是多一层 Bearer 鉴权。 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const authError = await requireMobileAuth(req)
  if (authError) return authError

  const { id } = await ctx.params
  const ok = await abortRun(id)
  if (!ok) {
    return mobileJson(req, { error: 'Run not found or already finished' }, { status: 404 })
  }
  return mobileJson(req, { ok: true })
}
