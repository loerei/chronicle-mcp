import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { getStore, getDb } from "./db.js";
import { ADAPTERS } from "./adapters/index.js";
import { getEmbeddingClient } from "./embeddings.js";
import { searchHistory, getSessionDetailsFromDb, computeSessionBenchmarks } from "./search.js";

let activeSync: Promise<void> | null = null;
let lastSyncTime = 0;
const SYNC_COOLDOWN_MS = 5000;

export function isAutoSyncEnabled(): boolean {
  return (
    process.env.CHRONICLE_AUTO_SYNC === "true" ||
    process.argv.includes("--auto-sync")
  );
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
          // Check if session already indexed
          const checkResult = store.query({ sessionId: s.id });
          if (checkResult.sessions.length > 0) {
            const existingSession = checkResult.sessions[0];
            const existingChunkIndices = new Set(existingSession.chunks.map(c => c.stepIndex));

            const stepsResult = store.query({ sessionId: s.id, includeSteps: true });
            const existingStepIndices = new Set(stepsResult.steps.map(step => step.stepIndex));

            const newChunks = s.chunks.filter(c => !existingChunkIndices.has(c.stepIndex));
            const newSteps = (s.steps || []).filter(step => !existingStepIndices.has(step.stepIndex));

            if (newChunks.length === 0 && newSteps.length === 0 && existingSession.title === s.title) {
              continue;
            }

            newCount++;
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
              const chunkTexts = newChunks.map(chunk => chunk.text);
              const vectors = await getEmbeddingClient().embed(chunkTexts);
              newChunks.forEach((chunk, index) => {
                chunkVectors.set(chunk.stepIndex, vectors[index]);
              });
            }

            store.save(s, {
              summary: summaryVector,
              chunks: chunkVectors
            });
            continue;
          }

          newCount++;
          console.error(`[Chronicle MCP] Indexing new session: "${s.title}" (${s.id})`);

          // Compute Level 1 vector (Session identity)
          const summaryText = `Title: ${s.title} | Context: ${s.projectPath || "unknown"} | Start: ${s.firstPrompt} ${s.secondPrompt}`;
          const [summaryVector] = await getEmbeddingClient().embed([summaryText]);

          // Compute Level 2 vectors (Granular turns)
          const chunkVectors = new Map<number, number[]>();
          if (s.chunks.length > 0) {
            const chunkTexts = s.chunks.map(chunk => chunk.text);
            const vectors = await getEmbeddingClient().embed(chunkTexts);
            s.chunks.forEach((chunk, index) => {
              chunkVectors.set(chunk.stepIndex, vectors[index]);
            });
          }

          store.save(s, {
            summary: summaryVector,
            chunks: chunkVectors
          });
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
const server = new Server(
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

// Register Tool Definitions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: any[] = [
    {
      name: "list_sessions",
      description: "List all indexed conversations and development sessions across adapters.",
      inputSchema: {
        type: "object",
        properties: {
          adapter: {
            type: "string",
            description: "Filter by adapter type: 'antigravity' or 'cursor'",
          },
          limit: {
            type: "number",
            description: "Max number of sessions to return",
            default: 10,
          },
          projectPath: {
            type: "string",
            description: "Filter sessions by project workspace directory path",
          },
        },
      },
    },
    {
      name: "get_session_details",
      description: "Retrieve details and conversational history/turns of a specific session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "UUID or unique ID of the session",
          },
          includeToolCalls: {
            type: "boolean",
            description: "Whether to include tool calls in the conversational history",
            default: false,
          },
          includeCallResults: {
            type: "boolean",
            description: "Whether to include tool calls AND their execution results in the history",
            default: false,
          },
          startStep: {
            type: "number",
            description: "Start step index (inclusive) for slicing the history",
          },
          endStep: {
            type: "number",
            description: "End step index (inclusive) for slicing the history",
          },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "get_step_details",
      description: "Retrieve detailed execution information for specific steps (e.g., tool calls, tool results/contents, thinking) in a session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "UUID or unique ID of the session",
          },
          stepIndex: {
            type: "number",
            description: "Index of a single step to retrieve",
          },
          startStep: {
            type: "number",
            description: "Start step index (inclusive) for range retrieval",
          },
          endStep: {
            type: "number",
            description: "End step index (inclusive) for range retrieval",
          },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "get_session_artifacts",
      description: "Retrieve local markdown artifacts (walkthrough.md, implementation_plan.md, task.md) for a completed session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "UUID or unique ID of the session",
          },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "search_steps",
      description: "Search for specific terms, tool calls, or errors across all indexed steps.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text keyword to look for in content, thinking, or tool calls",
          },
          sessionId: {
            type: "string",
            description: "Restrict search to this specific session ID",
          },
          type: {
            type: "string",
            description: "Filter by step type (e.g. PLANNER_RESPONSE, MCP_TOOL, COMMAND)",
          },
          status: {
            type: "string",
            description: "Filter by step execution status (e.g. DONE, ERROR)",
          },
          limit: {
            type: "number",
            description: "Max number of steps to return",
            default: 10,
          },
        },
      },
    },
    {
      name: "search_history",
      description: "Perform local semantic vector search across past sessions and individual turns.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search text or topic (e.g. 'snapping threshold')",
          },
          limit: {
            type: "number",
            description: "Max number of matching chunks to return",
            default: 5,
          },
          projectPath: {
            type: "string",
            description: "Filter matches by project workspace directory path",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_session_benchmarks",
      description: "Calculate and compare execution metrics (duration, tool calls, and standard token counts) across one or more sessions.",
      inputSchema: {
        type: "object",
        properties: {
          sessionIds: {
            type: "array",
            items: {
              type: "string",
            },
            description: "List of session IDs to benchmark.",
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
                  description: "List of session IDs in this group.",
                },
              },
              required: ["name", "sessionIds"],
            },
            description: "Optional grouping of sessions to compare aggregated averages.",
          },
        },
        required: ["sessionIds"],
      },
    }
  ];

  if (!isAutoSyncEnabled()) {
    tools.push({
      name: "sync_history",
      description: "Scan local filesystem for new session logs and index them incrementally.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    });
  }

  return { tools };
});

// Handle Tool Calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (isAutoSyncEnabled() && name !== "sync_history") {
      await syncHistory();
    }
    if (name === "list_sessions") {
      const adapter = args?.adapter as string | undefined;
      const limit = (args?.limit as number) || 10;
      const projectPath = args?.projectPath as string | undefined;

      const store = getStore();
      const result = store.query({
        adapter,
        projectPath,
        limit
      });

      const sortedSessions = [...result.sessions].sort((a, b) => b.createdAt - a.createdAt);
      const rows = sortedSessions.map(s => ({
        id: s.id,
        adapter: s.adapter,
        title: s.title,
        project_path: s.projectPath,
        created_at: s.createdAt,
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

        if (name === "get_session_details") {
      const sessionId = args?.sessionId as string;
      const includeToolCalls = args?.includeToolCalls as boolean | undefined;
      const includeCallResults = args?.includeCallResults as boolean | undefined;
      const startStep = args?.startStep as number | undefined;
      const endStep = args?.endStep as number | undefined;

      const details = await getSessionDetailsFromDb(sessionId, {
        includeToolCalls,
        includeCallResults,
        startStep,
        endStep,
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

      const needSteps = includeToolCalls || includeCallResults;

      if (needSteps) {
        for (const step of details.steps) {
          if (step.type === "USER_INPUT") {
            md += `### Step ${step.step_index}\n**User**: ${step.content || ""}\n\n`;
          } else if (step.type === "PLANNER_RESPONSE") {
            md += `### Step ${step.step_index}\n`;
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
          } else {
            if (includeCallResults) {
              md += `### Step ${step.step_index} (${step.type})\n`;
              md += `* **Source**: \`${step.source}\` | **Status**: \`${step.status}\`\n\n`;
              if (step.content) {
                md += `**Result**:\n\`\`\`\n${step.content}\n\`\`\`\n\n`;
              }
            }
          }
        }
      } else {
        for (const chunk of details.chunks) {
          // Format labels as bold and use double newlines to prevent markdown renderer from merging lines
          const formattedText = chunk.chunk_text
            .replace(/^User:/gm, "**User**:")
            .replace(/^Assistant:/gm, "**Assistant**:")
            .replace(/\n\*\*Assistant\*\*:/g, "\n\n**Assistant**:");
          md += `### Step ${chunk.step_index}\n${formattedText}\n\n`;
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

      return {
        content: [
          {
            type: "text",
            text: md,
          },
        ],
      };
    }

    if (name === "get_step_details") {
      const sessionId = args?.sessionId as string;
      const stepIndex = args?.stepIndex as number | undefined;
      const startStep = args?.startStep as number | undefined;
      const endStep = args?.endStep as number | undefined;

      const store = getStore();
      const sessionResult = store.query({ sessionId });
      if (sessionResult.sessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Session "${sessionId}" not found.`,
            },
          ],
          isError: true,
        };
      }

      const result = store.query({
        sessionId,
        includeSteps: true,
        startStep: stepIndex !== undefined ? stepIndex : startStep,
        endStep: stepIndex !== undefined ? stepIndex : endStep
      });

      const steps = result.steps.map(s => ({
        step_index: s.stepIndex,
        type: s.type,
        source: s.source,
        status: s.status,
        content: s.content ?? null,
        thinking: s.thinking ?? null,
        tool_calls: s.toolCalls ?? null,
        created_at: s.createdAt ?? null
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(steps, null, 2),
          },
        ],
      };
    }

    if (name === "get_session_artifacts") {
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

      return {
        content: [
          {
            type: "text",
            text: md,
          },
        ],
      };
    }

    if (name === "search_steps") {
      const queryText = args?.query as string;
      const sessionId = args?.sessionId as string | undefined;
      const type = args?.type as string | undefined;
      const status = args?.status as string | undefined;
      const limit = (args?.limit as number) || 10;

      const store = getStore();
      const result = store.query({
        sessionId,
        includeSteps: true,
        stepQuery: queryText,
        stepType: type,
        stepStatus: status
      });

      const stepsWithSessionId: any[] = [];
      for (const s of result.sessions) {
        if (s.steps) {
          for (const step of s.steps) {
            stepsWithSessionId.push({
              session_id: s.id,
              step_index: step.stepIndex,
              type: step.type,
              source: step.source,
              status: step.status,
              content: step.content ?? null,
              thinking: step.thinking ?? null,
              tool_calls: step.toolCalls ?? null,
              created_at: step.createdAt ?? null
            });
          }
        }
      }

      const sortedSteps = stepsWithSessionId.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
      const rows = sortedSteps.slice(0, limit);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(rows, null, 2),
          },
        ],
      };
    }

    if (name === "search_history") {
      const query = args?.query as string;
      const limit = (args?.limit as number) || 5;
      const projectPath = args?.projectPath as string | undefined;

      console.error(`[Chronicle MCP] Generating embedding for query: "${query}"`);
      const [queryVector] = await getEmbeddingClient().embed([query]);

      const hits = await searchHistory(queryVector, limit, { projectPath });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(hits, null, 2),
          },
        ],
      };
    }

    if (name === "get_session_benchmarks") {
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

        const durationText = m.durationMs !== null ? `${(m.durationMs / 1000).toFixed(1)}s` : "N/A";
        const titleText = m.title.length > 40 ? m.title.slice(0, 37) + "..." : m.title;
        const homedir = os.homedir();
        const sessionLink = `[${titleText}](file:///${homedir.replaceAll("\\", "/")}/.gemini/antigravity/brain/${m.sessionId})`;

        md += `| ${sessionLink}<br>\`${m.sessionId.slice(0, 8)}\` | ${groupName} | ${m.totalSteps} | ${m.toolCallsCount} | ${durationText} | ${m.cumulativeInputTokens.toLocaleString()} | ${m.cacheHitRate.toFixed(1)}% | ${m.estimatedCostSavings.toFixed(1)}% | ${m.peakContextSize.toLocaleString()} | ${m.estimatedOutputTokens.toLocaleString()} | ${m.errorStepsCount} |\n`;
      }
      md += `\n`;

      return {
        content: [
          {
            type: "text",
            text: md,
          },
        ],
      };
    }

    if (name === "sync_history") {
      await syncHistory(true);
      return {
        content: [
          {
            type: "text",
            text: "History synchronization completed successfully.",
          },
        ],
      };
    }

    throw new Error(`Tool "${name}" not found.`);
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

// Start Stdio Transport
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Chronicle MCP] Unified History Server running on stdio transport.");

  // Run initial sync on startup asynchronously to not block connection
  syncHistory().catch((e) => {
    console.error("[Chronicle MCP] Initial sync failed:", e.message);
  });
}

const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  fileURLToPath(import.meta.url).replace(/\.js$/, ".ts") === path.resolve(process.argv[1])
);

if (isMain) {
  run();
}
