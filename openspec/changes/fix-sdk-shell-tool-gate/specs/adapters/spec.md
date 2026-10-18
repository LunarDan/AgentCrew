# Adapters Delta

## MODIFIED Requirements

### Requirement: ClaudeCodeAdapter SHALL bridge SDK tool approvals

ClaudeCodeAdapter MUST use `@anthropic-ai/claude-agent-sdk` and route supported tool approvals through AgentHub path checks, pending writes, and command blacklist policy. It MUST start the SDK so that no filesystem settings source in the workspace is loaded, because a workspace `permissions.allow` entry is evaluated by the CLI before the approval callback and would bypass this bridge entirely. It MUST identify shell tool calls from the run's own reported tool table and a known-name set rather than assuming one platform's literal name, so the blacklist and critical-command approval policy apply wherever the SDK exposes a shell.

#### Scenario: Claude Code proposes a file write in review mode
- **WHEN** the SDK asks to use a write/edit tool
- **THEN** the adapter creates a pending write
- **AND** waits for user approval before allowing the SDK tool.

#### Scenario: The workspace tries to pre-approve a tool
- **WHEN** the workspace contains a settings file allowing the tool
- **THEN** the SDK still asks the adapter
- **AND** the workspace file has no effect on the outcome.

#### Scenario: The SDK's shell tool is not named Bash
- **WHEN** the run's reported tool table contains a shell tool under another name
- **THEN** the adapter applies the command blacklist and approval policy to its calls
- **AND** does not fall through to default allow.

#### Scenario: The tool table has not been observed
- **WHEN** a call arrives before the adapter has read the run's tool table
- **THEN** a known shell name is gated by name
- **AND** an unrecognized name carrying a command is gated rather than allowed.
