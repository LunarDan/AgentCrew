# Frontend Delta

## ADDED Requirements

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
