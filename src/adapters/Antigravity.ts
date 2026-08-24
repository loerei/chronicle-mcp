import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionData, HistoryAdapter } from "./types.js";
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

    return artifacts.sort();
  } catch {
    return [];
  }
}

export class AntigravityAdapter implements HistoryAdapter {
  name = "antigravity";
  private brainDir: string;

  constructor(brainDir?: string) {
    this.brainDir = brainDir || path.join(os.homedir(), ".gemini", "antigravity", "brain");
  }

  private parseSingleSession(sid: string, brainDir: string, globalTitleMap: Map<string, string>): SessionData | null {
    const logDir = path.join(brainDir, sid, ".system_generated", "logs");
    let logPath = path.join(logDir, "transcript_full.jsonl");
    if (!fs.existsSync(logPath)) {
      logPath = path.join(logDir, "transcript.jsonl");
    }

    if (!fs.existsSync(logPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(logPath, "utf-8");
      const session = SessionParser.parseAntigravity(sid, content);
      if (session) {
        if (session.createdAt === 0) {
          session.createdAt = fs.statSync(logPath).mtimeMs;
        }

        // Discover brain artifacts
        const sessionBrainDir = path.join(brainDir, sid);
        session.artifacts = discoverBrainArtifacts(sessionBrainDir);

        this.extractTitles(session, globalTitleMap);
        return session;
      }
    } catch {}
    return null;
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

  async discoverSessions(reporter?: any): Promise<SessionData[]> {
    const brainDir = this.brainDir;

    if (!fs.existsSync(brainDir)) {
      return [];
    }

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
    reporter?.start(total, "Scanning Antigravity sessions...");

    for (let i = 0; i < sessionDirs.length; i++) {
      const sid = sessionDirs[i];
      const session = this.parseSingleSession(sid, brainDir, globalTitleMap);
      if (session) {
        sessions.push(session);
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
        for (const childId of session.subagentIds) {
          const child = sessionMap.get(childId);
          if (child && !child.parentId) {
            child.parentId = session.id;
          }
        }
      }
    }

    // Compute rootId and depth with cycle detection
    for (const session of sessions) {
      let current = session;
      let depth = 0;
      const visited = new Set<string>([session.id]);

      while (current.parentId && depth < 20) {
        if (visited.has(current.parentId)) {
          break; // cycle detected, terminate walk
        }
        visited.add(current.parentId);
        const parent = sessionMap.get(current.parentId);
        if (!parent) {
          break;
        }
        current = parent;
        depth += 1;
      }

      session.rootId = current.id;
      session.depth = depth;
    }

    return sessions;
  }
}
