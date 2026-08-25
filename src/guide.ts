export function handleChronicleGuide(): any {
  const guideContent = {
    version: "2.0.0",
    content: `## chronicle-mcp (v2.0.0)

Local conversation history, 2-layer turn & step exploration, progressive disclosure, hybrid vector/keyword search, prompt benchmarking, and subagent hierarchy companion.

### Tool & Parameter Decision Router

\`\`\`mermaid
flowchart TD
    Task["Need Session History, Tool Logs, or Subagent Context"] --> Choice{"What is the query objective?"}
    
    Choice -->|"Search past solutions / code / error codes"| SearchHist["1. Call search_history(query, mode='hybrid', scope='workspace'|'all')"]
    SearchHist --> ViewSess["2. Call query_transcript(sessionId, turnIndex=..., detailLevel='compact')"]
    
    Choice -->|"Explore recent sessions or filter by role/errors"| ListSess["Call list_sessions(scope='workspace', limit=10)"]
    
    Choice -->|"Read dialogue / recent session conversation"| ReadDialogue["Call query_transcript(sessionId, lastTurns=5, detailLevel='compact')"]
    
    Choice -->|"Inspect detailed tool calls / errors / thinking"| DeepInspect["Call query_transcript(sessionId, turnIndex=-1, detailLevel='full', include=['executions', 'thinking'])"]
    
    Choice -->|"Trace subagent tree & hierarchy"| RelTree["Call get_session_relationship(sessionId, maxDepth=3)"]
    
    Choice -->|"Aggregate subagent execution history"| SubtreeHistory["Call query_transcript(sessionId, includeSubtree=true, detailLevel='compact')"]
    
    Choice -->|"Retrieve plans / walkthrough artifacts"| GetArtifacts["Call get_session_artifacts(sessionId, includeSubtree=true)"]
    
    Choice -->|"Analyze tool call counts, failures & thrashing"| ToolStats["Call get_tool_usage_stats(limit=30, scope='workspace'|'all', format='markdown')"]
    
    Choice -->|"Compare token benchmarks & context sizes"| Benchmarks["Call get_session_benchmarks(sessionIds=['...'])"]
\`\`\`

### 2-Layer Progressive Disclosure Recipes
1. **Search Past Solutions & Discover Sessions**:
   - Call \`search_history(query='...')\` $\\rightarrow$ returns compact 1-line markdown by default (saving 80–90% tokens).
   - Use session prefix (e.g. \`[105081dd:T2]\` $\\rightarrow$ \`sessionId='105081dd'\`) to query transcript.
2. **Explore Session Metadata**:
   - Call \`list_sessions(scope='workspace', limit=10)\` $\\rightarrow$ returns compact 1-line numbered markdown list with turns, steps, and error badges (\`, 1 error\`).
3. **Read High-Level Dialogue**:
   - Call \`query_transcript(sessionId, lastTurns=5, detailLevel='compact')\` (saves ~80% tokens compared to full dumps).
4. **Deep-Dive Specific Turn or Errors**:
   - Call \`query_transcript(sessionId, turnIndex=-1, detailLevel='full')\` to examine full arguments, results, thinking, and file modifications.
5. **Debug Subagent Swarms**:
   - Call \`get_session_relationship(sessionId, maxDepth=3)\` to map child/parent links.
   - Call \`query_transcript(sessionId, includeSubtree=true, detailLevel='compact')\` to see full chronological timeline across all subagents.
6. **Analyze Tool Usage & Thrashing**:
   - Call \`get_tool_usage_stats(format='markdown')\` to view formatted execution counts, failure rates, and detected loop thrashing.
7. **Inspect Artifacts**:
   - Call \`get_session_artifacts(sessionId, includeSubtree=true)\` to retrieve plans, walkthroughs, and designs produced by the session and its subagents.

### Session ID Prefix Resolution
- **Prefix Lookup**: All tools accepting \`sessionId\` (\`query_transcript\`, \`get_session_relationship\`, \`get_session_artifacts\`) support short hex prefixes (minimum 6 characters, e.g. \`105081dd\`).
- The server automatically resolves the prefix to the canonical full UUID.

### Parameter Bounds & Validation
- \`limit\`: Clamped between 1 and 100 across all tools (defaults: 5 for \`search_history\`, 10 for \`list_sessions\`, 30 for \`get_tool_usage_stats\`).
- \`maxSnippetChars\`: Clamped between 20 and 500 characters (default: 120) for markdown titles and assistant snippets.
- \`format\`: \`"markdown"\` (default compact 1-line presentation) or \`"json"\` (structured data).
- \`detailLevel\`: In JSON mode, \`"compact"\` (default essential projection) or \`"full"\` (unabridged fields).
- \`fields\` / \`order\`: Optional array or comma-separated string to project specific keys (e.g. \`fields: ["id", "title"]\`).
- \`output\`: Direct file export path (\`.md\` or \`.json\`) to write large payloads directly to disk without context token consumption.

### Empty State Protocols
- **Markdown Mode**: Returns human-readable empty messages (e.g. \`"No matching history turns found for \\"<query>\\"."\`, \`"No indexed sessions found."\`, \`"No tool usage data recorded."\`).
- **JSON Mode**: Returns empty arrays \`[]\` or structured zero-count stats object \`{ summary: { totalCalls: 0, totalErrors: 0, overallFailureRate: 0 }, tools: [], thrashingTools: [] }\`.

### Tool Matrix

| Tool Name | Call this tool when... | DO NOT call when... |
| :--- | :--- | :--- |
| \`search_history\` | Zero-copy turn-level hybrid (FTS5 + Vector BLOB RRF), semantic, or keyword search across sessions (default: compact markdown). | Searching within an already known single session turn (use \`query_transcript\`). |
| \`list_sessions\` | Finding sessions by \`scope\`, \`adapter\`, \`parentId\` ('root'|'<id>'), \`role\`, \`hasErrors\`, or \`sortBy='active'\` (default: compact markdown). | Reading transcript dialogue or steps (use \`query_transcript\`). |
| \`query_transcript\` | Reading dialogue, turn slicing (\`turnIndex\`, \`lastTurns\`, \`startTurn\`/\`endTurn\`), \`detailLevel\` ('compact'|'full'|'summary'), \`toolFilter\`, or \`includeSubtree\`. | Searching across all sessions with natural language query (use \`search_history\`). |
| \`get_session_relationship\` | Exploring parent, ancestors, child subagents hierarchy, \`initialPrompt\`, and \`finalOutput\`. | Querying step content or tool execution results (use \`query_transcript\`). |
| \`get_tool_usage_stats\` | Retrieving per-tool execution counts, failure rates, average durations, and thrash loops across sessions (\`format='markdown'\` or \`'json'\`). | Inspecting individual tool arguments or results (use \`query_transcript\`). |
| \`get_session_artifacts\` | Retrieving generated markdown artifacts (walkthroughs, implementation plans, notes) with optional subtree discovery. | Reading raw step logs or tool execution details (use \`query_transcript\`). |
| \`get_session_benchmarks\` | Comparing token usage, duration, cache hit rates, and peak context size across sessions. | Retrieving actual conversation text or code artifacts. |
| \`sync_history\` | Force-syncing latest un-indexed session logs from adapters. | Auto-sync is active. |
| \`chronicle_guide\` | Reviewing usage patterns, decision tree, progressive disclosure recipes, and parameter rules. | Querying actual session data. |

### Critical Directives
* **NEVER** use file reading tools on raw log files (\`transcript.jsonl\`, \`state.vscdb\`). ALWAYS use \`chronicle-mcp\` tools.
* **ALWAYS** delegate file writing to server via \`output\` parameter when processing large log outputs.`
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(guideContent, null, 2),
      },
    ],
  };
}
