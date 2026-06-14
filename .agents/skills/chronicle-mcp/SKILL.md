---
name: chronicle-mcp
description: >
  Guidance for using chronicle-mcp tools to inspect history, session logs, and errors.
  Use when analyzing previous agent conversations, subagent trees, or failed tool calls.
---

# Chronicle MCP History Exploration

Do NOT read raw JSONL log files directly. Use chronicle-mcp tools to access history cleanly to avoid context bloat.

## Quick Start

### Find Failed Tool Calls
To retrieve failed tool calls across history using `search_steps`:
```json
{
  "status": "ERROR",
  "type": "MCP_TOOL"
}
```

### Slice Dialogue History
To retrieve a clean range of conversation history using `get_session_details`:
```json
{
  "sessionId": "target-session-uuid",
  "includeToolCalls": false,
  "startStep": 10,
  "endStep": 20
}
```

## Workflows

### Traversing Agent History
- [ ] Call `list_sessions` or search with `search_history` to identify relevant previous sessions.
- [ ] Slice steps via `get_session_details` with `startStep` and `endStep` to inspect logs without exceeding context limits.
- [ ] If subagents were spawned, look for the `Subagents Spawned` section in the session details and traverse to parent/child IDs.

### Inspecting Errors
- [ ] Call `search_steps` with `status: "ERROR"` to extract failed executions.
- [ ] Pass specific `type` filters (e.g., `MCP_TOOL`, `COMMAND`) to narrow down the target.
- [ ] Use `get_step_details` with `sessionId` and `stepIndex` to inspect the raw JSON and call traces of the failure.
