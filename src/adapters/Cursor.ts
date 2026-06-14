import fs from "fs";
import path from "path";
import os from "os";
import { DatabaseSync } from "node:sqlite";
import { SessionData, HistoryAdapter } from "./types.js";
import { SessionParser } from "./SessionParser.js";

export class CursorAdapter implements HistoryAdapter {
  name = "cursor";

  async discoverSessions(): Promise<SessionData[]> {
    const homedir = os.homedir();
    
    // Default Cursor global state DB path on Windows
    let dbPath = path.join(
      homedir,
      "AppData",
      "Roaming",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb"
    );

    // Cross-platform fallbacks
    if (!fs.existsSync(dbPath)) {
      if (os.platform() === "darwin") {
        dbPath = path.join(
          homedir,
          "Library",
          "Application Support",
          "Cursor",
          "User",
          "globalStorage",
          "state.vscdb"
        );
      } else if (os.platform() === "linux") {
        dbPath = path.join(
          homedir,
          ".config",
          "Cursor",
          "User",
          "globalStorage",
          "state.vscdb"
        );
      }
    }

    if (!fs.existsSync(dbPath)) {
      return [];
    }

    const sessions: SessionData[] = [];

    try {
      // Open Cursor state database in read-only mode if possible, or standard mode
      const db = new DatabaseSync(dbPath);

      // Check if ItemTable exists
      const tableCheck = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'"
        )
        .get() as any;

      if (!tableCheck) {
        db.close();
        return [];
      }

      // Fetch all composer-related keys
      const rows = db
        .prepare(
          "SELECT key, value FROM ItemTable WHERE key LIKE 'composer.composerState%' OR key LIKE 'composer.composerStates%'"
        )
        .all() as any[];

      for (const row of rows) {
        try {
          const rawVal = row.value;
          if (!rawVal) continue;

          const data = JSON.parse(rawVal);
          // Cursor composerStates is often stored as a dictionary of composers, or single composer state
          if (row.key.includes("composerStates")) {
            // It's a dictionary of multiple composers
            if (data.composers && typeof data.composers === "object") {
              for (const compId of Object.keys(data.composers)) {
                const comp = data.composers[compId];
                const parsed = SessionParser.parseCursorComposer(compId, comp);
                if (parsed) sessions.push(parsed);
              }
            }
          } else {
            // Single composer state
            const compId = row.key.replace("composer.composerState.", "");
            const parsed = SessionParser.parseCursorComposer(compId, data);
            if (parsed) sessions.push(parsed);
          }
        } catch {}
      }

      db.close();
    } catch (e) {
      // Fail silently and return whatever was found (or empty) to avoid blocking MCP execution
    }

    return sessions;
  }
}
