# Stream Events Delta

## ADDED Requirements

### Requirement: AgentRunner SHALL own message part slot assignment

The `partIndex` on `part.start` / `part.delta` / `part.end` MUST be treated as a stream-local ordinal owned by the emitting adapter, **not** as an index into `messages.parts`. AgentRunner MUST translate that ordinal to a real `parts` slot before persisting the event and before publishing it to SSE, so that a part started after a tool event cannot overwrite the `tool_use` / `tool_result` part AgentRunner appended for the same message. The slot published MUST be the slot persisted.

#### Scenario: Text follows a tool call in the same message
- **WHEN** an adapter appends a tool call for a message
- **AND** then starts a text part on the same message using the next ordinal of its own counter
- **THEN** AgentRunner assigns the text part a slot after the appended `tool_use` / `tool_result` parts
- **AND** the persisted `parts` retains the tool call and its result alongside the text
- **AND** subscribers receive the same slot AgentRunner persisted.

#### Scenario: A later delta addresses the part it belongs to
- **WHEN** a `part.delta` arrives carrying an ordinal that has already been assigned a slot
- **THEN** AgentRunner applies the delta to that same slot.

#### Scenario: Slot bookkeeping is scoped to the run
- **WHEN** a run ends, fails, or is aborted
- **THEN** the ordinal-to-slot mapping is discarded with no effect on other runs or conversations.
