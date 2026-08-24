import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteHistoryStore, setStore } from "../db.js";
import { queryTranscript } from "../search.js";
import { SessionData, TurnData, StepData } from "../adapters/types.js";
import { EMBEDDING_DIMENSION } from "../embeddings.js";

describe("QueryTranscript Unit & Integration Suite", () => {
  let dbPath: string;
  let store: SqliteHistoryStore;
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-query-test-"));
    dbPath = path.join(tempDir, `test_query_transcript_${Date.now()}.db`);
    store = new SqliteHistoryStore(dbPath);
    setStore(store);

    // Seed test session data
    const session: SessionData = {
      id: "sess-query-test-1",
      title: "Test Query Transcript Session",
      adapter: "antigravity",
      projectPath: "d:/Projects/chronicle-mcp",
      firstPrompt: "Fix bug in patch_file tool execution",
      createdAt: 1000,
      lastActiveAt: 2000,
    };
    const turns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Fix bug in patch_file tool execution",
        assistantResponse: "I will patch the file using patch_file.",
        turnText: "Fix bug in patch_file tool execution I will patch the file using patch_file.",
        turnVector: new Float32Array(EMBEDDING_DIMENSION),
        inputTokens: 10,
        outputTokens: 10,
        thinkingTokens: 20,
        toolCount: 1,
        errorCount: 0,
        durationMs: 100,
        isUndone: false,
        createdAt: 1000,
      },
      {
        turnIndex: 2,
        userPrompt: "Run verification tests",
        assistantResponse: "Tests completed successfully.",
        turnText: "Run verification tests Tests completed successfully.",
        turnVector: new Float32Array(EMBEDDING_DIMENSION),
        inputTokens: 10,
        outputTokens: 10,
        thinkingTokens: 10,
        toolCount: 1,
        errorCount: 0,
        durationMs: 50,
        isUndone: false,
        createdAt: 2000,
      },
    ];
    const steps: StepData[] = [
      {
        stepIndex: 1,
        turnIndex: 1,
        stepOrder: 1,
        category: "execution",
        kind: "mcp",
        status: "DONE",
        thinking: "Analyzing file contents and patch delta.",
        toolName: "patch_file",
        serverName: "patchitright",
        filePath: "src/index.ts",
        toolArgs: JSON.stringify({ target_file: "src/index.ts" }),
        toolResult: "Successfully patched src/index.ts",
        toolDurationMs: 80,
        createdAt: 1100,
        isUndone: false,
      },
      {
        stepIndex: 2,
        turnIndex: 2,
        stepOrder: 1,
        category: "execution",
        kind: "command",
        status: "DONE",
        toolName: "run_command",
        filePath: "src/index.ts",
        toolArgs: JSON.stringify({ command: "npm test" }),
        toolResult: "Pass: 10 tests",
        toolDurationMs: 40,
        createdAt: 2100,
        isUndone: false,
      },
    ];
    store.saveSession(session, turns, steps);
  });

  after(() => {
    try {
      store.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("should format compact disclosure by default", async () => {
    const res = await queryTranscript({ sessionId: "sess-query-test-1" });
    assert.ok(res.text.includes("[Turn 1]"));
    assert.ok(res.text.includes("[Turn 2]"));
    assert.ok(res.text.includes("- [patchitright/patch_file] `src/index.ts` - DONE (80ms)"));
    assert.ok(res.text.includes("Fix bug in patch_file"));
  });

  it("should format full disclosure with thinking and tool results", async () => {
    const res = await queryTranscript({
      sessionId: "sess-query-test-1",
      turnIndex: 1,
      detailLevel: "full",
    });
    assert.ok(res.text.includes("[Turn 1]"));
    assert.ok(res.text.includes("Analyzing file contents and patch delta."));
    assert.ok(res.text.includes("Successfully patched src/index.ts"));
  });

  it("should format summary disclosure without executions", async () => {
    const res = await queryTranscript({
      sessionId: "sess-query-test-1",
      detailLevel: "summary",
    });
    assert.ok(res.text.includes("Fix bug in patch_file tool execution"));
    assert.ok(res.text.includes("I will patch the file using patch_file."));
    assert.ok(!res.text.includes("patchitright/patch_file"));
  });

  it("should handle turn slicing with negative indexing", async () => {
    const res = await queryTranscript({
      sessionId: "sess-query-test-1",
      turnIndex: -1,
    });
    assert.ok(res.text.includes("[Turn 2]"));
    assert.ok(!res.text.includes("[Turn 1]"));
  });

  it("should export transcript to JSON on disk", async () => {
    const jsonPath = path.join(tempDir, "test_transcript_export.json");
    const res = await queryTranscript({
      sessionId: "sess-query-test-1",
      output: jsonPath,
    });
    assert.ok(fs.existsSync(jsonPath));
    const content = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    assert.strictEqual(content.sessionId, "sess-query-test-1");
    assert.strictEqual(content.turnCount, 2);
  });

  it("should export transcript to Markdown on disk", async () => {
    const mdPath = path.join(tempDir, "test_transcript_export.md");
    const res = await queryTranscript({
      sessionId: "sess-query-test-1",
      output: mdPath,
    });
    assert.ok(fs.existsSync(mdPath));
    const content = fs.readFileSync(mdPath, "utf8");
    assert.ok(content.includes("[Turn 1]"));
    assert.ok(content.includes("[Turn 2]"));
  });

  it("should filter steps by toolName", async () => {
    const res = await queryTranscript({
      sessionId: "sess-query-test-1",
      toolFilter: { name: "patch_file" },
    });
    assert.ok(res.text.includes("patchitright/patch_file"));
    assert.ok(!res.text.includes("run_command"));
  });

  it("should filter steps by filePath", async () => {
    const res = await queryTranscript({
      sessionId: "sess-query-test-1",
      filePath: "src/index.ts",
    });
    assert.ok(res.text.includes("src/index.ts"));
  });
});
