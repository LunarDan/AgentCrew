# Adapters

## Purpose

Defines the AgentPlatformAdapter contract and provider-specific boundaries. Detailed adapter notes live in `specs/05-adapter-interface.md`.

## Requirements

### Requirement: Adapters SHALL translate provider output to StreamEvent

Each adapter MUST expose `stream(input, signal)` and yield only AgentHub `StreamEvent` objects to the application layer.

#### Scenario: Custom model emits tool calls
- **WHEN** Chat Completions streaming returns function tool call deltas
- **THEN** CustomAgentAdapter accumulates arguments
- **AND** emits AgentHub `tool.call` and `tool.result` events.

### Requirement: CustomAgentAdapter SHALL use Chat Completions compatible providers

CustomAgentAdapter SHALL call OpenAI Chat Completions-compatible endpoints for DeepSeek, OpenAI, and Volcano Ark, with provider-specific base URLs and keys.

#### Scenario: DeepSeek model responds with reasoning
- **WHEN** DeepSeek streams `reasoning_content`
- **THEN** the adapter emits thinking parts
- **AND** includes reasoning content in the assistant message for subsequent turns.

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

### Requirement: CodexAdapter SHALL use the Codex SDK

CodexAdapter MUST use `@openai/codex-sdk` `runStreamed()` rather than treating CLI spawn as the primary integration path.

#### Scenario: Codex run starts
- **WHEN** a Codex agent receives a prompt
- **THEN** the adapter starts or resumes a Codex thread
- **AND** translates thread, item, tool, and usage events into StreamEvent.

### Requirement: SDK adapters SHALL expose allowlisted AgentHub tools through MCP

Claude Code and Codex adapters MUST expose allowlisted AgentHub tools through adapter-owned MCP bridges rather than consuming per-agent `toolNames`. The `agenthub` bridge MUST remain present and functional when user-registered external MCP servers are also attached to the same run.

#### Scenario: Codex creates and deploys an artifact or workspace build
- **WHEN** Codex calls the AgentHub MCP `write_artifact`, `deploy_artifact`, or `deploy_workspace` tool
- **THEN** the adapter translates the MCP result into `artifact.create` or `deploy.status`.

#### Scenario: SDK agent asks a structured user question
- **WHEN** Claude Code or Codex calls the AgentHub MCP `ask_user` tool
- **THEN** AgentHub routes it through the shared pending question flow.

#### Scenario: External servers share the run with the AgentHub bridge
- **WHEN** an agent selects one or more external MCP servers
- **THEN** the adapter configures them alongside `agenthub` rather than replacing it
- **AND** AgentHub's own artifact, deploy, and question tools remain available.

### Requirement: MockAdapter SHALL provide deterministic scripted scenarios for E2E

MockAdapter MUST run without any LLM call and MUST be deterministic for a given input, so end-to-end tests can assert message, artifact, and dispatch flows without provider access.

#### Scenario: Mock agent produces a real artifact
- **WHEN** the prompt matches the artifact scenario keywords AND the agent's `tool_names` include `write_artifact`
- **THEN** the adapter executes `write_artifact` through the shared tool registry
- **AND** emits `tool.call`, `tool.result`, and `artifact.create` so the message gets an artifact card

#### Scenario: Mock agent plays the orchestrator three stages
- **WHEN** the adapter runs with `plan_tasks` in `toolNames`
- **THEN** it emits one `plan_tasks` tool call built from the agent ids in the plan system prompt
- **AND** when it later runs in the aggregate stage it emits a summary instead of dispatching again
- **AND** child sub-task runs emit a `report_task_result` report so completion gates can pass

#### Scenario: Mock child task honours the artifact handoff contract
- **WHEN** a dispatched child prompt declares a non-project expected output
- **THEN** the mock child writes that artifact with `outputKey` equal to the declared output id
- **AND** a child that receives an upstream artifact echoes the injected `artifactId` in its reply

### Requirement: Codex Base URL SHALL be Responses compatible

CodexAdapter MUST only accept Codex/Responses-compatible endpoints for `apiBaseUrl`; Chat Completions-only providers such as DeepSeek MUST be rejected or reported with a clear compatibility error.

#### Scenario: User configures DeepSeek for Codex
- **WHEN** `apiBaseUrl` points at `api.deepseek.com`
- **THEN** the adapter rejects the run before reconnect loops
- **AND** the error tells the user to use CustomAgentAdapter.

### Requirement: SDK runtime configuration SHALL be isolated

CodexAdapter MUST set `CODEX_HOME` and `CODEX_SQLITE_HOME` to AgentHub-managed data paths and strip unrelated external `CODEX_*` variables except certificate configuration.

#### Scenario: User has CC Switch configured locally
- **WHEN** AgentHub starts Codex SDK
- **THEN** the child runtime does not read the user's `~/.codex` config
- **AND** AgentHub per-agent settings determine key and base URL.

### Requirement: Adapters SHALL consume resolved external MCP servers from AdapterInput

`AdapterInput` MUST carry the run's resolved external MCP servers as plain configuration. Adapters MUST translate that structure into their SDK's native MCP configuration and MUST NOT read the database or resolve placeholders themselves.

#### Scenario: Claude Code adapter receives external servers
- **WHEN** `AdapterInput.mcpServers` is non-empty
- **THEN** the adapter maps each server to its SDK MCP config shape
- **AND** passes them in the `mcpServers` option together with the `agenthub` bridge.

#### Scenario: Codex adapter receives external servers
- **WHEN** `AdapterInput.mcpServers` is non-empty
- **THEN** the adapter adds each server to `config.mcp_servers` alongside `agenthub`
- **AND** omits absent optional fields instead of passing `null`, which the Codex SDK's TOML serializer rejects.

#### Scenario: No servers are selected
- **WHEN** an agent selects no external MCP servers
- **THEN** adapter behaviour is unchanged from before this capability existed.
