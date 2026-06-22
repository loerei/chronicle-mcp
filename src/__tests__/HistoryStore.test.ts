import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { 
  InMemoryHistoryStore, 
  SqliteHistoryStore, 
  HistoryStore,
  SessionEmbeddings
} from "../db.js";
import { SessionData } from "../adapters/types.js";
import { syncHistory, isAutoSyncEnabled } from "../index.js";
import { ADAPTERS } from "../adapters/index.js";

function runTestSuite(name: string, storeFactory: () => HistoryStore) {
  describe(`HistoryStore - ${name}`, () => {
    it("should save a session, its chunks, and steps, then retrieve them", () => {
      const store = storeFactory();
      
      const session: SessionData = {
        id: "session-1",
        adapter: "antigravity",
        title: "Test Session 1",
        projectPath: "d:/projects/test-project",
        createdAt: 1700000000000,
        firstPrompt: "init",
        secondPrompt: "",
        chunks: [
          { stepIndex: 0, text: "Chunk 1 content" },
          { stepIndex: 1, text: "Chunk 2 content" }
        ],
        steps: [
          {
            stepIndex: 0,
            type: "USER_INPUT",
            source: "USER_EXPLICIT",
            status: "DONE",
            content: "init",
            createdAt: 1700000000000
          },
          {
            stepIndex: 1,
            type: "COMMAND",
            source: "MODEL",
            status: "ERROR",
            content: "npm run test failed",
            thinking: "Running tests...",
            toolCalls: JSON.stringify([{ name: "execute_command" }]),
            createdAt: 1700000001000
          }
        ]
      };

      const embeddings: SessionEmbeddings = {
        summary: [0.9, 0.1],
        chunks: new Map([
          [0, [0.95, 0.05]],
          [1, [0.8, 0.2]]
        ])
      };

      store.save(session, embeddings);

      // Query without filters
      const result = store.query({ includeSteps: true });
      assert.strictEqual(result.sessions.length, 1);
      assert.strictEqual(result.sessions[0].id, "session-1");
      assert.strictEqual(result.sessions[0].title, "Test Session 1");
      
      assert.strictEqual(result.chunks.length, 2);
      assert.strictEqual(result.chunks[0].text, "Chunk 1 content");
      assert.strictEqual(result.chunks[1].text, "Chunk 2 content");

      assert.strictEqual(result.steps.length, 2);
      assert.strictEqual(result.steps[1].type, "COMMAND");
      assert.strictEqual(result.steps[1].status, "ERROR");
      assert.strictEqual(result.steps[1].thinking, "Running tests...");

      store.close();
    });

    it("should filter query() results by sessionId, adapter, and projectPath", () => {
      const store = storeFactory();

      const sessionA: SessionData = {
        id: "session-a",
        adapter: "antigravity",
        title: "Session A",
        projectPath: "d:/projects/project-a",
        createdAt: 1700000000000,
        firstPrompt: "hello",
        secondPrompt: "",
        chunks: []
      };

      const sessionB: SessionData = {
        id: "session-b",
        adapter: "cursor",
        title: "Session B",
        projectPath: "d:/projects/project-b",
        createdAt: 1700000010000,
        firstPrompt: "world",
        secondPrompt: "",
        chunks: []
      };

      const embeddings: SessionEmbeddings = {
        summary: [0.5, 0.5],
        chunks: new Map()
      };

      store.save(sessionA, embeddings);
      store.save(sessionB, embeddings);

      // Filter by sessionId
      const resSessionId = store.query({ sessionId: "session-a" });
      assert.strictEqual(resSessionId.sessions.length, 1);
      assert.strictEqual(resSessionId.sessions[0].id, "session-a");

      // Filter by adapter
      const resAdapter = store.query({ adapter: "cursor" });
      assert.strictEqual(resAdapter.sessions.length, 1);
      assert.strictEqual(resAdapter.sessions[0].id, "session-b");

      // Filter by projectPath (LIKE match case-insensitive substring)
      const resPath = store.query({ projectPath: "project-a" });
      assert.strictEqual(resPath.sessions.length, 1);
      assert.strictEqual(resPath.sessions[0].id, "session-a");

      // Limit results
      const resLimit = store.query({ limit: 1 });
      assert.strictEqual(resLimit.sessions.length, 1);

      store.close();
    });

    it("should filter steps in query() by type, status, query, and slice by index", () => {
      const store = storeFactory();

      const session: SessionData = {
        id: "session-steps",
        adapter: "antigravity",
        title: "Steps Test",
        projectPath: "d:/projects/test-steps-project",
        createdAt: 1700000000000,
        firstPrompt: "",
        secondPrompt: "",
        chunks: [
          { stepIndex: 1, text: "Chunk 1" },
          { stepIndex: 2, text: "Chunk 2" }
        ],
        steps: [
          { stepIndex: 1, type: "USER_INPUT", source: "USER", status: "DONE", content: "hello world" },
          { stepIndex: 2, type: "COMMAND", source: "MODEL", status: "ERROR", content: "test failed", thinking: "debugging", toolCalls: JSON.stringify([{ name: "memory/read_graph" }]) },
          { stepIndex: 3, type: "MCP_TOOL", source: "MODEL", status: "DONE", content: "success", toolCalls: JSON.stringify([{ name: "other/do_work" }]) }
        ]
      };

      store.save(session, { summary: [0.5, 0.5], chunks: new Map() });

      // Slicing: startStep and endStep
      const resSlice = store.query({ includeSteps: true, sessionId: "session-steps", startStep: 2, endStep: 3 });
      assert.strictEqual(resSlice.steps.length, 2);
      assert.strictEqual(resSlice.steps[0].stepIndex, 2);
      assert.strictEqual(resSlice.steps[1].stepIndex, 3);
      assert.strictEqual(resSlice.chunks.length, 1);
      assert.strictEqual(resSlice.chunks[0].stepIndex, 2);

      // Filter steps by type
      const resType = store.query({ includeSteps: true, sessionId: "session-steps", stepType: "COMMAND" });
      assert.strictEqual(resType.steps.length, 1);
      assert.strictEqual(resType.steps[0].type, "COMMAND");

      // Filter steps by status
      const resStatus = store.query({ includeSteps: true, sessionId: "session-steps", stepStatus: "ERROR" });
      assert.strictEqual(resStatus.steps.length, 1);
      assert.strictEqual(resStatus.steps[0].status, "ERROR");

      // Filter steps by stepQuery
      const resQuery = store.query({ includeSteps: true, sessionId: "session-steps", stepQuery: "fail" });
      assert.strictEqual(resQuery.steps.length, 1);
      assert.strictEqual(resQuery.steps[0].content, "test failed");

      // Filter steps by toolName (TDD Cycle 1)
      const resTool = store.query({ includeSteps: true, sessionId: "session-steps", toolName: "read_graph" });
      assert.strictEqual(resTool.steps.length, 1);
      assert.strictEqual(resTool.steps[0].stepIndex, 2);

      // Filter steps by serverName (TDD Cycle 1)
      const resServer = store.query({ includeSteps: true, sessionId: "session-steps", serverName: "memory" });
      assert.strictEqual(resServer.steps.length, 1);
      assert.strictEqual(resServer.steps[0].stepIndex, 2);

      // Exclude step content/thinking fields (TDD Cycle 2)
      const resExclude = store.query({ includeSteps: true, sessionId: "session-steps", excludeContent: true });
      assert.strictEqual(resExclude.steps.length, 3);
      assert.strictEqual(resExclude.steps[0].content, undefined);
      assert.strictEqual(resExclude.steps[0].thinking, undefined);
      assert.strictEqual(resExclude.steps[1].content, undefined);
      assert.strictEqual(resExclude.steps[1].thinking, undefined);

      // Filter steps by projectPath (TDD Cycle 3)
      const resProjMatch = store.query({ includeSteps: true, projectPath: "steps-project" });
      assert.strictEqual(resProjMatch.steps.length, 3);

      const resProjMismatch = store.query({ includeSteps: true, projectPath: "other-project" });
      assert.strictEqual(resProjMismatch.steps.length, 0);

      store.close();
    });

    it("should perform two-stage hierarchical vector search ranking in search()", () => {
      const store = storeFactory();

      // Session A (matches closely to query [1, 0])
      const sessionA: SessionData = {
        id: "session-a",
        adapter: "antigravity",
        title: "Session A",
        projectPath: "d:/projects/a",
        createdAt: 1700000000000,
        firstPrompt: "",
        secondPrompt: "",
        chunks: [
          { stepIndex: 0, text: "Close Match Chunk" },
          { stepIndex: 1, text: "Medium Match Chunk" }
        ]
      };
      const embeddingsA: SessionEmbeddings = {
        summary: [0.9, 0.1],
        chunks: new Map([
          [0, [0.95, 0.05]],
          [1, [0.7, 0.3]]
        ])
      };

      // Session B (poor match to query [1, 0])
      const sessionB: SessionData = {
        id: "session-b",
        adapter: "cursor",
        title: "Session B",
        projectPath: "d:/projects/b",
        createdAt: 1700000000000,
        firstPrompt: "",
        secondPrompt: "",
        chunks: [
          { stepIndex: 0, text: "Irrelevant Chunk" }
        ]
      };
      const embeddingsB: SessionEmbeddings = {
        summary: [0.1, 0.9],
        chunks: new Map([
          [0, [1, 0]] // Excellent chunk similarity, but session level 1 excludes it
        ])
      };

      store.save(sessionA, embeddingsA);
      store.save(sessionB, embeddingsB);

      // Insert 5 dummy sessions to push Session B out of top 5 (which gets computed in Level 1)
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
        const dummyEmbed: SessionEmbeddings = {
          summary: [0.3, 0.7],
          chunks: new Map()
        };
        store.save(dummy, dummyEmbed);
      }

      // Execute search with query vector [1, 0]
      const hits = store.search([1, 0], 3);

      assert.strictEqual(hits.length, 2); // Only chunks of Session A should be returned
      assert.strictEqual(hits[0].chunkText, "Close Match Chunk");
      assert.ok(Math.abs(hits[0].similarity - 0.95) < 0.01);
      assert.strictEqual(hits[1].chunkText, "Medium Match Chunk");
      assert.ok(Math.abs(hits[1].similarity - 0.7) < 0.01);

      // Search with projectPath constraint
      const hitsC = store.search([1, 0], 3, { projectPath: "projects/a" });
      assert.strictEqual(hitsC.length, 2);

      const hitsNone = store.search([1, 0], 3, { projectPath: "projects/nonexistent" });
      assert.strictEqual(hitsNone.length, 0);

      store.close();
    });

    it("should handle duplicate chunk index update correctly via overwriting/ignoring", () => {
      const store = storeFactory();

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

      store.save(session, { summary: [1, 0], chunks: new Map([[1, [1, 0]]]) });

      // Save again with same session id, same chunk index but different text
      const session2: SessionData = {
        ...session,
        chunks: [
          { stepIndex: 1, text: "Duplicate chunk" }
        ]
      };
      
      store.save(session2, { summary: [1, 0], chunks: new Map([[1, [1, 0]]]) });

      // Verify that after save, only one chunk with stepIndex 1 exists (the latest one or ignored first)
      const res = store.query({ sessionId: "session-dup" });
      assert.strictEqual(res.chunks.length, 1);
      
      store.close();
    });

    it("should link parent and child sessions and query parentId correctly", () => {
      const store = storeFactory();

      const childSession: SessionData = {
        id: "child-session-id",
        adapter: "antigravity",
        title: "Child Session",
        projectPath: "",
        createdAt: 1700000000000,
        firstPrompt: "",
        secondPrompt: "",
        chunks: [],
      };

      const parentSession: SessionData = {
        id: "parent-session-id",
        adapter: "antigravity",
        title: "Parent Session",
        projectPath: "",
        createdAt: 1700000001000,
        firstPrompt: "",
        secondPrompt: "",
        chunks: [],
        subagentIds: ["child-session-id"]
      };

      const embeddings: SessionEmbeddings = {
        summary: [0.5, 0.5],
        chunks: new Map()
      };

      // Save child first, then parent (which updates child link)
      store.save(childSession, embeddings);
      store.save(parentSession, embeddings);

      const resChild = store.query({ sessionId: "child-session-id" });
      assert.strictEqual(resChild.sessions.length, 1);
      assert.strictEqual(resChild.sessions[0].parentId, "parent-session-id");

      // Test preserving parentId link if child is re-saved
      store.save(childSession, embeddings);
      const resChildResaved = store.query({ sessionId: "child-session-id" });
      assert.strictEqual(resChildResaved.sessions[0].parentId, "parent-session-id");

      // Verify parent query has no parentId
      const resParent = store.query({ sessionId: "parent-session-id" });
      assert.strictEqual(resParent.sessions.length, 1);
      assert.strictEqual(resParent.sessions[0].parentId, null);

      store.close();
    });

    it("should incrementally save additional chunks and steps without overwriting existing ones", () => {
      const store = storeFactory();

      const session: SessionData = {
        id: "session-inc",
        adapter: "antigravity",
        title: "Incremental Test",
        projectPath: "",
        createdAt: 1700000000000,
        firstPrompt: "init",
        secondPrompt: "",
        chunks: [
          { stepIndex: 0, text: "Chunk 1" }
        ],
        steps: [
          { stepIndex: 0, type: "USER_INPUT", source: "USER", status: "DONE", content: "init" }
        ]
      };

      store.save(session, {
        summary: [0.5, 0.5],
        chunks: new Map([[0, [1, 0]]])
      });

      // Save again with additional chunk and step
      const sessionUpdated: SessionData = {
        ...session,
        chunks: [
          { stepIndex: 0, text: "Chunk 1" },
          { stepIndex: 1, text: "Chunk 2" }
        ],
        steps: [
          { stepIndex: 0, type: "USER_INPUT", source: "USER", status: "DONE", content: "init" },
          { stepIndex: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "response" }
        ]
      };

      // In incremental save, we only pass vectors for NEW chunks
      store.save(sessionUpdated, {
        chunks: new Map([[1, [0, 1]]])
      });

      const res = store.query({ sessionId: "session-inc", includeSteps: true });
      assert.strictEqual(res.chunks.length, 2);
      assert.strictEqual(res.steps.length, 2);
      
      // Verify first chunk vector is preserved (i.e. not empty)
      const searchRes = store.search([1, 0], 5);
      assert.strictEqual(searchRes.length, 2);
      // The first chunk should match query [1, 0] with 1 similarity
      const hit0 = searchRes.find(h => h.stepIndex === 0);
      assert.ok(hit0);
      assert.ok(Math.abs(hit0.similarity - 1) < 0.01);

      // The second chunk should match query [0, 1] with 1 similarity
      const searchRes2 = store.search([0, 1], 5);
      const hit1 = searchRes2.find(h => h.stepIndex === 1);
      assert.ok(hit1);
      assert.ok(Math.abs(hit1.similarity - 1) < 0.01);

      store.close();
    });

    it("should resolve active project path and apply scope workspace filter", () => {
      const store = storeFactory();

      const session1: SessionData = {
        id: "session-s1",
        adapter: "antigravity",
        title: "Session S1",
        projectPath: "d:/projects/project-s1",
        createdAt: 1700000000000,
        firstPrompt: "",
        secondPrompt: "",
        chunks: [{ stepIndex: 0, text: "Chunk S1" }],
        steps: [{ stepIndex: 0, type: "USER_INPUT", source: "USER", status: "DONE", content: "S1" }]
      };

      const session2: SessionData = {
        id: "session-s2",
        adapter: "antigravity",
        title: "Session S2",
        projectPath: "d:/projects/project-s2",
        createdAt: 1700000010000, // More recent
        firstPrompt: "",
        secondPrompt: "",
        chunks: [{ stepIndex: 0, text: "Chunk S2" }],
        steps: [{ stepIndex: 0, type: "USER_INPUT", source: "USER", status: "DONE", content: "S2" }]
      };

      const embeddings: SessionEmbeddings = {
        summary: [0.5, 0.5],
        chunks: new Map([[0, [0.5, 0.5]]])
      };

      store.save(session1, embeddings);
      store.save(session2, embeddings);

      // Verify getActiveProjectPath returns the most recent one (session2)
      assert.strictEqual(store.getActiveProjectPath(), "d:/projects/project-s2");

      // Query with scope: "workspace" (should resolve to session2's projectPath)
      const resWorkspace = store.query({ scope: "workspace", includeSteps: true });
      assert.strictEqual(resWorkspace.sessions.length, 1);
      assert.strictEqual(resWorkspace.sessions[0].id, "session-s2");
      assert.strictEqual(resWorkspace.steps.length, 1);
      assert.strictEqual(resWorkspace.steps[0].content, "S2");

      // Query with scope: "all" or omitted (should return all sessions)
      const resAll = store.query({ scope: "all", includeSteps: true });
      assert.ok(resAll.sessions.length >= 2);
      
      const resOmitted = store.query({ includeSteps: true });
      assert.ok(resOmitted.sessions.length >= 2);

      // Explicit projectPath should override/take precedence
      const resExplicit = store.query({ scope: "workspace", projectPath: "project-s1" });
      assert.strictEqual(resExplicit.sessions.length, 1);
      assert.strictEqual(resExplicit.sessions[0].id, "session-s1");

      // Test search with scope: "workspace"
      const hitsWorkspace = store.search([0.5, 0.5], 10, { scope: "workspace" });
      assert.ok(hitsWorkspace.length > 0);
      assert.ok(hitsWorkspace.every(h => h.projectPath === "d:/projects/project-s2"));

      store.close();
    });

    it("should track session lastActiveAt and support sorting and time range query", () => {
      const store = storeFactory();

      const session1: SessionData = {
        id: "session-t1",
        adapter: "antigravity",
        title: "Test Session 1",
        projectPath: "d:/projects/test",
        createdAt: 1000,
        firstPrompt: "init",
        secondPrompt: "",
        chunks: [],
        steps: [
          { stepIndex: 0, type: "USER_INPUT", source: "USER", status: "DONE", content: "hello", createdAt: 1000 },
          { stepIndex: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "world", createdAt: 5000 }
        ]
      };

      const session2: SessionData = {
        id: "session-t2",
        adapter: "antigravity",
        title: "Test Session 2",
        projectPath: "d:/projects/test",
        createdAt: 2000,
        firstPrompt: "init",
        secondPrompt: "",
        chunks: [],
        steps: [
          { stepIndex: 0, type: "USER_INPUT", source: "USER", status: "DONE", content: "hello", createdAt: 2000 },
          { stepIndex: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "world", createdAt: 3000 }
        ]
      };

      const embeddings: SessionEmbeddings = {
        summary: [0.5, 0.5],
        chunks: new Map()
      };

      store.save(session1, embeddings);
      store.save(session2, embeddings);

      // session1 has: createdAt=1000, lastActiveAt=5000
      // session2 has: createdAt=2000, lastActiveAt=3000

      // Sort by active DESC (default): should be session-t1 (5000) then session-t2 (3000)
      const resActive = store.query({ sortBy: "active" });
      assert.strictEqual(resActive.sessions.length, 2);
      assert.strictEqual(resActive.sessions[0].id, "session-t1");
      assert.strictEqual(resActive.sessions[1].id, "session-t2");
      assert.strictEqual(resActive.sessions[0].lastActiveAt, 5000);
      assert.strictEqual(resActive.sessions[1].lastActiveAt, 3000);

      // Sort by created DESC: should be session-t2 (2000) then session-t1 (1000)
      const resCreated = store.query({ sortBy: "created" });
      assert.strictEqual(resCreated.sessions.length, 2);
      assert.strictEqual(resCreated.sessions[0].id, "session-t2");
      assert.strictEqual(resCreated.sessions[1].id, "session-t1");

      // Filter timeRange "1500:4000" (matches session-t2 lastActiveAt=3000, but session-t1 lastActiveAt=5000 is out of range)
      const resRange = store.query({ timeRange: "1500:4000" });
      assert.strictEqual(resRange.sessions.length, 1);
      assert.strictEqual(resRange.sessions[0].id, "session-t2");

      store.close();
    });

    it("should filter conversation steps, sort in reverse, and slice by conversation step range", () => {
      const store = storeFactory();

      const session: SessionData = {
        id: "session-conv-steps",
        adapter: "antigravity",
        title: "Conv Steps Test",
        projectPath: "",
        createdAt: 1700000000000,
        firstPrompt: "",
        secondPrompt: "",
        chunks: [],
        steps: [
          { stepIndex: 1, type: "USER_INPUT", source: "USER", status: "DONE", content: "first prompt" },
          { stepIndex: 2, type: "COMMAND", source: "MODEL", status: "DONE", content: "some command" },
          { stepIndex: 3, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "", thinking: "response 1 thinking" },
          { stepIndex: 4, type: "MCP_TOOL", source: "MODEL", status: "DONE", content: "tool result" },
          { stepIndex: 5, type: "USER_INPUT", source: "USER", status: "DONE", content: "second prompt" },
          { stepIndex: 6, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "response 2" }
        ]
      };

      store.save(session, { summary: [0.5, 0.5], chunks: new Map() });

      // 1. Test conversationStepsOnly: true (only stepIndex 1, 5, 6 because stepIndex 3 has no content)
      const resConvOnly = store.query({ includeSteps: true, sessionId: "session-conv-steps", conversationStepsOnly: true });
      assert.strictEqual(resConvOnly.steps.length, 3);
      assert.strictEqual(resConvOnly.steps[0].stepIndex, 1);
      assert.strictEqual(resConvOnly.steps[1].stepIndex, 5);
      assert.strictEqual(resConvOnly.steps[2].stepIndex, 6);

      // 2. Test reverseSteps: true
      const resReverse = store.query({ includeSteps: true, sessionId: "session-conv-steps", reverseSteps: true });
      assert.strictEqual(resReverse.steps.length, 6);
      assert.strictEqual(resReverse.steps[0].stepIndex, 6);
      assert.strictEqual(resReverse.steps[5].stepIndex, 1);

      // 3. Test startConversationStep and endConversationStep (1-based index of conversation steps)
      // Conversation steps:
      // Index 1 (1-based) -> stepIndex 1 (USER_INPUT)
      // Index 2 (1-based) -> stepIndex 5 (USER_INPUT)
      // Index 3 (1-based) -> stepIndex 6 (PLANNER_RESPONSE)
      // Slice from conversation step 2 to 3 -> stepIndex 5 to 6
      const resConvRange = store.query({ includeSteps: true, sessionId: "session-conv-steps", startConversationStep: 2, endConversationStep: 3 });
      assert.strictEqual(resConvRange.steps.length, 2);
      assert.strictEqual(resConvRange.steps[0].stepIndex, 5);
      assert.strictEqual(resConvRange.steps[1].stepIndex, 6);

      store.close();
    });
  });
}

runTestSuite("InMemoryHistoryStore", () => new InMemoryHistoryStore());
runTestSuite("SqliteHistoryStore", () => new SqliteHistoryStore(":memory:"));

describe("syncHistory auto-sync and coalescing", () => {
  let originalDiscover0: any;
  let originalDiscover1: any;

  before(() => {
    originalDiscover0 = ADAPTERS[0].discoverSessions;
    originalDiscover1 = ADAPTERS[1].discoverSessions;
  });

  after(() => {
    ADAPTERS[0].discoverSessions = originalDiscover0;
    ADAPTERS[1].discoverSessions = originalDiscover1;
  });

  it("should coalesce concurrent syncHistory calls and respect cooldown", async () => {
    let callCount = 0;
    ADAPTERS[0].discoverSessions = async () => {
      callCount++;
      // Simulate delay
      await new Promise(resolve => setTimeout(resolve, 50));
      return [];
    };
    ADAPTERS[1].discoverSessions = async () => [];

    // Trigger two concurrent syncs
    const p1 = syncHistory(true); // Force bypasses cooldown
    const p2 = syncHistory(true); // Also concurrent, should coalesce

    await Promise.all([p1, p2]);

    // Should only have called discoverSessions once because of coalescing
    assert.strictEqual(callCount, 1);

    // Now call again WITHOUT force - should be within the 5-second cooldown and not call discoverSessions again
    await syncHistory();
    assert.strictEqual(callCount, 1);

    // Call again WITH force - should bypass cooldown and call discoverSessions
    await syncHistory(true);
    assert.strictEqual(callCount, 2);
  });

  it("should return correct status for isAutoSyncEnabled", () => {
    const originalEnv = process.env.CHRONICLE_AUTO_SYNC;
    
    process.env.CHRONICLE_AUTO_SYNC = "true";
    assert.strictEqual(isAutoSyncEnabled(), true);

    process.env.CHRONICLE_AUTO_SYNC = "false";
    assert.strictEqual(isAutoSyncEnabled(), false);

    process.env.CHRONICLE_AUTO_SYNC = originalEnv;
  });
});
