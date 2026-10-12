## 0. Decisions (resolved 2026-10-09)

- [x] 0.1 D1 — **option B**: a minimal Claude Code `ask` gate lands in P0 (per-tool-per-conversation approval memory, in-memory). See `design.md §4`.
- [x] 0.2 D2 — **approved**: `transport` gains `http`. Matrix: `stdio` both adapters, `http` both adapters, `sse` Claude Code only. Update the enum in `specs/15-external-mcp.md §3`. See `design.md §2`.
- [x] 0.3 D3 — **reuse `buildChildProcessEnv`**, i.e. third-party stdio MCP children inherit the full parent environment including AgentHub's provider keys and internal tokens. Accepted knowingly; obliges stronger registration warnings and documentation that never calls it a whitelist. See `design.md §5`.
- [x] 0.4 D4 — approved: extract `killProcessTree` from `src/server/tools/bash.ts:87` into a shared module as its own commit. See `design.md §6`.

## 1. Data model

- [x] 1.1 Add the `mcpServers` table to `src/db/schema.ts` (shape in `design.md §2`), plus `McpServerRow` / `McpServerInsert` exports.
- [x] 1.2 Add `agents.mcp_server_ids` to `src/db/schema.ts` (`json string[]`, notNull, default `'[]'`).
- [x] 1.3 Add `newMcpServerId = () => \`mcp_${nano()}\`` to `src/server/ids.ts`.
- [x] 1.4 Mirror both changes into `src/db/bootstrap.ts`: a `CREATE TABLE IF NOT EXISTS mcp_servers` block in `DDL`, and a `safeAlter` for `mcp_server_ids` on existing DBs. (Packaged-desktop contract, `specs/12-desktop-electron.md:248`.)
- [x] 1.5 Add `src/db/migrate-add-mcp-servers.ts` following the `migrate-add-app-settings.ts` (table) + `migrate-add-bookmarks.ts` (column) idempotent patterns.
- [ ] 1.6 Run `pnpm db:push` and confirm `scripts/ensure-node-sqlite.mjs` / Electron ABI wrapper is used.
  - Not run, and **not runnable on this database independently of this change**. Probing with a consistent snapshot (`VACUUM INTO`) on plain node: drizzle-kit wants to rebuild `app_settings` (column-order / NOT NULL representation drift) and `mcp_servers` (table-level `UNIQUE` vs its own separate unique index — equivalent, but it reads as a diff), emits some `CREATE INDEX` statements twice, then dies with `SqliteError: index idx_conv_updated already exists`. Running `push --force` against the real DB would rebuild tables and then fail mid-way, leaving a half-migrated database, so it was deliberately not run. The schema was applied instead by `src/db/bootstrap.ts` (runtime DDL + `safeAlter`) and `src/db/migrate-add-mcp-servers.ts` — which is the packaged-desktop contract anyway (`specs/12`). Verified against the live DB: `mcp_servers` exists with all columns and `agents.mcp_server_ids TEXT NOT NULL DEFAULT '[]'`. Recorded in `specs/08-db-schema.md` → 迁移规范.

## 2. Server-side service

- [x] 2.1 Add `src/server/mcp-server-service.ts`: `listMcpServers`, `getMcpServer`, `createMcpServer`, `updateMcpServer`, `deleteMcpServer`, following the multi-row CRUD shape of `agent-service.ts` (not the `app_settings` singleton).
- [x] 2.2 Validate on create/update: `name` matches `^[a-z0-9_]+$` and is unique; `command` required for `stdio`; `url` required for `sse`/`http`; `command`/`url` mutually exclusive.
- [x] 2.3 Add `expandEnvPlaceholders(values, processEnv)` resolving `${NAME}` in `env` / `headers` at run start; decide and test the unresolved-name behavior (recommend: throw with the variable name, so a broken server is diagnosed at run start rather than spawning with a missing secret).
- [x] 2.4 Add `resolveMcpServersForAgent(agent)`: intersect `agent.mcpServerIds` with `enabled = true`, expand placeholders, return the plain transport-neutral structure adapters consume.
- [x] 2.5 Add `testMcpServerConnection` — connect + `listTools()` + close, with a timeout, reusing `@modelcontextprotocol/sdk` transports (already a dependency).
- [x] 2.6 Add focused tests for name/transport validation, placeholder expansion, and the `mcpServerIds` ∩ `enabled` resolution.

## 3. API routes

- [x] 3.1 Add `src/app/api/mcp-servers/route.ts` (`GET` list, `POST` create) and `[id]/route.ts` (`PATCH`, `DELETE`), with zod bodies and `await ctx.params` per Next 16.
- [x] 3.2 Add `src/app/api/mcp-servers/[id]/test/route.ts` for the connection probe.
- [x] 3.3 Implement the masked read contract: list/detail return secret previews + presence markers, never plaintext (`design.md §7`).
- [x] 3.4 Implement the merged write contract: omitted = unchanged, literal = set, `null` = clear. Add a test that a round-tripped masked preview does **not** overwrite the stored secret.
- [x] 3.5 Extend `POST /api/agents` and the `.strict()` `PATCH /api/agents/[id]` bodies with `mcpServerIds: z.array(z.string())` — **both**, or edit silently 400s.
- [x] 3.6 Add a test asserting a Codex/Claude Code agent retains non-empty `mcpServerIds` (the SDK-adapter branch zeroes `toolNames`; `mcpServerIds` must **not** be zeroed).

## 4. Agent service + adapter input

- [x] 4.1 Thread `mcpServerIds` through `agent-service.ts` (`CreateAgentArgs`, row literal, `UpdateAgentPatch`) and `agent-draft-schema.ts`. (`agent-draft-schema.ts` was deliberately NOT changed — the AI-draft path has no MCP concept, and the DB default `[]` applies.)
- [x] 4.2 Add `mcpServers` to `AdapterInput` in `src/server/adapters/types.ts`.
- [x] 4.3 Resolve and attach `mcpServers` in `agent-runner.ts buildAdapterInput`; log/downgrade a resolution failure for one server without failing the run (`design.md §8`).

## 5. Adapter wiring

- [x] 5.1 `claude-code-adapter.ts`: spread resolved servers into the `mcpServers` map next to `agenthub`, mapping each transport to the SDK config shape.
- [x] 5.2 `codex-adapter.ts`: add each resolved `stdio`/`http` server to `config.mcp_servers`; **omit** absent optional fields (`null` throws in the SDK's TOML serializer).
- [x] 5.3 Reject or clearly warn on a server whose transport the agent's adapter cannot run (`sse` on Codex), rather than passing it through.
- [x] 5.4 Verify that external MCP tool calls reach `canUseTool` (`mcp__*` names) under `permissionMode: 'default'`. Verified **statically**: the Claude Agent SDK implements `canUseTool` by launching the CLI with `--permission-prompt-tool stdio` (confirmed at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, around offset 305885), so every non-pre-allowed tool decision routes to the callback. End-to-end confirmation is still pending (see §9).
- [x] 5.5 Add `src/server/mcp-approvals.ts`: in-memory per-conversation memory of approved `mcp__<server>__<tool>` names, not persisted. Document that a dev-server restart or HMR clears it, which only causes a re-prompt.
- [x] 5.6 Add the external-MCP branch to `bridgePermission` **before** the default `allow()`: allow if the server's `trust = 'always'` or the tool is already approved in this conversation; otherwise request approval and remember an approval.
- [x] 5.7 Add a pending-approval type + frontend approval card for MCP tool calls, reusing the existing pending-approval plumbing, with the tool name and server name visible.

## 6. Settings UI

- [x] 6.1 Add a fourth `TabsTrigger` / `TabsContent` to `src/components/settings-dialog.tsx` hosting a self-contained MCP server manager (list state + CRUD), following the `MobileConnectionHints` pattern.
- [x] 6.2 Registration form shows the full `command` / `args` / `env` and requires an explicit "我信任此 server" confirmation. The warning MUST cover both powers: runs outside AgentHub's sandbox and command blacklist, **and** inherits the process environment so it can read stored credentials (D3).
- [x] 6.3 Masked secret display + "test connection" action with its result.
- [x] 6.4 Per-server `trust` display showing what it actually does, including where the level is not enforced (Codex, whose own runtime owns approval).
- [x] 6.5 Add the `src/lib/api.ts` client helpers (`fetchMcpServers`, `create/update/deleteMcpServer`, `testMcpServer`) typed against `McpServerRow`.

## 7. Agent builder UI

- [x] 7.1 Add the `mcpServerIds` multi-select to `create-agent-dialog.tsx`, **outside** the `adapterKind === 'custom'` branch (P0 targets Claude Code / Codex), and include it in all three payload builders.
- [x] 7.2 Only offer servers the agent's adapter can actually run.
- [x] 7.3 Show selected servers in `agent-info-popover.tsx` (needs a name lookup; decide local fetch vs. a small store slice).

## 8. Docs and contracts

- [x] 8.1 Sync `specs/15-external-mcp.md` status and any accepted divergences (D1–D4).
- [x] 8.2 Sync `specs/05-adapter-interface.md`, `07-tools.md`, `08-db-schema.md`, `09-frontend-architecture.md`, `10-agent-builder.md`, `11-platform.md`. (Also `specs/01-core-entities.md` — the `Agent` entity gains `mcpServerIds`, and `CLAUDE.md §3.2` requires entity-field changes to land there. `specs/04-artifacts.md` verified as needing no change.)
- [x] 8.3 Amend `CLAUDE.md §5` with the external-MCP trust model (security constraint — discussion required per §6.2).
- [x] 8.4 Update `OVERVIEW.md` and the README to state that external MCP is outside the sandbox guarantee.
- [x] 8.5 Fold the accepted deltas from `openspec/changes/add-external-mcp/specs/` into `openspec/specs/`.

## 9. Verification

- [x] 9.1 `pnpm typecheck` and `pnpm lint` clean.
- [x] 9.2 `pnpm test` green, including the new validation / expansion / masking tests. (31 files / 244 passed — `mcp-server-service.test.ts` plus `mcp-approvals.test.ts`, added to cover the gate's pure logic: namespace classification, `parseMcpToolName` edge cases, and per-conversation/per-tool approval memory.)
- [x] 9.3 End-to-end manual run: register a stdio MCP server, enable it, select it on a Claude Code agent, confirm its tools are namespaced `mcp__<server>__<tool>` and that `tool.call` / `tool.result` render in the UI.
  - API half: verified through the HTTP API against a real stdio server (`npx -y @modelcontextprotocol/server-filesystem`): create/enable/list/patch/delete, masked reads, merged writes, name validation, and `POST /:id/test` returning `ok: true` with 14 tool names.
  - Live half: verified with a real model run (claude-code adapter, `claude-sonnet-4-6` via relay) against a purpose-built local stdio server. `tool.call` carried `toolName: "mcp__mcpv__echo"`, and asking the model to enumerate its `mcp__` tools returned `mcp__agenthub__*` (8 bridge tools) plus exactly `mcp__mcpv__{add,boom,echo,slow}` — namespacing confirmed.
  - UI half: **partially confirmed, with a pre-existing defect below.** The approval panel renders correctly while pending (`请求调用外部工具`, `mcp__mcpv__add`, `server：mcpv`), and a real tool card renders live during the run. But the card **disappears as soon as the message's text part arrives**, and is absent after reload — root cause F1, which is not MCP-specific.
- [x] 9.3a (added) API-level verification of the register → connect → list → teardown path: a broken server returns `{ ok: false, error }` at HTTP 200 rather than a 500; probe teardown leaves no orphaned `server-filesystem` child process; non-ASCII paths round-trip through the JSON body; secrets are never returned in plaintext and a name-only `PATCH` preserves the stored secret.
- [x] 9.4 Confirm the existing `agenthub` bridge still works with external servers attached (no regression on `write_artifact` / `ask_user`).
  - Both paths verified in live runs with an external server attached: `mcp__agenthub__write_artifact` created artifact `art_jTeBfOb0f7MI` v1 (`artifact.create` fired), and `mcp__agenthub__ask_user` round-tripped a question → answer → the model echoed the chosen option. Neither `mcp__agenthub__*` call hit the external-tool approval gate, as intended by `isExternalMcpTool`.
- [x] 9.5 Confirm a disabled server and a deselected server are both absent from the run.
  - Verified by asking the model to enumerate its `mcp__` tools while three servers were in known states: disabled (`mcpv_off`), enabled-but-not-selected-on-the-agent (`mcpv_unused`), and enabled+selected-but-unspawnable (`mcpv_broken`). None of the three appeared in the model's tool list.
- [x] 9.6 Confirm abort tears down stdio children (no orphaned processes) on Windows.
  - Verified with a `slow` tool (120s) so the abort landed mid-execution. The child's own lifecycle log recorded `call slow` (proving the tool was really executing), the abort request was accepted, the child stopped logging within ~6s, and a process sweep found zero orphaned `mcp-verify` node processes. Note the timing trap: a fixed abort deadline is unreliable here because a relay-routed model can take ~11s to emit the first `tool.call` — the harness now aborts a fixed delay *after the approval*, not after the send.
- [~] 9.7 Confirm a deliberately broken server degrades to a warning without failing the run.
  - **The "run does not fail" half holds; the "warning" half does not.** With a server whose `command` does not exist on PATH, the run still ended `complete` and the broken server's tools were simply absent — no crash, no hang. But **no warning reaches the user**: `resolveMcpServersForAgent` only warns on *resolution* problems (unsupported transport, missing `command`/`url`, unresolved `${ENV}`); a nonexistent command passes resolution and fails later at SDK spawn time, which AgentHub does not surface anywhere. See finding F2.
- [x] 9.8 With `trust = 'ask'`: confirm the first call to an external tool prompts, an approval makes the same tool silent for the rest of that conversation, and a **new** conversation prompts again.
  - All three parts verified: new conversation → prompt appeared; approving it → the tool executed; a second call to the same tool in the same conversation → no prompt (`pendingLog: []`); a *new* conversation → prompt appeared again. Memory is per (conversation, tool) and in-memory only, as designed.
- [x] 9.9 With `trust = 'always'`: confirm the tool executes with no prompt.
  - Verified: with `trust='always'` the tool ran immediately and no pending call was ever registered. `trust` was restored to `ask` afterwards.
- [x] 9.10 Confirm a denied approval returns an error result to the model and the run continues.
  - Verified: rejecting produced `tool.result` with `isError: true` carrying the rejection text, the model received it, replied accordingly, and the run ended `complete`. The model did not retry.
- [ ] 9.11 Known limitation (deferred, not fixed): the Claude Code adapter starts the SDK with `settingSources: ['project']`, so a `.claude/settings.json` inside the workspace can pre-allow `mcp__*` via `permissions.allow` and `canUseTool` is never consulted. Mitigation (drop `settingSources`, or write-protect `.claude/`) is P2.

> **Fix found by 9.3a**: the connection probe's timeout was 15s, which is shorter than a cold `npx -y <pkg>` download — so the most common registration shape (an `npx`-based stdio server) reported a *false* "timed out" the first time. Raised to 60s and the error now names the phase (`while connecting` / `while listing tools`). See `specs/15-external-mcp.md §12`.

### Findings from the §9 live verification (2026-10-10)

**F1 — `part.start` index collision drops every `tool_use` part (pre-existing, not MCP-specific).**
The adapter keeps `nextPartIndex` counting **only its own `part.start` emissions**, while `tool.call` / `tool.result` are inserted into the *same* `parts` array by a separate writer that appends without advancing that counter:

- `src/server/agent-runner.ts:1688` — `parts[event.partIndex] = event.part` (assign by index)
- `src/server/agent-runner.ts:1705` — the `tool.call` handler `parts.push({ type: 'tool_use', … })`
- `src/stores/app-store.ts:680` — the client mirrors the same assignment

So for a message whose text arrives *after* the tool call, the sequence `tool.call` (pushes `tool_use` at index 0) → `part.start { partIndex: 0 }` (the model's text) **overwrites slot 0**, and the tool call is gone. Observed persisted shape for every MCP run: `["text", "tool_result"]`. `src/components/message-parts.tsx` folds each `tool_result` into its `tool_use` and **drops orphans**, so the tool card renders live while the run is in flight and then vanishes the moment the text part lands — exactly the 9.3 UI result, on both the live and the post-reload path.

This affects **every** tool call through the claude-code adapter (`mcp__agenthub__*` bridge calls included), not just external MCP tools. It is the same tool-call defect the user deferred earlier ("工具调用先别管"), so it is **not** being fixed as part of this change — recorded here because it is what makes 9.3's UI half only partially pass.

> **Follow-up (2026-10-12)**: fixed separately in `openspec/changes/fix-part-index-collision/`. The paragraph above is the record of what the 2026-10-10 verification observed and is left as written.

**F2 — an SDK-level MCP spawn failure is invisible (9.7 gap).**
`resolveMcpServersForAgent` warns only for resolution failures. A server that resolves but cannot be spawned (bad `command`) is dropped silently by the SDK, so the user sees a server that is enabled, selected, and simply not there — with nothing explaining why. Closing this means surfacing spawn failures at connect time (e.g. prompting for a probe when a run resolves a server that produced no tools), which is a behavior change, so it is left open rather than patched in this change.

> Both findings above are recorded, not fixed. Neither is a regression introduced by the external-MCP work.
>
> **A caveat on the live half**: the model runs above were performed with the claude-code adapter routed to `claude-sonnet-4-6` through a relay. Namespacing, gating, abort, and degradation behavior are AgentHub-side and unaffected, but the *model-controlled* parts (whether a given call is made at all, how the rejection is phrased back) were not exercised against Anthropic's own endpoint.
