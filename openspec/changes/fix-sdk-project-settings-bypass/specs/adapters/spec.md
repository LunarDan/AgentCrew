# Adapters Delta

## MODIFIED Requirements

### Requirement: ClaudeCodeAdapter SHALL bridge SDK tool approvals

ClaudeCodeAdapter MUST use `@anthropic-ai/claude-agent-sdk` and route supported tool approvals through AgentHub path checks, pending writes, and command blacklist policy. It MUST start the SDK so that no filesystem settings source in the workspace is loaded, because a workspace `permissions.allow` entry is evaluated by the CLI before the approval callback and would bypass this bridge entirely.

#### Scenario: Claude Code proposes a file write in review mode
- **WHEN** the SDK asks to use a write/edit tool
- **THEN** the adapter creates a pending write
- **AND** waits for user approval before allowing the SDK tool.

#### Scenario: The workspace tries to pre-approve a tool
- **WHEN** the workspace contains a settings file allowing the tool
- **THEN** the SDK still asks the adapter
- **AND** the workspace file has no effect on the outcome.

## ADDED Requirements

### Requirement: The Claude Code adapter SHALL own project memory

Because the SDK cannot load project `CLAUDE.md` without also loading project settings, the adapter MUST read project memory itself. It MUST read only `<effectiveCwd>/CLAUDE.md`, MUST cap how much it injects, and MUST mark the injected text as workspace content rather than user instruction.

#### Scenario: The effective cwd has a CLAUDE.md
- **WHEN** a run starts and `<effectiveCwd>/CLAUDE.md` exists and is non-blank
- **THEN** its content is appended to the system prompt together with the file's absolute path
- **AND** it is labelled as workspace content.

#### Scenario: There is nothing to read
- **WHEN** the file is absent, unreadable, a directory, or blank
- **THEN** the system prompt is exactly the agent's own prompt
- **AND** the run is not failed because of it.

#### Scenario: Project memory is oversized
- **WHEN** the file exceeds the adapter's character cap
- **THEN** the injected text is truncated at a line boundary
- **AND** carries a visible truncation marker.

#### Scenario: Project configuration beyond the memory file
- **WHEN** the workspace contains `.claude/rules/`, `CLAUDE.local.md`, a parent-directory `CLAUDE.md`, or `@import` directives
- **THEN** none of them is loaded
- **AND** no documentation claims they are.
