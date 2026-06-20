import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionData, HistoryAdapter } from "./types.js";
import { SessionParser } from "./SessionParser.js";

export class AntigravityAdapter implements HistoryAdapter {
  name = "antigravity";

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
        this.extractTitles(session, globalTitleMap);
        return session;
      }
    } catch {}
    return null;
  }

  private extractTitles(session: SessionData, globalTitleMap: Map<string, string>): void {
    if (!session.steps) return;
    for (const step of session.steps) {
      if (step.type === "CONVERSATION_HISTORY") {
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

  async discoverSessions(): Promise<SessionData[]> {
    const homedir = os.homedir();
    const brainDir = path.join(homedir, ".gemini", "antigravity", "brain");

    if (!fs.existsSync(brainDir)) {
      return [];
    }

    const sessionDirs = fs
      .readdirSync(brainDir)
      .filter((file) => fs.statSync(path.join(brainDir, file)).isDirectory() && file !== "tempmediaStorage");

    const sessions: SessionData[] = [];
    const globalTitleMap = new Map<string, string>(); // sessionId -> title extracted from logs

    for (const sid of sessionDirs) {
      const session = this.parseSingleSession(sid, brainDir, globalTitleMap);
      if (session) {
        sessions.push(session);
      }
    }

    // Resolve titles globally
    for (const session of sessions) {
      const title = globalTitleMap.get(session.id);
      if (title) {
        session.title = title;
      }
    }

    return sessions;
  }
}
