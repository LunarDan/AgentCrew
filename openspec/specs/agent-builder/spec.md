# Agent Builder

## Purpose

Defines how users create and edit non-orchestrator agents from the UI. Detailed behavior lives in `specs/10-agent-builder.md`.

## Requirements

### Requirement: User-created agents SHALL default to Custom adapter

New agents MUST default to `adapterName='custom'` unless the user selects Claude Code or Codex SDK adapter.

#### Scenario: User opens create dialog
- **WHEN** no existing agent is being edited
- **THEN** adapter kind defaults to Custom
- **AND** provider defaults to DeepSeek.

### Requirement: New custom agents SHALL start with an editable harness prompt

The create dialog MUST prefill `systemPrompt` with a concise Custom agent scaffold that explains goal handling, context loading, tool use, artifact output, workspace safety, and final response expectations.

#### Scenario: User opens create dialog
- **WHEN** no existing agent is being edited
- **THEN** the System Prompt field contains the default Custom agent scaffold
- **AND** the user can edit or replace it before saving.

### Requirement: Custom agents SHALL require provider and model

Custom agents MUST have `modelProvider` and a non-empty `modelId`; SDK agents SHALL ignore `modelProvider`.

#### Scenario: User clears custom model id
- **WHEN** adapter kind is Custom
- **THEN** form submission is rejected.

### Requirement: SDK agents SHALL use built-in tool sets

Claude Code and Codex agents MUST persist `toolNames=[]` because their tools come from the SDK runtime rather than AgentHub `toolRegistry`.

#### Scenario: User switches from Custom to Codex
- **WHEN** the form is submitted
- **THEN** the saved agent has no custom tool names.

### Requirement: Custom agents SHALL expose structured question tooling

The agent builder MUST allow custom agents to enable `ask_user`, and newly created custom agents SHOULD include it in the default tool set.

#### Scenario: User creates a custom agent
- **WHEN** the create dialog opens for a Custom adapter agent
- **THEN** `ask_user` is available in the tool checklist
- **AND** it is selected by default.

### Requirement: Custom agents SHALL provide tool presets

The agent builder MUST provide one-click tool presets for common custom-agent roles, including all-purpose, local-code, artifact, and review workflows.

#### Scenario: User selects local-code preset
- **WHEN** the user clicks the local-code tool preset
- **THEN** the selected tools include `deploy_workspace`, `read_artifact`, `fs_read`, `fs_write`, and `bash`
- **AND** artifact creation tools are not selected unless the user adds them manually.

#### Scenario: User creates a custom agent
- **WHEN** the create dialog opens for a Custom adapter agent
- **THEN** the default preset is all-purpose
- **AND** both artifact tools and local workspace file/command tools are selected.

### Requirement: Codex agent configuration SHALL reject unsupported base URLs

The agent builder MUST validate known unsupported Codex base URLs before saving or running the agent.

#### Scenario: DeepSeek URL is entered for Codex
- **WHEN** the Base URL host is `api.deepseek.com`
- **THEN** the UI shows a Codex/Responses compatibility error.

### Requirement: API key hints SHALL match adapter fallback

The UI MUST display key fallback hints that match AgentRunner's key resolution for selected adapter/provider.

#### Scenario: Codex key field is empty
- **WHEN** a Codex agent is saved without per-agent key
- **THEN** runtime falls back to app OpenAI key, `CODEX_API_KEY`, or `OPENAI_API_KEY`.

### Requirement: Agents SHALL select external MCP servers independently of toolNames

The agent builder MUST let a user select zero or more registered MCP servers for an agent, stored as `mcpServerIds`. This selection MUST be independent of `toolNames` and MUST NOT be cleared for SDK adapters.

#### Scenario: Claude Code agent selects MCP servers
- **WHEN** a user selects two MCP servers on a `claude-code` agent and saves
- **THEN** the persisted agent has both ids in `mcpServerIds`
- **AND** the SDK-adapter rule that empties `toolNames` does not empty `mcpServerIds`.

#### Scenario: Custom agent selects MCP servers
- **WHEN** a user selects MCP servers on a `custom` agent
- **THEN** the selection is persisted
- **AND** the servers do not participate in runs until the custom adapter's MCP client exists.

### Requirement: The MCP picker SHALL only offer servers the agent's adapter can run

The picker MUST present servers compatible with the selected adapter, and MUST reject or clearly flag an incompatible transport pairing.

#### Scenario: SSE server on a Codex agent
- **WHEN** the selected adapter is `codex` and a server uses the `sse` transport
- **THEN** that server is not offered, or is offered as unavailable with the reason shown.

#### Scenario: Adapter is changed after selection
- **WHEN** a user selects a Codex-incompatible server and then switches the adapter to `codex`
- **THEN** the conflicting selection is surfaced before saving.

### Requirement: Agent details SHALL show selected MCP servers by name

The agent info popover MUST resolve selected server ids to display names so a user can see which external servers an agent can reach.

#### Scenario: Popover is opened for an agent with MCP servers
- **WHEN** the agent has non-empty `mcpServerIds`
- **THEN** the popover lists the resolved server names
- **AND** an id with no matching row is not rendered as a raw id.

### Requirement: Agent configurations SHALL be exportable and importable without secrets

AgentHub MUST export an agent configuration as a versioned JSON document and MUST import such a document by validating it before use. Exports MUST NOT contain `apiKey`, `apiBaseUrl`, installation-local ids (agent id, MCP server ids), or runtime flags. Import MUST open the create form prefilled with the validated configuration so the user can review it and supply any required credentials before saving.

#### Scenario: Exporting an agent with a per-agent key
- **WHEN** the user exports an agent whose row has `apiKey` and `apiBaseUrl`
- **THEN** the JSON contains identity, prompt, adapter, model, tool names, and vision settings
- **AND** it contains no API key or base URL.

#### Scenario: Importing a malformed file
- **WHEN** the selected file is not valid JSON, uses an unknown format/version, or fails schema validation
- **THEN** the import is rejected with a readable error
- **AND** no agent is created.

#### Scenario: Importing a valid file
- **WHEN** the user imports a valid v1 document
- **THEN** the create dialog opens prefilled with its fields
- **AND** no agent exists until the user submits the form.
