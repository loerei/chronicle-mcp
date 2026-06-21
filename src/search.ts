import { getStore, SearchResult as DbSearchResult } from "./db.js";
import { SessionBenchmarkMetrics, StepData } from "./adapters/types.js";
import { getEncoding } from "js-tiktoken";

const encoder = getEncoding("cl100k_base");

export type SearchResult = DbSearchResult;

export function dotProduct(a: number[], b: number[]): number {
  let val = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    val += a[i] * b[i];
  }
  return val;
}

export async function searchHistory(
  queryVector: number[],
  limit = 5,
  options: { projectPath?: string; scope?: "workspace" | "all" } = {}
): Promise<SearchResult[]> {
  const store = getStore();
  return store.search(queryVector, limit, options);
}

export async function getSessionDetailsFromDb(
  sessionId: string,
  options: {
    includeToolCalls?: boolean;
    includeCallResults?: boolean;
    startStep?: number;
    endStep?: number;
    excludeContent?: boolean;
  } = {}
): Promise<any> {
  const store = getStore();
  const includeSteps = !!(options.includeToolCalls || options.includeCallResults);
  const result = store.query({
    sessionId,
    includeSteps,
    startStep: options.startStep,
    endStep: options.endStep,
    excludeContent: options.excludeContent
  });

  const session = result.sessions[0];
  if (!session) return null;

  const dbChunks = result.chunks.map(c => ({
    step_index: c.stepIndex,
    chunk_text: c.text
  }));

  const dbSteps = result.steps.map(s => ({
    step_index: s.stepIndex,
    type: s.type,
    source: s.source,
    status: s.status,
    content: s.content,
    thinking: s.thinking,
    tool_calls: s.toolCalls,
    created_at: s.createdAt
  }));

  return {
    id: session.id,
    adapter: session.adapter,
    title: session.title,
    project_path: session.projectPath,
    created_at: session.createdAt,
    first_prompt: session.firstPrompt,
    second_prompt: session.secondPrompt,
    parent_id: session.parentId || null,
    chunks: dbChunks,
    steps: dbSteps
  };
}

interface StepAnalysis {
  minCreatedAt: number;
  maxCreatedAt: number;
  errorStepsCount: number;
  toolCallsCount: number;
  stepTokens: number[];
}

function countToolCalls(toolCalls: string | undefined): number {
  if (!toolCalls) return 0;
  try {
    const parsed = JSON.parse(toolCalls);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function analyzeSteps(steps: StepData[]): StepAnalysis {
  let minCreatedAt = Infinity;
  let maxCreatedAt = -Infinity;
  let errorStepsCount = 0;
  let toolCallsCount = 0;
  const stepTokens: number[] = [];

  for (const step of steps) {
    if (step.createdAt !== undefined) {
      minCreatedAt = Math.min(minCreatedAt, step.createdAt);
      maxCreatedAt = Math.max(maxCreatedAt, step.createdAt);
    }

    if (step.status === "ERROR") {
      errorStepsCount++;
    }

    toolCallsCount += countToolCalls(step.type === "PLANNER_RESPONSE" ? step.toolCalls : undefined);

    const contentStr = step.content || "";
    const thinkingStr = step.thinking || "";
    const toolCallsStr = step.toolCalls || "";
    const stepText = contentStr + thinkingStr + toolCallsStr;
    stepTokens.push(stepText ? encoder.encode(stepText).length : 0);
  }

  return { minCreatedAt, maxCreatedAt, errorStepsCount, toolCallsCount, stepTokens };
}

interface CachingMetrics {
  cumulativeInputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  estimatedOutputTokens: number;
  lastModelCallIndex: number;
}

function sumTokens(tokens: number[], start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) {
    sum += tokens[i];
  }
  return sum;
}

function simulateCaching(steps: StepData[], stepTokens: number[]): CachingMetrics {
  let cumulativeInputTokens = 0;
  let cacheHitTokens = 0;
  let cacheMissTokens = 0;
  let estimatedOutputTokens = 0;
  let lastModelCallIndex = -1;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.type !== "PLANNER_RESPONSE") continue;

    let hit = 0;
    let miss = 0;

    if (lastModelCallIndex === -1) {
      miss = sumTokens(stepTokens, 0, i);
    } else {
      hit = sumTokens(stepTokens, 0, lastModelCallIndex + 1);
      miss = sumTokens(stepTokens, lastModelCallIndex + 1, i);
    }

    cumulativeInputTokens += (hit + miss);
    cacheHitTokens += hit;
    cacheMissTokens += miss;
    estimatedOutputTokens += stepTokens[i];

    lastModelCallIndex = i;
  }

  return { cumulativeInputTokens, cacheHitTokens, cacheMissTokens, estimatedOutputTokens, lastModelCallIndex };
}

function computeSingleSessionMetrics(sessionId: string, session: any, steps: StepData[]): SessionBenchmarkMetrics {
  const hasDetailedSteps = steps.length > 0;

  let totalSteps = steps.length;
  let toolCallsCount = 0;
  let durationMs: number | null = null;
  let cumulativeInputTokens = 0;
  let cacheHitTokens = 0;
  let cacheMissTokens = 0;
  let cacheHitRate = 0;
  let estimatedCostSavings = 0;
  let peakContextSize = 0;
  let estimatedOutputTokens = 0;
  let errorStepsCount = 0;

  if (hasDetailedSteps) {
    const analysis = analyzeSteps(steps);
    errorStepsCount = analysis.errorStepsCount;
    toolCallsCount = analysis.toolCallsCount;
    const stepTokens = analysis.stepTokens;

    const cache = simulateCaching(steps, stepTokens);
    cumulativeInputTokens = cache.cumulativeInputTokens;
    cacheHitTokens = cache.cacheHitTokens;
    cacheMissTokens = cache.cacheMissTokens;
    estimatedOutputTokens = cache.estimatedOutputTokens;
    const lastModelCallIndex = cache.lastModelCallIndex;

    if (lastModelCallIndex === -1) {
      const total = stepTokens.reduce((a, b) => a + b, 0);
      cacheMissTokens = total;
      cumulativeInputTokens = total;
    }

    peakContextSize = stepTokens.reduce((a, b) => a + b, 0);

    if (cumulativeInputTokens > 0) {
      cacheHitRate = (cacheHitTokens / cumulativeInputTokens) * 100;
      estimatedCostSavings = (1 - (cacheMissTokens + 0.1 * cacheHitTokens) / cumulativeInputTokens) * 100;
    }

    if (analysis.minCreatedAt !== Infinity && analysis.maxCreatedAt !== -Infinity) {
      durationMs = analysis.maxCreatedAt - analysis.minCreatedAt;
    }
  } else {
    // Fallback
    totalSteps = session.chunks.length;
    let fullChunksText = "";
    for (const chunk of session.chunks) {
      fullChunksText += chunk.text + "\n";
    }

    if (fullChunksText) {
      const total = encoder.encode(fullChunksText).length;
      cacheMissTokens = Math.ceil(total * 0.6);
      estimatedOutputTokens = Math.ceil(total * 0.4);
      cumulativeInputTokens = cacheMissTokens;
      peakContextSize = total;
    }
  }

  return {
    sessionId,
    title: session.title,
    totalSteps,
    toolCallsCount,
    durationMs,
    cumulativeInputTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheHitRate,
    estimatedCostSavings,
    peakContextSize,
    estimatedOutputTokens,
    errorStepsCount,
    hasDetailedSteps
  };
}

export async function computeSessionBenchmarks(
  sessionIds: string[]
): Promise<SessionBenchmarkMetrics[]> {
  const store = getStore();
  const metricsList: SessionBenchmarkMetrics[] = [];

  for (const sessionId of sessionIds) {
    const result = store.query({
      sessionId,
      includeSteps: true
    });

    const session = result.sessions[0];
    if (!session) {
      continue;
    }

    metricsList.push(computeSingleSessionMetrics(sessionId, session, result.steps));
  }

  return metricsList;
}

function incrementToolStats(toolCallsStr: string, stats: Record<string, number>): void {
  try {
    const calls = JSON.parse(toolCallsStr);
    if (!Array.isArray(calls)) return;
    for (const call of calls) {
      let name = call.name || "unknown";
      if (name === "call_mcp_tool" && call.args) {
        const server = call.args.ServerName || "unknown";
        const tool = call.args.ToolName || "unknown";
        name = `${server}/${tool}`;
      }
      name = name.replaceAll("\\", "").replaceAll('"', "").trim();
      stats[name] = (stats[name] || 0) + 1;
    }
  } catch {}
}

export async function getToolUsageStats(options: { limit?: number; projectPath?: string; scope?: "workspace" | "all" } = {}): Promise<Record<string, number>> {
  const store = getStore();
  const limit = options.limit ?? 30;
  const projectPath = options.projectPath;
  const scope = options.scope;

  const result = store.query({
    projectPath,
    scope,
    limit,
    includeSteps: true
  });

  const stats: Record<string, number> = {};

  for (const step of result.steps) {
    if (step.toolCalls) {
      incrementToolStats(step.toolCalls, stats);
    }
  }

  return stats;
}
