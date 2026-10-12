# External MCP — 外部 MCP 工具接入

## Purpose

Defines user-registered external MCP servers: global registration, per-agent opt-in, transport support, the trust/approval gate, and secrets handling. Detailed notes live in `specs/15-external-mcp.md`.

## Requirements

### Requirement: External MCP servers SHALL be registered globally and reused by agents

MCP server configuration MUST live in a single global `mcp_servers` table, and agents MUST reference entries by id through `agents.mcp_server_ids`. Configuration MUST NOT be inlined per agent.

#### Scenario: One server is shared by two agents
- **WHEN** a user registers an MCP server and selects it on two different agents
- **THEN** both agents resolve the same `mcp_servers` row
- **AND** editing the server once changes both agents' runs.

#### Scenario: Agent references a deleted server
- **WHEN** a server is deleted while an agent still lists its id
- **THEN** resolution skips the missing id rather than failing the run.

### Requirement: External MCP SHALL require explicit opt-in at both levels

A registered server MUST NOT participate in any run unless it is both `enabled` and explicitly selected by the agent. New servers MUST default to disabled, and new agents MUST default to selecting none.

#### Scenario: Registered but disabled server
- **WHEN** a server row exists with `enabled = false`
- **THEN** its tools are absent from every run, including runs of agents that select it.

#### Scenario: Enabled but unselected server
- **WHEN** a server is enabled and the agent does not list its id
- **THEN** its tools are absent from that agent's runs.

### Requirement: External MCP tools SHALL be namespaced

Tools supplied by external servers MUST be exposed to the model as `mcp__<serverName>__<toolName>` so they cannot collide with built-in tools or the adapter-owned `agenthub` bridge.

#### Scenario: Two servers expose a same-named tool
- **WHEN** servers `fs` and `git` both expose a tool named `read`
- **THEN** the model sees two distinct tools, `mcp__fs__read` and `mcp__git__read`.

#### Scenario: A server claims a reserved name
- **WHEN** a user tries to register a server named `agenthub`
- **THEN** registration is rejected as reserved.

### Requirement: External MCP calls SHALL reuse existing stream events

MCP tool *invocations* MUST be reported through the existing `tool.call` and `tool.result` events with the namespaced tool name. No new `StreamEvent` variant may be introduced for reporting an invocation.

Approval is a separate concern and uses its own pair, `mcp_tool.pending` / `mcp_tool.resolved`, mirroring `bash_command.pending` / `bash_command.resolved` (decision D1). Those two variants are the **only** StreamEvent additions this change makes.

#### Scenario: Model calls an external tool
- **WHEN** the model invokes `mcp__fs__read`
- **THEN** AgentHub emits `tool.call` and then `tool.result` with `toolName = 'mcp__fs__read'`
- **AND** the client reducer renders them without new event handling.

#### Scenario: An external tool needs approval
- **WHEN** an external tool call is gated and the user has not approved that tool in this conversation
- **THEN** AgentHub emits `mcp_tool.pending`, and `mcp_tool.resolved` once the user decides
- **AND** the tool's own `tool.call` / `tool.result` follow only if it was approved.

### Requirement: External MCP servers SHALL NOT write AgentHub database rows

Adapters MUST translate resolved MCP configuration into SDK config only. Database reads, enablement filtering, and placeholder expansion MUST happen in the application layer and reach adapters as a plain resolved structure.

#### Scenario: Adapter receives MCP configuration
- **WHEN** an adapter builds its SDK options
- **THEN** it consumes an already-resolved server list from `AdapterInput`
- **AND** performs no database access of its own.

### Requirement: MCP secrets SHALL be masked on read and merged on write

MCP `env` and `headers` values MUST NOT be returned in plaintext by any read API. Updates MUST merge: an omitted field leaves the stored value unchanged, a literal value replaces it, and an explicit `null` clears it.

#### Scenario: Server list is fetched
- **WHEN** the client lists MCP servers
- **THEN** secret values appear as masked previews with a presence marker
- **AND** no plaintext secret is present in the response.

#### Scenario: Editing an unrelated field
- **WHEN** a user changes only a server's `name` and saves, with the masked secret preview round-tripped unchanged
- **THEN** the stored secret is preserved
- **AND** is not overwritten by the mask itself.

### Requirement: MCP secrets MAY reference environment variables

`env` and `headers` values MUST support `${NAME}` placeholders resolved from the server process environment at run start, so secrets need not be stored in the database.

#### Scenario: Secret is stored as a placeholder
- **WHEN** a server declares `{ "GITHUB_TOKEN": "${GITHUB_TOKEN}" }`
- **THEN** the placeholder is resolved when the run starts, not when the server row is saved
- **AND** the database row contains only the placeholder text.

#### Scenario: Placeholder cannot be resolved
- **WHEN** a referenced variable is absent from the environment
- **THEN** the failure names the unresolved variable
- **AND** the run continues without that server.

### Requirement: External MCP failure SHALL be isolated per server

A server that fails to start, connect, or list tools MUST degrade to a warning and MUST NOT fail the run or affect other servers.

#### Scenario: One server is broken
- **WHEN** one of three selected servers fails to connect
- **THEN** the run proceeds with the two that work
- **AND** the failure is surfaced to the user as a warning.

### Requirement: External MCP stdio processes SHALL be terminated with the run

Stdio MCP child processes MUST be killed as a process tree when the owning run ends or is aborted, on both POSIX and Windows.

#### Scenario: User aborts a run with a live stdio server
- **WHEN** the run AbortSignal fires
- **THEN** the server child process and its descendants are terminated
- **AND** no orphaned process remains.

### Requirement: External MCP SHALL be documented as outside the sandbox guarantee

Because external servers run with the application's privileges and bypass the workspace sandbox and command blacklist, the UI and documentation MUST state this explicitly, and registration MUST require an explicit trust confirmation that displays the full command, arguments, and environment keys.

#### Scenario: User registers a stdio server
- **WHEN** the registration form is submitted
- **THEN** the user has seen the complete command, arguments, and environment keys
- **AND** has explicitly confirmed trusting the server
- **AND** has been warned that it runs outside AgentHub's sandbox.

### Requirement: External MCP child environments SHALL inherit the application environment — D3

A third-party stdio MCP child MUST be spawned with the same environment as AgentHub's other child processes, via `buildChildProcessEnv`. Because that environment includes AgentHub's provider keys and internal tokens, this MUST be documented as explicit full-environment inheritance and MUST NOT be described as a whitelist or as isolation.

#### Scenario: Server reads the inherited environment
- **WHEN** a stdio server is spawned
- **THEN** it receives the parent process environment
- **AND** no documentation or UI implies that AgentHub's credentials are withheld from it.

#### Scenario: Server declares its own values
- **WHEN** a server declares `env` entries
- **THEN** those entries are applied on top of the inherited environment.

#### Scenario: Server uses a placeholder
- **WHEN** a server declares `{ "TOKEN": "${GITHUB_TOKEN}" }`
- **THEN** the placeholder resolves from the environment at run start
- **AND** the database stores only the placeholder text.

### Requirement: MCP server trust SHALL gate tool execution — D1

A server's `trust` MUST determine whether its tools execute freely or require approval. `trust = 'always'` MUST be the only value that executes without a prompt, and `trust = 'ask'` (the default) MUST require approval. A workspace-resident settings file MUST NOT be able to grant that approval in advance.

#### Scenario: Untrusted server tool is called for the first time
- **WHEN** the model calls a tool on a server with `trust = 'ask'` for the first time in a conversation
- **THEN** AgentHub requests user approval before executing
- **AND** records the approval for that tool in that conversation.

#### Scenario: Previously approved tool is called again
- **WHEN** the same tool is called again in the same conversation
- **THEN** it executes without another prompt
- **AND** a new conversation prompts again.

#### Scenario: Approval is denied
- **WHEN** the user denies the approval request
- **THEN** that call returns an error result to the model
- **AND** the run continues.

#### Scenario: Trusted server tool is called
- **WHEN** a tool on a server with `trust = 'always'` is called
- **THEN** it executes without a prompt.

#### Scenario: Workspace settings try to pre-approve an external tool
- **WHEN** the workspace contains a settings file allowing `mcp__<server>__<tool>`
- **THEN** the `trust = 'ask'` gate still requests approval
- **AND** the call executes without a prompt only if `trust = 'always'` or the tool is already approved in this conversation.

### Requirement: MCP transports SHALL be limited to what the adapter supports — D2

A server's transport MUST determine which adapters can use it, and an unsupported pairing MUST be rejected at selection time rather than passed to the SDK. The supported matrix is: `stdio` and `http` on both SDK adapters, `sse` on Claude Code only.

#### Scenario: SSE server selected on a Codex agent
- **WHEN** a user selects an `sse` server for a Codex agent
- **THEN** the agent builder rejects or clearly flags the selection
- **AND** the adapter is never handed a transport it cannot express.

#### Scenario: HTTP server is shared by both SDK adapters
- **WHEN** an `http` server is selected on a Claude Code agent and on a Codex agent
- **THEN** each adapter maps it to its own supported remote transport.

#### Scenario: Codex receives a server it cannot run
- **WHEN** the Codex adapter resolves a server whose transport is `sse`
- **THEN** that server is skipped rather than passed through
- **AND** the reason is surfaced to the user.
