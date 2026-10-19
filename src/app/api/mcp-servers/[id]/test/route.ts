import { NextRequest, NextResponse } from 'next/server'

import { rejectCrossOriginWrite } from '@/server/local-origin'
import { testMcpServerConnection } from '@/server/mcp-server-service'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * connect + listTools 探测。失败返回 200 + `{ ok: false, error }` —— 这是诊断结果，
 * 不是请求错误，客户端要展示原因而不是抛异常。
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
  const { id } = await ctx.params
  const result = await testMcpServerConnection(id)
  return NextResponse.json(result)
}
