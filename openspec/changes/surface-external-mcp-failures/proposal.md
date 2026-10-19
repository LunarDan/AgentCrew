# Surface external MCP connection failures

## Why

The external-MCP P0 verification left **F2** open (`openspec/changes/add-external-mcp/tasks.md:118-119`, `specs/15-external-mcp.md:257`): a server that is enabled and selected but fails at SDK spawn is dropped silently. The user sees a configured server that simply is not there, with nothing explaining why. The capability contract already requires a visible warning (`openspec/specs/external-mcp/spec.md` — "the failure is surfaced to the user as a warning"); the implementation only satisfies the "run does not fail" half.

There are two failure classes, both invisible today:

1. **Resolution failures** (`resolveMcpServersForAgent`): unsupported transport, missing `command`/`url`, unresolved `${ENV}`. These are returned as `warnings` but only `console.warn`-ed at `src/server/agent-runner.ts:2042`.
2. **SDK spawn/connect failures**: the Claude Code SDK's init message already carries `mcp_servers: { name, status }[]`; `src/server/adapters/claude-code-adapter.ts:483-491` reads `session_id` and `tools` and throws the statuses away.

## What Changes

- Add a `mcp_server.unavailable` StreamEvent (connection lifecycle, pass-through, not an invocation report) carrying the affected server names and statuses.
- The Claude Code adapter emits it from the SDK init message for selected external servers in `failed` / `needs-auth` / `disabled` states.
- AgentRunner turns both failure classes into **one persistent `role: 'system'` message per run** (`msg_mcp_<runId>`), visible in the conversation and excluded from LLM history. No new UI component, no toast dependency.
- Keep the run outcome unchanged: a broken server never fails the run.

## Impact

- New capability delta: `stream-events` (the lifecycle event) and `external-mcp` (failure warning is now user-visible and persistent).
- Touched code: `src/shared/types.ts`, `src/server/adapters/claude-code-adapter.ts`, `src/server/agent-runner.ts`; new pure helpers `src/server/adapters/mcp-status.ts` and `src/server/mcp-notices.ts` with unit tests.
- **Known boundary**: Codex exposes no MCP status through its SDK event stream, so spawn failures remain invisible there (the existing P2 limitation); resolution warnings are still surfaced for every adapter that can resolve MCP servers. The `custom` adapter has no MCP transport yet (P1).
- The SDK init status values are documented in `sdk.d.ts` (`failed | needs-auth | pending | disabled`) but the value used for a nonexistent `command` has not been observed; the live verification covers it. If the SDK omits such a server instead of marking it, the adapter extends the rule with a "not listed" status.
- No dependency changes, no security-constraint changes, no database schema changes.
