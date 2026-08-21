export function handleChronicleGuide(): any {
  const guideContent = {
    version: "1.3.0",
    content: `## chronicle-mcp (v1.3.0)

Local conversation history, step-level tool inspection, multi-tool filtering, prompt benchmarking, and subagent hierarchy companion.

### Tool & Parameter Decision Router

\`\`\`mermaid
flowchart TD
    Task["Need Session History, Tool Logs, or Subagent Context"] --> Choice{"What is the query objective?"}
    
    Choice -->|"Search past solutions / semantic query"| SearchHist["1. Call search_history(query, scope='workspace'|'all')"]
    SearchHist --> ViewSess["2. Call query_transcript(sessionId, categories=['conversation_steps'])"]
    
    Choice -->|"Read dialogue turns / recent chat"| ReadDialogue["Call query_transcript(sessionId, categories=['conversation_steps'], sort='time_new_to_old')"]
    
    Choice -->|"Filter specific tool calls (single or multiple)"| FilterTools["Call query_transcript(sessionId, toolName=['write_to_file', 'replace_file_content'], categories=['tool_calls', 'tool_results'])"]
    
    Choice -->|"Trace subagent hierarchy & initial/final prompts"| RelTree["Call get_session_relationship(sessionId, maxDepth=2)"]
    
    Choice -->|"Retrieve generated plans / walkthrough artifacts"| GetArtifacts["Call get_session_artifacts(sessionId)"]
    
    Choice -->|"Analyze tool call frequency & counts"| ToolStats["Call get_tool_usage_stats(limit=30, scope='workspace'|'all')"]
    
    Choice -->|"Compare token benchmarks & context size"| Benchmarks["Call get_session_benchmarks(sessionIds=['...'])"]
\`\`\`

### Session Reading & Hierarchy Directives
* **Pre-Query Sync Directive**: Call \`sync_history\` (or \`sync_history(force=true)\`) before querying recent sessions or after major task milestones if auto-sync is not enabled.
* **Unified Transcript Querying**: Use \`query_transcript\` as the primary tool to slice, filter, and export transcript entries.
* **Multi-Tool Filtering**: Pass an array to \`toolName\` (e.g. \`toolName: ["patch_file", "write_to_file", "replace_file_content"]\`) to inspect all file modifications in a single query.
* **Subagent & Parent Hierarchy**: Call \`get_session_relationship\` to inspect parent/child relationships, including each node's \`initialPrompt\` and \`finalOutput\`.
* **Category Filtering**: Use \`categories: ["conversation_steps", "tool_calls", "tool_results", "thinking", "system_events"]\` to extract only the information needed and avoid token waste.
* **Disk Export for Large Logs**: When querying extensive steps or benchmarks, pass \`output="<absolute_path>"\` to write the output directly to disk without bloating context.

### Tool Matrix

| Tool Name | Call this tool when... | DO NOT call when... |
| :--- | :--- | :--- |
| \`list_sessions\` | Finding active sessions by \`scope\`, \`adapter\`, \`timeRange\`, \`parentId\` ('root'|'<id>'), or \`sortBy='active'\`. | Reading transcript steps or tool calls (use \`query_transcript\`). |
| \`get_session_relationship\` | Exploring parent, ancestors, child subagents hierarchy, \`initialPrompt\`, and \`finalOutput\`. | Querying step content or tool execution results (use \`query_transcript\`). |
| \`query_transcript\` | Reading dialogue, filtering steps by \`toolName\` (single or array), \`serverName\`, \`stepIndex\`, \`startStep\`/\`endStep\`, or \`categories\`. | Searching across all sessions with natural language semantics (use \`search_history\`). |
| \`search_history\` | Searching past solutions across sessions using natural language vector queries. | Searching for exact tool names, error statuses, or specific step ranges (use \`query_transcript\`). |
| \`get_session_artifacts\` | Retrieving generated markdown plan or walkthrough files for a session. | Reading raw step logs or tool execution details (use \`query_transcript\`). |
| \`get_tool_usage_stats\` | Retrieving tool call counts and usage statistics across recent sessions. | Inspecting individual step payloads. |
| \`get_session_benchmarks\` | Comparing token usage, duration, cache hit rates, and peak context size across sessions. | Retrieving actual code or conversation text. |
| \`sync_history\` | Force-syncing latest un-indexed session logs from adapters. | Auto-sync is active. |
| \`chronicle_guide\` | Reviewing usage patterns, decision tree, and parameter rules. | Querying actual session data. |

### Token Optimization & Parameter Rules
* \`categories\`: Always specify narrow categories (e.g. \`["conversation_steps"]\` or \`["tool_calls"]\`) to prevent token bloat.
* \`output="<absolute_path>"\`: Pass in \`query_transcript\`, \`get_session_artifacts\`, or \`get_session_benchmarks\` to save results directly to disk.

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
