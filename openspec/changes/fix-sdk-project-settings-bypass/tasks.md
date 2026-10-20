## 0. Decisions (resolved 2026-10-13)

- [x] 0.1 **A2 — isolate, then inject project memory ourselves**: `settingSources: []` plus AgentHub reading `<effectiveCwd>/CLAUDE.md` into `systemPrompt.append`. Forced by the SDK: dropping project settings and dropping project `CLAUDE.md` are the same switch (`design.md §1`).
- [x] 0.2 **Add `strictMcpConfig: true` in the same change.** Without it the CLI still reads the workspace `.mcp.json`, which is the same class of bypass through a different file (`design.md §2`).
- [x] 0.3 **No write-protection of `.claude/`.** Not enforceable — bash can create the file without tripping the blacklist or the approval classifier, and `local`-mode workspaces are real repositories (`proposal.md` → Why).
- [x] 0.4 **`allowManagedPermissionRulesOnly` rejected.** Fails open when no real administrator policy exists (`design.md §6`).

## 1. Spec (commit 1)

- [x] 1.1 `openspec/changes/fix-sdk-project-settings-bypass/` — proposal / design / tasks.
- [x] 1.2 Delta: `specs/tools/spec.md` — workspace files MUST NOT pre-approve tools, with the Bash pre-allow and workspace `.mcp.json` scenarios.
- [x] 1.3 Delta: `specs/external-mcp/spec.md` — a MODIFIED D1 requirement gaining the "workspace settings try to pre-approve an external tool" scenario.
- [x] 1.4 Delta: `specs/adapters/spec.md` — MODIFIED approval-bridge requirement (isolation premise) + ADDED project-memory requirement.
- [x] 1.5 Delta: `specs/platform-security/spec.md` — ADDED requirement that SDK children start with no filesystem settings sources.
- [x] 1.6 Fold the same four deltas into `openspec/specs/`.

## 2. Docs (commit 2)

- [x] 2.1 `specs/05-adapter-interface.md:348` — the line already reads `[]`; add `strictMcpConfig`, widen the comment to both vectors, show the composed `append`; `:376-389` — state that the `canUseTool` bridge only holds under isolation.
- [x] 2.2 `specs/05-adapter-interface.md` — move Skills / Plugins from "deferred" to "deliberately not loaded"; add a project-memory subsection (path, cap, marker, not-loaded list).
- [x] 2.3 `specs/05-adapter-interface.md:497,511`, `specs/07-tools.md:505,542` — each approval clause gains the isolation premise.
- [x] 2.4 `specs/15-external-mcp.md:5,:166-175,:206` — status header, the P2 table row the table was missing, and `:206`'s "known limitation" rewritten as fixed **with the original text kept and a dated line appended**, recording why the fix is "drop the settings sources" rather than "write-protect `.claude/`".
- [x] 2.5 `specs/11-platform.md` — a new section after `:186`: SDK children load no project settings; the single exception is the `<effectiveCwd>/CLAUDE.md` AgentHub reads itself.
- [x] 2.6 `CLAUDE.md §5.5` — an isolation bullet (the section already requires discussion before change **and** syncing `specs/15` / `specs/11`); sync the `specs/15` index line at `:313`.
- [x] 2.7 `README.md:388` — replace the bypass note with the honest new limitation (reduced project memory). `README.zh-CN.md:362-368` — the Chinese version never carried that note, so only the new entry is added. **The asymmetry is deliberate**: the two files were already out of sync, and this is recorded here so a reviewer does not go looking for a mirror deletion that does not exist.
- [x] 2.8 `OVERVIEW.md:63-64,190,203,208` — feature matrix, key conventions, the 待办 entry, footer.
- [x] 2.9 `openspec/changes/add-external-mcp/tasks.md:97` — **do not edit item 9.11**. Append a dated follow-up blockquote pointing at this change directory, following the existing precedent at `:99`.

## 3. Implementation (commit 3)

- [x] 3.1 Add `src/server/adapters/project-memory.ts` — `PROJECT_MEMORY_FILENAME`, `MAX_PROJECT_MEMORY_CHARS`, `readProjectMemory(cwd, read = readFileIfPresent)`, `composeSystemPrompt(agentPrompt, memory, memoryPath)`.
- [x] 3.2 Add `src/server/adapters/project-memory.test.ts` — 5 stub branches (including the `<cwd>/CLAUDE.md` path contract), 3 real-fs cases via `mkdtempSync` (present / absent / a directory), 3 `composeSystemPrompt` cases. The most valuable assertion is **"no memory ⇒ the agent prompt is returned unchanged"**: that is today's behaviour and it is the regression guard.
- [x] 3.3 Add `src/server/adapters/sdk-isolation.ts` — `sdkIsolationOptions()` with a **type-only** `Options` import, so the test never boots `@/db/client`.
- [x] 3.4 Add `src/server/adapters/sdk-isolation.test.ts` — two assertions pinning the security invariants.
- [x] 3.5 `claude-code-adapter.ts` — `append: input.systemPrompt` → `append: systemPromptAppend`; `settingSources: ['project']` → `...sdkIsolationOptions()`; two consts near `:432`. **The generator and the `for await` loop are not touched.**
- [x] 3.6 `pnpm typecheck`, `pnpm lint`, `pnpm test`.

## 4. Live verification (asks first — see the note)

> **Scope actually run (2026-10-13): the two post-fix cells only.** The pre-fix control cells (3 and 4 of `design.md §5`) were deliberately skipped, so the cells below establish that the isolation is *in effect*; they do not on their own show the gate beating a file that would have won before. Where a cell carries its own two-sided discriminator, that is called out.

- [x] 4.1 Two post-fix cells from `design.md §5` — one workspace without `.claude/settings.json`, one with.
  - Real app on Windows, `claude-sonnet-4-6` via relay, conversation `conv_cfkLHn3qF8YI`.
  - **The vector probed is `permissions.allow`, and it was probed with `Write`, not `Bash`.** The substitution is forced by finding F3 below: this host's shell tool is not named `Bash`, so a Bash cell cannot produce a card in *either* configuration and would have returned "identical" for the wrong reason.
  - Cell A (no settings file): `pendingWrites` registered after 14.5s at `<workspace>\probe-write.txt`; rejected (`200`); `fileWritten: false`.
  - Cell B (settings present, `permissions.allow: ['Bash','PowerShell','Write','Edit']`): card after 13.3s at the same path; rejected; `fileWritten: false`.
  - The two cells are **identical** — the comparison the plan asks for. The cell also carries its own reverse control, which is why it reads without the skipped control cells: had the settings file been honoured, the CLI would have pre-approved `Write` and the cell would read *no card* + `fileWritten: true`. It read the opposite.
- [x] 4.2 Sentinel files.
  - `.mcp.json` declared a `probe` server whose `args` write `agenthub-probe-PROBE-SPAWNED` into `os.tmpdir()`: **never written** (`probeSpawned: false`), checked after both the write run and the shell run, cell B. `strictMcpConfig` holds.
  - The settings file declared a `PreToolUse` hook writing `agenthub-probe-HOOK-FIRED`: **never written** (`hookFired: false`).
  - **Honest limit**: these are one-sided checks. The skipped pre-fix cells were the control that would have shown the sentinels *can* fire, so "absent" here rests on the SDK's documented `settingSources` semantics rather than on a demonstration. The hook matcher was widened to `'*'` and a `Write` call certainly happened, so the hook sentinel was not left unarmed for want of a match.
- [x] 4.3 `mcp__agenthub__*` still functional. **Highest-risk point of this change.**
  - `write_artifact` produced artifact `art_Zl8mN3IVIQlZ`, confirmed through `GET /api/artifacts` rather than from the model's text. The in-process bridge is not collateral damage of `strictMcpConfig: true`.
- [x] 4.4 Project memory compensation and its boundary.
  - A3 and B3 — with and without the settings file — returned *only* `` `SENTINEL-WORKSPACE-MEMORY-7731` `` plus the path `…\workspaces\conv_cfkLHn3qF8YI\CLAUDE.md`.
  - Both decoys absent: the parent-directory `CLAUDE.md` (`SENTINEL-PARENT-DECOY-4412`) and `.claude/rules/decoy.md` (`SENTINEL-RULES-DECOY-9903`).
- [ ] 4.5 Approval semantics unchanged (same conversation silent after approval, new conversation prompts).
  - **Not covered by this run.** 4.1–4.4 exercised the *reject* path only (register → card → reject → deny → the model reads the rejection and stops; it did not retry). The "approve ⇒ silent for the rest of the conversation, and a fresh conversation prompts again" half needs an approve path plus a third conversation, which is outside the two-cell scope this run was narrowed to. The approval path is visibly intact; this item guards its memory semantics.
  - **Update (2026-10-20)**: the memory semantics are now covered by `src/server/mcp-approvals.test.ts` — same conversation + same tool is silent after `rememberApproval`, a different conversation prompts again, and a different tool in the same conversation prompts again. Still not re-run live with a real SDK, so the item stays open.
- [x] 4.6 Record the results here in the format of `add-external-mcp/tasks.md §9`.

### Findings from the §4 live verification (2026-10-13)

**F3 — the Bash gate is unreachable on Windows, because the SDK's shell tool is not named `Bash` (pre-existing; not caused by this change; not fixed here).**

`bridgePermission` gates shell commands in exactly one place — `if (toolName === 'Bash')` at `claude-code-adapter.ts:882`, wrapping both `findBannedPattern` (`:884`) and `classifyBashApproval` (`:888`). Everything unmatched falls through to `:992`'s `return allow()`. On this host that branch is never entered:

- Two live runs (the retry at A2B and B2) sent `Remove-Item probe.sh -Force; node -e "…agenthub-probe-BASH-EXECUTED…"`. The marker file was created **both times** — the command really executed.
- No `pendingBashCommands` entry ever appeared: both cells waited the full 120s, and one of them had **no settings file at all**, so `permissions.allow` cannot explain it.
- Approval *was* required by AgentHub's own rules — the Windows classifier arm `/\bRemove-Item\b[\s\S]*-(?:Recurse|Force)\b/i` matches that command (checked against the real regex from `bash-command-approval.ts:38`), and `git clean -n` in the first attempt matches `/\bgit\s+(?:reset|clean)\b/i` at `:26`.
- The tool's own result string is `"(PowerShell completed with no output)"`, and the model reported that the tool offered to it is 不是名为 `Bash` 的工具.

⇒ The branch is skipped, so **neither the Windows command blacklist nor the command approval classifier is consulted for Claude Code agents on this host**, and every shell command reaches the default allow. This contradicts `specs/11-platform.md:130`, which states the ClaudeCodeAdapter path is covered by the blacklist "走同一份 `getBannedPatterns`" through `canUseTool`: that holds on POSIX (the tool there is `Bash`) and does not hold here. The CustomAgent path is unaffected — `src/server/tools/bash.ts:146,168` gates AgentHub's *own* tool, whose name AgentHub defines.

Not fixed here: it changes a security constraint (blacklist + approval gate), so CLAUDE.md §6.2 requires discussion first.

**The `git clean -n` first attempt was a symptom of F3, not a bad probe.** It executed ungated in a cell with no settings file and initially looked like the fix failing, so it was replaced by the marker-carrying command above. That replacement was still the right move — it makes "executed" unfakeable — but the earlier hypothesis (that the CLI pre-allows dry runs before consulting the callback) is now unnecessary: the tool name explains the same result without inventing a special allowlist. Grepping `sdk.mjs` for such a list had already found nothing; the tool table lives in the CLI binary inside `manifest.zst.json`, not in greppable JS.

> The live half starts a dev server and makes real model runs through the relay. The dev server was previously killed by the system under memory pressure, so **this step asks for a go-ahead before it runs** rather than starting on its own.
