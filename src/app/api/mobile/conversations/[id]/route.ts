import type { NextRequest } from 'next/server'

import { mobileJson, mobileOptions } from '@/server/mobile-cors'
import { mobileErrorJson } from '@/server/mobile-errors'
import { requireMobileAuth } from '@/server/mobile-auth'
import { getMobileConversationDetail } from '@/server/mobile-service'

interface RouteContext {
  params: Promise<{ id: string }>
}

export const OPTIONS = mobileOptions

export async function GET(req: NextRequest, ctx: RouteContext) {
  const authError = await requireMobileAuth(req)
  if (authError) return authError

  const { id } = await ctx.params
  try {
    return mobileJson(req, await getMobileConversationDetail(id))
  } catch (err) {
    return mobileErrorJson(req, err, 'conversation detail')
  }
}
