import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { setStore, getStore, SqliteHistoryStore } from "../db.js";
import { SessionData } from "../adapters/types.js";
import { dotProduct, searchHistory, getSessionDetailsFromDb } from "../search.js";

describe("Chronicle Search Engine Tests", () => {
  beforeEach(() => {
    // Setup clean in-memory database store for each test
    setStore(new SqliteHistoryStore(":memory:"));
  });

  it("should compute dot products correctly", () => {
    assert.strictEqual(dotProduct([1, 0, 0], [1, 0, 0]), 1);
    assert.strictEqual(dotProduct([1, 0, 0], [0, 1, 0]), 0);
    assert.strictEqual(dotProduct([0.5, 0.5, 0], [1, 0, 0]), 0.5);
  });

  it("should insert and retrieve session details correctly", async () => {
    const store = getStore();
    const session: SessionData = {
      id: "session-1",
      adapter: "antigravity",
      title: "Test Title",
      projectPath: "d:/projects/test",
      createdAt: 1700000000000,
      firstPrompt: "hello",
      secondPrompt: "world",
      chunks: [
        { stepIndex: 0, text: "User: hello\nAssistant: world" }
      ]
    };
    store.save(session, {
      summary: [1, 0],
      chunks: new Map([[0, [1, 0]]])
    });

    const details = await getSessionDetailsFromDb("session-1");
    assert.ok(details);
    assert.strictEqual(details.title, "Test Title");
    assert.strictEqual(details.chunks.length, 1);
    assert.strictEqual(details.chunks[0].chunk_text, "User: hello\nAssistant: world");
  });

  it("should rank sessions and chunks hierarchically in searchHistory", async () => {
    const store = getStore();
    
    // Insert Session A (matches closely to query [1, 0])
    const sessionA: SessionData = {
      id: "session-a",
      adapter: "antigravity",
      title: "Session A",
      projectPath: "d:/projects/a",
      createdAt: 1700000000000,
      firstPrompt: "query matches",
      secondPrompt: "",
      chunks: [
        { stepIndex: 0, text: "Close Match Chunk" },
        { stepIndex: 1, text: "Medium Match Chunk" }
      ]
    };
    store.save(sessionA, {
      summary: [0.9, 0.1],
      chunks: new Map([
        [0, [0.95, 0.05]],
        [1, [0.7, 0.3]]
      ])
    });

    // Insert Session B (poor match to query [1, 0])
    const sessionB: SessionData = {
      id: "session-b",
      adapter: "cursor",
      title: "Session B",
      projectPath: "d:/projects/b",
      createdAt: 1700000000000,
      firstPrompt: "query differs",
      secondPrompt: "",
      chunks: [
        { stepIndex: 0, text: "Irrelevant Chunk" }
      ]
    };
    store.save(sessionB, {
      summary: [0.1, 0.9],
      chunks: new Map([
        [0, [0, 1]]
      ])
    });

    // Insert 5 dummy sessions to push Session B out of top 5
    for (let i = 1; i <= 5; i++) {
      const dummy: SessionData = {
        id: `session-dummy-${i}`,
        adapter: "antigravity",
        title: `Dummy ${i}`,
        projectPath: "",
        createdAt: 1700000000000,
        firstPrompt: "",
        secondPrompt: "",
        chunks: []
      };
      store.save(dummy, {
        summary: [0.3, 0.7],
        chunks: new Map()
      });
    }

    // Execute search with query vector [1, 0]
    const hits = await searchHistory([1, 0], 3);
    
    assert.strictEqual(hits.length, 2); // Only chunks of Session A should be returned
    assert.strictEqual(hits[0].chunkText, "Close Match Chunk");
    assert.ok(Math.abs(hits[0].similarity - 0.95) < 0.01);
    assert.strictEqual(hits[1].chunkText, "Medium Match Chunk");
    assert.ok(Math.abs(hits[1].similarity - 0.7) < 0.01);
  });

  it("should ignore duplicate chunks with the same session_id and step_index", () => {
    const store = getStore();
    
    // Insert Session
    const session: SessionData = {
      id: "session-dup",
      adapter: "antigravity",
      title: "Dup Test",
      projectPath: "",
      createdAt: 1700000000000,
      firstPrompt: "",
      secondPrompt: "",
      chunks: [
        { stepIndex: 1, text: "First chunk" }
      ]
    };
    store.save(session, {
      summary: [1, 0],
      chunks: new Map([[1, [1, 0]]])
    });

    // Save session again but with chunk stepIndex 1 having different text
    const session2: SessionData = {
      ...session,
      chunks: [
        { stepIndex: 1, text: "First chunk" },
        { stepIndex: 1, text: "Duplicate chunk" }
      ]
    };
    store.save(session2, {
      summary: [1, 0],
      chunks: new Map([[1, [1, 0]]])
    });

    // Verify only the first chunk exists
    const res = store.query({ sessionId: "session-dup" });
    assert.strictEqual(res.chunks.length, 1);
    assert.strictEqual(res.chunks[0].text, "First chunk");
  });

  it("should insert, query, and slice session steps correctly", async () => {
    const store = getStore();
    const session: SessionData = {
      id: "session-steps-test",
      adapter: "antigravity",
      title: "Steps Test Title",
      projectPath: "d:/projects/test",
      createdAt: 1700000000000,
      firstPrompt: "hello",
      secondPrompt: "world",
      chunks: [],
      steps: [
        { stepIndex: 0, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", content: "User prompt", createdAt: 1700000000000 },
        { stepIndex: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "Assistant text", thinking: "Thinking...", toolCalls: JSON.stringify([{ name: "test_tool" }]), createdAt: 1700000001000 },
        { stepIndex: 2, type: "MCP_TOOL", source: "MODEL", status: "DONE", content: "Tool result", createdAt: 1700000002000 }
      ]
    };
    store.save(session, {
      summary: [1, 0],
      chunks: new Map()
    });

    // Get session details with includeToolCalls
    const detailsWithCalls = await getSessionDetailsFromDb("session-steps-test", { includeToolCalls: true });
    assert.ok(detailsWithCalls);
    assert.strictEqual(detailsWithCalls.steps.length, 3);
    assert.strictEqual(detailsWithCalls.steps[1].type, "PLANNER_RESPONSE");
    assert.strictEqual(detailsWithCalls.steps[1].thinking, "Thinking...");
    assert.strictEqual(JSON.parse(detailsWithCalls.steps[1].tool_calls)[0].name, "test_tool");

    // Get session details with slicing
    const detailsSliced = await getSessionDetailsFromDb("session-steps-test", { includeToolCalls: true, startStep: 1, endStep: 2 });
    assert.strictEqual(detailsSliced.steps.length, 2);
    assert.strictEqual(detailsSliced.steps[0].step_index, 1);
    assert.strictEqual(detailsSliced.steps[1].step_index, 2);
  });

  it("should filter searchHistory by projectPath", async () => {
    const store = getStore();

    // Insert Session C (matches closely to query [1, 0] but has different project path)
    const sessionC: SessionData = {
      id: "session-c",
      adapter: "antigravity",
      title: "Session C",
      projectPath: "d:/projects/c",
      createdAt: 1700000000000,
      firstPrompt: "query matches",
      secondPrompt: "",
      chunks: [
        { stepIndex: 0, text: "Close Match Chunk C" }
      ]
    };
    store.save(sessionC, {
      summary: [0.9, 0.1],
      chunks: new Map([[0, [0.95, 0.05]]])
    });

    // Search with projectPath constraint
    const hitsC = await searchHistory([1, 0], 3, { projectPath: "d:/projects/c" });
    assert.strictEqual(hitsC.length, 1);
    assert.strictEqual(hitsC[0].sessionId, "session-c");
    assert.strictEqual(hitsC[0].chunkText, "Close Match Chunk C");

    // Search with non-matching projectPath constraint
    const hitsNone = await searchHistory([1, 0], 3, { projectPath: "d:/projects/nonexistent" });
    assert.strictEqual(hitsNone.length, 0);
  });

  it("should query session steps using LIKE and filters correctly", () => {
    const store = getStore();
    
    // Insert session first to satisfy FOREIGN KEY constraint
    const session: SessionData = {
      id: "session-steps-test",
      adapter: "antigravity",
      title: "Steps Test Title",
      projectPath: "d:/projects/test",
      createdAt: 1700000000000,
      firstPrompt: "hello",
      secondPrompt: "world",
      chunks: [],
      steps: [
        { stepIndex: 5, type: "COMMAND", source: "MODEL", status: "ERROR", content: "npm run test failed", createdAt: 1700000003000 }
      ]
    };
    store.save(session, {
      summary: [1, 0],
      chunks: new Map()
    });

    // Test query for specific content
    const res = store.query({
      sessionId: "session-steps-test",
      includeSteps: true,
      stepQuery: "failed",
      stepStatus: "ERROR"
    });
    
    assert.strictEqual(res.steps.length, 1);
    assert.strictEqual(res.steps[0].stepIndex, 5);
    assert.strictEqual(res.steps[0].status, "ERROR");
  });
});
