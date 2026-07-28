import { Server } from "@modelcontextprotocol/sdk/server/index.js"; // NOSONAR
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { getStore, getDb, StepCategory, StepSortMode } from "./db.js";
import { ADAPTERS } from "./adapters/index.js";
import { getEmbeddingClient } from "./embeddings.js";
import { searchHistory, getSessionDetailsFromDb, computeSessionBenchmarks, getToolUsageStats, generateInteractiveContextChartHtml } from "./search.js";

let activeSync: Promise<void> | null = null;
let lastSyncTime = 0;
const SYNC_COOLDOWN_MS = 5000;

type ScopeType = "workspace" | "all";

export function isAutoSyncEnabled(): boolean {
  return (
    process.env.CHRONICLE_AUTO_SYNC === "true" ||
    process.argv.includes("--auto-sync")
  );
}

export function isLegacyToolsEnabled(): boolean {
  return (
    process.env.CHRONICLE_ENABLE_LEGACY_TOOLS === "true" ||
    process.argv.includes("--enable-legacy-tools")
  );
}

async function syncSingleSession(s: any, store: any): Promise<boolean> {
  // Check if session already indexed
  const checkResult = store.query({ sessionId: s.id });
  if (checkResult.sessions.length > 0) {
    const existingSession = checkResult.sessions[0];
    const existingChunkIndices = new Set(existingSession.chunks.map((c: any) => c.stepIndex));

    const stepsResult = store.query({ sessionId: s.id, includeSteps: true });
    const existingStepIndices = new Set(stepsResult.steps.map((step: any) => step.stepIndex));

    const newChunks = s.chunks.filter((c: any) => !existingChunkIndices.has(c.stepIndex));
    const newSteps = (s.steps || []).filter((step: any) => !existingStepIndices.has(step.stepIndex));

    if (newChunks.length === 0 && newSteps.length === 0 && existingSession.title === s.title) {
      return false;
    }

    console.error(`[Chronicle MCP] Indexing updates for session: "${s.title}" (${s.id}) - ${newChunks.length} new chunks, ${newSteps.length} new steps`);

    // Recompute summary vector if title or first prompt changed
    let summaryVector = undefined;
    if (existingSession.title !== s.title || existingSession.firstPrompt !== s.firstPrompt) {
      const summaryText = `Title: ${s.title} | Context: ${s.projectPath || "unknown"} | Start: ${s.firstPrompt} ${s.secondPrompt}`;
      [summaryVector] = await getEmbeddingClient().embed([summaryText]);
    }

    // Compute Level 2 vectors only for the new chunks
    const chunkVectors = new Map<number, number[]>();
    if (newChunks.length > 0) {
      const chunkTexts = newChunks.map((chunk: any) => chunk.text);
      const vectors = await getEmbeddingClient().embed(chunkTexts);
      newChunks.forEach((chunk: any, index: number) => {
        chunkVectors.set(chunk.stepIndex, vectors[index]);
      });
    }

    store.save(s, {
      summary: summaryVector,
      chunks: chunkVectors
    });
    return true;
  }

  console.error(`[Chronicle MCP] Indexing new session: "${s.title}" (${s.id})`);

  // Compute Level 1 vector (Session identity)
  const summaryText = `Title: ${s.title} | Context: ${s.projectPath || "unknown"} | Start: ${s.firstPrompt} ${s.secondPrompt}`;
  const [summaryVector] = await getEmbeddingClient().embed([summaryText]);

  // Compute Level 2 vectors (Granular turns)
  const chunkVectors = new Map<number, number[]>();
  if (s.chunks.length > 0) {
    const chunkTexts = s.chunks.map((chunk: any) => chunk.text);
    const vectors = await getEmbeddingClient().embed(chunkTexts);
    s.chunks.forEach((chunk: any, index: number) => {
      chunkVectors.set(chunk.stepIndex, vectors[index]);
    });
  }

  store.save(s, {
    summary: summaryVector,
    chunks: chunkVectors
  });
  return true;
}

// Incremental Indexing function
export async function syncHistory(force: boolean = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastSyncTime < SYNC_COOLDOWN_MS) {
    return;
  }

  if (activeSync) {
    return activeSync;
  }

  activeSync = (async () => {
    const store = getStore();
    console.error("[Chronicle MCP] Syncing history from registered adapters...");

    for (const adapter of ADAPTERS) {
      try {
        const sessions = await adapter.discoverSessions();
        let newCount = 0;

        for (const s of sessions) {
          const didSync = await syncSingleSession(s, store);
          if (didSync) {
            newCount++;
          }
        }

        if (newCount > 0) {
          console.error(`[Chronicle MCP] Indexed ${newCount} new sessions from adapter "${adapter.name}".`);
        }
      } catch (e: any) {
        console.error(`[Chronicle MCP] Adapter "${adapter.name}" failed:`, e.message);
      }
    }
    console.error("[Chronicle MCP] Sync completed!");
    lastSyncTime = Date.now();
  })();

  try {
    await activeSync;
  } finally {
    activeSync = null;
  }
}

// Initialize MCP Server
const server = new Server( // NOSONAR
  {
    name: "chronicle-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Shared schema definition for conversation step slicing and sorting to avoid SonarCloud duplication
const conversationStepParams = {
  conversationStepsOnly: {
    type: "boolean",
    description: "Include only conversation steps.",
    default: false,
  },
  reverseSteps: {
    type: "boolean",
    description: "Retrieve history in reverse order.",
    default: false,
  },
  startConversationStep: {
    type: "number",
    description: "Start 1-based conversation step index (inclusive).",
  },
  endConversationStep: {
    type: "number",
    description: "End 1-based conversation step index (inclusive).",
  },
};

// Register Tool Definitions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: any[] = [
    {
      name: "chronicle_guide",
      description: "Self-guide tool providing usage patterns, tool selection matrix, and token-saving rules for chronicle-mcp.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_sessions",
      description: "List indexed development sessions.",
      inputSchema: {
        type: "object",
        properties: {
          adapter: {
            type: "string",
            description: "Filter sessions by adapter: 'antigravity' or 'cursor'.",
          },
          limit: {
            type: "number",
            description: "Max number of sessions to return",
            default: 10,
          },
          projectPath: {
            type: "string",
            description: "Filter sessions by absolute workspace path.",
          },
          scope: {
            type: "string",
            enum: ["workspace", "all"],
            description: "Search scope: 'workspace' limits results to the active project; 'all' searches globally.",
            default: "all"
          },
          timeRange: {
            type: "string",
            description: "Search sessions within a time range, formatted as 'start:end' (e.g. '2026-06-20:2026-06-22' or '1781298371:1781308371'). Leave one side blank for open-ended range."
          },
          sortBy: {
            type: "string",
            enum: ["created", "active"],
            description: "Sort sessions by: 'created' for creation time; 'active' for latest activity time.",
            default: "active"
          },
        },
      },
    },
    {
      name: "query_transcript",
      description: "Read, query, filter, slice, and export session transcript entries, tool calls, and execution results using categories and sort modes.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "Filter by session ID. If omitted, searches across all indexed sessions.",
          },
          stepIndex: {
            type: "integer",
            description: "Retrieve a single specific step index within a session.",
          },
          startStep: {
            type: "integer",
            description: "Start step index (inclusive) for slicing.",
          },
          endStep: {
            type: "integer",
            description: "End step index (inclusive) for slicing.",
          },
          startConversationStep: {
            type: "integer",
            description: "Start 1-based conversation turn index (inclusive).",
          },
          endConversationStep: {
            type: "integer",
            description: "End 1-based conversation turn index (inclusive).",
          },
          query: {
            type: "string",
            description: "Text query to find in content, thinking, or tool calls.",
          },
          toolName: {
            type: "string",
            description: "Filter by executed tool name (e.g. patch_file, view_file).",
          },
          serverName: {
            type: "string",
            description: "Filter by MCP server name (e.g. patchitright, chronicle).",
          },
          type: {
            type: "string",
            description: "Filter by step type (e.g. PLANNER_RESPONSE, MCP_TOOL, COMMAND).",
          },
          status: {
            type: "string",
            description: "Filter by step status (e.g. DONE, ERROR).",
          },
          scope: {
            type: "string",
            enum: ["workspace", "all"],
            description: "Search scope: 'workspace' limits results to the active project; 'all' searches globally.",
            default: "all",
          },
          projectPath: {
            type: "string",
            description: "Filter by absolute workspace path.",
          },
          categories: {
            type: "array",
            items: {
              type: "string",
              enum: ["conversation_steps", "tool_calls", "tool_results", "thinking", "system_events"],
            },
            description: "List of information categories to extract. Both omitting property and passing empty array [] default to all 5 categories.",
          },
          sort: {
            type: "string",
            enum: ["time_old_to_new", "time_new_to_old", "category"],
            description: "Output sort and grouping mode.",
            default: "time_old_to_new",
          },
          limit: {
            type: "integer",
            description: "Max number of steps/entries to return",
            default: 20,
          },
          output: {
            type: "string",
            description: "Absolute path to output file (.md or .json) or directory to write results directly.",
          },
        },
      },
    },
    {
      name: "get_session_artifacts",
      description: "Retrieve markdown artifacts (walkthrough.md, implementation_plan.md, task.md) for a session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "Unique session ID.",
          },
          output: {
            type: "string",
            description: "Absolute path to the output file or directory. If a directory is specified, a default filename will be generated.",
          },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "search_history",
      description: "Perform semantic search across past sessions and turns.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language query or topic.",
          },
          limit: {
            type: "number",
            description: "Max number of matching chunks to return",
            default: 5,
          },
          projectPath: {
            type: "string",
            description: "Filter by absolute workspace path.",
          },
          scope: {
            type: "string",
            enum: ["workspace", "all"],
            description: "Search scope: 'workspace' limits results to the active project; 'all' searches globally.",
            default: "all"
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_tool_usage_stats",
      description: "Retrieve tool execution statistics (counts) across recent sessions.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of recent sessions to analyze",
            default: 30,
          },
          projectPath: {
            type: "string",
            description: "Filter by absolute workspace path.",
          },
          scope: {
            type: "string",
            enum: ["workspace", "all"],
            description: "Search scope: 'workspace' limits results to the active project; 'all' searches globally.",
            default: "all"
          },
        },
      },
    },
    {
      name: "get_session_benchmarks",
      description: "Compare duration, tool calls, token usage, and errors across sessions.",
      inputSchema: {
        type: "object",
        properties: {
          sessionIds: {
            type: "array",
            items: {
              type: "string",
            },
            description: "Session IDs to benchmark.",
          },
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Name of the group (e.g. 'Group A')",
                },
                sessionIds: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  description: "Session IDs to compare.",
                },
              },
              required: ["name", "sessionIds"],
            },
            description: "Groups of session IDs to compare aggregated averages.",
          },
          output: {
            type: "string",
            description: "Absolute path to the output file or directory. If a directory is specified, a default filename will be generated.",
          },
          linechart_output: {
            type: "string",
            description: "Optional absolute path to export an interactive HTML line chart visualizing context window size over steps with Checkpoints and conversational steps highlighted.",
          },
        },
        required: ["sessionIds"],
      },
    }
  ];

  if (!isAutoSyncEnabled()) {
    tools.push({
      name: "sync_history",
      description: "Index new session logs.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    });
  }

  if (isLegacyToolsEnabled()) {
    tools.push(
      {
        name: "get_session_details",
        description: "[Legacy Wrapper] Retrieve conversational history and steps of a specific session.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "Unique session ID." },
            includeToolCalls: { type: "boolean", default: false },
            includeCallResults: { type: "boolean", default: false },
            startStep: { type: "number" },
            endStep: { type: "number" },
            excludeContent: { type: "boolean", default: false },
            includeTimestamps: { type: "boolean", default: false },
            output: { type: "string" },
            ...conversationStepParams,
          },
          required: ["sessionId"],
        },
      },
      {
        name: "get_step_details",
        description: "[Legacy Wrapper] Retrieve content, thinking, and tool execution details for specific step indexes in a session.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "Unique session ID." },
            stepIndex: { type: "number" },
            startStep: { type: "number" },
            endStep: { type: "number" },
            ...conversationStepParams,
          },
          required: ["sessionId"],
        },
      },
      {
        name: "search_steps",
        description: "[Legacy Wrapper] Search across indexed steps by text query, step type, status, or tool name.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            sessionId: { type: "string" },
            type: { type: "string" },
            status: { type: "string" },
            limit: { type: "number", default: 10 },
            projectPath: { type: "string" },
            scope: { type: "string", enum: ["workspace", "all"], default: "all" },
            toolName: { type: "string" },
            serverName: { type: "string" },
            excludeContent: { type: "boolean", default: false },
            conversationStepsOnly: { type: "boolean", default: false },
            includeToolResults: { type: "boolean", default: false },
          },
        },
      }
    );
  }

  return { tools };
});

function handleOutputWrite(
  md: string,
  outputPath?: string,
  defaultFilename?: string
): any {
  if (!outputPath) {
    return {
      content: [
        {
          type: "text",
          text: md,
        },
      ],
    };
  }

  try {
    let targetPath = outputPath;
    
    // Check if the outputPath is a directory or doesn't look like a file
    let isDir = false;
    try {
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory()) {
        isDir = true;
      }
    } catch {
      // If it doesn't exist, check if it doesn't end with .md
      if (!outputPath.toLowerCase().endsWith(".md")) {
        isDir = true;
      }
    }

    if (isDir) {
      if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
      }
      const filename = defaultFilename || `output_${Date.now()}.md`;
      targetPath = path.join(outputPath, filename);
    } else {
      const parentDir = path.dirname(outputPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
    }

    fs.writeFileSync(targetPath, md, "utf-8");
    const filename = path.basename(targetPath);
    return {
      content: [
        {
          type: "text",
          text: `Output successfully saved to: [${filename}](file:///${targetPath.replaceAll("\\", "/")})`,
        },
      ],
    };
  } catch (e: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error saving output to ${outputPath}: ${e.message}`,
        },
      ],
      isError: true,
    };
  }
}

function handleChronicleGuide(): any {
  const guideContent = {
    version: "1.2.0",
    content: `## chronicle-mcp (v1.2.0)

Local conversation history, step-level tool inspection, prompt benchmarking, and subagent hierarchy companion.

### Tool & Parameter Decision Router

\`\`\`mermaid
flowchart TD
    Task["Need Session History or Tool Step Context"] --> Choice{"What is the query objective?"}
    
    Choice -->|"Search past solutions / natural query"| SearchHist["1. Call search_history(query, scope='workspace'|'all')"]
    SearchHist --> ViewSess["2. Call get_session_details(sessionId, conversationStepsOnly=true)"]
    
    Choice -->|"Read MOST RECENT dialogue turns first"| ReadRecent["Call get_session_details(sessionId, reverseSteps=true, conversationStepsOnly=true)"]
    
    Choice -->|"Read SPECIFIC turn range (e.g. turns 5 to 10)"| ReadRange["Call get_session_details(sessionId, startConversationStep=5, endConversationStep=10)"]
    
    Choice -->|"Debug failed tool call / error traceback"| SearchError["1. Call search_steps(status='ERROR', type='MCP_TOOL')"]
    SearchError --> InspectStep["2. Call get_step_details(sessionId, stepIndex)"]

    Choice -->|"Search step content / tool parameter text"| SearchText["Call search_steps(query='search term', toolName='...', scope='workspace')"]
    
    Choice -->|"Analyze tool call frequency & counts"| ToolStats["Call get_tool_usage_stats(limit=30, scope='workspace'|'all')"]
    
    Choice -->|"Export session logs / benchmarks to disk"| ExportDisk["Call get_session_details or get_session_benchmarks with output='path'"]
\`\`\`

### Session Reading & Hierarchy Directives
* **Pre-Query Sync Directive**: Call \`sync_history\` (or \`sync_history(force=true)\`) before querying recent sessions or after major task milestones to ensure all un-indexed log entries from disk are indexed before retrieval.
* **Read Recent Turns First**: ALWAYS set \`reverseSteps=true\` in \`get_session_details\` or \`get_step_details\` when investigating recent context or latest user feedback to avoid parsing old steps.
* **Enforce User Scope**: MUST set \`scope="workspace"\` when user restricts request to current project; set \`scope="all"\` when searching across repositories.
* **Dialogue-Only Reading**: MUST set \`conversationStepsOnly=true\` when user wants to read human-assistant dialogue, skipping intermediate tool execution payloads.
* **Turn Slicing**: Use \`startConversationStep\` and \`endConversationStep\` (1-based conversation index) to retrieve specific dialogue windows.
* **Session Listing**: ALWAYS set \`sortBy="active"\` in \`list_sessions\` to retrieve recently active sessions first.
* **Subagent & Parent Session Tracing**: \`get_session_details\` automatically embeds clickable links to the Parent Session (if invoked as subagent) and list of Subagents Spawned. Inspect these links to trace parent/subagent context without manual search.
* **Execution Timestamps**: Pass \`includeTimestamps=true\` in \`get_session_details\` to inspect step execution times.

### Tool Matrix

| Tool Name | Call this tool when... | DO NOT call when... |
| :--- | :--- | :--- |
| \`list_sessions\` | Finding active sessions by \`scope\`, \`adapter\`, \`timeRange\`, or \`sortBy='active'\`. | Inspecting session content (use \`get_session_details\`). |
| \`search_history\` | Searching past solutions using natural language queries. | Searching for exact tool names, error statuses, or code tracebacks (use \`search_steps\`). |
| \`search_steps\` | Filtering execution steps by \`query\`, \`status='ERROR'\`, \`toolName\`, \`serverName\`, or \`type\`. | Searching for high-level semantic concepts or past user intent (use \`search_history\`). |
| \`get_session_details\` | Reading structured user-assistant conversation history, subagent links, or parent session for a session. | Inspecting raw parameters/results of a single step (use \`get_step_details\`). |
| \`get_step_details\` | Retrieving raw JSON arguments, thinking blocks, or error tracebacks of specific step indexes. | Reading full session conversation flows (use \`get_session_details\`). |
| \`get_tool_usage_stats\` | Retrieving tool call counts and usage statistics across recent sessions. | Inspecting session content or searching specific step payloads. |
| \`get_session_benchmarks\` | Comparing token usage, duration, or cache hit rates across session groups. | Retrieving actual code or conversation text. |
| \`get_session_artifacts\` | Retrieving generated plan or walkthrough markdown files for a session. | Reading raw step logs or tool execution details. |
| \`sync_history\` | Force-syncing latest un-indexed session logs from adapters (Antigravity, Cursor). | Auto-sync is active (triggered automatically before tool execution). |
| \`chronicle_guide\` | Self-guide tool providing usage patterns, tool selection matrix, and token-saving rules. | Executing queries against sessions or steps. |

### Token Optimization & Parameter Rules
* \`excludeContent=true\`: MUST set in \`get_session_details\` or \`search_steps\` when inspecting step metadata to prevent token bloat.
* \`output="<absolute_path>"\`: MUST pass in \`get_session_details\`, \`get_session_artifacts\`, or \`get_session_benchmarks\` to write files directly to disk.

### Failure Recovery
* **Session not found**: If \`get_session_details\` returns \`Session not found\`, call \`sync_history\` to index recent log files.
* **Empty search results**: If \`search_steps\` returns \`[]\`, widen search by setting \`scope="all"\` or removing \`toolName\` / \`query\` filters.
* **Context Window Truncation**: If response payload is too large, re-query with \`excludeContent=true\` and use \`get_step_details\` only for target \`stepIndex\`.

### Critical Directives
* **NEVER** use file reading tools on raw log files (\`transcript.jsonl\`, \`state.vscdb\`). ALWAYS use \`chronicle-mcp\` tools.
* **ALWAYS** delegate file writing to server via \`output\` parameter instead of receiving text payloads and writing manually.`
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

async function handleListSessions(args: any): Promise<any> {
  const adapter = args?.adapter as string | undefined;
  const limit = (args?.limit as number) || 10;
  const projectPath = args?.projectPath as string | undefined;
  const scope = args?.scope as ScopeType | undefined;
  const timeRange = args?.timeRange as string | undefined;
  const sortBy = args?.sortBy as "created" | "active" | undefined;

  const store = getStore();
  const result = store.query({
    adapter,
    projectPath,
    scope,
    limit,
    timeRange,
    sortBy
  });

  const rows = result.sessions.map(s => ({
    id: s.id,
    adapter: s.adapter,
    title: s.title,
    project_path: s.projectPath,
    created_at: s.createdAt,
    last_active_at: s.lastActiveAt,
    first_prompt: s.firstPrompt
  }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(rows, null, 2),
      },
    ],
  };
}

async function handleGetSessionDetails(args: any): Promise<any> {
  const sessionId = args?.sessionId as string;
  const includeToolCalls = args?.includeToolCalls as boolean | undefined;
  const includeCallResults = args?.includeCallResults as boolean | undefined;
  const startStep = args?.startStep as number | undefined;
  const endStep = args?.endStep as number | undefined;
  const excludeContent = args?.excludeContent as boolean | undefined;
  const includeTimestamps = args?.includeTimestamps as boolean | undefined;
  const conversationStepsOnly = args?.conversationStepsOnly as boolean | undefined;
  const reverseSteps = args?.reverseSteps as boolean | undefined;
  const startConversationStep = args?.startConversationStep as number | undefined;
  const endConversationStep = args?.endConversationStep as number | undefined;

  const details = await getSessionDetailsFromDb(sessionId, {
    includeToolCalls,
    includeCallResults,
    startStep,
    endStep,
    excludeContent,
    conversationStepsOnly,
    reverseSteps,
    startConversationStep,
    endConversationStep,
  });

  if (!details) {
    return {
      content: [
        {
          type: "text",
          text: `Session "${sessionId}" not found. Try running sync_history.`,
        },
      ],
      isError: true,
    };
  }

  // Format detail response as readable markdown
  let md = `# Session: ${details.title}\n`;
  md += `* **ID**: \`${details.id}\`\n`;
  md += `* **Adapter**: \`${details.adapter}\`\n`;
  md += `* **Project**: \`${details.project_path || "N/A"}\`\n`;
  md += `* **Created**: ${new Date(details.created_at).toLocaleString()}\n`;
  if (details.parent_id) {
    const db = getDb();
    const parent = db.prepare("SELECT title FROM sessions WHERE id = ?").get(details.parent_id) as any;
    if (parent) {
      const homedir = os.homedir();
      md += `* **Parent Session**: **[${parent.title}](file:///${homedir.replaceAll("\\", "/")}/.gemini/antigravity/brain/${details.parent_id})** (\`${details.parent_id}\`)\n`;
    }
  }
  md += `\n--- \n\n`;

  const needSteps = includeToolCalls || includeCallResults || conversationStepsOnly;

  if (needSteps) {
    for (const step of details.steps) {
      const timeStr = (includeTimestamps && step.created_at) ? ` (${new Date(step.created_at).toLocaleString()})` : "";
      const convStepIdx = step.conversation_step_index ? ` (Conversation Step ${step.conversation_step_index})` : "";
      if (step.type === "USER_INPUT") {
        md += `### Step ${step.step_index}${convStepIdx}${timeStr}\n**User**: ${step.content || ""}\n\n`;
      } else if (step.type === "PLANNER_RESPONSE") {
        md += `### Step ${step.step_index}${convStepIdx}${timeStr}\n`;
        if (step.thinking) {
          md += `**Thinking**:\n\`\`\`\n${step.thinking}\n\`\`\`\n\n`;
        }
        if (step.content) {
          md += `**Assistant**: ${step.content}\n\n`;
        }
        if (step.tool_calls) {
          try {
            md += `**Tool Calls**:\n\`\`\`json\n${JSON.stringify(JSON.parse(step.tool_calls), null, 2)}\n\`\`\`\n\n`;
          } catch {
            md += `**Tool Calls**: ${step.tool_calls}\n\n`;
          }
        }
      } else if (includeCallResults) {
        md += `### Step ${step.step_index} (${step.type})${convStepIdx}${timeStr}\n`;
        md += `* **Source**: \`${step.source}\` | **Status**: \`${step.status}\`\n\n`;
        if (step.content) {
          md += `**Result**:\n\`\`\`\n${step.content}\n\`\`\`\n\n`;
        }
      }
    }
  } else {
    for (const chunk of details.chunks) {
      const formattedText = chunk.chunk_text
        .replace(/^User:/gm, "**User**:")
        .replace(/^Assistant:/gm, "**Assistant**:")
        .replaceAll("\n**Assistant**:", "\n\n**Assistant**:");
      const convStepIdx = chunk.conversation_step_index ? ` (Conversation Step ${chunk.conversation_step_index})` : "";
      md += `### Step ${chunk.step_index}${convStepIdx}\n${formattedText}\n\n`;
    }
  }

  const db = getDb();
  const subagents = db.prepare("SELECT id, title FROM sessions WHERE parent_id = ?").all(sessionId) as any[];
  if (subagents && subagents.length > 0) {
    md += `### Subagents Spawned\n`;
    const homedir = os.homedir();
    for (const sub of subagents) {
      md += `*   **[${sub.title}](file:///${homedir.replaceAll("\\", "/")}/.gemini/antigravity/brain/${sub.id})** (\`${sub.id}\`)\n`;
    }
    md += `\n`;
  }

  const outputPath = args?.output as string | undefined;
  return handleOutputWrite(md, outputPath, `session_${sessionId}.md`);
}

async function handleGetStepDetails(args: any): Promise<any> {
  const categories: StepCategory[] = [];
  if (args?.conversationStepsOnly) categories.push("conversation_steps");
  const sort = args?.reverseSteps ? "time_new_to_old" : "time_old_to_new";

  return handleQueryTranscript({
    ...args,
    categories: categories.length > 0 ? categories : undefined,
    sort,
  });
}

async function handleGetSessionArtifacts(args: any): Promise<any> {
  const sessionId = args?.sessionId as string;
  const homedir = os.homedir();
  const brainDir = path.join(homedir, ".gemini", "antigravity", "brain");
  const sessionDir = path.join(brainDir, sessionId);

  if (!fs.existsSync(sessionDir)) {
    return {
      content: [
        {
          type: "text",
          text: `Artifact directory for session "${sessionId}" not found.`,
        },
      ],
      isError: true,
    };
  }

  const mdFiles = fs.readdirSync(sessionDir).filter((file: string) => file.endsWith(".md"));
  if (mdFiles.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No markdown artifacts found in session "${sessionId}".`,
        },
      ],
    };
  }

  let md = `# Artifacts for Session: ${sessionId}\n\n`;
  for (const file of mdFiles) {
    const filePath = path.join(sessionDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    md += `## File: [${file}](file:///${filePath.replaceAll("\\", "/")})\n\n`;
    md += `${content}\n\n`;
    md += `--- \n\n`;
  }

  const outputPath = args?.output as string | undefined;
  return handleOutputWrite(md, outputPath, `artifacts_${sessionId}.md`);
}

export async function handleQueryTranscript(args: any): Promise<any> {
  const sessionId = args?.sessionId as string | undefined;
  const stepIndex = args?.stepIndex as number | undefined;
  const startStep = args?.startStep as number | undefined;
  const endStep = args?.endStep as number | undefined;
  const startConversationStep = args?.startConversationStep as number | undefined;
  const endConversationStep = args?.endConversationStep as number | undefined;
  const queryText = args?.query as string | undefined;
  const toolName = args?.toolName as string | undefined;
  const serverName = args?.serverName as string | undefined;
  const type = args?.type as string | undefined;
  const status = args?.status as string | undefined;
  const limit = (args?.limit as number) || 20;
  const projectPath = args?.projectPath as string | undefined;
  const scope = args?.scope as "workspace" | "all" | undefined;
  let categories = args?.categories as StepCategory[] | undefined;
  const sortMode: StepSortMode = args?.sort || "time_old_to_new";
  const outputPath = args?.output as string | undefined;

  // Normalize categories if omitted or empty
  if (!categories || categories.length === 0) {
    categories = ["conversation_steps", "tool_calls", "tool_results", "thinking", "system_events"];
  }

  const store = getStore();
  const queryResult = store.query({
    sessionId,
    stepIndex,
    startStep,
    endStep,
    startConversationStep,
    endConversationStep,
    stepQuery: queryText,
    stepType: type,
    stepStatus: status,
    projectPath,
    scope,
    toolName,
    serverName,
    includeSteps: true,
    categories,
    sort: sortMode,
  });

  const stepsWithSessionId: any[] = [];
  const convStepIndexMaps = new Map<string, Map<number, number>>();

  for (const s of queryResult.sessions) {
    if (s.steps) {
      let convMap = convStepIndexMaps.get(s.id);
      if (!convMap) {
        const allConvResult = store.query({
          sessionId: s.id,
          includeSteps: true,
          conversationStepsOnly: true,
        });
        const sortedConvSteps = [...allConvResult.steps].sort((a, b) => a.stepIndex - b.stepIndex);
        convMap = new Map<number, number>();
        sortedConvSteps.forEach((step, idx) => {
          convMap!.set(step.stepIndex, idx + 1);
        });
        convStepIndexMaps.set(s.id, convMap);
      }

      for (const step of s.steps) {
        let toolResult: any = (step as any).tool_result;
        if (categories.includes("tool_results") && !toolResult && (step.toolCalls || (step as any).tool_calls)) {
          const nextStep = s.steps.find((ns: any) => ns.stepIndex === step.stepIndex + 1);
          if (nextStep && (nextStep.type === "MCP_TOOL" || nextStep.type === "COMMAND" || nextStep.source === "SYSTEM")) {
            toolResult = {
              step_index: nextStep.stepIndex,
              type: nextStep.type,
              source: nextStep.source,
              status: nextStep.status,
              content: nextStep.content ?? null,
            };
          }
        }

        const stepObj: any = {
          session_id: s.id,
          step_index: step.stepIndex,
          type: step.type,
          source: step.source,
          status: step.status,
          created_at: step.createdAt ?? null,
          conversation_step_index: convMap.get(step.stepIndex) ?? null,
        };

        if (categories.includes("conversation_steps") || (categories.includes("system_events") && !categories.includes("tool_results"))) {
          stepObj.content = step.content ?? null;
        }
        if (categories.includes("thinking")) {
          stepObj.thinking = step.thinking ?? null;
        }
        if (categories.includes("tool_calls")) {
          stepObj.tool_calls = step.toolCalls ?? null;
        }
        if (categories.includes("tool_results") && toolResult !== undefined) {
          stepObj.tool_result = toolResult;
        }

        stepsWithSessionId.push(stepObj);
      }
    }
  }

  // Sort logic
  if (sortMode === "time_new_to_old") {
    stepsWithSessionId.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  } else if (sortMode === "time_old_to_new") {
    stepsWithSessionId.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  }

  const rows = stepsWithSessionId.slice(0, limit);

  let finalPayload: any = rows;

  // Group by category if sort === "category"
  if (sortMode === "category") {
    const grouped: Record<string, any[]> = {
      conversation_steps: [],
      tool_calls: [],
      tool_results: [],
      thinking: [],
      system_events: [],
    };

    for (const step of rows) {
      if (categories.includes("conversation_steps") && (step.type === "USER_INPUT" || (step.type === "PLANNER_RESPONSE" && step.content))) {
        grouped.conversation_steps.push(step);
      }
      if (categories.includes("tool_calls") && step.tool_calls) {
        grouped.tool_calls.push(step);
      }
      if (categories.includes("tool_results") && (step.type === "MCP_TOOL" || step.type === "COMMAND" || step.tool_result)) {
        grouped.tool_results.push(step);
      }
      if (categories.includes("thinking") && step.thinking) {
        grouped.thinking.push(step);
      }
      if (categories.includes("system_events") && (step.type === "CHECKPOINT" || step.status === "ERROR" || step.source === "SYSTEM")) {
        grouped.system_events.push(step);
      }
    }
    finalPayload = grouped;
  }

  // Handle Output file export if specified
  if (outputPath) {
    let outputText = "";
    if (outputPath.endsWith(".json")) {
      outputText = JSON.stringify(finalPayload, null, 2);
    } else {
      // Format as readable markdown transcript documentation
      let md = `# Session Transcript: ${sessionId || "Query Result"}\n\n`;
      if (Array.isArray(finalPayload)) {
        for (const step of finalPayload) {
          const convStepIdx = step.conversation_step_index ? ` (Conversation Step ${step.conversation_step_index})` : "";
          const timeStr = step.created_at ? ` (${new Date(step.created_at).toLocaleString()})` : "";
          if (step.type === "USER_INPUT") {
            md += `### Step ${step.step_index}${convStepIdx}${timeStr}\n**User**: ${step.content || ""}\n\n`;
          } else if (step.type === "PLANNER_RESPONSE") {
            md += `### Step ${step.step_index}${convStepIdx}${timeStr}\n`;
            if (step.thinking) {
              md += `**Thinking**:\n\`\`\`\n${step.thinking}\n\`\`\`\n\n`;
            }
            if (step.content) {
              md += `**Assistant**: ${step.content}\n\n`;
            }
            if (step.tool_calls) {
              try {
                md += `**Tool Calls**:\n\`\`\`json\n${JSON.stringify(JSON.parse(step.tool_calls), null, 2)}\n\`\`\`\n\n`;
              } catch {
                md += `**Tool Calls**: ${step.tool_calls}\n\n`;
              }
            }
            if (step.tool_result) {
              md += `**Tool Result** (\`${step.tool_result.type}\`):\n\`\`\`\n${step.tool_result.content || ""}\n\`\`\`\n\n`;
            }
          } else if (step.type === "MCP_TOOL" || step.type === "COMMAND") {
            md += `### Step ${step.step_index}${convStepIdx}${timeStr} (\`${step.type}\`)\n`;
            if (step.content) {
              md += `**Result**:\n\`\`\`\n${step.content}\n\`\`\`\n\n`;
            }
          } else {
            md += `### Step ${step.step_index}${convStepIdx}${timeStr} (\`${step.type}\`)\n`;
            if (step.content) {
              md += `${step.content}\n\n`;
            }
          }
        }
      } else {
        outputText = `# Transcript Query Export\n\n\`\`\`json\n${JSON.stringify(finalPayload, null, 2)}\n\`\`\`\n`;
        md = outputText;
      }

      outputText = md;
    }

    return handleOutputWrite(outputText, outputPath, `transcript_${sessionId || "query"}.md`);
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(finalPayload, null, 2),
      },
    ],
  };
}

async function handleSearchSteps(args: any): Promise<any> {
  const categories: StepCategory[] = [];
  if (args?.conversationStepsOnly) categories.push("conversation_steps");
  if (args?.includeToolResults) categories.push("tool_calls", "tool_results");

  return handleQueryTranscript({
    ...args,
    categories: categories.length > 0 ? categories : undefined,
  });
}

async function handleSearchHistory(args: any): Promise<any> {
  const query = args?.query as string;
  const limit = (args?.limit as number) || 5;
  const projectPath = args?.projectPath as string | undefined;
  const scope = args?.scope as ScopeType | undefined;

  console.error(`[Chronicle MCP] Generating embedding for query: "${query}"`);
  const [queryVector] = await getEmbeddingClient().embed([query]);

  const hits = await searchHistory(queryVector, limit, { projectPath, scope });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(hits, null, 2),
      },
    ],
  };
}

async function handleGetToolUsageStats(args: any): Promise<any> {
  const limit = args?.limit as number | undefined;
  const projectPath = args?.projectPath as string | undefined;
  const scope = args?.scope as ScopeType | undefined;

  const stats = await getToolUsageStats({ limit, projectPath, scope });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(stats, null, 2),
      },
    ],
  };
}

async function handleGetSessionBenchmarks(args: any): Promise<any> {
  const sessionIds = args?.sessionIds as string[];
  const groups = args?.groups as Array<{ name: string; sessionIds: string[] }> | undefined;

  const metrics = await computeSessionBenchmarks(sessionIds);
  const metricsMap = new Map<string, typeof metrics[0]>();
  for (const m of metrics) {
    metricsMap.set(m.sessionId, m);
  }

  let md = `# Session Benchmarking Report\n\n`;

  if (groups && groups.length > 0) {
    md += `## Group Comparison\n\n`;
    md += `| Group | Avg Steps | Avg Tool Calls | Avg Duration (s) | Avg Cum. Input | Avg Cache Hit % | Avg Cost Saved % | Avg Peak Context | Total Errors |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

    for (const g of groups) {
      let sumSteps = 0;
      let sumToolCalls = 0;
      let sumDurationMs = 0;
      let durationCount = 0;
      let sumCumulativeInput = 0;
      let sumCacheHitTokens = 0;
      let sumCacheMissTokens = 0;
      let sumPeakContext = 0;
      let sumErrors = 0;
      let count = 0;

      for (const sid of g.sessionIds) {
        const m = metricsMap.get(sid);
        if (m) {
          sumSteps += m.totalSteps;
          sumToolCalls += m.toolCallsCount;
          if (m.durationMs !== null) {
            sumDurationMs += m.durationMs;
            durationCount++;
          }
          sumCumulativeInput += m.cumulativeInputTokens;
          sumCacheHitTokens += m.cacheHitTokens;
          sumCacheMissTokens += m.cacheMissTokens;
          sumPeakContext += m.peakContextSize;
          sumErrors += m.errorStepsCount;
          count++;
        }
      }

      if (count > 0) {
        const avgSteps = (sumSteps / count).toFixed(1);
        const avgToolCalls = (sumToolCalls / count).toFixed(1);
        const avgDuration = durationCount > 0 ? (sumDurationMs / durationCount / 1000).toFixed(1) : "N/A";
        const avgCumInput = Math.round(sumCumulativeInput / count).toLocaleString();
        const avgCacheHitRate = sumCumulativeInput > 0 ? ((sumCacheHitTokens / sumCumulativeInput) * 100).toFixed(1) : "0.0";
        const avgCostSavings = sumCumulativeInput > 0 ? ((1 - (sumCacheMissTokens + 0.1 * sumCacheHitTokens) / sumCumulativeInput) * 100).toFixed(1) : "0.0";
        const avgPeakContext = Math.round(sumPeakContext / count).toLocaleString();
        md += `| **${g.name}** (${count} sessions) | ${avgSteps} | ${avgToolCalls} | ${avgDuration}s | ${avgCumInput} | ${avgCacheHitRate}% | ${avgCostSavings}% | ${avgPeakContext} | ${sumErrors} |\n`;
      } else {
        md += `| **${g.name}** | - | - | - | - | - | - | - | - |\n`;
      }
    }
    md += `\n`;
  }

  md += `## Individual Session Breakdown\n\n`;
  md += `| Session / ID | Group | Steps | Tool Calls | Duration | Cum. Input | Cache Hit % | Cost Saved % | Peak Context | Output Tokens | Errors |\n`;
  md += `| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

  for (const m of metrics) {
    let groupName = "N/A";
    if (groups) {
      const g = groups.find(x => x.sessionIds.includes(m.sessionId));
      if (g) groupName = g.name;
    }

    const durationText = m.durationMs === null ? "N/A" : `${(m.durationMs / 1000).toFixed(1)}s`;
    const titleText = m.title.length > 40 ? m.title.slice(0, 37) + "..." : m.title;
    const homedir = os.homedir();
    const sessionLink = `[${titleText}](file:///${homedir.replaceAll("\\", "/")}/.gemini/antigravity/brain/${m.sessionId})`;

    md += `| ${sessionLink}<br>\`${m.sessionId.slice(0, 8)}\` | ${groupName} | ${m.totalSteps} | ${m.toolCallsCount} | ${durationText} | ${m.cumulativeInputTokens.toLocaleString()} | ${m.cacheHitRate.toFixed(1)}% | ${m.estimatedCostSavings.toFixed(1)}% | ${m.peakContextSize.toLocaleString()} | ${m.estimatedOutputTokens.toLocaleString()} | ${m.errorStepsCount} |\n`;
  }
  md += `\n`;

  const linechartPath = (args?.linechart_output || args?.linechartOutput) as string | undefined;
  if (linechartPath && sessionIds && sessionIds.length > 0) {
    const store = getStore();
    for (const sid of sessionIds) {
      const qResult = store.query({ sessionId: sid, includeSteps: true });
      const sess = qResult.sessions[0];
      if (sess && qResult.steps) {
        const chartHtml = generateInteractiveContextChartHtml(sid, sess.title || sid, qResult.steps);
        const chartResult = await handleOutputWrite(chartHtml, linechartPath, `context_chart_${sid.slice(0, 8)}.html`);
        const writtenText = chartResult.content?.[0]?.text || "";
        md += `> **Interactive Context Window Chart**: ${writtenText}\n\n`;
      }
    }
  }

  const outputPath = args?.output as string | undefined;
  return handleOutputWrite(md, outputPath, `benchmarks_${Date.now()}.md`);
}

// Handle Tool Calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (isAutoSyncEnabled() && name !== "sync_history") {
      await syncHistory();
    }

    switch (name) {
      case "chronicle_guide":
        return handleChronicleGuide();
      case "query_transcript":
        return await handleQueryTranscript(args);
      case "get_session_details":
        return await handleGetSessionDetails(args);
      case "get_step_details":
        return await handleGetStepDetails(args);
      case "get_session_artifacts":
        return await handleGetSessionArtifacts(args);
      case "search_steps":
        return await handleSearchSteps(args);
      case "search_history":
        return await handleSearchHistory(args);
      case "get_tool_usage_stats":
        return await handleGetToolUsageStats(args);
      case "get_session_benchmarks":
        return await handleGetSessionBenchmarks(args);
      case "sync_history":
        await syncHistory(true);
        return {
          content: [
            {
              type: "text",
              text: "History synchronization completed successfully.",
            },
          ],
        };
      default:
        throw new Error(`Tool "${name}" not found.`);
    }
  } catch (e: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error executing tool "${name}": ${e.message}`,
        },
      ],
      isError: true,
    };
  }
});

const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  fileURLToPath(import.meta.url).replace(/\.js$/, ".ts") === path.resolve(process.argv[1])
);

if (isMain) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Chronicle MCP] Unified History Server running on stdio transport.");

  try {
    await syncHistory();
  } catch (e: any) {
    console.error("[Chronicle MCP] Initial sync failed:", e.message || String(e));
  }
}
