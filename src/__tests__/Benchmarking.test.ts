import { describe, it } from "node:test";
import assert from "node:assert";
import { InMemoryHistoryStore, setStore, SessionEmbeddings } from "../db.js";
import { computeSessionBenchmarks } from "../search.js";
import { SessionData, StepData } from "../adapters/types.js";

describe("Benchmarking Logic", () => {
  it("should calculate session benchmark metrics and caching simulation correctly", async () => {
    const store = new InMemoryHistoryStore();
    setStore(store);

    const sessionId = "bench-session-1";

    const steps: StepData[] = [
      {
        stepIndex: 0,
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        status: "DONE",
        content: "Hello", // 1 token in cl100k
        createdAt: 1700000000000
      },
      {
        stepIndex: 1,
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        content: "ResponseOne", // 2 tokens in cl100k
        toolCalls: JSON.stringify([{ name: "test_tool", args: {} }]), // 10 tokens approx
        createdAt: 1700000002000
      },
      {
        stepIndex: 2,
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        status: "DONE",
        content: "Hello again", // 2 tokens in cl100k
        createdAt: 1700000003000
      },
      {
        stepIndex: 3,
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "ERROR",
        content: "ResponseTwo", // 2 tokens in cl100k
        createdAt: 1700000005000
      }
    ];

    const session: SessionData = {
      id: sessionId,
      adapter: "antigravity",
      title: "Bench Session",
      projectPath: "/projects/bench",
      createdAt: 1700000000000,
      firstPrompt: "Hello",
      secondPrompt: "",
      chunks: [],
      steps
    };

    const embeddings: SessionEmbeddings = {
      summary: [0, 0],
      chunks: new Map()
    };

    store.save(session, embeddings);

    const benchmarks = await computeSessionBenchmarks([sessionId]);
    assert.strictEqual(benchmarks.length, 1);
    
    const m = benchmarks[0];
    assert.strictEqual(m.sessionId, sessionId);
    assert.strictEqual(m.title, "Bench Session");
    assert.strictEqual(m.totalSteps, 4);
    assert.strictEqual(m.toolCallsCount, 1);
    assert.strictEqual(m.durationMs, 5000); // 1700000005000 - 1700000000000
    assert.strictEqual(m.errorStepsCount, 1); // step 3 is ERROR
    assert.strictEqual(m.hasDetailedSteps, true);

    // Verify prompt caching metrics are calculated
    assert.ok(m.cumulativeInputTokens > 0);
    assert.ok(m.cacheHitTokens > 0);
    assert.ok(m.cacheMissTokens > 0);
    assert.ok(m.cacheHitRate > 0 && m.cacheHitRate < 100);
    assert.ok(m.estimatedCostSavings > 0 && m.estimatedCostSavings < 100);
    assert.ok(m.peakContextSize > 0);
    assert.ok(m.estimatedOutputTokens > 0);
  });

  it("should fallback to chunks token estimation when no steps are present", async () => {
    const store = new InMemoryHistoryStore();
    setStore(store);

    const sessionId = "bench-session-2";

    const session: SessionData = {
      id: sessionId,
      adapter: "antigravity",
      title: "Chunk-only Session",
      projectPath: "/projects/bench",
      createdAt: 1700000000000,
      firstPrompt: "Chunk prompt",
      secondPrompt: "",
      chunks: [
        { stepIndex: 0, text: "User: Chunk prompt\nAssistant: Response text" }
      ]
    };

    const embeddings: SessionEmbeddings = {
      summary: [0, 0],
      chunks: new Map()
    };

    store.save(session, embeddings);

    const benchmarks = await computeSessionBenchmarks([sessionId]);
    assert.strictEqual(benchmarks.length, 1);
    
    const m = benchmarks[0];
    assert.strictEqual(m.sessionId, sessionId);
    assert.strictEqual(m.totalSteps, 1); // 1 chunk
    assert.strictEqual(m.toolCallsCount, 0);
    assert.strictEqual(m.durationMs, null);
    assert.strictEqual(m.errorStepsCount, 0);
    assert.strictEqual(m.hasDetailedSteps, false);

    assert.ok(m.cumulativeInputTokens > 0);
    assert.ok(m.cacheHitTokens === 0); // fallback has no hits
    assert.ok(m.cacheHitRate === 0);
    assert.ok(m.estimatedCostSavings === 0);
    assert.ok(m.peakContextSize > 0);
    assert.ok(m.estimatedOutputTokens > 0);
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
      chunks: [],
      steps: [
        {
          stepIndex: 1,
          type: "PLANNER_RESPONSE",
          source: "MODEL",
          status: "DONE",
          toolCalls: JSON.stringify([{ name: "\"memory\"/\"read_graph\"" }, { name: "gitnexus/query" }]),
          createdAt: 1700000001000
        },
        {
          stepIndex: 2,
          type: "PLANNER_RESPONSE",
          source: "MODEL",
          status: "DONE",
          toolCalls: JSON.stringify([{ name: "gitnexus/query" }]),
          createdAt: 1700000002000
        }
      ]
    };

    store.save(session, { summary: [0, 0], chunks: new Map() });

    const { getToolUsageStats } = await import("../search.js");
    const stats = await getToolUsageStats({ limit: 5, projectPath: "stats" });

    assert.deepStrictEqual(stats, {
      "memory/read_graph": 1,
      "gitnexus/query": 2
    });
  });

  it("should correctly handle CHECKPOINT steps in caching simulation and peakContextSize", async () => {
    const store = new InMemoryHistoryStore();
    setStore(store);

    const sessionId = "checkpoint-session-1";

    const steps: StepData[] = [
      {
        stepIndex: 0,
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        status: "DONE",
        content: "First turn question",
        createdAt: 1700000000000
      },
      {
        stepIndex: 1,
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        content: "First turn response",
        createdAt: 1700000001000
      },
      {
        stepIndex: 2,
        type: "CHECKPOINT",
        source: "SYSTEM",
        status: "DONE",
        content: "{{ CHECKPOINT 1 }} Summary of truncated content",
        createdAt: 1700000002000
      },
      {
        stepIndex: 3,
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        status: "DONE",
        content: "Second turn question",
        createdAt: 1700000003000
      },
      {
        stepIndex: 4,
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        content: "Second turn response",
        createdAt: 1700000004000
      }
    ];

    const session: SessionData = {
      id: sessionId,
      adapter: "antigravity",
      title: "Checkpoint Session",
      projectPath: "/projects/ckpt",
      createdAt: 1700000000000,
      firstPrompt: "First turn question",
      secondPrompt: "",
      chunks: [],
      steps
    };

    store.save(session, { summary: [0, 0], chunks: new Map() });

    const benchmarks = await computeSessionBenchmarks([sessionId]);
    assert.strictEqual(benchmarks.length, 1);

    const m = benchmarks[0];
    assert.strictEqual(m.sessionId, sessionId);
    assert.strictEqual(m.totalSteps, 5);
    assert.ok(m.peakContextSize > 0);
    // Verified that cache simulation ran without throwing errors
    assert.ok(m.cumulativeInputTokens > 0);
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

    // SVG output area elements
    assert.ok(html.includes('id="output-area"'), "Missing output-area polygon");
    assert.ok(html.includes('id="output-line"'), "Missing output-line polyline");
    assert.ok(html.includes('id="output-area-gradient"'), "Missing output-area-gradient");
    assert.ok(html.includes('#ef4444'), "Missing red color for output chart");

    // Controls bar toggle
    assert.ok(html.includes('id="toggle-output"'), "Missing toggle-output checkbox");
    assert.ok(html.includes('Cumulative Output Area'), "Missing Cumulative Output Area label");

    // Tooltip and pinned card output fields
    assert.ok(html.includes('Cumulative Output'), "Missing Cumulative Output in tooltip");
    assert.ok(html.includes('id="pinned-output"'), "Missing pinned-output element");

    // Stats badge
    assert.ok(html.includes('Total Output'), "Missing Total Output stat badge");

    // Data should include outputContext field
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

    // Extract base64-encoded pointsData from HTML
    const b64Match = html.match(/const pointsDataB64 = "([^"]+)"/);
    assert.ok(b64Match, "Expected base64-encoded pointsData in HTML");
    const pointsData = JSON.parse(Buffer.from(b64Match[1], "base64").toString("utf-8"));

    assert.strictEqual(pointsData.length, 6, "Should have 6 data points");

    // outputContext must be monotonically non-decreasing
    for (let i = 1; i < pointsData.length; i++) {
      assert.ok(pointsData[i].outputContext >= pointsData[i - 1].outputContext,
        `outputContext must be monotonic: step ${i} (${pointsData[i].outputContext}) < step ${i-1} (${pointsData[i-1].outputContext})`);
    }

    // Step 0 (USER_INPUT): outputContext should be 0
    assert.strictEqual(pointsData[0].outputContext, 0, "USER_INPUT should not contribute to cumulative output");

    // Step 2 (MCP_TOOL with source=MODEL): should NOT increase outputContext
    assert.strictEqual(pointsData[2].outputContext, pointsData[1].outputContext,
      "MCP_TOOL step should not increase cumulative output even with source=MODEL");

    // Step 1 (PLANNER_RESPONSE): should increase from 0
    assert.ok(pointsData[1].outputContext > 0, "First PLANNER_RESPONSE should contribute output tokens");

    // Step 3 (PLANNER_RESPONSE with thinking): should include thinking tokens in output
    assert.ok(pointsData[3].outputContext > pointsData[2].outputContext,
      "PLANNER_RESPONSE with thinking should increase cumulative output");

    // Step 5 (PLANNER_RESPONSE after CHECKPOINT): output continues accumulating (never resets)
    assert.ok(pointsData[5].outputContext > pointsData[3].outputContext,
      "Cumulative output should keep growing after CHECKPOINT");

    // Context window should reset after CHECKPOINT
    assert.ok(pointsData[5].context < pointsData[3].context,
      "Context window should drop after CHECKPOINT while output keeps growing");

    // Total Output badge should show final cumulative value
    const finalOutput = pointsData[pointsData.length - 1].outputContext;
    assert.ok(html.includes(`Total Output`), "Total Output badge must be present");
    assert.ok(html.includes(finalOutput.toLocaleString()), `Total Output badge should show ${finalOutput.toLocaleString()}`);
  });
});
