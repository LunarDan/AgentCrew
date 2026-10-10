# Core Domain Delta

## MODIFIED Requirements

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
