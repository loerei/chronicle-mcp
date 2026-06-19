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
});
