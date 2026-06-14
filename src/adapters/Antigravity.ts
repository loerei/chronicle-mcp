import fs from "fs";
import path from "path";
import os from "os";
import { SessionData, HistoryAdapter } from "./types.js";
import { SessionParser } from "./SessionParser.js";

export class AntigravityAdapter implements HistoryAdapter {
  name = "antigravity";

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
      const logDir = path.join(brainDir, sid, ".system_generated", "logs");
      let logPath = path.join(logDir, "transcript_full.jsonl");
      if (!fs.existsSync(logPath)) {
        logPath = path.join(logDir, "transcript.jsonl");
      }

      if (!fs.existsSync(logPath)) {
        continue;
      }

      try {
        const content = fs.readFileSync(logPath, "utf-8");
        const session = SessionParser.parseAntigravity(sid, content);
        if (session) {
          if (session.createdAt === 0) {
            session.createdAt = fs.statSync(logPath).mtimeMs;
          }
          sessions.push(session);

          // Extract global title mapping from logs
          if (session.steps) {
            for (const step of session.steps) {
              if (step.type === "CONVERSATION_HISTORY") {
                const historyText = step.content || "";
                const linesInHistory = historyText.split("\n");
                for (const hLine of linesInHistory) {
                  const match = hLine.match(/## Conversation\s+([a-fA-F0-9-]+):\s*(.*)/);
                  if (match) {
                    globalTitleMap.set(match[1].trim(), match[2].trim());
                  }
                }
              }
            }
          }
        }
      } catch {}
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
