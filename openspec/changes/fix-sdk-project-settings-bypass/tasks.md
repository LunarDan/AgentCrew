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

- [ ] 4.1 Four-cell comparison from `design.md §5`; the evidence is that cells 1 and 2 are identical while cell 3 prompts for neither tool.
- [ ] 4.2 Sentinel files: `.mcp.json` `probe` absent and `PROBE-SPAWNED` never written; `HOOK-FIRED` never written.
- [ ] 4.3 `mcp__agenthub__*` still functional — a `write_artifact` that produces an artifact card. **Highest-risk point of this change.**
- [ ] 4.4 Project memory compensation: the workspace `CLAUDE.md` sentinel is quotable; the parent-directory / `.claude/rules/` / `~/.claude/CLAUDE.md` decoys are not.
- [ ] 4.5 Approval semantics unchanged (same conversation silent after approval, new conversation prompts).
- [ ] 4.6 Record the results here in the format of `add-external-mcp/tasks.md §9`.

> The live half starts a dev server and makes at least four real model runs through the relay. The dev server was previously killed by the system under memory pressure, so **this step asks for a go-ahead before it runs** rather than starting on its own.
