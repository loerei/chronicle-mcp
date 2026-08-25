import { describe, it } from "node:test";
import assert from "node:assert";
import {
  handleChronicleGuide,
  normalizeTopics,
  type ChronicleGuideArgs,
} from "../guide.js";
import { getMcpToolDefinitions, handleCallToolRequest } from "../index.js";

describe("Dynamic Topic-Based chronicle_guide Test Suite", () => {
  // Helper to extract parsed guide content
  function getGuide(args?: ChronicleGuideArgs): { version: string; content: string } {
    const res = handleChronicleGuide(args);
    assert.ok(res.content && res.content.length > 0);
    return JSON.parse(res.content[0].text);
  }

  it("TC-GUIDE-01: should return general overview and decision router on default invocation (no args)", () => {
    const resNoArgs = getGuide();
    assert.strictEqual(resNoArgs.version, "2.0.0");
    assert.ok(resNoArgs.content.includes("## Topic: General Quickstart & Decision Router"));
    assert.ok(resNoArgs.content.includes("### Tool & Parameter Decision Router"));
    assert.ok(resNoArgs.content.includes("flowchart TD"));
    assert.ok(resNoArgs.content.includes("### Tool Matrix"));
    assert.ok(resNoArgs.content.includes("*Topic Catalog:"));

    // Empty object permutation
    const resEmptyObj = getGuide({});
    assert.ok(resEmptyObj.content.includes("## Topic: General Quickstart & Decision Router"));
  });

  it("TC-GUIDE-02: should return search module exclusively when topic is 'search'", () => {
    const res = getGuide({ topic: "search" });
    assert.ok(res.content.includes("## Topic: Historical Search & Turn Slicing"));
    assert.ok(res.content.includes("### Precision Search Recipes"));
    assert.ok(res.content.includes("### Slicing & Detail Level Control"));
    // Should NOT contain the general decision tree flowchart
    assert.ok(!res.content.includes("### Tool & Parameter Decision Router"));
  });

  it("TC-GUIDE-03: should return artifacts module exclusively when topic is 'artifacts'", () => {
    const res = getGuide({ topic: "artifacts" });
    assert.ok(res.content.includes("## Topic: Artifact Discovery & Direct Disk Export"));
    assert.ok(res.content.includes("### Artifact Retrieval Recipes"));
    assert.ok(res.content.includes("### Direct Disk Export & Path Traversal Security"));
    assert.ok(!res.content.includes("## Topic: General Quickstart"));
  });

  it("TC-GUIDE-04: should return subagents module exclusively when topic is 'subagents'", () => {
    const res = getGuide({ topic: "subagents" });
    assert.ok(res.content.includes("## Topic: Subagent Swarms & Multi-Agent Timelines"));
    assert.ok(res.content.includes("### Swarm Tracing Recipes"));
    assert.ok(res.content.includes("### Subagent Hierarchy Topology"));
    assert.ok(!res.content.includes("## Topic: General Quickstart"));
  });

  it("TC-GUIDE-05: should return benchmarks module exclusively when topic is 'benchmarks'", () => {
    const res = getGuide({ topic: "benchmarks" });
    assert.ok(res.content.includes("## Topic: Performance & Token Benchmarking"));
    assert.ok(res.content.includes("### Multi-Variant A/B/C Benchmarking Recipes"));
    assert.ok(res.content.includes("### Metrics Dictionary"));
    assert.ok(!res.content.includes("## Topic: General Quickstart"));
  });

  it("TC-GUIDE-06: should return debug_errors module exclusively when topic is 'debug_errors'", () => {
    const res = getGuide({ topic: "debug_errors" });
    assert.ok(res.content.includes("## Topic: Error Diagnosis & Thrashing Detection"));
    assert.ok(res.content.includes("### Tool Error Diagnosis Recipes"));
    assert.ok(res.content.includes("### Thrashing Loop Detection"));
    assert.ok(!res.content.includes("## Topic: General Quickstart"));
  });

  it("TC-GUIDE-07: should concatenate multiple topic modules separated by dividers when topics array is passed", () => {
    const res = getGuide({ topics: ["search", "benchmarks"] });
    assert.ok(res.content.includes("## Topic: Historical Search & Turn Slicing"));
    assert.ok(res.content.includes("## Topic: Performance & Token Benchmarking"));
    assert.ok(res.content.includes("\n\n---\n\n"));
    assert.ok(!res.content.includes("## Topic: General Quickstart"));
  });

  it("TC-GUIDE-08: should permissively parse comma-delimited strings in topic or topics", () => {
    const resString = getGuide({ topic: "search,benchmarks" });
    assert.ok(resString.content.includes("## Topic: Historical Search & Turn Slicing"));
    assert.ok(resString.content.includes("## Topic: Performance & Token Benchmarking"));

    const resArrayString = getGuide({ topics: ["artifacts, subagents"] });
    assert.ok(resArrayString.content.includes("## Topic: Artifact Discovery & Direct Disk Export"));
    assert.ok(resArrayString.content.includes("## Topic: Subagent Swarms & Multi-Agent Timelines"));
  });

  it("TC-GUIDE-09: should expand topic 'all' into full canonical 6-topic manual", () => {
    const res = getGuide({ topic: "all" });
    assert.ok(res.content.includes("## Topic: General Quickstart & Decision Router"));
    assert.ok(res.content.includes("## Topic: Historical Search & Turn Slicing"));
    assert.ok(res.content.includes("## Topic: Artifact Discovery & Direct Disk Export"));
    assert.ok(res.content.includes("## Topic: Subagent Swarms & Multi-Agent Timelines"));
    assert.ok(res.content.includes("## Topic: Performance & Token Benchmarking"));
    assert.ok(res.content.includes("## Topic: Error Diagnosis & Thrashing Detection"));
  });

  it("TC-GUIDE-10: should deduplicate topic requests while preserving caller insertion order", () => {
    const res = getGuide({ topics: ["benchmarks", "search", "benchmarks", "search"] });
    const benchmarksIndex = res.content.indexOf("## Topic: Performance & Token Benchmarking");
    const searchIndex = res.content.indexOf("## Topic: Historical Search & Turn Slicing");
    assert.ok(benchmarksIndex !== -1);
    assert.ok(searchIndex !== -1);
    // Benchmarks was requested first, so it should appear before search
    assert.ok(benchmarksIndex < searchIndex);

    // Should only appear once each
    assert.strictEqual(
      res.content.split("## Topic: Performance & Token Benchmarking").length - 1,
      1
    );
    assert.strictEqual(
      res.content.split("## Topic: Historical Search & Turn Slicing").length - 1,
      1
    );
  });

  it("TC-GUIDE-11: should handle case and whitespace insensitivity gracefully", () => {
    const res = getGuide({ topic: "   SEARCH   " });
    assert.ok(res.content.includes("## Topic: Historical Search & Turn Slicing"));
    assert.ok(!res.content.includes("Unrecognized topic"));
  });

  it("TC-GUIDE-12: should prune empty tokens without emitting spurious invalid topic warnings", () => {
    const res = getGuide({ topics: ["", "   ", "search,", ",artifacts"] });
    assert.ok(res.content.includes("## Topic: Historical Search & Turn Slicing"));
    assert.ok(res.content.includes("## Topic: Artifact Discovery & Direct Disk Export"));
    assert.ok(!res.content.includes("Unrecognized topic"));
  });

  it("TC-GUIDE-13: should fallback to general guide with diagnostic banner when all requested topics are invalid", () => {
    const res = getGuide({ topic: "invalid_topic_xyz" });
    assert.ok(res.content.includes('> [!NOTE]\n> Unrecognized topic(s): "invalid_topic_xyz". Defaulting to "general" overview.'));
    assert.ok(res.content.includes("## Topic: General Quickstart & Decision Router"));
  });

  it("TC-GUIDE-14: should render valid topics and prepend diagnostic banner for partial invalid topics", () => {
    const res = getGuide({ topics: ["search", "non_existent_topic"] });
    assert.ok(res.content.includes('> [!NOTE]\n> Unrecognized topic(s): "non_existent_topic". Showing requested valid topic(s): "search".'));
    assert.ok(res.content.includes("## Topic: Historical Search & Turn Slicing"));
    assert.ok(!res.content.includes("## Topic: General Quickstart"));
  });

  it("TC-GUIDE-15: should defend against non-string elements at runtime without throwing", () => {
    const res = getGuide({
      topic: 12345 as any,
      topics: [null, undefined, true, {}] as any,
    });
    assert.strictEqual(res.version, "2.0.0");
    assert.ok(res.content.includes("## Topic: General Quickstart & Decision Router"));
  });

  it("TC-GUIDE-16: should dispatch chronicle_guide via handleCallToolRequest with args and schema metadata", async () => {
    // 1. Schema metadata check
    const defs = getMcpToolDefinitions();
    const guideDef = defs.find((d) => d.name === "chronicle_guide");
    assert.ok(guideDef);
    assert.ok(guideDef.inputSchema.properties.topic);
    assert.ok(guideDef.inputSchema.properties.topics);
    assert.ok(Array.isArray(guideDef.inputSchema.properties.topic.enum));
    assert.ok(guideDef.inputSchema.properties.topic.enum.includes("search"));

    // 2. Dispatcher check
    const res = await handleCallToolRequest("chronicle_guide", { topic: "subagents" });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.content.includes("## Topic: Subagent Swarms & Multi-Agent Timelines"));
  });
});
