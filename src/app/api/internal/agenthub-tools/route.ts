import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { db, schema } from '@/db/client'
import { verifyInternalToolToken } from '@/server/internal-tool-auth'
import { askUserTool } from '@/server/tools/ask-user'
import { deployArtifactTool } from '@/server/tools/deploy-artifact'
import { deployWorkspaceTool } from '@/server/tools/deploy-workspace'
import { fsListTool } from '@/server/tools/fs-list'
import { planTasksTool } from '@/server/tools/plan-tasks'
import { readArtifactTool } from '@/server/tools/read-artifact'
import { readAttachmentTool } from '@/server/tools/read-attachment'
import { reportTaskResultTool } from '@/server/tools/report-task-result'
import type { ToolContext } from '@/server/tools/types'
import { writeArtifactTool } from '@/server/tools/write-artifact'
import { getEffectiveCwd } from '@/server/workspace-utils'

export const runtime = 'nodejs'

/** 工具参数里可能带整份 artifact 内容；与 /api/artifacts/:id/versions 的上限对齐。 */
const MAX_INTERNAL_BODY_BYTES = 20 * 1024 * 1024

const EXPOSED_TOOLS = {
  write_artifact: writeArtifactTool,
  read_artifact: readArtifactTool,
  deploy_artifact: deployArtifactTool,
  deploy_workspace: deployWorkspaceTool,
  ask_user: askUserTool,
  report_task_result: reportTaskResultTool,
  fs_list: fsListTool,
  plan_tasks: planTasksTool,
  read_attachment: readAttachmentTool,
}

const BodySchema = z.object({
  toolName: z.string().min(1),
  args: z.unknown(),
  conversationId: z.string().min(1),
  agentId: z.string().min(1),
  runId: z.string().min(1),
})

export async function POST(req: Request) {
  if (!verifyInternalToolToken(req.headers.get('authorization'))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const contentLength = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_INTERNAL_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'Request body too large' }, { status: 413 })
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: `Invalid body: ${parsed.error.message}` }, { status: 400 })
  }

  const { toolName, args, conversationId, agentId, runId } = parsed.data
  const tool = EXPOSED_TOOLS[toolName as keyof typeof EXPOSED_TOOLS]
  if (!tool) {
    return NextResponse.json({ ok: false, error: `Tool is not exposed to Codex: ${toolName}` }, { status: 403 })
  }

  // token 是进程级的（所有 Codex 子进程共用），所以不能只看 body 里的三个 id：
  // 必须确认这个 run 确实属于该会话与该 agent，否则一个被诱导的 Codex 会话可以
  // 带着自己的 token 往别的会话写产物 / 以别人的 run 记账。
  const run = await db.query.agentRuns.findFirst({
    where: eq(schema.agentRuns.id, runId),
  })
  if (
    !run ||
    run.conversationId !== conversationId ||
    run.agentId !== agentId ||
    (run.status !== 'queued' && run.status !== 'running')
  ) {
    return NextResponse.json(
      { ok: false, error: 'Tool call does not belong to an active run of this conversation' },
      { status: 403 },
    )
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(schema.workspaces.conversationId, conversationId),
  })
  if (!workspace) {
    return NextResponse.json({ ok: false, error: `Workspace not found for conversation: ${conversationId}` }, { status: 404 })
  }

  const ctx: ToolContext = {
    conversationId,
    workspacePath: getEffectiveCwd(workspace),
    agentId,
    runId,
    abortSignal: req.signal,
  }

  try {
    return NextResponse.json(await tool.handler(args, ctx))
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
