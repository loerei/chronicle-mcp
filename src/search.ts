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
    conversationStepsOnly?: boolean;
    reverseSteps?: boolean;
    startConversationStep?: number;
    endConversationStep?: number;
  } = {}
): Promise<any> {
  const store = getStore();
  const includeSteps = !!(options.includeToolCalls || options.includeCallResults || options.conversationStepsOnly);
  const result = store.query({
    sessionId,
    includeSteps,
    startStep: options.startStep,
    endStep: options.endStep,
    excludeContent: options.excludeContent,
    conversationStepsOnly: options.conversationStepsOnly,
    reverseSteps: options.reverseSteps,
    startConversationStep: options.startConversationStep,
    endConversationStep: options.endConversationStep
  });

  const session = result.sessions[0];
  if (!session) return null;

  const dbChunks = result.chunks.map(c => ({
    step_index: c.stepIndex,
    chunk_text: c.text
  }));

  // Query all conversation steps for this session to build the absolute conversation_step_index mapping
  const allConvResult = store.query({
    sessionId,
    includeSteps: true,
    conversationStepsOnly: true
  });
  const sortedConvSteps = [...allConvResult.steps].sort((a, b) => a.stepIndex - b.stepIndex);
  const convStepIndexMap = new Map<number, number>();
  sortedConvSteps.forEach((step, idx) => {
    convStepIndexMap.set(step.stepIndex, idx + 1);
  });

  const dbSteps = result.steps.map(s => ({
    step_index: s.stepIndex,
    type: s.type,
    source: s.source,
    status: s.status,
    content: s.content,
    thinking: s.thinking,
    tool_calls: s.toolCalls,
    created_at: s.createdAt,
    conversation_step_index: convStepIndexMap.get(s.stepIndex) ?? null
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
  let activeStartIndex = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.type === "CHECKPOINT") {
      activeStartIndex = i;
      continue;
    }

    if (step.type !== "PLANNER_RESPONSE") continue;

    let hit = 0;
    let miss = 0;

    if (lastModelCallIndex === -1 || lastModelCallIndex < activeStartIndex) {
      miss = sumTokens(stepTokens, activeStartIndex, i);
    } else {
      hit = sumTokens(stepTokens, activeStartIndex, lastModelCallIndex + 1);
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

    let maxContextSize = 0;
    let activeStartIndex = 0;
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].type === "CHECKPOINT") {
        activeStartIndex = i;
      }
      if (steps[i].type === "PLANNER_RESPONSE") {
        const currentContextSize = sumTokens(stepTokens, activeStartIndex, i);
        if (currentContextSize > maxContextSize) {
          maxContextSize = currentContextSize;
        }
      }
    }
    peakContextSize = maxContextSize > 0 ? maxContextSize : stepTokens.reduce((a, b) => a + b, 0);

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

export interface StepContextPoint {
  stepIndex: number;
  type: string;
  source: string;
  tokens: number;
  cumulativeContextSize: number;
  cumulativeOutputTokens: number;
  isConversational: boolean;
  isCheckpoint: boolean;
  contentPreview: string;
  createdAt?: number;
}

export function generateInteractiveContextChartHtml(
  sessionId: string,
  sessionTitle: string,
  steps: StepData[]
): string {
  if (!steps || steps.length === 0) {
    return `<!DOCTYPE html><html><body><h1>No steps recorded for session: ${sessionId}</h1></body></html>`;
  }

  const analysis = analyzeSteps(steps);
  const stepTokens = analysis.stepTokens;

  const points: StepContextPoint[] = [];
  let activeStartIndex = 0;
  let currentContextSize = 0;
  let runningOutputTokens = 0;
  let checkpointCount = 0;
  let conversationalCount = 0;
  let peakContextSize = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const tokens = stepTokens[i] || 0;
    const isCheckpoint = step.type === "CHECKPOINT";
    const isConversational = step.source === "USER_EXPLICIT" || step.type === "USER_INPUT";
    const isPlannerResponse = step.type === "PLANNER_RESPONSE" || step.source === "MODEL";

    if (isCheckpoint) {
      activeStartIndex = i;
      checkpointCount++;
    }
    if (isConversational) {
      conversationalCount++;
    }
    if (isPlannerResponse) {
      runningOutputTokens += tokens;
    }

    currentContextSize = sumTokens(stepTokens, activeStartIndex, i + 1);
    if (currentContextSize > peakContextSize) {
      peakContextSize = currentContextSize;
    }

    const contentRaw = step.content || step.thinking || "";
    const previewStr = contentRaw.slice(0, 150).replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

    points.push({
      stepIndex: step.stepIndex ?? i,
      type: step.type,
      source: step.source || "",
      tokens,
      cumulativeContextSize: currentContextSize,
      cumulativeOutputTokens: runningOutputTokens,
      isConversational,
      isCheckpoint,
      contentPreview: previewStr,
      createdAt: step.createdAt
    });
  }

  const stepSpacing = 24;
  const paddingLeft = 75;
  const paddingRight = 40;
  const paddingTop = 40;
  const paddingBottom = 45;
  const chartHeight = 520;
  const innerHeight = chartHeight - paddingTop - paddingBottom;

  const totalWidth = Math.max(1200, paddingLeft + paddingRight + points.length * stepSpacing);
  const innerWidth = totalWidth - paddingLeft - paddingRight;

  const maxValTokens = Math.max(peakContextSize, runningOutputTokens);
  const rawMax = Math.max(10000, maxValTokens * 1.1);
  const majorUnit = rawMax >= 200000 ? 50000 : 10000;
  const maxVal = Math.ceil(rawMax / majorUnit) * majorUnit;
  const minorStep = maxVal > 300000 ? 5000 : 1000;

  function getX(idx: number): number {
    if (points.length <= 1) return paddingLeft + innerWidth / 2;
    return paddingLeft + (idx / (points.length - 1)) * innerWidth;
  }

  function getY(val: number): number {
    return paddingTop + innerHeight - (val / maxVal) * innerHeight;
  }

  let yGridHtml = "";
  let stickyYGridLabelsHtml = "";

  for (let val = 0; val <= maxVal; val += minorStep) {
    const yPos = getY(val);
    const is100k = val > 0 && val % 100000 === 0;
    const is10k = val % 10000 === 0;

    let strokeColor = "rgba(42, 48, 60, 0.25)";
    let strokeWidth = "0.5";
    let dashArray = "1 3";

    if (is100k) {
      strokeColor = "rgba(167, 139, 250, 0.5)";
      strokeWidth = "1.5";
      dashArray = "4 4";
    } else if (is10k) {
      strokeColor = "rgba(99, 102, 241, 0.35)";
      strokeWidth = "1";
      dashArray = "2 4";
    }

    yGridHtml += `<line x1="${paddingLeft}" y1="${yPos}" x2="${totalWidth - paddingRight}" y2="${yPos}" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-dasharray="${dashArray}"/>\n`;

    if (is100k || is10k || val === 0) {
      const labelText = val === 0 ? "0 tok" : `${val / 1000}k tok`;
      let textColor = "#6e7681";
      if (is100k) {
        textColor = "#c4b5fd";
      } else if (is10k) {
        textColor = "#8b949e";
      }
      const fontWeight = is100k ? "bold" : "normal";

      stickyYGridLabelsHtml += `<text x="${paddingLeft - 12}" y="${yPos + 4}" fill="${textColor}" font-size="10" font-weight="${fontWeight}" text-anchor="end" font-family="sans-serif">${labelText}</text>\n`;
    }
  }

  const polylineCoords = points.map((p, idx) => `${getX(idx).toFixed(1)},${getY(p.cumulativeContextSize).toFixed(1)}`).join(" ");
  const outputPolylineCoords = points.map((p, idx) => `${getX(idx).toFixed(1)},${getY(p.cumulativeOutputTokens).toFixed(1)}`).join(" ");
  const firstX = getX(0).toFixed(1);
  const lastX = getX(points.length - 1).toFixed(1);
  const baselineY = (chartHeight - paddingBottom).toFixed(1);
  const areaPolygonCoords = `${firstX},${baselineY} ${polylineCoords} ${lastX},${baselineY}`;
  const outputAreaPolygonCoords = `${firstX},${baselineY} ${outputPolylineCoords} ${lastX},${baselineY}`;

  let checkpointsHtml = "";
  let dataPointsHtml = "";
  let interactiveNodesHtml = "";
  let xAxisLabelsHtml = "";
  let checkpointNum = 0;

  points.forEach((p, idx) => {
    const cx = getX(idx);
    const cy = getY(p.cumulativeContextSize);

    if (p.isCheckpoint) {
      checkpointNum++;
      checkpointsHtml += `
        <g class="checkpoint-group" data-step="${p.stepIndex}">
          <line x1="${cx}" y1="${paddingTop}" x2="${cx}" y2="${chartHeight - paddingBottom}" stroke="#ef4444" stroke-width="2" stroke-dasharray="4 4"/>
          <rect x="${cx - 45}" y="${paddingTop - 25}" width="90" height="20" rx="4" fill="#ef4444" opacity="0.9"/>
          <text x="${cx}" y="${paddingTop - 11}" fill="#ffffff" font-size="11" font-weight="bold" text-anchor="middle" font-family="sans-serif">CHECKPOINT ${checkpointNum}</text>
        </g>`;
    }

    let fillColor = "#6366f1";
    let radius = 3;
    let pointClass = "point-normal";
    let hitClass = "hit-target";

    if (p.isConversational) {
      fillColor = "#10b981";
      radius = 5;
      pointClass = "point-conversational";
      hitClass += " hit-target-conversational";
    } else if (p.isCheckpoint) {
      fillColor = "#ef4444";
      radius = 6;
      pointClass = "point-checkpoint";
    }

    dataPointsHtml += `<circle class="${pointClass}" cx="${cx}" cy="${cy}" r="${radius}" fill="${fillColor}" stroke="#161b22" stroke-width="1.5"/>\n`;

    interactiveNodesHtml += `
      <circle class="${hitClass}" cx="${cx}" cy="${cy}" r="12" fill="transparent" 
        data-idx="${idx}"
      />\n`;

    if (idx % 5 === 0 || p.isConversational || p.isCheckpoint || idx === points.length - 1) {
      let labelColor = "#8b949e";
      let guideColor = "rgba(42, 48, 60, 0.7)";

      if (p.isCheckpoint) {
        labelColor = "#ef4444";
      } else if (p.isConversational) {
        labelColor = "#10b981";
        guideColor = "rgba(16, 185, 129, 0.4)";
      }

      if (!p.isCheckpoint) {
        xAxisLabelsHtml += `<line x1="${cx}" y1="${cy + 4}" x2="${cx}" y2="${chartHeight - 24}" stroke="${guideColor}" stroke-dasharray="2 3" stroke-width="1"/>\n`;
      }

      xAxisLabelsHtml += `<text x="${cx}" y="${chartHeight - 12}" fill="${labelColor}" font-size="10" text-anchor="middle" font-family="sans-serif">#${p.stepIndex}</text>\n`;
    }
  });

  const pointsDataJson = JSON.stringify(points.map((p, idx) => ({
    idx,
    cx: Number(getX(idx).toFixed(1)),
    cy: Number(getY(p.cumulativeContextSize).toFixed(1)),
    stepIndex: p.stepIndex,
    type: p.type,
    source: p.source,
    tokens: p.tokens,
    context: p.cumulativeContextSize,
    outputContext: p.cumulativeOutputTokens,
    isCkpt: p.isCheckpoint,
    isConv: p.isConversational,
    preview: p.contentPreview,
    fullContent: (steps[idx].content || steps[idx].thinking || "").slice(0, 8000),
    createdAt: p.createdAt ? new Date(p.createdAt).toLocaleString() : "N/A"
  })));
  const pointsDataB64 = Buffer.from(pointsDataJson, "utf-8").toString("base64");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Context Window Timeline - ${sessionId}</title>
  <style>
    :root {
      --bg-color: #0d1117;
      --card-bg: #161b22;
      --border-color: #30363d;
      --text-main: #c9d1d9;
      --text-muted: #8b949e;
      --accent-purple: #8b5cf6;
      --accent-cyan: #10b981;
      --accent-red: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg-color);
      color: var(--text-main);
      padding: 24px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      background: var(--card-bg);
      padding: 16px 24px;
      border-radius: 8px;
      border: 1px solid var(--border-color);
    }
    .header h1 { font-size: 20px; font-weight: 600; color: #f0f6fc; }
    .stats-row { display: flex; gap: 16px; font-size: 13px; color: var(--text-muted); }
    .stat-badge {
      background: #21262d;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border-color);
    }
    .stat-badge strong { color: #f0f6fc; font-weight: 600; }
    .controls-bar {
      display: flex;
      gap: 20px;
      margin-bottom: 16px;
      font-size: 13px;
      align-items: center;
    }
    .control-item { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
    .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .dot-conv { background-color: var(--accent-cyan); }
    .dot-ckpt { background-color: var(--accent-red); }
    .dot-line { background-color: #6366f1; }
    .dot-output { background-color: #ef4444; }
    
    /* Custom Scrollbar */
    ::-webkit-scrollbar {
      height: 8px;
      width: 8px;
    }
    ::-webkit-scrollbar-track {
      background: #161b22;
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb {
      background: #30363d;
      border-radius: 4px;
      border: 2px solid #161b22;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: #484f58;
    }

    .chart-viewport {
      width: 100%;
      overflow-x: auto;
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      position: relative;
      padding: 0;
      margin: 0;
    }
    .sticky-y-axis {
      position: sticky;
      left: 0;
      top: 0;
      z-index: 15;
      width: ${paddingLeft}px;
      height: ${chartHeight}px;
      float: left;
      margin-right: -${paddingLeft}px;
      pointer-events: auto;
      background: linear-gradient(90deg, rgba(22, 27, 34, 0.95) 0%, rgba(22, 27, 34, 0.85) 75%, rgba(22, 27, 34, 0) 100%);
    }
    .control-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #21262d;
      color: #c9d1d9;
      border: 1px solid var(--border-color);
      padding: 5px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      margin-left: 12px;
      transition: background 0.15s ease;
    }
    .control-btn:hover {
      background: #30363d;
      color: #ffffff;
      border-color: #8b949e;
    }
    .chart-viewport svg {
      display: block;
    }
    .hit-target { cursor: pointer; }
    .hit-target:hover { stroke: #ffffff; stroke-width: 2px; }

    #tooltip {
      position: fixed;
      display: none;
      pointer-events: none;
      background: #1f242c;
      border: 1px solid #484f58;
      border-radius: 6px;
      padding: 12px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.6);
      z-index: 9999;
      width: 290px;
      font-size: 12px;
    }
    #tooltip .title { font-weight: 600; font-size: 13px; color: #f0f6fc; margin-bottom: 6px; }
    #tooltip .row { display: flex; justify-content: space-between; margin-bottom: 4px; color: var(--text-muted); }
    #tooltip .row span { color: #f0f6fc; font-weight: 500; }
    #tooltip .hint { margin-top: 6px; font-size: 10px; color: #8b949e; border-top: 1px solid var(--border-color); padding-top: 4px; }

    #pinned-card {
      position: fixed;
      display: none;
      top: 80px;
      right: 24px;
      width: 480px;
      max-height: calc(100vh - 120px);
      background: #161b22;
      border: 1px solid #484f58;
      border-radius: 8px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.8);
      z-index: 10000;
      flex-direction: column;
      overflow: hidden;
    }
    #pinned-card.active { display: flex; }
    .pinned-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: #21262d;
      border-bottom: 1px solid var(--border-color);
    }
    .pinned-header h3 { font-size: 14px; font-weight: 600; color: #f0f6fc; }
    .pinned-close {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 20px;
      cursor: pointer;
      line-height: 1;
    }
    .pinned-close:hover { color: #ffffff; }
    .pinned-body {
      padding: 16px;
      overflow-y: auto;
      font-size: 12px;
    }
    .pinned-body .row { display: flex; justify-content: space-between; margin-bottom: 6px; color: var(--text-muted); }
    .pinned-body .row span { color: #f0f6fc; font-weight: 600; }
    .pinned-content {
      margin-top: 12px;
      padding: 12px;
      background: #0d1117;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      color: #c9d1d9;
      font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
      font-size: 11px;
      white-space: pre-wrap;
      max-height: 320px;
      overflow-y: auto;
      line-height: 1.5;
    }
    .pinned-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 10px;
      font-weight: 600;
      background: #8b5cf6;
      color: #ffffff;
      margin-left: 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Context Window Timeline</h1>
      <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">Session: <code>${sessionTitle || sessionId}</code></div>
    </div>
    <div class="stats-row">
      <div class="stat-badge">Total Steps: <strong>${points.length}</strong></div>
      <div class="stat-badge">Peak Context: <strong>${peakContextSize.toLocaleString()} tokens</strong></div>
      <div class="stat-badge">Total Output: <strong>${runningOutputTokens.toLocaleString()} tokens</strong></div>
      <div class="stat-badge">Checkpoints: <strong>${checkpointCount}</strong></div>
      <div class="stat-badge">Conversational Turns: <strong>${conversationalCount}</strong></div>
    </div>
  </div>

  <div class="controls-bar">
    <label class="control-item"><input type="checkbox" id="toggle-line" checked /> <span class="dot dot-line"></span> Context Window Area</label>
    <label class="control-item"><input type="checkbox" id="toggle-output" checked /> <span class="dot dot-output"></span> Cumulative Output Area</label>
    <label class="control-item"><input type="checkbox" id="toggle-conv" checked /> <span class="dot dot-conv"></span> Conversational Steps (User)</label>
    <label class="control-item"><input type="checkbox" id="toggle-ckpt" checked /> <span class="dot dot-ckpt"></span> Checkpoint Markers</label>
    <div style="display: flex; gap: 8px; align-items: center; margin-left: auto;">
      <span class="stat-badge" id="zoom-badge" style="font-size: 11px;">Zoom: 100% X | 100% Y</span>
      <button id="btn-zoom-in" class="control-btn" title="Zoom In Both Axes">+</button>
      <button id="btn-zoom-out" class="control-btn" title="Zoom Out Both Axes">-</button>
      <button id="btn-reset-view" class="control-btn" title="Reset View Zoom">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
          <path d="M3 3v5h5"/>
        </svg>
        Reset View
      </button>
    </div>
  </div>

  <div class="chart-viewport" id="viewport">
    <div class="sticky-y-axis">
      <svg width="${paddingLeft}" height="${chartHeight}">
        ${stickyYGridLabelsHtml}
      </svg>
    </div>
    <svg width="${totalWidth}" height="${chartHeight}" id="svg-chart">
      <defs>
        <linearGradient id="area-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#6366f1" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="#6366f1" stop-opacity="0.03"/>
        </linearGradient>
        <linearGradient id="output-area-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ef4444" stop-opacity="0.40"/>
          <stop offset="100%" stop-color="#ef4444" stop-opacity="0.03"/>
        </linearGradient>
      </defs>
      <g id="layer-ygrid">${yGridHtml}</g>
      <polygon id="output-area" fill="url(#output-area-gradient)" points="${outputAreaPolygonCoords}" />
      <polyline id="output-line" fill="none" stroke="#ef4444" stroke-width="2" stroke-dasharray="3 3" points="${outputPolylineCoords}" />
      <polygon id="context-area" fill="url(#area-gradient)" points="${areaPolygonCoords}" />
      <polyline id="context-line" fill="none" stroke="#6366f1" stroke-width="2.5" points="${polylineCoords}" />
      <g id="layer-checkpoints">${checkpointsHtml}</g>
      <g id="layer-xaxis">${xAxisLabelsHtml}</g>
      <g id="layer-points">
        ${dataPointsHtml}
        <circle id="pinned-pulse" cx="-100" cy="-100" r="10" fill="none" stroke="#10b981" stroke-width="2.5" style="display:none; pointer-events:none;">
          <animate attributeName="r" values="8;16;8" dur="1.8s" repeatCount="indefinite"/>
          <animate attributeName="stroke-opacity" values="1;0.2;1" dur="1.8s" repeatCount="indefinite"/>
        </circle>
      </g>
      <g id="layer-targets">${interactiveNodesHtml}</g>
    </svg>
  </div>
  <div id="tooltip"></div>

  <div id="pinned-card">
    <div class="pinned-header">
      <div style="display:flex; align-items:center;">
        <h3 id="pinned-title">Step Detail</h3>
        <span class="pinned-badge">PINNED</span>
      </div>
      <button class="pinned-close" id="btn-close-pinned">&times;</button>
    </div>
    <div class="pinned-body">
      <div class="row">Context Window: <span id="pinned-context">-</span></div>
      <div class="row">Cumulative Output: <span id="pinned-output">-</span></div>
      <div class="row">Step Tokens: <span id="pinned-tokens">-</span></div>
      <div class="row">Source: <span id="pinned-source">-</span></div>
      <div class="row">Created At: <span id="pinned-created">-</span></div>
      <div id="pinned-content" class="pinned-content"></div>
    </div>
  </div>

  <script>
    const pointsDataB64 = "${pointsDataB64}";
    const pointsData = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(pointsDataB64), c => c.charCodeAt(0))));
    const tooltip = document.getElementById('tooltip');
    const viewport = document.getElementById('viewport');
    const pinnedCard = document.getElementById('pinned-card');

    let scaleX = 1.0;
    let scaleY = 1.0;
    let currentPositions = [];

    const baseStepSpacing = ${stepSpacing};
    const paddingLeft = ${paddingLeft};
    const paddingRight = ${paddingRight};
    const paddingTop = ${paddingTop};
    const paddingBottom = ${paddingBottom};
    const baseChartHeight = ${chartHeight};
    const maxVal = ${maxVal};
    const minorStep = ${minorStep};

    function renderChart() {
      const currentStepSpacing = baseStepSpacing * scaleX;
      const totalWidth = Math.max(1200, paddingLeft + paddingRight + pointsData.length * currentStepSpacing);
      const innerWidth = totalWidth - paddingLeft - paddingRight;

      const chartHeight = Math.max(350, Math.round(baseChartHeight * scaleY));
      const innerHeight = chartHeight - paddingTop - paddingBottom;

      function getX(idx) {
        if (pointsData.length <= 1) return paddingLeft + innerWidth / 2;
        return paddingLeft + (idx / (pointsData.length - 1)) * innerWidth;
      }

      function getY(val) {
        return paddingTop + innerHeight - (val / maxVal) * innerHeight;
      }

      const svgChart = document.getElementById('svg-chart');
      svgChart.setAttribute('width', totalWidth);
      svgChart.setAttribute('height', chartHeight);

      const stickyAxis = document.querySelector('.sticky-y-axis');
      const stickySvg = stickyAxis.querySelector('svg');
      stickyAxis.style.height = chartHeight + 'px';
      stickySvg.setAttribute('height', chartHeight);

      let yGridHtml = '';
      let stickyYGridLabelsHtml = '';

      for (let val = 0; val <= maxVal; val += minorStep) {
        const yPos = getY(val);
        const is100k = val > 0 && val % 100000 === 0;
        const is10k = val % 10000 === 0;

        let strokeColor = 'rgba(42, 48, 60, 0.25)';
        let strokeWidth = '0.5';
        let dashArray = '1 3';

        if (is100k) {
          strokeColor = 'rgba(167, 139, 250, 0.5)';
          strokeWidth = '1.5';
          dashArray = '4 4';
        } else if (is10k) {
          strokeColor = 'rgba(99, 102, 241, 0.35)';
          strokeWidth = '1';
          dashArray = '2 4';
        }

        yGridHtml += '<line x1="' + paddingLeft + '" y1="' + yPos + '" x2="' + (totalWidth - paddingRight) + '" y2="' + yPos + '" stroke="' + strokeColor + '" stroke-width="' + strokeWidth + '" stroke-dasharray="' + dashArray + '"/>';

        if (is100k || is10k || val === 0) {
          const labelText = val === 0 ? '0 tok' : (val / 1000) + 'k tok';
          const textColor = is100k ? '#c4b5fd' : (is10k ? '#8b949e' : '#6e7681');
          const fontWeight = is100k ? 'bold' : 'normal';

          stickyYGridLabelsHtml += '<text x="' + (paddingLeft - 12) + '" y="' + (yPos + 4) + '" fill="' + textColor + '" font-size="10" font-weight="' + fontWeight + '" text-anchor="end" font-family="sans-serif">' + labelText + '</text>';
        }
      }

      stickySvg.innerHTML = stickyYGridLabelsHtml;

      currentPositions = pointsData.map((p, idx) => ({
        cx: getX(idx),
        cy: getY(p.context)
      }));

      const polylineCoords = currentPositions.map(p => p.cx.toFixed(1) + ',' + p.cy.toFixed(1)).join(' ');
      const outputPolylineCoords = currentPositions.map((p, idx) => p.cx.toFixed(1) + ',' + getY(pointsData[idx].outputContext).toFixed(1)).join(' ');
      const firstX = currentPositions[0].cx.toFixed(1);
      const lastX = currentPositions[currentPositions.length - 1].cx.toFixed(1);
      const baselineY = (chartHeight - paddingBottom).toFixed(1);
      const areaPolygonCoords = firstX + ',' + baselineY + ' ' + polylineCoords + ' ' + lastX + ',' + baselineY;
      const outputAreaPolygonCoords = firstX + ',' + baselineY + ' ' + outputPolylineCoords + ' ' + lastX + ',' + baselineY;

      document.getElementById('context-area').setAttribute('points', areaPolygonCoords);
      document.getElementById('context-line').setAttribute('points', polylineCoords);
      document.getElementById('output-area').setAttribute('points', outputAreaPolygonCoords);
      document.getElementById('output-line').setAttribute('points', outputPolylineCoords);

      let checkpointsHtml = '';
      let checkpointNum = 0;
      let xAxisLabelsHtml = '';
      let dataPointsHtml = '';
      let interactiveNodesHtml = '';

      pointsData.forEach((p, idx) => {
        const cx = currentPositions[idx].cx;
        const cy = currentPositions[idx].cy;

        if (p.isCkpt) {
          checkpointNum++;
          checkpointsHtml += '<g class="checkpoint-group" data-step="' + p.stepIndex + '">' +
            '<line x1="' + cx + '" y1="' + paddingTop + '" x2="' + cx + '" y2="' + (chartHeight - paddingBottom) + '" stroke="#ef4444" stroke-width="2" stroke-dasharray="4 4"/>' +
            '<rect x="' + (cx - 45) + '" y="' + (paddingTop - 25) + '" width="90" height="20" rx="4" fill="#ef4444" opacity="0.9"/>' +
            '<text x="' + cx + '" y="' + (paddingTop - 11) + '" fill="#ffffff" font-size="11" font-weight="bold" text-anchor="middle" font-family="sans-serif">CHECKPOINT ' + checkpointNum + '</text>' +
            '</g>';
        }

        let fillColor = '#6366f1';
        let radius = 3;
        let pointClass = 'point-normal';
        let hitClass = 'hit-target';

        if (p.isConv) {
          fillColor = '#10b981';
          radius = 5;
          pointClass = 'point-conversational';
          hitClass += ' hit-target-conversational';
        } else if (p.isCkpt) {
          fillColor = '#ef4444';
          radius = 6;
          pointClass = 'point-checkpoint';
        }

        dataPointsHtml += '<circle class="' + pointClass + '" cx="' + cx + '" cy="' + cy + '" r="' + radius + '" fill="' + fillColor + '" stroke="#161b22" stroke-width="1.5"/>';

        interactiveNodesHtml += '<circle class="' + hitClass + '" cx="' + cx + '" cy="' + cy + '" r="12" fill="transparent" data-idx="' + idx + '"/>';

        if (idx % 5 === 0 || p.isConv || p.isCkpt || idx === pointsData.length - 1) {
          let labelColor = '#8b949e';
          let guideColor = 'rgba(42, 48, 60, 0.7)';

          if (p.isCkpt) {
            labelColor = '#ef4444';
          } else if (p.isConv) {
            labelColor = '#10b981';
            guideColor = 'rgba(16, 185, 129, 0.4)';
          }

          if (!p.isCkpt) {
            xAxisLabelsHtml += '<line x1="' + cx + '" y1="' + (cy + 4) + '" x2="' + cx + '" y2="' + (chartHeight - 24) + '" stroke="' + guideColor + '" stroke-dasharray="2 3" stroke-width="1"/>';
          }

          xAxisLabelsHtml += '<text x="' + cx + '" y="' + (chartHeight - 12) + '" fill="' + labelColor + '" font-size="10" text-anchor="middle" font-family="sans-serif">#' + p.stepIndex + '</text>';
        }
      });

      document.getElementById('layer-ygrid').innerHTML = yGridHtml;
      document.getElementById('layer-checkpoints').innerHTML = checkpointsHtml;
      document.getElementById('layer-xaxis').innerHTML = xAxisLabelsHtml;
      document.getElementById('layer-points').innerHTML = dataPointsHtml + '<circle id="pinned-pulse" cx="-100" cy="-100" r="10" fill="none" stroke="#10b981" stroke-width="2.5" style="display:none; pointer-events:none;"><animate attributeName="r" values="8;16;8" dur="1.8s" repeatCount="indefinite"/><animate attributeName="stroke-opacity" values="1;0.2;1" dur="1.8s" repeatCount="indefinite"/></circle>';
      document.getElementById('layer-targets').innerHTML = interactiveNodesHtml;

      const badge = document.getElementById('zoom-badge');
      if (badge) {
        badge.textContent = 'Zoom: ' + Math.round(scaleX * 100) + '% X | ' + Math.round(scaleY * 100) + '% Y';
      }

      attachHitTargetListeners();
    }

    function updatePinnedCard(idx) {
      const p = pointsData[idx];
      const pos = currentPositions[idx];
      if (!p || !pos) return;

      let tagStr = p.type;
      if (p.isCkpt) tagStr += ' (CHECKPOINT)';
      if (p.isConv) tagStr += ' (USER)';

      document.getElementById('pinned-title').textContent = 'Step #' + p.stepIndex + ' - ' + tagStr;
      document.getElementById('pinned-context').textContent = p.context.toLocaleString() + ' tokens';
      document.getElementById('pinned-output').textContent = (p.outputContext || 0).toLocaleString() + ' tokens';
      document.getElementById('pinned-tokens').textContent = p.tokens.toLocaleString() + ' tokens';
      document.getElementById('pinned-source').textContent = p.source || 'N/A';
      document.getElementById('pinned-created').textContent = p.createdAt;

      const contentEl = document.getElementById('pinned-content');
      contentEl.textContent = p.fullContent || '(No text content)';

      const pulse = document.getElementById('pinned-pulse');
      if (pulse) {
        pulse.setAttribute('cx', pos.cx);
        pulse.setAttribute('cy', pos.cy);
        pulse.style.display = 'block';
      }

      pinnedCard.classList.add('active');
    }

    function closePinnedCard() {
      pinnedCard.classList.remove('active');
      const pulse = document.getElementById('pinned-pulse');
      if (pulse) pulse.style.display = 'none';
    }

    function attachHitTargetListeners() {
      document.querySelectorAll('.hit-target').forEach(node => {
        const idx = Number(node.getAttribute('data-idx'));
        const p = pointsData[idx];

        node.addEventListener('mouseenter', (e) => {
          if (!p) return;
          let tagStr = p.type;
          if (p.isCkpt) tagStr += ' (CHECKPOINT)';
          if (p.isConv) tagStr += ' (USER)';

          tooltip.innerHTML =
            '<div class="title">Step #' + p.stepIndex + ' - ' + tagStr + '</div>' +
            '<div class="row">Context Window: <span>' + p.context.toLocaleString() + ' tokens</span></div>' +
            '<div class="row">Cumulative Output: <span>' + (p.outputContext || 0).toLocaleString() + ' tokens</span></div>' +
            '<div class="row">Step Tokens: <span>' + p.tokens.toLocaleString() + ' tokens</span></div>' +
            '<div class="row">Source: <span>' + (p.source || 'N/A') + '</span></div>' +
            '<div class="hint">(Click point to pin & expand full content)</div>';

          tooltip.style.display = 'block';
        });

        node.addEventListener('mousemove', (e) => {
          const tooltipWidth = 290;
          const tooltipHeight = tooltip.offsetHeight || 160;

          let left = e.clientX + 15;
          if (left + tooltipWidth > window.innerWidth - 10) {
            left = e.clientX - tooltipWidth - 15;
          }

          let top = e.clientY + 15;
          if (top + tooltipHeight > window.innerHeight - 10) {
            top = e.clientY - tooltipHeight - 15;
          }

          tooltip.style.left = Math.max(10, left) + 'px';
          tooltip.style.top = Math.max(10, top) + 'px';
        });

        node.addEventListener('mouseleave', () => {
          tooltip.style.display = 'none';
        });

        node.addEventListener('click', (e) => {
          e.stopPropagation();
          updatePinnedCard(idx);
        });
      });
    }

    document.getElementById('btn-close-pinned').addEventListener('click', closePinnedCard);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePinnedCard();
    });

    // Window wheel navigation and zoom listener
    window.addEventListener('wheel', (e) => {
      const target = e.target;
      if (!target) return;
      const insideViewport = target.closest('#viewport') || target.closest('.sticky-y-axis') || target.closest('#svg-chart');
      if (!insideViewport) return;

      // If CTRL or META key is held down -> Perform Chart Zoom
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault(); // Prevent native browser page zoom inside chart

        const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        if (!delta) return;

        const zoomFactor = delta < 0 ? 1.15 : 0.85;

        const isYAxisZone = target.closest('.sticky-y-axis');
        const viewportRect = viewport.getBoundingClientRect();
        const isXAxisZone = target.closest('#layer-xaxis') || (e.clientY > viewportRect.bottom - 45);

        if (isYAxisZone) {
          scaleY = Math.max(0.2, Math.min(8.0, scaleY * zoomFactor));
        } else if (isXAxisZone) {
          scaleX = Math.max(0.2, Math.min(8.0, scaleX * zoomFactor));
        } else {
          scaleX = Math.max(0.2, Math.min(8.0, scaleX * zoomFactor));
          scaleY = Math.max(0.2, Math.min(8.0, scaleY * zoomFactor));
        }

        renderChart();
        return;
      }

      // Default Scroll or Shift+Scroll -> Horizontal scrolling across steps
      const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      if (delta !== 0) {
        e.preventDefault();
        viewport.scrollLeft += delta;
      }
    }, { passive: false });

    // Click Zoom buttons
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      scaleX = Math.min(8.0, scaleX * 1.25);
      scaleY = Math.min(8.0, scaleY * 1.25);
      renderChart();
    });

    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      scaleX = Math.max(0.2, scaleX / 1.25);
      scaleY = Math.max(0.2, scaleY / 1.25);
      renderChart();
    });

    // Reset View button
    document.getElementById('btn-reset-view').addEventListener('click', () => {
      scaleX = 1.0;
      scaleY = 1.0;
      renderChart();
    });

    document.getElementById('toggle-line').addEventListener('change', (e) => {
      const display = e.target.checked ? 'block' : 'none';
      document.getElementById('context-area').style.display = display;
      document.getElementById('context-line').style.display = display;
    });
    document.getElementById('toggle-output').addEventListener('change', (e) => {
      const display = e.target.checked ? 'block' : 'none';
      document.getElementById('output-area').style.display = display;
      document.getElementById('output-line').style.display = display;
    });
    document.getElementById('toggle-conv').addEventListener('change', (e) => {
      const display = e.target.checked ? 'block' : 'none';
      document.querySelectorAll('.point-conversational, .hit-target-conversational').forEach(el => el.style.display = display);
    });
    document.getElementById('toggle-ckpt').addEventListener('change', (e) => {
      document.getElementById('layer-checkpoints').style.display = e.target.checked ? 'block' : 'none';
    });

    // Initial render
    renderChart();
  </script>
</body>
</html>`;
}
