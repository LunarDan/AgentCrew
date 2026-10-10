# Adapters Delta

## MODIFIED Requirements

### Requirement: SDK adapters SHALL expose allowlisted AgentHub tools through MCP

Claude Code and Codex adapters MUST expose allowlisted AgentHub tools through adapter-owned MCP bridges rather than consuming per-agent `toolNames`. The `agenthub` bridge MUST remain present and functional when user-registered external MCP servers are also attached to the same run.

#### Scenario: Codex creates and deploys an artifact or workspace build
- **WHEN** Codex calls the AgentHub MCP `write_artifact`, `deploy_artifact`, or `deploy_workspace` tool
- **THEN** the adapter translates the MCP result into `artifact.create` or `deploy.status`.

#### Scenario: SDK agent asks a structured user question
- **WHEN** Claude Code or Codex calls the AgentHub MCP `ask_user` tool
- **THEN** AgentHub routes it through the shared pending question flow.

#### Scenario: External servers share the run with the AgentHub bridge
- **WHEN** an agent selects one or more external MCP servers
- **THEN** the adapter configures them alongside `agenthub` rather than replacing it
- **AND** AgentHub's own artifact, deploy, and question tools remain available.

## ADDED Requirements

### Requirement: Adapters SHALL consume resolved external MCP servers from AdapterInput

`AdapterInput` MUST carry the run's resolved external MCP servers as plain configuration. Adapters MUST translate that structure into their SDK's native MCP configuration and MUST NOT read the database or resolve placeholders themselves.

#### Scenario: Claude Code adapter receives external servers
- **WHEN** `AdapterInput.mcpServers` is non-empty
- **THEN** the adapter maps each server to its SDK MCP config shape
- **AND** passes them in the `mcpServers` option together with the `agenthub` bridge.

#### Scenario: Codex adapter receives external servers
- **WHEN** `AdapterInput.mcpServers` is non-empty
- **THEN** the adapter adds each server to `config.mcp_servers` alongside `agenthub`
- **AND** omits absent optional fields instead of passing `null`, which the Codex SDK's TOML serializer rejects.

#### Scenario: No servers are selected
- **WHEN** an agent selects no external MCP servers
- **THEN** adapter behaviour is unchanged from before this capability existed.
