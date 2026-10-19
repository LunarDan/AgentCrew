# Core Domain

## Purpose

Defines AgentHub's durable entities and ownership boundaries. Detailed field notes live in `specs/01-core-entities.md`.

## Requirements

### Requirement: Core entities SHALL remain normalized

AgentHub SHALL model Agent, Conversation, Message, Artifact, Workspace, Tool, and AgentRun as separate domain concepts with explicit references instead of embedding unrelated lifecycle data into a single record. MCP server registrations are configuration, not a core entity, and are referenced by id from Agent rather than embedded in it.

#### Scenario: Message references an artifact
- **WHEN** an agent creates an artifact during a run
- **THEN** the message contains an `artifact_ref` part
- **AND** the artifact content and version metadata remain in the artifacts table.

#### Scenario: Agent selects MCP servers
- **WHEN** an agent is configured to use external MCP servers
- **THEN** the agent stores only their ids
- **AND** the connection configuration remains in the shared `mcp_servers` table.

### Requirement: Agents SHALL route through an adapter name

Every runnable agent MUST declare an `adapterName` of `custom`, `claude-code`, `codex`, or `mock`, and AgentRunner SHALL use that value to resolve the adapter. An agent MAY additionally reference zero or more external MCP servers through `mcpServerIds`.

#### Scenario: Codex agent is configured
- **WHEN** an agent has `adapterName='codex'`
- **THEN** `modelProvider` is ignored
- **AND** `toolNames` is forced to an empty list because Codex uses SDK-provided tools.

#### Scenario: SDK agent selects external MCP servers
- **WHEN** an agent has `adapterName='claude-code'` or `'codex'` and a non-empty `mcpServerIds`
- **THEN** `mcpServerIds` is preserved
- **AND** the rule that empties `toolNames` for SDK adapters does not apply to it, because external MCP servers are the mechanism by which SDK agents gain user-chosen tools.

### Requirement: Conversations SHALL own workspace policy

Each conversation SHALL have exactly one workspace record that determines effective cwd, filesystem approval mode, pinned message ids, and local vs sandbox workspace semantics.

#### Scenario: Local workspace conversation runs a tool
- **WHEN** a tool receives a relative path
- **THEN** the path is resolved under the conversation's effective cwd
- **AND** writes outside that tree are rejected.

### Requirement: Agent runs SHALL be auditable

Each agent execution MUST create an AgentRun record with trigger message, parent run if any, status, timestamps, and usage when reported.

#### Scenario: Adapter throws
- **WHEN** an adapter stream fails
- **THEN** the AgentRun status becomes `failed`
- **AND** the user sees an error message in the conversation.

### Requirement: Destructive operations SHALL respect active work and references

Deleting a conversation MUST be rejected while it has queued or running agent runs. Sending a message with attachment ids that do not exist in that conversation MUST be rejected instead of silently dropping them. Deleting a custom agent MUST remove its id from `conversations.agentIds`.

#### Scenario: User deletes a conversation mid-run
- **WHEN** the conversation has a `queued` or `running` agent run
- **THEN** deletion fails with a clear error
- **AND** no rows or workspace files are removed.

#### Scenario: Message references a foreign attachment
- **WHEN** a send request includes an attachment id from another conversation or an unknown id
- **THEN** the request is rejected
- **AND** no user message is inserted.

#### Scenario: User deletes a custom agent used by group chats
- **WHEN** the agent is removed
- **THEN** every conversation's `agentIds` no longer contains that id.
