import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { ResolvedMcpServer } from '@/shared/types'

import { callMcpTool, closeMcpConnections, connectMcpServers } from './custom-mcp-client'
import { buildMcpToolTable } from './custom-mcp-tools'

/**
 * 用真实的 MCP SDK stdio server 子进程验证建连 / listTools / callTool / 清理。
 * fixture 放在仓库内（node_modules/.cache）而不是系统临时目录，否则 ESM 解析不到依赖。
 */
const fixtureRoot = createFixture()

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

function createFixture(): string {
  const cacheDir = path.join(process.cwd(), 'node_modules', '.cache')
  mkdirSync(cacheDir, { recursive: true })
  const root = mkdtempSync(path.join(cacheDir, 'agenthub-mcp-test-'))
  writeFileSync(path.join(root, 'echo-server.mjs'), fixtureSource())
  return root
}

function fixtureSource(): string {
  return `
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'agenthub-echo', version: '0.0.1' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the given text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: String(request.params.arguments?.text ?? '') }],
}))

await server.connect(new StdioServerTransport())
`
}

function echoServer(): ResolvedMcpServer {
  return {
    name: 'echo',
    trust: 'ask',
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(fixtureRoot, 'echo-server.mjs')],
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('connectMcpServers', () => {
  it('returns empty results without spawning anything when no server is selected', async () => {
    const controller = new AbortController()
    const result = await connectMcpServers([], {
      signal: controller.signal,
      workspacePath: process.cwd(),
    })

    expect(result).toEqual({ servers: [], unavailable: [] })
  })

  it(
    'connects, lists tools, calls a tool, and closes the child process',
    async () => {
      const controller = new AbortController()
      const server = echoServer()
      const result = await connectMcpServers([server], {
        signal: controller.signal,
        workspacePath: process.cwd(),
      })

      expect(result.unavailable).toEqual([])
      expect(result.servers).toHaveLength(1)

      const connection = result.servers[0]
      const pid = connection.pid
      expect(pid).toBeTypeOf('number')
      expect(connection.tools.map((t) => t.name)).toEqual(['echo'])

      const table = buildMcpToolTable({
        servers: [server],
        toolsByServer: new Map([['echo', connection.tools]]),
      })
      expect(table.tools[0].exposedName).toBe('mcp__echo__echo')

      try {
        const outcome = await callMcpTool(connection, 'echo', { text: 'hi' }, controller.signal)
        expect(outcome).toEqual({ ok: true, value: 'hi' })
      } finally {
        await closeMcpConnections(result.servers)
      }

      if (pid !== null) {
        await waitFor(() => !isAlive(pid), 5_000)
        expect(isAlive(pid)).toBe(false)
      }
    },
    20_000,
  )

  it(
    'reports a broken command as unavailable instead of throwing',
    async () => {
      const controller = new AbortController()
      const broken: ResolvedMcpServer = {
        name: 'broken',
        trust: 'ask',
        transport: 'stdio',
        command: path.join(fixtureRoot, 'definitely-missing-executable'),
        args: [],
      }

      const result = await connectMcpServers([broken], {
        signal: controller.signal,
        workspacePath: process.cwd(),
      })

      expect(result.servers).toEqual([])
      expect(result.unavailable).toEqual([{ name: 'broken', status: 'failed' }])
    },
    20_000,
  )
})
