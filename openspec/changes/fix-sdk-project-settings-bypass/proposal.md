# Isolate the Claude Code SDK from workspace project settings

## Why

`ClaudeCodeAdapter` starts the SDK with `settingSources: ['project']` (`src/server/adapters/claude-code-adapter.ts:449` — the only `query()` call site in the repository). That single option hands permission decisions to files inside the workspace:

- `.claude/settings.json` → `permissions.allow` is evaluated by the CLI **before** the `ask` path, so `canUseTool` (`bridgePermission`) is never consulted. What gets bypassed is the Bash approval gate (command blacklist + critical-command classification) and the external-MCP `trust = 'ask'` gate from `add-external-mcp` D1.
- Project **hooks** load from the same source, and a hook executes a command **on the host** — never through `canUseTool`, never through the command blacklist.
- With `strictMcpConfig` unset, the CLI also reads the workspace's `.mcp.json` (`sdk.d.ts:1917-1921`). One file in the workspace is enough to make the CLI spawn arbitrary MCP servers, outside AgentHub's `mcp_servers` registry and its approval gate.

Write-protecting `.claude/` is not a way out. Bash's cwd is the workspace root (`src/server/tools/bash.ts:156,204`), and `mkdir -p .claude && echo '{}' > .claude/settings.json` matches neither `src/server/security.ts`'s blacklist nor `src/server/bash-command-approval.ts`'s classifier. In `local` mode the workspace is the user's real repository, which may already contain that file. The fix has to land at the **SDK options** layer.

**This is code that diverged from spec, not a newly discovered hole.** `specs/05-adapter-interface.md:348` already specifies `settingSources: []`; the code says `['project']`. Both lines came from the initial commit, so there is no history to consult. Per `CLAUDE.md §9` this change moves the code back to the spec side, and writes down the premise the spec left implicit.

**Goal**: `canUseTool` becomes the single entry point for permission decisions. No file inside a workspace can pre-approve a tool on AgentHub's behalf.

## What Changes

- Start the SDK in isolation mode: `settingSources: []` plus `strictMcpConfig: true`, so no workspace-resident settings source is loaded and MCP servers come only from the adapter's own `mcpServers` map.
- Compensate for the one thing `'project'` was actually useful for — project memory — by having AgentHub read `<effectiveCwd>/CLAUDE.md` itself and fold it into `systemPrompt.append`, capped and labelled.
- State the isolation premise in every spec that describes the approval gate, so a future reader cannot re-introduce `settingSources: ['project']` without contradicting a written requirement.

Isolation is the security boundary. The CLAUDE.md injection is feature parity, **not** a boundary: if reading it fails, the run continues without it.

## Impact

- **Security posture**: closes the Bash approval bypass and the external-MCP `trust='ask'` bypass (D1), removes host command execution via project hooks, and cuts off the workspace `.mcp.json` MCP-spawn vector. Amends `CLAUDE.md §5.5`, `specs/15-external-mcp.md`, `specs/11-platform.md`.
- **Behaviour**: project memory is reduced to `<effectiveCwd>/CLAUDE.md` — no parent-directory walk, no `CLAUDE.local.md`, no `.claude/rules/`, no `@import`. Recorded in `specs/05-adapter-interface.md` and the READMEs.
- **Adapter interface**: unchanged. `AdapterInput` is untouched; only the `Options` object the Claude Code adapter builds changes.
- **No new dependency**, no schema change, no new StreamEvent.
- **Not covered**: the Codex adapter, which runs its own sandbox with an isolated `CODEX_HOME` and is not on this threat surface. `allowManagedPermissionRulesOnly` was considered and rejected — it only becomes the effective policy tier when there is no real administrator policy, and it fails open (`sdk.d.ts:4911`, `:1842-1850`).
