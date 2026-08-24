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
import {
  searchHistory,
  queryTranscript,
  getSessionDetailsFromDb,
  computeSessionBenchmarks,
  getToolUsageStats,
  generateInteractiveContextChartHtml,
} from "./search.js";
import { ProgressReporter, ProgressNotify } from "./progress.js";
import { handleChronicleGuide } from "./guide.js";

let activeSync: Promise<void> | null = null;

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

    const stepsResult = store.query({ sessionId: s.id, includeSteps: true, includeUndone: true });
    const existingStepIndices = new Set(stepsResult.steps.map((step: any) => step.stepIndex));

    const newChunks = s.chunks.filter((c: any) => !existingChunkIndices.has(c.stepIndex));
    const newSteps = (s.steps || []).filter((step: any) => !existingStepIndices.has(step.stepIndex));

    const stepsCountChanged = (s.steps || []).length !== stepsResult.steps.length;
    const promptChanged = existingSession.firstPrompt !== s.firstPrompt || existingSession.secondPrompt !== s.secondPrompt;
    const titleChanged = existingSession.title !== s.title;

    const dbUndoneCount = stepsResult.steps.filter((st: any) => st.isUndone).length;
    const parserUndoneCount = (s.steps || []).filter((st: any) => st.isUndone).length;
    const undoneCountChanged = dbUndoneCount !== parserUndoneCount;

    if (newChunks.length === 0 && newSteps.length === 0 && !titleChanged && !stepsCountChanged && !promptChanged && !undoneCountChanged) {
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
export async function syncHistory(force: boolean = false, reporter?: ProgressReporter): Promise<void> {
  if (activeSync) {
    return activeSync;
  }

  activeSync = (async () => {
    const store = getStore();
    console.error("[Chronicle MCP] Syncing history from registered adapters...");

    for (const adapter of ADAPTERS) {
      try {
        const sessions = await adapter.discoverSessions(reporter);
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
    reporter?.finish("Sync completed!");
    console.error("[Chronicle MCP] Sync completed!");
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
  includeUndone: {
    type: "boolean",
    description: "Include undone / superseded conversation steps.",
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
          parentId: {
            type: "string",
            description: "Filter sessions by parent session ID. Use 'root' or 'null' to filter top-level root sessions only.",
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
      name: "get_session_relationship",
      description: "Expose parent session, child subagent sessions, siblings, and ancestry hierarchy for a given session ID.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "Session ID to explore relationships for.",
          },
          includeAncestors: {
            type: "boolean",
            description: "Include ancestor chain up to root session.",
            default: true,
          },
          maxDepth: {
            type: "integer",
            description: "Maximum depth for recursive child subagent tree graph.",
            default: 2,
            minimum: 1,
            maximum: 10,
          },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "query_transcript",
      description: "Read, query, slice, and progressively disclose conversation transcripts with token-saving detailLevel ('compact', 'full', 'summary'), turn slicing, subagent subtree resolution, and execution filters.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "Session ID to inspect. If omitted, defaults to the most recent workspace session.",
          },
          turnIndex: {
            type: "integer",
            description: "Specific 1-based turn index to retrieve, or negative index (e.g. -1 for latest turn).",
          },
          startTurn: {
            type: "integer",
            description: "Start turn index (inclusive), supports negative indexing (e.g. -3 for last 3 turns).",
          },
          endTurn: {
            type: "integer",
            description: "End turn index (inclusive), supports negative indexing (e.g. -1 for latest turn).",
          },
          lastTurns: {
            type: "integer",
            description: "Retrieve the last N turns.",
          },
          detailLevel: {
            type: "string",
            enum: ["compact", "full", "summary"],
            description: "Detail level: 'compact' (dialogue + execution summary, saving ~80% tokens), 'full' (complete dialogue, thinking, tool args & results), 'summary' (conversational dialogue only).",
            default: "compact",
          },
          include: {
            type: "array",
            items: {
              type: "string",
              enum: ["dialogue", "thinking", "executions", "system_events"],
            },
            description: "Array masks to conditionally include dialogue, thinking, executions, or system_events.",
          },
          filePath: {
            type: "string",
            description: "Filter execution steps touching a specific file path or basename.",
          },
          toolFilter: {
            type: "object",
            properties: {
              name: {
                oneOf: [
                  { type: "string" },
                  { type: "array", items: { type: "string" } },
                ],
                description: "Filter by tool name or array of tool names.",
              },
              server: {
                type: "string",
                description: "Filter by MCP server name.",
              },
              status: {
                type: "string",
                enum: ["DONE", "ERROR", "PENDING"],
                description: "Filter by execution status.",
              },
              kind: {
                type: "string",
                enum: ["mcp", "command", "native", "subagent"],
                description: "Filter by execution kind.",
              },
            },
            description: "Filter execution steps by tool name, server, status, or kind.",
          },
          includeSubtree: {
            type: "boolean",
            description: "Recursively resolve and aggregate turns across all descendant subagents in chronological order.",
            default: false,
          },
          includeUndone: {
            type: "boolean",
            description: "Include undone / rewound steps from superseded branches.",
            default: false,
          },
          maxResultChars: {
            type: "integer",
            description: "Safety truncation limit for individual execution payloads. Default: 2500.",
            default: 2500,
          },
          output: {
            type: "string",
            description: "Path to write output file directly (.md or .json). If a directory is specified, a default timestamped filename will be generated.",
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
      description: "Perform zero-copy turn-level hybrid (FTS5 + Vector BLOB RRF), semantic, or keyword search across development sessions.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query text, symbol, error code, or natural language question.",
          },
          mode: {
            type: "string",
            enum: ["hybrid", "semantic", "keyword"],
            description: "Search mode: 'hybrid' (combines FTS5 BM25 + Vector cosine similarity via RRF k=60), 'semantic' (dense vector cosine similarity), 'keyword' (exact FTS5 symbol matching).",
            default: "hybrid",
          },
          limit: {
            type: "number",
            description: "Maximum number of matching turn results to return. Default: 5.",
            default: 5,
          },
          scope: {
            type: "string",
            enum: ["workspace", "all"],
            description: "Search scope: 'workspace' limits to active project; 'all' searches globally.",
            default: "workspace",
          },
          projectPath: {
            type: "string",
            description: "Filter by absolute workspace path.",
          },
          filter: {
            type: "object",
            properties: {
              role: {
                type: "string",
                description: "Filter by subagent role (e.g. 'research', 'reviewer').",
              },
              hasErrors: {
                type: "boolean",
                description: "Filter turns containing errors.",
              },
              onlySubagents: {
                type: "boolean",
                description: "Filter to subagent sessions only.",
              },
              onlyUserPrompts: {
                type: "boolean",
                description: "Restricts keyword search match strictly to user_prompt column.",
              },
              timeRange: {
                type: "string",
                description: "Search within a time range ('start:end').",
              },
            },
            description: "Database-level filter predicates.",
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

async function handleListSessions(args: any): Promise<any> {
  const adapter = args?.adapter as string | undefined;
  const parentId = args?.parentId as string | undefined;
  const limit = (args?.limit as number) || 10;
  const projectPath = args?.projectPath as string | undefined;
  const scope = args?.scope as ScopeType | undefined;
  const timeRange = args?.timeRange as string | undefined;
  const sortBy = args?.sortBy as "created" | "active" | undefined;

  const store = getStore();
  const result = store.query({
    adapter,
    parentId,
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
    first_prompt: s.firstPrompt,
    parent_id: s.parentId || null,
    child_session_ids: s.childSessionIds || []
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

async function handleGetSessionRelationship(args: any): Promise<any> {
  const sessionId = args?.sessionId as string | undefined;
  if (!sessionId) {
    return {
      content: [
        {
          type: "text",
          text: "Error: Missing required parameter 'sessionId'.",
        },
      ],
      isError: true,
    };
  }

  const maxDepth = typeof args?.maxDepth === "number" ? args.maxDepth : 2;
  const includeAncestors = args?.includeAncestors !== false;

  const store = getStore();
  const rel = store.getSessionRelationship(sessionId, maxDepth, includeAncestors);

  if (!rel) {
    return {
      content: [
        {
          type: "text",
          text: `Session '${sessionId}' not found.`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(rel, null, 2),
      },
    ],
  };
}

function getStepTypeLabel(step: any, includeCallResults?: boolean): string {
  if (step.type === "USER_INPUT" || step.type === "PLANNER_RESPONSE") {
    return "";
  }
  if (includeCallResults || step.type === "MCP_TOOL" || step.type === "COMMAND") {
    return ` (${step.type})`;
  }
  return ` (\`${step.type}\`)`;
}

function formatStepToMarkdown(step: any, options?: { includeTimestamps?: boolean; includeCallResults?: boolean }): string {
  let md = "";
  const isUndone = Boolean(step.is_undone || step.isUndone);
  const undoneBadge = isUndone ? " **[UNDONE / REWOUND]**" : "";
  const timeStr = (options?.includeTimestamps && step.created_at) ? ` (${new Date(step.created_at).toLocaleString()})` : "";
  const convStepIdx = step.conversation_step_index ? ` (Conversation Step ${step.conversation_step_index})` : "";

  let body = "";
  if (step.type === "USER_INPUT") {
    body = `**User**: ${step.content || ""}\n\n`;
  } else if (step.type === "PLANNER_RESPONSE") {
    if (step.thinking) {
      body += `**Thinking**:\n\`\`\`\n${step.thinking}\n\`\`\`\n\n`;
    }
    if (step.content) {
      body += `**Assistant**: ${step.content}\n\n`;
    }
    if (step.tool_calls) {
      try {
        body += `**Tool Calls**:\n\`\`\`json\n${JSON.stringify(JSON.parse(step.tool_calls), null, 2)}\n\`\`\`\n\n`;
      } catch {
        body += `**Tool Calls**: ${step.tool_calls}\n\n`;
      }
    }
    if (step.tool_result) {
      body += `**Tool Result** (\`${step.tool_result.type}\`):\n\`\`\`\n${step.tool_result.content || ""}\n\`\`\`\n\n`;
    }
  } else if (options?.includeCallResults || step.type === "MCP_TOOL" || step.type === "COMMAND") {
    if (step.source && step.status) {
      body += `* **Source**: \`${step.source}\` | **Status**: \`${step.status}\`\n\n`;
    }
    if (step.content) {
      body += `**Result**:\n\`\`\`\n${step.content}\n\`\`\`\n\n`;
    }
  } else if (step.content) {
    body += `${step.content}\n\n`;
  }

  const typeLabel = getStepTypeLabel(step, options?.includeCallResults);
  if (isUndone) {
    md += `### Step ${step.step_index}${convStepIdx}${undoneBadge}${timeStr}${typeLabel}\n`;
    md += `> [!NOTE]\n> **[UNDONE / REWOUND STEP]** *(This step was superseded by a later turn rollback)*\n>\n`;
    const quotedBody = body.trim().split("\n").map(line => `> ${line}`).join("\n");
    md += `${quotedBody}\n\n`;
  } else {
    md += `### Step ${step.step_index}${convStepIdx}${timeStr}${typeLabel}\n${body}`;
  }

  return md;
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
  const includeUndone = args?.includeUndone as boolean | undefined;

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
    includeUndone,
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
      md += formatStepToMarkdown(step, { includeTimestamps, includeCallResults });
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
  const result = await queryTranscript({
    sessionId: args?.sessionId,
    turnIndex: args?.turnIndex,
    startTurn: args?.startTurn ?? args?.startConversationStep,
    endTurn: args?.endTurn ?? args?.endConversationStep,
    lastTurns: args?.lastTurns,
    detailLevel: args?.detailLevel,
    include: args?.include,
    filePath: args?.filePath,
    toolFilter:
      args?.toolFilter ??
      (args?.toolName || args?.serverName || args?.status || args?.type
        ? {
            name: args?.toolName,
            server: args?.serverName,
            status: args?.status,
            kind: args?.type,
          }
        : undefined),
    includeSubtree: args?.includeSubtree,
    includeUndone: args?.includeUndone,
    maxResultChars: args?.maxResultChars,
    output: args?.output,
  });

  return {
    content: [
      {
        type: "text",
        text: result.text,
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
  const mode = args?.mode as "hybrid" | "semantic" | "keyword" | undefined;
  const limit = (args?.limit as number) || 5;
  const projectPath = args?.projectPath as string | undefined;
  const scope = args?.scope as ScopeType | undefined;
  const filter = args?.filter;

  const hits = await searchHistory({
    query,
    mode,
    limit,
    projectPath,
    scope,
    filter,
  });

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
  const progressToken = (request.params as any)?._meta?.progressToken;

  let progressNotify: ProgressNotify | null = null;
  if (progressToken) {
    progressNotify = (progress, total, message) => {
      return server.notification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          total: total ?? 1.0,
          message,
        },
      });
    };
  }

  const reporter = new ProgressReporter(progressNotify, { label: "Syncing" });

  try {
    if (isAutoSyncEnabled() && name !== "sync_history") {
      await syncHistory(false, reporter);
    }

    switch (name) {
      case "chronicle_guide":
        return handleChronicleGuide();
      case "list_sessions":
        return await handleListSessions(args);
      case "get_session_relationship":
        return await handleGetSessionRelationship(args);
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
        await syncHistory(true, reporter);
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
