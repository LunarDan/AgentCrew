import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { rejectCrossOriginWrite } from '@/server/local-origin'
import { getAppSettings, updateAppSettings } from '@/server/settings-service'
import { MAX_API_KEY_CHARS, MAX_URL_CHARS } from '@/shared/constants'

/** GET /api/settings —— 返回全局设置（key 字段会原样返回；用户已自行选择填明文） */
export async function GET() {
  const settings = await getAppSettings()
  return NextResponse.json({ settings })
}

const PatchBody = z.object({
  // 显式 null 表示清空；undefined 表示不改
  anthropicApiKey: z.string().max(MAX_API_KEY_CHARS).nullable().optional(),
  anthropicBaseUrl: z.string().max(MAX_URL_CHARS).nullable().optional(),
  openaiApiKey: z.string().max(MAX_API_KEY_CHARS).nullable().optional(),
  deepseekApiKey: z.string().max(MAX_API_KEY_CHARS).nullable().optional(),
  arkApiKey: z.string().max(MAX_API_KEY_CHARS).nullable().optional(),
  companionMode: z.enum(['off', 'lan', 'tailnet']).optional(),
  // 这个 token 是局域网唯一的凭据；拒绝过短的值，避免手填出「1」这类可猜 token。
  mobileDeviceToken: z.string().min(16).max(256).nullable().optional(),
  deploymentPublishEnabled: z.boolean().optional(),
  deploymentPublishDir: z.string().max(4096).nullable().optional(),
  deploymentPublicBaseUrl: z.string().max(MAX_URL_CHARS).nullable().optional(),
})

/** PATCH /api/settings —— upsert 部分字段 */
export async function PATCH(req: NextRequest) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const raw = await req.json().catch(() => null)
  const parsed = PatchBody.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', issues: parsed.error.issues },
      { status: 400 },
    )
  }
  const settings = await updateAppSettings(parsed.data)
  return NextResponse.json({ settings })
}
