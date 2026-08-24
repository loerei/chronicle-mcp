import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  SqliteHistoryStore,
  InMemoryHistoryStore,
  setStore,
  getStore,
  sanitizeFts5Query,
} from "../db.js";
import {
  searchHistory,
  queryTranscript,
  SearchHistoryOptions,
  TranscriptQueryOptions,
} from "../search.js";
import {
  MockEmbeddingClient,
  setEmbeddingClient,
  EMBEDDING_DIMENSION,
  blobToVector,
  vectorToBlob,
} from "../embeddings.js";
import { SessionData, TurnData, StepData } from "../adapters/types.js";

describe("SearchEngine & Progressive Disclosure Test Suite", () => {
  let dbPath: string;
  let store: SqliteHistoryStore;
  let mockEmbeddings: MockEmbeddingClient;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-test-"));
    dbPath = path.join(tempDir, `search_engine_test_${Date.now()}.db`);
    store = new SqliteHistoryStore(dbPath);
    setStore(store);

    mockEmbeddings = new MockEmbeddingClient();
    mockEmbeddings.reset();
    setEmbeddingClient(mockEmbeddings);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // Scenario 1: FTS5 Keyword Search Mode
  it("1. FTS5 Keyword Search Mode with symbols, paths, and query sanitization", async () => {
    const session: SessionData = {
      id: "sess-fts-1",
      title: "FTS5 Test Session",
      adapter: "antigravity",
      projectPath: "d:/Projects/chronicle-mcp",
      firstPrompt: "Refactor SessionParser in src/db.ts to fix error: ERR_INVALID_ARG",
      createdAt: 1000,
      lastActiveAt: 2000,
    };
    const turns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Refactor SessionParser in src/db.ts to fix error: ERR_INVALID_ARG",
        assistantResponse: "I will update SessionParser in src/db.ts.",
        turnText: "Refactor SessionParser in src/db.ts to fix error: ERR_INVALID_ARG I will update SessionParser in src/db.ts.",
        turnVector: new Float32Array(EMBEDDING_DIMENSION),
        inputTokens: 10,
        outputTokens: 10,
        thinkingTokens: 0,
        toolCount: 1,
        errorCount: 1,
        durationMs: 50,
        isUndone: false,
        createdAt: 1000,
      },
    ];
    store.saveSession(session, turns, []);

    // Exact symbol match
    const hitsSymbol = await searchHistory({
      query: "SessionParser",
      mode: "keyword",
    });
    assert.strictEqual(hitsSymbol.length, 1);
    assert.strictEqual(hitsSymbol[0].sessionId, "sess-fts-1");

    // Path match
    const hitsPath = await searchHistory({
      query: "src/db.ts",
      mode: "keyword",
    });
    assert.strictEqual(hitsPath.length, 1);

    // Sanitization with quotes & special characters
    const sanitized = sanitizeFts5Query('error: "ERR_INVALID_ARG" --test');
    assert.ok(sanitized);
    assert.ok(!sanitized.includes('""ERR_INVALID_ARG""'));

    // Empty query short-circuit
    const emptyHits = await searchHistory({
      query: "   ",
      mode: "keyword",
    });
    assert.deepStrictEqual(emptyHits, []);
  });

  // Scenario 2: Vector Semantic Search Mode
  it("2. Vector Semantic Search Mode with cosine similarity and NaN/zero guards", async () => {
    const vec1 = new Float32Array(EMBEDDING_DIMENSION);
    vec1[0] = 1.0;
    const vec2 = new Float32Array(EMBEDDING_DIMENSION);
    vec2[1] = 1.0;

    mockEmbeddings.setMockVector("semantic search test", Array.from(vec1));

    const session: SessionData = {
      id: "sess-vec-1",
      title: "Vector Search Session",
      adapter: "antigravity",
      projectPath: "d:/Projects/chronicle-mcp",
      firstPrompt: "semantic search test target prompt",
      createdAt: 1000,
      lastActiveAt: 2000,
    };
    const turns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "semantic search test target prompt",
        assistantResponse: "Target response",
        turnText: "semantic search test target prompt Target response",
        turnVector: vec1,
        inputTokens: 10,
        outputTokens: 10,
        thinkingTokens: 0,
        toolCount: 0,
        errorCount: 0,
        durationMs: 20,
        isUndone: false,
        createdAt: 1000,
      },
      {
        turnIndex: 2,
        userPrompt: "orthogonal prompt",
        assistantResponse: "Orthogonal response",
        turnText: "orthogonal prompt Orthogonal response",
        turnVector: vec2,
        inputTokens: 10,
        outputTokens: 10,
        thinkingTokens: 0,
        toolCount: 0,
        errorCount: 0,
        durationMs: 20,
        isUndone: false,
        createdAt: 2000,
      },
    ];
    store.saveSession(session, turns, []);

    const hits = await searchHistory({
      query: "semantic search test",
      mode: "semantic",
      limit: 2,
    });
    assert.strictEqual(hits.length, 2);
    assert.strictEqual(hits[0].turnIndex, 1);
    assert.ok(hits[0].score > 0.99);
    assert.strictEqual(hits[1].turnIndex, 2);
    assert.ok(Math.abs(hits[1].score) < 1e-4);
  });

  // Scenario 3: Hybrid Search & RRF Fusion
  it("3. Hybrid Search & RRF Fusion combining keyword and vector rankings", async () => {
    const vecA = new Float32Array(EMBEDDING_DIMENSION);
    vecA[0] = 0.9;
    vecA[1] = 0.1;
    const vecB = new Float32Array(EMBEDDING_DIMENSION);
    vecB[0] = 0.1;
    vecB[1] = 0.9;

    mockEmbeddings.setMockVector("authentication token", Array.from(vecA));

    const session: SessionData = {
      id: "sess-hybrid-1",
      title: "Hybrid Search Session",
      adapter: "antigravity",
      projectPath: "d:/Projects/chronicle-mcp",
      firstPrompt: "authentication token verification logic",
      createdAt: 1000,
      lastActiveAt: 2000,
    };
    const turns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "authentication token verification logic",
        assistantResponse: "Implementing authentication token validation",
        turnText: "authentication token verification logic Implementing authentication token validation",
        turnVector: vecA,
        inputTokens: 10,
        outputTokens: 10,
        thinkingTokens: 0,
        toolCount: 0,
        errorCount: 0,
        durationMs: 20,
        isUndone: false,
        createdAt: 1000,
      },
      {
        turnIndex: 2,
        userPrompt: "unrelated database schema changes",
        assistantResponse: "Database schema migration",
        turnText: "unrelated database schema changes Database schema migration",
        turnVector: vecB,
        inputTokens: 10,
        outputTokens: 10,
        thinkingTokens: 0,
        toolCount: 0,
        errorCount: 0,
        durationMs: 20,
        isUndone: false,
        createdAt: 2000,
      },
    ];
    store.saveSession(session, turns, []);

    const hits = await searchHistory({
      query: "authentication token",
      mode: "hybrid",
      limit: 5,
    });
    assert.ok(hits.length >= 1);
    assert.strictEqual(hits[0].turnIndex, 1);
    assert.strictEqual(hits[0].conversationLink, "conversation://sess-hybrid-1");
  });

  // Scenario 4: Search Filters
  it("4. Database-level Search Filters (role, hasErrors, onlySubagents, onlyUserPrompts)", async () => {
    const parentSession: SessionData = {
      id: "sess-parent",
      title: "Parent Session",
      adapter: "antigravity",
      role: "lead",
      projectPath: "d:/Projects/chronicle-mcp",
      firstPrompt: "Execute build and test pipeline",
      createdAt: 1000,
      lastActiveAt: 3000,
    };
    const childSession: SessionData = {
      id: "sess-child",
      parentId: "sess-parent",
      title: "Subagent Session",
      adapter: "antigravity",
      role: "researcher",
      projectPath: "d:/Projects/chronicle-mcp",
      firstPrompt: "Research bug report for pipeline",
      createdAt: 2000,
      lastActiveAt: 3000,
    };

    const parentTurns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Execute build and test pipeline",
        assistantResponse: "Build failed with error",
        turnText: "Execute build and test pipeline Build failed with error",
        turnVector: new Float32Array(EMBEDDING_DIMENSION),
        inputTokens: 10,
        outputTokens: 10,
        thinkingTokens: 0,
        toolCount: 1,
        errorCount: 1,
        durationMs: 50,
        isUndone: false,
        createdAt: 1000,
      },
    ];

    const childTurns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Research bug report for pipeline",
        assistantResponse: "Found relevant documentation",
        turnText: "Research bug report for pipeline Found relevant documentation",
        turnVector: new Float32Array(EMBEDDING_DIMENSION),
        inputTokens: 10,
        outputTokens: 10,
        thinkingTokens: 0,
        toolCount: 0,
        errorCount: 0,
        durationMs: 20,
        isUndone: false,
        createdAt: 2000,
      },
    ];

    store.saveSession(parentSession, parentTurns, []);
    store.saveSession(childSession, childTurns, []);

    // Filter by role
    const roleHits = await searchHistory({
      query: "pipeline",
      mode: "keyword",
      filter: { role: "researcher" },
    });
    assert.strictEqual(roleHits.length, 1);
    assert.strictEqual(roleHits[0].sessionId, "sess-child");

    // Filter by hasErrors
    const errorHits = await searchHistory({
      query: "pipeline",
      mode: "keyword",
      filter: { hasErrors: true },
    });
    assert.strictEqual(errorHits.length, 1);
    assert.strictEqual(errorHits[0].sessionId, "sess-parent");

    // Filter by onlySubagents
    const subHits = await searchHistory({
      query: "pipeline",
      mode: "keyword",
      filter: { onlySubagents: true },
    });
    assert.strictEqual(subHits.length, 1);
    assert.strictEqual(subHits[0].sessionId, "sess-child");

    // Filter by onlyUserPrompts
    const promptOnlyHits = await searchHistory({
      query: "Research",
      mode: "keyword",
      filter: { onlyUserPrompts: true },
    });
    assert.strictEqual(promptOnlyHits.length, 1);
  });

  // Scenario 5: Symmetric Negative Turn Index Slicing
  it("5. Symmetric Negative Turn Index Slicing (-1, startTurn: -3, lastTurns)", async () => {
    const session: SessionData = {
      id: "sess-slice-1",
      title: "Turn Slicing Session",
      adapter: "antigravity",
      projectPath: "d:/Projects/chronicle-mcp",
      firstPrompt: "Turn 1 prompt",
      createdAt: 1000,
      lastActiveAt: 5000,
    };
    const turns: TurnData[] = [];
    for (let i = 1; i <= 5; i++) {
      turns.push({
        turnIndex: i,
        userPrompt: `Turn ${i} prompt`,
        assistantResponse: `Turn ${i} response`,
        turnText: `Turn ${i} prompt Turn ${i} response`,
        turnVector: new Float32Array(EMBEDDING_DIMENSION),
        inputTokens: 10,
        outputTokens: 10,
        thinkingTokens: 0,
        toolCount: 0,
        errorCount: 0,
        durationMs: 10,
        isUndone: false,
        createdAt: 1000 * i,
      });
    }
    store.saveSession(session, turns, []);

    // turnIndex: -1 (latest turn = 5)
    const resLatest = await queryTranscript({
      sessionId: "sess-slice-1",
      turnIndex: -1,
    });
    assert.ok(resLatest.text.includes("[Turn 5]"));
    assert.ok(!resLatest.text.includes("[Turn 4]"));

    // startTurn: -3, endTurn: -1 (turns 3, 4, 5)
    const resRange = await queryTranscript({
      sessionId: "sess-slice-1",
      startTurn: -3,
      endTurn: -1,
    });
    assert.ok(resRange.text.includes("[Turn 3]"));
    assert.ok(resRange.text.includes("[Turn 4]"));
    assert.ok(resRange.text.includes("[Turn 5]"));
    assert.ok(!resRange.text.includes("[Turn 2]"));

    // lastTurns: 2 (turns 4, 5)
    const resLast2 = await queryTranscript({
      sessionId: "sess-slice-1",
      lastTurns: 2,
    });
    assert.ok(resLast2.text.includes("[Turn 4]"));
    assert.ok(resLast2.text.includes("[Turn 5]"));
    assert.ok(!resLast2.text.includes("[Turn 3]"));

    // Out-of-bounds negative index returns empty string
    const resClamp = await queryTranscript({
      sessionId: "sess-slice-1",
      turnIndex: -999,
    });
    assert.strictEqual(resClamp.text, "");
  });

  // Scenario 6: Empty Session & Safety Cap Retrieval
  it("6. Empty Session and 100-Turn Safety Cap Retrieval", async () => {
    const emptySession: SessionData = {
      id: "sess-empty",
      title: "Empty Session",
      adapter: "antigravity",
      projectPath: "d:/Projects/chronicle-mcp",
      firstPrompt: "",
      createdAt: 1000,
      lastActiveAt: 1000,
    };
    store.saveSession(emptySession, [], []);

    const resEmpty = await queryTranscript({ sessionId: "sess-empty" });
    assert.ok(resEmpty.text.includes("0 indexed turns"));

    // 120 turns session
    const bigSession: SessionData = {
      id: "sess-big",
      title: "Big Session",
      adapter: "antigravity",
      projectPath: "d:/Projects/chronicle-mcp",
      firstPrompt: "Prompt 1",
      createdAt: 1000,
      lastActiveAt: 100000,
    };
    const bigTurns: TurnData[] = [];
    for (let i = 1; i <= 120; i++) {
      bigTurns.push({
        turnIndex: i,
        userPrompt: `Prompt ${i}`,
        assistantResponse: `Response ${i}`,
        turnText: `Prompt ${i} Response ${i}`,
        turnVector: new Float32Array(EMBEDDING_DIMENSION),
        inputTokens: 5,
        outputTokens: 5,
        thinkingTokens: 0,
        toolCount: 0,
        errorCount: 0,
        durationMs: 5,
        isUndone: false,
        createdAt: 1000 + i,
      });
    }
    store.saveSession(bigSession, bigTurns, []);

    const resBig = await queryTranscript({ sessionId: "sess-big" });
    assert.ok(resBig.text.includes("Transcript automatically capped to the last 100 turns"));
    assert.ok(resBig.text.includes("[Turn 120]"));
    assert.ok(!resBig.text.includes("[Turn 15]"));
  });

  // Scenario 7: Progressive Disclosure (compact vs full vs summary)
  it("7. Progressive Disclosure token-saving detailLevel ('compact', 'full', 'summary')", async () => {
    const session: SessionData = {
      id: "sess-prog-1",
      title: "Progressive Disclosure Session",
      adapter: "antigravity",
      projectPath: "d:/Projects/chronicle-mcp",
      firstPrompt: "Implement feature in auth.ts",
      createdAt: 1000,
      lastActiveAt: 2000,
    };
    const turns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Implement feature in auth.ts",
        assistantResponse: "Here is the completed feature.",
        turnText: "Implement feature in auth.ts Here is the completed feature.",
        turnVector: new Float32Array(EMBEDDING_DIMENSION),
        inputTokens: 20,
        outputTokens: 20,
        thinkingTokens: 50,
        toolCount: 1,
        errorCount: 0,
        durationMs: 150,
        isUndone: false,
        createdAt: 1000,
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
        thinking: "Deep architectural reasoning about token security.",
        toolName: "patch_file",
        serverName: "patchitright",
        filePath: "src/auth.ts",
        toolArgs: JSON.stringify({ target: "src/auth.ts", patch: "diff content" }),
        toolResult: "Successfully applied patch to auth.ts",
        toolDurationMs: 120,
        createdAt: 1100,
        isUndone: false,
      },
    ];
    store.saveSession(session, turns, steps);

    // Compact mode
    const resCompact = await queryTranscript({
      sessionId: "sess-prog-1",
      detailLevel: "compact",
    });
    assert.ok(resCompact.text.includes("- [patchitright/patch_file] `src/auth.ts` - DONE (120ms)"));
    assert.ok(!resCompact.text.includes("Deep architectural reasoning"));

    // Full mode
    const resFull = await queryTranscript({
      sessionId: "sess-prog-1",
      detailLevel: "full",
    });
    assert.ok(resFull.text.includes("Deep architectural reasoning"));
    assert.ok(resFull.text.includes("Successfully applied patch to auth.ts"));

    // Summary mode
    const resSummary = await queryTranscript({
      sessionId: "sess-prog-1",
      detailLevel: "summary",
    });
    assert.ok(resSummary.text.includes("Here is the completed feature."));
    assert.ok(!resSummary.text.includes("patchitright/patch_file"));
  });

  // Scenario 8: Subagent Subtree Resolution via recursive SQL CTE
  it("8. Subagent Subtree Resolution (includeSubtree: true) across hierarchy", async () => {
    const rootSession: SessionData = {
      id: "sess-root",
      title: "Root Lead",
      adapter: "antigravity",
      role: "lead",
      projectPath: "d:/Projects/chronicle-mcp",
      firstPrompt: "Root prompt",
      createdAt: 1000,
      lastActiveAt: 5000,
    };
    const childSession: SessionData = {
      id: "sess-sub-1",
      parentId: "sess-root",
      title: "Reviewer 1",
      adapter: "antigravity",
      role: "reviewer",
      projectPath: "d:/Projects/chronicle-mcp",
      firstPrompt: "Child review prompt",
      createdAt: 2000,
      lastActiveAt: 4000,
    };
    const grandchildSession: SessionData = {
      id: "sess-grandchild-1",
      parentId: "sess-sub-1",
      title: "Specialist",
      adapter: "antigravity",
      role: "security_tester",
      projectPath: "d:/Projects/chronicle-mcp",
      firstPrompt: "Grandchild security prompt",
      createdAt: 3000,
      lastActiveAt: 4000,
    };

    store.saveSession(
      rootSession,
      [
        {
          turnIndex: 1,
          userPrompt: "Root prompt",
          assistantResponse: "Root response",
          turnText: "Root prompt Root response",
          turnVector: new Float32Array(EMBEDDING_DIMENSION),
          inputTokens: 10,
          outputTokens: 10,
          thinkingTokens: 0,
          toolCount: 0,
          errorCount: 0,
          durationMs: 10,
          isUndone: false,
          createdAt: 1000,
        },
      ],
      []
    );

    store.saveSession(
      childSession,
      [
        {
          turnIndex: 1,
          userPrompt: "Child review prompt",
          assistantResponse: "Child review response",
          turnText: "Child review prompt Child review response",
          turnVector: new Float32Array(EMBEDDING_DIMENSION),
          inputTokens: 10,
          outputTokens: 10,
          thinkingTokens: 0,
          toolCount: 0,
          errorCount: 0,
          durationMs: 10,
          isUndone: false,
          createdAt: 2000,
        },
      ],
      []
    );

    store.saveSession(
      grandchildSession,
      [
        {
          turnIndex: 1,
          userPrompt: "Grandchild security prompt",
          assistantResponse: "Grandchild security response",
          turnText: "Grandchild security prompt Grandchild security response",
          turnVector: new Float32Array(EMBEDDING_DIMENSION),
          inputTokens: 10,
          outputTokens: 10,
          thinkingTokens: 0,
          toolCount: 0,
          errorCount: 0,
          durationMs: 10,
          isUndone: false,
          createdAt: 3000,
        },
      ],
      []
    );

    const subtreeIds = store.getSubtreeSessionIds("sess-root");
    assert.strictEqual(subtreeIds.length, 3);
    assert.ok(subtreeIds.includes("sess-root"));
    assert.ok(subtreeIds.includes("sess-sub-1"));
    assert.ok(subtreeIds.includes("sess-grandchild-1"));

    const resSubtree = await queryTranscript({
      sessionId: "sess-root",
      includeSubtree: true,
    });
    assert.ok(resSubtree.text.includes("[Turn 1]"));
    assert.ok(resSubtree.text.includes("Role: reviewer"));
    assert.ok(resSubtree.text.includes("Role: security_tester"));
  });

  // Scenario 9: Multi-Session Batch Step Loading & Empty Guard
  it("9. Multi-Session Batch Step Loading and empty array guard", () => {
    const emptyMap = store.getStepsForTurns("sess-any", []);
    assert.strictEqual(emptyMap.size, 0);

    const inMemStore = new InMemoryHistoryStore();
    const inMemEmpty = inMemStore.getStepsForTurns("sess-any", []);
    assert.strictEqual(inMemEmpty.size, 0);
  });

  // Scenario 10: Execution Filtering (filePath and toolFilter)
  it("10. Execution Step Filtering by filePath and toolFilter", async () => {
    const session: SessionData = {
      id: "sess-filter-steps",
      title: "Step Filter Session",
      adapter: "antigravity",
      projectPath: "d:/Projects/chronicle-mcp",
      firstPrompt: "Run edits on src/db.ts and src/search.ts",
      createdAt: 1000,
      lastActiveAt: 2000,
    };
    const turns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Run edits on codebase modules",
        assistantResponse: "Edits complete.",
        turnText: "Run edits on codebase modules Edits complete.",
        turnVector: new Float32Array(EMBEDDING_DIMENSION),
        inputTokens: 10,
        outputTokens: 10,
        thinkingTokens: 0,
        toolCount: 2,
        errorCount: 0,
        durationMs: 40,
        isUndone: false,
        createdAt: 1000,
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
        toolName: "replace_file_content",
        serverName: "default_api",
        filePath: "d:/Projects/chronicle-mcp/src/db.ts",
        createdAt: 1100,
        isUndone: false,
      },
      {
        stepIndex: 2,
        turnIndex: 1,
        stepOrder: 2,
        category: "execution",
        kind: "mcp",
        status: "ERROR",
        toolName: "view_file",
        serverName: "default_api",
        filePath: "d:/Projects/chronicle-mcp/src/search.ts",
        errorMessage: "File not found",
        createdAt: 1200,
        isUndone: false,
      },
    ];
    store.saveSession(session, turns, steps);

    // Filter by filePath (case-insensitive and normalized separators)
    const resFile = await queryTranscript({
      sessionId: "sess-filter-steps",
      filePath: "src\\db.ts",
    });
    assert.ok(resFile.text.includes("src/db.ts"));
    assert.ok(!resFile.text.includes("src/search.ts"));

    // Filter by toolFilter (status: ERROR)
    const resError = await queryTranscript({
      sessionId: "sess-filter-steps",
      toolFilter: { status: "ERROR" },
    });
    assert.ok(resError.text.includes("view_file"));
    assert.ok(!resError.text.includes("replace_file_content"));
  });

  // Scenario 11: Output Safety & Polymorphic File Export
  it("11. Output Safety, payload truncation, and direct disk export (.md and .json)", async () => {
    const session: SessionData = {
      id: "sess-export-1",
      title: "Export Session",
      adapter: "antigravity",
      projectPath: "d:/Projects/chronicle-mcp",
      firstPrompt: "Generate huge payload",
      createdAt: 1000,
      lastActiveAt: 2000,
    };
    const longPayload = "A".repeat(5000);
    const turns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Generate huge payload",
        assistantResponse: "Payload generated",
        turnText: "Generate huge payload Payload generated",
        turnVector: new Float32Array(EMBEDDING_DIMENSION),
        inputTokens: 10,
        outputTokens: 10,
        thinkingTokens: 0,
        toolCount: 1,
        errorCount: 0,
        durationMs: 50,
        isUndone: false,
        createdAt: 1000,
      },
    ];
    const steps: StepData[] = [
      {
        stepIndex: 1,
        turnIndex: 1,
        stepOrder: 1,
        category: "execution",
        kind: "command",
        status: "DONE",
        toolName: "run_command",
        toolResult: longPayload,
        createdAt: 1100,
        isUndone: false,
      },
    ];
    store.saveSession(session, turns, steps);

    // Test payload truncation in full mode with custom maxResultChars
    const resTrunc = await queryTranscript({
      sessionId: "sess-export-1",
      detailLevel: "full",
      maxResultChars: 100,
    });
    assert.ok(resTrunc.text.includes("[Truncated: output exceeded 100 characters]"));

    // Direct Markdown export to custom output file
    const mdExportPath = path.join(tempDir, "export_test.md");
    const resMd = await queryTranscript({
      sessionId: "sess-export-1",
      output: mdExportPath,
    });
    assert.ok(fs.existsSync(mdExportPath));
    const mdContent = fs.readFileSync(mdExportPath, "utf8");
    assert.ok(mdContent.includes("[Turn 1]"));

    // Direct JSON export
    const jsonExportPath = path.join(tempDir, "export_test.json");
    await queryTranscript({
      sessionId: "sess-export-1",
      output: jsonExportPath,
    });
    assert.ok(fs.existsSync(jsonExportPath));
    const jsonContent = JSON.parse(fs.readFileSync(jsonExportPath, "utf8"));
    assert.strictEqual(jsonContent.sessionId, "sess-export-1");
    assert.strictEqual(jsonContent.turnCount, 1);
  });

  // Scenario 12: Mock Embedding Client
  it("12. Mock Embedding Client deterministic 384D fallback vectors and reset", async () => {
    const client = new MockEmbeddingClient();
    client.reset();

    const [vec1] = await client.embed(["test unmocked text"]);
    assert.strictEqual(vec1.length, EMBEDDING_DIMENSION);

    const customVec = Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => (i === 0 ? 1 : 0));
    client.setMockVector("custom text", customVec);

    const [retrieved] = await client.embed(["custom text"]);
    assert.deepStrictEqual(retrieved, customVec);

    client.reset();
    const [afterReset] = await client.embed(["custom text"]);
    assert.strictEqual(afterReset.length, EMBEDDING_DIMENSION);
  });
});
