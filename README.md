# chronicle-mcp

Developer agents operating across multiple workspaces often lack a unified, searchable history of past execution steps, subagent hierarchies, and token usage metrics, leading to redundant context re-explanation and untracked API costs.

This local Model Context Protocol (MCP) server indexes, synchronizes, and exposes agent conversation logs, tool execution steps, subagent hierarchies, and execution benchmarks from **Antigravity** and **Cursor** workspaces. It provides vector search capabilities, BPE token analysis, and prompt caching simulations over transactional SQLite storage.

## Features

- **Incremental History Synchronization**: Scans and parses local logs (`transcript.jsonl` and Composer states) from your active agent workspace. Skips previously indexed sessions to complete subsequent syncs in less than a second.
- **Hierarchical Vector Search**: Two-stage search that ranks matching sessions by summary vector, then ranks individual chunks within those top sessions to return contextually relevant history.
- **Subagent Linking and Discoverability**: Automatically extracts subagent conversation IDs from steps of type `INVOKE_SUBAGENT`. Links child sessions to their parent sessions dynamically, allowing bidirectional traversal of agent hierarchies.
- **Deep Tool & Step Inspection**: Indexes all `USER_INPUT`, `PLANNER_RESPONSE`, and `MCP_TOOL` steps (including thinking blocks, arguments, and return values). Retrieve specific step details, slice steps by range, or search for errors and failed tool calls.
- **Performance Benchmarking & Caching Simulation**: Computes steps, tool calls, duration, errors, and standard BPE token counts (via `js-tiktoken`). Simulates turn-by-turn prefix prompt caching to calculate cumulative input tokens, peak context sizes, cache hit rates, and estimated cost savings. *Note: Caching calculations assume a continuous hot cache, without simulating TTL expiration or provider-specific minimum token limits.*
- **Zero Native Dependencies**: Built on pure `node:sqlite` using SQLite WAL mode for fast queries without native MSBuild/Python build requirements on Windows.

## Tech Stack

- **Core**: Node.js & TypeScript
- **Database**: `node:sqlite` (SQLite WAL mode)
- **Embeddings**: `@huggingface/transformers` (local ONNX pipeline running on CPU)
- **SDK**: `@modelcontextprotocol/sdk`

## Project Structure

```text
chronicle-mcp/
├── src/
│   ├── __tests__/           # Test suite (HistoryStore, SessionParser, EmbeddingClient, etc.)
│   ├── adapters/            # Log & state format parsers
│   │   ├── Antigravity.ts   # Antigravity log adapter
│   │   ├── Cursor.ts        # Cursor Composer state adapter
│   │   ├── SessionParser.ts # Pure in-process log parser
│   │   └── types.ts         # Data models and interfaces
│   ├── db.ts                # HistoryStore adapters (SQLite & In-Memory)
│   ├── embeddings.ts        # EmbeddingClient adapters (transformers & mock)
│   ├── index.ts             # MCP server entry point and tool schema handlers
│   └── search.ts            # Search controllers and details retrieval
├── package.json
└── tsconfig.json
```

## Install

Clone, build, and install dependencies:

```bash
git clone https://github.com/loerei/chronicle-mcp.git
cd chronicle-mcp
npm install
npm run build
```

## Client Configuration

Add the server to your MCP client configuration (e.g. Claude Desktop at `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "chronicle-mcp": {
      "command": "node",
      "args": ["D:/Projects/chronicle-mcp/dist/index.js"]
    }
  }
}
```

## Tools

- **`sync_history`**: Triggers incremental synchronization of local history logs.
- **`list_sessions`**: Lists synced sessions with optional filter parameters (`adapter`, `projectPath`, `limit`).
- **`get_session_details`**: Retrieves formatted Markdown of a session's conversation history. Supports range slicing (`startStep`/`endStep`) and optional detailed blocks (`includeToolCalls`, `includeCallResults`).
- **`get_step_details`**: Retrieves the raw JSON structure of a specific step (including thinking, tool calls, and results).
- **`get_session_benchmarks`**: Calculates and compares execution metrics (steps, tool calls, duration, cumulative input tokens, output tokens, errors, peak context size, simulated cache hit rate, and cost savings assuming cache reads are billed at a 10% rate under hot cache assumptions) across one or more sessions, with optional grouping.
- **`search_history`**: Performs semantic search against synced session summaries and chunks.
- **`search_steps`**: Searches logged steps with filters for `sessionId`, step `type` (e.g., `MCP_TOOL`, `COMMAND`), step `status` (e.g., `ERROR`), and an optional text keyword `query`. Used to retrieve failed tool calls or specific command executions.

## License

MIT
