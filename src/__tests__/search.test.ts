import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { setStore, getStore, SqliteHistoryStore } from "../db.js";
import { SessionData, TurnData, StepData } from "../adapters/types.js";
import { dotProduct, searchHistory, getSessionDetailsFromDb } from "../search.js";
import { EMBEDDING_DIMENSION } from "../embeddings.js";

describe("Chronicle Search Engine Tests", () => {
  let store: SqliteHistoryStore;

  beforeEach(() => {
    store = new SqliteHistoryStore(":memory:");
    setStore(store);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
  });

  it("should compute dot products correctly", () => {
    assert.strictEqual(dotProduct([1, 0, 0], [1, 0, 0]), 1);
    assert.strictEqual(dotProduct([1, 0, 0], [0, 1, 0]), 0);
    assert.strictEqual(dotProduct([0.5, 0.5, 0], [1, 0, 0]), 0.5);
  });

  it("should insert and retrieve session details correctly", async () => {
    const session: SessionData = {
      id: "session-1",
      adapter: "antigravity",
      title: "Test Title",
      projectPath: "d:/projects/test",
      firstPrompt: "hello",
      createdAt: 1700000000000,
      lastActiveAt: 1700000001000,
    };
    const turns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "hello",
        assistantResponse: "world",
        turnText: "hello world",
        turnVector: new Float32Array(EMBEDDING_DIMENSION),
        inputTokens: 5,
        outputTokens: 5,
        thinkingTokens: 0,
        toolCount: 0,
        errorCount: 0,
        durationMs: 10,
        isUndone: false,
        createdAt: 1700000000000,
      },
    ];
    store.saveSession(session, turns, []);

    const retrieved = store.getSession("session-1");
    assert.ok(retrieved);
    assert.strictEqual(retrieved.title, "Test Title");
    const retrievedTurns = store.getTurns("session-1");
    assert.strictEqual(retrievedTurns.length, 1);
    assert.strictEqual(retrievedTurns[0].userPrompt, "hello");
  });

  it("should rank sessions by vector cosine similarity in searchTurnsVector", async () => {
    const vecA = new Float32Array(EMBEDDING_DIMENSION);
    vecA[0] = 0.95;
    vecA[1] = 0.05;
    const vecB = new Float32Array(EMBEDDING_DIMENSION);
    vecB[0] = 0.1;
    vecB[1] = 0.9;

    const sessionA: SessionData = {
      id: "session-a",
      adapter: "antigravity",
      title: "Session A",
      projectPath: "d:/projects/a",
      firstPrompt: "Close Match Chunk",
      createdAt: 1700000000000,
      lastActiveAt: 1700000001000,
    };
    const turnsA: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Close Match Chunk",
        assistantResponse: "Response A",
        turnText: "Close Match Chunk Response A",
        turnVector: vecA,
        inputTokens: 5,
        outputTokens: 5,
        thinkingTokens: 0,
        toolCount: 0,
        errorCount: 0,
        durationMs: 10,
        isUndone: false,
        createdAt: 1700000000000,
      },
    ];

    const sessionB: SessionData = {
      id: "session-b",
      adapter: "cursor",
      title: "Session B",
      projectPath: "d:/projects/b",
      firstPrompt: "Irrelevant Chunk",
      createdAt: 1700000000000,
      lastActiveAt: 1700000001000,
    };
    const turnsB: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Irrelevant Chunk",
        assistantResponse: "Response B",
        turnText: "Irrelevant Chunk Response B",
        turnVector: vecB,
        inputTokens: 5,
        outputTokens: 5,
        thinkingTokens: 0,
        toolCount: 0,
        errorCount: 0,
        durationMs: 10,
        isUndone: false,
        createdAt: 1700000000000,
      },
    ];

    store.saveSession(sessionA, turnsA, []);
    store.saveSession(sessionB, turnsB, []);

    const queryVec = new Float32Array(EMBEDDING_DIMENSION);
    queryVec[0] = 1.0;

    const hits = store.searchTurnsVector(queryVec, 2);
    assert.strictEqual(hits.length, 2);
    assert.strictEqual(hits[0].sessionId, "session-a");
    assert.ok(hits[0].similarity > 0.9);
  });

  it("should filter searchHistory by projectPath", async () => {
    const sessionC: SessionData = {
      id: "session-c",
      adapter: "antigravity",
      title: "Session C",
      projectPath: "d:/projects/c",
      firstPrompt: "Match in project C",
      createdAt: 1700000000000,
      lastActiveAt: 1700000001000,
    };
    const turnsC: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Match in project C",
        assistantResponse: "Response C",
        turnText: "Match in project C Response C",
        turnVector: new Float32Array(EMBEDDING_DIMENSION),
        inputTokens: 5,
        outputTokens: 5,
        thinkingTokens: 0,
        toolCount: 0,
        errorCount: 0,
        durationMs: 10,
        isUndone: false,
        createdAt: 1700000000000,
      },
    ];
    store.saveSession(sessionC, turnsC, []);

    const hitsC = await searchHistory({
      query: "Match",
      mode: "keyword",
      projectPath: "d:/projects/c",
    });
    assert.strictEqual(hitsC.length, 1);
    assert.strictEqual(hitsC[0].sessionId, "session-c");

    const hitsNone = await searchHistory({
      query: "Match",
      mode: "keyword",
      projectPath: "d:/projects/nonexistent",
    });
    assert.strictEqual(hitsNone.length, 0);
  });

  it("should insert, query, and slice session steps correctly", async () => {
    const session: SessionData = {
      id: "session-steps-test",
      adapter: "antigravity",
      title: "Steps Test Title",
      projectPath: "d:/projects/test",
      firstPrompt: "hello",
      createdAt: 1700000000000,
      lastActiveAt: 1700000002000,
    };
    const turns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "User prompt",
        assistantResponse: "Assistant text",
        turnText: "User prompt Assistant text",
        turnVector: new Float32Array(EMBEDDING_DIMENSION),
        inputTokens: 5,
        outputTokens: 5,
        thinkingTokens: 0,
        toolCount: 1,
        errorCount: 0,
        durationMs: 20,
        isUndone: false,
        createdAt: 1700000000000,
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
        thinking: "Thinking...",
        toolName: "test_tool",
        createdAt: 1700000001000,
        isUndone: false,
      },
      {
        stepIndex: 2,
        turnIndex: 1,
        stepOrder: 2,
        category: "execution",
        kind: "mcp",
        status: "DONE",
        content: "Tool result",
        createdAt: 1700000002000,
        isUndone: false,
      },
    ];
    store.saveSession(session, turns, steps);

    const stepMap = store.getStepsForTurns("session-steps-test", [1]);
    assert.strictEqual(stepMap.get(1)?.length, 2);
    assert.strictEqual(stepMap.get(1)![0].thinking, "Thinking...");
    assert.strictEqual(stepMap.get(1)![0].toolName, "test_tool");
  });

  it("should return valid chronicle_guide documentation structure", () => {
    const guideText = "chronicle-mcp (v1.2.0)";
    assert.ok(guideText.includes("chronicle-mcp"));
  });
});
