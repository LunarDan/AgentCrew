import { NextResponse } from 'next/server'

import { listDeviceSessions } from '@/server/device-sessions'

/** GET /api/settings/devices —— 已配对且未吊销的移动设备。 */
export async function GET() {
  return NextResponse.json({ devices: await listDeviceSessions() })
}
