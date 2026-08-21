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
} from "./adapters/types.js";
import {
  vectorToBlob,
  blobToVector,
  cosineSimilarityFloat32,
  EMBEDDING_DIMENSION,
  EMBEDDING_BLOB_SIZE,
} from "./embeddings.js";

// ============================================================
// 1. Interfaces & Option Contracts
// ============================================================

export interface ListSessionsOptions {
  projectPath?: string;
  scope?: "workspace" | "all";
  role?: string;
  hasErrors?: boolean;
  timeRange?: string; // "start:end" epoch ms
  limit?: number;
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
  getSessionRelationship(
    sessionId: string,
    maxDepth?: number,
    includeAncestors?: boolean
  ): SessionRelationshipResult | null;
  getArtifacts(sessionId: string, includeSubtree?: boolean): string[];
  searchTurnsVector(
    queryVector: Float32Array | Buffer | number[],
    limit: number,
    options?: { projectPath?: string; scope?: "workspace" | "all" }
  ): VectorSearchResult[];
  searchTurnsFTS(
    queryText: string,
    limit: number,
    options?: { projectPath?: string; scope?: "workspace" | "all" }
  ): FTSSearchResult[];
  getActiveProjectPath(): string | undefined;
  close(): void;

  /** @deprecated Transitional shim for S2 compatibility */
  save(session: SessionData, embeddings?: SessionEmbeddings): void;
  /** @deprecated Transitional shim for S2 compatibility */
  query(options: QueryOptions): QueryResult;
  /** @deprecated Transitional shim for S2 compatibility */
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
      metadata TEXT
    );

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
    const sessionCopy: SessionData = {
      ...session,
      artifacts: session.artifacts ? [...session.artifacts] : [],
      filesTouched: session.filesTouched ? [...session.filesTouched] : [],
      metadata: session.metadata ? { ...session.metadata } : {},
      turns: turns ? turns.map((t) => ({ ...t })) : [],
      steps: steps ? steps.map((s) => ({ ...s })) : [],
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

    if (session.subagentIds && session.subagentIds.length > 0) {
      for (const childId of session.subagentIds) {
        const child = this.sessionsMap.get(childId);
        if (child) {
          child.parentId = session.id;
        }
      }
    }
  }

  getSession(id: string): SessionData | null {
    const session = this.sessionsMap.get(id);
    if (!session) return null;
    return {
      ...session,
      turns: this.getTurns(id, { includeUndone: true }),
      steps: this.getSteps(id, { includeUndone: true }),
    };
  }

  listSessions(options: ListSessionsOptions = {}): SessionData[] {
    let sessions = Array.from(this.sessionsMap.values());

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

    if (options.limit !== undefined) {
      sessions = sessions.slice(0, options.limit);
    }

    return sessions.map((s) => ({ ...s }));
  }

  getTurns(sessionId: string, options: GetTurnsOptions = {}): TurnData[] {
    let turns = (this.turnsMap.get(sessionId) || []).map((t) => ({ ...t }));

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
    let steps = (this.stepsMap.get(sessionId) || []).map((s) => ({ ...s }));

    if (!options.includeUndone) {
      steps = steps.filter((s) => !s.isUndone);
    }

    if (options.turnIndex !== undefined) {
      const turns = this.turnsMap.get(sessionId) || [];
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
      const fp = options.filePath.toLowerCase();
      steps = steps.filter((s) => s.filePath?.toLowerCase().includes(fp));
    }
    if (options.toolName !== undefined || options.serverName !== undefined) {
      steps = steps.filter((s) => {
        if (s.toolName) {
          if (Array.isArray(options.toolName)) {
            if (!options.toolName.includes(s.toolName)) return false;
          } else if (options.toolName && s.toolName !== options.toolName) {
            return false;
          }
        }
        if (options.serverName && s.serverName !== options.serverName) {
          return false;
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

  getSessionRelationship(
    sessionId: string,
    maxDepth = 10,
    includeAncestors = true
  ): SessionRelationshipResult | null {
    const currentSession = this.sessionsMap.get(sessionId);
    if (!currentSession) return null;

    const buildNode = (s: SessionData, currentDepth: number): SessionRelationshipNode => {
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
        mandate: s.firstPrompt,
        artifacts: s.artifacts ? [...s.artifacts] : [],
      };

      if (currentDepth < maxDepth) {
        const directChildren = Array.from(this.sessionsMap.values()).filter(
          (cand) => cand.parentId === s.id
        );
        if (directChildren.length > 0) {
          node.children = directChildren.map((c) => buildNode(c, currentDepth + 1));
        }
      }
      return node;
    };

    const ancestors: SessionRelationshipNode[] = [];
    let rootSessionId = currentSession.id;

    if (includeAncestors) {
      let curParentId = currentSession.parentId;
      let depthCounter = 1;
      while (curParentId && depthCounter <= 10) {
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
          mandate: pSession.firstPrompt,
          artifacts: pSession.artifacts ? [...pSession.artifacts] : [],
        });
        rootSessionId = pSession.id;
        curParentId = pSession.parentId;
        depthCounter++;
      }
    }

    const parentNode =
      currentSession.parentId && this.sessionsMap.get(currentSession.parentId)
        ? buildNode(this.sessionsMap.get(currentSession.parentId)!, 0)
        : null;

    const directChildren = Array.from(this.sessionsMap.values()).filter(
      (s) => s.parentId === currentSession.id
    );
    const childrenNodes = directChildren.map((c) => buildNode(c, 1));

    const siblings = currentSession.parentId
      ? Array.from(this.sessionsMap.values())
          .filter((s) => s.parentId === currentSession.parentId && s.id !== currentSession.id)
          .map((s) => buildNode(s, 0))
      : [];

    return {
      sessionId: currentSession.id,
      rootSessionId,
      parent: parentNode,
      ancestors,
      current: buildNode(currentSession, 0),
      children: childrenNodes,
      siblings,
    };
  }

  getArtifacts(sessionId: string, includeSubtree = false): string[] {
    const session = this.sessionsMap.get(sessionId);
    if (!session) return [];

    const artifacts = new Set<string>(session.artifacts || []);

    if (includeSubtree) {
      const gatherChildren = (parentId: string, depth: number) => {
        if (depth > 10) return;
        const children = Array.from(this.sessionsMap.values()).filter(
          (s) => s.parentId === parentId
        );
        for (const child of children) {
          if (child.artifacts) {
            for (const a of child.artifacts) {
              artifacts.add(a);
            }
          }
          gatherChildren(child.id, depth + 1);
        }
      };
      gatherChildren(sessionId, 1);
    }

    return Array.from(artifacts);
  }

  searchTurnsVector(
    queryVector: Float32Array | Buffer | number[],
    limit: number,
    options: { projectPath?: string; scope?: "workspace" | "all" } = {}
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

      if (resolvedProjectPath !== undefined) {
        if (
          !session.projectPath ||
          !session.projectPath.toLowerCase().includes(resolvedProjectPath.toLowerCase())
        ) {
          continue;
        }
      }

      for (const turn of turns) {
        if (turn.isUndone) continue;
        if (!turn.turnVector) continue;
        const tVec =
          turn.turnVector instanceof Float32Array
            ? turn.turnVector
            : Float32Array.from(turn.turnVector as number[]);
        const similarity = cosineSimilarityFloat32(floatVec, tVec);

        results.push({
          sessionId: sid,
          turnIndex: turn.turnIndex,
          title: session.title,
          role: session.role,
          projectPath: session.projectPath,
          similarity,
          userPrompt: turn.userPrompt,
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
    options: { projectPath?: string; scope?: "workspace" | "all" } = {}
  ): FTSSearchResult[] {
    const query = queryText.toLowerCase();
    let resolvedProjectPath = options.projectPath;
    if (resolvedProjectPath === undefined && options.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    const results: FTSSearchResult[] = [];

    for (const [sid, turns] of this.turnsMap.entries()) {
      const session = this.sessionsMap.get(sid);
      if (!session) continue;

      if (resolvedProjectPath !== undefined) {
        if (
          !session.projectPath ||
          !session.projectPath.toLowerCase().includes(resolvedProjectPath.toLowerCase())
        ) {
          continue;
        }
      }

      for (const turn of turns) {
        if (turn.isUndone) continue;
        const promptMatch = turn.userPrompt?.toLowerCase().includes(query);
        const respMatch = turn.assistantResponse?.toLowerCase().includes(query);
        const textMatch = turn.turnText?.toLowerCase().includes(query);

        if (promptMatch || respMatch || textMatch) {
          results.push({
            sessionId: sid,
            turnIndex: turn.turnIndex,
            title: session.title,
            role: session.role,
            projectPath: session.projectPath,
            rank: -1,
            userPrompt: turn.userPrompt,
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

    this.saveSession(session, turns, steps);
  }

  query(options: QueryOptions): QueryResult {
    const sessions = this.listSessions({
      projectPath: options.projectPath,
      scope: options.scope,
      timeRange: options.timeRange,
      limit: options.limit,
      sortBy: options.sortBy,
    });

    const sessionIds = new Set(sessions.map((s) => s.id));
    let matchedSteps: StepData[] = [];
    const matchedChunks: ChunkData[] = [];

    for (const sid of sessionIds) {
      const sSteps = this.getSteps(sid, {
        stepIndex: options.stepIndex,
        category: options.categories ? undefined : undefined,
        status: options.stepStatus as any,
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

  search(
    queryVector: number[],
    limit: number,
    options?: { projectPath?: string; scope?: "workspace" | "all" }
  ): SearchResult[] {
    const results = this.searchTurnsVector(queryVector, limit, options);
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
      let parentId = session.parentId || null;
      if (!parentId) {
        const existing = db
          .prepare("SELECT parent_id FROM sessions WHERE id = ?")
          .get(session.id) as { parent_id: string | null } | undefined;
        if (existing) {
          parentId = existing.parent_id;
        }
      }

      let rootId = session.rootId || null;
      if (!rootId && parentId) {
        const parentRow = db
          .prepare("SELECT root_id FROM sessions WHERE id = ?")
          .get(parentId) as { root_id: string | null } | undefined;
        rootId = parentRow?.root_id || parentId;
      }

      const stepTimestamps = (steps || session.steps || [])
        .map((s) => s.createdAt)
        .filter((t): t is number => t !== undefined);
      const lastActiveAt =
        stepTimestamps.length > 0
          ? Math.max(...stepTimestamps)
          : session.lastActiveAt ?? session.createdAt;

      const artifactsJson = session.artifacts ? JSON.stringify(session.artifacts) : null;
      const filesTouchedJson = session.filesTouched
        ? JSON.stringify(session.filesTouched)
        : null;
      const metadataJson = session.metadata ? JSON.stringify(session.metadata) : null;

      const totalTurns = turns ? turns.length : session.totalTurns ?? 0;
      const totalSteps = steps ? steps.length : session.totalSteps ?? 0;

      db.prepare(`
        INSERT INTO sessions (
          id, adapter, title, role, project_path, created_at, last_active_at,
          parent_id, root_id, depth, total_turns, total_steps, total_tokens,
          artifacts, files_touched, first_prompt, metadata
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          role = COALESCE(excluded.role, role),
          project_path = excluded.project_path,
          created_at = excluded.created_at,
          last_active_at = excluded.last_active_at,
          parent_id = COALESCE(excluded.parent_id, parent_id),
          root_id = COALESCE(excluded.root_id, root_id),
          depth = excluded.depth,
          total_turns = excluded.total_turns,
          total_steps = excluded.total_steps,
          total_tokens = excluded.total_tokens,
          artifacts = COALESCE(excluded.artifacts, artifacts),
          files_touched = COALESCE(excluded.files_touched, files_touched),
          first_prompt = excluded.first_prompt,
          metadata = COALESCE(excluded.metadata, metadata)
      `).run(
        session.id,
        session.adapter,
        session.title,
        session.role ?? null,
        session.projectPath ?? null,
        session.createdAt,
        lastActiveAt,
        parentId,
        rootId,
        session.depth ?? 0,
        totalTurns,
        totalSteps,
        session.totalTokens ?? 0,
        artifactsJson,
        filesTouchedJson,
        session.firstPrompt,
        metadataJson
      );

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
            turn.userPrompt,
            turn.assistantResponse ?? null,
            turn.turnSummary ?? null,
            turn.turnText,
            vectorBlob,
            turn.inputTokens ?? 0,
            turn.outputTokens ?? 0,
            turn.thinkingTokens ?? 0,
            turn.toolCount ?? 0,
            turn.errorCount ?? 0,
            turn.durationMs ?? 0,
            turn.isUndone ? 1 : 0,
            turn.createdAt ?? session.createdAt
          );
        }
      }

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
            step.status,
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
            step.createdAt ?? session.createdAt,
            step.isUndone ? 1 : 0
          );
        }
      }

      if (session.subagentIds && session.subagentIds.length > 0) {
        const updateChild = db.prepare("UPDATE sessions SET parent_id = ? WHERE id = ?");
        for (const childId of session.subagentIds) {
          updateChild.run(session.id, childId);
        }
      }

      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  }

  getSession(id: string): SessionData | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
    if (!row) return null;

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
      turns: this.getTurns(id, { includeUndone: true }),
      steps: this.getSteps(id, { includeUndone: true }),
    };
  }

  listSessions(options: ListSessionsOptions = {}): SessionData[] {
    let sql = `SELECT * FROM sessions`;
    const where: string[] = [];
    const params: any[] = [];

    if (options.role !== undefined) {
      where.push("role = ?");
      params.push(options.role);
    }

    let resolvedProjectPath = options.projectPath;
    if (resolvedProjectPath === undefined && options.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    if (resolvedProjectPath !== undefined) {
      where.push("LOWER(project_path) LIKE ?");
      params.push(`%${resolvedProjectPath.toLowerCase()}%`);
    }

    if (options.hasErrors === true) {
      where.push(
        "EXISTS (SELECT 1 FROM transcript_turns WHERE session_id = sessions.id AND error_count > 0)"
      );
    }

    if (options.timeRange !== undefined) {
      const range = parseTimeRange(options.timeRange);
      if (range) {
        if (range.start !== null) {
          where.push("last_active_at >= ?");
          params.push(range.start);
        }
        if (range.end !== null) {
          where.push("last_active_at <= ?");
          params.push(range.end);
        }
      }
    }

    if (where.length > 0) {
      sql += " WHERE " + where.join(" AND ");
    }

    const sortBy = options.sortBy || "active";
    sql += sortBy === "created" ? " ORDER BY created_at DESC" : " ORDER BY last_active_at DESC";

    if (options.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(options.limit);
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
      artifacts: r.artifacts ? JSON.parse(r.artifacts) : [],
      filesTouched: r.files_touched ? JSON.parse(r.files_touched) : [],
      firstPrompt: r.first_prompt,
      metadata: r.metadata ? JSON.parse(r.metadata) : {},
    }));
  }

  getTurns(sessionId: string, options: GetTurnsOptions = {}): TurnData[] {
    const maxRow = this.db
      .prepare("SELECT MAX(turn_index) as max_idx FROM transcript_turns WHERE session_id = ?")
      .get(sessionId) as { max_idx: number | null } | undefined;
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
    const params: any[] = [sessionId];

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
      params.push(sessionId, options.lastTurns);
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
    let sql = `SELECT * FROM transcript_steps WHERE session_id = ?`;
    const params: any[] = [sessionId];

    if (!options.includeUndone) {
      sql += ` AND is_undone = 0`;
    }

    if (options.turnIndex !== undefined) {
      const maxRow = this.db
        .prepare("SELECT MAX(turn_index) as max_idx FROM transcript_turns WHERE session_id = ?")
        .get(sessionId) as { max_idx: number | null } | undefined;
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
      sql += ` AND LOWER(file_path) LIKE ?`;
      params.push(`%${options.filePath.toLowerCase()}%`);
    }

    if (options.toolName !== undefined) {
      if (Array.isArray(options.toolName)) {
        const placeholders = options.toolName.map(() => "?").join(",");
        sql += ` AND tool_name IN (${placeholders})`;
        params.push(...options.toolName);
      } else {
        sql += ` AND tool_name = ?`;
        params.push(options.toolName);
      }
    }

    if (options.serverName !== undefined) {
      sql += ` AND server_name = ?`;
      params.push(options.serverName);
    }

    sql += ` ORDER BY turn_index ASC, step_order ASC`;

    if (options.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
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
    }));
  }

  getSessionRelationship(
    sessionId: string,
    maxDepth = 10,
    includeAncestors = true
  ): SessionRelationshipResult | null {
    const current = this.getSession(sessionId);
    if (!current) return null;

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
        ancestors.push({
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
          mandate: row.first_prompt,
          artifacts: row.artifacts ? JSON.parse(row.artifacts) : [],
        });
      }
      if (ancestors.length > 0) {
        rootSessionId = ancestors[0].id;
      }
    }

    const parentNode = current.parentId
      ? ancestors.find((a) => a.id === current.parentId) ||
        (this.getSession(current.parentId) as any)
      : null;

    // Direct children
    const childSql = `
      SELECT * FROM sessions WHERE parent_id = ?
    `;
    const childRows = this.db.prepare(childSql).all(current.id) as any[];
    const childrenNodes: SessionRelationshipNode[] = childRows.map((r) => ({
      id: r.id,
      adapter: r.adapter,
      title: r.title,
      role: r.role ?? undefined,
      projectPath: r.project_path,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
      parentId: r.parent_id,
      rootId: r.root_id,
      depth: 1,
      totalTurns: r.total_turns,
      mandate: r.first_prompt,
      artifacts: r.artifacts ? JSON.parse(r.artifacts) : [],
    }));

    // Siblings
    let siblings: SessionRelationshipNode[] = [];
    if (current.parentId) {
      const sibRows = this.db
        .prepare("SELECT * FROM sessions WHERE parent_id = ? AND id != ?")
        .all(current.parentId, current.id) as any[];
      siblings = sibRows.map((r) => ({
        id: r.id,
        adapter: r.adapter,
        title: r.title,
        role: r.role ?? undefined,
        projectPath: r.project_path,
        createdAt: r.created_at,
        lastActiveAt: r.last_active_at,
        parentId: r.parent_id,
        rootId: r.root_id,
        depth: 0,
        totalTurns: r.total_turns,
        mandate: r.first_prompt,
        artifacts: r.artifacts ? JSON.parse(r.artifacts) : [],
      }));
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
      mandate: current.firstPrompt,
      artifacts: current.artifacts,
      children: childrenNodes,
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

  getArtifacts(sessionId: string, includeSubtree = false): string[] {
    if (!includeSubtree) {
      const session = this.getSession(sessionId);
      return session?.artifacts || [];
    }

    const sql = `
      WITH RECURSIVE subtree_cte(id, depth) AS (
        SELECT id, 0 FROM sessions WHERE id = ?
        UNION ALL
        SELECT s.id, st.depth + 1
        FROM sessions s
        JOIN subtree_cte st ON s.parent_id = st.id
        WHERE st.depth < 10
      )
      SELECT artifacts FROM sessions
      WHERE id IN (SELECT id FROM subtree_cte) AND artifacts IS NOT NULL
    `;
    const rows = this.db.prepare(sql).all(sessionId) as { artifacts: string }[];
    const result = new Set<string>();

    for (const r of rows) {
      if (r.artifacts) {
        try {
          const arr = JSON.parse(r.artifacts);
          if (Array.isArray(arr)) {
            for (const a of arr) result.add(a);
          }
        } catch {}
      }
    }

    return Array.from(result);
  }

  searchTurnsVector(
    queryVector: Float32Array | Buffer | number[],
    limit: number,
    options: { projectPath?: string; scope?: "workspace" | "all" } = {}
  ): VectorSearchResult[] {
    const floatVec = normalizeQueryVector(queryVector);

    let resolvedProjectPath = options.projectPath;
    if (resolvedProjectPath === undefined && options.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    let sql = `
      SELECT t.session_id, t.turn_index, t.user_prompt, t.assistant_response,
             t.turn_vector, t.created_at, s.title, s.role, s.project_path
      FROM transcript_turns t
      JOIN sessions s ON t.session_id = s.id
      WHERE t.is_undone = 0
    `;
    const params: any[] = [];

    if (resolvedProjectPath !== undefined) {
      sql += " AND LOWER(s.project_path) LIKE ?";
      params.push(`%${resolvedProjectPath.toLowerCase()}%`);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    const results: VectorSearchResult[] = [];

    for (const row of rows) {
      if (!row.turn_vector) continue;
      const turnVec = blobToVector(row.turn_vector);
      const similarity = cosineSimilarityFloat32(floatVec, turnVec);

      results.push({
        sessionId: row.session_id,
        turnIndex: row.turn_index,
        title: row.title,
        role: row.role ?? undefined,
        projectPath: row.project_path,
        similarity,
        userPrompt: row.user_prompt,
        assistantSnippet: (row.assistant_response || "").slice(0, 200),
        createdAt: row.created_at,
      });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  searchTurnsFTS(
    queryText: string,
    limit: number,
    options: { projectPath?: string; scope?: "workspace" | "all" } = {}
  ): FTSSearchResult[] {
    let resolvedProjectPath = options.projectPath;
    if (resolvedProjectPath === undefined && options.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    let sql = `
      SELECT f.rowid, f.user_prompt, f.assistant_response, f.turn_text,
             bm25(transcript_turns_fts) as rank,
             t.session_id, t.turn_index, t.created_at,
             s.title, s.role, s.project_path
      FROM transcript_turns_fts f
      JOIN transcript_turns t ON f.rowid = t.id
      JOIN sessions s ON t.session_id = s.id
      WHERE transcript_turns_fts MATCH ? AND t.is_undone = 0
    `;
    const params: any[] = [queryText];

    if (resolvedProjectPath !== undefined) {
      sql += " AND LOWER(s.project_path) LIKE ?";
      params.push(`%${resolvedProjectPath.toLowerCase()}%`);
    }

    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
      sessionId: r.session_id,
      turnIndex: r.turn_index,
      title: r.title,
      role: r.role ?? undefined,
      projectPath: r.project_path,
      rank: r.rank,
      userPrompt: r.user_prompt,
      assistantSnippet: (r.assistant_response || "").slice(0, 200),
      createdAt: r.created_at,
    }));
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
    // DatabaseSync instances don't require manual close unless needed
  }

  // ============================================================
  // Transitional Shims for S2 Compatibility
  // ============================================================

  save(session: SessionData, embeddings?: SessionEmbeddings): void {
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

    this.saveSession(session, turns, steps);
  }

  query(options: QueryOptions): QueryResult {
    const sessions = this.listSessions({
      projectPath: options.projectPath,
      scope: options.scope,
      timeRange: options.timeRange,
      limit: options.limit,
      sortBy: options.sortBy,
    });

    const sessionIds = new Set(sessions.map((s) => s.id));
    let matchedSteps: StepData[] = [];
    const matchedChunks: ChunkData[] = [];

    for (const sid of sessionIds) {
      const sSteps = this.getSteps(sid, {
        stepIndex: options.stepIndex,
        status: options.stepStatus as any,
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

  search(
    queryVector: number[],
    limit: number,
    options?: { projectPath?: string; scope?: "workspace" | "all" }
  ): SearchResult[] {
    const results = this.searchTurnsVector(queryVector, limit, options);
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
}
