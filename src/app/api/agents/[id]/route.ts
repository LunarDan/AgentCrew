import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { deleteCustomAgent, updateCustomAgent } from '@/server/agent-service'
import { rejectCrossOriginWrite } from '@/server/local-origin'
import {
  MAX_API_KEY_CHARS,
  MAX_ID_CHARS,
  MAX_ID_LIST_LENGTH,
  MAX_SYSTEM_PROMPT_CHARS,
  MAX_URL_CHARS,
} from '@/shared/constants'

interface RouteContext {
  params: Promise<{ id: string }>
}

const PatchBody = z
  .object({
    name: z.string().min(1).max(64).optional(),
    avatar: z.string().max(8).optional(),
    description: z.string().min(1).max(280).optional(),
    capabilities: z.array(z.string().max(MAX_ID_CHARS)).max(MAX_ID_LIST_LENGTH).optional(),
    systemPrompt: z.string().min(1).max(MAX_SYSTEM_PROMPT_CHARS).optional(),
    adapterName: z.enum(['custom', 'claude-code', 'codex']).optional(),
    modelProvider: z
      .enum(['anthropic', 'openai', 'deepseek', 'volcano-ark', 'openai-compatible'])
      .optional(),
    modelId: z.union([z.string().min(1).max(MAX_ID_CHARS), z.null()]).optional(),
    toolNames: z.array(z.string().max(MAX_ID_CHARS)).max(MAX_ID_LIST_LENGTH).optional(),
    mcpServerIds: z.array(z.string().max(MAX_ID_CHARS)).max(MAX_ID_LIST_LENGTH).optional(),
    supportsVision: z.boolean().optional(),
    // null 表示清除，空字符串当 null 处理
    apiKey: z.union([z.string().max(MAX_API_KEY_CHARS), z.null()]).optional(),
    apiBaseUrl: z.union([z.string().max(MAX_URL_CHARS), z.null()]).optional(),
  })
  .strict()

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const { id } = await ctx.params
  const raw = await req.json().catch(() => null)
  const parsed = PatchBody.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const agent = await updateCustomAgent(id, parsed.data)
    return NextResponse.json({ agent })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = message.includes('not found') ? 404 : 400
    return NextResponse.json({ error: message }, { status })
  }
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const { id } = await ctx.params
  try {
    await deleteCustomAgent(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = message.includes('not found') ? 404 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
