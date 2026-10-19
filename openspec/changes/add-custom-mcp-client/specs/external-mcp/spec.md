# External MCP Delta

## MODIFIED Requirements

### Requirement: MCP transports SHALL be limited to what the adapter supports — D2

A server's transport MUST determine which adapters can use it, and an unsupported pairing MUST be rejected at selection time rather than passed to the adapter. The supported matrix is: `stdio`, `http`, and `sse` on Claude Code; `stdio` and `http` on Codex; `stdio`, `sse`, and `http` on custom.

#### Scenario: SSE server selected on a Codex agent
- **WHEN** a user selects an `sse` server for a Codex agent
- **THEN** the agent builder rejects or clearly flags the selection
- **AND** the adapter is never handed a transport it cannot express.

#### Scenario: HTTP server is shared by all adapters
- **WHEN** an `http` server is selected on a Claude Code, Codex, and custom agent
- **THEN** each adapter maps it to its own supported remote transport.

#### Scenario: Codex receives a server it cannot run
- **WHEN** the Codex adapter resolves a server whose transport is `sse`
- **THEN** that server is skipped rather than passed through
- **AND** the reason is surfaced to the user.

#### Scenario: Custom agent selects a supported server
- **WHEN** a custom agent selects a `stdio`, `http`, or `sse` server
- **THEN** the adapter connects to it for that run
- **AND** its tools are exposed to the model as `mcp__<server>__<tool>`.

### Requirement: MCP server trust SHALL gate tool execution — D1

A server's `trust` MUST determine whether its tools execute freely or require approval. `trust = 'always'` MUST be the only value that executes without a prompt, and `trust = 'ask'` (the default) MUST require approval on every adapter that runs the server through AgentHub's own approval path — Claude Code and custom. Codex's own approval policy and sandbox are outside AgentHub, so `trust` is advisory there and the UI MUST say so. A workspace-resident settings file MUST NOT be able to grant that approval in advance.

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

#### Scenario: Custom agent calls an untrusted tool
- **WHEN** a custom agent's model calls an external tool whose server has `trust = 'ask'`
- **THEN** the same `mcp_tool.pending` / `mcp_tool.resolved` approval flow runs before the call
- **AND** a denial returns an error result without executing the tool.

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

#### Scenario: Custom adapter spawns a stdio server
- **WHEN** the custom adapter connects to a stdio server
- **THEN** it passes `buildChildProcessEnv()` as the child environment
- **AND** overlays the server's declared `env` on top.

## ADDED Requirements

### Requirement: CustomAgentAdapter SHALL connect external MCP servers per run

The custom adapter MUST create its own MCP clients for the run's resolved servers, list their tools, expose them to the model under the `mcp__<server>__<tool>` namespace, route calls back to the owning server, and close every connection when the run ends or aborts.

#### Scenario: A custom run has healthy servers
- **WHEN** the run starts with one or more resolved servers
- **THEN** the adapter connects to each server and lists its tools
- **AND** the model receives both the built-in tools and the namespaced external tools.

#### Scenario: One server fails to connect
- **WHEN** a server cannot be connected or cannot list tools
- **THEN** the adapter skips only that server
- **AND** emits `mcp_server.unavailable` with the server name and status
- **AND** the run continues with the remaining tools.

#### Scenario: The run ends or is aborted
- **WHEN** the stream finishes or the abort signal fires
- **THEN** every MCP client is closed
- **AND** every stdio child process tree is terminated.

#### Scenario: No servers are selected
- **WHEN** the custom agent selects no external MCP servers
- **THEN** no MCP client is created
- **AND** behaviour is unchanged from before this capability existed.

#### Scenario: A tool result contains binary content
- **WHEN** a tool returns image, audio, or resource content
- **THEN** the value returned to the model describes it without inlining the encoded bytes.
