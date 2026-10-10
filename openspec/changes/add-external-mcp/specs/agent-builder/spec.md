# Agent Builder Delta

## ADDED Requirements

### Requirement: Agents SHALL select external MCP servers independently of toolNames

The agent builder MUST let a user select zero or more registered MCP servers for an agent, stored as `mcpServerIds`. This selection MUST be independent of `toolNames` and MUST NOT be cleared for SDK adapters.

#### Scenario: Claude Code agent selects MCP servers
- **WHEN** a user selects two MCP servers on a `claude-code` agent and saves
- **THEN** the persisted agent has both ids in `mcpServerIds`
- **AND** the SDK-adapter rule that empties `toolNames` does not empty `mcpServerIds`.

#### Scenario: Custom agent selects MCP servers
- **WHEN** a user selects MCP servers on a `custom` agent
- **THEN** the selection is persisted
- **AND** the servers do not participate in runs until the custom adapter's MCP client exists.

### Requirement: The MCP picker SHALL only offer servers the agent's adapter can run

The picker MUST present servers compatible with the selected adapter, and MUST reject or clearly flag an incompatible transport pairing.

#### Scenario: SSE server on a Codex agent
- **WHEN** the selected adapter is `codex` and a server uses the `sse` transport
- **THEN** that server is not offered, or is offered as unavailable with the reason shown.

#### Scenario: Adapter is changed after selection
- **WHEN** a user selects a Codex-incompatible server and then switches the adapter to `codex`
- **THEN** the conflicting selection is surfaced before saving.

### Requirement: Agent details SHALL show selected MCP servers by name

The agent info popover MUST resolve selected server ids to display names so a user can see which external servers an agent can reach.

#### Scenario: Popover is opened for an agent with MCP servers
- **WHEN** the agent has non-empty `mcpServerIds`
- **THEN** the popover lists the resolved server names
- **AND** an id with no matching row is not rendered as a raw id.
