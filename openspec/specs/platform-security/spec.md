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

#### Scenario: A symlink or junction points outside the workspace
- **WHEN** a path lexically inside the workspace resolves, through a symbolic link, directory symlink, or NTFS junction, to a location outside the effective cwd
- **THEN** the path is rejected as outside the workspace
- **AND** this holds for writes to targets that do not exist yet.

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

#### Scenario: A process ignores graceful termination
- **WHEN** a POSIX process tree is still alive 5 seconds after the graceful signal
- **THEN** the remaining process group or tracked pids are sent SIGKILL
- **AND** on Windows the tree is terminated forcibly in the first place.

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

### Requirement: SDK child processes SHALL start without filesystem settings sources

An SDK child process MUST be started so that no workspace-resident settings source is loaded: no project settings, no project hooks, no project MCP configuration, and no project plugins, skills, or custom commands. Project-level configuration MUST NOT cause a command to execute on the host.

#### Scenario: The workspace declares a project hook
- **WHEN** the workspace contains a settings file declaring a hook
- **THEN** the hook does not run during an AgentHub run.

#### Scenario: Administrator-managed settings remain in effect
- **WHEN** the host has administrator-managed settings
- **THEN** those continue to apply to the run
- **AND** only workspace-resident sources are excluded.

#### Scenario: A workspace file declares an MCP server
- **WHEN** the workspace contains an MCP configuration file
- **THEN** no server is started from it
- **AND** the run's MCP servers come only from what the adapter supplied.

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
