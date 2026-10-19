import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { revokeDeviceSession } from '@/server/device-sessions'
import { rejectCrossOriginWrite } from '@/server/local-origin'

interface RouteContext {
  params: Promise<{ id: string }>
}

/** DELETE /api/settings/devices/:id —— 吊销一台设备（幂等）。 */
export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected

  const { id } = await ctx.params
  const revoked = await revokeDeviceSession(id)
  return NextResponse.json({ revoked })
}
