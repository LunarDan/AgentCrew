# Tools Delta

## ADDED Requirements

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
