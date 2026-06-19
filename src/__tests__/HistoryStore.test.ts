import { describe, it } from "node:test";
import assert from "node:assert";
import { 
  InMemoryHistoryStore, 
  SqliteHistoryStore, 
  HistoryStore,
  SessionEmbeddings
} from "../db.js";
import { SessionData, StepData, ChunkData } from "../adapters/types.js";

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
        projectPath: "",
        createdAt: 1700000000000,
        firstPrompt: "",
        secondPrompt: "",
        chunks: [
          { stepIndex: 1, text: "Chunk 1" },
          { stepIndex: 2, text: "Chunk 2" }
        ],
        steps: [
          { stepIndex: 1, type: "USER_INPUT", source: "USER", status: "DONE", content: "hello world" },
          { stepIndex: 2, type: "COMMAND", source: "MODEL", status: "ERROR", content: "test failed", thinking: "debugging", toolCalls: "[]" },
          { stepIndex: 3, type: "MCP_TOOL", source: "MODEL", status: "DONE", content: "success" }
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
          [0, [1.0, 0.0]] // Excellent chunk similarity, but session level 1 excludes it
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

      // Execute search with query vector [1.0, 0.0]
      const hits = store.search([1.0, 0.0], 3);

      assert.strictEqual(hits.length, 2); // Only chunks of Session A should be returned
      assert.strictEqual(hits[0].chunkText, "Close Match Chunk");
      assert.ok(Math.abs(hits[0].similarity - 0.95) < 0.01);
      assert.strictEqual(hits[1].chunkText, "Medium Match Chunk");
      assert.ok(Math.abs(hits[1].similarity - 0.7) < 0.01);

      // Search with projectPath constraint
      const hitsC = store.search([1.0, 0.0], 3, { projectPath: "projects/a" });
      assert.strictEqual(hitsC.length, 2);

      const hitsNone = store.search([1.0, 0.0], 3, { projectPath: "projects/nonexistent" });
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

      store.save(session, { summary: [1.0, 0.0], chunks: new Map([[1, [1, 0]]]) });

      // Save again with same session id, same chunk index but different text
      const session2: SessionData = {
        ...session,
        chunks: [
          { stepIndex: 1, text: "Duplicate chunk" }
        ]
      };
      
      store.save(session2, { summary: [1.0, 0.0], chunks: new Map([[1, [1, 0]]]) });

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
        chunks: new Map([[0, [1.0, 0.0]]])
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
        chunks: new Map([[1, [0.0, 1.0]]])
      });

      const res = store.query({ sessionId: "session-inc", includeSteps: true });
      assert.strictEqual(res.chunks.length, 2);
      assert.strictEqual(res.steps.length, 2);
      
      // Verify first chunk vector is preserved (i.e. not empty)
      const searchRes = store.search([1.0, 0.0], 5);
      assert.strictEqual(searchRes.length, 2);
      // The first chunk should match query [1.0, 0.0] with 1.0 similarity
      const hit0 = searchRes.find(h => h.stepIndex === 0);
      assert.ok(hit0);
      assert.ok(Math.abs(hit0.similarity - 1.0) < 0.01);

      // The second chunk should match query [0.0, 1.0] with 1.0 similarity
      const searchRes2 = store.search([0.0, 1.0], 5);
      const hit1 = searchRes2.find(h => h.stepIndex === 1);
      assert.ok(hit1);
      assert.ok(Math.abs(hit1.similarity - 1.0) < 0.01);

      store.close();
    });
  });
}

runTestSuite("InMemoryHistoryStore", () => new InMemoryHistoryStore());
runTestSuite("SqliteHistoryStore", () => new SqliteHistoryStore(":memory:"));
