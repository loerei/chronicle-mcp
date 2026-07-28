---
name: chronicle-mcp
description: >
  Guidance for using chronicle-mcp tools to inspect history, session logs, and errors.
  Use when analyzing previous agent conversations, subagent trees, or failed tool calls.
---

# Chronicle MCP History Exploration

Do NOT read raw JSONL log files directly. Use `chronicle-mcp` tools to access history cleanly to avoid context bloat.

## Quick Start with `query_transcript`

`query_transcript` is the primary entry point to read, search, filter, and extract session transcript entries.

### 1. Retrieve Tool Execution Outputs (e.g. `patch_file` results)
```json
{
  "toolName": "patch_file",
  "categories": ["tool_results"],
  "limit": 50
}
```

### 2. Inspect Dialogue History (Conversation Steps Only)
```json
{
  "sessionId": "target-session-uuid",
  "categories": ["conversation_steps"],
  "startConversationStep": 1,
  "endConversationStep": 10
}
```

### 3. Retrieve Failed Executions & System Errors
```json
{
  "status": "ERROR",
  "categories": ["system_events", "tool_results"],
  "sort": "time_new_to_old"
}
```

---

## Workflows & Best Practices

- [ ] **Pre-Query History Sync**: Call `sync_history(force=true)` before querying recent sessions or after major task milestones to ensure all un-indexed log entries from disk are indexed.
- [ ] **Read Recent Turns First**: ALWAYS set `sort="time_new_to_old"` when investigating recent context or latest user feedback.
- [ ] **Dialogue-Only Reading**: Set `categories=["conversation_steps"]` when reading human-assistant dialogue, skipping tool payloads.
- [ ] **Targeted Tool Output Extraction**: Set `categories=["tool_results"]` and `toolName="patch_file"` to retrieve execution outputs directly.
- [ ] **Group Transcript Entries**: Set `sort="category"` to retrieve transcript entries grouped under category keys.
