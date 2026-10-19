import type { NextRequest } from 'next/server'

import { mobileJson, mobileOptions } from '@/server/mobile-cors'
import { mobileUserErrorJson } from '@/server/mobile-errors'
import { requireMobileAuth } from '@/server/mobile-auth'
import { withdrawMobileMessage } from '@/server/mobile-service'

interface RouteContext {
  params: Promise<{ id: string; messageId: string }>
}

export const OPTIONS = mobileOptions

export async function POST(req: NextRequest, ctx: RouteContext) {
  const authError = await requireMobileAuth(req)
  if (authError) return authError

  const { id, messageId } = await ctx.params
  try {
    const result = await withdrawMobileMessage({ conversationId: id, messageId })
    return mobileJson(req, result, { status: 200 })
  } catch (err) {
    return mobileUserErrorJson(req, err, 'mobile message action')
  }
}
