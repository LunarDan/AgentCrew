# External MCP Delta

## MODIFIED Requirements

### Requirement: External MCP failure SHALL be isolated per server

A server that fails to start, connect, or list tools MUST degrade to a warning and MUST NOT fail the run or affect other servers. Every such failure MUST be surfaced to the user as a persistent warning in the conversation.

#### Scenario: One server is broken
- **WHEN** one of three selected servers fails to connect
- **THEN** the run proceeds with the two that work
- **AND** the conversation shows a warning naming the failed server and its status.

#### Scenario: A server cannot be resolved before the run starts
- **WHEN** a selected server has an unsupported transport, a missing `command` or `url`, or an unresolved `${ENV}` placeholder
- **THEN** the run proceeds without that server
- **AND** the conversation shows a warning naming the server and the reason.

#### Scenario: Every selected server is healthy
- **WHEN** all selected servers connect successfully
- **THEN** no MCP warning is added to the conversation.
