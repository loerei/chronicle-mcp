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

  private parseComposers(data: any, sessions: SessionData[]): void {
    if (!data.composers || typeof data.composers !== "object") return;
    for (const compId of Object.keys(data.composers)) {
      const comp = data.composers[compId];
      const parsed = SessionParser.parseCursorComposer(compId, comp);
      if (parsed) sessions.push(parsed);
    }
  }

  private parseComposerRow(row: any, sessions: SessionData[]): void {
    try {
      const rawVal = row.value;
      if (!rawVal) return;

      const data = JSON.parse(rawVal);
      if (row.key.includes("composerStates")) {
        this.parseComposers(data, sessions);
      } else {
        const compId = row.key.replace("composer.composerState.", "");
        const parsed = SessionParser.parseCursorComposer(compId, data);
        if (parsed) sessions.push(parsed);
      }
    } catch (e) {
      console.warn("CursorAdapter failed to parse composer row:", e);
    }
  }

  private parseWorkspacePath(workspaceJson: any): string | null {
    const uriStr = workspaceJson.folder || workspaceJson.workspace || null;
    if (!uriStr || typeof uriStr !== "string") return null;
    try {
      const url = new URL(uriStr);
      let p = decodeURIComponent(url.pathname);
      if (os.platform() === "win32" && p.startsWith("/")) {
        p = p.slice(1);
      }
      return p.replaceAll("\\", "/");
    } catch {
      let clean = decodeURIComponent(uriStr.replace(/^file:\/\/\/?/, ""));
      if (os.platform() === "win32" && /^[a-zA-Z]:/.test(clean)) {
        // already valid windows path
      } else if (os.platform() === "win32" && clean.startsWith("/")) {
        clean = clean.slice(1);
      }
      return clean.replaceAll("\\", "/");
    }
  }

  private resolveDiskKVWorkspacePath(composerData: any, dbPath: string): string | null {
    if (composerData.workspaceIdentifier?.uri?.fsPath) {
      return composerData.workspaceIdentifier.uri.fsPath;
    }
    if (composerData.workspaceIdentifier?.id) {
      const wsId = composerData.workspaceIdentifier.id;
      const workspaceJsonPath = path.join(
        path.dirname(path.dirname(dbPath)),
        "workspaceStorage",
        wsId,
        "workspace.json"
      );
      if (fs.existsSync(workspaceJsonPath)) {
        try {
          const wsJson = JSON.parse(fs.readFileSync(workspaceJsonPath, "utf-8"));
          return this.parseWorkspacePath(wsJson);
        } catch {}
      }
    }
    return null;
  }

  private retrieveConversationBubbles(db: any, composerId: string, composerData: any): any[] {
    const bubbleHeaders = composerData.fullConversationHeadersOnly || [];
    const conversationBubbles: any[] = [];
    for (const header of bubbleHeaders) {
      const bubbleKey = `bubbleId:${composerId}:${header.bubbleId}`;
      const bubbleRow = db
        .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
        .get(bubbleKey) as any;
      if (bubbleRow?.value) {
        try {
          conversationBubbles.push(JSON.parse(bubbleRow.value));
        } catch {}
      }
    }
    return conversationBubbles;
  }

  private parseDiskKVRow(row: any, db: any, dbPath: string, sessions: SessionData[]): void {
    try {
      const composerId = row.key.replace("composerData:", "");
      const composerData = JSON.parse(row.value);
      if (!composerData) return;

      const resolvedWorkspacePath = this.resolveDiskKVWorkspacePath(composerData, dbPath);
      const conversationBubbles = this.retrieveConversationBubbles(db, composerId, composerData);

      if (conversationBubbles.length > 0) {
        const state = {
          createdAt: composerData.createdAt || Date.now(),
          workspacePath: resolvedWorkspacePath,
          conversation: conversationBubbles,
        };
        const parsed = SessionParser.parseCursorComposer(composerId, state);
        if (parsed) {
          sessions.push(parsed);
        }
      }
    } catch (rowErr) {
      console.warn("CursorAdapter failed to parse cursorDiskKV composer row:", rowErr);
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

      // 1. Try cursorDiskKV first
      const diskKVCheck = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'"
        )
        .get() as any;

      if (diskKVCheck) {
        const rows = db
          .prepare(
            "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'"
          )
          .all() as any[];

        for (const row of rows) {
          this.parseDiskKVRow(row, db, dbPath, sessions);
        }
      }

      // 2. Fall back to ItemTable if no sessions found
      if (sessions.length === 0) {
        const tableCheck = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'"
          )
          .get() as any;

        if (tableCheck) {
          const rows = db
            .prepare(
              "SELECT key, value FROM ItemTable WHERE key LIKE 'composer.composerState%' OR key LIKE 'composer.composerStates%'"
            )
            .all() as any[];

          for (const row of rows) {
            this.parseComposerRow(row, sessions);
          }
        }
      }

      db.close();
    } catch (e) {
      console.warn("CursorAdapter discoverSessions database error:", e);
    }

    return sessions;
  }
}
