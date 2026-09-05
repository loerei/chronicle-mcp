import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  SessionData,
  TurnData,
  StepData,
  ChunkData,
  SessionRelationshipNode,
  SessionRelationshipResult,
  SessionLifecycle,
  SessionInbox,
  ArtifactDescriptor,
  ToolUsageStatsOptions,
  ToolUsageReport,
  PerToolStat,
  ThrashingTool,
} from "./adapters/types.js";
import {
  vectorToBlob,
  blobToVector,
  cosineSimilarityFloat32,
  EMBEDDING_DIMENSION,
} from "./embeddings.js";
import { getAntigravityAdapter } from "./adapters/Antigravity.js";

// ============================================================
// 1. Interfaces & Option Contracts
// ============================================================

export interface ListSessionsOptions {
  projectPath?: string;
  scope?: "workspace" | "all";
  adapter?: string;
  parentId?: string;
  role?: string;
  hasErrors?: boolean;
  timeRange?: string; // "start:end" epoch ms
  limit?: number;
  offset?: number;
  sortBy?: "active" | "created";
}

export interface GetTurnsOptions {
  turnIndex?: number;
  startTurn?: number;
  endTurn?: number;
  lastTurns?: number;
  includeUndone?: boolean;
  order?: "chronological" | "reverse_chronological";
  limit?: number;
}

export interface GetStepsOptions {
  turnIndex?: number;
  stepIndex?: number;
  category?: "user" | "agent" | "execution" | "system";
  kind?: "mcp" | "command" | "native" | "subagent";
  status?: "DONE" | "ERROR" | "PENDING";
  toolName?: string | string[];
  serverName?: string;
  filePath?: string;
  includeUndone?: boolean;
  limit?: number;
}

export interface VectorSearchResult {
  sessionId: string;
  turnIndex: number;
  title: string;
  role?: string;
  projectPath?: string | null;
  similarity: number;
  userPrompt: string;
  assistantSnippet: string;
  createdAt: number;
}

export interface FTSSearchResult {
  sessionId: string;
  turnIndex: number;
  title: string;
  role?: string;
  projectPath?: string | null;
  rank: number;
  userPrompt: string;
  assistantSnippet: string;
  createdAt: number;
}

export interface SessionEmbeddings {
  summary?: number[];
  chunks: Map<number, number[]>; // maps stepIndex -> chunkVector
}

export type StepCategory =
  | "conversation_steps"
  | "tool_calls"
  | "tool_results"
  | "thinking"
  | "system_events";

export type StepSortMode = "time_old_to_new" | "time_new_to_old" | "category";

export interface QueryOptions {
  sessionId?: string;
  parentId?: string | null;
  adapter?: string;
  projectPath?: string;
  scope?: "workspace" | "all";
  stepIndex?: number;
  startStep?: number;
  endStep?: number;
  stepQuery?: string;
  stepType?: string;
  stepStatus?: string;
  includeSteps?: boolean;
  includeUndone?: boolean;
  limit?: number;
  toolName?: string | string[];
  serverName?: string;
  excludeContent?: boolean;
  timeRange?: string; // Format: "start:end"
  sortBy?: "created" | "active";
  conversationStepsOnly?: boolean;
  reverseSteps?: boolean;
  startConversationStep?: number;
  endConversationStep?: number;
  includeToolResults?: boolean;
  categories?: StepCategory[];
  category?: "user" | "agent" | "execution" | "system";
  kind?: "mcp" | "command" | "native" | "subagent" | null;
  filePath?: string;
  status?: string;
  sort?: StepSortMode;
}

export interface QueryResult {
  sessions: SessionData[];
  steps: StepData[];
  chunks: ChunkData[];
}

export interface SearchResult {
  sessionId: string;
  adapter: string;
  title: string;
  projectPath?: string | null;
  stepIndex: number | null;
  chunkText: string;
  similarity: number;
}

export interface SearchHistoryFilter {
  role?: string;
  hasErrors?: boolean;
  onlySubagents?: boolean;
  onlyUserPrompts?: boolean;
  timeRange?: string; // "start:end"
}

export type VectorInput = Float32Array | Buffer | number[];

export interface HistoryStore {
  saveSession(
    session: SessionData,
    turns?: TurnData[],
    steps?: StepData[]
  ): void;
  getSession(id: string): SessionData | null;
  listSessions(options?: ListSessionsOptions): SessionData[];
  getTurns(sessionId: string, options?: GetTurnsOptions): TurnData[];
  getSteps(sessionId: string, options?: GetStepsOptions): StepData[];
  getStepsForTurns(
    sessionId: string,
    turnIndices: number[],
    options?: GetStepsOptions
  ): Map<number, StepData[]>;
  getSubtreeSessionIds(sessionId: string): string[];
  getSessionRelationship(
    sessionId: string,
    maxDepth?: number,
    includeAncestors?: boolean,
    includeMandate?: boolean
  ): SessionRelationshipResult | null;
  getArtifactDescriptors(
    sessionId: string,
    includeSubtree?: boolean,
    artifactName?: string
  ): ArtifactDescriptor[];
  getArtifacts(
    sessionId: string,
    includeSubtree?: boolean,
    artifactName?: string
  ): string[];
  getToolUsageStats(options?: ToolUsageStatsOptions): ToolUsageReport;
  getSessionLogStats(): Map<string, { logMtime: number; logSize: number }>;
  searchTurnsVector(
    queryVector: VectorInput,
    limit: number,
    options?: {
      projectPath?: string;
      scope?: "workspace" | "all";
      filter?: SearchHistoryFilter;
    }
  ): VectorSearchResult[];
  searchTurnsFTS(
    queryText: string,
    limit: number,
    options?: {
      projectPath?: string;
      scope?: "workspace" | "all";
      filter?: SearchHistoryFilter;
    }
  ): FTSSearchResult[];
  getActiveProjectPath(): string | undefined;
  close(): void;

  /** Transitional compatibility shim */
  save(session: SessionData, embeddings?: SessionEmbeddings): void;
  /** Transitional compatibility shim */
  query(options: QueryOptions): QueryResult;
  /** Transitional compatibility shim */
  search(
    queryVector: number[],
    limit: number,
    options?: { projectPath?: string; scope?: "workspace" | "all" }
  ): SearchResult[];
}

// ============================================================
// 2. Helper Functions
// ============================================================

function normalizeTurnVector(vector?: Float32Array | number[]): Buffer {
  if (!vector || vector.length === 0) {
    return vectorToBlob(new Float32Array(EMBEDDING_DIMENSION));
  }
  if (vector.length === EMBEDDING_DIMENSION) {
    return vectorToBlob(vector);
  }
  const padded = new Float32Array(EMBEDDING_DIMENSION);
  padded.set(vector);
  return vectorToBlob(padded);
}

function normalizeQueryVector(
  queryVector: Float32Array | Buffer | number[]
): Float32Array {
  let floatVec: Float32Array;
  if (queryVector instanceof Float32Array) {
    floatVec = queryVector;
  } else if (Buffer.isBuffer(queryVector)) {
    floatVec = blobToVector(queryVector);
  } else {
    floatVec = new Float32Array(queryVector);
  }

  if (floatVec.length === EMBEDDING_DIMENSION) {
    return floatVec;
  }
  const padded = new Float32Array(EMBEDDING_DIMENSION);
  padded.set(floatVec);
  return padded;
}

function matchInMemoryTurnFilter(
  session: SessionData,
  turn: TurnData,
  resolvedProjectPath: string | undefined,
  filter: SearchHistoryFilter | undefined
): boolean {
  if (
    resolvedProjectPath !== undefined &&
    !session.projectPath?.toLowerCase().includes(resolvedProjectPath.toLowerCase())
  ) {
    return false;
  }

  if (
    filter?.role !== undefined &&
    !session.role?.toLowerCase().includes(filter.role.toLowerCase())
  ) {
    return false;
  }

  if (filter?.onlySubagents === true && !session.parentId) {
    return false;
  }

  const errCount = turn.errorCount ?? 0;
  if (
    (filter?.hasErrors === true && errCount <= 0) ||
    (filter?.hasErrors === false && errCount > 0)
  ) {
    return false;
  }

  if (filter?.timeRange !== undefined) {
    const range = parseTimeRange(filter.timeRange);
    if (range) {
      const turnTime = turn.createdAt ?? session.createdAt;
      if (range.start !== null && turnTime < range.start) return false;
      if (range.end !== null && turnTime > range.end) return false;
    }
  }

  return true;
}

function buildStepFilterClauses(options: GetStepsOptions, sql: string, params: any[]): string {
  if (options.category !== undefined) {
    sql += ` AND category = ?`;
    params.push(options.category);
  }
  if (options.kind !== undefined) {
    sql += ` AND kind = ?`;
    params.push(options.kind);
  }
  if (options.status !== undefined) {
    sql += ` AND status = ?`;
    params.push(options.status);
  }
  if (options.filePath !== undefined) {
    sql += ` AND REPLACE(LOWER(file_path), char(92), '/') LIKE ?`;
    params.push(`%${options.filePath.replaceAll("\\", "/").toLowerCase()}%`);
  }
  if (options.toolName !== undefined) {
    if (Array.isArray(options.toolName)) {
      if (options.toolName.length === 0) {
        sql += ` AND 1 = 0`;
      } else {
        const placeholders = options.toolName.map(() => "?").join(",");
        sql += ` AND tool_name IN (${placeholders})`;
        params.push(...options.toolName);
      }
    } else {
      sql += ` AND tool_name = ?`;
      params.push(options.toolName);
    }
  }
  if (options.serverName !== undefined) {
    sql += ` AND server_name = ?`;
    params.push(options.serverName);
  }
  return sql;
}

function mapRowToStepData(r: any): StepData {
  return {
    stepIndex: r.step_index,
    turnIndex: r.turn_index,
    stepOrder: r.step_order,
    category: r.category,
    kind: r.kind ?? undefined,
    status: r.status,
    content: r.content ?? undefined,
    thinking: r.thinking ?? undefined,
    toolName: r.tool_name ?? undefined,
    serverName: r.server_name ?? undefined,
    filePath: r.file_path ?? undefined,
    exitCode: r.exit_code ?? undefined,
    errorMessage: r.error_message ?? undefined,
    toolArgs: r.tool_args ?? undefined,
    toolResult: r.tool_result ?? undefined,
    toolDurationMs: r.tool_duration_ms ?? undefined,
    subagentSessionId: r.subagent_session_id ?? undefined,
    createdAt: r.created_at,
    isUndone: r.is_undone === 1,
  };
}

function applySqliteTurnFilters(
  resolvedProjectPath: string | undefined,
  filter: SearchHistoryFilter | undefined,
  sql: string,
  params: any[]
): string {
  if (resolvedProjectPath !== undefined) {
    sql += " AND LOWER(s.project_path) LIKE ?";
    params.push(`%${resolvedProjectPath.toLowerCase()}%`);
  }

  if (filter?.role !== undefined) {
    sql += " AND LOWER(s.role) LIKE ?";
    params.push(`%${filter.role.toLowerCase()}%`);
  }

  if (filter?.hasErrors === true) {
    sql += " AND t.error_count > 0";
  } else if (filter?.hasErrors === false) {
    sql += " AND (t.error_count IS NULL OR t.error_count = 0)";
  }

  if (filter?.onlySubagents === true) {
    sql += " AND s.parent_id IS NOT NULL";
  }

  if (filter?.timeRange !== undefined) {
    const range = parseTimeRange(filter.timeRange);
    if (range) {
      if (range.start !== null) {
        sql += " AND t.created_at >= ?";
        params.push(range.start);
      }
      if (range.end !== null) {
        sql += " AND t.created_at <= ?";
        params.push(range.end);
      }
    }
  }

  return sql;
}

function buildToolUsageReport(
  tools: PerToolStat[],
  thrashingTools: ThrashingTool[],
  totalCalls: number,
  totalErrors: number
): ToolUsageReport {
  const overallFailureRate =
    totalCalls > 0 ? Math.round((totalErrors * 1000.0) / totalCalls) / 10.0 : 0.0;

  return {
    summary: {
      totalCalls,
      totalErrors,
      overallFailureRate,
    },
    tools,
    thrashingTools,
  };
}

/**
 * Sanitizes and formats a raw text string into a safe SQLite FTS5 MATCH expression.
 * Escapes internal quotes, strips empty tokens, and supports column-group isolation.
 */
export function sanitizeFts5Query(queryText: string, onlyUserPrompts = false): string | null {
  if (!queryText || queryText.trim().length === 0) {
    return null;
  }
  const tokens = queryText
    .replace(/[^\p{L}\p{N}_\-./:\\]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    return null;
  }

  const quotedTokens = tokens.map((token) => `"${token.replaceAll('"', '""')}"`);

  if (onlyUserPrompts) {
    return `user_prompt : ( ${quotedTokens.join(" ")} )`;
  }
  return quotedTokens.join(" ");
}

export function matchToolCall(
  call: any,
  targetServer?: string,
  targetTool?: string | string[]
): boolean {
  const name = call.name || "";
  let callServer = "";
  let callTool = "";

  if (name === "call_mcp_tool" && call.args) {
    callServer = call.args.ServerName || "";
    callTool = call.args.ToolName || "";
  } else {
    const parts = name.split("/");
    if (parts.length === 2) {
      callServer = parts[0];
      callTool = parts[1];
    } else {
      callTool = name;
    }
  }

  let matchesTool = true;
  let matchesServer = true;

  if (targetTool !== undefined) {
    if (Array.isArray(targetTool)) {
      matchesTool = targetTool.some(
        (t) =>
          callTool === t ||
          callTool.endsWith("/" + t) ||
          name === t ||
          name.endsWith("/" + t)
      );
    } else {
      matchesTool =
        callTool === targetTool ||
        callTool.endsWith("/" + targetTool) ||
        name === targetTool ||
        name.endsWith("/" + targetTool);
    }
  }
  if (targetServer !== undefined) {
    matchesServer =
      callServer === targetServer ||
      name.startsWith(targetServer + "/") ||
      name.includes("_" + targetServer + "_");
  }

  return matchesTool && matchesServer;
}

export function parseTimeRange(
  timeRange: string
): { start: number | null; end: number | null } | null {
  const parts = timeRange.split(":");
  if (parts.length !== 2) return null;
  const parseVal = (val: string): number | null => {
    const trimmed = val.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const num = Number.parseInt(trimmed, 10);
      if (num >= 1000000000 && num <= 9999999999) {
        return num * 1000;
      }
      return num;
    }
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) {
      return date.getTime();
    }
    return null;
  };
  return {
    start: parseVal(parts[0]),
    end: parseVal(parts[1]),
  };
}

export function isConversationStep(step: StepData): boolean {
  if (step.category === "user" || step.type === "USER_INPUT") return true;
  return !!(
    (step.category === "agent" || step.type === "PLANNER_RESPONSE") &&
    step.content?.trim()
  );
}

export function matchStepCategory(
  step: StepData,
  categories: StepCategory[]
): boolean {
  if (categories.includes("conversation_steps") && isConversationStep(step))
    return true;
  if (
    categories.includes("tool_calls") &&
    (step.toolName || step.toolCalls || step.category === "execution")
  )
    return true;
  if (
    categories.includes("tool_results") &&
    (step.kind === "mcp" ||
      step.kind === "command" ||
      step.type === "MCP_TOOL" ||
      step.type === "COMMAND" ||
      step.source === "SYSTEM" ||
      step.toolResult)
  )
    return true;
  if (
    categories.includes("thinking") &&
    step.thinking &&
    step.thinking.trim() !== ""
  )
    return true;
  if (
    categories.includes("system_events") &&
    (step.category === "system" ||
      step.type === "CHECKPOINT" ||
      step.status === "ERROR" ||
      step.kind === "subagent" ||
      step.type === "INVOKE_SUBAGENT" ||
      step.source === "SYSTEM")
  )
    return true;
  return false;
}

// ============================================================
// 3. Database Initialization & DDL
// ============================================================

const DB_DIR = path.join(os.homedir(), ".config", "chronicle-mcp");
const DB_PATH = path.join(DB_DIR, "history.db");

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

let dbInstance: DatabaseSync | null = null;

export function setDb(db: DatabaseSync): void {
  dbInstance = db;
}

let storeInstance: HistoryStore | null = null;

export function setStore(store: HistoryStore): void {
  storeInstance = store;
}

export function getStore(): HistoryStore {
  if (storeInstance) {
    return storeInstance;
  }
  storeInstance = new SqliteHistoryStore(DB_PATH);
  return storeInstance;
}

export function initDatabaseSchema(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      adapter TEXT NOT NULL,
      title TEXT NOT NULL,
      role TEXT,
      project_path TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      parent_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      root_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      depth INTEGER DEFAULT 0,
      total_turns INTEGER DEFAULT 0,
      total_steps INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      artifacts TEXT,
      files_touched TEXT,
      first_prompt TEXT,
      metadata TEXT,
      log_mtime INTEGER,
      log_size INTEGER,
      lifecycle_status TEXT,
      has_turn_completion INTEGER DEFAULT 1,
      last_step_index INTEGER,
      last_tool_executed TEXT
    );
  `);

  try {
    const tableInfo = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const columnNames = new Set(tableInfo.map((col) => col.name));
    const requiredColumns: Record<string, string> = {
      root_id: "TEXT REFERENCES sessions(id) ON DELETE SET NULL",
      role: "TEXT",
      depth: "INTEGER DEFAULT 0",
      total_turns: "INTEGER DEFAULT 0",
      total_steps: "INTEGER DEFAULT 0",
      total_tokens: "INTEGER DEFAULT 0",
      artifacts: "TEXT",
      files_touched: "TEXT",
      metadata: "TEXT",
      log_mtime: "INTEGER",
      log_size: "INTEGER",
      lifecycle_status: "TEXT",
      has_turn_completion: "INTEGER DEFAULT 1",
      last_step_index: "INTEGER",
      last_tool_executed: "TEXT",
    };

    for (const [colName, colDef] of Object.entries(requiredColumns)) {
      if (!columnNames.has(colName)) {
        try {
          db.exec(`ALTER TABLE sessions ADD COLUMN ${colName} ${colDef};`);
        } catch (e: any) {
          console.error(`[Chronicle MCP] Failed to add column "${colName}" during database auto-migration:`, e?.message || e);
        }
      }
    }
  } catch (e: any) {
    console.error("[Chronicle MCP] Database schema verification failed:", e?.message || e);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_root ON sessions(root_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_role ON sessions(role);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
    CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(last_active_at DESC);

    CREATE TABLE IF NOT EXISTS transcript_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_index INTEGER NOT NULL,
      user_prompt TEXT NOT NULL,
      assistant_response TEXT,
      turn_summary TEXT,
      turn_text TEXT NOT NULL,
      turn_vector BLOB NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      thinking_tokens INTEGER DEFAULT 0,
      tool_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      is_undone INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, turn_index, is_undone) ON CONFLICT REPLACE
    );

    CREATE INDEX IF NOT EXISTS idx_turns_session ON transcript_turns(session_id, turn_index);
    CREATE INDEX IF NOT EXISTS idx_turns_undone ON transcript_turns(session_id, is_undone);
    CREATE INDEX IF NOT EXISTS idx_turns_errors ON transcript_turns(session_id, error_count);

    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_turns_fts USING fts5(
      user_prompt,
      assistant_response,
      turn_text,
      content='transcript_turns',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS trg_turns_ai AFTER INSERT ON transcript_turns BEGIN
      INSERT INTO transcript_turns_fts(rowid, user_prompt, assistant_response, turn_text)
      VALUES (new.id, new.user_prompt, new.assistant_response, new.turn_text);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_turns_ad AFTER DELETE ON transcript_turns BEGIN
      INSERT INTO transcript_turns_fts(transcript_turns_fts, rowid, user_prompt, assistant_response, turn_text)
      VALUES ('delete', old.id, old.user_prompt, old.assistant_response, old.turn_text);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_turns_au AFTER UPDATE ON transcript_turns BEGIN
      INSERT INTO transcript_turns_fts(transcript_turns_fts, rowid, user_prompt, assistant_response, turn_text)
      VALUES ('delete', old.id, old.user_prompt, old.assistant_response, old.turn_text);
      INSERT INTO transcript_turns_fts(rowid, user_prompt, assistant_response, turn_text)
      VALUES (new.id, new.user_prompt, new.assistant_response, new.turn_text);
    END;

    CREATE TABLE IF NOT EXISTS transcript_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_index INTEGER NOT NULL,
      step_index INTEGER NOT NULL,
      step_order INTEGER NOT NULL,
      category TEXT NOT NULL,
      kind TEXT,
      status TEXT NOT NULL,
      content TEXT,
      thinking TEXT,
      tool_name TEXT,
      server_name TEXT,
      file_path TEXT,
      exit_code INTEGER,
      error_message TEXT,
      tool_args TEXT,
      tool_result TEXT,
      tool_duration_ms INTEGER,
      subagent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      is_undone INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_steps_session_turn ON transcript_steps(session_id, turn_index, step_order);
    CREATE INDEX IF NOT EXISTS idx_steps_category ON transcript_steps(session_id, category);
    CREATE INDEX IF NOT EXISTS idx_steps_tool ON transcript_steps(tool_name, server_name);
    CREATE INDEX IF NOT EXISTS idx_steps_filepath ON transcript_steps(file_path);
    CREATE INDEX IF NOT EXISTS idx_steps_status ON transcript_steps(session_id, status);
    CREATE INDEX IF NOT EXISTS idx_steps_subagent ON transcript_steps(subagent_session_id);
  `);
}

export function getDb(): DatabaseSync {
  if (dbInstance) {
    return dbInstance;
  }

  const db = new DatabaseSync(DB_PATH);
  initDatabaseSchema(db);
  dbInstance = db;
  return db;
}

// ============================================================
// 4. In-Memory History Store (Test Double & Cache)
// ============================================================

export class InMemoryHistoryStore implements HistoryStore {
  private readonly sessionsMap = new Map<string, SessionData>();
  private readonly turnsMap = new Map<string, TurnData[]>();
  private readonly stepsMap = new Map<string, StepData[]>();

  saveSession(
    session: SessionData,
    turns?: TurnData[],
    steps?: StepData[]
  ): void {
    const safeSteps = steps || session.steps || [];
    const existing = this.sessionsMap.get(session.id);

    let effectiveParentId = session.parentId || null;
    if (!effectiveParentId && existing?.parentId) {
      const pCheck = this.sessionsMap.get(existing.parentId);
      if (pCheck && pCheck.createdAt <= (session.createdAt ?? Date.now())) {
        effectiveParentId = existing.parentId;
      }
    }
    if (effectiveParentId === session.id || session.rootId === session.id) {
      effectiveParentId = null;
    }

    const parent = effectiveParentId ? this.sessionsMap.get(effectiveParentId) : undefined;
    let resolvedDepth = session.depth && session.depth > 0 ? session.depth : 0;
    if (!resolvedDepth) {
      resolvedDepth = parent ? (parent.depth ?? 0) + 1 : (existing?.depth ?? 0);
    }
    const resolvedRootId = session.rootId || parent?.rootId || parent?.id || effectiveParentId || existing?.rootId || null;

    let title = session.title ?? existing?.title ?? "Untitled Session";
    if (existing?.title) {
      const isGeneric = (t: string) => t.startsWith("Session ") || t.startsWith("Untitled") || t.startsWith("Unknown") || t === "";
      if (isGeneric(title) && !isGeneric(existing.title)) {
        title = existing.title;
      }
    }

    const effectiveArtifacts = session.artifacts && session.artifacts.length > 0 ? session.artifacts : (existing?.artifacts || []);
    const effectiveFilesTouched = session.filesTouched && session.filesTouched.length > 0 ? session.filesTouched : (existing?.filesTouched || []);
    const effectiveMetadata = session.metadata && Object.keys(session.metadata).length > 0 ? session.metadata : (existing?.metadata || {});
    const effectiveFirstPrompt = session.firstPrompt && session.firstPrompt !== "" ? session.firstPrompt : (existing?.firstPrompt || "");
    const effectiveRole = session.role ?? existing?.role ?? undefined;
    const effectiveProjectPath = session.projectPath ?? existing?.projectPath ?? null;
    const effectiveLogMtime = session.logMtime ?? existing?.logMtime ?? undefined;
    const effectiveLogSize = session.logSize ?? existing?.logSize ?? undefined;

    const stepTimestamps = safeSteps
      .map((s) => s.createdAt)
      .filter((t): t is number => t !== undefined);
    const lastActiveAt =
      stepTimestamps.length > 0
        ? Math.max(...stepTimestamps)
        : session.lastActiveAt ?? session.createdAt ?? Date.now();

    const totalTurns = turns ? turns.length : (session.totalTurns ?? existing?.totalTurns ?? 0);
    const totalSteps = steps ? steps.length : (session.totalSteps ?? existing?.totalSteps ?? safeSteps.length);

    let effectiveTurns: TurnData[] = [];
    if (turns) {
      effectiveTurns = turns.map((t) => ({ ...t }));
    } else if (existing?.turns) {
      effectiveTurns = [...existing.turns];
    }

    let effectiveSteps: StepData[] = [];
    if (steps) {
      effectiveSteps = steps.map((s) => ({ ...s }));
    } else if (existing?.steps) {
      effectiveSteps = [...existing.steps];
    }

    const sessionCopy: SessionData = {
      ...session,
      title,
      role: effectiveRole,
      projectPath: effectiveProjectPath,
      parentId: effectiveParentId,
      rootId: resolvedRootId,
      depth: resolvedDepth,
      createdAt: session.createdAt ?? existing?.createdAt ?? Date.now(),
      lastActiveAt,
      totalTurns,
      totalSteps,
      totalTokens: session.totalTokens ?? existing?.totalTokens ?? 0,
      artifacts: [...effectiveArtifacts],
      filesTouched: [...effectiveFilesTouched],
      firstPrompt: effectiveFirstPrompt,
      metadata: { ...effectiveMetadata },
      logMtime: effectiveLogMtime,
      logSize: effectiveLogSize,
      lifecycle: session.lifecycle ?? existing?.lifecycle,
      turns: effectiveTurns,
      steps: effectiveSteps,
    };
    this.sessionsMap.set(session.id, sessionCopy);

    if (turns) {
      this.turnsMap.set(
        session.id,
        turns.map((t) => {
          let vec: Float32Array;
          if (!t.turnVector || t.turnVector.length === 0) {
            vec = new Float32Array(EMBEDDING_DIMENSION);
          } else if (t.turnVector.length === EMBEDDING_DIMENSION) {
            vec =
              t.turnVector instanceof Float32Array
                ? new Float32Array(t.turnVector)
                : Float32Array.from(t.turnVector);
          } else {
            vec = new Float32Array(EMBEDDING_DIMENSION);
            vec.set(t.turnVector);
          }
          return {
            ...t,
            turnVector: vec,
          };
        })
      );
    }

    if (steps) {
      this.stepsMap.set(
        session.id,
        steps.map((s) => ({ ...s }))
      );
    }

    const referencedChildIds = new Set<string>([
      ...(Array.isArray(session.subagentIds) ? session.subagentIds : []),
      ...safeSteps.filter((st: any) => st?.subagentSessionId).map((st: any) => st.subagentSessionId as string),
    ]);
    for (const childId of referencedChildIds) {
      if (childId && childId !== session.id) {
        let child = this.sessionsMap.get(childId);
        if (!child) {
          child = {
            id: childId,
            adapter: session.adapter || "unknown",
            title: "Unknown Subagent",
            createdAt: session.createdAt || Date.now(),
            lastActiveAt: session.lastActiveAt || Date.now(),
            firstPrompt: "",
            parentId: session.id,
            rootId: resolvedRootId || session.id,
            depth: resolvedDepth + 1,
          };
          this.sessionsMap.set(childId, child);
        } else {
          child.parentId = child.parentId || session.id;
          child.rootId = child.rootId || resolvedRootId || session.id;
          if ((child.depth ?? 0) === 0 && resolvedDepth + 1 > 0) {
            child.depth = resolvedDepth + 1;
          }
        }
      }
    }

    const updateDescendants = (parentId: string, newRoot: string, curDepth: number) => {
      if (curDepth >= 20) return;
      for (const s of this.sessionsMap.values()) {
        if (s.parentId === parentId && s.id !== parentId) {
          s.rootId = newRoot;
          s.depth = curDepth + 1;
          updateDescendants(s.id, newRoot, curDepth + 1);
        }
      }
    };
    updateDescendants(session.id, resolvedRootId || session.id, resolvedDepth);
  }

  getSessionLogStats(): Map<string, { logMtime: number; logSize: number }> {
    const result = new Map<string, { logMtime: number; logSize: number }>();
    for (const [id, s] of this.sessionsMap.entries()) {
      if (s.logMtime !== undefined && s.logSize !== undefined) {
        result.set(id, { logMtime: s.logMtime, logSize: s.logSize });
      }
    }
    return result;
  }

  getSession(id: string): SessionData | null {
    if (!id || typeof id !== "string") return null;
    let session = this.sessionsMap.get(id);
    const cleanId = id.trim().toLowerCase();
    if (!session) {
      session = this.sessionsMap.get(cleanId);
    }
    if (!session) {
      for (const [sId, s] of this.sessionsMap.entries()) {
        if (sId.toLowerCase() === cleanId) {
          session = s;
          break;
        }
      }
    }
    if (!session && cleanId.length >= 6) {
      const matches: SessionData[] = [];
      for (const [sId, s] of this.sessionsMap.entries()) {
        if (sId.toLowerCase().startsWith(cleanId)) {
          matches.push(s);
        }
      }
      if (matches.length > 0) {
        matches.sort((a, b) => {
          const aTime = a.lastActiveAt ?? a.createdAt ?? 0;
          const bTime = b.lastActiveAt ?? b.createdAt ?? 0;
          if (bTime !== aTime) return bTime - aTime;
          return (b.createdAt ?? 0) - (a.createdAt ?? 0);
        });
        session = matches[0];
      }
    }
    if (!session) return null;

    const actualId = session.id;
    return {
      ...session,
      turns: this.getTurns(actualId, { includeUndone: true }),
      steps: this.getSteps(actualId, { includeUndone: true }),
    };
  }

  listSessions(options: ListSessionsOptions = {}): SessionData[] {
    let sessions = Array.from(this.sessionsMap.values());

    if (options.adapter !== undefined) {
      sessions = sessions.filter((s) => s.adapter === options.adapter);
    }

    if (options.parentId !== undefined) {
      if (options.parentId === "root" || options.parentId === "null") {
        sessions = sessions.filter((s) => !s.parentId);
      } else {
        sessions = sessions.filter((s) => s.parentId === options.parentId);
      }
    }

    if (options.role !== undefined) {
      sessions = sessions.filter((s) => s.role === options.role);
    }

    let resolvedProjectPath = options.projectPath;
    if (resolvedProjectPath === undefined && options.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    if (resolvedProjectPath !== undefined) {
      const pathFilter = resolvedProjectPath.toLowerCase();
      sessions = sessions.filter((s) =>
        s.projectPath?.toLowerCase().includes(pathFilter)
      );
    }

    if (options.hasErrors === true) {
      sessions = sessions.filter((s) => {
        const turns = this.turnsMap.get(s.id) || [];
        return turns.some((t) => (t.errorCount ?? 0) > 0);
      });
    } else if (options.hasErrors === false) {
      sessions = sessions.filter((s) => {
        const turns = this.turnsMap.get(s.id) || [];
        return !turns.some((t) => (t.errorCount ?? 0) > 0);
      });
    }

    if (options.timeRange !== undefined) {
      const range = parseTimeRange(options.timeRange);
      if (range) {
        sessions = sessions.filter((s) => {
          const activeTime = s.lastActiveAt ?? s.createdAt;
          if (range.start !== null && activeTime < range.start) return false;
          if (range.end !== null && activeTime > range.end) return false;
          return true;
        });
      }
    }

    const sortBy = options.sortBy || "active";
    sessions.sort((a, b) => {
      const timeA = sortBy === "created" ? a.createdAt : (a.lastActiveAt ?? a.createdAt);
      const timeB = sortBy === "created" ? b.createdAt : (b.lastActiveAt ?? b.createdAt);
      return timeB - timeA;
    });

    let limit: number | undefined;
    if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
      limit = Math.max(1, Math.floor(options.limit));
    } else if (options.offset !== undefined) {
      limit = 10;
    }

    const offset =
      typeof options.offset === "number" && Number.isFinite(options.offset)
        ? Math.max(0, Math.floor(options.offset))
        : 0;

    if (offset > 0) {
      sessions = sessions.slice(offset);
    }
    if (limit !== undefined) {
      sessions = sessions.slice(0, limit);
    }

    return sessions.map((s) => ({
      ...s,
      errorCount: (this.turnsMap.get(s.id) || []).reduce((acc, t) => acc + (t.errorCount || 0), 0),
    }));
  }

  private resolveActualSessionId(id: string): string {
    if (!id || typeof id !== "string") return id;
    if (this.sessionsMap.has(id)) return id;
    const cleanId = id.trim().toLowerCase();
    for (const sid of this.sessionsMap.keys()) {
      if (sid.toLowerCase() === cleanId || (cleanId.length >= 6 && sid.toLowerCase().startsWith(cleanId))) {
        return sid;
      }
    }
    return id;
  }

  getTurns(sessionId: string, options: GetTurnsOptions = {}): TurnData[] {
    const resolvedSessionId = this.resolveActualSessionId(sessionId);
    let turns = (this.turnsMap.get(resolvedSessionId) || []).map((t) => ({ ...t }));

    if (!options.includeUndone) {
      turns = turns.filter((t) => !t.isUndone);
    }

    const maxTurnIndex = turns.length > 0 ? Math.max(...turns.map((t) => t.turnIndex)) : 0;

    let targetTurn = options.turnIndex;
    if (targetTurn !== undefined && targetTurn < 0) {
      targetTurn = maxTurnIndex + 1 + targetTurn;
    }

    let startTurn = options.startTurn;
    if (startTurn !== undefined && startTurn < 0) {
      startTurn = maxTurnIndex + 1 + startTurn;
    }

    let endTurn = options.endTurn;
    if (endTurn !== undefined && endTurn < 0) {
      endTurn = maxTurnIndex + 1 + endTurn;
    }

    if (targetTurn !== undefined) {
      turns = turns.filter((t) => t.turnIndex === targetTurn);
    }
    if (startTurn !== undefined) {
      turns = turns.filter((t) => t.turnIndex >= startTurn!);
    }
    if (endTurn !== undefined) {
      turns = turns.filter((t) => t.turnIndex <= endTurn!);
    }

    turns.sort((a, b) => a.turnIndex - b.turnIndex);

    if (options.lastTurns !== undefined && options.lastTurns > 0) {
      turns = turns.slice(-options.lastTurns);
    }

    if (options.order === "reverse_chronological") {
      turns.reverse();
    }

    if (options.limit !== undefined) {
      turns = turns.slice(0, options.limit);
    }

    return turns;
  }

  getSteps(sessionId: string, options: GetStepsOptions = {}): StepData[] {
    const resolvedSessionId = this.resolveActualSessionId(sessionId);
    let steps = (this.stepsMap.get(resolvedSessionId) || []).map((s) => ({ ...s }));

    if (!options.includeUndone) {
      steps = steps.filter((s) => !s.isUndone);
    }

    if (options.turnIndex !== undefined) {
      const turns = this.turnsMap.get(resolvedSessionId) || [];
      const maxTurn = turns.length > 0 ? Math.max(...turns.map((t) => t.turnIndex)) : 0;
      const resolvedTurn =
        options.turnIndex < 0 ? maxTurn + 1 + options.turnIndex : options.turnIndex;
      steps = steps.filter((s) => s.turnIndex === resolvedTurn);
    }

    if (options.stepIndex !== undefined) {
      steps = steps.filter((s) => s.stepIndex === options.stepIndex);
    }
    if (options.category !== undefined) {
      steps = steps.filter((s) => s.category === options.category);
    }
    if (options.kind !== undefined) {
      steps = steps.filter((s) => s.kind === options.kind);
    }
    if (options.status !== undefined) {
      steps = steps.filter((s) => s.status === options.status);
    }
    if (options.filePath !== undefined) {
      const fp = options.filePath.replaceAll("\\", "/").toLowerCase();
      steps = steps.filter((s) => s.filePath?.replaceAll("\\", "/").toLowerCase().includes(fp));
    }
    if (options.toolName !== undefined || options.serverName !== undefined) {
      steps = steps.filter((s) => {
        if (options.toolName !== undefined) {
          if (!s.toolName) return false;
          if (Array.isArray(options.toolName)) {
            if (options.toolName.length === 0 || !options.toolName.includes(s.toolName)) return false;
          } else if (s.toolName !== options.toolName) {
            return false;
          }
        }
        if (options.serverName !== undefined) {
          if (!s.serverName || s.serverName !== options.serverName) return false;
        }
        return true;
      });
    }

    steps.sort((a, b) => {
      const turnDiff = (a.turnIndex ?? 0) - (b.turnIndex ?? 0);
      if (turnDiff !== 0) return turnDiff;
      return (a.stepOrder ?? a.stepIndex) - (b.stepOrder ?? b.stepIndex);
    });

    if (options.limit !== undefined) {
      steps = steps.slice(0, options.limit);
    }

    return steps;
  }

  getStepsForTurns(
    sessionId: string,
    turnIndices: number[],
    options: GetStepsOptions = {}
  ): Map<number, StepData[]> {
    const result = new Map<number, StepData[]>();
    if (!turnIndices || turnIndices.length === 0) {
      return result;
    }
    const turnIndexSet = new Set(turnIndices);
    for (const tIdx of turnIndexSet) {
      result.set(tIdx, []);
    }
    const allSteps = this.getSteps(sessionId, options);
    for (const step of allSteps) {
      if (step.turnIndex !== undefined && turnIndexSet.has(step.turnIndex)) {
        result.get(step.turnIndex)!.push(step);
      }
    }
    return result;
  }

  getSubtreeSessionIds(sessionId: string): string[] {
    const visited = new Set<string>();
    const gather = (id: string, depth: number) => {
      if (depth > 10 || visited.has(id)) return;
      visited.add(id);
      const children = Array.from(this.sessionsMap.values()).filter(
        (s) => s.parentId === id
      );
      for (const child of children) {
        gather(child.id, depth + 1);
      }
    };
    gather(sessionId, 0);
    return Array.from(visited);
  }

  getSessionRelationship(
    sessionId: string,
    maxDepth = 3,
    includeAncestors = true,
    includeMandate = false
  ): SessionRelationshipResult | null {
    const currentSession = this.sessionsMap.get(sessionId);
    if (!currentSession) return null;

    const effectiveMaxDepth = Math.min(Math.max(1, maxDepth || 3), 10);

    const buildNode = (
      s: SessionData,
      currentDepth: number,
      visited: Set<string>
    ): SessionRelationshipNode => {
      const turns = this.turnsMap.get(s.id) || [];
      const node: SessionRelationshipNode = {
        id: s.id,
        adapter: s.adapter,
        title: s.title,
        role: s.role,
        projectPath: s.projectPath,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        parentId: s.parentId,
        rootId: s.rootId,
        depth: currentDepth,
        totalTurns: turns.length,
        ...(includeMandate && s.firstPrompt ? { mandate: s.firstPrompt } : {}),
        artifacts: s.artifacts ? [...s.artifacts] : [],
        lifecycle: s.lifecycle || { status: "completed", hasTurnCompletion: true },
      };
      if (s.adapter === "antigravity") {
        node.inbox = getAntigravityAdapter().getInbox(s.id);
      }

      if (currentDepth < effectiveMaxDepth) {
        const directChildren = Array.from(this.sessionsMap.values()).filter(
          (cand) => cand.parentId === s.id && !visited.has(cand.id)
        );
        if (directChildren.length > 0) {
          node.children = directChildren.map((c) => {
            const branchVisited = new Set(visited);
            branchVisited.add(c.id);
            return buildNode(c, currentDepth + 1, branchVisited);
          });
        }
      }
      return node;
    };

    const ancestors: SessionRelationshipNode[] = [];
    let rootSessionId = currentSession.id;

    if (includeAncestors) {
      let curParentId = currentSession.parentId;
      let depthCounter = 1;
      const ancVisited = new Set<string>([currentSession.id]);
      while (curParentId && depthCounter <= 10 && !ancVisited.has(curParentId)) {
        ancVisited.add(curParentId);
        const pSession = this.sessionsMap.get(curParentId);
        if (!pSession) break;
        ancestors.unshift({
          id: pSession.id,
          adapter: pSession.adapter,
          title: pSession.title,
          role: pSession.role,
          projectPath: pSession.projectPath,
          createdAt: pSession.createdAt,
          lastActiveAt: pSession.lastActiveAt,
          parentId: pSession.parentId,
          rootId: pSession.rootId,
          depth: depthCounter,
          ...(includeMandate && pSession.firstPrompt ? { mandate: pSession.firstPrompt } : {}),
          artifacts: pSession.artifacts ? [...pSession.artifacts] : [],
          lifecycle: pSession.lifecycle || { status: "completed", hasTurnCompletion: true },
          inbox: pSession.adapter === "antigravity" ? getAntigravityAdapter().getInbox(pSession.id) : undefined,
        });
        rootSessionId = pSession.id;
        curParentId = pSession.parentId;
        depthCounter++;
      }
    }

    const parentNode =
      currentSession.parentId && this.sessionsMap.get(currentSession.parentId)
        ? buildNode(this.sessionsMap.get(currentSession.parentId)!, 0, new Set([currentSession.id, currentSession.parentId]))
        : null;

    const visitedRoot = new Set<string>([currentSession.id]);
    const directChildren = Array.from(this.sessionsMap.values()).filter(
      (s) => s.parentId === currentSession.id
    );
    const childrenNodes = directChildren.map((c) => {
      const branchVisited = new Set(visitedRoot);
      branchVisited.add(c.id);
      return buildNode(c, 1, branchVisited);
    });

    const siblings = currentSession.parentId
      ? Array.from(this.sessionsMap.values())
          .filter((s) => s.parentId === currentSession.parentId && s.id !== currentSession.id)
          .map((s) => buildNode(s, 0, new Set([s.id])))
      : [];

    const currentNode = buildNode(currentSession, 0, visitedRoot);
    delete currentNode.children;

    return {
      sessionId: currentSession.id,
      rootSessionId,
      parent: parentNode,
      ancestors,
      current: currentNode,
      children: childrenNodes,
      siblings,
    };
  }

  getArtifactDescriptors(
    sessionId: string,
    includeSubtree = false,
    artifactName?: string
  ): ArtifactDescriptor[] {
    const session = this.sessionsMap.get(sessionId);
    if (!session) return [];

    const descriptors: ArtifactDescriptor[] = [];
    const filterName = artifactName ? artifactName.toLowerCase() : undefined;

    const addArtifacts = (s: SessionData) => {
      if (s.artifacts) {
        for (const a of s.artifacts) {
          if (!filterName || a.toLowerCase().includes(filterName)) {
            descriptors.push({ sessionId: s.id, filename: a });
          }
        }
      }
    };

    addArtifacts(session);

    if (includeSubtree) {
      const subtreeIds = this.getSubtreeSessionIds(sessionId);
      for (const subId of subtreeIds) {
        if (subId !== sessionId) {
          const subSession = this.sessionsMap.get(subId);
          if (subSession) {
            addArtifacts(subSession);
          }
        }
      }
    }

    return descriptors;
  }

  getArtifacts(
    sessionId: string,
    includeSubtree = false,
    artifactName?: string
  ): string[] {
    const descriptors = this.getArtifactDescriptors(sessionId, includeSubtree, artifactName);
    return Array.from(new Set(descriptors.map((d) => d.filename)));
  }

  getToolUsageStats(options: ToolUsageStatsOptions = {}): ToolUsageReport {
    const matchingSessions = this.listSessions({
      projectPath: options.projectPath,
      scope: options.scope,
      timeRange: options.timeRange,
      limit: options.limit ?? 30,
    });

    const sessionIds = new Set(matchingSessions.map((s) => s.id));
    const statsMap = new Map<
      string,
      {
        serverName: string;
        toolName: string;
        totalCalls: number;
        errorCount: number;
        successCount: number;
        totalDurationMs: number;
        durationCalls: number;
      }
    >();

    const thrashMap = new Map<
      string,
      {
        sessionId: string;
        turnIndex: number;
        serverName: string;
        toolName: string;
        consecutiveFailures: number;
        sampleError?: string;
      }
    >();

    let totalCalls = 0;
    let totalErrors = 0;

    for (const sid of sessionIds) {
      const steps = this.stepsMap.get(sid) || [];
      for (const step of steps) {
        if (step.isUndone || step.category !== "execution" || !step.toolName) {
          continue;
        }

        totalCalls++;
        const sName = step.serverName || "native";
        const tName = step.toolName || "unknown";
        const key = `${sName}::${tName}`;

        let entry = statsMap.get(key);
        if (!entry) {
          entry = {
            serverName: sName,
            toolName: tName,
            totalCalls: 0,
            errorCount: 0,
            successCount: 0,
            totalDurationMs: 0,
            durationCalls: 0,
          };
          statsMap.set(key, entry);
        }

        entry.totalCalls++;
        if (step.status === "ERROR") {
          totalErrors++;
          entry.errorCount++;

          const thrashKey = `${sid}::${step.turnIndex ?? 1}::${sName}::${tName}`;
          let thrash = thrashMap.get(thrashKey);
          if (!thrash) {
            thrash = {
              sessionId: sid,
              turnIndex: step.turnIndex ?? 1,
              serverName: sName,
              toolName: tName,
              consecutiveFailures: 0,
              sampleError: (step.errorMessage || "").slice(0, 500),
            };
            thrashMap.set(thrashKey, thrash);
          }
          thrash.consecutiveFailures++;
          if (step.errorMessage && !thrash.sampleError) {
            thrash.sampleError = step.errorMessage.slice(0, 500);
          }
        } else if (step.status === "DONE") {
          entry.successCount++;
        }

        if (typeof step.toolDurationMs === "number" && step.toolDurationMs >= 0) {
          entry.totalDurationMs += step.toolDurationMs;
          entry.durationCalls++;
        }
      }
    }

    const tools: PerToolStat[] = Array.from(statsMap.values())
      .map((e) => ({
        serverName: e.serverName,
        toolName: e.toolName,
        totalCalls: e.totalCalls,
        errorCount: e.errorCount,
        successCount: e.successCount,
        failureRate:
          e.totalCalls > 0
            ? Math.round((e.errorCount * 1000.0) / e.totalCalls) / 10.0
            : 0.0,
        avgDurationMs:
          e.durationCalls > 0
            ? Math.round((e.totalDurationMs * 10.0) / e.durationCalls) / 10.0
            : 0.0,
      }))
      .sort((a, b) => b.totalCalls - a.totalCalls);

    const thrashingTools: ThrashingTool[] = Array.from(thrashMap.values())
      .filter((t) => t.consecutiveFailures >= 3)
      .sort((a, b) => b.consecutiveFailures - a.consecutiveFailures);

    return buildToolUsageReport(tools, thrashingTools, totalCalls, totalErrors);
  }

  searchTurnsVector(
    queryVector: VectorInput,
    limit: number,
    options: {
      projectPath?: string;
      scope?: "workspace" | "all";
      filter?: SearchHistoryFilter;
    } = {}
  ): VectorSearchResult[] {
    const floatVec = normalizeQueryVector(queryVector);

    let resolvedProjectPath = options.projectPath;
    if (resolvedProjectPath === undefined && options.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    const results: VectorSearchResult[] = [];

    for (const [sid, turns] of this.turnsMap.entries()) {
      const session = this.sessionsMap.get(sid);
      if (!session) continue;

      for (const turn of turns) {
        if (turn.isUndone || !turn.turnVector) continue;
        if (!matchInMemoryTurnFilter(session, turn, resolvedProjectPath, options.filter)) {
          continue;
        }

        const tVec =
          turn.turnVector instanceof Float32Array
            ? turn.turnVector
            : Float32Array.from(turn.turnVector as number[]);
        const similarity = cosineSimilarityFloat32(floatVec, tVec);
        const safeSimilarity = Number.isNaN(similarity) ? 0 : similarity;

        results.push({
          sessionId: sid,
          turnIndex: turn.turnIndex,
          title: session.title,
          role: session.role,
          projectPath: session.projectPath,
          similarity: safeSimilarity,
          userPrompt: (turn.userPrompt || "").slice(0, 500),
          assistantSnippet: (turn.assistantResponse || "").slice(0, 200),
          createdAt: turn.createdAt ?? session.createdAt,
        });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  searchTurnsFTS(
    queryText: string,
    limit: number,
    options: {
      projectPath?: string;
      scope?: "workspace" | "all";
      filter?: SearchHistoryFilter;
    } = {}
  ): FTSSearchResult[] {
    const query = queryText.toLowerCase();
    if (!query || query.trim().length === 0) {
      return [];
    }

    let resolvedProjectPath = options.projectPath;
    if (resolvedProjectPath === undefined && options.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    const results: FTSSearchResult[] = [];

    for (const [sid, turns] of this.turnsMap.entries()) {
      const session = this.sessionsMap.get(sid);
      if (!session) continue;

      for (const turn of turns) {
        if (turn.isUndone) continue;
        if (!matchInMemoryTurnFilter(session, turn, resolvedProjectPath, options.filter)) {
          continue;
        }

        let isMatch = false;
        if (options.filter?.onlyUserPrompts === true) {
          isMatch = (turn.userPrompt || "").toLowerCase().includes(query);
        } else {
          const promptMatch = (turn.userPrompt || "").toLowerCase().includes(query);
          const respMatch = (turn.assistantResponse || "").toLowerCase().includes(query);
          const textMatch = (turn.turnText || "").toLowerCase().includes(query);
          isMatch = promptMatch || respMatch || textMatch;
        }

        if (isMatch) {
          results.push({
            sessionId: sid,
            turnIndex: turn.turnIndex,
            title: session.title,
            role: session.role,
            projectPath: session.projectPath,
            rank: -1,
            userPrompt: (turn.userPrompt || "").slice(0, 500),
            assistantSnippet: (turn.assistantResponse || "").slice(0, 200),
            createdAt: turn.createdAt ?? session.createdAt,
          });
        }
      }
    }

    return results.slice(0, limit);
  }

  getActiveProjectPath(): string | undefined {
    let mostRecentTime = -1;
    let mostRecentPath: string | undefined = undefined;

    for (const session of this.sessionsMap.values()) {
      if (!session.projectPath) continue;
      const sessionTime = session.lastActiveAt ?? session.createdAt;
      if (sessionTime > mostRecentTime) {
        mostRecentTime = sessionTime;
        mostRecentPath = session.projectPath;
      }
    }
    return mostRecentPath;
  }

  close(): void {
    // No-op for in-memory store
  }

  // ============================================================
  // Transitional Shims for S2 Compatibility
  // ============================================================

  save(session: SessionData, embeddings?: SessionEmbeddings): void {
    legacySaveShim(this, session, embeddings);
  }

  query(options: QueryOptions): QueryResult {
    return legacyQueryShim(this, options);
  }

  search(
    queryVector: number[],
    limit: number,
    options?: { projectPath?: string; scope?: "workspace" | "all" }
  ): SearchResult[] {
    return legacySearchShim(this, queryVector, limit, options);
  }
}

// ============================================================
// 5. SQLite History Store (Production Relational Engine)
// ============================================================

export class SqliteHistoryStore implements HistoryStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    initDatabaseSchema(this.db);
  }

  saveSession(
    session: SessionData,
    turns?: TurnData[],
    steps?: StepData[]
  ): void {
    const db = this.db;
    db.exec("BEGIN TRANSACTION;");
    try {
      const safeSteps = steps || session.steps || [];
      const artifactsJson = session.artifacts && session.artifacts.length > 0 ? JSON.stringify(session.artifacts) : null;
      const filesTouchedJson = session.filesTouched && session.filesTouched.length > 0 ? JSON.stringify(session.filesTouched) : null;
      const metadataJson = session.metadata && Object.keys(session.metadata).length > 0 ? JSON.stringify(session.metadata) : null;

      const existing = db.prepare("SELECT parent_id, root_id, depth, title FROM sessions WHERE id = ?").get(session.id) as any;
      let effectiveParentId = session.parentId || null;
      if (!effectiveParentId && existing?.parent_id) {
        const pCheck = db.prepare("SELECT created_at FROM sessions WHERE id = ?").get(existing.parent_id) as any;
        if (pCheck && pCheck.created_at <= (session.createdAt ?? Date.now())) {
          effectiveParentId = existing.parent_id;
        }
      }
      if (effectiveParentId === session.id || session.rootId === session.id) {
        effectiveParentId = null;
      }

      let parentRow: any = undefined;
      if (effectiveParentId) {
        parentRow = db.prepare("SELECT id, root_id, depth FROM sessions WHERE id = ?").get(effectiveParentId) as any;
      }

      let resolvedDepth = session.depth && session.depth > 0 ? session.depth : 0;
      if (!resolvedDepth) {
        resolvedDepth = parentRow ? (parentRow.depth ?? 0) + 1 : (existing?.depth ?? 0);
      }
      const resolvedRootId = session.rootId || parentRow?.root_id || parentRow?.id || effectiveParentId || existing?.root_id || null;

      // 1. Pre-insert stub records for parent and root before primary upsert
      const insertStub = db.prepare(`
        INSERT OR IGNORE INTO sessions (id, adapter, title, created_at, last_active_at, first_prompt)
        VALUES (?, ?, 'Unknown Session', ?, ?, '')
      `);
      if (effectiveParentId) {
        insertStub.run(effectiveParentId, session.adapter || "unknown", session.createdAt || Date.now(), session.lastActiveAt || Date.now());
      }
      if (resolvedRootId && resolvedRootId !== effectiveParentId && resolvedRootId !== session.id) {
        insertStub.run(resolvedRootId, session.adapter || "unknown", session.createdAt || Date.now(), session.lastActiveAt || Date.now());
      }

      const stepTimestamps = safeSteps
        .map((s) => s.createdAt)
        .filter((t): t is number => t !== undefined);
      const lastActiveAt =
        stepTimestamps.length > 0
          ? Math.max(...stepTimestamps)
          : session.lastActiveAt ?? session.createdAt ?? Date.now();

      const totalTurns = turns ? turns.length : session.totalTurns ?? 0;
      const totalSteps = steps ? steps.length : session.totalSteps ?? safeSteps.length;
      const lifecycleStatus = session.lifecycle?.status ?? "completed";
      const hasTurnCompletion = session.lifecycle?.hasTurnCompletion !== false ? 1 : 0;
      const lastStepIndex = session.lifecycle?.lastStepIndex ?? null;
      const lastToolExecuted = session.lifecycle?.lastToolExecuted ?? null;

      // 2. Primary session upsert
      db.prepare(`
        INSERT INTO sessions (
          id, adapter, title, role, project_path, created_at, last_active_at,
          parent_id, root_id, depth, total_turns, total_steps, total_tokens,
          artifacts, files_touched, first_prompt, metadata, log_mtime, log_size,
          lifecycle_status, has_turn_completion, last_step_index, last_tool_executed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          adapter = excluded.adapter,
          title = CASE
            WHEN excluded.title NOT LIKE 'Session %' AND excluded.title NOT LIKE 'Untitled%' AND excluded.title NOT LIKE 'Unknown%' AND excluded.title != ''
            THEN excluded.title
            WHEN title NOT LIKE 'Session %' AND title NOT LIKE 'Untitled%' AND title NOT LIKE 'Unknown%' AND title != ''
            THEN title
            ELSE excluded.title
          END,
          role = COALESCE(excluded.role, role),
          project_path = COALESCE(excluded.project_path, project_path),
          created_at = excluded.created_at,
          last_active_at = excluded.last_active_at,
          parent_id = COALESCE(excluded.parent_id, parent_id),
          root_id = COALESCE(excluded.root_id, root_id),
          depth = excluded.depth,
          total_turns = excluded.total_turns,
          total_steps = excluded.total_steps,
          total_tokens = excluded.total_tokens,
          artifacts = CASE
            WHEN excluded.artifacts IS NOT NULL AND excluded.artifacts != '[]'
            THEN excluded.artifacts
            ELSE artifacts
          END,
          files_touched = CASE
            WHEN excluded.files_touched IS NOT NULL AND excluded.files_touched != '[]'
            THEN excluded.files_touched
            ELSE files_touched
          END,
          first_prompt = CASE
            WHEN excluded.first_prompt IS NOT NULL AND excluded.first_prompt != ''
            THEN excluded.first_prompt
            ELSE first_prompt
          END,
          metadata = CASE
            WHEN excluded.metadata IS NOT NULL AND excluded.metadata != '{}'
            THEN excluded.metadata
            ELSE metadata
          END,
          log_mtime = COALESCE(excluded.log_mtime, log_mtime),
          log_size = COALESCE(excluded.log_size, log_size),
          lifecycle_status = excluded.lifecycle_status,
          has_turn_completion = excluded.has_turn_completion,
          last_step_index = excluded.last_step_index,
          last_tool_executed = excluded.last_tool_executed;
      `).run(
        session.id,
        session.adapter ?? "unknown",
        session.title ?? "Untitled Session",
        session.role ?? null,
        session.projectPath ?? null,
        session.createdAt ?? Date.now(),
        lastActiveAt,
        effectiveParentId,
        resolvedRootId,
        resolvedDepth,
        totalTurns,
        totalSteps,
        session.totalTokens ?? 0,
        artifactsJson,
        filesTouchedJson,
        session.firstPrompt ?? "",
        metadataJson,
        session.logMtime ?? null,
        session.logSize ?? null,
        lifecycleStatus,
        hasTurnCompletion,
        lastStepIndex,
        lastToolExecuted
      );

      // 3. Pre-insert child stubs AND resolve backward linkage strictly before transcript_steps
      const childStubStmt = db.prepare(`
        INSERT OR IGNORE INTO sessions (id, adapter, title, created_at, last_active_at, first_prompt, parent_id, root_id, depth)
        VALUES (?, ?, 'Unknown Subagent', ?, ?, '', ?, ?, ?)
      `);
      const updateChildLinkStmt = db.prepare(`
        UPDATE sessions
        SET parent_id = ?,
            root_id = ?,
            depth = CASE WHEN depth = 0 AND ? > 0 THEN ? ELSE depth END
        WHERE id = ? AND (created_at >= ? OR created_at IS NULL)
      `);
      const referencedChildIds = new Set<string>([
        ...(Array.isArray(session.subagentIds) ? session.subagentIds : []),
        ...safeSteps.filter((st: any) => st?.subagentSessionId).map((st: any) => st.subagentSessionId as string),
      ]);
      for (const childId of referencedChildIds) {
        if (childId && childId !== session.id) {
          childStubStmt.run(childId, session.adapter || "unknown", session.createdAt || Date.now(), session.lastActiveAt || Date.now(), session.id, resolvedRootId || session.id, resolvedDepth + 1);
          updateChildLinkStmt.run(session.id, resolvedRootId || session.id, resolvedDepth + 1, resolvedDepth + 1, childId, session.createdAt || 0);
        }
      }

      // 4. Depth-bounded recursive multi-level hierarchy descendant cascade
      const cascadeDescendantsStmt = db.prepare(`
        WITH RECURSIVE descendants(id, new_root, new_depth) AS (
          SELECT id, ?, ? + 1
          FROM sessions
          WHERE parent_id = ?
          UNION ALL
          SELECT s.id, d.new_root, d.new_depth + 1
          FROM sessions s
          JOIN descendants d ON s.parent_id = d.id
          WHERE d.new_depth < 20
        )
        UPDATE sessions
        SET root_id = (SELECT new_root FROM descendants WHERE descendants.id = sessions.id),
            depth = (SELECT new_depth FROM descendants WHERE descendants.id = sessions.id)
        WHERE id IN (SELECT id FROM descendants);
      `);
      cascadeDescendantsStmt.run(resolvedRootId || session.id, resolvedDepth, session.id);

      // 5. Insert transcript_turns
      if (turns && turns.length > 0) {
        db.prepare("DELETE FROM transcript_turns WHERE session_id = ?").run(session.id);

        const insertTurn = db.prepare(`
          INSERT INTO transcript_turns (
            session_id, turn_index, user_prompt, assistant_response, turn_summary,
            turn_text, turn_vector, input_tokens, output_tokens, thinking_tokens,
            tool_count, error_count, duration_ms, is_undone, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const turn of turns) {
          const vectorBlob = normalizeTurnVector(turn.turnVector);

          insertTurn.run(
            session.id,
            turn.turnIndex,
            turn.userPrompt ?? "",
            turn.assistantResponse ?? null,
            turn.turnSummary ?? null,
            turn.turnText ?? "",
            vectorBlob,
            turn.inputTokens ?? 0,
            turn.outputTokens ?? 0,
            turn.thinkingTokens ?? 0,
            turn.toolCount ?? 0,
            turn.errorCount ?? 0,
            turn.durationMs ?? 0,
            turn.isUndone ? 1 : 0,
            turn.createdAt ?? session.createdAt ?? Date.now()
          );
        }
      }

      // 6. Insert transcript_steps
      if (steps && steps.length > 0) {
        db.prepare("DELETE FROM transcript_steps WHERE session_id = ?").run(session.id);

        const insertStep = db.prepare(`
          INSERT INTO transcript_steps (
            session_id, turn_index, step_index, step_order, category, kind,
            status, content, thinking, tool_name, server_name, file_path,
            exit_code, error_message, tool_args, tool_result, tool_duration_ms,
            subagent_session_id, created_at, is_undone
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const step of steps) {
          insertStep.run(
            session.id,
            step.turnIndex ?? 1,
            step.stepIndex,
            step.stepOrder ?? step.stepIndex,
            step.category ?? "agent",
            step.kind ?? null,
            step.status ?? "DONE",
            step.content ?? null,
            step.thinking ?? null,
            step.toolName ?? null,
            step.serverName ?? null,
            step.filePath ?? null,
            step.exitCode ?? null,
            step.errorMessage ?? null,
            step.toolArgs ?? null,
            step.toolResult ?? null,
            step.toolDurationMs ?? null,
            step.subagentSessionId ?? null,
            step.createdAt ?? session.createdAt ?? Date.now(),
            step.isUndone ? 1 : 0
          );
        }
      }

      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  }

  getSessionLogStats(): Map<string, { logMtime: number; logSize: number }> {
    const rows = this.db.prepare(
      "SELECT id, log_mtime, log_size FROM sessions WHERE log_mtime IS NOT NULL AND log_size IS NOT NULL"
    ).all() as Array<{ id: string; log_mtime: number; log_size: number }>;
    const map = new Map<string, { logMtime: number; logSize: number }>();
    for (const row of rows) {
      map.set(row.id, { logMtime: row.log_mtime, logSize: row.log_size });
    }
    return map;
  }

  getSession(id: string): SessionData | null {
    if (!id || typeof id !== "string") return null;
    let row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
    const cleanId = id.trim().toLowerCase();
    if (!row) {
      row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(cleanId) as any;
    }
    if (!row && cleanId.length >= 6) {
      const nextPrefix = cleanId.slice(0, -1) + String.fromCharCode(cleanId.charCodeAt(cleanId.length - 1) + 1);
      row = this.db
        .prepare(
          "SELECT * FROM sessions WHERE id >= ? AND id < ? ORDER BY last_active_at DESC, created_at DESC LIMIT 1"
        )
        .get(cleanId, nextPrefix) as any;
    }
    if (!row) return null;

    const actualId = row.id;
    return {
      id: row.id,
      adapter: row.adapter,
      title: row.title,
      role: row.role ?? undefined,
      projectPath: row.project_path,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      parentId: row.parent_id,
      rootId: row.root_id,
      depth: row.depth,
      totalTurns: row.total_turns,
      totalSteps: row.total_steps,
      totalTokens: row.total_tokens,
      artifacts: row.artifacts ? JSON.parse(row.artifacts) : [],
      filesTouched: row.files_touched ? JSON.parse(row.files_touched) : [],
      firstPrompt: row.first_prompt,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      logMtime: row.log_mtime ?? undefined,
      logSize: row.log_size ?? undefined,
      lifecycle: {
        status: row.lifecycle_status || "completed",
        hasTurnCompletion: row.has_turn_completion !== 0,
        lastStepIndex: row.last_step_index ?? undefined,
        lastToolExecuted: row.last_tool_executed ?? undefined,
      },
      turns: this.getTurns(actualId, { includeUndone: true }),
      steps: this.getSteps(actualId, { includeUndone: true }),
    };
  }

  listSessions(options: ListSessionsOptions = {}): SessionData[] {
    let sql = `SELECT s.*, (SELECT COALESCE(SUM(error_count), 0) FROM transcript_turns WHERE session_id = s.id) as error_count FROM sessions s`;
    const where: string[] = [];
    const params: any[] = [];

    if (options.adapter !== undefined) {
      where.push("s.adapter = ?");
      params.push(options.adapter);
    }

    if (options.parentId !== undefined) {
      if (options.parentId === "root" || options.parentId === "null") {
        where.push("s.parent_id IS NULL");
      } else {
        where.push("s.parent_id = ?");
        params.push(options.parentId);
      }
    }

    if (options.role !== undefined) {
      where.push("s.role = ?");
      params.push(options.role);
    }

    let resolvedProjectPath = options.projectPath;
    if (resolvedProjectPath === undefined && options.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    if (resolvedProjectPath !== undefined) {
      where.push("LOWER(s.project_path) LIKE ?");
      params.push(`%${resolvedProjectPath.toLowerCase()}%`);
    }

    if (options.hasErrors === true) {
      where.push(
        "EXISTS (SELECT 1 FROM transcript_turns WHERE session_id = s.id AND error_count > 0)"
      );
    } else if (options.hasErrors === false) {
      where.push(
        "NOT EXISTS (SELECT 1 FROM transcript_turns WHERE session_id = s.id AND error_count > 0)"
      );
    }

    if (options.timeRange !== undefined) {
      const range = parseTimeRange(options.timeRange);
      if (range) {
        if (range.start !== null) {
          where.push("s.last_active_at >= ?");
          params.push(range.start);
        }
        if (range.end !== null) {
          where.push("s.last_active_at <= ?");
          params.push(range.end);
        }
      }
    }

    if (where.length > 0) {
      sql += " WHERE " + where.join(" AND ");
    }

    const sortBy = options.sortBy || "active";
    sql += sortBy === "created" ? " ORDER BY s.created_at DESC" : " ORDER BY s.last_active_at DESC";

    let limit: number | undefined;
    if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
      limit = Math.max(1, Math.floor(options.limit));
    } else if (options.offset !== undefined) {
      limit = 10;
    }

    const offset =
      typeof options.offset === "number" && Number.isFinite(options.offset)
        ? Math.max(0, Math.floor(options.offset))
        : undefined;

    if (limit !== undefined) {
      sql += " LIMIT ?";
      params.push(limit);
    }

    if (offset !== undefined) {
      sql += " OFFSET ?";
      params.push(offset);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
      id: r.id,
      adapter: r.adapter,
      title: r.title,
      role: r.role ?? undefined,
      projectPath: r.project_path,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
      parentId: r.parent_id,
      rootId: r.root_id,
      depth: r.depth,
      totalTurns: r.total_turns,
      totalSteps: r.total_steps,
      totalTokens: r.total_tokens,
      errorCount: Number(r.error_count || 0),
      artifacts: r.artifacts ? JSON.parse(r.artifacts) : [],
      filesTouched: r.files_touched ? JSON.parse(r.files_touched) : [],
      firstPrompt: r.first_prompt,
      metadata: r.metadata ? JSON.parse(r.metadata) : {},
      logMtime: r.log_mtime ?? undefined,
      logSize: r.log_size ?? undefined,
      lifecycle: {
        status: r.lifecycle_status || "completed",
        hasTurnCompletion: r.has_turn_completion !== 0,
        lastStepIndex: r.last_step_index ?? undefined,
        lastToolExecuted: r.last_tool_executed ?? undefined,
      },
    }));
  }

  private resolveActualSessionId(id: string): string {
    if (!id || typeof id !== "string") return id;
    const cleanId = id.trim().toLowerCase();
    if (cleanId.length >= 6 && cleanId.length < 36) {
      const nextPrefix = cleanId.slice(0, -1) + String.fromCharCode(cleanId.charCodeAt(cleanId.length - 1) + 1);
      const row = this.db
        .prepare(
          "SELECT id FROM sessions WHERE id = ? OR (id >= ? AND id < ?) ORDER BY last_active_at DESC LIMIT 1"
        )
        .get(cleanId, cleanId, nextPrefix) as { id: string } | undefined;
      if (row?.id) return row.id;
    }
    return id;
  }

  getTurns(sessionId: string, options: GetTurnsOptions = {}): TurnData[] {
    const resolvedSessionId = this.resolveActualSessionId(sessionId);
    const maxRow = this.db
      .prepare("SELECT MAX(turn_index) as max_idx FROM transcript_turns WHERE session_id = ?")
      .get(resolvedSessionId) as { max_idx: number | null } | undefined;
    const maxTurnIndex = maxRow?.max_idx ?? 0;

    let targetTurn = options.turnIndex;
    if (targetTurn !== undefined && targetTurn < 0) {
      targetTurn = maxTurnIndex + 1 + targetTurn;
    }

    let startTurn = options.startTurn;
    if (startTurn !== undefined && startTurn < 0) {
      startTurn = maxTurnIndex + 1 + startTurn;
    }

    let endTurn = options.endTurn;
    if (endTurn !== undefined && endTurn < 0) {
      endTurn = maxTurnIndex + 1 + endTurn;
    }

    let sql = `SELECT * FROM transcript_turns WHERE session_id = ?`;
    const params: any[] = [resolvedSessionId];

    if (!options.includeUndone) {
      sql += ` AND is_undone = 0`;
    }

    if (targetTurn !== undefined) {
      sql += ` AND turn_index = ?`;
      params.push(targetTurn);
    }
    if (startTurn !== undefined) {
      sql += ` AND turn_index >= ?`;
      params.push(startTurn);
    }
    if (endTurn !== undefined) {
      sql += ` AND turn_index <= ?`;
      params.push(endTurn);
    }

    sql += options.order === "reverse_chronological" ? " ORDER BY turn_index DESC" : " ORDER BY turn_index ASC";

    if (options.lastTurns !== undefined && options.lastTurns > 0) {
      // Subquery for last N turns
      sql = `
        SELECT * FROM (
          SELECT * FROM transcript_turns
          WHERE session_id = ? ${!options.includeUndone ? "AND is_undone = 0" : ""}
          ORDER BY turn_index DESC
          LIMIT ?
        )
        ORDER BY turn_index ASC
      `;
      params.length = 0;
      params.push(resolvedSessionId, options.lastTurns);
    } else if (options.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
      turnIndex: r.turn_index,
      userPrompt: r.user_prompt,
      assistantResponse: r.assistant_response ?? "",
      turnSummary: r.turn_summary ?? undefined,
      turnText: r.turn_text,
      turnVector: r.turn_vector ? blobToVector(r.turn_vector) : new Float32Array(EMBEDDING_DIMENSION),
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      thinkingTokens: r.thinking_tokens,
      toolCount: r.tool_count,
      errorCount: r.error_count,
      durationMs: r.duration_ms,
      isUndone: r.is_undone === 1,
      createdAt: r.created_at,
    }));
  }

  getSteps(sessionId: string, options: GetStepsOptions = {}): StepData[] {
    const resolvedSessionId = this.resolveActualSessionId(sessionId);
    let sql = `SELECT * FROM transcript_steps WHERE session_id = ?`;
    const params: any[] = [resolvedSessionId];

    if (!options.includeUndone) {
      sql += ` AND is_undone = 0`;
    }

    if (options.turnIndex !== undefined) {
      const maxRow = this.db
        .prepare("SELECT MAX(turn_index) as max_idx FROM transcript_turns WHERE session_id = ?")
        .get(resolvedSessionId) as { max_idx: number | null } | undefined;
      const maxTurn = maxRow?.max_idx ?? 0;
      const resolvedTurn =
        options.turnIndex < 0 ? maxTurn + 1 + options.turnIndex : options.turnIndex;
      sql += ` AND turn_index = ?`;
      params.push(resolvedTurn);
    }

    if (options.stepIndex !== undefined) {
      sql += ` AND step_index = ?`;
      params.push(options.stepIndex);
    }

    sql = buildStepFilterClauses(options, sql, params);

    sql += ` ORDER BY turn_index ASC, step_order ASC`;

    if (options.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => mapRowToStepData(r));
  }

  getStepsForTurns(
    sessionId: string,
    turnIndices: number[],
    options: GetStepsOptions = {}
  ): Map<number, StepData[]> {
    const result = new Map<number, StepData[]>();
    if (!turnIndices || turnIndices.length === 0) {
      return result;
    }
    for (const tIdx of turnIndices) {
      result.set(tIdx, []);
    }

    const BATCH_SIZE = 500;
    for (let i = 0; i < turnIndices.length; i += BATCH_SIZE) {
      const chunk = turnIndices.slice(i, i + BATCH_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      let sql = `SELECT * FROM transcript_steps WHERE session_id = ? AND turn_index IN (${placeholders})`;
      const params: any[] = [sessionId, ...chunk];

      if (!options.includeUndone) {
        sql += ` AND is_undone = 0`;
      }

      sql = buildStepFilterClauses(options, sql, params);

      sql += ` ORDER BY turn_index ASC, step_order ASC`;

      const rows = this.db.prepare(sql).all(...params) as any[];
      for (const r of rows) {
        const step = mapRowToStepData(r);
        if (result.has(r.turn_index)) {
          result.get(r.turn_index)!.push(step);
        }
      }
    }
    return result;
  }

  getSubtreeSessionIds(sessionId: string): string[] {
    const sql = `
      WITH RECURSIVE subtree_cte(id, depth) AS (
        SELECT id, 0 FROM sessions WHERE id = ?
        UNION ALL
        SELECT s.id, st.depth + 1
        FROM sessions s
        JOIN subtree_cte st ON s.parent_id = st.id
        WHERE st.depth < 10
      )
      SELECT id FROM sessions WHERE id IN (SELECT id FROM subtree_cte);
    `;
    const rows = this.db.prepare(sql).all(sessionId) as { id: string }[];
    return rows.map((r) => r.id);
  }

  getSessionRelationship(
    sessionId: string,
    maxDepth = 3,
    includeAncestors = true,
    includeMandate = false
  ): SessionRelationshipResult | null {
    const current = this.getSession(sessionId);
    if (!current) return null;

    const effectiveMaxDepth = Math.min(Math.max(1, maxDepth || 3), 10);

    const buildSqliteNode = (
      row: any,
      depth: number
    ): SessionRelationshipNode => {
      const node: SessionRelationshipNode = {
        id: row.id,
        adapter: row.adapter,
        title: row.title,
        role: row.role ?? undefined,
        projectPath: row.project_path,
        createdAt: row.created_at,
        lastActiveAt: row.last_active_at,
        parentId: row.parent_id,
        rootId: row.root_id,
        depth,
        totalTurns: row.total_turns,
        artifacts: row.artifacts ? (typeof row.artifacts === "string" ? JSON.parse(row.artifacts) : row.artifacts) : [],
        lifecycle: {
          status: row.lifecycle_status || "completed",
          hasTurnCompletion: row.has_turn_completion !== 0,
          lastStepIndex: row.last_step_index ?? undefined,
          lastToolExecuted: row.last_tool_executed ?? undefined,
        },
      };
      if (includeMandate && row.first_prompt) {
        node.mandate = row.first_prompt;
      }
      if (row.adapter === "antigravity") {
        node.inbox = getAntigravityAdapter().getInbox(row.id);
      }
      return node;
    };

    const ancestors: SessionRelationshipNode[] = [];
    let rootSessionId = current.id;

    if (includeAncestors && current.parentId) {
      const ancestorSql = `
        WITH RECURSIVE ancestors_cte(id, parent_id, depth) AS (
          SELECT id, parent_id, 0 FROM sessions WHERE id = ?
          UNION ALL
          SELECT s.id, s.parent_id, a.depth + 1
          FROM sessions s
          JOIN ancestors_cte a ON s.id = a.parent_id
          WHERE a.depth < 10
        )
        SELECT s.* FROM sessions s
        JOIN ancestors_cte a ON s.id = a.id
        WHERE s.id != ?
        ORDER BY a.depth DESC
      `;
      const ancRows = this.db.prepare(ancestorSql).all(current.parentId, current.id) as any[];
      for (const row of ancRows) {
        ancestors.push(buildSqliteNode(row, row.depth));
      }
      if (ancestors.length > 0) {
        rootSessionId = ancestors[0].id;
      }
    }

    const parentNode = current.parentId
      ? ancestors.find((a) => a.id === current.parentId) ||
        (this.getSession(current.parentId) as any)
      : null;

    // Children recursive query up to effectiveMaxDepth
    const childCteSql = `
      WITH RECURSIVE children_cte(id, parent_id, depth) AS (
        SELECT id, parent_id, 1 FROM sessions WHERE parent_id = ?
        UNION ALL
        SELECT s.id, s.parent_id, c.depth + 1
        FROM sessions s
        JOIN children_cte c ON s.parent_id = c.id
        WHERE c.depth < ?
      )
      SELECT s.*, c.depth as tree_depth
      FROM sessions s
      JOIN children_cte c ON s.id = c.id
      ORDER BY c.depth ASC, s.created_at ASC
    `;
    const childRows = this.db.prepare(childCteSql).all(current.id, effectiveMaxDepth) as any[];

    const childrenByParent = new Map<string, any[]>();
    for (const r of childRows) {
      const pId = r.parent_id || "";
      if (!childrenByParent.has(pId)) {
        childrenByParent.set(pId, []);
      }
      childrenByParent.get(pId)!.push(r);
    }

    const buildChildrenTree = (
      parentId: string,
      currentDepth: number,
      visited: Set<string>
    ): SessionRelationshipNode[] => {
      if (currentDepth > effectiveMaxDepth) return [];
      const directChildren = childrenByParent.get(parentId) || [];
      const nodes: SessionRelationshipNode[] = [];

      for (const r of directChildren) {
        if (visited.has(r.id)) continue;
        const branchVisited = new Set(visited);
        branchVisited.add(r.id);

        const childNode = buildSqliteNode(r, r.tree_depth ?? currentDepth);
        const subChildren = buildChildrenTree(r.id, currentDepth + 1, branchVisited);
        if (subChildren.length > 0) {
          childNode.children = subChildren;
        }
        nodes.push(childNode);
      }
      return nodes;
    };

    const visitedRoot = new Set<string>([current.id]);
    const childrenNodes = buildChildrenTree(current.id, 1, visitedRoot);

    // Siblings
    let siblings: SessionRelationshipNode[] = [];
    if (current.parentId) {
      const sibRows = this.db
        .prepare("SELECT * FROM sessions WHERE parent_id = ? AND id != ?")
        .all(current.parentId, current.id) as any[];
      siblings = sibRows.map((r) => buildSqliteNode(r, 0));
    }

    const currentNode: SessionRelationshipNode = {
      id: current.id,
      adapter: current.adapter,
      title: current.title,
      role: current.role,
      projectPath: current.projectPath,
      createdAt: current.createdAt,
      lastActiveAt: current.lastActiveAt,
      parentId: current.parentId,
      rootId: current.rootId,
      depth: 0,
      totalTurns: current.totalTurns,
      ...(includeMandate && current.firstPrompt ? { mandate: current.firstPrompt } : {}),
      artifacts: current.artifacts,
      lifecycle: current.lifecycle || { status: "completed", hasTurnCompletion: true },
      inbox: current.adapter === "antigravity" ? getAntigravityAdapter().getInbox(current.id) : undefined,
    };

    return {
      sessionId: current.id,
      rootSessionId,
      parent: parentNode,
      ancestors,
      current: currentNode,
      children: childrenNodes,
      siblings,
    };
  }

  getArtifactDescriptors(
    sessionId: string,
    includeSubtree = false,
    artifactName?: string
  ): ArtifactDescriptor[] {
    const session = this.getSession(sessionId);
    if (!session) return [];

    const targetSessionIds = includeSubtree
      ? this.getSubtreeSessionIds(sessionId)
      : [sessionId];

    if (targetSessionIds.length === 0) return [];

    const placeholders = targetSessionIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, artifacts FROM sessions WHERE id IN (${placeholders}) AND artifacts IS NOT NULL`
      )
      .all(...targetSessionIds) as { id: string; artifacts: string }[];

    const descriptors: ArtifactDescriptor[] = [];
    const filterName = artifactName ? artifactName.toLowerCase() : undefined;

    for (const r of rows) {
      try {
        const arr = JSON.parse(r.artifacts);
        if (Array.isArray(arr)) {
          for (const a of arr) {
            if (typeof a === "string") {
              if (!filterName || a.toLowerCase().includes(filterName)) {
                descriptors.push({ sessionId: r.id, filename: a });
              }
            }
          }
        }
      } catch {}
    }

    return descriptors;
  }

  getArtifacts(
    sessionId: string,
    includeSubtree = false,
    artifactName?: string
  ): string[] {
    const descriptors = this.getArtifactDescriptors(
      sessionId,
      includeSubtree,
      artifactName
    );
    return Array.from(new Set(descriptors.map((d) => d.filename)));
  }

  getToolUsageStats(options: ToolUsageStatsOptions = {}): ToolUsageReport {
    let sessionSubquery = `SELECT id FROM sessions`;
    const subWhere: string[] = [];
    const subParams: any[] = [];

    let resolvedProjectPath = options.projectPath;
    if (resolvedProjectPath === undefined && options.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    if (resolvedProjectPath !== undefined) {
      subWhere.push("LOWER(project_path) LIKE ?");
      subParams.push(`%${resolvedProjectPath.toLowerCase()}%`);
    }

    if (options.timeRange !== undefined) {
      const range = parseTimeRange(options.timeRange);
      if (range) {
        if (range.start !== null) {
          subWhere.push("last_active_at >= ?");
          subParams.push(range.start);
        }
        if (range.end !== null) {
          subWhere.push("last_active_at <= ?");
          subParams.push(range.end);
        }
      }
    }

    if (subWhere.length > 0) {
      sessionSubquery += " WHERE " + subWhere.join(" AND ");
    }

    sessionSubquery += " ORDER BY last_active_at DESC";

    const sessionLimit =
      typeof options.limit === "number" && Number.isFinite(options.limit)
        ? Math.max(1, Math.floor(options.limit))
        : 30;

    sessionSubquery += " LIMIT ?";
    subParams.push(sessionLimit);

    const statsSql = `
      SELECT
        COALESCE(st.server_name, 'native') AS server_name,
        COALESCE(st.tool_name, 'unknown') AS tool_name,
        COUNT(*) AS total_calls,
        SUM(CASE WHEN st.status = 'ERROR' THEN 1 ELSE 0 END) AS error_count,
        SUM(CASE WHEN st.status = 'DONE' THEN 1 ELSE 0 END) AS success_count,
        CASE
          WHEN COUNT(*) > 0 THEN ROUND(SUM(CASE WHEN st.status = 'ERROR' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1)
          ELSE 0.0
        END AS failure_rate,
        ROUND(AVG(COALESCE(st.tool_duration_ms, 0)), 1) AS avg_duration_ms
      FROM transcript_steps st
      WHERE st.session_id IN (${sessionSubquery})
        AND st.category = 'execution'
        AND st.is_undone = 0
        AND st.tool_name IS NOT NULL
      GROUP BY server_name, tool_name
      ORDER BY total_calls DESC
    `;

    const rows = this.db.prepare(statsSql).all(...subParams) as any[];

    const thrashSql = `
      SELECT
        st.session_id,
        st.turn_index,
        COALESCE(st.tool_name, 'unknown') AS tool_name,
        COALESCE(st.server_name, 'native') AS server_name,
        COUNT(*) AS consecutive_failures,
        SUBSTR(MAX(st.error_message), 1, 500) AS sample_error
      FROM transcript_steps st
      WHERE st.session_id IN (${sessionSubquery})
        AND st.category = 'execution'
        AND st.status = 'ERROR'
        AND st.is_undone = 0
      GROUP BY st.session_id, st.turn_index, server_name, tool_name
      HAVING COUNT(*) >= 3
      ORDER BY consecutive_failures DESC
    `;

    const thrashRows = this.db.prepare(thrashSql).all(...subParams) as any[];

    let totalCalls = 0;
    let totalErrors = 0;

    const tools: PerToolStat[] = rows.map((r) => {
      totalCalls += Number(r.total_calls || 0);
      totalErrors += Number(r.error_count || 0);
      return {
        serverName: r.server_name,
        toolName: r.tool_name,
        totalCalls: Number(r.total_calls || 0),
        errorCount: Number(r.error_count || 0),
        successCount: Number(r.success_count || 0),
        failureRate: Number(r.failure_rate || 0),
        avgDurationMs: Number(r.avg_duration_ms || 0),
      };
    });

    const thrashingTools: ThrashingTool[] = thrashRows.map((r) => ({
      sessionId: r.session_id,
      turnIndex: r.turn_index,
      serverName: r.server_name,
      toolName: r.tool_name,
      consecutiveFailures: Number(r.consecutive_failures || 0),
      sampleError: r.sample_error ?? undefined,
    }));

    return buildToolUsageReport(tools, thrashingTools, totalCalls, totalErrors);
  }

  searchTurnsVector(
    queryVector: VectorInput,
    limit: number,
    options: {
      projectPath?: string;
      scope?: "workspace" | "all";
      filter?: SearchHistoryFilter;
    } = {}
  ): VectorSearchResult[] {
    const floatVec = normalizeQueryVector(queryVector);

    let resolvedProjectPath = options.projectPath;
    if (resolvedProjectPath === undefined && options.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    let sql = `
      SELECT t.session_id, t.turn_index, SUBSTR(t.user_prompt, 1, 500) AS user_prompt,
             SUBSTR(t.assistant_response, 1, 200) AS assistant_snippet,
             t.turn_vector, t.created_at, s.title, s.role, s.project_path
      FROM transcript_turns t
      JOIN sessions s ON t.session_id = s.id
      WHERE t.is_undone = 0
    `;
    const params: any[] = [];
    sql = applySqliteTurnFilters(resolvedProjectPath, options.filter, sql, params);

    const rows = this.db.prepare(sql).all(...params) as any[];
    const results: VectorSearchResult[] = [];

    for (const row of rows) {
      if (!row.turn_vector) continue;
      const turnVec = blobToVector(row.turn_vector);
      const similarity = cosineSimilarityFloat32(floatVec, turnVec);
      const safeSimilarity = Number.isNaN(similarity) ? 0 : similarity;

      results.push({
        sessionId: row.session_id,
        turnIndex: row.turn_index,
        title: row.title,
        role: row.role ?? undefined,
        projectPath: row.project_path,
        similarity: safeSimilarity,
        userPrompt: row.user_prompt,
        assistantSnippet: row.assistant_snippet ?? "",
        createdAt: row.created_at,
      });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  searchTurnsFTS(
    queryText: string,
    limit: number,
    options: {
      projectPath?: string;
      scope?: "workspace" | "all";
      filter?: SearchHistoryFilter;
    } = {}
  ): FTSSearchResult[] {
    const onlyUserPrompts = options.filter?.onlyUserPrompts === true;
    const ftsExpression = sanitizeFts5Query(queryText, onlyUserPrompts);
    if (!ftsExpression) {
      return [];
    }

    let resolvedProjectPath = options.projectPath;
    if (resolvedProjectPath === undefined && options.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    let sql = `
      SELECT f.rowid, f.user_prompt, SUBSTR(f.assistant_response, 1, 200) AS assistant_snippet,
             bm25(transcript_turns_fts) as rank,
             t.session_id, t.turn_index, t.created_at,
             s.title, s.role, s.project_path
      FROM transcript_turns_fts f
      JOIN transcript_turns t ON f.rowid = t.id
      JOIN sessions s ON t.session_id = s.id
      WHERE transcript_turns_fts MATCH ? AND t.is_undone = 0
    `;
    const params: any[] = [ftsExpression];
    sql = applySqliteTurnFilters(resolvedProjectPath, options.filter, sql, params);

    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    try {
      const rows = this.db.prepare(sql).all(...params) as any[];
      return rows.map((r) => ({
        sessionId: r.session_id,
        turnIndex: r.turn_index,
        title: r.title,
        role: r.role ?? undefined,
        projectPath: r.project_path,
        rank: r.rank,
        userPrompt: r.user_prompt,
        assistantSnippet: r.assistant_snippet ?? "",
        createdAt: r.created_at,
      }));
    } catch (e: any) {
      console.error("[Chronicle DB] FTS query execution fallback:", e?.message || String(e));
      return [];
    }
  }

  getActiveProjectPath(): string | undefined {
    const row = this.db
      .prepare(
        "SELECT project_path FROM sessions WHERE project_path IS NOT NULL ORDER BY last_active_at DESC LIMIT 1"
      )
      .get() as { project_path: string } | undefined;
    return row?.project_path;
  }

  close(): void {
    try {
      this.db.close();
    } catch {}
  }

  // ============================================================
  // Transitional Shims for S2 Compatibility
  // ============================================================

  save(session: SessionData, embeddings?: SessionEmbeddings): void {
    legacySaveShim(this, session, embeddings);
  }

  query(options: QueryOptions): QueryResult {
    return legacyQueryShim(this, options);
  }

  search(
    queryVector: number[],
    limit: number,
    options?: { projectPath?: string; scope?: "workspace" | "all" }
  ): SearchResult[] {
    return legacySearchShim(this, queryVector, limit, options);
  }
}

export function legacySaveShim(
  store: HistoryStore,
  session: SessionData,
  embeddings?: SessionEmbeddings
): void {
  const turns: TurnData[] = [];
  const steps: StepData[] = session.steps || [];

  if (session.chunks && session.chunks.length > 0) {
    let idx = 1;
    for (const chunk of session.chunks) {
      const vec = embeddings?.chunks.get(chunk.stepIndex);
      turns.push({
        turnIndex: idx++,
        userPrompt: chunk.text,
        assistantResponse: "",
        turnText: chunk.text,
        turnVector: vec ? Float32Array.from(vec) : new Float32Array(EMBEDDING_DIMENSION),
      });
    }
  }

  store.saveSession(session, turns, steps);
}

export function legacyQueryShim(
  store: HistoryStore,
  options: QueryOptions
): QueryResult {
  let sessions: SessionData[];
  if (options.sessionId) {
    const single = store.getSession(options.sessionId);
    sessions = single ? [single] : [];
  } else {
    sessions = store.listSessions({
      projectPath: options.projectPath,
      scope: options.scope,
      timeRange: options.timeRange,
      limit: options.limit,
      sortBy: options.sortBy,
    });
  }

  const sessionIds = new Set(sessions.map((s) => s.id));
  let matchedSteps: StepData[] = [];
  const matchedChunks: ChunkData[] = [];

  for (const sid of sessionIds) {
    const sSteps = store.getSteps(sid, {
      stepIndex: options.stepIndex,
      category: options.category,
      kind: options.kind || undefined,
      toolName: options.toolName,
      serverName: options.serverName,
      filePath: options.filePath,
      status: (options.stepStatus || options.status) as any,
      includeUndone: options.includeUndone,
    });
    matchedSteps = matchedSteps.concat(sSteps);
  }

  return {
    sessions,
    steps: matchedSteps,
    chunks: matchedChunks,
  };
}

export function legacySearchShim(
  store: HistoryStore,
  queryVector: number[],
  limit: number,
  options?: { projectPath?: string; scope?: "workspace" | "all" }
): SearchResult[] {
  const results = store.searchTurnsVector(queryVector, limit, options);
  return results.map((r) => ({
    sessionId: r.sessionId,
    adapter: "antigravity",
    title: r.title,
    projectPath: r.projectPath,
    stepIndex: r.turnIndex,
    chunkText: r.userPrompt,
    similarity: r.similarity,
  }));
}
