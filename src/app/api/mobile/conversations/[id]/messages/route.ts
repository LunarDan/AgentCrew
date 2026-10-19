import type { NextRequest } from 'next/server'
import { z } from 'zod'

import { mobileJson, mobileOptions } from '@/server/mobile-cors'
import { mobileErrorJson } from '@/server/mobile-errors'
import { requireMobileAuth } from '@/server/mobile-auth'
import { sendMobileMessage } from '@/server/mobile-service'
import { MAX_MESSAGE_CHARS } from '@/shared/constants'

interface RouteContext {
  params: Promise<{ id: string }>
}

const Body = z.object({
  // 与桌面端一致：纯空白不算内容，否则会落一条空消息并触发空回复 run。
  content: z.string().max(MAX_MESSAGE_CHARS).refine((value) => value.trim().length > 0, {
    message: 'content must not be blank',
  }),
})

export const OPTIONS = mobileOptions

export async function POST(req: NextRequest, ctx: RouteContext) {
  const authError = await requireMobileAuth(req)
  if (authError) return authError

  const raw = await req.json().catch(() => null)
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return mobileJson(req, { error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  const { id } = await ctx.params
  try {
    const result = await sendMobileMessage({
      conversationId: id,
      content: parsed.data.content,
    })
    return mobileJson(req, result, { status: 202 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 客户端可自行修正的输入错误仍回 400；其余（DB、内部不变量）只回通用 500。
    if (message.startsWith('Conversation not found')) {
      return mobileJson(req, { error: message }, { status: 400 })
    }
    return mobileErrorJson(req, err, 'send message')
  }
}
