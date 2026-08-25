import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getStore,
  setStore,
  SqliteHistoryStore,
} from "../db.js";
import {
  SessionData,
  TurnData,
  StepData,
} from "../adapters/types.js";
import {
  getMcpToolDefinitions,
  handleCallToolRequest,
  handleListSessions,
  handleGetSessionRelationship,
  handleGetSessionArtifacts,
  handleQueryTranscript,
  handleSearchHistory,
  handleGetToolUsageStats,
  handleGetSessionBenchmarks,
  handleOutputWrite,
} from "../index.js";
import { handleChronicleGuide } from "../guide.js";

describe("Chronicle MCP 2-Layer Tool Query Surface", () => {
  let tempDir: string;
  let dbPath: string;
  let brainDir: string;
  let store: SqliteHistoryStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-mcp-tools-test-"));
    dbPath = path.join(tempDir, "test.db");
    brainDir = path.join(tempDir, "brain");
    fs.mkdirSync(brainDir, { recursive: true });

    store = new SqliteHistoryStore(dbPath);
    setStore(store);
  });

  afterEach(() => {
    store.close();
    setStore(null as any);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function populateSampleData() {
    // 1. Root session
    const rootSession: SessionData = {
      id: "root-sess-1",
      adapter: "antigravity",
      title: "Root Architecture Session",
      role: "Architect",
      projectPath: "d:/projects/my-app",
      createdAt: 1000,
      lastActiveAt: 5000,
      firstPrompt: "Design the 2-layer storage model",
      artifacts: ["implementation_plan.md"],
      filesTouched: ["src/db.ts"],
    };

    const rootTurns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Design the 2-layer storage model",
        assistantResponse: "I have designed the storage engine with SQLite.",
        turnText: "Design the 2-layer storage model I have designed the storage engine with SQLite.",
        inputTokens: 100,
        outputTokens: 50,
        thinkingTokens: 20,
        toolCount: 1,
        errorCount: 0,
        createdAt: 1500,
      },
      {
        turnIndex: 2,
        userPrompt: "Run benchmark tests",
        assistantResponse: "Benchmarks completed successfully.",
        turnText: "Run benchmark tests Benchmarks completed successfully.",
        inputTokens: 120,
        outputTokens: 60,
        thinkingTokens: 10,
        toolCount: 2,
        errorCount: 0,
        createdAt: 3000,
      },
      {
        turnIndex: 3,
        userPrompt: "Check for regression",
        assistantResponse: "Regression detected in index.ts.",
        turnText: "Check for regression Regression detected in index.ts.",
        inputTokens: 150,
        outputTokens: 70,
        thinkingTokens: 15,
        toolCount: 1,
        errorCount: 1,
        createdAt: 4500,
      },
    ];

    const rootSteps: StepData[] = [
      {
        stepIndex: 1,
        turnIndex: 1,
        category: "execution",
        toolName: "write_to_file",
        serverName: "default_api",
        filePath: "src/db.ts",
        toolArgs: JSON.stringify({ TargetFile: "src/db.ts" }),
        toolResult: JSON.stringify({ success: true }),
        status: "DONE",
        toolDurationMs: 80,
        createdAt: 1600,
      },
      {
        stepIndex: 2,
        turnIndex: 2,
        category: "execution",
        toolName: "run_command",
        serverName: "default_api",
        toolArgs: JSON.stringify({ CommandLine: "npm test" }),
        toolResult: "Tests passed: 42 passed",
        status: "DONE",
        toolDurationMs: 500,
        createdAt: 3100,
      },
      {
        stepIndex: 3,
        turnIndex: 2,
        category: "execution",
        toolName: "view_file",
        serverName: "default_api",
        filePath: "src/index.ts",
        status: "DONE",
        toolDurationMs: 30,
        createdAt: 3200,
      },
      {
        stepIndex: 4,
        turnIndex: 3,
        category: "execution",
        toolName: "patch_file",
        serverName: "patchitright",
        filePath: "src/index.ts",
        status: "ERROR",
        errorMessage: "Target content not found",
        toolDurationMs: 120,
        createdAt: 4600,
      },
    ];

    // 2. Child Subagent Session
    const childSession: SessionData = {
      id: "child-sess-1",
      adapter: "antigravity",
      title: "Subagent Test Runner",
      role: "Tester",
      parentId: "root-sess-1",
      rootId: "root-sess-1",
      depth: 1,
      projectPath: "d:/projects/my-app",
      createdAt: 2000,
      lastActiveAt: 4000,
      firstPrompt: "Execute unit tests in isolation",
      artifacts: ["walkthrough.md"],
    };

    const childTurns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Execute unit tests in isolation",
        assistantResponse: "All 15 tests passed.",
        turnText: "Execute unit tests in isolation All 15 tests passed.",
        inputTokens: 80,
        outputTokens: 40,
        thinkingTokens: 5,
        toolCount: 1,
        errorCount: 0,
        createdAt: 2500,
      },
    ];

    const childSteps: StepData[] = [
      {
        stepIndex: 1,
        turnIndex: 1,
        category: "execution",
        toolName: "run_command",
        serverName: "default_api",
        toolArgs: JSON.stringify({ CommandLine: "npm run test:unit" }),
        toolResult: "15 passed",
        status: "DONE",
        toolDurationMs: 300,
        createdAt: 2600,
      },
    ];

    // 3. Independent Clean Session
    const cleanSession: SessionData = {
      id: "clean-sess-1",
      adapter: "cursor",
      title: "Clean Documentation Session",
      role: "Writer",
      projectPath: "d:/projects/docs",
      createdAt: 6000,
      lastActiveAt: 7000,
      firstPrompt: "Draft README documentation",
      artifacts: ["README.md"],
    };

    const cleanTurns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Draft README documentation",
        assistantResponse: "README.md created.",
        turnText: "Draft README documentation README.md created.",
        inputTokens: 90,
        outputTokens: 60,
        toolCount: 1,
        errorCount: 0,
        createdAt: 6500,
      },
    ];

    const cleanSteps: StepData[] = [
      {
        stepIndex: 1,
        turnIndex: 1,
        category: "execution",
        toolName: "write_to_file",
        serverName: "default_api",
        filePath: "README.md",
        status: "DONE",
        toolDurationMs: 40,
        createdAt: 6600,
      },
    ];

    store.saveSession(rootSession, rootTurns, rootSteps);
    store.saveSession(childSession, childTurns, childSteps);
    store.saveSession(cleanSession, cleanTurns, cleanSteps);

    // Create artifact files on disk in brainDir
    const rootBrainDir = path.join(brainDir, "root-sess-1");
    fs.mkdirSync(rootBrainDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootBrainDir, "implementation_plan.md"),
      "# Implementation Plan\n\n- [x] Step 1\n- [ ] Step 2\n",
      "utf-8"
    );

    const childBrainDir = path.join(brainDir, "child-sess-1");
    fs.mkdirSync(childBrainDir, { recursive: true });
    fs.writeFileSync(
      path.join(childBrainDir, "walkthrough.md"),
      "# Walkthrough\n\nAll tests passed successfully.\n",
      "utf-8"
    );
  }

  it("1. should validate all 7 MCP tool schemas in getMcpToolDefinitions", () => {
    const tools = getMcpToolDefinitions();
    const toolNames = tools.map((t) => t.name);

    assert.ok(toolNames.includes("chronicle_guide"));
    assert.ok(toolNames.includes("list_sessions"));
    assert.ok(toolNames.includes("get_session_relationship"));
    assert.ok(toolNames.includes("query_transcript"));
    assert.ok(toolNames.includes("get_session_artifacts"));
    assert.ok(toolNames.includes("search_history"));
    assert.ok(toolNames.includes("get_tool_usage_stats"));
    assert.ok(toolNames.includes("get_session_benchmarks"));
    assert.ok(toolNames.includes("sync_history"));
  });

  it("2. should list sessions with adapter, parentId, role, hasErrors, and pagination filters", async () => {
    populateSampleData();

    // Filter by adapter
    const resAntigravity = await handleListSessions({ adapter: "antigravity" });
    const rowsAntigravity = JSON.parse(resAntigravity.content[0].text);
    assert.strictEqual(rowsAntigravity.length, 2);

    // Filter by parentId='root'
    const resRoot = await handleListSessions({ parentId: "root" });
    const rowsRoot = JSON.parse(resRoot.content[0].text);
    assert.strictEqual(rowsRoot.length, 2);
    assert.ok(rowsRoot.some((r: any) => r.id === "root-sess-1"));
    assert.ok(rowsRoot.some((r: any) => r.id === "clean-sess-1"));

    // Filter by hasErrors=false (error-free sessions)
    const resClean = await handleListSessions({ hasErrors: false });
    const rowsClean = JSON.parse(resClean.content[0].text);
    assert.strictEqual(rowsClean.length, 2);
    assert.ok(!rowsClean.some((r: any) => r.id === "root-sess-1"));

    // Filter by hasErrors=true
    const resError = await handleListSessions({ hasErrors: true });
    const rowsError = JSON.parse(resError.content[0].text);
    assert.strictEqual(rowsError.length, 1);
    assert.strictEqual(rowsError[0].id, "root-sess-1");

    // Pagination limit & offset
    const resPage1 = await handleListSessions({ limit: 1, offset: 0 });
    const rowsPage1 = JSON.parse(resPage1.content[0].text);
    assert.strictEqual(rowsPage1.length, 1);

    const resPage2 = await handleListSessions({ limit: 1, offset: 1 });
    const rowsPage2 = JSON.parse(resPage2.content[0].text);
    assert.strictEqual(rowsPage2.length, 1);
    assert.notStrictEqual(rowsPage1[0].id, rowsPage2[0].id);
  });

  it("3. should get session relationships with recursive tree and ancestry", async () => {
    populateSampleData();

    const resRootRel = await handleGetSessionRelationship({
      sessionId: "root-sess-1",
      maxDepth: 2,
    });
    const rootRel = JSON.parse(resRootRel.content[0].text);
    assert.strictEqual(rootRel.sessionId, "root-sess-1");
    assert.strictEqual(rootRel.children.length, 1);
    assert.strictEqual(rootRel.children[0].id, "child-sess-1");

    const resChildRel = await handleGetSessionRelationship({
      sessionId: "child-sess-1",
      includeAncestors: true,
    });
    const childRel = JSON.parse(resChildRel.content[0].text);
    assert.strictEqual(childRel.sessionId, "child-sess-1");
    assert.strictEqual(childRel.parent?.id, "root-sess-1");
    assert.strictEqual(childRel.ancestors.length, 1);
    assert.strictEqual(childRel.ancestors[0].id, "root-sess-1");
  });

  it("4. should slice transcript turns symmetrically with negative indexing and boundaries", async () => {
    populateSampleData();

    // 1. Single positive turn
    const resTurn1 = await handleQueryTranscript({
      sessionId: "root-sess-1",
      turnIndex: 1,
      detailLevel: "compact",
    });
    assert.ok(resTurn1.content[0].text.includes("### [Turn 1]"));
    assert.ok(!resTurn1.content[0].text.includes("### [Turn 2]"));

    // 2. Single negative turn (latest turn = Turn 3)
    const resTurnLatest = await handleQueryTranscript({
      sessionId: "root-sess-1",
      turnIndex: -1,
      detailLevel: "compact",
    });
    assert.ok(resTurnLatest.content[0].text.includes("### [Turn 3]"));
    assert.ok(resTurnLatest.content[0].text.includes("Check for regression"));
    assert.ok(!resTurnLatest.content[0].text.includes("### [Turn 1]"));

    // 3. Out-of-bounds negative turn (|-4| > 3 -> empty)
    const resTurnOob = await handleQueryTranscript({
      sessionId: "root-sess-1",
      turnIndex: -4,
    });
    assert.strictEqual(resTurnOob.content[0].text, "");

    // 4. turnIndex = 0 -> empty
    const resTurnZero = await handleQueryTranscript({
      sessionId: "root-sess-1",
      turnIndex: 0,
    });
    assert.strictEqual(resTurnZero.content[0].text, "");

    // 5. lastTurns: 2 -> Turns 2 and 3
    const resLast2 = await handleQueryTranscript({
      sessionId: "root-sess-1",
      lastTurns: 2,
    });
    assert.ok(!resLast2.content[0].text.includes("### [Turn 1]"));
    assert.ok(resLast2.content[0].text.includes("### [Turn 2]"));
    assert.ok(resLast2.content[0].text.includes("### [Turn 3]"));

    // 6. lastTurns <= 0 -> empty
    const resLastZero = await handleQueryTranscript({
      sessionId: "root-sess-1",
      lastTurns: 0,
    });
    assert.strictEqual(resLastZero.content[0].text, "");

    // 7. Range slicing with negative startTurn: -2 to -1 (Turns 2 and 3)
    const resRange = await handleQueryTranscript({
      sessionId: "root-sess-1",
      startTurn: -2,
      endTurn: -1,
    });
    assert.ok(!resRange.content[0].text.includes("### [Turn 1]"));
    assert.ok(resRange.content[0].text.includes("### [Turn 2]"));
    assert.ok(resRange.content[0].text.includes("### [Turn 3]"));
  });

  it("5. should support detailLevel compact vs full vs summary and toolFilter in queryTranscript", async () => {
    populateSampleData();

    // Summary: dialogue only
    const resSummary = await handleQueryTranscript({
      sessionId: "root-sess-1",
      turnIndex: 1,
      detailLevel: "summary",
    });
    assert.ok(resSummary.content[0].text.includes("**User**:\nDesign the 2-layer storage model"));
    assert.ok(resSummary.content[0].text.includes("**Assistant**:\nI have designed the storage engine with SQLite."));
    assert.ok(!resSummary.content[0].text.includes("Tool Call:"));

    // Full: tool call arguments and results
    const resFull = await handleQueryTranscript({
      sessionId: "root-sess-1",
      turnIndex: 1,
      detailLevel: "full",
    });
    assert.ok(resFull.content[0].text.includes("#### Tool Call: `default_api/write_to_file` (DONE)"));
    assert.ok(resFull.content[0].text.includes("**File**: `src/db.ts`"));
    assert.ok(resFull.content[0].text.includes('"TargetFile": "src/db.ts"'));

    // ToolFilter by status=ERROR
    const resErrorFilter = await handleQueryTranscript({
      sessionId: "root-sess-1",
      detailLevel: "compact",
      toolFilter: { status: "ERROR" },
    });
    assert.ok(resErrorFilter.content[0].text.includes("patchitright/patch_file"));
    assert.ok(!resErrorFilter.content[0].text.includes("write_to_file"));

    // Multi-Tool filtering
    const resMultiFilter = await handleQueryTranscript({
      sessionId: "root-sess-1",
      detailLevel: "compact",
      toolFilter: { name: ["write_to_file", "view_file"] },
    });
    assert.ok(resMultiFilter.content[0].text.includes("write_to_file"));
    assert.ok(resMultiFilter.content[0].text.includes("view_file"));
    assert.ok(!resMultiFilter.content[0].text.includes("run_command"));
  });

  it("6. should aggregate subtree turns chronologically with includeSubtree=true", async () => {
    populateSampleData();

    const resSubtree = await handleQueryTranscript({
      sessionId: "root-sess-1",
      includeSubtree: true,
      detailLevel: "compact",
    });

    const text = resSubtree.content[0].text;
    assert.ok(text.includes("### [Turn 1]"));
    assert.ok(text.includes("### [Turn 2]"));
    assert.ok(text.includes("### [Turn 3]"));
    assert.ok(text.includes("### [Turn 4]"));
    assert.ok(text.includes("Role: Tester, Session: child-sess-1"));
  });

  it("7. should export transcript directly to disk with error encapsulation", async () => {
    populateSampleData();

    const exportPath = path.join(tempDir, "exports", "transcript.md");
    const resExport = await handleQueryTranscript({
      sessionId: "root-sess-1",
      output: exportPath,
    });

    assert.ok(resExport.content[0].text.includes("Transcript successfully exported"));
    assert.ok(fs.existsSync(exportPath));
    const content = fs.readFileSync(exportPath, "utf-8");
    assert.ok(content.includes("### [Turn 1]"));
  });

  it("8. should retrieve session artifacts safely with subtree discovery and path containment", async () => {
    populateSampleData();

    // 1. Direct artifact retrieval
    const resDirect = await handleGetSessionArtifacts(
      { sessionId: "root-sess-1" },
      brainDir
    );
    assert.ok(resDirect.content[0].text.includes("File: [implementation_plan.md]"));
    assert.ok(resDirect.content[0].text.includes("Step 1"));
    assert.ok(!resDirect.content[0].text.includes("walkthrough.md"));

    // 2. Subtree artifact retrieval
    const resSubtree = await handleGetSessionArtifacts(
      { sessionId: "root-sess-1", includeSubtree: true },
      brainDir
    );
    assert.ok(resSubtree.content[0].text.includes("File: [implementation_plan.md]"));
    assert.ok(resSubtree.content[0].text.includes("File: [walkthrough.md]"));

    // 3. Artifact name filter
    const resFiltered = await handleGetSessionArtifacts(
      { sessionId: "root-sess-1", includeSubtree: true, artifactName: "walkthrough" },
      brainDir
    );
    assert.ok(!resFiltered.content[0].text.includes("implementation_plan.md"));
    assert.ok(resFiltered.content[0].text.includes("File: [walkthrough.md]"));
  });

  it("9. should compute tool usage analytics and benchmarks", async () => {
    populateSampleData();

    // Tool usage stats
    const resStats = await handleGetToolUsageStats({ projectPath: "d:/projects/my-app" });
    const stats = JSON.parse(resStats.content[0].text);
    assert.ok(stats.summary.totalCalls >= 4);
    assert.ok(stats.tools.some((s: any) => s.toolName === "write_to_file"));

    // Session benchmarks
    const resBenchmarks = await handleGetSessionBenchmarks({
      sessionIds: ["root-sess-1", "child-sess-1"],
      groups: [
        { name: "Root Group", sessionIds: ["root-sess-1"] },
        { name: "Child Group", sessionIds: ["child-sess-1"] },
      ],
    });
    assert.ok(resBenchmarks.content[0].text.includes("# Session Benchmarking Report"));
    assert.ok(resBenchmarks.content[0].text.includes("Root Group"));
    assert.ok(resBenchmarks.content[0].text.includes("Child Group"));
  });

  it("10. should return version 2.0.0 for chronicle_guide and dispatch via handleCallToolRequest", async () => {
    // Direct guide call
    const guideRes = handleChronicleGuide();
    const parsedGuide = JSON.parse(guideRes.content[0].text);
    assert.strictEqual(parsedGuide.version, "2.0.0");
    assert.ok(parsedGuide.content.includes("2-layer turn & step exploration"));

    // Dispatch via handleCallToolRequest
    const dispatchGuide = await handleCallToolRequest("chronicle_guide", {});
    const parsedDispatch = JSON.parse(dispatchGuide.content[0].text);
    assert.strictEqual(parsedDispatch.version, "2.0.0");

    // Invalid tool dispatch
    await assert.rejects(
      async () => {
        await handleCallToolRequest("non_existent_tool", {});
      },
      { message: 'Tool "non_existent_tool" not found.' }
    );
  });

  it("11. should return compact 1-line markdown by default in handleSearchHistory with zero-match text and token savings", async () => {
    populateSampleData();

    // 1. Default format: markdown
    const res = await handleSearchHistory({ query: "benchmark" });
    const text = res.content[0].text;
    assert.ok(text.startsWith('# Search Results for "benchmark"'));
    assert.ok(text.includes('1. [root-ses:T2] (role:Architect) - "Run benchmark tests"'));

    // 2. Zero-match query in keyword mode
    const resZero = await handleSearchHistory({ query: "non_existent_keyword_xyz", mode: "keyword" });
    assert.strictEqual(resZero.content[0].text, 'No matching history turns found for "non_existent_keyword_xyz".');
  });

  it("12. should support session prefix resolution in queryTranscript and getSession", async () => {
    populateSampleData();

    // Query transcript using prefix "root-ses" (>= 6 chars)
    const res = await handleQueryTranscript({
      sessionId: "root-ses",
      turnIndex: 1,
      detailLevel: "compact",
    });
    assert.ok(res.content[0].text.includes("### [Turn 1]"));
    assert.ok(res.content[0].text.includes("Design the 2-layer storage model"));
  });

  it("13. should support JSON format, detailLevel, fields/order projection, and parameter clamping in handleSearchHistory", async () => {
    populateSampleData();

    // 1. format: json, detailLevel: compact
    const resCompact = await handleSearchHistory({
      query: "benchmark",
      format: "json",
      detailLevel: "compact",
    });
    const compactList = JSON.parse(resCompact.content[0].text);
    assert.ok(Array.isArray(compactList));
    assert.ok(compactList.length > 0);
    assert.deepEqual(Object.keys(compactList[0]), [
      "sessionId",
      "turnIndex",
      "score",
      "snippet",
      "role",
      "projectPath",
    ]);

    // 2. Custom fields projection
    const resProjected = await handleSearchHistory({
      query: "benchmark",
      format: "json",
      fields: ["id", "turnIndex", "snippet"],
      limit: 1,
    });
    const projList = JSON.parse(resProjected.content[0].text);
    assert.strictEqual(projList.length, 1);
    assert.deepEqual(Object.keys(projList[0]), ["id", "turnIndex", "snippet"]);

    // 3. Zero match in JSON mode returns []
    const resZeroJson = await handleSearchHistory({
      query: "non_existent_zero_match",
      mode: "keyword",
      format: "json",
    });
    assert.strictEqual(resZeroJson.content[0].text, "[]");
  });

  it("14. should support output file export with path traversal containment checks and stderr audit warnings", async () => {
    populateSampleData();

    const validOutputFile = path.join(tempDir, "search_results.md");
    const resValid = await handleSearchHistory({
      query: "benchmark",
      output: validOutputFile,
    });
    assert.ok(!resValid.isError);
    assert.ok(fs.existsSync(validOutputFile));
    const written = fs.readFileSync(validOutputFile, "utf-8");
    assert.ok(written.includes('# Search Results for "benchmark"'));

    // Path traversal block (e.g. C:/Windows/System32/evil.md or relative escape)
    const dangerousPath = path.join("Z:", "unauthorized", "evil.md");
    const resBlocked = handleOutputWrite("evil payload", dangerousPath);
    assert.strictEqual(resBlocked.isError, true);
    assert.ok(resBlocked.content[0].text.includes("Access denied"));

    // Null byte path block
    const nullByteRes = handleOutputWrite("null payload", "safe_name\0.md");
    assert.strictEqual(nullByteRes.isError, true);
    assert.ok(nullByteRes.content[0].text.includes("Invalid or dangerous"));
  });
});
