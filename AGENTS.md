# 🤖 Chronicle MCP Agent Guidelines (AGENTS.md)

> [!IMPORTANT]
> This file is the source of truth for any agent operating in this repository. All agents must read and strictly adhere to these rules.

## 🎯 Code Intelligence & History Exploration Rules

### 1. Do NOT Read Raw Log Files Directly
- NEVER call `view_file` or filesystem read tools on raw log files (such as `transcript.jsonl`, `transcript_full.jsonl`, or Cursor state SQLite databases).
- Doing so is token-inefficient, introduces noise, and causes prompt truncation.

### 2. Mandatory Chronicle MCP Tool Usage
When asked to read, query, summarize, or search past conversations, sessions, tool executions, or errors, you MUST use the registered `chronicle-mcp` tools:
- **`list_sessions`**: Retrieve history metadata and session IDs.
- **`get_session_details`**: Retrieve formatted conversation summaries with optional range slicing and tool details.
- **`get_step_details`**: Inspect raw JSON structures of specific steps.
- **`get_session_benchmarks`**: View execution steps, tool calls, BPE token counts, and caching stats.
- **`search_history`**: Perform semantic vector search over past turns.
- **`search_steps`**: Retrieve specific tool call parameters, thinking blocks, or execution errors (e.g. by filtering `status="ERROR"` and `type="MCP_TOOL"`).
