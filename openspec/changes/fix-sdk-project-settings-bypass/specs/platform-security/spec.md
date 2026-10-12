# Platform Security Delta

## ADDED Requirements

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
