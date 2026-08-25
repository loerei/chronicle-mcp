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
import { getStore, getDb, type StepCategory } from "./db.js";
import { ADAPTERS } from "./adapters/index.js";
import type { TurnData } from "./adapters/types.js";
import { getEmbeddingClient } from "./embeddings.js";
import {
  searchHistory,
  queryTranscript,
  getSessionDetailsFromDb,
  computeSessionBenchmarks,
  getToolUsageStats,
  generateInteractiveContextChartHtml,
} from "./search.js";
import {
  formatListSessionsMarkdown,
  formatToolUsageStatsMarkdown,
  projectFields,
} from "./presentation.js";
import { ProgressReporter, ProgressNotify } from "./progress.js";
import { handleChronicleGuide } from "./guide.js";

export { handleChronicleGuide } from "./guide.js";

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

let hasLoggedKillswitchNotice = false;

export function resetKillswitchState(): void {
  hasLoggedKillswitchNotice = false;
}

export function isProgressiveDisclosureEnabled(): boolean {
  const envVal = process.env.CHRONICLE_PROGRESSIVE_DISCLOSURE_ENABLED;
  if (envVal !== undefined) {
    const clean = envVal.trim().toLowerCase();
    if (["false", "0", "off", "no"].includes(clean)) {
      if (!hasLoggedKillswitchNotice) {
        process.stderr.write(
          `[Chronicle MCP] Operational kill-switch active: Progressive disclosure defaults disabled. Reverting to legacy JSON output.\n`
        );
        hasLoggedKillswitchNotice = true;
      }
      return false;
    }
  }
  return true;
}

export async function syncSingleSession(s: any, store: any): Promise<boolean> {
  const turns = s.turns || [];
  const steps = s.steps || [];

  async function ensureVectorized(turnList: TurnData[]): Promise<void> {
    const unvectorized = turnList.filter((t) => !t.turnVector || t.turnVector.length === 0);
    if (unvectorized.length > 0) {
      const turnTexts = unvectorized.map((t) => t.turnText || t.userPrompt || "");
      try {
        const vectors = await getEmbeddingClient().embed(turnTexts);
        unvectorized.forEach((t, idx) => {
          t.turnVector = Float32Array.from(vectors[idx]);
        });
      } catch (e: any) {
        console.error(`[Chronicle MCP] Embedding error for session ${s.id}:`, e?.message || e);
      }
    }
  }

  // 1. Top-Level Stat Fast-Path
  if (s.logMtime !== undefined) {
    await ensureVectorized(turns);
    try {
      store.saveSession(s, turns, steps);
      return true;
    } catch (e: any) {
      console.error(`[Chronicle MCP] Failed to persist session "${s.title}" (${s.id}) to store:`, e?.message || e);
      return false;
    }
  }

  // 2. Legacy / Non-Stat Fallback Path (e.g. CursorAdapter, synthetic test sessions)
  if (turns.length > 0) {
    const existingSession = store.getSession(s.id);
    if (existingSession) {
      const existingTurns = store.getTurns(s.id, { includeUndone: true });
      const existingSteps = store.getSteps(s.id, { includeUndone: true });

      const turnsCountChanged = turns.length !== existingTurns.length;
      const stepsCountChanged = steps.length !== existingSteps.length;
      const promptChanged = existingSession.firstPrompt !== s.firstPrompt;
      const titleChanged = existingSession.title !== s.title;

      if (!turnsCountChanged && !stepsCountChanged && !promptChanged && !titleChanged) {
        return false;
      }
    }

    await ensureVectorized(turns);
    try {
      store.saveSession(s, turns, steps);
      return true;
    } catch (e: any) {
      console.error(`[Chronicle MCP] Failed to persist legacy session "${s.title}" (${s.id}) to store:`, e?.message || e);
      return false;
    }
  }

  // Fallback to legacy chunk-based session save
  const checkResult = store.query({ sessionId: s.id });
  if (checkResult.sessions.length > 0) {
    const existingSession = checkResult.sessions[0];
    const existingChunkIndices = new Set((existingSession.chunks || []).map((c: any) => c.stepIndex));

    const stepsResult = store.query({ sessionId: s.id, includeSteps: true, includeUndone: true });
    const existingStepIndices = new Set(stepsResult.steps.map((step: any) => step.stepIndex));

    const newChunks = (s.chunks || []).filter((c: any) => !existingChunkIndices.has(c.stepIndex));
    const newSteps = (s.steps || []).filter((step: any) => !existingStepIndices.has(step.stepIndex));

    const stepsCountChanged = (s.steps || []).length !== stepsResult.steps.length;
    const promptChanged = existingSession.firstPrompt !== s.firstPrompt;
    const titleChanged = existingSession.title !== s.title;

    if (newChunks.length === 0 && newSteps.length === 0 && !titleChanged && !stepsCountChanged && !promptChanged) {
      return false;
    }

    try {
      store.save(s);
      return true;
    } catch (e: any) {
      console.error(`[Chronicle MCP] Failed to persist legacy chunk session "${s.title}" (${s.id}) to store:`, e?.message || e);
      return false;
    }
  }

  try {
    store.save(s);
    return true;
  } catch (e: any) {
    console.error(`[Chronicle MCP] Failed to persist session "${s.title}" (${s.id}) to store:`, e?.message || e);
    return false;
  }
}

// Incremental Indexing function
export async function syncHistory(force: boolean = false, reporter?: ProgressReporter): Promise<void> {
  if (activeSync) {
    return activeSync;
  }

  activeSync = (async () => {
    const startTime = Date.now();
    const store = getStore();
    const isForceFull = force || process.env.CHRONICLE_FORCE_FULL_SYNC === "true" || process.env.CHRONICLE_DISABLE_STAT_CACHE === "true";
    console.error(`[Chronicle MCP] Syncing history from registered adapters...${isForceFull ? " (force full sync)" : ""}`);

    let cachedStats: Map<string, { logMtime: number; logSize: number }> | undefined;
    if (!isForceFull) {
      try {
        cachedStats = store.getSessionLogStats();
      } catch (e: any) {
        console.error("[Chronicle MCP] Failed to retrieve cached session log stats:", e?.message || e);
      }
    }

    let scannedCount = 0;
    let indexedCount = 0;

    for (const adapter of ADAPTERS) {
      try {
        const sessions = await adapter.discoverSessions({ reporter, cachedStats, force: isForceFull });
        scannedCount += sessions.length;
        let newCount = 0;

        for (const s of sessions) {
          const didSync = await syncSingleSession(s, store);
          if (didSync) {
            newCount++;
            indexedCount++;
          }
        }

        if (newCount > 0) {
          console.error(`[Chronicle MCP] Indexed ${newCount} new/updated sessions from adapter "${adapter.name}".`);
        }
      } catch (e: any) {
        console.error(`[Chronicle MCP] Adapter "${adapter.name}" failed:`, e?.message || e);
      }
    }
    reporter?.finish("Sync completed!");
    const durationMs = Date.now() - startTime;
    console.error(`[Chronicle MCP] Sync completed in ${durationMs}ms (scanned: ${scannedCount}, indexed: ${indexedCount})`);
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
export function getMcpToolDefinitions(): any[] {
  const tools: any[] = [
    {
      name: "chronicle_guide",
      description:
        "Self-guide tool providing usage patterns, tool selection matrix, and token-saving rules for chronicle-mcp.",
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
            description:
              "Filter sessions by parent session ID. Use 'root' or 'null' to filter top-level root sessions only.",
          },
          role: {
            type: "string",
            description: "Filter sessions by subagent role.",
          },
          hasErrors: {
            type: "boolean",
            description:
              "Filter sessions containing errors (true) or clean error-free sessions (false).",
          },
          limit: {
            type: "number",
            description: "Max number of sessions to return (default: 10).",
            default: 10,
          },
          offset: {
            type: "number",
            description: "Pagination offset index.",
          },
          projectPath: {
            type: "string",
            description: "Filter sessions by absolute workspace path.",
          },
          scope: {
            type: "string",
            enum: ["workspace", "all"],
            description:
              "Search scope: 'workspace' limits results to the active project; 'all' searches globally.",
            default: "all",
          },
          timeRange: {
            type: "string",
            description:
              "Search sessions within a time range, formatted as 'start:end' (e.g. '2026-06-20:2026-06-22' or '1781298371:1781308371').",
          },
          sortBy: {
            type: "string",
            enum: ["created", "active"],
            description:
              "Sort sessions by: 'created' for creation time; 'active' for latest activity time.",
            default: "active",
          },
          format: {
            type: "string",
            enum: ["markdown", "json"],
            description:
              "Output format: 'markdown' (default compact 1-line numbered list) or 'json' (structured JSON).",
            default: "markdown",
          },
          detailLevel: {
            type: "string",
            enum: ["compact", "full"],
            description:
              "Level of detail for JSON output: 'compact' (default essential fields) or 'full'.",
            default: "compact",
          },
          fields: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Optional array or comma-separated list of field names to project in JSON output mode.",
          },
          maxSnippetChars: {
            type: "number",
            description:
              "Maximum character length for session titles in markdown mode (clamped between 20 and 500).",
            default: 120,
          },
          output: {
            type: "string",
            description:
              "Path to write output file directly (.md or .json). If a directory is specified, a default timestamped filename will be generated.",
          },
        },
      },
    },
    {
      name: "get_session_relationship",
      description:
        "Expose parent session, child subagent sessions, siblings, and ancestry hierarchy for a given session ID.",
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
            description:
              "Maximum depth for recursive child subagent tree graph (1-10, default: 3).",
            default: 3,
            minimum: 1,
            maximum: 10,
          },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "query_transcript",
      description:
        "Read, query, slice, and progressively disclose conversation transcripts with token-saving detailLevel ('compact', 'full', 'summary'), turn slicing, subagent subtree resolution, and execution filters.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description:
              "Session ID to inspect. If omitted, defaults to the most recent workspace session.",
          },
          turnIndex: {
            type: "integer",
            description:
              "Specific 1-based turn index to retrieve, or negative index (e.g. -1 for latest turn).",
          },
          startTurn: {
            type: "integer",
            description:
              "Start turn index (inclusive), supports negative indexing (e.g. -3 for last 3 turns).",
          },
          endTurn: {
            type: "integer",
            description:
              "End turn index (inclusive), supports negative indexing (e.g. -1 for latest turn).",
          },
          lastTurns: {
            type: "integer",
            description: "Retrieve the last N turns.",
          },
          detailLevel: {
            type: "string",
            enum: ["compact", "full", "summary"],
            description:
              "Detail level: 'compact' (dialogue + execution summary, saving ~80% tokens), 'full' (complete dialogue, thinking, tool args & results), 'summary' (conversational dialogue only).",
            default: "compact",
          },
          include: {
            type: "array",
            items: {
              type: "string",
              enum: ["dialogue", "thinking", "executions", "system_events"],
            },
            description:
              "Array masks to conditionally include dialogue, thinking, executions, or system_events.",
          },
          filePath: {
            type: "string",
            description:
              "Filter execution steps touching a specific file path or basename.",
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
            description:
              "Filter execution steps by tool name, server, status, or kind.",
          },
          includeSubtree: {
            type: "boolean",
            description:
              "Recursively resolve and aggregate turns across all descendant subagents in chronological order.",
            default: false,
          },
          includeUndone: {
            type: "boolean",
            description: "Include undone / rewound steps from superseded branches.",
            default: false,
          },
          maxResultChars: {
            type: "integer",
            description:
              "Safety truncation limit for individual execution payloads. Default: 2500.",
            default: 2500,
          },
          output: {
            type: "string",
            description:
              "Path to write output file directly (.md or .json). If a directory is specified, a default timestamped filename will be generated.",
          },
        },
      },
    },
    {
      name: "get_session_artifacts",
      description:
        "Retrieve markdown artifacts (walkthrough.md, implementation_plan.md, task.md) for a session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "Unique session ID.",
          },
          artifactName: {
            type: "string",
            description: "Optional artifact filename or substring filter.",
          },
          includeSubtree: {
            type: "boolean",
            description: "Include artifacts from descendant subagent sessions.",
            default: false,
          },
          output: {
            type: "string",
            description:
              "Absolute path to the output file or directory. If a directory is specified, a default filename will be generated.",
          },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "search_history",
      description:
        "Perform zero-copy turn-level hybrid (FTS5 + Vector BLOB RRF), semantic, or keyword search across development sessions.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query text, symbol, error code, or natural language question.",
          },
          mode: {
            type: "string",
            enum: ["hybrid", "semantic", "keyword"],
            description:
              "Search mode: 'hybrid' (combines FTS5 BM25 + Vector cosine similarity via RRF k=60), 'semantic' (dense vector cosine similarity), 'keyword' (exact FTS5 symbol matching).",
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
            description:
              "Search scope: 'workspace' limits to active project; 'all' searches globally.",
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
                description: "Filter turns containing errors (true) or clean error-free turns (false).",
              },
              onlySubagents: {
                type: "boolean",
                description: "Filter to subagent sessions only.",
              },
              onlyUserPrompts: {
                type: "boolean",
                description:
                  "Restricts keyword search match strictly to user_prompt column.",
              },
              timeRange: {
                type: "string",
                description: "Search within a time range ('start:end').",
              },
            },
            description: "Database-level filter predicates.",
          },
          format: {
            type: "string",
            enum: ["markdown", "json"],
            description:
              "Output format: 'markdown' (default compact 1-line numbered list) or 'json' (structured JSON).",
            default: "markdown",
          },
          detailLevel: {
            type: "string",
            enum: ["compact", "full"],
            description:
              "Level of detail for JSON output: 'compact' (default essential fields) or 'full'.",
            default: "compact",
          },
          fields: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Optional array or comma-separated list of field names to project in JSON output mode.",
          },
          maxSnippetChars: {
            type: "number",
            description:
              "Maximum character length for snippets in markdown mode (clamped between 20 and 500).",
            default: 120,
          },
          output: {
            type: "string",
            description:
              "Path to write output file directly (.md or .json). If a directory is specified, a default timestamped filename will be generated.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_tool_usage_stats",
      description:
        "Retrieve comprehensive tool execution analytics (per-tool call counts, failure rates, avg duration) and thrash loop detection across sessions.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of recent sessions to analyze (default: 30).",
            default: 30,
          },
          projectPath: {
            type: "string",
            description: "Filter by absolute workspace path.",
          },
          scope: {
            type: "string",
            enum: ["workspace", "all"],
            description:
              "Search scope: 'workspace' limits results to the active project; 'all' searches globally.",
            default: "all",
          },
          timeRange: {
            type: "string",
            description: "Analyze sessions within a time range ('start:end').",
          },
          format: {
            type: "string",
            enum: ["markdown", "json"],
            description:
              "Output format: 'markdown' (standardized markdown summary table) or 'json' (structured report).",
            default: "json",
          },
          output: {
            type: "string",
            description:
              "Path to write output file directly (.md or .json). If a directory is specified, a default timestamped filename will be generated.",
          },
        },
      },
    },
    {
      name: "get_session_benchmarks",
      description:
        "Compare duration, tool calls, token usage, and errors across sessions.",
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
            description:
              "Absolute path to the output file or directory. If a directory is specified, a default filename will be generated.",
          },
          linechart_output: {
            type: "string",
            description:
              "Optional absolute path to export an interactive HTML line chart visualizing context window size over steps with Checkpoints and conversational steps highlighted.",
          },
        },
        required: ["sessionIds"],
      },
    },
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
        description:
          "[Legacy Wrapper] Retrieve conversational history and steps of a specific session.",
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
        description:
          "[Legacy Wrapper] Retrieve content, thinking, and tool execution details for specific step indexes in a session.",
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
        description:
          "[Legacy Wrapper] Search across indexed steps by text query, step type, status, or tool name.",
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

  return tools;
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: getMcpToolDefinitions() };
});

export function handleOutputWrite(
  content: string | object,
  outputPath?: string,
  defaultFilename?: string
): any {
  if (!outputPath) {
    const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
    return {
      content: [
        {
          type: "text",
          text,
        },
      ],
    };
  }

  if (typeof outputPath !== "string" || !outputPath.trim() || outputPath.includes("\0")) {
    process.stderr.write(
      `[Chronicle MCP] [Security] Blocked path traversal attempt in output parameter: "${outputPath}" outside authorized roots.\n`
    );
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: Invalid or dangerous output path provided: "${outputPath}"`,
        },
      ],
    };
  }

  try {
    const resolvedPath = path.resolve(outputPath);
    const normalizedTargetPath = resolvedPath.replaceAll("\\", "/").toLowerCase();

    const authorizedRoots = [
      process.cwd(),
      os.tmpdir(),
      process.env.APPDATA || "",
      process.env.HOME || process.env.USERPROFILE || "",
    ]
      .filter(Boolean)
      .map((r) => path.resolve(r).replaceAll("\\", "/").toLowerCase());

    const isAuthorized = authorizedRoots.some(
      (root) =>
        normalizedTargetPath === root ||
        normalizedTargetPath.startsWith(root.endsWith("/") ? root : `${root}/`)
    );

    if (!isAuthorized) {
      process.stderr.write(
        `[Chronicle MCP] [Security] Blocked path traversal attempt in output parameter: "${resolvedPath}" outside authorized roots.\n`
      );
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error: Access denied. Output path "${outputPath}" is outside authorized workspace and temporary directories.`,
          },
        ],
      };
    }

    let targetPath = resolvedPath;
    let isDir = false;
    try {
      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
        isDir = true;
      }
    } catch {
      const ext = path.extname(resolvedPath).toLowerCase();
      if (![".md", ".json", ".txt", ".html"].includes(ext)) {
        isDir = true;
      }
    }

    if (isDir) {
      fs.mkdirSync(resolvedPath, { recursive: true });
      const filename = defaultFilename || `output_${Date.now()}.md`;
      targetPath = path.join(resolvedPath, filename);
    } else {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    }

    const payload = typeof content === "string" ? content : JSON.stringify(content, null, 2);
    fs.writeFileSync(targetPath, payload, "utf-8");
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

export async function handleListSessions(args: any): Promise<any> {
  try {
    const progressiveEnabled = isProgressiveDisclosureEnabled();
    const adapter = args?.adapter as string | undefined;
    const parentId = args?.parentId as string | undefined;
    const role = args?.role as string | undefined;
    const hasErrors = typeof args?.hasErrors === "boolean" ? args.hasErrors : undefined;
    const rawLimit = args?.limit;
    const limit =
      typeof rawLimit === "number" && !Number.isNaN(rawLimit)
        ? Math.max(1, Math.min(Math.floor(rawLimit), 100))
        : 10;
    const offset =
      typeof args?.offset === "number" && !Number.isNaN(args.offset)
        ? Math.max(0, Math.floor(args.offset))
        : undefined;
    const projectPath = args?.projectPath as string | undefined;
    const scope = args?.scope as ScopeType | undefined;
    const timeRange = args?.timeRange as string | undefined;
    const sortBy = args?.sortBy as "created" | "active" | undefined;
    const format = args?.format ?? (progressiveEnabled ? "markdown" : "json");
    const detailLevel = args?.detailLevel ?? (progressiveEnabled ? "compact" : "full");
    const fields = (args?.fields ?? args?.order) as string[] | string | undefined;
    const rawMaxSnippetChars = args?.maxSnippetChars;
    const maxSnippetChars =
      typeof rawMaxSnippetChars === "number" && !Number.isNaN(rawMaxSnippetChars)
        ? Math.max(20, Math.min(Math.floor(rawMaxSnippetChars), 500))
        : 120;
    const outputPath = args?.output as string | undefined;

    const store = getStore();
    const sessions = store.listSessions({
      adapter,
      parentId,
      role,
      hasErrors,
      projectPath,
      scope,
      limit,
      offset,
      timeRange,
      sortBy,
    });

    if (format === "json") {
      let result: any[];
      if (sessions.length === 0) {
        result = [];
      } else if (fields) {
        result = projectFields(sessions, fields, "session");
      } else if (detailLevel === "compact") {
        result = projectFields(sessions, undefined, "session");
      } else {
        // full
        result = sessions.map((s) => ({
          id: s.id,
          adapter: s.adapter,
          title: s.title,
          role: s.role,
          project_path: s.projectPath,
          created_at: s.createdAt,
          last_active_at: s.lastActiveAt,
          parent_id: s.parentId || null,
          root_id: s.rootId || null,
          depth: s.depth ?? 0,
          total_turns: s.totalTurns ?? 0,
          total_steps: s.totalSteps ?? 0,
          artifacts: s.artifacts || [],
          files_touched: s.filesTouched || [],
          first_prompt: s.firstPrompt,
        }));
      }

      const jsonText = JSON.stringify(result, null, 2);
      if (outputPath) {
        return handleOutputWrite(jsonText, outputPath, `sessions_${Date.now()}.json`);
      }
      return {
        content: [
          {
            type: "text",
            text: jsonText,
          },
        ],
      };
    }

    // format === "markdown"
    const md = formatListSessionsMarkdown(sessions, scope || "all", maxSnippetChars);
    if (outputPath) {
      return handleOutputWrite(md, outputPath, `sessions_${Date.now()}.md`);
    }
    return {
      content: [
        {
          type: "text",
          text: md,
        },
      ],
    };
  } catch (e: any) {
    process.stderr.write(`[Chronicle MCP] Tool "list_sessions" failed: ${e.message}\n${e.stack}\n`);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${e.message}`,
        },
      ],
    };
  }
}

export async function handleGetSessionRelationship(args: any): Promise<any> {
  try {
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

    const maxDepth = typeof args?.maxDepth === "number" ? args.maxDepth : 3;
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
  } catch (e: any) {
    process.stderr.write(`[Chronicle MCP] Tool "get_session_relationship" failed: ${e.message}\n${e.stack}\n`);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${e.message}`,
        },
      ],
    };
  }
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

export async function handleGetSessionArtifacts(
  args: any,
  brainBaseDir?: string
): Promise<any> {
  try {
    const sessionId = args?.sessionId as string;
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

    const includeSubtree = args?.includeSubtree === true;
    const artifactNameFilter = args?.artifactName as string | undefined;
    const homedir = os.homedir();
    const brainDir =
      brainBaseDir || path.join(homedir, ".gemini", "antigravity", "brain");

    const store = getStore();
    const descriptors = store.getArtifactDescriptors(
      sessionId,
      includeSubtree,
      artifactNameFilter
    );

    // Fallback: If DB had no descriptors for current session, inspect disk
    if (descriptors.length === 0) {
      const sessionDir = path.join(brainDir, sessionId);
      if (fs.existsSync(sessionDir)) {
        try {
          const diskFiles = fs
            .readdirSync(sessionDir)
            .filter((f) => f.endsWith(".md"));
          for (const df of diskFiles) {
            if (
              !artifactNameFilter ||
              df.toLowerCase().includes(artifactNameFilter.toLowerCase())
            ) {
              descriptors.push({ sessionId, filename: df });
            }
          }
        } catch {}
      }
    }

    if (descriptors.length === 0) {
      const subtreeSuffix = includeSubtree ? " (including subtree)" : "";
      const filterSuffix = artifactNameFilter ? ` matching "${artifactNameFilter}"` : "";
      return {
        content: [
          {
            type: "text",
            text: `No markdown artifacts found for session "${sessionId}"${subtreeSuffix}${filterSuffix}.`,
          },
        ],
      };
    }

    let md = `# Artifacts for Session: ${sessionId}\n\n`;
    const MAX_ARTIFACT_BYTES = 512 * 1024; // 512 KB

    for (const desc of descriptors) {
      const targetSessionDir = path.join(brainDir, desc.sessionId);
      const targetPath = path.resolve(targetSessionDir, desc.filename);

      // Sibling directory escape & containment check
      const rel = path.relative(targetSessionDir, targetPath);
      const isContained =
        !rel.startsWith("..") &&
        !path.isAbsolute(rel) &&
        targetPath.startsWith(targetSessionDir + path.sep);

      if (!isContained) {
        md += `## File: ${desc.filename} (Session: ${desc.sessionId})\n\n`;
        md += `> [!WARNING]\n> Path traversal blocked for artifact "${desc.filename}".\n\n---\n\n`;
        continue;
      }

      if (!fs.existsSync(targetPath)) {
        md += `## File: ${desc.filename} (Session: ${desc.sessionId})\n\n`;
        md += `> [!NOTE]\n> Artifact file not found on disk at \`${targetPath}\`.\n\n---\n\n`;
        continue;
      }

      try {
        const stats = fs.statSync(targetPath);
        if (!stats.isFile()) continue;

        let content = fs.readFileSync(targetPath, "utf-8");
        if (stats.size > MAX_ARTIFACT_BYTES) {
          content =
            content.slice(0, MAX_ARTIFACT_BYTES) +
            `\n\n... [Truncated: artifact exceeded ${MAX_ARTIFACT_BYTES / 1024} KB limit]`;
        }

        md += `## File: [${desc.filename}](file:///${targetPath.replaceAll("\\", "/")}) (Session: ${desc.sessionId})\n\n`;
        md += `${content}\n\n`;
        md += `--- \n\n`;
      } catch (e: any) {
        md += `## File: ${desc.filename} (Session: ${desc.sessionId})\n\n`;
        md += `> [!WARNING]\n> Error reading artifact: ${e?.message || String(e)}\n\n---\n\n`;
      }
    }

    const outputPath = args?.output as string | undefined;
    return handleOutputWrite(md, outputPath, `artifacts_${sessionId}.md`);
  } catch (e: any) {
    process.stderr.write(`[Chronicle MCP] Tool "get_session_artifacts" failed: ${e.message}\n${e.stack}\n`);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${e.message}`,
        },
      ],
    };
  }
}

export async function handleQueryTranscript(args: any): Promise<any> {
  try {
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
  } catch (e: any) {
    process.stderr.write(`[Chronicle MCP] Tool "query_transcript" failed: ${e.message}\n${e.stack}\n`);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${e.message}`,
        },
      ],
    };
  }
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

export async function handleSearchHistory(args: any): Promise<any> {
  try {
    const progressiveEnabled = isProgressiveDisclosureEnabled();
    const query = args?.query as string;
    const mode = args?.mode as "hybrid" | "semantic" | "keyword" | undefined;
    const rawLimit = args?.limit;
    const limit =
      typeof rawLimit === "number" && !Number.isNaN(rawLimit)
        ? Math.max(1, Math.min(Math.floor(rawLimit), 100))
        : 10;
    const projectPath = args?.projectPath as string | undefined;
    const scope = args?.scope as ScopeType | undefined;
    const filter = args?.filter;
    const format = args?.format ?? (progressiveEnabled ? "markdown" : "json");
    const detailLevel = args?.detailLevel ?? (progressiveEnabled ? "compact" : "full");
    const fields = (args?.fields ?? args?.order) as string[] | string | undefined;
    const rawMaxSnippetChars = args?.maxSnippetChars;
    const maxSnippetChars =
      typeof rawMaxSnippetChars === "number" && !Number.isNaN(rawMaxSnippetChars)
        ? Math.max(20, Math.min(Math.floor(rawMaxSnippetChars), 500))
        : 120;
    const outputPath = args?.output as string | undefined;

    const result = await searchHistory({
      query,
      mode,
      limit,
      projectPath,
      scope,
      filter,
      format,
      detailLevel,
      fields,
      maxSnippetChars,
    });

    if (format === "json") {
      const jsonText = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      if (outputPath) {
        return handleOutputWrite(jsonText, outputPath, `search_${Date.now()}.json`);
      }
      return {
        content: [
          {
            type: "text",
            text: jsonText,
          },
        ],
      };
    }

    // format === "markdown"
    const mdText = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    if (outputPath) {
      return handleOutputWrite(mdText, outputPath, `search_${Date.now()}.md`);
    }
    return {
      content: [
        {
          type: "text",
          text: mdText,
        },
      ],
    };
  } catch (e: any) {
    process.stderr.write(`[Chronicle MCP] Tool "search_history" failed: ${e.message}\n${e.stack}\n`);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${e.message}`,
        },
      ],
    };
  }
}

export async function handleGetToolUsageStats(args: any): Promise<any> {
  try {
    const rawLimit = args?.limit;
    const limit =
      typeof rawLimit === "number" && !Number.isNaN(rawLimit)
        ? Math.max(1, Math.min(Math.floor(rawLimit), 100))
        : 30;
    const projectPath = args?.projectPath as string | undefined;
    const scope = args?.scope as ScopeType | undefined;
    const timeRange = args?.timeRange as string | undefined;
    const format = args?.format as "markdown" | "json" | undefined;
    const outputPath = args?.output as string | undefined;

    const stats = await getToolUsageStats({ limit, projectPath, scope, timeRange });

    const normalizedStats = stats && stats.summary ? stats : {
      summary: { totalCalls: 0, totalErrors: 0, overallFailureRate: 0 },
      tools: [],
      thrashingTools: [],
    };

    if (format === "markdown") {
      const md = formatToolUsageStatsMarkdown(normalizedStats);
      if (outputPath) {
        return handleOutputWrite(md, outputPath, `tool_stats_${Date.now()}.md`);
      }
      return {
        content: [
          {
            type: "text",
            text: md,
          },
        ],
      };
    }

    // Default or format === "json"
    const jsonText = JSON.stringify(normalizedStats, null, 2);
    if (outputPath) {
      return handleOutputWrite(jsonText, outputPath, `tool_stats_${Date.now()}.json`);
    }
    return {
      content: [
        {
          type: "text",
          text: jsonText,
        },
      ],
    };
  } catch (e: any) {
    process.stderr.write(`[Chronicle MCP] Tool "get_tool_usage_stats" failed: ${e.message}\n${e.stack}\n`);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${e.message}`,
        },
      ],
    };
  }
}

export async function handleGetSessionBenchmarks(args: any): Promise<any> {
  try {
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
  } catch (e: any) {
    process.stderr.write(`[Chronicle MCP] Tool "get_session_benchmarks" failed: ${e.message}\n${e.stack}\n`);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${e.message}`,
        },
      ],
    };
  }
}

export async function handleCallToolRequest(
  name: string,
  args: any,
  reporter?: ProgressReporter
): Promise<any> {
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
    return await handleCallToolRequest(name, args, reporter);
  } catch (e: any) {
    process.stderr.write(`[Chronicle MCP] Tool "${name}" failed: ${e.message}\n${e.stack}\n`);
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
