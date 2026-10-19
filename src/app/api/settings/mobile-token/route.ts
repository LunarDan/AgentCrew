import { NextResponse, type NextRequest } from 'next/server'

import { rejectCrossOriginWrite } from '@/server/local-origin'
import { regenerateMobileDeviceToken } from '@/server/settings-service'

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const settings = await regenerateMobileDeviceToken()
  return NextResponse.json({ settings })
}
