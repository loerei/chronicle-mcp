import type { SearchHistoryResult } from "./search.js";
import type { SessionData, ToolUsageReport } from "./adapters/types.js";

const FORBIDDEN_PROPERTIES = new Set(["__proto__", "constructor", "prototype"]);

const SEARCH_FIELD_WHITELIST = new Set([
  "sessionId",
  "id",
  "turnIndex",
  "score",
  "title",
  "role",
  "projectPath",
  "matchedUserPrompt",
  "prompt",
  "matchedAssistantSnippet",
  "snippet",
  "createdAt",
  "conversationLink",
  "files_touched",
  "filesTouched",
  "artifacts",
  "first_prompt",
  "firstPrompt",
]);

const SESSION_FIELD_WHITELIST = new Set([
  "id",
  "sessionId",
  "title",
  "project_path",
  "projectPath",
  "total_turns",
  "totalTurns",
  "total_steps",
  "totalSteps",
  "total_tokens",
  "totalTokens",
  "created_at",
  "createdAt",
  "last_active_at",
  "lastActiveAt",
  "first_prompt",
  "firstPrompt",
  "files_touched",
  "filesTouched",
  "artifacts",
  "error_count",
  "errorCount",
  "role",
  "adapter",
  "raw_log_path",
  "rawLogPath",
  "metadata",
]);

const DEFAULT_SEARCH_COMPACT_FIELDS = [
  "sessionId",
  "turnIndex",
  "score",
  "snippet",
  "role",
  "projectPath",
];

const DEFAULT_SESSION_COMPACT_FIELDS = [
  "id",
  "title",
  "project_path",
  "total_turns",
  "total_steps",
  "role",
];

/**
 * Sanitizes multi-line text into a single line and truncates safely without breaking UTF-16 surrogate pairs.
 */
export function sanitizeSnippet(text?: string | null, maxSnippetChars = 120): string {
  if (!text) {
    return "";
  }
  const clean = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= maxSnippetChars) {
    return clean;
  }

  let sliced = clean.slice(0, maxSnippetChars);
  // Detect trailing high surrogate code point (U+D800 to U+DBFF) and back off 1 character
  if (/[\uD800-\uDBFF]$/.test(sliced)) {
    sliced = sliced.slice(0, -1);
  }
  return `${sliced}...`;
}

/**
 * Formats search results into a compact 1-line numbered markdown list.
 */
export function formatSearchHistoryMarkdown(
  query: string,
  results: SearchHistoryResult[],
  mode = "hybrid",
  maxSnippetChars = 120
): string {
  if (!results || results.length === 0) {
    return `No matching history turns found for "${query}".`;
  }

  let markdown = `# Search Results for "${query}" (${results.length} hits, mode: ${mode})\n\n`;

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    const shortId = item.sessionId ? item.sessionId.slice(0, 8) : "unknown";
    const turnIndex = item.turnIndex ?? 0;
    
    let scopeLabel = "unknown";
    if (item.role) {
      scopeLabel = `role:${item.role}`;
    } else if (item.projectPath) {
      const parts = item.projectPath.split(/[/\\]/).filter(Boolean);
      scopeLabel = parts.length > 0 ? parts[parts.length - 1] : "unknown";
    }

    const rawSnippet = item.matchedUserPrompt || item.matchedAssistantSnippet || item.title || "";
    const snippet = sanitizeSnippet(rawSnippet, maxSnippetChars);

    markdown += `${i + 1}. [${shortId}:T${turnIndex}] (${scopeLabel}) - "${snippet}"\n`;
  }

  return markdown;
}

/**
 * Formats session records into a compact 1-line numbered markdown list.
 */
export function formatListSessionsMarkdown(
  sessions: (SessionData & Record<string, any>)[],
  scope = "all",
  maxSnippetChars = 120
): string {
  if (!sessions || sessions.length === 0) {
    return "No indexed sessions found.";
  }

  let markdown = `# Indexed Sessions (${sessions.length} sessions, scope: ${scope})\n\n`;

  for (let i = 0; i < sessions.length; i++) {
    const sess = sessions[i];
    const shortId = sess.id ? sess.id.slice(0, 8) : "unknown";

    let scopeLabel = sess.adapter || "unknown";
    const projPath = sess.project_path ?? sess.projectPath;
    if (projPath) {
      const parts = projPath.split(/[/\\]/).filter(Boolean);
      if (parts.length > 0) {
        scopeLabel = parts[parts.length - 1];
      }
    }

    const title = sanitizeSnippet(sess.title || "Untitled Session", maxSnippetChars);
    const totalTurns = sess.total_turns ?? sess.totalTurns ?? 0;
    const totalSteps = sess.total_steps ?? sess.totalSteps ?? 0;
    const errorCount = sess.error_count ?? sess.errorCount ?? 0;

    let errorBadge = "";
    if (errorCount > 0) {
      errorBadge = errorCount === 1 ? ", 1 error" : `, ${errorCount} errors`;
    }

    let statusBadge = "";
    if (sess.lifecycle?.status === "interrupted_mid_turn") {
      statusBadge = ", interrupted";
    } else if (sess.lifecycle?.status === "orphaned") {
      statusBadge = ", orphaned";
    }

    markdown += `${i + 1}. [${shortId}] (${scopeLabel}) - "${title}" (${totalTurns} turns, ${totalSteps} steps${errorBadge}${statusBadge})\n`;
  }

  return markdown;
}

/**
 * Formats tool execution statistics into a clean markdown table.
 */
export function formatToolUsageStatsMarkdown(stats?: ToolUsageReport | null): string {
  if (!stats || !stats.tools || stats.tools.length === 0) {
    return "No tool usage data recorded.";
  }

  const thrashingSet = new Set<string>();
  if (Array.isArray(stats.thrashingTools)) {
    for (const t of stats.thrashingTools) {
      if (t?.serverName && t?.toolName) {
        thrashingSet.add(`${t.serverName}::${t.toolName}`);
      }
    }
  }

  let markdown = "# Tool Usage & Execution Statistics\n\n";
  markdown += "| Tool Name | Server | Calls | Failures | Error Rate (%) | Avg Duration (ms) | Thrashing Loop |\n";
  markdown += "| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n";

  let totalCalls = 0;
  for (const tool of stats.tools) {
    const toolName = (tool.toolName || "").replace(/\|/g, "\\|");
    const serverName = (tool.serverName || "").replace(/\|/g, "\\|");
    const calls = tool.totalCalls ?? (tool as any).calls ?? 0;
    const failures = tool.errorCount ?? (tool as any).failures ?? 0;
    totalCalls += calls;

    const failureRate =
      typeof tool.failureRate === "number" && !Number.isNaN(tool.failureRate)
        ? `${tool.failureRate.toFixed(1)}%`
        : "0.0%";

    const avgDurationMs =
      typeof tool.avgDurationMs === "number" && !Number.isNaN(tool.avgDurationMs)
        ? tool.avgDurationMs.toFixed(1)
        : "0.0";

    const isThrashing = thrashingSet.has(`${tool.serverName}::${tool.toolName}`) ? "YES" : "No";

    markdown += `| ${toolName} | ${serverName} | ${calls} | ${failures} | ${failureRate} | ${avgDurationMs} | ${isThrashing} |\n`;
  }

  const uniqueTools = stats.tools.length;
  if (stats.summary && typeof stats.summary.totalCalls === "number") {
    totalCalls = stats.summary.totalCalls;
  }
  markdown += `\n**Total Tool Executions**: ${totalCalls} across ${uniqueTools} tools.\n`;

  return markdown;
}

/**
 * Resolves a single field value from an entity using whitelist and alias mappings.
 */
function resolveFieldValue(item: Record<string, any>, field: string, entityType?: "search" | "session"): any {
  if (entityType === "search") {
    switch (field) {
      case "sessionId":
      case "id":
        return item.sessionId ?? item.id;
      case "turnIndex":
        return item.turnIndex;
      case "score":
        return item.score;
      case "title":
        return item.title;
      case "role":
        return item.role;
      case "projectPath":
        return item.projectPath;
      case "matchedUserPrompt":
      case "prompt":
        return item.matchedUserPrompt ?? item.prompt;
      case "matchedAssistantSnippet":
        return item.matchedAssistantSnippet;
      case "snippet":
        return item.matchedUserPrompt || item.matchedAssistantSnippet || item.title || "";
      case "createdAt":
        return item.createdAt;
      case "conversationLink":
        return item.conversationLink;
      case "files_touched":
      case "filesTouched":
        return item.files_touched ?? item.filesTouched;
      case "artifacts":
        return item.artifacts;
      case "first_prompt":
      case "firstPrompt":
        return item.first_prompt ?? item.firstPrompt;
      default:
        return item[field];
    }
  }

  if (entityType === "session") {
    switch (field) {
      case "id":
      case "sessionId":
        return item.id ?? item.sessionId;
      case "title":
        return item.title;
      case "project_path":
      case "projectPath":
        return item.project_path ?? item.projectPath;
      case "total_turns":
      case "totalTurns":
        return item.total_turns ?? item.totalTurns;
      case "total_steps":
      case "totalSteps":
        return item.total_steps ?? item.totalSteps;
      case "total_tokens":
      case "totalTokens":
        return item.total_tokens ?? item.totalTokens;
      case "created_at":
      case "createdAt":
        return item.created_at ?? item.createdAt;
      case "last_active_at":
      case "lastActiveAt":
        return item.last_active_at ?? item.lastActiveAt;
      case "first_prompt":
      case "firstPrompt":
        return item.first_prompt ?? item.firstPrompt;
      case "files_touched":
      case "filesTouched":
        return item.files_touched ?? item.filesTouched;
      case "artifacts":
        return item.artifacts;
      case "error_count":
      case "errorCount":
        return item.error_count ?? item.errorCount;
      case "role":
        return item.role;
      case "adapter":
        return item.adapter;
      case "raw_log_path":
      case "rawLogPath":
        return item.raw_log_path ?? item.rawLogPath;
      case "metadata":
        return item.metadata;
      default:
        return item[field];
    }
  }

  return item[field];
}

/**
 * Safely projects requested keys into newly instantiated plain objects without mutating source objects.
 */
export function projectFields<T extends Record<string, any>>(
  items: T[],
  fields?: string[] | string | null,
  entityType?: "search" | "session"
): Record<string, any>[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  let requestedFields: string[] = [];
  if (typeof fields === "string") {
    requestedFields = fields
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
  } else if (Array.isArray(fields)) {
    requestedFields = fields
      .map((f) => (typeof f === "string" ? f.trim() : ""))
      .filter(Boolean);
  }

  if (requestedFields.length === 0) {
    if (entityType === "search") {
      requestedFields = DEFAULT_SEARCH_COMPACT_FIELDS;
    } else if (entityType === "session") {
      requestedFields = DEFAULT_SESSION_COMPACT_FIELDS;
    }
  }

  // If still no fields specified (unknown entityType and empty fields), return shallow clone of items
  if (requestedFields.length === 0) {
    return items.map((item) => {
      const clone: Record<string, any> = {};
      for (const [k, v] of Object.entries(item)) {
        if (!FORBIDDEN_PROPERTIES.has(k)) {
          clone[k] = v;
        }
      }
      return clone;
    });
  }

  const whitelist = entityType === "search" ? SEARCH_FIELD_WHITELIST : entityType === "session" ? SESSION_FIELD_WHITELIST : null;
  const validFields: string[] = [];

  for (const f of requestedFields) {
    if (FORBIDDEN_PROPERTIES.has(f)) {
      continue;
    }
    if (whitelist && !whitelist.has(f)) {
      process.stderr.write(`[Chronicle MCP] Warning: Unknown field "${f}" requested in projection and omitted.\n`);
      continue;
    }
    validFields.push(f);
  }

  return items.map((item) => {
    const projected: Record<string, any> = {};
    for (const f of validFields) {
      projected[f] = resolveFieldValue(item, f, entityType);
    }
    return projected;
  });
}