import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "os";
import fs from "fs";
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

    if (tableSqlRow && tableSqlRow.sql && !tableSqlRow.sql.includes("UNIQUE")) {
      needsMigration = true;
    }
  } catch (e) {
    // Table might not exist yet, which is fine
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
  } catch (e) {
    // Ignore error if column already exists
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

export class InMemoryHistoryStore implements HistoryStore {
  private sessionsMap = new Map<string, Omit<SessionData, "chunks"> & { summary_vector?: number[] }>();
  private stepsMap = new Map<string, StepData[]>();
  private chunksMap = new Map<string, Array<ChunkData & { chunk_vector: number[] }>>();

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
    const sessionCopy = {
      id: session.id,
      adapter: session.adapter,
      title: session.title,
      projectPath: session.projectPath,
      createdAt: session.createdAt,
      firstPrompt: session.firstPrompt,
      secondPrompt: session.secondPrompt,
      parentId,
      subagentIds: session.subagentIds || [],
      summary_vector: embeddings.summary
        ? [...embeddings.summary]
        : (existingSession ? (existingSession as any).summary_vector : undefined)
    };

    const chunksCopy: Array<ChunkData & { chunk_vector: number[] }> = [];
    const existingChunks = this.chunksMap.get(sessionId) || [];
    const chunksByStepIndex = new Map(existingChunks.map(c => [c.stepIndex, c]));

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

    this.sessionsMap.set(sessionId, sessionCopy);
    this.chunksMap.set(sessionId, chunksCopy);
    this.stepsMap.set(sessionId, stepsCopy);

    if (session.subagentIds && session.subagentIds.length > 0) {
      for (const childId of session.subagentIds) {
        const childSession = this.sessionsMap.get(childId);
        if (childSession) {
          (childSession as any).parentId = session.id;
        }
      }
    }
  }

  query(options: QueryOptions): QueryResult {
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
        s.projectPath && s.projectPath.toLowerCase().includes(pathFilter)
      );
    }

    if (options.limit !== undefined) {
      matchedSessions = matchedSessions.slice(0, options.limit);
    }

    const sessionIds = new Set(matchedSessions.map(s => s.id));

    let matchedChunks: ChunkData[] = [];
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

    let matchedSteps: StepData[] = [];
    if (options.includeSteps) {
      for (const [sid, steps] of this.stepsMap.entries()) {
        if (!sessionIds.has(sid)) continue;
        for (const step of steps) {
          if (options.startStep !== undefined && step.stepIndex < options.startStep) continue;
          if (options.endStep !== undefined && step.stepIndex > options.endStep) continue;
          if (options.stepType !== undefined && step.type !== options.stepType) continue;
          if (options.stepStatus !== undefined && step.status !== options.stepStatus) continue;
          if (options.stepQuery !== undefined) {
            const query = options.stepQuery.toLowerCase();
            const contentMatch = step.content && step.content.toLowerCase().includes(query);
            const thinkingMatch = step.thinking && step.thinking.toLowerCase().includes(query);
            const toolCallsMatch = step.toolCalls && step.toolCalls.toLowerCase().includes(query);
            if (!contentMatch && !thinkingMatch && !toolCallsMatch) continue;
          }
          if (options.toolName !== undefined || options.serverName !== undefined) {
            if (!step.toolCalls) continue;
            try {
              const calls = JSON.parse(step.toolCalls);
              if (!Array.isArray(calls)) continue;
              const isMatch = calls.some(call => matchToolCall(call, options.serverName, options.toolName));
              if (!isMatch) continue;
            } catch {
              continue;
            }
          }
          const stepCopy = { ...step };
          if (options.excludeContent) {
            delete stepCopy.content;
            delete stepCopy.thinking;
          }
          matchedSteps.push(stepCopy);
        }
      }
    }

    const sessionsResult = matchedSessions.map(s => {
      const sessionChunks = (this.chunksMap.get(s.id) || [])
        .filter(c => {
          if (options.startStep !== undefined && c.stepIndex < options.startStep) return false;
          if (options.endStep !== undefined && c.stepIndex > options.endStep) return false;
          return true;
        })
        .map(c => ({ stepIndex: c.stepIndex, text: c.text }));

      const sessionSteps = options.includeSteps ? (this.stepsMap.get(s.id) || [])
        .filter(step => {
          if (options.startStep !== undefined && step.stepIndex < options.startStep) return false;
          if (options.endStep !== undefined && step.stepIndex > options.endStep) return false;
          if (options.stepType !== undefined && step.type !== options.stepType) return false;
          if (options.stepStatus !== undefined && step.status !== options.stepStatus) return false;
          if (options.stepQuery !== undefined) {
            const query = options.stepQuery.toLowerCase();
            const contentMatch = step.content && step.content.toLowerCase().includes(query);
            const thinkingMatch = step.thinking && step.thinking.toLowerCase().includes(query);
            const toolCallsMatch = step.toolCalls && step.toolCalls.toLowerCase().includes(query);
            if (!contentMatch && !thinkingMatch && !toolCallsMatch) return false;
          }
          if (options.toolName !== undefined || options.serverName !== undefined) {
            if (!step.toolCalls) return false;
            try {
              const calls = JSON.parse(step.toolCalls);
              if (!Array.isArray(calls)) return false;
              const isMatch = calls.some(call => matchToolCall(call, options.serverName, options.toolName));
              if (!isMatch) return false;
            } catch {
              return false;
            }
          }
          return true;
        })
        .map(step => {
          const stepCopy = { ...step };
          if (options.excludeContent) {
            delete stepCopy.content;
            delete stepCopy.thinking;
          }
          return stepCopy;
        }) : undefined;

      return {
        id: s.id,
        adapter: s.adapter,
        title: s.title,
        projectPath: s.projectPath,
        createdAt: s.createdAt,
        firstPrompt: s.firstPrompt,
        secondPrompt: s.secondPrompt,
        parentId: (s as any).parentId || null,
        subagentIds: (s as any).subagentIds || [],
        chunks: sessionChunks,
        ...(sessionSteps !== undefined ? { steps: sessionSteps } : {})
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
        s.projectPath && s.projectPath.toLowerCase().includes(pathFilter)
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

  close(): void {}
}

export class SqliteHistoryStore implements HistoryStore {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        title TEXT NOT NULL,
        project_path TEXT,
        created_at INTEGER,
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
    } catch (e) {
      // Ignore error if column already exists
    }

    try {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);");
    } catch (e) {
      // Ignore error if column/index already exists
    }
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

      const summaryStr = embeddings.summary ? JSON.stringify(embeddings.summary) : null;
      db.prepare(`
        INSERT INTO sessions (id, adapter, title, project_path, created_at, first_prompt, second_prompt, summary_vector, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          project_path = excluded.project_path,
          created_at = excluded.created_at,
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

  query(options: QueryOptions): QueryResult {
    const db = this.db;
    
    let sessionSql = `SELECT id, adapter, title, project_path, created_at, first_prompt, second_prompt, parent_id FROM sessions`;
    const sessionWhere: string[] = [];
    const sessionParams: any[] = [];

    if (options.sessionId !== undefined) {
      sessionWhere.push("id = ?");
      sessionParams.push(options.sessionId);
    }
    if (options.adapter !== undefined) {
      sessionWhere.push("adapter = ?");
      sessionParams.push(options.adapter);
    }
    let resolvedProjectPath = options.projectPath;
    if (resolvedProjectPath === undefined && options.scope === "workspace") {
      resolvedProjectPath = this.getActiveProjectPath();
    }

    if (resolvedProjectPath !== undefined) {
      sessionWhere.push("project_path LIKE ?");
      sessionParams.push(`%${resolvedProjectPath}%`);
    }

    if (sessionWhere.length > 0) {
      sessionSql += " WHERE " + sessionWhere.join(" AND ");
    }

    if (options.limit !== undefined) {
      sessionSql += " LIMIT ?";
      sessionParams.push(options.limit);
    }

    const sessionsRows = db.prepare(sessionSql).all(...sessionParams) as any[];

    const sessionsResult: SessionData[] = [];
    const stepsResult: StepData[] = [];
    const chunksResult: ChunkData[] = [];

    if (sessionsRows.length === 0) {
      return { sessions: [], steps: [], chunks: [] };
    }

    const sessionIds = sessionsRows.map(s => s.id);
    const placeholders = sessionIds.map(() => "?").join(",");

    let chunkSql = `SELECT session_id, step_index, chunk_text FROM session_chunks WHERE session_id IN (${placeholders})`;
    const chunkParams: any[] = [...sessionIds];

    if (options.startStep !== undefined) {
      chunkSql += " AND step_index >= ?";
      chunkParams.push(options.startStep);
    }
    if (options.endStep !== undefined) {
      chunkSql += " AND step_index <= ?";
      chunkParams.push(options.endStep);
    }
    chunkSql += " ORDER BY step_index ASC";

    const chunksRows = db.prepare(chunkSql).all(...chunkParams) as any[];

    let stepsRows: any[] = [];
    if (options.includeSteps) {
      const contentCol = options.excludeContent ? "NULL as content" : "content";
      const thinkingCol = options.excludeContent ? "NULL as thinking" : "thinking";
      let stepSql = `SELECT session_id, step_index, type, source, status, ${contentCol}, ${thinkingCol}, tool_calls, created_at FROM session_steps WHERE session_id IN (${placeholders})`;
      const stepParams: any[] = [...sessionIds];

      if (options.startStep !== undefined) {
        stepSql += " AND step_index >= ?";
        stepParams.push(options.startStep);
      }
      if (options.endStep !== undefined) {
        stepSql += " AND step_index <= ?";
        stepParams.push(options.endStep);
      }
      if (options.stepType !== undefined) {
        stepSql += " AND type = ?";
        stepParams.push(options.stepType);
      }
      if (options.stepStatus !== undefined) {
        stepSql += " AND status = ?";
        stepParams.push(options.stepStatus);
      }
      if (options.stepQuery !== undefined) {
        stepSql += " AND (content LIKE ? OR thinking LIKE ? OR tool_calls LIKE ?)";
        stepParams.push(`%${options.stepQuery}%`, `%${options.stepQuery}%`, `%${options.stepQuery}%`);
      }
      stepSql += " ORDER BY step_index ASC";

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
        if (!step.toolCalls) continue;
        try {
          const calls = JSON.parse(step.toolCalls);
          if (!Array.isArray(calls)) continue;
          const isMatch = calls.some(call => matchToolCall(call, options.serverName, options.toolName));
          if (!isMatch) continue;
        } catch {
          continue;
        }
      }

      const sList = stepsBySession.get(row.session_id) || [];
      sList.push(step);
      stepsBySession.set(row.session_id, sList);
      stepsResult.push(step);
    }

    for (const s of sessionsRows) {
      sessionsResult.push({
        id: s.id,
        adapter: s.adapter,
        title: s.title,
        projectPath: s.project_path,
        createdAt: s.created_at,
        firstPrompt: s.first_prompt,
        secondPrompt: s.second_prompt,
        parentId: s.parent_id || null,
        chunks: chunksBySession.get(s.id) || [],
        steps: options.includeSteps ? (stepsBySession.get(s.id) || []) : undefined
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
      } catch {}
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
      } catch {}
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
      return undefined;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {}
  }
}

let storeInstance: HistoryStore | null = null;

export function setStore(store: HistoryStore): void {
  storeInstance = store;
}

export function getStore(): HistoryStore {
  if (!storeInstance) {
    storeInstance = new SqliteHistoryStore(DB_PATH);
  }
  return storeInstance;
}
