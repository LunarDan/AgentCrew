import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { rejectCrossOriginWrite } from '@/server/local-origin'
import { createMcpServer, listMcpServers, toMcpServerView } from '@/server/mcp-server-service'
import { MAX_API_KEY_CHARS, MAX_URL_CHARS } from '@/shared/constants'

export async function GET() {
  const servers = await listMcpServers()
  return NextResponse.json({ servers: servers.map(toMcpServerView) })
}

const TransportEnum = z.enum(['stdio', 'sse', 'http'])

/** env / headers 是用户自填的键值表；限制条目与取值长度，避免把任意大对象塞进 DB。 */
const MAX_MCP_ENV_ENTRIES = 100
const EnvRecord = z
  .record(z.string().max(256), z.string().max(MAX_API_KEY_CHARS))
  .refine((value) => Object.keys(value).length <= MAX_MCP_ENV_ENTRIES, {
    message: `Too many entries (max ${MAX_MCP_ENV_ENTRIES})`,
  })

const CreateBody = z.object({
  name: z.string().min(1).max(64),
  transport: TransportEnum,
  command: z.string().max(MAX_URL_CHARS).optional(),
  args: z.array(z.string().max(MAX_URL_CHARS)).max(100).optional(),
  env: EnvRecord.nullish(),
  url: z.string().max(MAX_URL_CHARS).optional(),
  headers: EnvRecord.nullish(),
  trust: z.enum(['always', 'ask']).optional(),
  enabled: z.boolean().optional(),
})

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOriginWrite(req)
  if (rejected) return rejected
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
