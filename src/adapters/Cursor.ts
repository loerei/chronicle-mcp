import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SessionData, HistoryAdapter } from "./types.js";
import { SessionParser } from "./SessionParser.js";

export class CursorAdapter implements HistoryAdapter {
  name = "cursor";

  private getDbPath(): string {
    const homedir = os.homedir();
    let dbPath = path.join(
      homedir,
      "AppData",
      "Roaming",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb"
    );

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
    return dbPath;
  }

  private parseComposerRow(row: any, sessions: SessionData[]): void {
    try {
      const rawVal = row.value;
      if (!rawVal) return;

      const data = JSON.parse(rawVal);
      if (row.key.includes("composerStates")) {
        if (data.composers && typeof data.composers === "object") {
          for (const compId of Object.keys(data.composers)) {
            const comp = data.composers[compId];
            const parsed = SessionParser.parseCursorComposer(compId, comp);
            if (parsed) sessions.push(parsed);
          }
        }
      } else {
        const compId = row.key.replace("composer.composerState.", "");
        const parsed = SessionParser.parseCursorComposer(compId, data);
        if (parsed) sessions.push(parsed);
      }
    } catch (e) {
      console.warn("CursorAdapter failed to parse composer row:", e);
    }
  }

  async discoverSessions(): Promise<SessionData[]> {
    const dbPath = this.getDbPath();

    if (!fs.existsSync(dbPath)) {
      return [];
    }

    const sessions: SessionData[] = [];

    try {
      const db = new DatabaseSync(dbPath);

      const tableCheck = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'"
        )
        .get() as any;

      if (!tableCheck) {
        db.close();
        return [];
      }

      const rows = db
        .prepare(
          "SELECT key, value FROM ItemTable WHERE key LIKE 'composer.composerState%' OR key LIKE 'composer.composerStates%'"
        )
        .all() as any[];

      for (const row of rows) {
        this.parseComposerRow(row, sessions);
      }

      db.close();
    } catch (e) {
      console.warn("CursorAdapter discoverSessions database error:", e);
    }

    return sessions;
  }
}
