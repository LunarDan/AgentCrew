# Add External MCP Servers

## Why

AgentHub today only exposes its *own* tools to Claude Code and Codex, through adapter-owned MCP bridges (`agenthub`). Users cannot attach third-party MCP servers — the filesystem server, a database server, a browser server — so the value of choosing Claude Code or Codex over a plain chat model is capped at whatever AgentHub ships.

`specs/15-external-mcp.md` is the existing design proposal for this (P0 implemented 2026-10-09 and verified end-to-end 2026-10-10; see §12) and its decision record (§11) is settled. This change turned that proposal into a buildable, testable contract, scoped to its **P0**.

## What Changes

- Add a global `mcp_servers` table: register a server once, reuse it across agents.
- Add `agents.mcp_server_ids` so an agent opts into specific servers.
- Resolve enabled servers per run in `AgentRunner.buildAdapterInput` and pass them to adapters through `AdapterInput`.
- Wire resolved servers into `ClaudeCodeAdapter`'s SDK `mcpServers` map and `CodexAdapter`'s `config.mcp_servers`, alongside the existing `agenthub` bridge.
- Add MCP server management (add / edit / delete / enable / test connection) to the Settings dialog.
- Add a per-agent MCP server multi-select to the agent builder.
- Namespace external tools as `mcp__<serverName>__<toolName>` and reuse the existing `tool.call` / `tool.result` events — **no new StreamEvent**.
- Return masked secrets from MCP server read APIs; never plaintext.

Out of scope for this change (per decision §11.3): the `custom` adapter's MCP client layer, connection pooling, and OAuth. See `design.md` → *Deferred*.

## Impact

- **Schema**: one new table + one new agent column. Requires `pnpm db:push` *and* the `src/db/bootstrap.ts` DDL mirror (packaged-desktop contract, `specs/12-desktop-electron.md`).
- **Security posture**: external MCP servers run arbitrary code outside AgentHub's workspace sandbox and Bash blacklist. This change adds a new trust surface, so it also amends `CLAUDE.md §5` and `specs/11-platform.md`.
- **Adapter interface**: `AdapterInput` gains a field; three of four adapters ignore it.
- **No new runtime dependency** — `@modelcontextprotocol/sdk` is already installed (used by the `test connection` probe).
- **Not covered**: the `custom` adapter, which is the path every DeepSeek / OpenAI-compatible key uses. P0 is exercisable only through the Claude Code and Codex adapters.
