# Glossary

- **same-name override**: Calling `pi.registerTool` with a built-in tool name (such as `bash` or `eval`), copying its schema and execution metadata, and delegating execution to the native built-in via `ctx.invokeTool`.
- **turn group**: All `bash` and `eval` tool calls occurring after the latest `role: "user"` message entry (or `before_agent_start` boundary) and before the next user message.
- **summary line**: The single-line ANSI TUI component rendered by the first `bash` or `eval` tool call in a **turn group**, dynamically reflecting total `bash` and `eval` counts across the turn group when collapsed.
- **branch fallback**: Rebuilding **turn group** memberships and counts from `ctx.sessionManager.getBranch()` (keyed by persisted `toolCall.arguments` object references in a `WeakMap`) so resumed or replayed sessions render the same **summary line** without live `tool_call` events.
