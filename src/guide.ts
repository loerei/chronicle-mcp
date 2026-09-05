export interface ChronicleGuideArgs {
  topic?: string | string[];
  topics?: string | string[];
}

export type ChronicleGuideTopic =
  | "general"
  | "search"
  | "artifacts"
  | "subagents"
  | "benchmarks"
  | "debug_errors";

export interface NormalizedTopicResult {
  validTopics: ChronicleGuideTopic[];
  invalidTopics: string[];
}

export const CANONICAL_TOPICS: ChronicleGuideTopic[] = [
  "general",
  "search",
  "artifacts",
  "subagents",
  "benchmarks",
  "debug_errors",
];

const DISCOVERABILITY_FOOTER =
  "---\n*Topic Catalog: `general` (Router & Overview) | `search` (Search & Slicing) | `artifacts` (Plans & Direct Export) | `subagents` (Swarm Topology) | `benchmarks` (Token Metrics & Charts) | `debug_errors` (Failures & Thrashing) | `all` (Full Manual)*";

export function normalizeTopics(args?: ChronicleGuideArgs): NormalizedTopicResult {
  const rawTokens: string[] = [];

  const extractTokens = (val: unknown) => {
    if (typeof val === "string") {
      rawTokens.push(...val.split(","));
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string") {
          rawTokens.push(...item.split(","));
        }
      }
    }
  };

  if (args) {
    extractTokens(args.topic);
    extractTokens(args.topics);
  }

  const sanitizedTokens = rawTokens
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);

  // Expand "all" keyword
  const expandedTokens: string[] = [];
  for (const token of sanitizedTokens) {
    if (token === "all") {
      expandedTokens.push(...CANONICAL_TOPICS);
    } else {
      expandedTokens.push(token);
    }
  }

  const validTopics: ChronicleGuideTopic[] = [];
  const invalidTopics: string[] = [];
  const seenValid = new Set<ChronicleGuideTopic>();
  const seenInvalid = new Set<string>();

  for (const token of expandedTokens) {
    if ((CANONICAL_TOPICS as string[]).includes(token)) {
      const topic = token as ChronicleGuideTopic;
      if (!seenValid.has(topic)) {
        seenValid.add(topic);
        validTopics.push(topic);
      }
    } else {
      if (!seenInvalid.has(token)) {
        seenInvalid.add(token);
        invalidTopics.push(token);
      }
    }
  }

  if (validTopics.length === 0) {
    validTopics.push("general");
  }

  return { validTopics, invalidTopics };
}

export function renderGeneralGuide(): string {
  return `## Topic: General Quickstart & Decision Router

### chronicle-mcp (v2.0.0)

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
| \`get_session_relationship\` | Exploring parent, ancestors, child subagents hierarchy, with optional \`includeMandate\`. | Querying step content or tool execution results (use \`query_transcript\`). |
| \`get_tool_usage_stats\` | Retrieving per-tool execution counts, failure rates, average durations, and thrash loops across sessions (\`format='markdown'\` or \`'json'\`). | Inspecting individual tool arguments or results (use \`query_transcript\`). |
| \`get_session_artifacts\` | Retrieving generated markdown artifacts (walkthroughs, implementation plans, notes) with optional subtree discovery. | Reading raw step logs or tool execution details (use \`query_transcript\`). |
| \`get_session_benchmarks\` | Comparing token usage, duration, cache hit rates, and peak context size across sessions. | Retrieving actual conversation text or code artifacts. |
| \`sync_history\` | Force-syncing latest un-indexed session logs from adapters. | Auto-sync is active. |
| \`chronicle_guide\` | Reviewing usage patterns, decision tree, progressive disclosure recipes, and parameter rules. | Querying actual session data. |

### Critical Directives
* **NEVER** use file reading tools on raw log files (\`transcript.jsonl\`, \`state.vscdb\`). ALWAYS use \`chronicle-mcp\` tools.
* **ALWAYS** delegate file writing to server via \`output\` parameter when processing large log outputs.`;
}

export function renderSearchGuide(): string {
  return `## Topic: Historical Search & Turn Slicing

### Precision Search Recipes
1. **Find Past Solution by Natural Language**:
   \`\`\`json
   {
     "query": "how did we resolve SonarCloud duplication in schema",
     "scope": "workspace",
     "mode": "hybrid",
     "limit": 5
   }
   \`\`\`
   - Returns 1-line compact hits: \`1. [105081dd:T12] (workspace) - "Extracted conversationStepParams schema..."\`
2. **Inspect Discovered Turn Dialogue**:
   \`\`\`json
   {
     "sessionId": "105081dd",
     "turnIndex": 12,
     "detailLevel": "compact"
   }
   \`\`\`

### Search Modes
- \`mode: "hybrid"\` (Default): Combines FTS5 full-text keyword ranking with vector BLOB cosine similarity using Reciprocal Rank Fusion (RRF). Best for natural language questions and multi-term topics.
- \`mode: "keyword"\`: Pure FTS5 exact token matching. Best for exact function names, error codes, identifiers, or exact filepaths (e.g. \`"searchHistory"\`, \`"SQLITE_BUSY"\`).
- \`mode: "semantic"\`: Pure embedding vector similarity. Best for conceptual similarity where exact keywords may differ.

### Slicing & Detail Level Control
- **Negative Turn Slicing**:
  - \`turnIndex: -1\`: Slices the very latest conversation turn.
  - \`turnIndex: -2\`: Slices the penultimate turn.
- **Turn Ranges**:
  - \`startTurn: 5, endTurn: 10\`: Slices turns 5 through 10 (inclusive).
  - \`lastTurns: 3\`: Slices the last 3 conversation turns.
- **Detail Levels in \`query_transcript\`**:
  - \`detailLevel: "compact"\` (Default): Shows turn sequence, user prompt, and assistant summary text. Consumes minimal context.
  - \`detailLevel: "summary"\`: High-level synopsis of conversation turns.
  - \`detailLevel: "full"\`: Unabridged tool arguments, execution outputs, thinking blocks, and file modifications. Use for deep debugging of specific steps.

### Field Projection & JSON Mode
When structured JSON output is required:
\`\`\`json
{
  "format": "json",
  "detailLevel": "compact",
  "fields": ["id", "title", "totalTurns", "errorCount"]
}
\`\`\``;
}

export function renderArtifactsGuide(): string {
  return `## Topic: Artifact Discovery & Direct Disk Export

### Artifact Retrieval Recipes
1. **List Artifacts in Root Session**:
   \`\`\`json
   {
     "sessionId": "105081dd"
   }
   \`\`\`
2. **Retrieve Artifacts Across Full Subagent Swarm**:
   \`\`\`json
   {
     "sessionId": "105081dd",
     "includeSubtree": true,
     "artifactName": "PRD"
   }
   \`\`\`

### Direct Disk Export & Path Traversal Security
When exporting large markdown summaries, full benchmark dumps, or multi-turn transcripts, use the \`output\` parameter:
\`\`\`json
{
  "sessionId": "105081dd",
  "detailLevel": "full",
  "output": "C:/Users/sayus/.gemini/antigravity/brain/105081dd/full_transcript.md"
}
\`\`\`
- **Zero Context Pollution**: Writes output directly to disk and returns a markdown link.
- **Path Security**: Validates containment within authorized roots (workspace root, OS temp directory, AppData directory, Home/UserProfile). Traversal attempts (\`../\`) outside authorized roots are rejected.`;
}

export function renderSubagentsGuide(): string {
  return `## Topic: Subagent Swarms & Multi-Agent Timelines

### Swarm Tracing Recipes
1. **Inspect Swarm Hierarchy & Topology**:
   \`\`\`json
   {
     "sessionId": "105081dd",
     "maxDepth": 3
   }
   \`\`\`
   - Returns root ID, parent ID, subagent roles, conversation IDs, and deduplicated child hierarchy (use \`includeMandate: true\` if initial prompt mandate is needed).
2. **Aggregated Multi-Agent Chronological Timeline**:
   \`\`\`json
   {
     "sessionId": "105081dd",
     "includeSubtree": true,
     "detailLevel": "compact"
   }
   \`\`\`
   - Merges turns from parent and all child subagents chronologically with sender attribution tags (\`[Parent]\`, \`[Subagent: Reviewer #1]\`).

### Subagent Hierarchy Topology
- **Parent ID**: Identifies the direct delegating session.
- **Root ID**: Identifies the top-level root session of the entire swarm.
- **Depth Level**: 0 for root, 1 for direct child subagents, 2 for nested subagents.
- **Initial Prompt & Final Output**: Captures delegation intent and final outcome without loading intermediate step logs.`;
}

export function renderBenchmarksGuide(): string {
  return `## Topic: Performance & Token Benchmarking

### Multi-Variant A/B/C Benchmarking Recipes
1. **Compare Specific Sessions**:
   \`\`\`json
   {
     "sessionIds": ["faf17406", "a65e04da", "f4c86ed6"]
   }
   \`\`\`
2. **Grouped A/B/C Multi-Variant Comparison**:
   \`\`\`json
   {
     "sessionIds": ["faf17406", "a65e04da", "f4c86ed6"],
     "groups": [
       { "name": "Variant A (MCP v2.0)", "sessionIds": ["faf17406"] },
       { "name": "Variant B (Custom Scripts)", "sessionIds": ["a65e04da"] },
       { "name": "Variant C (Markdown Only)", "sessionIds": ["f4c86ed6"] }
     ],
     "linechart_output": "C:/path/to/benchmark_chart.html"
   }
   \`\`\`

### Metrics Dictionary
- **Steps**: Total planner and execution steps taken by the agent.
- **Tool Calls**: Count of discrete tool executions.
- **Duration (s)**: Wall-clock execution time in seconds.
- **Cumulative Input Tokens**: Sum of all prompt input tokens across every turn.
- **Cache Hit %**: Prompt prefix caching efficiency (higher is better).
- **Cost Saved %**: Estimated dollar savings from prompt caching.
- **Peak Context Window**: Maximum token size reached by conversation context.
- **Output Tokens**: Total tokens generated in responses and tool calls.`;
}

export function renderDebugErrorsGuide(): string {
  return `## Topic: Error Diagnosis & Thrashing Detection

### Tool Error Diagnosis Recipes
1. **Global Tool Health & Thrashing Audit**:
   \`\`\`json
   {
     "format": "markdown",
     "limit": 30
   }
   \`\`\`
   - Tool: \`get_tool_usage_stats\`
   - Renders failure rates, error counts, average duration, and identifies active loop thrashing.
2. **Filter Sessions with Errors**:
   \`\`\`json
   {
     "scope": "workspace",
     "hasErrors": true,
     "limit": 10
   }
   \`\`\`
   - Tool: \`list_sessions\`
3. **Deep-Dive Failed Step Executions**:
   \`\`\`json
   {
     "sessionId": "105081dd",
     "toolFilter": { "status": "ERROR" },
     "include": ["executions"]
   }
   \`\`\`
   - Tool: \`query_transcript\`
   - Returns only the failed tool executions and error stack traces.

### Thrashing Loop Detection
- **Composite Key**: Monitored via \`\${serverName}::\${toolName}\`.
- **Thrashing Threshold**: $\\ge 3$ consecutive errors or repeated identical failures trigger thrashing alerts in \`get_tool_usage_stats\`.
- **Structured Stderr Observability**: Unhandled tool exceptions log structured JSON error records with stack traces to \`process.stderr\`.`;
}

export function handleChronicleGuide(args?: ChronicleGuideArgs): any {
  const { validTopics, invalidTopics } = normalizeTopics(args);

  const topicRenderers: Record<ChronicleGuideTopic, () => string> = {
    general: renderGeneralGuide,
    search: renderSearchGuide,
    artifacts: renderArtifactsGuide,
    subagents: renderSubagentsGuide,
    benchmarks: renderBenchmarksGuide,
    debug_errors: renderDebugErrorsGuide,
  };

  const renderedSections = validTopics.map((topic) => topicRenderers[topic]());
  let fullContent = renderedSections.join("\n\n---\n\n");

  // Prepend diagnostic note banner if invalid topics were supplied
  if (invalidTopics.length > 0) {
    const invalidList = invalidTopics.join(", ");
    const isSingleGeneralDefault =
      validTopics.length === 1 &&
      validTopics[0] === "general" &&
      !JSON.stringify(args || "").includes("general");

    if (isSingleGeneralDefault) {
      fullContent = `> [!NOTE]\n> Unrecognized topic(s): "${invalidList}". Defaulting to "general" overview. Available topics: general, search, artifacts, subagents, benchmarks, debug_errors, all.\n\n${fullContent}`;
    } else {
      const validList = validTopics.join(", ");
      fullContent = `> [!NOTE]\n> Unrecognized topic(s): "${invalidList}". Showing requested valid topic(s): "${validList}". Available topics: general, search, artifacts, subagents, benchmarks, debug_errors, all.\n\n${fullContent}`;
    }
  }

  // Append discoverability footer
  fullContent = `${fullContent}\n\n${DISCOVERABILITY_FOOTER}`;

  const guideResponse = {
    version: "2.0.0",
    content: fullContent,
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(guideResponse, null, 2),
      },
    ],
  };
}
