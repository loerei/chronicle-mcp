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

  it("should omit undone steps by default and include them when includeUndone=true with forensic markdown formatting", async () => {
    store.save(
      {
        id: "sess-undone-export-test",
        title: "Test Undone Export",
        adapter: "antigravity",
        projectPath: "d:/Projects/test",
        createdAt: 1000,
        firstPrompt: "init",
        secondPrompt: "",
        chunks: [],
        steps: [
          {
            stepIndex: 0,
            type: "USER_INPUT",
            source: "USER_EXPLICIT",
            status: "DONE",
            content: "First valid turn",
            createdAt: 1000,
            isUndone: false,
          },
          {
            stepIndex: 1,
            type: "USER_INPUT",
            source: "USER_EXPLICIT",
            status: "DONE",
            content: "Discarded undone turn",
            createdAt: 1100,
            isUndone: true,
          },
          {
            stepIndex: 1,
            type: "USER_INPUT",
            source: "USER_EXPLICIT",
            status: "DONE",
            content: "Surviving replacement turn",
            createdAt: 1200,
            isUndone: false,
          },
        ],
      },
      { chunks: new Map() }
    );

    // Default: includeUndone = false
    const resDefault = await handleQueryTranscript({ sessionId: "sess-undone-export-test" });
    const dataDefault = JSON.parse(resDefault.content[0].text);
    assert.strictEqual(dataDefault.length, 2);
    assert.strictEqual(dataDefault[0].content, "First valid turn");
    assert.strictEqual(dataDefault[1].content, "Surviving replacement turn");

    // With includeUndone = true and Markdown file output
    const tmpMdFile = path.join(os.tmpdir(), `query_export_undone_${Date.now()}.md`);
    await handleQueryTranscript({
      sessionId: "sess-undone-export-test",
      includeUndone: true,
      output: tmpMdFile,
    });

    assert.ok(fs.existsSync(tmpMdFile));
    const mdContent = fs.readFileSync(tmpMdFile, "utf-8");
    assert.ok(mdContent.includes("[UNDONE / REWOUND]"));
    assert.ok(mdContent.includes("Discarded undone turn"));
    assert.ok(mdContent.includes("Surviving replacement turn"));

    fs.unlinkSync(tmpMdFile);
  });

  it("should export all steps when output is provided without limit (no truncation for large transcripts)", async () => {
    const largeSessionId = "sess-large-export-test";
    const numSteps = 25;
    const steps: any[] = [];

    for (let i = 0; i < numSteps; i++) {
      steps.push({
        stepIndex: i,
        type: i % 2 === 0 ? "USER_INPUT" : "PLANNER_RESPONSE",
        source: i % 2 === 0 ? "USER" : "MODEL",
        status: "DONE",
        content: `Step ${i + 1} content`,
        createdAt: 1000 + i,
        isUndone: false,
      });
    }

    store.save(
      {
        id: largeSessionId,
        title: "Large Export Session",
        adapter: "antigravity",
        projectPath: "d:/Projects/test",
        createdAt: 1000,
        firstPrompt: "init",
        secondPrompt: "",
        chunks: [],
        steps,
      },
      { chunks: new Map() }
    );

    const tmpOutputFile = path.join(os.tmpdir(), `large-transcript-${Date.now()}.md`);

    await handleQueryTranscript({
      sessionId: largeSessionId,
      includeUndone: false,
      output: tmpOutputFile,
    });

    const contents = fs.readFileSync(tmpOutputFile, "utf-8");
    for (let i = 0; i < numSteps; i++) {
      assert.ok(contents.includes(`Step ${i + 1} content`));
    }

    fs.unlinkSync(tmpOutputFile);
  });

  it("should include undone steps with isUndone flag in JSON output when includeUndone=true", async () => {
    const jsonSessionId = "sess-json-undone-export-test";
    store.save(
      {
        id: jsonSessionId,
        title: "JSON Undone Export Session",
        adapter: "antigravity",
        projectPath: "d:/Projects/test",
        createdAt: 1000,
        firstPrompt: "init",
        secondPrompt: "",
        chunks: [],
        steps: [
          {
            stepIndex: 0,
            type: "USER_INPUT",
            source: "USER",
            status: "DONE",
            content: "First completed step",
            createdAt: 1100,
            isUndone: false,
          },
          {
            stepIndex: 1,
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Second completed step",
            createdAt: 1200,
            isUndone: false,
          },
          {
            stepIndex: 1,
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Third step that was undone",
            createdAt: 1300,
            isUndone: true,
          },
        ],
      },
      { chunks: new Map() }
    );

    const result: any = await handleQueryTranscript({
      sessionId: jsonSessionId,
      includeUndone: true,
    });

    const steps = JSON.parse(result.content[0].text);
    assert.strictEqual(steps.length, 3);
    const undoneSteps = steps.filter((s: any) => s.is_undone === true || s.isUndone === true);
    const doneSteps = steps.filter((s: any) => !s.is_undone && !s.isUndone);

    assert.strictEqual(undoneSteps.length, 1);
    assert.strictEqual(doneSteps.length, 2);
    assert.strictEqual(undoneSteps[0].content, "Third step that was undone");
  });

  it("should filter steps by single toolName string and toolName string array", async () => {
    const resSingle: any = await handleQueryTranscript({
      sessionId: "sess-query-test-1",
      toolName: "patch_file",
    });
    const stepsSingle = JSON.parse(resSingle.content[0].text);
    assert.strictEqual(stepsSingle.length, 1);
    assert.strictEqual(stepsSingle[0].step_index, 1);

    const resArray: any = await handleQueryTranscript({
      sessionId: "sess-query-test-1",
      toolName: ["patch_file", "view_file"],
    });
    const stepsArray = JSON.parse(resArray.content[0].text);
    assert.strictEqual(stepsArray.length, 1);
    assert.strictEqual(stepsArray[0].step_index, 1);

    const resNone: any = await handleQueryTranscript({
      sessionId: "sess-query-test-1",
      toolName: ["non_existent_tool"],
    });
    const stepsNone = JSON.parse(resNone.content[0].text);
    assert.strictEqual(stepsNone.length, 0);
  });
});
