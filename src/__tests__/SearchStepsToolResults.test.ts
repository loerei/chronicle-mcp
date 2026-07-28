import { describe, it } from "node:test";
import assert from "node:assert";
import { InMemoryHistoryStore } from "../db.js";

describe("search_steps includeToolResults", () => {
  it("should pair tool calls with step N+1 tool results when includeToolResults is true", () => {
    const store = new InMemoryHistoryStore();
    store.save(
      {
        id: "test-session-1",
        adapter: "antigravity",
        title: "Test Session",
        projectPath: "d:/Projects/test",
        createdAt: 1000,
        firstPrompt: "Hello",
        secondPrompt: "World",
        chunks: [],
        steps: [
          {
            stepIndex: 1,
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Patching file",
            thinking: "I will patch file",
            toolCalls: JSON.stringify([{ name: "patch_file", args: { target_file: "test.ts" } }]),
            createdAt: 1000,
          },
          {
            stepIndex: 2,
            type: "MCP_TOOL",
            source: "SYSTEM",
            status: "DONE",
            content: "Successfully applied patch to test.ts",
            createdAt: 1001,
          },
        ],
      },
      { chunks: new Map() }
    );

    const res = store.query({
      sessionId: "test-session-1",
      includeSteps: true,
      toolName: "patch_file",
      includeToolResults: true,
    });

    assert.strictEqual(res.steps.length, 1);
    const step = res.steps[0] as any;
    assert.strictEqual(step.stepIndex, 1);
    assert.ok(step.tool_result);
    assert.strictEqual(step.tool_result.step_index, 2);
    assert.strictEqual(step.tool_result.type, "MCP_TOOL");
    assert.strictEqual(step.tool_result.content, "Successfully applied patch to test.ts");
  });
});
