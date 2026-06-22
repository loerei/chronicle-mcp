import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { SessionData, StepData, ChunkData } from "./adapters/types.js";

function matchToolCall(call: any, targetServer?: string, targetTool?: string): boolean {
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
    matchesTool = callTool === targetTool || callTool.endsWith("/" + targetTool) || name === targetTool || name.endsWith("/" + targetTool);
  }
  if (targetServer !== undefined) {
    matchesServer = callServer === targetServer || name.startsWith(targetServer + "/") || name.includes("_" + targetServer + "_");
  }

  return matchesTool && matchesServer;
}

const DB_DIR = path.join(os.homedir(), ".config", "chronicle-mcp");
const DB_PATH = path.join(DB_DIR, "history.db");

// Ensure directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

let dbInstance: DatabaseSync | null = null;

export function setDb(db: DatabaseSync): void {
  dbInstance = db;
}

export function getDb(): DatabaseSync {
  if (dbInstance) {
    return dbInstance;
  }

  const db = new DatabaseSync(DB_PATH);
  dbInstance = db;

  // Check if session_chunks needs migration (missing UNIQUE constraint)
  let needsMigration = false;
  try {
    const tableSqlRow = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type='table' AND name='session_chunks'
    `).get() as { sql: string } | undefined;

    if (tableSqlRow?.sql && !tableSqlRow.sql.includes("UNIQUE")) {
      needsMigration = true;
    }
  } catch (e) {
    // Table might not exist yet, which is fine
    console.debug?.("[Chronicle MCP] Table check for migration failed:", e);
  }

  if (needsMigration) {
    console.error("[Chronicle MCP] Upgrading session_chunks table schema to add UNIQUE constraint...");
    db.exec(`
      BEGIN TRANSACTION;
      ALTER TABLE session_chunks RENAME TO session_chunks_old;
      
      CREATE TABLE session_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        step_index INTEGER,
        chunk_text TEXT NOT NULL,
        chunk_vector TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        UNIQUE(session_id, step_index) ON CONFLICT IGNORE
      );

      INSERT OR IGNORE INTO session_chunks (session_id, step_index, chunk_text, chunk_vector)
      SELECT session_id, step_index, chunk_text, chunk_vector FROM session_chunks_old;

      DROP TABLE session_chunks_old;
      COMMIT;
    `);
    console.error("[Chronicle MCP] Database upgrade completed successfully.");
  }

  // Initialize tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      adapter TEXT NOT NULL,
      title TEXT NOT NULL,
      project_path TEXT,
      created_at INTEGER,
      last_active_at INTEGER,
      first_prompt TEXT,
      second_prompt TEXT,
      summary_vector TEXT,
      parent_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);

    CREATE TABLE IF NOT EXISTS session_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      step_index INTEGER,
      chunk_text TEXT NOT NULL,
      chunk_vector TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      UNIQUE(session_id, step_index) ON CONFLICT IGNORE
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_session ON session_chunks(session_id);

    CREATE TABLE IF NOT EXISTS session_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      content TEXT,
      thinking TEXT,
      tool_calls TEXT,
      created_at INTEGER,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      UNIQUE(session_id, step_index) ON CONFLICT IGNORE
    );

    CREATE INDEX IF NOT EXISTS idx_steps_session ON session_steps(session_id);
  `);

  try {
    db.exec("ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;");
  } catch (e: any) {
    if (!e?.message?.includes("duplicate column name")) {
      console.debug?.("[Chronicle MCP] Alter table parent_id failed:", e);
    }
  }

  try {
    db.exec("ALTER TABLE sessions ADD COLUMN last_active_at INTEGER;");
  } catch (e: any) {
    if (!e?.message?.includes("duplicate column name")) {
      console.debug?.("[Chronicle MCP] Alter table last_active_at failed:", e);
    }
  }

  return db;
}

export interface SessionEmbeddings {
  summary?: number[];
  chunks: Map<number, number[]>; // maps stepIndex -> chunkVector
}

export interface QueryOptions {
  sessionId?: string;
  adapter?: string;
  projectPath?: string;
  scope?: "workspace" | "all";
  startStep?: number;
  endStep?: number;
  stepQuery?: string;
  stepType?: string;
  stepStatus?: string;
  includeSteps?: boolean;
  limit?: number;
  toolName?: string;
  serverName?: string;
  excludeContent?: boolean;
  timeRange?: string; // Format: "start:end"
  sortBy?: "created" | "active";
  conversationStepsOnly?: boolean;
  reverseSteps?: boolean;
  startConversationStep?: number;
  endConversationStep?: number;
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
  projectPath: string | null;
  stepIndex: number | null;
  chunkText: string;
  similarity: number;
}

export interface HistoryStore {
  save(session: SessionData, embeddings: SessionEmbeddings): void;
  query(options: QueryOptions): QueryResult;
  search(queryVector: number[], limit: number, options?: { projectPath?: string; scope?: "workspace" | "all" }): SearchResult[];
  getActiveProjectPath(): string | undefined;
  close(): void;
}

function dotProduct(a: number[], b: number[]): number {
  let val = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    val += a[i] * b[i];
  }
  return val;
}

function parseTimeRange(timeRange: string): { start: number | null; end: number | null } | null {
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
    end: parseVal(parts[1])
  };
}

export class InMemoryHistoryStore implements HistoryStore {
  private readonly sessionsMap = new Map<string, Omit<SessionData, "chunks"> & { summary_vector?: number[] }>();
  private readonly stepsMap = new Map<string, StepData[]>();
  private readonly chunksMap = new Map<string, Array<ChunkData & { chunk_vector: number[] }>>();

  private copyChunks(session: SessionData, embeddings: SessionEmbeddings, chunksByStepIndex: Map<number, ChunkData & { chunk_vector: number[] }>): Array<ChunkData & { chunk_vector: number[] }> {
    const chunksCopy: Array<ChunkData & { chunk_vector: number[] }> = [];
    const seenChunkIndexes = new Set<number>();
    for (const chunk of session.chunks) {
      if (seenChunkIndexes.has(chunk.stepIndex)) {
        continue;
      }
      seenChunkIndexes.add(chunk.stepIndex);
      
      const existingChunk = chunksByStepIndex.get(chunk.stepIndex);
      const vec = embeddings.chunks.get(chunk.stepIndex) || (existingChunk ? existingChunk.chunk_vector : []);
      
      chunksCopy.push({
        stepIndex: chunk.stepIndex,
        text: chunk.text,
        chunk_vector: [...vec]
      });
    }
    return chunksCopy;
  }

  private copySteps(session: SessionData): StepData[] {
    const stepsCopy: StepData[] = [];
    const seenStepIndexes = new Set<number>();
    if (session.steps) {
      for (const step of session.steps) {
        if (seenStepIndexes.has(step.stepIndex)) {
          continue;
        }
        seenStepIndexes.add(step.stepIndex);
        stepsCopy.push({
          stepIndex: step.stepIndex,
          type: step.type,
          source: step.source,
          status: step.status,
          content: step.content,
          thinking: step.thinking,
          toolCalls: step.toolCalls,
          createdAt: step.createdAt
        });
      }
    }
    return stepsCopy;
  }

  private updateSubagents(subagentIds: string[], parentId: string): void {
    for (const childId of subagentIds) {
      const childSession = this.sessionsMap.get(childId);
      if (childSession) {
        (childSession as any).parentId = parentId;
      }
    }
  }

  private filterSessionsByTimeRange(sessions: any[], timeRange: string): any[] {
    const range = parseTimeRange(timeRange);
    if (!range) return sessions;
    return sessions.filter(s => {
      const activeTime = (s as any).lastActiveAt ?? s.createdAt;
      if (range.start !== null && activeTime < range.start) return false;
      if (range.end !== null && activeTime > range.end) return false;
      return true;
    });
  }

  private filterSessions(options: QueryOptions): any[] {
    let matchedSessions = Array.from(this.sessionsMap.values());

    if (options.sessionId !== undefined) {
      matchedSessions = matchedSessions.filter(s => s.id === options.sessionId);
    }
    if (options.adapter !== undefined) {
      matchedSessions = matchedSessions.filter(s => s.adapter === options.adapter);
    }
    
    let resolvedProjectPath = options.projectPath;
    if (resolvedProjectPath === undefined && options.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    if (resolvedProjectPath !== undefined) {
      const pathFilter = resolvedProjectPath.toLowerCase();
      matchedSessions = matchedSessions.filter(s => 
        s.projectPath?.toLowerCase().includes(pathFilter)
      );
    }

    if (options.timeRange !== undefined) {
      matchedSessions = this.filterSessionsByTimeRange(matchedSessions, options.timeRange);
    }

    const sortBy = options.sortBy || "active";
    matchedSessions.sort((a, b) => {
      const timeA = sortBy === "created" ? a.createdAt : ((a as any).lastActiveAt ?? a.createdAt);
      const timeB = sortBy === "created" ? b.createdAt : ((b as any).lastActiveAt ?? b.createdAt);
      return timeB - timeA;
    });

    if (options.limit !== undefined) {
      matchedSessions = matchedSessions.slice(0, options.limit);
    }
    return matchedSessions;
  }

  private filterChunks(sessionIds: Set<string>, options: QueryOptions): ChunkData[] {
    const matchedChunks: ChunkData[] = [];
    for (const [sid, chunks] of this.chunksMap.entries()) {
      if (!sessionIds.has(sid)) continue;
      for (const chunk of chunks) {
        if (options.startStep !== undefined && chunk.stepIndex < options.startStep) continue;
        if (options.endStep !== undefined && chunk.stepIndex > options.endStep) continue;
        matchedChunks.push({
          stepIndex: chunk.stepIndex,
          text: chunk.text
        });
      }
    }
    return matchedChunks;
  }

  private matchStepQuery(step: StepData, query: string): boolean {
    const contentMatch = step.content?.toLowerCase().includes(query);
    const thinkingMatch = step.thinking?.toLowerCase().includes(query);
    const toolCallsMatch = step.toolCalls?.toLowerCase().includes(query);
    return !!(contentMatch || thinkingMatch || toolCallsMatch);
  }

  private matchStepTool(step: StepData, serverName?: string, toolName?: string): boolean {
    if (!step.toolCalls) return false;
    try {
      const calls = JSON.parse(step.toolCalls);
      if (!Array.isArray(calls)) return false;
      return calls.some(call => matchToolCall(call, serverName, toolName));
    } catch {
      return false;
    }
  }

  private isConversationStep(step: StepData): boolean {
    if (step.type === "USER_INPUT") return true;
    return !!(step.type === "PLANNER_RESPONSE" && step.content?.trim());
  }

  private matchStepQueryAndTool(step: StepData, options: QueryOptions): boolean {
    if (options.stepQuery !== undefined && !this.matchStepQuery(step, options.stepQuery.toLowerCase())) return false;
    if (options.toolName !== undefined || options.serverName !== undefined) {
      if (!this.matchStepTool(step, options.serverName, options.toolName)) return false;
    }
    return true;
  }

  private matchStep(step: StepData, options: QueryOptions): boolean {
    if (options.startStep !== undefined && step.stepIndex < options.startStep) return false;
    if (options.endStep !== undefined && step.stepIndex > options.endStep) return false;
    if (options.stepType !== undefined && step.type !== options.stepType) return false;
    if (options.stepStatus !== undefined && step.status !== options.stepStatus) return false;
    if (options.conversationStepsOnly && !this.isConversationStep(step)) return false;
    return this.matchStepQueryAndTool(step, options);
  }

  private filterSteps(sessionIds: Set<string>, options: QueryOptions): StepData[] {
    const matchedSteps: StepData[] = [];
    if (!options.includeSteps) return matchedSteps;

    for (const [sid, steps] of this.stepsMap.entries()) {
      if (!sessionIds.has(sid)) continue;
      for (const step of steps) {
        if (!this.matchStep(step, options)) continue;

        const stepCopy = { ...step };
        if (options.excludeContent) {
          delete stepCopy.content;
          delete stepCopy.thinking;
        }
        matchedSteps.push(stepCopy);
      }
    }
    return matchedSteps;
  }

  save(session: SessionData, embeddings: SessionEmbeddings): void {
    const sessionId = session.id;

    let parentId = session.parentId || null;
    if (!parentId) {
      const existing = this.sessionsMap.get(sessionId);
      if (existing && (existing as any).parentId) {
        parentId = (existing as any).parentId;
      }
    }
    
    const existingSession = this.sessionsMap.get(sessionId);
    let summaryVector = undefined;
    if (embeddings.summary) {
      summaryVector = [...embeddings.summary];
    } else if (existingSession) {
      summaryVector = (existingSession as any).summary_vector;
    }

    const stepTimestamps = (session.steps || []).map(s => s.createdAt).filter((t): t is number => t !== undefined);
    const lastActiveAt = stepTimestamps.length > 0 ? Math.max(...stepTimestamps) : (session.lastActiveAt ?? session.createdAt);

    const sessionCopy = {
      id: session.id,
      adapter: session.adapter,
      title: session.title,
      projectPath: session.projectPath,
      createdAt: session.createdAt,
      lastActiveAt,
      firstPrompt: session.firstPrompt,
      secondPrompt: session.secondPrompt,
      parentId,
      subagentIds: session.subagentIds || [],
      summary_vector: summaryVector
    };

    const existingChunks = this.chunksMap.get(sessionId) || [];
    const chunksByStepIndex = new Map(existingChunks.map(c => [c.stepIndex, c]));
    const chunksCopy = this.copyChunks(session, embeddings, chunksByStepIndex);
    const stepsCopy = this.copySteps(session);

    this.sessionsMap.set(sessionId, sessionCopy);
    this.chunksMap.set(sessionId, chunksCopy);
    this.stepsMap.set(sessionId, stepsCopy);

    if (session.subagentIds && session.subagentIds.length > 0) {
      this.updateSubagents(session.subagentIds, session.id);
    }
  }

  private resolveConversationSteps(queryOpts: QueryOptions): void {
    if (!queryOpts.sessionId) return;
    if (queryOpts.startConversationStep === undefined && queryOpts.endConversationStep === undefined) return;

    const steps = this.stepsMap.get(queryOpts.sessionId) || [];
    const convSteps = steps
      .filter(s => s.type === "USER_INPUT" || (s.type === "PLANNER_RESPONSE" && s.content && s.content.trim() !== ""))
      .sort((a, b) => a.stepIndex - b.stepIndex);

    if (queryOpts.startConversationStep !== undefined) {
      const idx = queryOpts.startConversationStep - 1;
      queryOpts.startStep = (idx >= 0 && idx < convSteps.length) ? convSteps[idx].stepIndex : Infinity;
    }
    if (queryOpts.endConversationStep !== undefined) {
      const idx = queryOpts.endConversationStep - 1;
      if (idx >= 0 && idx < convSteps.length) {
        queryOpts.endStep = convSteps[idx].stepIndex;
      } else if (idx < 0) {
        queryOpts.endStep = -1;
      }
    }
  }

  query(options: QueryOptions): QueryResult {
    const queryOpts = { ...options };
    this.resolveConversationSteps(queryOpts);
    const matchedSessions = this.filterSessions(queryOpts);
    const sessionIds = new Set(matchedSessions.map(s => s.id));

    const matchedChunks = this.filterChunks(sessionIds, queryOpts);
    const matchedSteps = this.filterSteps(sessionIds, queryOpts);

    if (queryOpts.reverseSteps) {
      matchedSteps.reverse();
      matchedChunks.reverse();
    }

    const sessionsResult = matchedSessions.map(s => {
      const sessionChunks = (this.chunksMap.get(s.id) || [])
        .filter(c => {
          if (queryOpts.startStep !== undefined && c.stepIndex < queryOpts.startStep) return false;
          if (queryOpts.endStep !== undefined && c.stepIndex > queryOpts.endStep) return false;
          return true;
        })
        .map(c => ({ stepIndex: c.stepIndex, text: c.text }));

      if (queryOpts.reverseSteps) {
        sessionChunks.reverse();
      }

      const sessionSteps = queryOpts.includeSteps ? (this.stepsMap.get(s.id) || [])
        .filter(step => this.matchStep(step, queryOpts))
        .map(step => {
          const stepCopy = { ...step };
          if (queryOpts.excludeContent) {
            delete stepCopy.content;
            delete stepCopy.thinking;
          }
          return stepCopy;
        }) : undefined;

      if (sessionSteps && queryOpts.reverseSteps) {
        sessionSteps.reverse();
      }

      return {
        id: s.id,
        adapter: s.adapter,
        title: s.title,
        projectPath: s.projectPath,
        createdAt: s.createdAt,
        lastActiveAt: (s as any).lastActiveAt ?? s.createdAt,
        firstPrompt: s.firstPrompt,
        secondPrompt: s.secondPrompt,
        parentId: s.parentId || null,
        subagentIds: s.subagentIds || [],
        chunks: sessionChunks,
        ...(sessionSteps === undefined ? {} : { steps: sessionSteps })
      };
    });

    return {
      sessions: sessionsResult,
      steps: matchedSteps,
      chunks: matchedChunks
    };
  }

  search(queryVector: number[], limit: number, options?: { projectPath?: string; scope?: "workspace" | "all" }): SearchResult[] {
    let candidateSessions = Array.from(this.sessionsMap.values()).filter(s => s.summary_vector !== undefined);
    
    let resolvedProjectPath = options?.projectPath;
    if (resolvedProjectPath === undefined && options?.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    if (resolvedProjectPath) {
      const pathFilter = resolvedProjectPath.toLowerCase();
      candidateSessions = candidateSessions.filter(s => 
        s.projectPath?.toLowerCase().includes(pathFilter)
      );
    }

    const scoredSessions = candidateSessions.map(s => {
      const sim = dotProduct(queryVector, s.summary_vector!);
      return { id: s.id, similarity: sim, session: s };
    });

    scoredSessions.sort((a, b) => b.similarity - a.similarity);
    const topSessions = scoredSessions.slice(0, 5);
    const topSessionIds = new Set(topSessions.map(s => s.id));

    if (topSessions.length === 0) {
      return [];
    }

    const candidateChunks: SearchResult[] = [];
    for (const [sid, chunks] of this.chunksMap.entries()) {
      if (!topSessionIds.has(sid)) continue;
      const session = this.sessionsMap.get(sid)!;
      for (const chunk of chunks) {
        const sim = dotProduct(queryVector, chunk.chunk_vector);
        candidateChunks.push({
          sessionId: sid,
          adapter: session.adapter,
          title: session.title,
          projectPath: session.projectPath,
          stepIndex: chunk.stepIndex,
          chunkText: chunk.text,
          similarity: sim
        });
      }
    }

    candidateChunks.sort((a, b) => b.similarity - a.similarity);
    return candidateChunks.slice(0, limit);
  }

  getActiveProjectPath(): string | undefined {
    const sessions = Array.from(this.sessionsMap.values())
      .filter(s => s.projectPath)
      .sort((a, b) => b.createdAt - a.createdAt);
    return sessions[0]?.projectPath || undefined;
  }

  close(): void {
    // No-op for in-memory store
  }
}

export class SqliteHistoryStore implements HistoryStore {
  private readonly db: DatabaseSync;
  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        title TEXT NOT NULL,
        project_path TEXT,
        created_at INTEGER,
        last_active_at INTEGER,
        first_prompt TEXT,
        second_prompt TEXT,
        summary_vector TEXT,
        parent_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS session_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        step_index INTEGER,
        chunk_text TEXT NOT NULL,
        chunk_vector TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        UNIQUE(session_id, step_index) ON CONFLICT IGNORE
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_session ON session_chunks(session_id);

      CREATE TABLE IF NOT EXISTS session_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        content TEXT,
        thinking TEXT,
        tool_calls TEXT,
        created_at INTEGER,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        UNIQUE(session_id, step_index) ON CONFLICT IGNORE
      );

      CREATE INDEX IF NOT EXISTS idx_steps_session ON session_steps(session_id);
    `);

    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;");
    } catch (e: any) {
      if (!e?.message?.includes("duplicate column name")) {
        console.debug?.("[Chronicle MCP] parent_id alter table failed:", e);
      }
    }

    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN last_active_at INTEGER;");
    } catch (e: any) {
      if (!e?.message?.includes("duplicate column name")) {
        console.debug?.("[Chronicle MCP] last_active_at alter table failed:", e);
      }
    }

    try {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);");
    } catch (e) {
      // Ignore error if column/index already exists
      console.debug?.("[Chronicle MCP] idx_sessions_parent create index failed:", e);
    }
  }

  private filterAndPushStep(row: any, options: QueryOptions, stepsBySession: Map<string, StepData[]>, stepsResult: StepData[]): void {
    if (options.conversationStepsOnly && row.type !== "USER_INPUT" && !(row.type === "PLANNER_RESPONSE" && row.content && row.content.trim() !== "")) {
      return;
    }

    const step: StepData = {
      stepIndex: row.step_index,
      type: row.type,
      source: row.source,
      status: row.status,
      content: row.content ?? undefined,
      thinking: row.thinking ?? undefined,
      toolCalls: row.tool_calls ?? undefined,
      createdAt: row.created_at ?? undefined
    };

    if (options.toolName !== undefined || options.serverName !== undefined) {
      if (!step.toolCalls) return;
      try {
        const calls = JSON.parse(step.toolCalls);
        if (!Array.isArray(calls)) return;
        const isMatch = calls.some(call => matchToolCall(call, options.serverName, options.toolName));
        if (!isMatch) return;
      } catch {
        return;
      }
    }

    const sList = stepsBySession.get(row.session_id) || [];
    sList.push(step);
    stepsBySession.set(row.session_id, sList);
    stepsResult.push(step);
  }

  save(session: SessionData, embeddings: SessionEmbeddings): void {
    const db = this.db;
    db.exec("BEGIN TRANSACTION;");
    try {
      let parentId = session.parentId || null;
      if (!parentId) {
        const existing = db.prepare("SELECT parent_id FROM sessions WHERE id = ?").get(session.id) as { parent_id: string | null } | undefined;
        if (existing) {
          parentId = existing.parent_id;
        }
      }

      const stepTimestamps = (session.steps || []).map(s => s.createdAt).filter((t): t is number => t !== undefined);
      const lastActiveAt = stepTimestamps.length > 0 ? Math.max(...stepTimestamps) : (session.lastActiveAt ?? session.createdAt);

      const summaryStr = embeddings.summary ? JSON.stringify(embeddings.summary) : null;
      db.prepare(`
        INSERT INTO sessions (id, adapter, title, project_path, created_at, last_active_at, first_prompt, second_prompt, summary_vector, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          project_path = excluded.project_path,
          created_at = excluded.created_at,
          last_active_at = excluded.last_active_at,
          first_prompt = excluded.first_prompt,
          second_prompt = excluded.second_prompt,
          summary_vector = COALESCE(excluded.summary_vector, summary_vector),
          parent_id = COALESCE(excluded.parent_id, parent_id)
      `).run(
        session.id,
        session.adapter,
        session.title,
        session.projectPath,
        session.createdAt,
        lastActiveAt,
        session.firstPrompt,
        session.secondPrompt,
        summaryStr,
        parentId
      );

      const insertChunk = db.prepare(`
        INSERT OR IGNORE INTO session_chunks (session_id, step_index, chunk_text, chunk_vector)
        VALUES (?, ?, ?, ?)
      `);
      for (const chunk of session.chunks) {
        const vec = embeddings.chunks.get(chunk.stepIndex) || [];
        insertChunk.run(session.id, chunk.stepIndex, chunk.text, JSON.stringify(vec));
      }

      if (session.steps) {
        const insertStep = db.prepare(`
          INSERT OR IGNORE INTO session_steps (session_id, step_index, type, source, status, content, thinking, tool_calls, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const step of session.steps) {
          insertStep.run(
            session.id,
            step.stepIndex,
            step.type,
            step.source,
            step.status,
            step.content ?? null,
            step.thinking ?? null,
            step.toolCalls ?? null,
            step.createdAt ?? null
          );
        }
      }

      if (session.subagentIds && session.subagentIds.length > 0) {
        const updateChild = db.prepare("UPDATE sessions SET parent_id = ? WHERE id = ?");
        for (const childId of session.subagentIds) {
          const res = updateChild.run(session.id, childId);
          console.error(`[DEBUG] UPDATE childId=${childId} parentId=${session.id} changes=${res.changes}`);
        }
      }

      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  }

  private buildSessionQueryTimeRange(where: string[], params: any[], timeRange: string): void {
    const range = parseTimeRange(timeRange);
    if (!range) return;
    if (range.start !== null) {
      where.push("COALESCE(last_active_at, created_at) >= ?");
      params.push(range.start);
    }
    if (range.end !== null) {
      where.push("COALESCE(last_active_at, created_at) <= ?");
      params.push(range.end);
    }
  }

  private buildSessionQuery(options: QueryOptions, params: any[]): string {
    let sql = `SELECT id, adapter, title, project_path, created_at, last_active_at, first_prompt, second_prompt, parent_id FROM sessions`;
    const where: string[] = [];

    if (options.sessionId !== undefined) {
      where.push("id = ?");
      params.push(options.sessionId);
    }
    if (options.adapter !== undefined) {
      where.push("adapter = ?");
      params.push(options.adapter);
    }
    let resolvedProjectPath = options.projectPath;
    if (resolvedProjectPath === undefined && options.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    if (resolvedProjectPath !== undefined) {
      where.push("project_path LIKE ?");
      params.push(`%${resolvedProjectPath}%`);
    }

    if (options.timeRange !== undefined) {
      this.buildSessionQueryTimeRange(where, params, options.timeRange);
    }

    if (where.length > 0) {
      sql += " WHERE " + where.join(" AND ");
    }

    const sortBy = options.sortBy || "active";
    const orderCol = sortBy === "created" ? "created_at" : "COALESCE(last_active_at, created_at)";
    sql += ` ORDER BY ${orderCol} DESC`;

    if (options.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }
    return sql;
  }

  private buildChunkQuery(placeholders: string, options: QueryOptions, params: any[]): string {
    let sql = `SELECT session_id, step_index, chunk_text FROM session_chunks WHERE session_id IN (${placeholders})`;
    if (options.startStep !== undefined) {
      sql += " AND step_index >= ?";
      params.push(options.startStep);
    }
    if (options.endStep !== undefined) {
      sql += " AND step_index <= ?";
      params.push(options.endStep);
    }
    const sortDir = options.reverseSteps ? "DESC" : "ASC";
    sql += ` ORDER BY step_index ${sortDir}`;
    return sql;
  }

  private buildStepQuery(placeholders: string, options: QueryOptions, params: any[]): string {
    const contentCol = options.excludeContent ? "NULL as content" : "content";
    const thinkingCol = options.excludeContent ? "NULL as thinking" : "thinking";
    let sql = `SELECT session_id, step_index, type, source, status, ${contentCol}, ${thinkingCol}, tool_calls, created_at FROM session_steps WHERE session_id IN (${placeholders})`;

    if (options.startStep !== undefined) {
      sql += " AND step_index >= ?";
      params.push(options.startStep);
    }
    if (options.endStep !== undefined) {
      sql += " AND step_index <= ?";
      params.push(options.endStep);
    }
    if (options.stepType !== undefined) {
      sql += " AND type = ?";
      params.push(options.stepType);
    }
    if (options.stepStatus !== undefined) {
      sql += " AND status = ?";
      params.push(options.stepStatus);
    }
    if (options.stepQuery !== undefined) {
      sql += " AND (content LIKE ? OR thinking LIKE ? OR tool_calls LIKE ?)";
      params.push(`%${options.stepQuery}%`, `%${options.stepQuery}%`, `%${options.stepQuery}%`);
    }
    const sortDir = options.reverseSteps ? "DESC" : "ASC";
    sql += ` ORDER BY step_index ${sortDir}`;
    return sql;
  }

  private resolveConversationSteps(db: any, queryOpts: QueryOptions): void {
    if (queryOpts.startConversationStep !== undefined) {
      const row = db.prepare(`
        SELECT step_index FROM session_steps
        WHERE session_id = ? AND (type = 'USER_INPUT' OR (type = 'PLANNER_RESPONSE' AND content IS NOT NULL AND TRIM(content) != ''))
        ORDER BY step_index ASC
        LIMIT 1 OFFSET ?
      `).get(queryOpts.sessionId, queryOpts.startConversationStep - 1) as { step_index: number } | undefined;
      if (row) {
        queryOpts.startStep = row.step_index;
      } else {
        queryOpts.startStep = Infinity;
      }
    }
    if (queryOpts.endConversationStep !== undefined) {
      const row = db.prepare(`
        SELECT step_index FROM session_steps
        WHERE session_id = ? AND (type = 'USER_INPUT' OR (type = 'PLANNER_RESPONSE' AND content IS NOT NULL AND TRIM(content) != ''))
        ORDER BY step_index ASC
        LIMIT 1 OFFSET ?
      `).get(queryOpts.sessionId, queryOpts.endConversationStep - 1) as { step_index: number } | undefined;
      if (row) {
        queryOpts.endStep = row.step_index;
      } else {
        queryOpts.endStep = -1;
      }
    }
  }

  query(options: QueryOptions): QueryResult {
    const db = this.db;
    const queryOpts = { ...options };

    if (queryOpts.sessionId && (queryOpts.startConversationStep !== undefined || queryOpts.endConversationStep !== undefined)) {
      this.resolveConversationSteps(db, queryOpts);
    }

    const sessionParams: any[] = [];
    const sessionSql = this.buildSessionQuery(queryOpts, sessionParams);
    const sessionsRows = db.prepare(sessionSql).all(...sessionParams) as any[];

    const sessionsResult: SessionData[] = [];
    const stepsResult: StepData[] = [];
    const chunksResult: ChunkData[] = [];

    if (sessionsRows.length === 0) {
      return { sessions: [], steps: [], chunks: [] };
    }

    const sessionIds = sessionsRows.map(s => s.id);
    const placeholders = sessionIds.map(() => "?").join(",");

    const chunkParams: any[] = [...sessionIds];
    const chunkSql = this.buildChunkQuery(placeholders, queryOpts, chunkParams);
    const chunksRows = db.prepare(chunkSql).all(...chunkParams) as any[];

    let stepsRows: any[] = [];
    if (queryOpts.includeSteps) {
      const stepParams: any[] = [...sessionIds];
      const stepSql = this.buildStepQuery(placeholders, queryOpts, stepParams);
      stepsRows = db.prepare(stepSql).all(...stepParams) as any[];
    }

    const chunksBySession = new Map<string, ChunkData[]>();
    for (const row of chunksRows) {
      const cList = chunksBySession.get(row.session_id) || [];
      const chunk = { stepIndex: row.step_index, text: row.chunk_text };
      cList.push(chunk);
      chunksBySession.set(row.session_id, cList);
      chunksResult.push(chunk);
    }

    const stepsBySession = new Map<string, StepData[]>();
    for (const row of stepsRows) {
      this.filterAndPushStep(row, queryOpts, stepsBySession, stepsResult);
    }

    for (const s of sessionsRows) {
      sessionsResult.push({
        id: s.id,
        adapter: s.adapter,
        title: s.title,
        projectPath: s.project_path,
        createdAt: s.created_at,
        lastActiveAt: s.last_active_at ?? s.created_at,
        firstPrompt: s.first_prompt,
        secondPrompt: s.second_prompt,
        parentId: s.parent_id || null,
        chunks: chunksBySession.get(s.id) || [],
        steps: queryOpts.includeSteps ? (stepsBySession.get(s.id) || []) : undefined
      });
    }

    return {
      sessions: sessionsResult,
      steps: stepsResult,
      chunks: chunksResult
    };
  }

  search(queryVector: number[], limit: number, options?: { projectPath?: string; scope?: "workspace" | "all" }): SearchResult[] {
    const db = this.db;

    let sessionQuery = `
      SELECT id, adapter, title, project_path, summary_vector 
      FROM sessions 
      WHERE summary_vector IS NOT NULL
    `;
    const sessionParams: any[] = [];
    
    let resolvedProjectPath = options?.projectPath;
    if (resolvedProjectPath === undefined && options?.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    if (resolvedProjectPath) {
      sessionQuery += " AND project_path LIKE ?";
      sessionParams.push(`%${resolvedProjectPath}%`);
    }
    const sessions = db.prepare(sessionQuery).all(...sessionParams) as any[];

    const matchedSessions: { id: string; similarity: number }[] = [];

    for (const s of sessions) {
      try {
        const vec = JSON.parse(s.summary_vector) as number[];
        const sim = dotProduct(queryVector, vec);
        matchedSessions.push({ id: s.id, similarity: sim });
      } catch (e) {
        console.debug?.("[Chronicle MCP] Failed to parse summary vector:", e);
      }
    }

    matchedSessions.sort((a, b) => b.similarity - a.similarity);
    const topSessionIds = matchedSessions.slice(0, 5).map((s) => s.id);

    if (topSessionIds.length === 0) {
      return [];
    }

    const placeholders = topSessionIds.map(() => "?").join(",");
    const chunks = db.prepare(`
      SELECT c.session_id, c.step_index, c.chunk_text, c.chunk_vector,
             s.adapter, s.title, s.project_path
      FROM session_chunks c
      JOIN sessions s ON c.session_id = s.id
      WHERE c.session_id IN (${placeholders})
    `).all(...topSessionIds) as any[];

    const results: SearchResult[] = [];

    for (const c of chunks) {
      try {
        const vec = JSON.parse(c.chunk_vector) as number[];
        const sim = dotProduct(queryVector, vec);
        results.push({
          sessionId: c.session_id,
          adapter: c.adapter,
          title: c.title,
          projectPath: c.project_path,
          stepIndex: c.step_index,
          chunkText: c.chunk_text,
          similarity: sim,
        });
      } catch (e) {
        console.debug?.("[Chronicle MCP] Failed to parse chunk vector:", e);
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  getActiveProjectPath(): string | undefined {
    try {
      const row = this.db.prepare(`
        SELECT project_path FROM sessions 
        WHERE project_path IS NOT NULL AND project_path != '' 
        ORDER BY created_at DESC LIMIT 1
      `).get() as { project_path: string } | undefined;
      return row?.project_path || undefined;
    } catch (e) {
      console.debug?.("[Chronicle MCP] getActiveProjectPath failed:", e);
      return undefined;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch (e) {
      console.warn("[Chronicle MCP] Failed to close database:", e);
    }
  }
}

let storeInstance: HistoryStore | null = null;

export function setStore(store: HistoryStore): void {
  storeInstance = store;
}

export function getStore(): HistoryStore {
  storeInstance ??= new SqliteHistoryStore(DB_PATH);
  return storeInstance;
}
