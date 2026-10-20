import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import {
  deploySelectedArtifact,
  handleDeployCommand,
  listDeployCandidates,
} from '@/server/deploy-command-service'
import { rejectCrossOriginWrite } from '@/server/local-origin'

interface RouteContext {
  params: Promise<{ id: string }>
}

const DeployBody = z.object({
  artifactId: z.string().min(1).optional(),
})

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params
  try {
    const candidates = await listDeployCandidates(id)
    return NextResponse.json({ candidates })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const { id } = await ctx.params
  // 畸形 JSON 不能被当成「空 body → 部署第一个候选」，那是用户没表达过的操作
  const raw = await req.json().catch(() => null)
  if (raw === null) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = DeployBody.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const result = parsed.data.artifactId
      ? await deploySelectedArtifact({
          conversationId: id,
          artifactId: parsed.data.artifactId,
        })
      : await handleDeployCommand({ conversationId: id })
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = message.startsWith('Conversation not found')
      ? 404
      : message.startsWith('Artifact not found')
        ? 404
        : 400
    if (status === 400) console.error('[deploy] command failed', err)
    return NextResponse.json({ error: message }, { status })
  }
}
