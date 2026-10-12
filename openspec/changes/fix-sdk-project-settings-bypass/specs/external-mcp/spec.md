# External MCP Delta

## MODIFIED Requirements

### Requirement: MCP server trust SHALL gate tool execution — D1

A server's `trust` MUST determine whether its tools execute freely or require approval. `trust = 'always'` MUST be the only value that executes without a prompt, and `trust = 'ask'` (the default) MUST require approval. A workspace-resident settings file MUST NOT be able to grant that approval in advance.

#### Scenario: Untrusted server tool is called for the first time
- **WHEN** the model calls a tool on a server with `trust = 'ask'` for the first time in a conversation
- **THEN** AgentHub requests user approval before executing
- **AND** records the approval for that tool in that conversation.

#### Scenario: Previously approved tool is called again
- **WHEN** the same tool is called again in the same conversation
- **THEN** it executes without another prompt
- **AND** a new conversation prompts again.

#### Scenario: Approval is denied
- **WHEN** the user denies the approval request
- **THEN** that call returns an error result to the model
- **AND** the run continues.

#### Scenario: Trusted server tool is called
- **WHEN** a tool on a server with `trust = 'always'` is called
- **THEN** it executes without a prompt.

#### Scenario: Workspace settings try to pre-approve an external tool
- **WHEN** the workspace contains a settings file allowing `mcp__<server>__<tool>`
- **THEN** the `trust = 'ask'` gate still requests approval
- **AND** the call executes without a prompt only if `trust = 'always'` or the tool is already approved in this conversation.
