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

ClaudeCodeAdapter MUST use `@anthropic-ai/claude-agent-sdk` and route supported tool approvals through AgentHub path checks, pending writes, and command blacklist policy.

#### Scenario: Claude Code proposes a file write in review mode
- **WHEN** the SDK asks to use a write/edit tool
- **THEN** the adapter creates a pending write
- **AND** waits for user approval before allowing the SDK tool.

### Requirement: CodexAdapter SHALL use the Codex SDK

CodexAdapter MUST use `@openai/codex-sdk` `runStreamed()` rather than treating CLI spawn as the primary integration path.

#### Scenario: Codex run starts
- **WHEN** a Codex agent receives a prompt
- **THEN** the adapter starts or resumes a Codex thread
- **AND** translates thread, item, tool, and usage events into StreamEvent.

### Requirement: SDK adapters SHALL expose allowlisted AgentHub tools through MCP

Claude Code and Codex adapters MUST expose allowlisted AgentHub tools through adapter-owned MCP bridges rather than consuming per-agent `toolNames`.

#### Scenario: Codex creates and deploys an artifact or workspace build
- **WHEN** Codex calls the AgentHub MCP `write_artifact`, `deploy_artifact`, or `deploy_workspace` tool
- **THEN** the adapter translates the MCP result into `artifact.create` or `deploy.status`.

#### Scenario: SDK agent asks a structured user question
- **WHEN** Claude Code or Codex calls the AgentHub MCP `ask_user` tool
- **THEN** AgentHub routes it through the shared pending question flow.

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
