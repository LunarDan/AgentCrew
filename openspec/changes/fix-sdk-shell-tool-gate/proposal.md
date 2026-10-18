# Gate the SDK shell tool by identity, not by the literal name `Bash`

## Why

`bridgePermission` gates shell commands in exactly one place: `if (toolName === 'Bash')` (`src/server/adapters/claude-code-adapter.ts:882`). Both the command blacklist (`findBannedPattern`, `:884`) and the critical-command classifier (`classifyBashApproval`, `:888`) live inside that branch. Every tool that does not match falls through to `:992` — `return allow()`.

On a Windows host the SDK's shell tool is **not named `Bash`**, so the branch is never entered and both gates are skipped for every command. Observed live on 2026-10-13 against the app's own adapter (`claude-sonnet-4-6` via relay):

- A command containing `Remove-Item probe.sh -Force; node -e "…writeFileSync(…'agenthub-probe-BASH-EXECUTED'…)"` was executed — the marker file appeared — in a workspace with **no** `.claude/settings.json`, so `permissions.allow` cannot explain it.
- No `pendingBashCommands` entry ever appeared (two runs, each waiting the full 120s).
- AgentHub's own Windows classifier arm for `Remove-Item … -Force` **does** match that command (checked against the real regex), so had the branch been entered a card would have been required.
- The tool's own result string is `"(PowerShell completed with no output)"`, and the model reported that the tool offered to it is not named `Bash`.

**This is not related to the `settingSources` change.** That change closed the path by which workspace files pre-approve tools; this one means the gate itself is unreachable on this platform. The two defects have different mechanisms, and the second survives any settings isolation.

It also contradicts the written contract. `specs/11-platform.md:130` states that `ClaudeCodeAdapter`'s blacklist "走同一份 `getBannedPatterns`" through `canUseTool`, and `specs/07-tools.md:505` says the blacklist "仍由 AgentHub 接管". Both are true on POSIX, where the tool is `Bash`, and false here. AgentHub's own `bash` tool (`src/server/tools/bash.ts:146,168`) is unaffected — it gates a tool whose name AgentHub defines itself.

**Goal**: no shell tool call, on any platform and under any SDK tool name, can reach the default-allow branch without passing the blacklist and the approval classifier.

## What Changes

- Capture the SDK's tool table from the `system:init` message (`sdk.d.ts:3981-3988` carries `tools: string[]`; the adapter already has a `m.type === 'system'` branch at `claude-code-adapter.ts:473` that can read it).
- Decide "is this a shell call?" from three signals instead of one literal: a known shell-name set (`Bash`, `PowerShell`, …), membership in the run's actual tool table, and the presence of a non-empty `command` string. External `mcp__*` tools are excluded because they have their own gate at step 5.
- Fail closed: if a known shell tool arrives with an input AgentHub cannot parse, deny rather than allow. Record the check that confirms the input field name.
- Correct the platform claim in `specs/11-platform.md:130` and make the `specs/07-tools.md:505` clause state the assumption it relies on.

## Impact

- **Security posture**: restores the command blacklist and the critical-command approval gate for Claude Code agents on Windows. This is the only shell gate on that path.
- **Behaviour**: shell calls that previously reached default allow now pass the blacklist and classifier. Commands the classifier does not flag behave exactly as before; the flagged classes are the ones already listed in `bash-command-approval.ts`.
- **Adapter interface**: unchanged. `AdapterInput` and `StreamEvent` are untouched; only the `canUseTool` closure's inputs change.
- **No new dependency**, no schema change, no new StreamEvent.
- **Not covered**: the Codex adapter (its own approval model and sandbox), and AgentHub's own `bash` tool (already gated).
- **Open facts to confirm during implementation**: whether the PowerShell tool's input field is `command` (the evidence says the command executed through AgentHub's existing shape, and AgentHub's own tools use `command`), and whether the presence of Git Bash changes the SDK tool name back to `Bash`. The candidate set covers both, and the shape rule covers a future rename.
