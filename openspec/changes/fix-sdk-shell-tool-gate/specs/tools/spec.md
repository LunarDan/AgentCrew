# Tools Delta

## ADDED Requirements

### Requirement: The shell tool SHALL be identified by identity, not by a platform literal

An SDK adapter MUST apply its command blacklist and critical-command approval policy to every shell tool call the runtime exposes, regardless of the name that runtime gives the tool. Identification MUST NOT rely on a single platform-specific literal. A call whose identity cannot be determined MUST NOT fall through to the default-allow path.

#### Scenario: The runtime names its shell tool something other than Bash
- **WHEN** the runtime offers its shell tool under a different name (for example `PowerShell` on Windows)
- **THEN** a call to that tool still reaches the command blacklist and approval policy
- **AND** the call executes only if that policy allows it.

#### Scenario: A shell tool is renamed by a runtime upgrade
- **WHEN** the tool name is not in the known set but appears in the tool table the runtime reported for the run
- **AND** its input carries a non-empty command
- **THEN** it is treated as a shell call.

#### Scenario: An external MCP tool takes a command argument
- **WHEN** the tool name starts with `mcp__`
- **THEN** it is not treated as a shell call
- **AND** its external-MCP trust policy decides the outcome.

#### Scenario: A known shell tool arrives with unparseable input
- **WHEN** a known shell tool name is called without a command string the adapter can read
- **THEN** the call is denied
- **AND** it is not allowed by default.
