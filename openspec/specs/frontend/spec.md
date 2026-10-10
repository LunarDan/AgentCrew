# Frontend

## Purpose

Defines client state, event application, and major UI boundaries. Detailed frontend notes live in `specs/09-frontend-architecture.md`.

## Requirements

### Requirement: Frontend SHALL consume server APIs and SSE

The frontend MUST use REST routes and SSE stream events; it SHALL not import or call LLM SDKs directly.

#### Scenario: User sends a message
- **WHEN** the UI posts to the messages API
- **THEN** server-side AgentRunner invokes the adapter
- **AND** UI updates arrive through SSE events.

### Requirement: Store reducers SHALL apply StreamEvent deterministically

Zustand reducers MUST update conversation, message, artifact, pending write, pending bash command, dispatch, and usage state from `StreamEvent` payloads.

#### Scenario: `part.delta` arrives
- **WHEN** the event references an existing part
- **THEN** the store appends content to that part without reordering other parts.

#### Scenario: A failed run leaves an open tool call
- **WHEN** `run.end` arrives with `status='failed'` or `status='aborted'`
- **THEN** the store marks streaming messages from that run as terminal
- **AND** appends local error `tool_result` parts for any unmatched `tool_use` call ids.

### Requirement: Artifact preview SHALL be separate from chat rendering

The UI MUST render artifact previews in a dedicated panel and render chat artifact references as cards or links.

#### Scenario: User clicks artifact ref
- **WHEN** an `artifact_ref` part is selected
- **THEN** the preview panel opens the referenced artifact.

### Requirement: Preview URLs SHALL be one-click actions

For `web_app` artifacts and ready deployment status parts, the UI MUST provide open and copy actions for the preview URL. Deployment cards SHOULD distinguish local previews from externally published static deployments.

#### Scenario: Deployment card is ready
- **WHEN** a `deploy_status` part has `status='ready'`
- **THEN** the chat renders a deployment card with open and copy controls.

#### Scenario: Deployment card has external publish metadata
- **WHEN** a `deploy_status` part has `deploymentType='external_static'`
- **THEN** the card labels it as an external static publish
- **AND** shows the local preview fallback when available.

### Requirement: Agent builder SHALL expose adapter-specific fields

Create/edit agent UI MUST show provider, model, tool, key, and base URL fields according to selected adapter semantics.

#### Scenario: User selects Codex adapter
- **WHEN** `adapterKind='codex'`
- **THEN** provider and AgentHub tool checkboxes are hidden
- **AND** Base URL copy says it must support Codex/Responses.

### Requirement: Settings SHALL manage external MCP servers

The settings dialog MUST provide a section to register, edit, enable, disable, delete, and test external MCP servers. Because this section manages a list of entities with per-row actions, it MUST NOT be forced into the dialog's shared single-save footer.

#### Scenario: User adds a server
- **WHEN** a user submits the registration form with a valid name and transport configuration
- **THEN** the server is created disabled
- **AND** appears in the list without a full-page reload.

#### Scenario: User tests a server
- **WHEN** a user triggers the connection test
- **THEN** the UI reports success with the discovered tool names, or the failure reason
- **AND** a slow or hanging server does not block the dialog.

#### Scenario: Existing scalar settings are unaffected
- **WHEN** the MCP section is opened and closed without changes
- **THEN** saving the dialog does not mutate unrelated settings.

### Requirement: The settings UI SHALL state what a registered server can do

The MCP section MUST state that registered servers run outside AgentHub's workspace sandbox and command blacklist **and** that a stdio server inherits AgentHub's process environment, so it can read stored credentials such as provider API keys. Registration MUST require an explicit trust confirmation showing the full command, arguments, and environment keys.

#### Scenario: User registers a stdio server
- **WHEN** the user fills in a command and arguments
- **THEN** the complete command line and environment keys are displayed before submission
- **AND** both the sandbox bypass and the credential readability are stated
- **AND** submission requires an explicit confirmation of trust.

#### Scenario: Trust level is displayed
- **WHEN** a server is listed
- **THEN** its `trust` level is shown alongside what it actually means for that server
- **AND** a level that is not enforced for the server's adapter is not presented as an active protection.

### Requirement: Masked MCP secrets SHALL round-trip without data loss

The edit form MUST be able to submit without resending secret values, so that saving an unrelated change does not overwrite stored secrets with their masked preview.

#### Scenario: User edits only the server name
- **WHEN** the form is submitted without touching the secret fields
- **THEN** the stored secrets are preserved unchanged.
