import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { rejectCrossOriginWrite } from '@/server/local-origin'
import { pendingQuestions, validateAskUserAnswers } from '@/server/pending-questions'

interface RouteContext {
  params: Promise<{ id: string; qid: string }>
}

const Body = z
  .object({
    answers: z.record(
      z.string(),
      z.object({
        selectedLabels: z.array(z.string().max(200)).max(8),
        freeformNote: z.string().max(4000).optional(),
      }),
    ),
  })
  .refine((body) => Object.keys(body.answers).length <= 4, {
    message: 'Too many answers',
  })

/** POST /api/conversations/:id/pending-questions/:qid  body { answers } —— 提交答案。 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const { id, qid } = await ctx.params
  const raw = await req.json().catch(() => null)
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const existing = pendingQuestions.get(qid)
  if (!existing || existing.conversationId !== id) {
    return NextResponse.json({ error: 'Pending question not found' }, { status: 404 })
  }
  const invalid = validateAskUserAnswers(existing, parsed.data.answers)
  if (invalid) {
    return NextResponse.json({ error: invalid }, { status: 400 })
  }

  const ok = pendingQuestions.answer(qid, parsed.data.answers)
  if (!ok) {
    return NextResponse.json({ error: 'Failed to record answer' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
