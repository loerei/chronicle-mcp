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
- **`sync_history`**: Call `sync_history(force=true)` before querying recent history to ensure all un-indexed log entries from disk are indexed into the database.
- **`query_transcript`**: Primary tool to read, query, filter, slice, or export transcript entries (`detailLevel: 'compact' | 'full' | 'summary'`). Supports session ID prefix lookup (>= 6 chars).
- **`list_sessions`**: Retrieve history metadata and session IDs. Defaults to compact 1-line markdown list (saving 80–90% tokens). Supports `format: "json"`, `detailLevel: "compact" | "full"`, `fields` projection, and `limit: 1–100`.
- **`search_history`**: Perform zero-copy turn-level hybrid (FTS5 + Vector RRF), semantic, or keyword search across sessions. Defaults to compact 1-line markdown. Supports `fields` projection and `output` direct file export.
- **`get_session_relationship`**: Map parent sessions, ancestors, and child subagent trees (`maxDepth: 1–10`). Supports session prefix resolution.
- **`get_tool_usage_stats`**: View per-tool call counts, failure rates, duration analytics, and thrashing loop detection (`format: "markdown"` or `"json"`).
- **`get_session_benchmarks`**: View execution steps, tool calls, BPE token counts, context window growth, and caching stats.
- **`get_session_artifacts`**: Retrieve generated plan, task, or walkthrough markdown files with optional subtree discovery.

### 3. Progressive Disclosure & Token Efficiency Rules
- **Prefix Lookup**: Pass short hex session prefixes (minimum 6 chars, e.g. `105081dd`) to any tool accepting `sessionId`.
- **Default to Compact Formats**: Use the default 1-line Markdown format or `detailLevel: "compact"` for initial exploration. Escalate to `detailLevel: "full"` only when inspecting exact tool inputs/outputs.
- **Direct File Export**: Use `output: "<path>"` when writing or inspecting large transcripts or benchmark reports to avoid polluting conversation context tokens.
