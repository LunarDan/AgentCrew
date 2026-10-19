import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { createCustomAgent, listAgentsOrdered } from '@/server/agent-service'
import { rejectCrossOriginWrite } from '@/server/local-origin'
import {
  MAX_API_KEY_CHARS,
  MAX_ID_CHARS,
  MAX_ID_LIST_LENGTH,
  MAX_SYSTEM_PROMPT_CHARS,
  MAX_URL_CHARS,
} from '@/shared/constants'

export async function GET() {
  const agents = await listAgentsOrdered()
  return NextResponse.json({ agents })
}

const CreateBody = z
  .object({
    name: z.string().min(1).max(64),
    avatar: z.string().max(8).optional(),
    description: z.string().min(1).max(280),
    capabilities: z.array(z.string().max(MAX_ID_CHARS)).max(MAX_ID_LIST_LENGTH).default([]),
    systemPrompt: z.string().min(1).max(MAX_SYSTEM_PROMPT_CHARS),
    adapterName: z.enum(['custom', 'claude-code', 'codex']).default('custom'),
    modelProvider: z
      .enum(['anthropic', 'openai', 'deepseek', 'volcano-ark', 'openai-compatible'])
      .optional(),
    modelId: z.string().min(1).max(MAX_ID_CHARS).optional(),
    toolNames: z.array(z.string().max(MAX_ID_CHARS)).max(MAX_ID_LIST_LENGTH).default([]),
    mcpServerIds: z.array(z.string().max(MAX_ID_CHARS)).max(MAX_ID_LIST_LENGTH).default([]),
    supportsVision: z.boolean().optional(),
    apiKey: z.string().max(MAX_API_KEY_CHARS).optional(),
    apiBaseUrl: z.string().max(MAX_URL_CHARS).optional(),
  })
  .refine(
    (d) => d.adapterName !== 'custom' || (d.modelProvider && d.modelId),
    { message: 'Custom adapter requires modelProvider and modelId' },
  )

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const raw = await req.json().catch(() => null)
  const parsed = CreateBody.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const agent = await createCustomAgent({
      ...parsed.data,
      avatar: parsed.data.avatar ?? '',
    })
    return NextResponse.json({ agent }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
