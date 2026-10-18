# Platform Security Delta

## ADDED Requirements

### Requirement: The command blacklist and approval classifier SHALL apply on every host platform

The command blacklist and the critical-command approval classifier MUST be consulted for every shell command a Claude Code agent proposes, on every host platform. A platform difference in what the runtime calls its shell tool MUST NOT remove the gate.

#### Scenario: The host is Windows
- **WHEN** a Claude Code agent runs on a Windows host whose runtime exposes the shell under a name other than `Bash`
- **THEN** a command matching a Windows blacklist rule is denied
- **AND** a command matching a Windows approval rule requires user approval before it executes.

#### Scenario: The runtime's shell tool name is unknown
- **WHEN** the adapter cannot map the runtime's tool name to a known shell name
- **AND** a submitted command is classified as critical
- **THEN** the approval prompt still appears
- **AND** the run does not proceed on the assumption that the tool is harmless.

#### Scenario: A non-command tool is used
- **WHEN** the agent calls a tool that does not accept a command
- **THEN** no command approval prompt is created.
