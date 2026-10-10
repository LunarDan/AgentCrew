# Persistence

## Purpose

Defines SQLite/Drizzle physical schema and key storage. Detailed schema notes live in `specs/08-db-schema.md`.

## Requirements

### Requirement: Database schema SHALL map domain entities

The SQLite schema MUST persist agents, conversations, messages, artifacts, workspaces, attachments, agent runs, context summaries, app settings, and MCP server registrations.

#### Scenario: New conversation is created
- **WHEN** a conversation is inserted
- **THEN** a workspace row is created or associated
- **AND** messages and runs can reference the conversation id.

#### Scenario: Schema change is applied
- **WHEN** `src/db/schema.ts` gains a table or column
- **THEN** the same DDL is mirrored into `src/db/bootstrap.ts` so packaged desktop builds create it
- **AND** `pnpm db:push` is run.

### Requirement: JSON columns SHALL store typed unions

JSON columns such as `messages.parts`, `artifacts.content`, and usage payloads MUST correspond to TypeScript union types in shared code.

#### Scenario: Message parts are loaded
- **WHEN** the UI fetches messages
- **THEN** each part can be rendered by its discriminant without ad hoc parsing.

### Requirement: API keys SHALL follow defined precedence

Runtime keys MUST resolve in this order: per-agent key, app settings key, environment key, and provider-specific SDK fallback where documented.

#### Scenario: Agent has a custom key
- **WHEN** `agents.api_key` is non-empty
- **THEN** AgentRunner uses it instead of app settings or environment variables.

### Requirement: Base URLs SHALL be adapter-specific

`agents.api_base_url` MUST be interpreted according to adapter protocol: Anthropic-compatible for Claude Code and Codex/Responses-compatible for Codex.

#### Scenario: Codex base URL is set
- **WHEN** a Codex agent has `api_base_url`
- **THEN** it is passed to Codex SDK as `baseUrl`
- **AND** it must not be sourced from global CC Switch config.

### Requirement: App settings SHALL remain local single-user storage

Global API settings MUST be stored in the single-row `app_settings` table and SHALL not introduce OS keychain dependencies in the current local single-user model.

#### Scenario: User saves OpenAI key in settings
- **WHEN** the settings API receives the key
- **THEN** it normalizes empty strings to null
- **AND** stores the value in SQLite.

#### Scenario: User saves external deployment publishing settings
- **WHEN** the settings API receives `deployment_publish_enabled`, `deployment_publish_dir`, or `deployment_public_base_url`
- **THEN** it normalizes empty strings to null
- **AND** stores the values in the single `app_settings` row.

### Requirement: MCP server registrations SHALL be stored as global rows

MCP servers MUST be stored in a `mcp_servers` table addressed by id, with a unique `name`, a `transport` of `stdio`, `sse`, or `http`, transport-specific connection fields, a `trust` level, and an `enabled` flag defaulting to false. Agents MUST reference servers through a `mcp_server_ids` JSON array on the `agents` table.

#### Scenario: Server row is created
- **WHEN** a user registers an MCP server
- **THEN** a row is inserted with a generated `mcp_` id and `enabled = false`
- **AND** its `name` is unique across the table.

#### Scenario: Server row is loaded by an agent
- **WHEN** a run resolves an agent's MCP servers
- **THEN** the agent's `mcp_server_ids` are intersected with existing, enabled rows
- **AND** ids that no longer exist are skipped.

#### Scenario: Agent row gains the column on an existing database
- **WHEN** an existing database is opened after this change
- **THEN** `agents.mcp_server_ids` and the `mcp_servers` table exist
- **AND** existing agents read as having no MCP servers selected.

### Requirement: MCP secret columns SHALL follow the same local-storage model as app settings

MCP `env` and `headers` values MUST be stored in the database with the same no-keychain trade-off applied to global API keys, and MUST be returned to clients only in masked form.

#### Scenario: Server with secrets is read back
- **WHEN** the client fetches the server list
- **THEN** secret values are masked in the response
- **AND** plaintext values remain only in the database.

#### Scenario: Secret is expressed as a placeholder
- **WHEN** a secret value is written as `${ENV_NAME}`
- **THEN** the database stores the placeholder text
- **AND** resolution happens at run start from the process environment.
