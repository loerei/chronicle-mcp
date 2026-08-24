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
    
    Choice -->|"Read dialogue / recent session conversation"| ReadDialogue["Call query_transcript(sessionId, lastTurns=5, detailLevel='compact')"]
    
    Choice -->|"Inspect detailed tool calls / errors / thinking"| DeepInspect["Call query_transcript(sessionId, turnIndex=-1, detailLevel='full', include=['executions', 'thinking'])"]
    
    Choice -->|"Trace subagent tree & hierarchy"| RelTree["Call get_session_relationship(sessionId, maxDepth=3)"]
    
    Choice -->|"Aggregate subagent execution history"| SubtreeHistory["Call query_transcript(sessionId, includeSubtree=true, detailLevel='compact')"]
    
    Choice -->|"Retrieve plans / walkthrough artifacts"| GetArtifacts["Call get_session_artifacts(sessionId, includeSubtree=true)"]
    
    Choice -->|"Analyze tool call counts, failures & thrashing"| ToolStats["Call get_tool_usage_stats(limit=30, scope='workspace'|'all')"]
    
    Choice -->|"Compare token benchmarks & context sizes"| Benchmarks["Call get_session_benchmarks(sessionIds=['...'])"]
\`\`\`

### 2-Layer Progressive Disclosure Recipes
1. **Explore Session Metadata**:
   - Call \`list_sessions(scope='workspace', limit=10)\` to find recent session IDs and summary metrics (turn count, step count, artifacts).
2. **Read High-Level Dialogue**:
   - Call \`query_transcript(sessionId, lastTurns=5, detailLevel='compact')\` (saves ~80% tokens compared to full dumps).
3. **Deep-Dive Specific Turn or Errors**:
   - Call \`query_transcript(sessionId, turnIndex=-1, detailLevel='full')\` to examine full arguments, results, thinking, and file modifications.
4. **Debug Subagent Swarms**:
   - Call \`get_session_relationship(sessionId, maxDepth=3)\` to map child/parent links.
   - Call \`query_transcript(sessionId, includeSubtree=true, detailLevel='compact')\` to see full chronological timeline across all subagents.
5. **Inspect Artifacts**:
   - Call \`get_session_artifacts(sessionId, includeSubtree=true)\` to retrieve plans, walkthroughs, and designs produced by the session and its subagents.

### Tool Matrix

| Tool Name | Call this tool when... | DO NOT call when... |
| :--- | :--- | :--- |
| \`list_sessions\` | Finding sessions by \`scope\`, \`adapter\`, \`parentId\` ('root'|'<id>'), \`role\`, \`hasErrors\`, or \`sortBy='active'\`. | Reading transcript dialogue or steps (use \`query_transcript\`). |
| \`get_session_relationship\` | Exploring parent, ancestors, child subagents hierarchy, \`initialPrompt\`, and \`finalOutput\`. | Querying step content or tool execution results (use \`query_transcript\`). |
| \`query_transcript\` | Reading dialogue, turn slicing (\`turnIndex\`, \`lastTurns\`, \`startTurn\`/\`endTurn\`), \`detailLevel\` ('compact'|'full'|'summary'), \`toolFilter\`, or \`includeSubtree\`. | Searching across all sessions with natural language query (use \`search_history\`). |
| \`search_history\` | Zero-copy turn-level hybrid (FTS5 + Vector BLOB RRF), semantic, or keyword search across sessions. | Searching within an already known single session turn (use \`query_transcript\`). |
| \`get_session_artifacts\` | Retrieving generated markdown artifacts (walkthroughs, implementation plans, notes) with optional subtree discovery. | Reading raw step logs or tool execution details (use \`query_transcript\`). |
| \`get_tool_usage_stats\` | Retrieving per-tool execution counts, failure rates, average durations, and thrash loops across sessions. | Inspecting individual tool arguments or results (use \`query_transcript\`). |
| \`get_session_benchmarks\` | Comparing token usage, duration, cache hit rates, and peak context size across sessions. | Retrieving actual conversation text or code artifacts. |
| \`sync_history\` | Force-syncing latest un-indexed session logs from adapters. | Auto-sync is active. |
| \`chronicle_guide\` | Reviewing usage patterns, decision tree, progressive disclosure recipes, and parameter rules. | Querying actual session data. |

### Token Optimization & Parameter Rules
* \`detailLevel\`: Default to \`compact\` for initial reading. Use \`full\` only when inspecting specific tool payloads, or \`summary\` for conversational dialogues only.
* Slicing: Use \`turnIndex: -1\` for the latest turn, or \`lastTurns: N\` to bound output.
* \`output="<absolute_path>"\`: Pass in \`query_transcript\`, \`get_session_artifacts\`, or \`get_session_benchmarks\` to save large outputs directly to disk.

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
