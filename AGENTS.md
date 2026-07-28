# Chronicle MCP Agent Guidelines

> [!IMPORTANT]
> Global Policies apply to this repository by default. This file contains repository-specific rules for chronicle-mcp.

## Code Intelligence & History Exploration Rules

### 1. Do NOT Read Raw Log Files Directly
- NEVER call `view_file` or filesystem read tools on raw log files (such as `transcript.jsonl`, `transcript_full.jsonl`, or Cursor state SQLite databases).
- Doing so is token-inefficient, introduces noise, and causes prompt truncation.

### 2. Mandatory Chronicle MCP Tool Usage
When asked to read, query, summarize, or search past conversations, sessions, tool executions, or errors, you MUST use the registered `chronicle-mcp` tools:
- **`chronicle_guide`**: Call first when starting history exploration to review token-saving rules, decision tree, and parameter guidelines.
- **`query_transcript`**: Primary tool to read, query, filter, slice, or export transcript entries by `categories` and `sort` modes.
- **`list_sessions`**: Retrieve history metadata and session IDs.
- **`search_history`**: Perform semantic vector search over past turns.
- **`get_session_benchmarks`**: View execution steps, tool calls, BPE token counts, and caching stats.
- **`get_session_artifacts`**: Retrieve generated plan or walkthrough markdown files.
