# Design — identify the shell tool without hard-coding one platform's name

## 1. The defect, precisely

`bridgePermission` has six ordered steps. Step 2 is the only shell gate:

```
:869  PATH_TOOLS           → path sandbox
:882  if (toolName === 'Bash') { findBannedPattern; classifyBashApproval; return allow() }
:905  FS_WRITE_TOOLS       → pending-write approval
:959  NotebookEdit         → deny in Review mode
:966  isExternalMcpTool    → trust gate
:992  return allow()       ← everything else
```

Tool identity is the sole discriminator. On Windows the SDK exposes the shell under a different name, so step 2 is dead and step 6 allows. This is the same class of failure as `settingSources` — a security decision made by something the code assumed rather than checked — but it is a separate mechanism and needs a separate fix.

## 2. Options

| | Approach | Strength | Weakness |
|---|---|---|---|
| A | Add `PowerShell` to the name check | Smallest change; fixes today's host | Still an enumeration. The next SDK rename re-opens the hole silently. |
| B | Gate any tool whose input has a `command` string | Name-agnostic | Over-broad: an MCP tool with a `command` argument would be gated by the shell branch and skip its own `trust` gate unless explicitly excluded. |
| C | Read the run's actual tool table from `system:init` and identify the shell from it | No dependency on one literal; adapts to a rename | The init message only lists **names**; "which name is the shell" still needs a predicate. So C is not name-free — it is "known name **or** a shape match restricted to tools the SDK actually offered". |

**Chosen: C, with the name set retained as the pre-init fallback.** Honest statement of what that buys: before `system:init` is consumed, a known name is gated by name; after it, a renamed shell tool with a `command` string is still gated because the name appears in the run's own tool table. The shape rule is not used for tools that are absent from the table, and never for `mcp__*`.

## 3. The rule

```
isShellTool(toolName, toolInput, sdkToolNames):
  if toolName.startsWith('mcp__')            → false   // step 5 owns these
  if SHELL_TOOL_NAMES has toolName.lower()   → true    // Bash, PowerShell, pwsh, cmd, shell
  if sdkToolNames === null                   → hasCommandString(toolInput)   // fail closed
  if toolName not in sdkToolNames            → false
  return hasCommandString(toolInput)
```

`hasCommandString` accepts a non-empty `command`. On the chosen branch:

- an empty `command` on a **known shell name** → deny (`unrecognized shell tool input`), not allow. Fail closed. If the real field were named something else, the live verification in `tasks.md §5` would surface it immediately, and the rule would be corrected rather than silently bypassed.
- `classifyBashApproval` and `findBannedPattern` receive exactly what they receive today; this change does not add, remove, or reorder a single blacklist or classifier rule.

`SHELL_TOOL_NAMES` is a small exported set in the new module, not scattered literals. Case-insensitive because `toolName` casing is an SDK detail.

## 4. Where the tool table comes from

`SDKSystemMessage` with `subtype: 'init'` carries `tools: string[]` (`sdk.d.ts:3981-3988`). The adapter's loop already has:

```
:473  if (m.type === 'system') { … session_id …; continue }
```

That branch is the capture point: store `m.tools` in a mutable variable declared before `options`, and let the `canUseTool` closure read it. Ordering is safe — the SDK emits init before any assistant turn, so no tool call can arrive before the table is known. If a resume path ever changes that ordering, the name set and the fail-closed shape rule still apply.

This keeps the change inside `ClaudeCodeAdapter`; no new event, no persistence, no cross-run state.

## 5. Rejected alternatives

- **`disallowedTools: ['Bash', 'PowerShell']`** — removes the shell tool entirely. That is not a gate, it is an amputation.
- **Descend from `toolName` to the tool description** — `canUseTool` receives a name and input, not a description; the init message carries names only.
- **Move the MCP check before the shell check** — does not help; the failing call is not an MCP tool.
- **Patch only `specs/11-platform.md:130`** — documents the hole without closing it. Rejected as the whole fix; the doc change is part of this change, not a substitute.

## 6. Verification

Unit tests are necessary but not sufficient — the defect was invisible to the existing unit tests because none of them exercised a non-`Bash` shell name. The test table must include:

| case | expected |
|---|---|
| `Bash` + `command` | shell |
| `PowerShell` + `command` | shell — **the regression** |
| `powershell` (lower case) | shell |
| `mcp__x__run` + `command` | not shell (step 5 owns it) |
| `Write` (no command) | not shell |
| unknown name + `command`, table known and containing it | shell |
| unknown name + `command`, table known and not containing it | not shell |
| unknown name + `command`, table not yet seen | shell (fail closed) |
| known shell name with no `command` | deny, not allow |

A live run is still required: the unit tests pin the rule, but only a real run proves the SDK's init table actually contains the name the model is offered, and that the input field really is `command`. That run needs a dev server (see `tasks.md`).
