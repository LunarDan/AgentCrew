# Tools Delta

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: SDK tool sets SHALL be documented separately

SDK adapters MUST receive their tool set from the adapter/SDK rather than per-agent `toolNames`. This requirement governs **AgentHub-provided** tools only; user-registered external MCP servers are a separate, explicitly opted-in mechanism and MUST NOT be treated as part of the SDK tool set.

#### Scenario: SDK agent receives AgentHub MCP tools
- **WHEN** a Claude Code or Codex agent runs
- **THEN** the injected guidance includes the allowlisted AgentHub MCP tools exposed by that adapter

#### Scenario: SDK agent is restricted to its allowlist
- **WHEN** a Claude Code or Codex agent runs
- **THEN** its built-in AgentHub tool set is still taken from the adapter rather than from `toolNames`
- **AND** external MCP servers, if any are selected, are added on top of that set rather than substituting for it.
