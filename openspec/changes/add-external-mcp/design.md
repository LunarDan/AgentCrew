# Design — External MCP Servers (P0)

Companion to `specs/15-external-mcp.md`. Everything below was verified against the working tree; line numbers are current as of this change.

---

## 1. Layering

Per `CLAUDE.md §3.1`, adapters (L2) must not read the DB. So **all** DB reads, `enabled` filtering, and `${ENV_NAME}` expansion happen in L3, and adapters receive a plain, ready-to-use structure:

```
mcp_servers (DB, L1)
  → mcp-server-service.listResolvedForAgent()      (L3, pure DB read)
  → agent-runner.buildAdapterInput()               (L3, expand ${ENV}, filter enabled)
  → AdapterInput.mcpServers                        (the L2 boundary)
  → ClaudeCodeAdapter / CodexAdapter               (L2, translate to SDK config only)
```

`buildAdapterInput` is already `async` and already hits the DB (`getAppSettings()` at `agent-runner.ts:1981`), so this is an existing pattern, not a new one.

**Placeholder expansion runs at run start, never at write time.** `${ENV_NAME}` resolves from `process.env` when the run begins, so `.env.local` edits take effect without re-saving the server row, and no plaintext lands in the DB.

---

## 2. Data model

```ts
export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),                                  // newMcpServerId() → mcp_<12>
  name: text('name').notNull().unique(),                        // ^[a-z0-9_]+$, used in tool namespace
  transport: text('transport', { enum: ['stdio', 'sse', 'http'] }).notNull(),
  command: text('command'),                                     // stdio
  args: text('args', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  env: text('env', { mode: 'json' }).$type<Record<string, string>>(),
  url: text('url'),                                             // sse / http
  headers: text('headers', { mode: 'json' }).$type<Record<string, string>>(),
  trust: text('trust', { enum: ['always', 'ask'] }).notNull().default('ask'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
})
```

`agents` gains `mcp_server_ids text('mcp_server_ids', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`)`.

`enabled` defaults **false** — decision §11.1 ("默认不启用任何外部 MCP") requires opt-in twice: register *and* enable.

### Divergence D2 — `transport` gains `http` (decided: yes)

`specs/15-external-mcp.md §3` defines `transport: 'stdio' | 'sse'`. Verified against both SDKs:

| transport | Claude Code SDK | Codex CLI 0.149.1 |
|---|---|---|
| `stdio` | ✅ `McpStdioServerConfig { command, args, env }` | ✅ `command` + `args` + `--env` |
| `sse` | ✅ `McpSSEServerConfig { type: 'sse', url, headers }` | ❌ not supported |
| `http` | ✅ `McpHttpServerConfig { type: 'http', url, headers }` | ✅ `--url` (streamable HTTP) + `--bearer-token-env-var` |

`codex mcp add --help` offers exactly two shapes: `<COMMAND>...` (stdio) or `--url <URL>` ("URL for a streamable HTTP MCP server"). Codex has no SSE transport.

So a two-value enum either strands Codex on `stdio`, or silently mislabels an SSE server as Codex-compatible. **Decision: `http` is added**, and the adapter matrix is treated as a first-class, user-visible fact — a server's transport decides which adapters can use it, and the agent builder must only offer servers the agent's adapter can actually run.

The resulting support matrix, which the UI and specs must state:

| transport | Claude Code | Codex |
|---|---|---|
| `stdio` | ✅ | ✅ |
| `http` | ✅ | ✅ |
| `sse` | ✅ | ❌ |

`specs/15-external-mcp.md §3` needs its enum updated to match.

---

## 3. Adapter wiring

### Claude Code

`claude-code-adapter.ts:435` currently passes a single-entry map. It becomes the `agenthub` bridge plus one entry per resolved server:

```ts
mcpServers: { agenthub: agenthubMcpServer, ...externalMcpServers }
```

Translation is a straight field map (`stdio → { type:'stdio', command, args, env }`, `sse → { type:'sse', url, headers }`, `http → { type:'http', url, headers }`).

### Codex

`codex-adapter.ts:78-88` passes `config.mcp_servers.agenthub`. The Codex SDK's `config` is **untyped and free-form**: `CodexOptions.config?: CodexConfigObject`, which the SDK flattens into dotted `--config` overrides and serializes as TOML (`codex-sdk/dist/index.js:304-370`). So `mcp_servers.<name> = { command, args, env }` flattens to `mcp_servers.<name>.command="..."` etc. — exactly the Codex `config.toml` table shape, and the same mechanism the existing `agenthub` bridge already relies on.

Two constraints worth recording:

- `serializeConfigOverrides` **throws on `null`** and skips `undefined`. Optional `env`/`headers` must be omitted, never passed as `null`.
- AgentHub points `CODEX_HOME` at its own dataDir (`buildCodexChildProcessEnv`, `adapters/adapter-utils.ts:27-40`), so writing `config.mcp_servers` **does not touch the user's real `~/.codex/config.toml`** — consistent with the isolation requirement in `CLAUDE.md §5.4` and `openspec/specs/adapters/spec.md:86`.

Codex owns its own approval policy and sandbox, so for Codex the `trust` field is advisory only.

---

## 4. Divergence D1 — the `trust` gate does not exist, and `bridgePermission` defaults to allow (decided: option B)

`specs/15-external-mcp.md §11.2` fixes the `ask` granularity (per-tool-per-conversation) and `§10` schedules the gate itself for **P2**. That leaves P0 storing `trust: 'ask'` as the default with nothing enforcing it.

Verified: `bridgePermission` (`claude-code-adapter.ts:804-915`) handles path sandbox (1), Bash blacklist (2), fs_write approval (3), NotebookEdit (4), then:

```ts
// 5. 默认放行（Read / Grep / Glob / WebFetch / WebSearch / Task / TodoWrite / ...）
return allow()
```

An external MCP tool arrives as `mcp__<server>__<tool>` — it matches none of cases 1–4 and falls through to **step 5, `return allow()`**. So wiring external MCP into Claude Code *without* touching `bridgePermission` gives every external tool silent, ungated execution. Combined with decision §11.4 (no command whitelist) and §11.5 (plaintext-capable secrets in the DB), the practical P0 posture would be: a user registers a server, ticks a box, and arbitrary third-party code runs in every subsequent run with no prompt and no visible signal.

A stored-but-unenforced `trust: 'ask'` is worse than no field at all, because the Settings UI would imply a protection that is not there.

**Options:**

- **A — Spec-faithful.** Ship P0 exactly per §10: `trust` is stored, unenforced, and the UI states plainly that the approval gate lands in P2. Smallest change; the honesty burden sits entirely on UI copy and docs.
- **B — Pull a minimal Claude Code gate into P0 (recommended).** One branch inserted before step 5: if the name is `mcp__*` and not `mcp__agenthub__*`, then `trust: 'always'` → allow, `trust: 'ask'` → route through the existing pending-approval pattern (`waitForBashApproval` / `pendingWrites` are both already per-conversation and AbortSignal-aware), remembering approvals per tool per conversation per decision §11.2. This is what makes §11.2 real rather than aspirational, and it is the difference between a safe feature and a silent arbitrary-code-execution one. Cost: a new pending-approval type + one frontend approval card + the remember-set. P2 then shrinks to "Codex/custom gate + OAuth + pooling".

**Decision: option B.** A bounded Claude Code gate lands in P0. This is the one gap that cannot be fixed by documentation, and it is what makes decision §11.2 real rather than aspirational. P2 consequently shrinks to: the Codex/custom gate, OAuth, and connection pooling.

Implementation detail worth pinning down now, because it is the part with real state: the per-tool-per-conversation approval memory must be scoped to a conversation and must survive across runs within it (a user who approved `mcp__fs__read` on turn 1 should not be re-prompted on turn 2), while a *new* conversation must prompt again. It must not be persisted to the DB in P0 — in-memory, keyed by conversation id, is sufficient and matches how `pendingWrites` / pending bash approvals already work.

---

## 5. Divergence D3 — `buildChildProcessEnv` is not a whitelist (decided: reuse it anyway)

> **Decision (2026-10-09): reuse `buildChildProcessEnv`.** The consequence below is accepted, not overlooked. Because this is a security-constraint relaxation, the leak is a **documentation and UI obligation**, not something to leave implicit: registration must warn that the server can read AgentHub's own credentials, and `CLAUDE.md §5` / `specs/11-platform.md` must describe external MCP as full-environment inheritance rather than as whitelisted.

`specs/15-external-mcp.md §6.3` says the stdio child's `env` goes "走白名单(复用 `buildChildProcessEnv`)". The phrase "白名单" is wrong about what that function does — it is a full passthrough:

```ts
export function buildChildProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  ...
}
```
(`adapters/adapter-utils.ts:16-25`)

It forwards **the entire parent environment** — every variable, including `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `ARK_API_KEY`, and AgentHub's own `AGENTHUB_MOBILE_TOKEN` / `AGENTHUB_INTERNAL_TOOL_TOKEN`. Its only transform is `HOME ← USERPROFILE` on Windows.

That is the right default for the two existing callers, which spawn *first-party* processes (the Claude SDK, the Codex CLI). For a third-party MCP server — arbitrary code the user downloaded — it means that server can read every secret the application holds.

**Accepted consequence, and what it obliges us to do:**

- A registered stdio MCP server can read AgentHub's provider keys and internal tokens from its environment. The user's reasoning — a local single-user app, registering a server is equivalent to running it in your own terminal, consistent with the deliberate no-keychain stance of `CLAUDE.md §5.4` — is the basis for accepting this, and it is a defensible position. It is **not** the same as "env is whitelisted", so nothing may describe it that way.
- The registration confirmation (task 6.2) must therefore warn about **two** distinct powers, not one: the server runs outside the workspace sandbox and command blacklist, **and** it can read AgentHub's stored credentials from its environment.
- `specs/11-platform.md` and `CLAUDE.md §5` must record full-environment inheritance as the actual behaviour.
- `${ENV_NAME}` (decision §11.5) still earns its place: it keeps a server's *own* secret out of the database. It is no longer load-bearing for isolation, since isolation is not claimed.

If this is ever revisited, the narrow fix is a dedicated builder — baseline OS variables plus the server's declared values — but it must not land as a silent tightening, since it would break any server that currently relies on inheriting, say, `NODE_OPTIONS` or a proxy variable.

---

## 6. Divergence D4 — `killProcessTree` is not reusable yet

`specs/15-external-mcp.md §6.5` and `§7` both say to reuse `killProcessTree` "spec 11". It exists at `src/server/tools/bash.ts:87-110` but is **module-private** and referenced only inside that file.

Prerequisite: extract it to a shared module (`src/server/child-process.ts`), have `tools/bash.ts` import it, and have the MCP teardown use it. This is a pure move with no behavior change, and it is required by the spec rather than incidental cleanup — it should be its own commit so the move stays reviewable.

The Windows branch matters here: `taskkill /F /T /PID` is the only way to kill a process *tree*; `child.kill()` leaves grandchildren orphaned.

---

## 7. Secrets: masked read, merged write (new contract)

Decision §11.5 requires masked display and no plaintext from list APIs. Verified: **no masking helper exists anywhere in the codebase** — `GET /api/settings` returns keys verbatim by explicit design (`api/settings/route.ts:6`), and `GET /api/agents` returns plaintext `apiKey`. So this contract is net-new and must be built deliberately rather than copied.

Read path returns, per secret field, a preview plus a presence marker — never the value:

```
env:      { GITHUB_TOKEN: { masked: '••••abcd', set: true } }
headers:  { Authorization: { masked: '••••wxyz', set: true } }
```

Write path must **merge, not replace**, so an unchanged masked preview round-tripping through the edit form cannot overwrite the stored secret with its own mask:

- field omitted → leave stored value unchanged
- field present with a literal value → set it
- field present as `null` → clear it

Without the omitted-means-unchanged rule, saving an unrelated edit to a server would destroy its credentials. This is the single easiest thing to get wrong in this change.

---

## 8. Failure isolation

Per decision §6.4, one bad server must not sink a run:

- Resolution/expansion failure for a server → drop that server, emit a warning part, continue.
- Claude Code / Codex: the SDK owns connection lifecycle; a server that fails to start degrades to "its tools are absent", which is the correct behavior and needs no AgentHub code.
- `test connection` (Settings) runs connect + `listTools()` in an isolated probe with a timeout, so a broken server is diagnosed at registration time instead of mid-run.

---

## 9. Deferred (not in this change)

| Item | Why deferred |
|---|---|
| `custom` adapter MCP client (`Client` + `StdioClientTransport` / `SSEClientTransport`, `listTools`, loop routing, teardown) | Decision §11.3 — highest cost, most exposed to the bypassed sandbox |
| `ask` gate for **Codex** and **custom** | Owned by those runtimes / depends on the custom client |
| OAuth for remote servers | Decision §10 P2 |
| Connection pooling per conversation | Decision §10 P2 — P0 is per-run connect + teardown |
| Danger hints for stdio commands | Decision §11.4 chose "show everything + explicit trust" over a whitelist; a hint layer can come later |

**Scope caveat worth stating out loud:** P0 does not reach the `custom` adapter, so MCP is unavailable to DeepSeek / OpenAI-compatible / Volcano Ark agents. Verifying P0 end-to-end requires the Claude Code or Codex adapters (both CLIs are installed locally: `claude` 2.1.295, `codex` 0.149.1).
