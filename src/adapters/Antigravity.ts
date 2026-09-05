import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionData, HistoryAdapter, DiscoverSessionsOptions, SessionInbox, SessionInboxItem } from "./types.js";
import { ProgressReporter } from "../progress.js";
import { SessionParser } from "./SessionParser.js";

/**
 * Discovers markdown artifacts located in a session brain directory (shallow depth = 1).
 * Ignores system-generated files, logs, scratch directories, and hidden files.
 * Returns relative artifact basenames (e.g. ["implementation_plan.md", "walkthrough.md"]).
 */
export function discoverBrainArtifacts(sessionBrainDir: string): string[] {
  if (!sessionBrainDir || !fs.existsSync(sessionBrainDir)) {
    return [];
  }

  try {
    const entries = fs.readdirSync(sessionBrainDir, { withFileTypes: true });
    const artifacts: string[] = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith(".")) {
        artifacts.push(entry.name);
      }
    }

    return artifacts.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export class AntigravityAdapter implements HistoryAdapter {
  readonly name = "antigravity";
  private readonly brainDir: string;

  constructor(brainDir?: string) {
    this.brainDir = brainDir || path.join(os.homedir(), ".gemini", "antigravity", "brain");
  }

  private extractTitles(session: SessionData, globalTitleMap: Map<string, string>): void {
    if (!session.steps) return;
    for (const step of session.steps) {
      if (step.type === "CONVERSATION_HISTORY" || step.category === "system") {
        const historyText = step.content || "";
        const linesInHistory = historyText.split("\n");
        for (const hLine of linesInHistory) {
          const match = /## Conversation\s+([a-fA-F0-9-]+):\s*(.*)/.exec(hLine);
          if (match) {
            globalTitleMap.set(match[1].trim(), match[2].trim());
          }
        }
      }
    }
  }

  async discoverSessions(options?: DiscoverSessionsOptions | ProgressReporter): Promise<SessionData[]> {
    const brainDir = this.brainDir;

    if (!fs.existsSync(brainDir)) {
      return [];
    }

    const opts: DiscoverSessionsOptions =
      options && typeof (options as any).update === "function"
        ? { reporter: options as ProgressReporter }
        : (options as DiscoverSessionsOptions) || {};
    const reporter = opts.reporter;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const sessionDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name !== "tempmediaStorage" && !entry.name.startsWith("."))
      .map((entry) => entry.name);

    const sessions: SessionData[] = [];
    const globalTitleMap = new Map<string, string>(); // sessionId -> title extracted from logs

    const total = sessionDirs.length;
    const startTime = Date.now();
    let skippedCount = 0;

    (reporter as any)?.start?.(total, "Scanning Antigravity sessions...");

    for (let i = 0; i < sessionDirs.length; i++) {
      const sid = sessionDirs[i];
      const logDir = path.join(brainDir, sid, ".system_generated", "logs");
      let logPath = path.join(logDir, "transcript_full.jsonl");
      if (!fs.existsSync(logPath)) {
        logPath = path.join(logDir, "transcript.jsonl");
      }

      if (!fs.existsSync(logPath)) {
        reporter?.update(i + 1, total, sid);
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(logPath);
      } catch (e: any) {
        console.error(`[Chronicle MCP] Failed to stat session transcript "${sid}" at ${logPath}:`, e?.message || e);
        reporter?.update(i + 1, total, sid);
        continue;
      }

      const currentMtime = Math.floor(stat.mtimeMs);

      if (!opts.force && opts.cachedStats?.has(sid)) {
        const cached = opts.cachedStats.get(sid)!;
        if (currentMtime === cached.logMtime && stat.size === cached.logSize) {
          skippedCount++;
          reporter?.update(i + 1, total, sid);
          continue;
        }
      }

      let session: SessionData | null = null;
      try {
        const content = fs.readFileSync(logPath, "utf-8");
        session = SessionParser.parseAntigravity(sid, content);
        if (session) {
          if (session.createdAt === 0) {
            session.createdAt = currentMtime;
          }
          session.logMtime = currentMtime;
          session.logSize = stat.size;

          const sessionBrainDir = path.join(brainDir, sid);
          session.artifacts = discoverBrainArtifacts(sessionBrainDir);

          this.extractTitles(session, globalTitleMap);
          sessions.push(session);
        }
      } catch (e: any) {
        console.error(`[Chronicle MCP] Failed to parse session transcript "${sid}" at ${logPath}:`, e?.message || e);
      }

      reporter?.update(i + 1, total, session?.title || sid);
    }

    // Resolve titles globally
    for (const session of sessions) {
      const title = globalTitleMap.get(session.id);
      if (title) {
        session.title = title;
      }
    }

    // Build session map for topology hierarchy resolution
    const sessionMap = new Map<string, SessionData>();
    for (const session of sessions) {
      sessionMap.set(session.id, session);
    }

    // Link subagent parent IDs
    for (const session of sessions) {
      if (Array.isArray(session.subagentIds)) {
        for (const rawChildId of session.subagentIds) {
          const cleanChildId = (typeof rawChildId === "string" ? rawChildId : "")
            .replace(/^["']|["']$/g, "")
            .trim();
          if (!cleanChildId || cleanChildId === session.id) continue;
          const child = sessionMap.get(cleanChildId);
          if (child && !child.parentId) {
            // Temporal causality guard: parent cannot be created after child
            if (session.createdAt <= child.createdAt) {
              child.parentId = session.id;
            }
          }
        }
      }
    }

    // Compute rootId and depth with cycle detection
    for (const session of sessions) {
      if (!session.parentId) {
        session.rootId = session.id;
        session.depth = 0;
        continue;
      }

      let current = session;
      let depth = 0;
      const visited = new Set<string>([session.id]);
      let parentResolved = true;

      while (current.parentId && depth < 20) {
        if (visited.has(current.parentId)) {
          break; // cycle detected, terminate walk
        }
        visited.add(current.parentId);
        const parent = sessionMap.get(current.parentId);
        if (!parent) {
          parentResolved = false;
          break;
        }
        current = parent;
        depth += 1;
      }

      if (parentResolved) {
        session.rootId = current.id;
        session.depth = depth;
      }
    }

    console.error(`[Chronicle MCP] [Antigravity] Scanned ${total} session directories: ${skippedCount} unchanged (stat-cached), ${sessions.length} parsed in ${Date.now() - startTime}ms`);

    return sessions;
  }

  getInbox(sessionId: string): SessionInbox {
    const cleanId = String(sessionId).replace(/^["']|["']$/g, "").trim();
    const uDir = path.join(this.brainDir, cleanId, ".system_generated", "messages", "undelivered");
    if (!fs.existsSync(uDir)) {
      return { pendingCount: 0, undelivered: [] };
    }
    try {
      const files = fs.readdirSync(uDir);
      const items: SessionInboxItem[] = [];
      const mDir = path.join(this.brainDir, cleanId, ".system_generated", "messages");
      for (const f of files) {
        const jsonPath = path.join(mDir, `${f}.json`);
        if (fs.existsSync(jsonPath)) {
          try {
            const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
            const msgText = typeof raw.content === "string" ? raw.content : typeof raw.message === "string" ? raw.message : undefined;
            items.push({
              id: f,
              sender: raw.sender,
              timestamp: raw.timestamp,
              content: msgText ? msgText.slice(0, 100) : undefined,
            });
          } catch {
            items.push({ id: f });
          }
        } else {
          items.push({ id: f });
        }
      }
      return { pendingCount: files.length, undelivered: items };
    } catch {
      return { pendingCount: 0, undelivered: [] };
    }
  }

  checkMessageDelivery(recipientId: string, messageId?: string, senderId?: string): { isDelivered: boolean; pendingCount: number } {
    const inbox = this.getInbox(recipientId);
    let isDelivered = true;
    if (messageId) {
      isDelivered = !inbox.undelivered.some(item => item.id === messageId);
    } else if (senderId) {
      isDelivered = !inbox.undelivered.some(item => item.sender === senderId);
    } else {
      isDelivered = inbox.pendingCount === 0;
    }
    return {
      isDelivered,
      pendingCount: inbox.pendingCount,
    };
  }
}

let defaultAntigravityAdapter: AntigravityAdapter | null = null;
export function getAntigravityAdapter(): AntigravityAdapter {
  if (!defaultAntigravityAdapter) {
    defaultAntigravityAdapter = new AntigravityAdapter();
  }
  return defaultAntigravityAdapter;
}

export function setAntigravityAdapter(adapter: AntigravityAdapter | null): void {
  defaultAntigravityAdapter = adapter;
}

