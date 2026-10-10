# Platform Security

## Purpose

Defines cross-platform shell, path, sandbox, and process safety rules. Detailed platform notes live in `specs/11-platform.md`.

## Requirements

### Requirement: Platform detection SHALL drive shell behavior

AgentHub MUST select shell command conventions and tool descriptions based on the current host platform.

#### Scenario: Host is POSIX
- **WHEN** AgentHub executes an AgentHub-managed bash command
- **THEN** it SHOULD use the user's login zsh/bash shell when available
- **AND** it MUST fall back to a POSIX-compatible shell invocation when the user shell cannot be resolved safely.

#### Scenario: Host is Windows
- **WHEN** bash-like tool descriptions are built
- **THEN** they use PowerShell-oriented examples and Windows blacklist language.

### Requirement: Path safety SHALL be platform-aware

Workspace path checks MUST handle case sensitivity, path separators, drive roots, and sensitive directories according to host platform.

#### Scenario: Windows path case differs
- **WHEN** a path differs only by drive-letter case
- **THEN** containment checks still evaluate correctly.

### Requirement: Command blacklist SHALL be shared

POSIX and Windows banned command patterns MUST be defined in one shared server security module and used by both tools and SDK approval bridges where applicable.

#### Scenario: Claude Code asks to run a banned command
- **WHEN** the Bash tool approval includes a matching command
- **THEN** the adapter denies the tool use.

### Requirement: Child processes SHALL be cleaned up

Long-running child processes spawned by tool or SDK boundaries — including user-registered stdio MCP servers — MUST be aborted or terminated when the owning run or app shuts down, as a process tree where the platform requires it.

#### Scenario: User aborts a run
- **WHEN** the run AbortSignal fires
- **THEN** active tool or SDK work receives cancellation.

#### Scenario: Aborting a run with a live stdio MCP server
- **WHEN** a stdio MCP server child process is running and the run aborts
- **THEN** the child and its descendants are terminated
- **AND** on Windows this uses a tree kill rather than a single-process signal.

#### Scenario: Process tree termination is needed outside the bash tool
- **WHEN** any module must terminate a spawned process tree
- **THEN** it uses one shared implementation rather than a private copy.

### Requirement: SDK child process environment SHALL preserve required host basics

Child process environments MUST preserve required values such as PATH and HOME/USERPROFILE while applying adapter-specific isolation. A user-registered stdio MCP server is spawned with the shared child environment builder, so it inherits the parent environment; this MUST be stated wherever the external MCP security model is described.

#### Scenario: Codex runs on Windows
- **WHEN** HOME is missing and USERPROFILE exists
- **THEN** the child env receives a HOME fallback.

#### Scenario: A third-party stdio MCP server starts
- **WHEN** AgentHub spawns a user-registered stdio MCP server
- **THEN** the child receives the same inherited environment as other AgentHub child processes, plus the values the server declares
- **AND** the security documentation states that AgentHub's provider keys and internal tokens are therefore readable by that server.

### Requirement: External MCP SHALL be recognized as outside AgentHub's isolation guarantees

Documentation and specs MUST state that external MCP servers run arbitrary code or reach external networks with the application's privileges, bypassing the workspace path sandbox and the command blacklist.

#### Scenario: User reads security documentation
- **WHEN** a user consults the security or feature documentation about external MCP
- **THEN** it states that such servers are outside AgentHub's sandbox guarantee
- **AND** describes the opt-in steps that constrain them.

#### Scenario: A stdio command is registered
- **WHEN** a user supplies a command for a stdio server
- **THEN** the command is displayed in full so the user grants informed consent
- **AND** no hard-coded allowlist is presented as the protection mechanism.
