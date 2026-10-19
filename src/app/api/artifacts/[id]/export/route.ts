import { exportArtifactResponse } from '@/server/artifact-export'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * GET /api/artifacts/:id/export —— 产物一键导出。
 * 具体分发逻辑见 `src/server/artifact-export.ts`（移动端复用同一实现）。
 */
export async function GET(req: Request, ctx: RouteContext) {
  const { id } = await ctx.params
  const exportMode = new URL(req.url).searchParams.get('mode')
  return exportArtifactResponse(id, exportMode)
}
