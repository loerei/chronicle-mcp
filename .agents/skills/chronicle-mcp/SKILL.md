---
name: chronicle-mcp
description: >
  Guidance for using chronicle-mcp tools to inspect history, session logs, and errors.
  Use when analyzing previous agent conversations, subagent trees, or failed tool calls.
---

Do NOT read raw JSONL log files directly. Use chronicle-mcp tools to access history cleanly.

## Core Rules

1. **Context Bloat Prevention**: Never call `view_file` or filesystem read tools on `transcript.jsonl`, `transcript_full.jsonl`, or Cursor state databases. Doing so is extremely token-inefficient and causes prompt truncation.
2. **Search First**:
   - Use `search_history` to query semantic concepts.
   - Use `search_steps` to find specific keywords, tools, or status codes.
3. **Inspect Details**:
   - Use `get_session_details` to read clean conversation markdown.
   - Use `get_step_details` to inspect raw JSON step details.
4. **Identify Errors**:
   - To retrieve failed tool calls or command errors, call `search_steps` with `status: "ERROR"` and `type: "MCP_TOOL"` (or `type: "COMMAND"`).
