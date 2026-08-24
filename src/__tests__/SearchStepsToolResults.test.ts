import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  setStore,
  SqliteHistoryStore,
  InMemoryHistoryStore,
  HistoryStore,
} from "../db.js";
import { SessionData, TurnData, StepData } from "../adapters/types.js";

describe("search_steps paired execution trace and filter parity", () => {
  let tempDir: string;
  let sqliteStore: SqliteHistoryStore;
  let inMemoryStore: InMemoryHistoryStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-steps-test-"));
    const dbPath = path.join(tempDir, "steps_test.db");
    sqliteStore = new SqliteHistoryStore(dbPath);
    inMemoryStore = new InMemoryHistoryStore();
  });

  afterEach(() => {
    sqliteStore.close();
    setStore(null as any);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function seedTestSession(store: HistoryStore) {
    const session: SessionData = {
      id: "trace-session-1",
      adapter: "antigravity",
      title: "Trace Execution Test Session",
      projectPath: "d:/projects/my-app",
      createdAt: 1000,
      lastActiveAt: 4000,
      firstPrompt: "Execute step pairing",
    };

    const turns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Execute step pairing",
        assistantResponse: "Applied patch and ran command.",
        turnText: "Execute step pairing Applied patch and ran command.",
        inputTokens: 50,
        outputTokens: 30,
        toolCount: 2,
        errorCount: 0,
        createdAt: 1500,
      },
      {
        turnIndex: 2,
        userPrompt: "Run invalid command",
        assistantResponse: "Command failed.",
        turnText: "Run invalid command Command failed.",
        inputTokens: 40,
        outputTokens: 20,
        toolCount: 1,
        errorCount: 1,
        createdAt: 3000,
      },
    ];

    const steps: StepData[] = [
      {
        stepIndex: 1,
        turnIndex: 1,
        stepOrder: 1,
        category: "execution",
        kind: "mcp",
        toolName: "patch_file",
        serverName: "patchitright",
        filePath: "src\\index.ts",
        toolArgs: JSON.stringify({ target_file: "src/index.ts", search_content: "foo" }),
        toolResult: JSON.stringify({ success: true, diff: "+bar" }),
        status: "DONE",
        toolDurationMs: 45,
        createdAt: 1600,
      },
      {
        stepIndex: 2,
        turnIndex: 1,
        stepOrder: 2,
        category: "execution",
        kind: "command",
        toolName: "run_command",
        serverName: "default_api",
        toolArgs: JSON.stringify({ CommandLine: "npm test" }),
        toolResult: "Tests passed: 10/10",
        status: "DONE",
        toolDurationMs: 350,
        createdAt: 1800,
      },
      {
        stepIndex: 3,
        turnIndex: 2,
        stepOrder: 1,
        category: "execution",
        kind: "mcp",
        toolName: "patch_file",
        serverName: "patchitright",
        filePath: "src/db.ts",
        toolArgs: JSON.stringify({ target_file: "src/db.ts" }),
        status: "ERROR",
        errorMessage: "Target content not found",
        toolDurationMs: 80,
        createdAt: 3200,
      },
      {
        stepIndex: 4,
        turnIndex: 2,
        stepOrder: 2,
        category: "agent",
        content: "I noticed the patch failed, investigating...",
        thinking: "Let me check line offsets.",
        status: "DONE",
        createdAt: 3300,
      },
    ];

    store.saveSession(session, turns, steps);
  }

  for (const storeType of ["SqliteHistoryStore", "InMemoryHistoryStore"] as const) {
    describe(`${storeType} Implementation`, () => {
      let store: HistoryStore;

      beforeEach(() => {
        store = storeType === "SqliteHistoryStore" ? sqliteStore : inMemoryStore;
        setStore(store);
        seedTestSession(store);
      });

      it("should pair tool calls with execution results in unified StepData records", () => {
        const steps = store.getSteps("trace-session-1");
        assert.strictEqual(steps.length, 4);

        const patchStep = steps.find((s) => s.stepIndex === 1);
        assert.ok(patchStep);
        assert.strictEqual(patchStep.toolName, "patch_file");
        assert.strictEqual(patchStep.serverName, "patchitright");
        assert.strictEqual(patchStep.status, "DONE");
        assert.ok(patchStep.toolArgs?.includes("src/index.ts"));
        assert.ok(patchStep.toolResult?.includes("+bar"));
        assert.strictEqual(patchStep.toolDurationMs, 45);

        const errStep = steps.find((s) => s.stepIndex === 3);
        assert.ok(errStep);
        assert.strictEqual(errStep.status, "ERROR");
        assert.strictEqual(errStep.errorMessage, "Target content not found");
      });

      it("should filter steps by toolName, serverName, and status without leaking unfiltered steps", () => {
        // Filter by toolName string
        const patchSteps = store.getSteps("trace-session-1", { toolName: "patch_file" });
        assert.strictEqual(patchSteps.length, 2);
        assert.ok(patchSteps.every((s) => s.toolName === "patch_file"));

        // Filter by toolName array
        const multiToolSteps = store.getSteps("trace-session-1", {
          toolName: ["patch_file", "run_command"],
        });
        assert.strictEqual(multiToolSteps.length, 3);

        // Filter by serverName
        const mcpSteps = store.getSteps("trace-session-1", { serverName: "patchitright" });
        assert.strictEqual(mcpSteps.length, 2);
        assert.ok(mcpSteps.every((s) => s.serverName === "patchitright"));

        // Filter by status=ERROR
        const errorSteps = store.getSteps("trace-session-1", { status: "ERROR" });
        assert.strictEqual(errorSteps.length, 1);
        assert.strictEqual(errorSteps[0].stepIndex, 3);
      });

      it("should normalize path separators (/ vs \\) when filtering by filePath", () => {
        // Query with forward slash matching backslash on disk
        const forwardSlashSteps = store.getSteps("trace-session-1", { filePath: "src/index.ts" });
        assert.strictEqual(forwardSlashSteps.length, 1);
        assert.strictEqual(forwardSlashSteps[0].stepIndex, 1);

        // Query with backslash matching forward slash on disk
        const backSlashSteps = store.getSteps("trace-session-1", { filePath: "src\\db.ts" });
        assert.strictEqual(backSlashSteps.length, 1);
        assert.strictEqual(backSlashSteps[0].stepIndex, 3);
      });

      it("should handle boundary edge cases cleanly (empty arrays, non-existent turns/sessions)", () => {
        // Empty toolName array should return empty list
        const emptyToolSteps = store.getSteps("trace-session-1", { toolName: [] });
        assert.strictEqual(emptyToolSteps.length, 0);

        // Non-existent session
        const nonExistentSteps = store.getSteps("non-existent-session");
        assert.strictEqual(nonExistentSteps.length, 0);

        // Batch step loading for turns
        const stepMap = store.getStepsForTurns("trace-session-1", [1, 2]);
        assert.strictEqual(stepMap.get(1)?.length, 2);
        assert.strictEqual(stepMap.get(2)?.length, 2);

        // Batch step loading for empty turn array
        const emptyMap = store.getStepsForTurns("trace-session-1", []);
        assert.strictEqual(emptyMap.size, 0);

        // Batch step loading with non-existent turn indices
        const oobMap = store.getStepsForTurns("trace-session-1", [999]);
        assert.strictEqual(oobMap.get(999)?.length, 0);
      });

      it("should query execution steps via store.query() strictly isolated by sessionId and parameters", () => {
        const queryRes = store.query({
          sessionId: "trace-session-1",
          includeSteps: true,
          toolName: "patch_file",
        });

        assert.strictEqual(queryRes.sessions.length, 1);
        assert.strictEqual(queryRes.sessions[0].id, "trace-session-1");
        assert.strictEqual(queryRes.steps.length, 2);
        assert.ok(queryRes.steps.every((s) => s.toolName === "patch_file"));
      });
    });
  }
});
