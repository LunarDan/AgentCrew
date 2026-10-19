# Stream Events Delta

## ADDED Requirements

### Requirement: MCP server unavailability SHALL be reported as a lifecycle event

When an adapter learns that one or more external MCP servers it was given for a run are unavailable, it SHALL emit `mcp_server.unavailable` carrying the affected server names and statuses. This is a connection-lifecycle event, not an invocation report; it MUST NOT change the semantics of `tool.call` / `tool.result`.

#### Scenario: SDK reports a failed server at init
- **WHEN** the Claude Code SDK's init message reports `failed` or `needs-auth` for a selected external server
- **THEN** the adapter emits `mcp_server.unavailable` with that server and status
- **AND** AgentRunner turns it into a persistent system notice
- **AND** the run continues.

#### Scenario: All servers connect
- **WHEN** every selected external server reports `connected`
- **THEN** no `mcp_server.unavailable` event is emitted
- **AND** no MCP warning message is added to the conversation.
