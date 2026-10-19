import type { NextRequest } from 'next/server'

import { exportArtifactResponse } from '@/server/artifact-export'
import { requireMobileAuth } from '@/server/mobile-auth'
import { mobileCorsHeaders, mobileOptions } from '@/server/mobile-cors'
import { mobileErrorJson } from '@/server/mobile-errors'

interface RouteContext {
  params: Promise<{ id: string }>
}

export const OPTIONS = mobileOptions

export async function GET(req: NextRequest, ctx: RouteContext) {
  const authError = await requireMobileAuth(req)
  if (authError) return authError

  const { id } = await ctx.params
  try {
    const res = await exportArtifactResponse(id, req.nextUrl.searchParams.get('mode'))
    for (const [name, value] of mobileCorsHeaders(req)) res.headers.set(name, value)
    return res
  } catch (err) {
    return mobileErrorJson(req, err, 'export artifact')
  }
}
