# Adapters Delta

## ADDED Requirements

### Requirement: CustomAgentAdapter SHALL route external MCP tools inside its tool loop

When `AdapterInput.mcpServers` is non-empty, the custom adapter MUST merge external tools into the OpenAI function list alongside the built-in tools, execute a model tool call on the owning MCP server, and translate the result back into `tool.call` / `tool.result` without changing the existing loop contract.

External function names MUST be derived from `mcp__<server>__<tool>` and MUST satisfy the OpenAI-compatible function-name constraint. Routing MUST use a runtime mapping from the exposed name to the original server and tool rather than re-parsing the exposed name.

#### Scenario: Built-in and external tools are both offered
- **WHEN** a custom run has built-in tools and external MCP tools
- **THEN** the model's `tools` array contains both
- **AND** built-in tool names take precedence on a name collision.

#### Scenario: The model calls an external tool
- **WHEN** the model emits a function call for an exposed MCP tool name
- **THEN** the adapter calls the owning server's tool with the parsed arguments
- **AND** emits `tool.call` before the call and `tool.result` after it
- **AND** appends the result as a `role: 'tool'` message for the next turn.

#### Scenario: An external tool name is not provider-safe
- **WHEN** the namespaced name contains characters outside `[A-Za-z0-9_-]` or exceeds 64 characters
- **THEN** the adapter exposes a sanitized name
- **AND** the runtime mapping still resolves it to the original server and tool.

#### Scenario: An untrusted external tool is called
- **WHEN** the server's `trust` is `ask` and the tool has not been approved in this conversation
- **THEN** the adapter waits for the shared MCP approval queue before calling the server
- **AND** a denial produces an error result and does not execute the tool.

#### Scenario: The external call fails
- **WHEN** the MCP server returns an error or the call times out
- **THEN** the adapter emits `tool.result` with `isError: true`
- **AND** the tool loop continues.
