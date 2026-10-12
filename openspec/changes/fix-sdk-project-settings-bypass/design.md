# Design — SDK isolation and reduced project memory

## 1. Why isolation and project memory are the same decision

Verified against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (v0.3.170):

| Fact | Source |
|---|---|
| `Pass [] to disable filesystem settings (SDK isolation mode)`; **`Must include 'project' to load CLAUDE.md files`** | `:1870-1872` |
| No `contextFiles` / `claudeMd`-style `Options` field loads CLAUDE.md on its own (`claudeMd` applies only to the managed/policy tier) | full grep of `Options` |
| `strictMcpConfig`: use only servers passed in `mcpServers`; ignore project `.mcp.json`, user settings, plugins, and on-disk agent frontmatter | `:1917-1921` |
| Project settings **cannot** escalate `permissions.defaultMode` to `bypassPermissions` / `auto` / `acceptEdits` (the SDK already filters by trust tier) | `:639-647` |

The second row is the whole design constraint: in this SDK, "stop loading project settings" and "keep loading project `CLAUDE.md`" are the same switch. There is no option that drops `.claude/settings.json` while keeping the memory file. So the switch goes off, and AgentHub reads the memory file itself.

## 2. What is no longer loaded

`settingSources: []` excludes every **filesystem** settings source. Explicitly, none of the following reaches the SDK any more:

- `.claude/settings.json` and `.claude/settings.local.json` in the workspace — `permissions.allow` / `permissions.deny` / `permissions.ask`, `env`, `hooks`
- project hooks (the host-command-execution vector)
- workspace `.mcp.json` (belt and braces: `strictMcpConfig` closes it independently)
- plugins, skills, and custom slash commands from the workspace
- workspace `.claude/agents/` agent frontmatter

**Not** excluded: the managed / policy tier. Enterprise administrator settings are still read from disk, which is intended — an organisation's `deny` rules should keep applying.

## 3. Project memory: what is simplified

`src/server/adapters/project-memory.ts` reads `<effectiveCwd>/CLAUDE.md` only. Relative to what `settingSources: ['project']` used to load, these are **dropped**:

- parent-directory walk (a `CLAUDE.md` above the workspace)
- `CLAUDE.local.md`
- `.claude/rules/`
- `@import` directives

Cap: `MAX_PROJECT_MEMORY_CHARS = 50_000`, matching `src/server/fs-service.ts:29`'s `MAX_READ_CHARS` — the same kind of thing (file contents entering a context window), so it reuses the existing ruler rather than inventing a second one. Over the cap the text is truncated at the last line boundary and carries a visible marker, following the `[TRUNCATED …]` convention at `fs-service.ts:80`. The constant is **not imported** from `fs-service`: that module pulls in DB types, and the two numbers only happen to be equal.

Failure policy: absent / unreadable / a directory / blank after trim → `null`, never a throw. A run must not fail because a memory file is malformed. The isolation invariant comes from §2; the memory read is compensation.

The injected block carries a heading, the file's absolute path, and an explicit statement that this is **workspace content, not a user instruction**. The workspace is untrusted input; injecting its text without a label would just move the bypass somewhere less visible.

## 4. Module split

- `src/server/adapters/project-memory.ts` — `readProjectMemory(cwd, read = readFileIfPresent)` with an injectable reader (the five policy branches are then pure and unit-testable), and `composeSystemPrompt(agentPrompt, memory, memoryPath)`.
- `src/server/adapters/sdk-isolation.ts` — `sdkIsolationOptions()` returning `{ settingSources: [], strictMcpConfig: true }`. `Options` is a **type-only** import, so a test can import this module without booting the adapter (and therefore `@/db/client`).
- `claude-code-adapter.ts` — three lines: the `append` value, the `...sdkIsolationOptions()` spread in place of `settingSources: ['project']`, and two consts. The generator function and the `for await` loop are untouched.

A test that asserted the fully assembled `options` object would have to import the real adapter and would be both slow and brittle. `sdk-isolation.test.ts` pins the two security invariants instead; the definitive evidence is a live run (§5).

## 5. Verification: the evidence is a difference

Unit tests cannot prove this. "No approval card appeared" is ambiguous — it could also mean the gate is broken. So the check is a four-cell comparison, and the **difference between cells** is the proof:

| workspace `.claude/settings.json` | code | expected |
|---|---|---|
| absent | after the fix | Bash and `mcp__…` both prompt |
| present | after the fix | **identical to the previous cell** |
| present | before the fix | **neither prompts; both execute** |
| absent | before the fix | prompts |

Only cell 3 differs. That difference is what shows cell 2's prompt is AgentHub's gate winning against a file that demonstrably wins in cell 3.

Sentinel files, one per mechanism (`ls` is enough to read them):

- a `probe` server declared in `.mcp.json` is **not** in the run's MCP list, and `PROBE-SPAWNED` never appears → `strictMcpConfig` effective
- `HOOK-FIRED` never appears → project hooks did not run (a sentinel file is the only way to see this; the transcript cannot)
- **`mcp__agenthub__*` still works** (run a `write_artifact` and get an artifact card) → strict mode did not break the in-process bridge. This is the **highest-risk point** of the change and must be asserted explicitly, not inferred from "the run looked clean".
- the model can quote the workspace `CLAUDE.md` sentinel line but quotes **none** of the decoys in the parent directory, `.claude/rules/`, or `~/.claude/CLAUDE.md` → compensation works and its boundary is right
- approval semantics unchanged: approving a tool in one conversation keeps it silent there, and a new conversation prompts again

Environment note: the adapter routes through a relay (`buildClaudeSdkEnv`'s `ANTHROPIC_BASE_URL` branch), where the first `tool.call` can take ~11s. Assert on the approval card, **not** on a wall-clock timeout.

## 6. Rejected alternatives

- **Write-protect `.claude/`.** Bash can create the file without tripping the blacklist or the approval classifier, and in `local` mode the workspace is a real repository that may ship one. Not enforceable.
- **`allowManagedPermissionRulesOnly: true`.** Becomes the sole policy tier only when no real administrator policy exists, and fails open. Silent failure is worse than the current state.
- **Keep `['project']` and audit `.claude/settings.json` before each run.** Race-prone (the file can change mid-run, and bash can write it), and it still leaves hooks and `.mcp.json` untouched.
