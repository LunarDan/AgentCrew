import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { createMcpServer, listMcpServers, toMcpServerView } from '@/server/mcp-server-service'

export async function GET() {
  const servers = await listMcpServers()
  return NextResponse.json({ servers: servers.map(toMcpServerView) })
}

const TransportEnum = z.enum(['stdio', 'sse', 'http'])

const CreateBody = z.object({
  name: z.string().min(1).max(64),
  transport: TransportEnum,
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).nullish(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).nullish(),
  trust: z.enum(['always', 'ask']).optional(),
  enabled: z.boolean().optional(),
})

export async function POST(req: NextRequest) {
  const raw = await req.json().catch(() => null)
  const parsed = CreateBody.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const server = await createMcpServer(parsed.data)
    return NextResponse.json({ server: toMcpServerView(server) }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
