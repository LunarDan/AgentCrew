# Fix Part Index Collision

## Why

A message's `parts` array is written by two protocols that do not know about each other:

- `part.start` **assigns by index** — `parts[event.partIndex] = event.part` (`src/server/agent-runner.ts:1688`, mirrored client-side at `src/stores/app-store.ts:680`)
- `tool.call` / `tool.result` **append** — `parts.push(...)` (`agent-runner.ts:1707` / `:1719`, mirrored at `app-store.ts:705` / `:725`)

The `partIndex` an adapter emits counts only the parts *that adapter* starts, and it does not advance when a tool event is appended. So when an adapter emits text *after* a tool call, `parts[partIndex]` overwrites the slot the `tool_use` already occupies.

The damage is permanent. The persisted `messages.parts` becomes `["text","tool_result"]`, the `tool_use` is gone from the database, and the renderer — which folds each `tool_result` into its `tool_use` by `callId` and silently drops orphans (`src/components/message-parts.tsx:28-33,42`) — loses the tool card. Reloading does not help: history is read straight from `messages.parts` (`src/server/conversation-service.ts:261-266`), not replayed from events.

This affects **every** tool call made through the claude-code and codex adapters, including AgentHub's own `mcp__agenthub__*` bridge. It is not MCP-specific. It was found and recorded as finding **F1** during the external-MCP P0 verification (`openspec/changes/add-external-mcp/tasks.md`, 2026-10-10), which deliberately left it unfixed.

`specs/02-stream-events.md:210` already states the intended boundary — the Adapter "should not care what the next partIndex for this message is; AgentRunner is the only role that holds the message stream." The adapters violate it in practice. This change makes the code match the spec, not the other way round (CLAUDE.md §9).

## What Changes

- AgentRunner becomes the single authority for `parts` slot assignment. An adapter's `partIndex` is treated as a **stream-local ordinal** and translated to a real array slot before the event is persisted and published.
- The translation is applied at the one choke point every adapter event passes through (`consumeStream`, `agent-runner.ts:1543-1544`), so claude-code, codex, and mock are all corrected without touching a single adapter.
- Because the rewritten index is what reaches SSE, the frontend reducer needs **no change**.
- The `StreamEvent` shape is unchanged: `tool.call` / `tool.result` still carry no `partIndex`.

## Impact

- No schema change, no new dependency, no event-contract change.
- Adapters keep their counters as stream-local ordinals; they are not removed.
- **Forward-only**: messages already persisted with the collapsed `["text","tool_result"]` shape cannot be repaired — the lost `tool_use` payload (`toolName`, `args`) is physically gone. No backfill is attempted.
- Outside this change, and deliberately left as-is: the `partsBuffer.get(id) ?? []` fallback in `persistEvent` (a post-`message.end` event would overwrite the message's stored parts with a one-element array — not reachable today), and the claude-code adapter's non-streaming text fallback at `claude-code-adapter.ts:515-523`.
