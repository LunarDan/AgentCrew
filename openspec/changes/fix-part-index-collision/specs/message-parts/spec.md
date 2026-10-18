# Message Parts Delta

## ADDED Requirements

### Requirement: Parts SHALL keep their order under tool activity

The `parts` array MUST be a dense, ordered list in which a `tool_use` part is never overwritten by a later text or thinking part, and every `tool_result` part is preceded by a `tool_use` with the same `callId`.

#### Scenario: A completed run interleaves text and tools
- **WHEN** a run emits text, then a tool call and its result, then more text, all within one message
- **THEN** the message's `parts` contains every one of those parts in emission order
- **AND** no `tool_use` part is missing
- **AND** no `tool_result` part is left without its `tool_use`.
