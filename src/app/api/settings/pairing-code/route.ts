import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { rejectCrossOriginWrite } from '@/server/local-origin'
import { issuePairingCode, PAIRING_CODE_TTL_MS } from '@/server/pairing-codes'
import { getAppSettings } from '@/server/settings-service'

/** POST /api/settings/pairing-code —— 生成一次性配对码（仅桌面同源）。 */
export async function POST(req: NextRequest) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected

  const settings = await getAppSettings()
  if (settings.companionMode === 'off') {
    return NextResponse.json(
      { error: 'Enable companion mode before pairing a device' },
      { status: 409 },
    )
  }

  const { code, expiresAt } = issuePairingCode()
  return NextResponse.json({ code, expiresAt, expiresInSeconds: PAIRING_CODE_TTL_MS / 1000 })
}
