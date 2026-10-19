# Tools

## Purpose

Defines AgentHub-managed tools, approval boundaries, and adapter-specific tool ownership. Detailed tool specs live in `specs/07-tools.md`.

## Requirements

### Requirement: Tool definitions SHALL be registered centrally

AgentHub-managed tools MUST be registered through `toolRegistry` with name, description, JSON schema, and handler.

#### Scenario: Custom agent enables a tool
- **WHEN** an agent's `toolNames` includes `fs_read`
- **THEN** CustomAgentAdapter resolves the tool definition from `toolRegistry`.

### Requirement: Attachments SHALL be read through safe tool extraction

`read_attachment` MUST read user-uploaded attachments scoped to the current conversation. Text-like files and PDFs with extractable text SHALL return plain text with bounded length; unsupported binary formats SHALL return metadata instead of raw bytes.

#### Scenario: Agent reads a PDF attachment
- **WHEN** `read_attachment` receives an attachment whose MIME type, filename, or file header identifies it as a PDF
- **THEN** AgentHub extracts local PDF text before returning the tool result
- **AND** truncates the returned text at the same bounded length used for text files
- **AND** returns a clear note when the PDF has no extractable text and likely needs OCR.

### Requirement: File tools SHALL enforce workspace boundaries

`fs_read`, `fs_write`, and `bash` MUST resolve paths under the conversation effective cwd and reject access outside that tree.

#### Scenario: Agent attempts path traversal
- **WHEN** a tool receives `../../.ssh/id_rsa`
- **THEN** the path check rejects the operation.

### Requirement: Bash SHALL enforce platform blacklist

The bash tool MUST reject commands that match the platform-specific banned pattern list before execution.

#### Scenario: POSIX destructive command is requested
- **WHEN** the command matches `rm -rf /`
- **THEN** the tool refuses to run it.

#### Scenario: POSIX background process inherits stdio
- **WHEN** a bash command starts a background process and the shell script exits
- **THEN** the bash tool MUST NOT wait forever on inherited stdout or stderr
- **AND** it SHOULD clean up the command process group before returning.

### Requirement: Key bash commands SHALL require user approval

AgentHub MUST require explicit user approval before executing bash commands that are not banned but can materially change dependencies, discard files, or affect host-level runtime state. This approval gate MUST apply to AgentHub's `bash` tool and SDK command hooks where the adapter exposes a pre-execution permission callback.

#### Scenario: Agent installs dependencies
- **WHEN** an agent requests `pnpm install`
- **THEN** AgentHub records a pending bash command
- **AND** emits it through the conversation event stream
- **AND** executes the command only after user approval.

### Requirement: Review mode SHALL require write approval

In review mode, file write effects managed by AgentHub MUST create pending approvals instead of directly mutating workspace files.

#### Scenario: Agent proposes a file write
- **WHEN** `fs_write` is called in review mode
- **THEN** AgentHub records a pending write
- **AND** waits for explicit user approval.

### Requirement: Pending approvals SHALL be scoped to their conversation

A pending approval resolved through `/api/conversations/{id}/.../{pendingId}` MUST belong to that conversation. An id from another conversation MUST be treated as not found.

#### Scenario: Pending write id belongs to another conversation
- **WHEN** a client posts an approval for a pending write / question under conversation A
- **AND** the pending item's `conversationId` is B
- **THEN** the route returns 404
- **AND** the pending item is not applied.

### Requirement: SDK tool sets SHALL be documented separately

SDK adapters MUST receive their tool set from the adapter/SDK rather than per-agent `toolNames`. This requirement governs **AgentHub-provided** tools only; user-registered external MCP servers are a separate, explicitly opted-in mechanism and MUST NOT be treated as part of the SDK tool set.

#### Scenario: SDK agent receives AgentHub MCP tools
- **WHEN** a Claude Code or Codex agent runs
- **THEN** the injected guidance includes the allowlisted AgentHub MCP tools exposed by that adapter

#### Scenario: SDK agent is restricted to its allowlist
- **WHEN** a Claude Code or Codex agent runs
- **THEN** its built-in AgentHub tool set is still taken from the adapter rather than from `toolNames`
- **AND** external MCP servers, if any are selected, are added on top of that set rather than substituting for it.

### Requirement: AgentHub SHALL inject tool-call guidance for available tools

AgentHub MUST append usage guidance and concrete examples for the AgentHub-managed tools available to the current run. Guidance MUST be scoped to the actual tool set, and MUST call out common argument-shape mistakes for tools whose schemas are often confused.

#### Scenario: Custom agent has file and artifact tools
- **WHEN** a custom agent run is built with `fs_read`, `fs_write`, `read_artifact`, and `write_artifact`
- **THEN** the injected system prompt includes examples for those tools
- **AND** it does not instruct the agent to call unavailable tools such as `plan_tasks`.

#### Scenario: Agent can write artifacts
- **WHEN** a run includes `write_artifact`
- **THEN** the injected guidance warns against empty `write_artifact({})` calls
- **AND** includes a complete document artifact template with `type`, `title`, and `content`.

#### Scenario: SDK adapter receives AgentHub MCP tools
- **WHEN** a Claude Code or Codex run is built
- **THEN** the injected guidance includes the allowlisted AgentHub MCP tools exposed by that adapter
- **AND** examples use the exact camelCase argument names accepted by the tool schemas.

#### Scenario: Local workspace code task has file tools
- **WHEN** a run is built for a local workspace
- **AND** the agent has AgentHub file tools or SDK local file tools
- **THEN** the injected guidance tells the agent to prefer direct workspace file/command tools for project source work
- **AND** tells the agent not to use `write_artifact` for source files that should be written to disk.

### Requirement: Network fetch tools SHALL prevent SSRF

AgentHub MUST provide a `web_fetch` tool that fetches `http` / `https` URLs only. It MUST reject URLs with embedded credentials and MUST refuse to connect when the hostname or any resolved address is loopback, private, link-local, multicast, reserved, or a cloud metadata address. Redirect targets MUST be re-validated with the same rules on every hop. Responses MUST be capped in size and truncation MUST be reported; non-text content MUST NOT be downloaded.

#### Scenario: Agent targets a private or local URL
- **WHEN** an agent calls `web_fetch` with `http://localhost:3000`, `http://127.0.0.1/`, `http://169.254.169.254/latest/meta-data/`, or a `file://` URL
- **THEN** the tool returns an error
- **AND** no outbound request is made to that target.

#### Scenario: Public URL redirects to a private address
- **WHEN** a fetch response redirects to a host that resolves to a private address
- **THEN** the redirect is rejected before connecting.

#### Scenario: Response exceeds the text limit
- **WHEN** the fetched response is larger than the tool's size cap
- **THEN** the tool returns the leading content with a truncation marker
- **AND** the result states that it was truncated.

### Requirement: Agents SHALL be able to ask structured user questions

AgentHub MUST provide an `ask_user` tool for finite user choices. The tool SHALL accept 1-4 questions, each with 2-4 options, and SHALL suspend the run until the user answers or the run is aborted.

#### Scenario: Agent needs a blocking finite choice
- **WHEN** an available agent tool call submits `ask_user` with valid questions
- **THEN** AgentHub records a pending user question
- **AND** emits the pending question through the conversation event stream
- **AND** returns the selected answers to the agent after the user responds.

#### Scenario: Orchestrator plan has a key ambiguity
- **WHEN** the Orchestrator plan stage needs a blocking clarification expressible as 2-4 options
- **THEN** the plan stage may call `ask_user` before `plan_tasks`
- **AND** the aggregate stage does not expose `ask_user`.

### Requirement: Web app artifacts SHALL be deployable to preview URLs

AgentHub MUST provide a `deploy_artifact` tool that accepts a web app artifact id and returns a deployment status record with a preview path. The tool MUST create a local static deployment and SHOULD additionally publish it to a configured external static directory.

#### Scenario: Agent deploys a web app artifact
- **WHEN** `deploy_artifact` receives a valid `web_app` artifact id
- **THEN** it returns a ready deployment record
- **AND** the record points at the local deployment preview route when no external publish target is configured.

#### Scenario: Agent deploys with external static publishing configured
- **WHEN** `deployment_publish_enabled` is true
- **AND** `deployment_publish_dir` and `deployment_public_base_url` are set
- **THEN** the tool publishes public deployment files to the configured directory
- **AND** returns the public URL as the primary preview path
- **AND** includes a local preview fallback.

#### Scenario: Agent deploys a non-web artifact
- **WHEN** `deploy_artifact` receives a document, image, or missing artifact id
- **THEN** it returns a failed deployment record with a user-visible reason.

### Requirement: Workspace static directories SHALL be deployable to preview URLs

AgentHub MUST provide a `deploy_workspace` tool that accepts a static output directory inside the current workspace and returns a deployment status record. The tool MUST copy existing static files only; it MUST NOT run build commands. Workspace deployments MUST enforce workspace path isolation, reject missing or non-directory sources, require an HTML entry file, and exclude private or dependency directories such as `.agenthub`, `.git`, and `node_modules`.

#### Scenario: Agent deploys a built local project
- **WHEN** `deploy_workspace` receives `path="dist"` and `dist/index.html` exists inside the conversation workspace
- **THEN** it creates a ready deployment record
- **AND** the record has `sourceType="workspace"` and `workspacePath="dist"`.

#### Scenario: Slash deploy has no artifact candidates
- **WHEN** a user sends `/deploy`
- **AND** the conversation has no `web_app` artifact candidates
- **AND** a common static output directory such as `dist`, `build`, `out`, or `client/dist` exists with `index.html`
- **THEN** AgentHub deploys that workspace directory and inserts a `deploy_status` message part.

### Requirement: Child tasks SHALL report semantic task outcomes

AgentHub MUST provide a `report_task_result` tool for Orchestrator-dispatched child runs. The tool SHALL accept `status`, `summary`, optional `acceptanceResults`, and optional `blockers`, and SHALL not create artifacts or mutate workspace files.

#### Scenario: Child reports completion
- **WHEN** a child run calls `report_task_result` with `status="complete"`
- **THEN** AgentRunner can use that structured report as the semantic task outcome.

#### Scenario: Child reports blocked work
- **WHEN** a child run calls `report_task_result` with `status="blocked"`
- **THEN** the dispatch task is treated as not complete
- **AND** blocker details remain available to aggregation.

### Requirement: External MCP tools SHALL be namespaced and distinguished from built-in tools

Tools supplied by user-registered MCP servers MUST be named `mcp__<serverName>__<toolName>` and MUST be distinguishable from AgentHub's built-in tools and from the adapter-owned `agenthub` bridge tools.

#### Scenario: Tool call is emitted
- **WHEN** the model invokes a tool on external server `fs` named `read`
- **THEN** the emitted `tool.call` and `tool.result` carry `toolName = 'mcp__fs__read'`.

#### Scenario: Built-in tool routing is unaffected
- **WHEN** the model invokes a built-in tool such as `fs_read` or `bash`
- **THEN** the call routes through the existing tool registry exactly as before.

### Requirement: External MCP tool results SHALL be errors when the call fails

A failed external tool call MUST be returned to the model as an error result and MUST NOT abort the run.

#### Scenario: External server rejects a call
- **WHEN** an external MCP tool call fails or is denied
- **THEN** the model receives an error tool result
- **AND** the run continues.

### Requirement: External MCP tools SHALL NOT bypass AgentHub approval policy

Where the owning adapter supports AgentHub-side approval, external MCP tool calls MUST pass through it before execution, exactly like built-in side-effecting tools.

#### Scenario: Untrusted server tool is invoked
- **WHEN** a tool on a server with `trust = 'ask'` is called
- **THEN** AgentHub requests approval before the call executes.

### Requirement: Workspace files SHALL NOT pre-approve SDK tools

An SDK adapter MUST start its runtime so that no file inside the workspace can authorize a tool call on AgentHub's behalf. Every side-effecting tool call MUST reach AgentHub's approval policy before it executes; a workspace-resident settings file MUST NOT cause one to execute without it.

#### Scenario: Workspace pre-allows Bash
- **WHEN** the workspace contains `.claude/settings.json` listing Bash in `permissions.allow`
- **THEN** a Bash call still reaches AgentHub's command blacklist and approval policy
- **AND** the call executes only if that policy allows it.

#### Scenario: Workspace ships its own MCP configuration
- **WHEN** the workspace contains `.mcp.json` declaring an MCP server
- **THEN** that server is not started for the run
- **AND** only the servers the adapter was given are available to the model.

### Requirement: The shell tool SHALL be identified by identity, not by a platform literal

An SDK adapter MUST apply its command blacklist and critical-command approval policy to every shell tool call the runtime exposes, regardless of the name that runtime gives the tool. Identification MUST NOT rely on a single platform-specific literal. A call whose identity cannot be determined MUST NOT fall through to the default-allow path.

#### Scenario: The runtime names its shell tool something other than Bash
- **WHEN** the runtime offers its shell tool under a different name (for example `PowerShell` on Windows)
- **THEN** a call to that tool still reaches the command blacklist and approval policy
- **AND** the call executes only if that policy allows it.

#### Scenario: A shell tool is renamed by a runtime upgrade
- **WHEN** the tool name is not in the known set but appears in the tool table the runtime reported for the run
- **AND** its input carries a non-empty command
- **THEN** it is treated as a shell call.

#### Scenario: An external MCP tool takes a command argument
- **WHEN** the tool name starts with `mcp__`
- **THEN** it is not treated as a shell call
- **AND** its external-MCP trust policy decides the outcome.

#### Scenario: A known shell tool arrives with unparseable input
- **WHEN** a known shell tool name is called without a command string the adapter can read
- **THEN** the call is denied
- **AND** it is not allowed by default.
