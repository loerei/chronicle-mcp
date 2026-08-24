import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  InMemoryHistoryStore,
  SqliteHistoryStore,
  setStore,
} from "../db.js";
import { computeSessionBenchmarks, searchHistory } from "../search.js";
import { SessionData, StepData, TurnData } from "../adapters/types.js";
import { MockEmbeddingClient, setEmbeddingClient } from "../embeddings.js";

describe("Benchmarking Logic", () => {
  let tempDir: string;
  let sqliteStore: SqliteHistoryStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-bench-test-"));
    const dbPath = path.join(tempDir, "bench_test.db");
    sqliteStore = new SqliteHistoryStore(dbPath);
  });

  afterEach(() => {
    sqliteStore.close();
    setStore(null as any);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("should calculate session benchmark metrics and caching simulation correctly", async () => {
    const store = new InMemoryHistoryStore();
    setStore(store);

    const sessionId = "bench-session-1";

    const turns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Hello",
        assistantResponse: "ResponseOne",
        turnText: "Hello ResponseOne",
        inputTokens: 5,
        outputTokens: 10,
        thinkingTokens: 0,
        toolCount: 1,
        errorCount: 0,
      },
      {
        turnIndex: 2,
        userPrompt: "Hello again",
        assistantResponse: "ResponseTwo",
        turnText: "Hello again ResponseTwo",
        inputTokens: 15,
        outputTokens: 10,
        thinkingTokens: 0,
        toolCount: 0,
        errorCount: 1,
      },
    ];

    const steps: StepData[] = [
      {
        stepIndex: 0,
        turnIndex: 1,
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        status: "DONE",
        content: "Hello",
        createdAt: 1700000000000,
      },
      {
        stepIndex: 1,
        turnIndex: 1,
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        content: "ResponseOne",
        toolCalls: JSON.stringify([{ name: "test_tool", args: {} }]),
        createdAt: 1700000002000,
      },
      {
        stepIndex: 2,
        turnIndex: 2,
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        status: "DONE",
        content: "Hello again",
        createdAt: 1700000003000,
      },
      {
        stepIndex: 3,
        turnIndex: 2,
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "ERROR",
        content: "ResponseTwo",
        createdAt: 1700000005000,
      },
    ];

    const session: SessionData = {
      id: sessionId,
      adapter: "antigravity",
      title: "Bench Session",
      projectPath: "/projects/bench",
      createdAt: 1700000000000,
      firstPrompt: "Hello",
      secondPrompt: "",
    };

    store.saveSession(session, turns, steps);

    const benchmarks = await computeSessionBenchmarks([sessionId]);
    assert.strictEqual(benchmarks.length, 1);

    const m = benchmarks[0];
    assert.strictEqual(m.sessionId, sessionId);
    assert.strictEqual(m.title, "Bench Session");
    assert.strictEqual(m.totalSteps, 4);
    assert.strictEqual(m.totalTurns, 2);
    assert.strictEqual(m.toolCallsCount, 1);
    assert.strictEqual(m.errorStepsCount, 1);
    assert.strictEqual(m.hasDetailedSteps, true);

    // Verify prompt caching metrics are calculated
    assert.ok(m.cumulativeInputTokens > 0);
    assert.ok(m.cacheHitTokens > 0);
    assert.ok(m.cacheMissTokens > 0);
    assert.ok(m.cacheHitRate > 0 && m.cacheHitRate < 100);
    assert.ok(m.estimatedCostSavings > 0 && m.estimatedCostSavings < 100);
    assert.ok(m.estimatedOutputTokens > 0);
  });

  it("should fallback to turn metrics estimation when no steps are present", async () => {
    const store = new InMemoryHistoryStore();
    setStore(store);

    const sessionId = "bench-session-2";

    const session: SessionData = {
      id: sessionId,
      adapter: "antigravity",
      title: "Turn-only Session",
      projectPath: "/projects/bench",
      createdAt: 1700000000000,
      firstPrompt: "Chunk prompt",
      secondPrompt: "",
    };

    const turns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Chunk prompt",
        assistantResponse: "Response text",
        turnText: "Chunk prompt Response text",
        inputTokens: 10,
        outputTokens: 20,
        thinkingTokens: 5,
        toolCount: 0,
        errorCount: 0,
      },
    ];

    store.saveSession(session, turns, []);

    const benchmarks = await computeSessionBenchmarks([sessionId]);
    assert.strictEqual(benchmarks.length, 1);

    const m = benchmarks[0];
    assert.strictEqual(m.sessionId, sessionId);
    assert.strictEqual(m.totalTurns, 1);
    assert.strictEqual(m.toolCallsCount, 0);
    assert.strictEqual(m.errorStepsCount, 0);
    assert.strictEqual(m.cumulativeInputTokens, 10);
    assert.strictEqual(m.estimatedOutputTokens, 25);
  });

  it("should calculate tool usage statistics correctly", async () => {
    const store = new InMemoryHistoryStore();
    setStore(store);

    const session: SessionData = {
      id: "stats-session-1",
      adapter: "antigravity",
      title: "Stats Session",
      projectPath: "/projects/stats",
      createdAt: 1700000000000,
      firstPrompt: "",
      secondPrompt: "",
    };

    const turns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "run tools",
        assistantResponse: "ran tools",
        turnText: "run tools ran tools",
        toolCount: 3,
        errorCount: 0,
      },
    ];

    const steps: StepData[] = [
      {
        stepIndex: 1,
        turnIndex: 1,
        category: "execution",
        toolName: "read_graph",
        serverName: "memory",
        status: "DONE",
        createdAt: 1700000001000,
      },
      {
        stepIndex: 2,
        turnIndex: 1,
        category: "execution",
        toolName: "query",
        serverName: "gitnexus",
        status: "DONE",
        createdAt: 1700000002000,
      },
      {
        stepIndex: 3,
        turnIndex: 1,
        category: "execution",
        toolName: "query",
        serverName: "gitnexus",
        status: "DONE",
        createdAt: 1700000003000,
      },
    ];

    store.saveSession(session, turns, steps);

    const { getToolUsageStats } = await import("../search.js");
    const report = await getToolUsageStats({ limit: 5, projectPath: "/projects/stats" });

    assert.strictEqual(report.summary.totalCalls, 3);
    assert.strictEqual(report.summary.totalErrors, 0);

    const memStat = report.tools.find((t) => t.toolName === "read_graph" && t.serverName === "memory");
    assert.ok(memStat);
    assert.strictEqual(memStat.totalCalls, 1);

    const gitStat = report.tools.find((t) => t.toolName === "query" && t.serverName === "gitnexus");
    assert.ok(gitStat);
    assert.strictEqual(gitStat.totalCalls, 2);
  });

  it("should correctly handle CHECKPOINT steps in caching simulation and peakContextSize", async () => {
    const store = new InMemoryHistoryStore();
    setStore(store);

    const sessionId = "checkpoint-session-1";

    const turns: TurnData[] = [
      { turnIndex: 1, userPrompt: "First turn question", assistantResponse: "First turn response", turnText: "First turn question First turn response" },
      { turnIndex: 2, userPrompt: "Second turn question", assistantResponse: "Second turn response", turnText: "Second turn question Second turn response" },
    ];

    const steps: StepData[] = [
      {
        stepIndex: 0,
        turnIndex: 1,
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        status: "DONE",
        content: "First turn question",
        createdAt: 1700000000000,
      },
      {
        stepIndex: 1,
        turnIndex: 1,
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        content: "First turn response",
        createdAt: 1700000001000,
      },
      {
        stepIndex: 2,
        turnIndex: 1,
        type: "CHECKPOINT",
        source: "SYSTEM",
        status: "DONE",
        content: "{{ CHECKPOINT 1 }} Summary of truncated content",
        createdAt: 1700000002000,
      },
      {
        stepIndex: 3,
        turnIndex: 2,
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        status: "DONE",
        content: "Second turn question",
        createdAt: 1700000003000,
      },
      {
        stepIndex: 4,
        turnIndex: 2,
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        content: "Second turn response",
        createdAt: 1700000004000,
      },
    ];

    const session: SessionData = {
      id: sessionId,
      adapter: "antigravity",
      title: "Checkpoint Session",
      projectPath: "/projects/ckpt",
      createdAt: 1700000000000,
      firstPrompt: "First turn question",
      secondPrompt: "",
    };

    store.saveSession(session, turns, steps);

    const benchmarks = await computeSessionBenchmarks([sessionId]);
    assert.strictEqual(benchmarks.length, 1);

    const m = benchmarks[0];
    assert.strictEqual(m.sessionId, sessionId);
    assert.strictEqual(m.totalSteps, 5);
    assert.ok(m.peakContextSize > 0);
    assert.ok(m.cumulativeInputTokens > 0);
  });

  it("should accurately calculate 2-layer category StepData benchmark metrics (cumulative input, peak context, cache hit rate)", async () => {
    const store = new InMemoryHistoryStore();
    setStore(store);

    const sessionId = "2layer-bench-session";

    const turns: TurnData[] = [
      {
        turnIndex: 1,
        userPrompt: "Find artifacts from /write-a-request",
        assistantResponse: "Found 5 artifacts in history.",
        turnText: "Find artifacts from /write-a-request Found 5 artifacts in history.",
        inputTokens: 10,
        outputTokens: 30,
        thinkingTokens: 50,
        toolCount: 2,
        errorCount: 0,
        durationMs: 5000,
      },
    ];

    const steps: StepData[] = [
      {
        stepIndex: 1,
        turnIndex: 1,
        stepOrder: 1,
        category: "user",
        status: "DONE",
        content: "Find artifacts from /write-a-request",
        createdAt: 1700000000000,
      },
      {
        stepIndex: 2,
        turnIndex: 1,
        stepOrder: 2,
        category: "execution",
        toolName: "search_history",
        serverName: "chronicle",
        status: "DONE",
        toolArgs: JSON.stringify({ query: "write-a-request" }),
        toolResult: JSON.stringify([{ id: "art-1" }, { id: "art-2" }]),
        createdAt: 1700000001000,
      },
      {
        stepIndex: 3,
        turnIndex: 1,
        stepOrder: 3,
        category: "execution",
        toolName: "get_session_artifacts",
        serverName: "chronicle",
        status: "DONE",
        toolArgs: JSON.stringify({ sessionId: "art-1" }),
        toolResult: JSON.stringify([{ name: "request_1.md" }]),
        createdAt: 1700000002000,
      },
      {
        stepIndex: 4,
        turnIndex: 1,
        stepOrder: 4,
        category: "agent",
        status: "DONE",
        content: "Found 5 artifacts in history.",
        thinking: "Let me summarize the 5 artifacts clearly.",
        createdAt: 1700000004000,
      },
    ];

    const session: SessionData = {
      id: sessionId,
      adapter: "antigravity",
      title: "2-Layer Benchmark Session",
      projectPath: "/projects/chronicle",
      createdAt: 1700000000000,
      firstPrompt: "Find artifacts from /write-a-request",
    };

    store.saveSession(session, turns, steps);

    const benchmarks = await computeSessionBenchmarks([sessionId]);
    assert.strictEqual(benchmarks.length, 1);

    const m = benchmarks[0];
    assert.strictEqual(m.sessionId, sessionId);
    assert.strictEqual(m.totalSteps, 4);
    assert.strictEqual(m.totalTurns, 1);
    assert.strictEqual(m.toolCallsCount, 2);
    assert.strictEqual(m.errorStepsCount, 0);

    // Verify accurate non-zero cumulative input tokens and peak context
    assert.ok(m.cumulativeInputTokens > 10, "Cumulative input must be greater than user prompt tokens");
    assert.ok(m.peakContextSize > 10, "Peak context must be greater than user prompt tokens");
    assert.ok(m.peakContextSize <= m.cumulativeInputTokens, "Peak context must be <= cumulative input");
    assert.ok(m.estimatedOutputTokens >= 80, "Output tokens must include dialogue + thinking");
    assert.ok(m.cacheHitTokens >= 0);
    assert.ok(m.cacheHitRate >= 0 && m.cacheHitRate <= 100);
    assert.ok(m.estimatedCostSavings >= 0 && m.estimatedCostSavings <= 100);
  });

  it("should validate sub-5ms performance for computeSessionBenchmarks and hybrid search", async () => {
    setStore(sqliteStore);
    const mockEmbedding = new MockEmbeddingClient();
    setEmbeddingClient(mockEmbedding);

    // Seed 10 multi-turn sessions (5 turns each)
    const sessionIds: string[] = [];
    for (let s = 1; s <= 10; s++) {
      const sId = `perf-session-${s}`;
      sessionIds.push(sId);

      const turns: TurnData[] = [];
      const steps: StepData[] = [];

      for (let t = 1; t <= 5; t++) {
        const text = `Turn ${t} question for session ${s}`;
        const vec = (await mockEmbedding.embed([text]))[0];
        turns.push({
          turnIndex: t,
          userPrompt: text,
          assistantResponse: `Turn ${t} response for session ${s}`,
          turnText: `${text} Turn ${t} response for session ${s}`,
          turnVector: vec,
          inputTokens: 100 * t,
          outputTokens: 50 * t,
          thinkingTokens: 20 * t,
          toolCount: 1,
          errorCount: 0,
          durationMs: 500,
          createdAt: 1000 + t * 1000,
        });

        steps.push({
          stepIndex: (t - 1) * 2 + 1,
          turnIndex: t,
          stepOrder: 1,
          category: "execution",
          toolName: "read_file",
          serverName: "default_api",
          filePath: `src/file_${t}.ts`,
          status: "DONE",
          createdAt: 1000 + t * 1000 + 100,
        });
      }

      sqliteStore.saveSession(
        {
          id: sId,
          adapter: "antigravity",
          title: `Performance Session ${s}`,
          projectPath: "d:/projects/bench-perf",
          createdAt: 1000,
          lastActiveAt: 6000,
          firstPrompt: `Turn 1 question for session ${s}`,
        },
        turns,
        steps
      );
    }

    // Warmup passes (un-timed)
    await computeSessionBenchmarks([sessionIds[0]]);
    await searchHistory({ query: "Turn 1 question", mode: "hybrid", limit: 5 });

    // Measure computeSessionBenchmarks across multiple iterations
    const iterations = 10;
    const startBench = performance.now();
    for (let i = 0; i < iterations; i++) {
      await computeSessionBenchmarks(sessionIds);
    }
    const totalBenchElapsed = performance.now() - startBench;
    const avgBenchPerSession = totalBenchElapsed / (iterations * sessionIds.length);

    // Assert sub-5ms SLA
    assert.ok(
      avgBenchPerSession < 5.0,
      `computeSessionBenchmarks average per session (${avgBenchPerSession.toFixed(3)}ms) must be < 5.0ms`
    );

    // Measure searchHistory hybrid mode
    const startSearch = performance.now();
    for (let i = 0; i < iterations; i++) {
      await searchHistory({ query: "performance benchmark test", mode: "hybrid", limit: 5 });
    }
    const totalSearchElapsed = performance.now() - startSearch;
    const avgSearchPerOp = totalSearchElapsed / iterations;

    assert.ok(
      avgSearchPerOp < 5.0,
      `searchHistory average per operation (${avgSearchPerOp.toFixed(3)}ms) must be < 5.0ms`
    );
  });

  it("should generate interactive HTML line chart HTML string correctly", async () => {
    const { generateInteractiveContextChartHtml } = await import("../search.js");
    const steps: StepData[] = [
      { stepIndex: 0, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", content: "Hello" },
      { stepIndex: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "Hi" },
      { stepIndex: 2, type: "CHECKPOINT", source: "SYSTEM", status: "DONE", content: "{{ CHECKPOINT 1 }}" }
    ];

    const html = generateInteractiveContextChartHtml("test-chart-id", "Test Session Chart", steps);
    assert.ok(html.includes("<!DOCTYPE html>"));
    assert.ok(html.includes("Context Window Timeline"));
    assert.ok(html.includes("CHECKPOINT 1"));
    assert.ok(html.includes("test-chart-id"));
    assert.ok(html.includes("svg"));
  });

  it("should include cumulative output tokens area chart elements in generated HTML", async () => {
    const { generateInteractiveContextChartHtml } = await import("../search.js");
    const steps: StepData[] = [
      { stepIndex: 0, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", content: "Hello world" },
      { stepIndex: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "Response one" },
      { stepIndex: 2, type: "MCP_TOOL", source: "SYSTEM", status: "DONE", content: "Tool result" },
      { stepIndex: 3, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "Response two" },
    ];

    const html = generateInteractiveContextChartHtml("output-test-id", "Output Token Test", steps);

    assert.ok(html.includes('id="output-area"'), "Missing output-area polygon");
    assert.ok(html.includes('id="output-line"'), "Missing output-line polyline");
    assert.ok(html.includes('id="output-area-gradient"'), "Missing output-area-gradient");
    assert.ok(html.includes('#ef4444'), "Missing red color for output chart");
    assert.ok(html.includes('id="toggle-output"'), "Missing toggle-output checkbox");
    assert.ok(html.includes('Cumulative Output Area'), "Missing Cumulative Output Area label");
    assert.ok(html.includes('Cumulative Output'), "Missing Cumulative Output in tooltip");
    assert.ok(html.includes('id="pinned-output"'), "Missing pinned-output element");
    assert.ok(html.includes('Total Output'), "Missing Total Output stat badge");
    assert.ok(html.includes('outputContext'), "Missing outputContext in pointsData");
  });

  it("should compute correct cumulative output token values across step types", async () => {
    const { generateInteractiveContextChartHtml } = await import("../search.js");
    const steps: StepData[] = [
      { stepIndex: 0, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", content: "Hello world" },
      { stepIndex: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "Response one" },
      { stepIndex: 2, type: "MCP_TOOL", source: "MODEL", status: "DONE", content: "Tool result with many tokens" },
      { stepIndex: 3, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "Response two", thinking: "Internal reasoning" },
      { stepIndex: 4, type: "CHECKPOINT", source: "SYSTEM", status: "DONE", content: "{{ CHECKPOINT 1 }}" },
      { stepIndex: 5, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "Response three" },
    ];

    const html = generateInteractiveContextChartHtml("cumval-test", "Cumulative Values Test", steps);

    const b64Match = html.match(/const pointsDataB64 = "([^"]+)"/);
    assert.ok(b64Match, "Expected base64-encoded pointsData in HTML");
    const pointsData = JSON.parse(Buffer.from(b64Match[1], "base64").toString("utf-8"));

    assert.strictEqual(pointsData.length, 6, "Should have 6 data points");

    for (let i = 1; i < pointsData.length; i++) {
      assert.ok(pointsData[i].outputContext >= pointsData[i - 1].outputContext,
        `outputContext must be monotonic: step ${i} (${pointsData[i].outputContext}) < step ${i-1} (${pointsData[i-1].outputContext})`);
    }

    assert.strictEqual(pointsData[0].outputContext, 0, "USER_INPUT should not contribute to cumulative output");
    assert.strictEqual(pointsData[2].outputContext, pointsData[1].outputContext,
      "MCP_TOOL step should not increase cumulative output even with source=MODEL");
    assert.ok(pointsData[1].outputContext > 0, "First PLANNER_RESPONSE should contribute output tokens");
    assert.ok(pointsData[3].outputContext > pointsData[2].outputContext,
      "PLANNER_RESPONSE with thinking should increase cumulative output");
    assert.ok(pointsData[5].outputContext > pointsData[3].outputContext,
      "Cumulative output should keep growing after CHECKPOINT");
    assert.ok(pointsData[5].context < pointsData[3].context,
      "Context window should drop after CHECKPOINT while output keeps growing");

    const finalOutput = pointsData[pointsData.length - 1].outputContext;
    assert.ok(html.includes(`Total Output`), "Total Output badge must be present");
    assert.ok(html.includes(finalOutput.toLocaleString()), `Total Output badge should show ${finalOutput.toLocaleString()}`);
  });
});
