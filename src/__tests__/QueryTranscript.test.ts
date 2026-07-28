import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteHistoryStore, setStore } from "../db.js";
import { handleQueryTranscript } from "../index.js";

describe("QueryTranscript Unit & Integration Suite", () => {
  let dbPath: string;
  let store: SqliteHistoryStore;

  before(() => {
    dbPath = path.join(os.tmpdir(), `test_query_transcript_${Date.now()}.db`);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    store = new SqliteHistoryStore(dbPath);
    setStore(store);

    // Seed test session data via store.save()
    store.save(
      {
        id: "sess-query-test-1",
        title: "Test Query Transcript Session",
        adapter: "antigravity",
        projectPath: "d:/Projects/chronicle-mcp",
        createdAt: 1000,
        lastActiveAt: 2000,
        firstPrompt: "Fix bug in patch_file tool execution",
        secondPrompt: "",
        chunks: [],
        steps: [
          {
            stepIndex: 0,
            type: "USER_INPUT",
            source: "USER_EXPLICIT",
            status: "DONE",
            content: "Fix bug in patch_file tool execution",
            createdAt: 1000,
          },
          {
            stepIndex: 1,
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "I will patch the file using patch_file.",
            thinking: "Analyzing file contents and patch delta.",
            toolCalls: JSON.stringify([{ name: "patch_file", args: { target_file: "src/index.ts" } }]),
            createdAt: 1100,
          },
          {
            stepIndex: 2,
            type: "MCP_TOOL",
            source: "SYSTEM",
            status: "DONE",
            content: "Successfully patched src/index.ts",
            createdAt: 1200,
          },
          {
            stepIndex: 3,
            type: "CHECKPOINT",
            source: "SYSTEM",
            status: "ERROR",
            content: "Execution error encountered",
            createdAt: 1300,
          },
        ],
      },
      { chunks: new Map() }
    );
  });

  after(() => {
    if (fs.existsSync(dbPath)) {
      try {
        fs.unlinkSync(dbPath);
      } catch (e) {
        // Ignore file lock cleanup errors on Windows
      }
    }
  });

  it("should normalize categories to all 5 when omitted or empty", async () => {
    const res = await handleQueryTranscript({ sessionId: "sess-query-test-1" });
    assert.strictEqual(res.isError, undefined);
    const data = JSON.parse(res.content[0].text);
    assert.strictEqual(data.length, 4);
    assert.strictEqual(data[0].step_index, 0);
    assert.strictEqual(data[1].step_index, 1);
    assert.ok(data[1].thinking);
    assert.ok(data[1].tool_calls);
  });

  it("should normalize categories when passed an empty array", async () => {
    const res = await handleQueryTranscript({
      sessionId: "sess-query-test-1",
      categories: [],
    });
    assert.strictEqual(res.isError, undefined);
    const data = JSON.parse(res.content[0].text);
    assert.strictEqual(data.length, 4);
    assert.strictEqual(data[0].step_index, 0);
    assert.strictEqual(data[1].step_index, 1);
    assert.ok(data[1].thinking);
    assert.ok(data[1].tool_calls);
  });

  it("should extract specified categories only", async () => {
    const res = await handleQueryTranscript({
      sessionId: "sess-query-test-1",
      categories: ["tool_results"],
    });
    const data = JSON.parse(res.content[0].text);
    assert.ok(Array.isArray(data));
    const patchCallStep = data.find((s: any) => s.step_index === 1);
    assert.ok(patchCallStep);
    assert.ok(patchCallStep.tool_result);
    assert.strictEqual(patchCallStep.tool_result.content, "Successfully patched src/index.ts");
  });

  it("should sort reverse chronological when sort='time_new_to_old'", async () => {
    const res = await handleQueryTranscript({
      sessionId: "sess-query-test-1",
      sort: "time_new_to_old",
    });
    const data = JSON.parse(res.content[0].text);
    assert.strictEqual(data[0].step_index, 3);
    assert.strictEqual(data[data.length - 1].step_index, 0);
  });

  it("should group by category when sort='category'", async () => {
    const res = await handleQueryTranscript({
      sessionId: "sess-query-test-1",
      sort: "category",
    });
    const data = JSON.parse(res.content[0].text);
    assert.ok(data.conversation_steps);
    assert.ok(data.tool_calls);
    assert.ok(data.tool_results);
    assert.ok(data.thinking);
    assert.ok(data.system_events);
    assert.strictEqual(data.conversation_steps.length, 2);
    assert.strictEqual(data.system_events.length, 2); // MCP_TOOL result + CHECKPOINT error
  });

  it("should handle output parameter and write JSON to disk", async () => {
    const tmpOutputFile = path.join(os.tmpdir(), `query_export_${Date.now()}.json`);
    const res = await handleQueryTranscript({
      sessionId: "sess-query-test-1",
      output: tmpOutputFile,
    });

    assert.ok(fs.existsSync(tmpOutputFile));
    const fileContent = fs.readFileSync(tmpOutputFile, "utf-8");
    const json = JSON.parse(fileContent);
    assert.strictEqual(json.length, 4);

    fs.unlinkSync(tmpOutputFile);
  });
});
