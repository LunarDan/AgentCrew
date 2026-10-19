import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { createConversation, listConversations } from '@/server/conversation-service'
import { rejectCrossOriginWrite } from '@/server/local-origin'
import { MAX_ID_CHARS, MAX_ID_LIST_LENGTH } from '@/shared/constants'

const CreateBody = z.object({
  title: z.string().max(100).optional(),
  mode: z.enum(['single', 'group']),
  agentIds: z.array(z.string().max(MAX_ID_CHARS)).min(1).max(MAX_ID_LIST_LENGTH),
  boundPath: z.string().max(4096).optional(),
})

export async function GET() {
  const conversations = await listConversations()
  return NextResponse.json({ conversations })
}

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const raw = await req.json().catch(() => null)
  const parsed = CreateBody.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const conversation = await createConversation(parsed.data)
    return NextResponse.json({ conversation }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
