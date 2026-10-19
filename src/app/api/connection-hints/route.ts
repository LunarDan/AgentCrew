import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { DEFAULT_COMPANION_PORT } from '@/server/companion-config'
import { getConnectionHints } from '@/server/network-hints'
import { getAppSettings } from '@/server/settings-service'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const settings = await getAppSettings()
  const localPort = url.port || process.env.PORT || '3000'
  const remotePort =
    settings.companionMode === 'off'
      ? localPort
      : String(DEFAULT_COMPANION_PORT)
  return NextResponse.json({
    hints: getConnectionHints({
      protocol: url.protocol,
      remotePort,
      localPort,
    }),
    companionMode: settings.companionMode,
    mobileDeviceTokenConfigured: !!settings.mobileDeviceToken,
    // Electron 主进程监听 0.0.0.0:companionPort 失败时写入；否则手机连不上而设置页仍展示地址。
    companionProxyError: process.env.AGENTHUB_COMPANION_PROXY_ERROR ?? null,
  })
}
