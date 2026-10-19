# Design — surfacing external MCP failures

## 1. Where the information exists

| Failure class | Source | Today |
|---|---|---|
| Unsupported transport / missing `command` / `url` / unresolved `${ENV}` | `resolveMcpServersForAgent` returns `warnings: string[]` (`src/server/mcp-server-service.ts:253-309`) | `console.warn` only (`agent-runner.ts:2042`) |
| Cannot spawn / connect / needs auth | SDK init `mcp_servers: { name, status }[]` (`sdk.d.ts:3988-3991`) | Dropped by the init branch (`claude-code-adapter.ts:483-491`) |

`Query.mcpServerStatus()` would give richer statuses (`error`, `tools`) but is only supported with streaming input/output; this adapter passes a string prompt. The init snapshot is the usable source.

## 2. User-visible channel: persisted system message

Options considered:

| Option | Verdict |
|---|---|
| **Persisted `role: 'system'` message** | **Chosen.** Renders through the existing `MessageItem` → `PartList` path, survives reload, excluded from LLM history (`conversation-context.ts:191`) and compaction, mirrors the existing deploy/compaction notices. |
| Transient banner / toast | No toast dependency exists; a banner needs a new store slice and a new component, and disappears on reload. |
| `run.end.error` | Terminal semantics; would mark a successful run as failed. |
| Appending a text part to the agent message | Pollutes the model's output and the assistant bubble. |
| New `MessagePart` type | Larger contract change for no benefit over a system message. |

One notice per run: message id `msg_mcp_<runId>`. The first warning inserts it and publishes `message.added`; later warnings append a text part and publish `part.start`. A single message cannot be duplicated by the orchestrator's plan/aggregate stages, which share a run id.

## 3. Transport: a lifecycle event, not a callback

Adapters only yield events (`CLAUDE.md §3.1`; `specs/05-adapter-interface.md`). The runner cannot observe SDK internals itself, so the adapter must communicate the init statuses. A new `mcp_server.unavailable` event keeps the existing adapter → runner → EventBus pipeline:

- pass-through: `persistEvent`'s `default` ignores it, `publish` forwards it, the store's `default` ignores it;
- the user-visible artifact is the system message inserted by the runner;
- it is a **connection-lifecycle** event. `openspec/specs/external-mcp/spec.md` forbids a new event for *reporting an invocation* — this is not one, and `tool.call` / `tool.result` semantics are untouched.

Statuses treated as unavailable: `failed`, `needs-auth`, `disabled`. `connected`, `pending`, and unknown values do not warn, so a connection that is still settling at init does not produce a false alarm.

Only servers present in `input.mcpServers` are considered, which excludes the built-in `agenthub` bridge.

## 4. Boundaries

- **Codex**: no MCP status in its SDK event stream. Spawn failures remain a documented limitation; resolution warnings still appear because the runner produces them.
- **custom**: `resolveMcpServersForAgent` returns early for adapters with no supported transports, so nothing is resolved or warned. Enabling custom MCP is P1.
- No per-run probe: an extra connection attempt would cost up to 60 s (`TEST_TIMEOUT_MS`) and duplicate what the SDK already does.
- The warning is informational only; it never changes `run.end.status`.
