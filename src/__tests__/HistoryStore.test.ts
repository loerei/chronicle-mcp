import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  InMemoryHistoryStore,
  SqliteHistoryStore,
  HistoryStore,
} from "../db.js";
import {
  SessionData,
  TurnData,
  StepData,
} from "../adapters/types.js";
import {
  vectorToBlob,
  blobToVector,
  cosineSimilarityFloat32,
  EMBEDDING_DIMENSION,
} from "../embeddings.js";

function createDenseVector(fillValue: number): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIMENSION);
  vec.fill(fillValue);
  // Normalize vector to have unit length for predictable cosine math
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
      vec[i] /= norm;
    }
  }
  return vec;
}

function runTestSuite(name: string, storeFactory: () => HistoryStore) {
  describe(`2-Layer HistoryStore - ${name}`, () => {
    it("should save and retrieve a session with 2-layer turns and execution steps", () => {
      const store = storeFactory();

      const session: SessionData = {
        id: "session-1",
        adapter: "antigravity",
        title: "Test Session 1",
        role: "Codebase Architect",
        projectPath: "d:/projects/test-project",
        createdAt: 1700000000000,
        lastActiveAt: 1700000005000,
        firstPrompt: "Implement feature X",
        artifacts: ["brain/test/plan.md"],
        filesTouched: ["src/index.ts", "src/db.ts"],
        metadata: { agentModel: "gemini-pro" },
      };

      const vec1 = createDenseVector(1.0);
      const vec2 = createDenseVector(0.5);

      const turns: TurnData[] = [
        {
          turnIndex: 1,
          userPrompt: "Implement feature X",
          assistantResponse: "I will implement feature X now.",
          turnSummary: "Feature X initiation",
          turnText: "Implement feature X I will implement feature X now.",
          turnVector: vec1,
          inputTokens: 100,
          outputTokens: 50,
          thinkingTokens: 20,
          toolCount: 1,
          errorCount: 0,
          durationMs: 1500,
          isUndone: false,
          createdAt: 1700000001000,
        },
        {
          turnIndex: 2,
          userPrompt: "Run test suite",
          assistantResponse: "Tests failed with syntax error.",
          turnSummary: "Test run with error",
          turnText: "Run test suite Tests failed with syntax error.",
          turnVector: vec2,
          inputTokens: 150,
          outputTokens: 80,
          thinkingTokens: 30,
          toolCount: 1,
          errorCount: 1,
          durationMs: 2000,
          isUndone: false,
          createdAt: 1700000004000,
        },
      ];

      const steps: StepData[] = [
        {
          stepIndex: 1,
          turnIndex: 1,
          stepOrder: 1,
          category: "user",
          status: "DONE",
          content: "Implement feature X",
          createdAt: 1700000001000,
        },
        {
          stepIndex: 2,
          turnIndex: 1,
          stepOrder: 2,
          category: "execution",
          kind: "mcp",
          status: "DONE",
          toolName: "write_file",
          serverName: "patchitright",
          filePath: "src/index.ts",
          toolArgs: JSON.stringify({ target_file: "src/index.ts" }),
          toolResult: JSON.stringify({ success: true }),
          toolDurationMs: 350,
          createdAt: 1700000002000,
        },
        {
          stepIndex: 3,
          turnIndex: 2,
          stepOrder: 1,
          category: "execution",
          kind: "command",
          status: "ERROR",
          toolName: "run_command",
          exitCode: 1,
          errorMessage: "Process exited with code 1",
          toolDurationMs: 1200,
          createdAt: 1700000004000,
        },
      ];

      store.saveSession(session, turns, steps);

      // Verify getSession
      const fetched = store.getSession("session-1");
      assert.ok(fetched);
      assert.strictEqual(fetched?.id, "session-1");
      assert.strictEqual(fetched?.title, "Test Session 1");
      assert.strictEqual(fetched?.role, "Codebase Architect");
      assert.strictEqual(fetched?.firstPrompt, "Implement feature X");
      assert.deepStrictEqual(fetched?.artifacts, ["brain/test/plan.md"]);
      assert.deepStrictEqual(fetched?.filesTouched, ["src/index.ts", "src/db.ts"]);
      assert.strictEqual(fetched?.metadata?.agentModel, "gemini-pro");

      // Verify turns
      const fetchedTurns = store.getTurns("session-1");
      assert.strictEqual(fetchedTurns.length, 2);
      assert.strictEqual(fetchedTurns[0].turnIndex, 1);
      assert.strictEqual(fetchedTurns[0].userPrompt, "Implement feature X");
      assert.strictEqual(fetchedTurns[0].inputTokens, 100);
      assert.strictEqual(fetchedTurns[0].toolCount, 1);
      assert.strictEqual(fetchedTurns[1].turnIndex, 2);
      assert.strictEqual(fetchedTurns[1].errorCount, 1);

      // Verify steps
      const fetchedSteps = store.getSteps("session-1");
      assert.strictEqual(fetchedSteps.length, 3);
      assert.strictEqual(fetchedSteps[1].toolName, "write_file");
      assert.strictEqual(fetchedSteps[1].serverName, "patchitright");
      assert.strictEqual(fetchedSteps[1].filePath, "src/index.ts");
      assert.strictEqual(fetchedSteps[2].kind, "command");
      assert.strictEqual(fetchedSteps[2].status, "ERROR");
      assert.strictEqual(fetchedSteps[2].exitCode, 1);

      store.close();
    });

    it("should resolve negative turn indices, lastTurns, and filter active timeline", () => {
      const store = storeFactory();

      const session: SessionData = {
        id: "session-offsets",
        adapter: "antigravity",
        title: "Offset Test",
        createdAt: 1000,
        firstPrompt: "init",
      };

      const turns: TurnData[] = [
        { turnIndex: 1, userPrompt: "Prompt 1", assistantResponse: "Resp 1", turnText: "T1", isUndone: false, createdAt: 1000 },
        { turnIndex: 2, userPrompt: "Prompt 2 (undone)", assistantResponse: "Resp 2", turnText: "T2", isUndone: true, createdAt: 2000 },
        { turnIndex: 2, userPrompt: "Prompt 2 (active)", assistantResponse: "Resp 2", turnText: "T2", isUndone: false, createdAt: 3000 },
        { turnIndex: 3, userPrompt: "Prompt 3", assistantResponse: "Resp 3", turnText: "T3", isUndone: false, createdAt: 4000 },
        { turnIndex: 4, userPrompt: "Prompt 4", assistantResponse: "Resp 4", turnText: "T4", isUndone: false, createdAt: 5000 },
      ];

      store.saveSession(session, turns);

      // 1. Negative index: turnIndex = -1 should resolve to latest active turn (4)
      const lastTurn = store.getTurns("session-offsets", { turnIndex: -1 });
      assert.strictEqual(lastTurn.length, 1);
      assert.strictEqual(lastTurn[0].turnIndex, 4);
      assert.strictEqual(lastTurn[0].userPrompt, "Prompt 4");

      // 2. Negative index: turnIndex = -2 should resolve to turn 3
      const secondLastTurn = store.getTurns("session-offsets", { turnIndex: -2 });
      assert.strictEqual(secondLastTurn.length, 1);
      assert.strictEqual(secondLastTurn[0].turnIndex, 3);

      // 3. lastTurns: 2 should return turns 3 and 4 in chronological order
      const last2 = store.getTurns("session-offsets", { lastTurns: 2 });
      assert.strictEqual(last2.length, 2);
      assert.strictEqual(last2[0].turnIndex, 3);
      assert.strictEqual(last2[1].turnIndex, 4);

      // 4. Undone filtering: default should exclude undone turns
      const allActive = store.getTurns("session-offsets");
      assert.strictEqual(allActive.length, 4); // 1, 2(active), 3, 4

      // 5. includeUndone: true should include the undone turn
      const withUndone = store.getTurns("session-offsets", { includeUndone: true });
      assert.ok(withUndone.some((t) => t.isUndone));

      store.close();
    });

    it("should perform zero-copy Float32Array BLOB vector search with cosine ranking", () => {
      const store = storeFactory();

      const vecTarget = createDenseVector(1.0);
      const vecSimilar = createDenseVector(0.9);
      const vecOpposite = createDenseVector(-1.0);

      const session1: SessionData = {
        id: "sess-v1",
        adapter: "antigravity",
        title: "Vector Session 1",
        projectPath: "d:/projects/app-a",
        createdAt: 1000,
        firstPrompt: "Target topic",
      };

      const session2: SessionData = {
        id: "sess-v2",
        adapter: "antigravity",
        title: "Vector Session 2",
        projectPath: "d:/projects/app-b",
        createdAt: 2000,
        firstPrompt: "Opposite topic",
      };

      const turns1: TurnData[] = [
        {
          turnIndex: 1,
          userPrompt: "Find database configuration",
          assistantResponse: "Here is the SQLite config.",
          turnText: "Find database configuration SQLite config",
          turnVector: vecSimilar,
          createdAt: 1000,
        },
      ];

      const turns2: TurnData[] = [
        {
          turnIndex: 1,
          userPrompt: "Completely unrelated graphics topic",
          assistantResponse: "Render shaders on GPU.",
          turnText: "Completely unrelated graphics topic shaders GPU",
          turnVector: vecOpposite,
          createdAt: 2000,
        },
      ];

      store.saveSession(session1, turns1);
      store.saveSession(session2, turns2);

      // Query vector with vecTarget
      const results = store.searchTurnsVector(vecTarget, 5);
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].sessionId, "sess-v1");
      assert.strictEqual(results[0].turnIndex, 1);
      assert.ok(results[0].similarity > 0.95);

      assert.strictEqual(results[1].sessionId, "sess-v2");
      assert.ok(results[1].similarity < -0.9);

      // Search with projectPath constraint
      const scopedResults = store.searchTurnsVector(vecTarget, 5, {
        projectPath: "app-a",
      });
      assert.strictEqual(scopedResults.length, 1);
      assert.strictEqual(scopedResults[0].sessionId, "sess-v1");

      store.close();
    });

    it("should filter sessions by role, projectPath, hasErrors, and timeRange", () => {
      const store = storeFactory();

      const sessionA: SessionData = {
        id: "sess-a",
        adapter: "antigravity",
        title: "Architect Session",
        role: "Codebase Architect",
        projectPath: "d:/projects/project-alpha",
        createdAt: 1000,
        lastActiveAt: 2000,
        firstPrompt: "Architect prompt",
      };

      const sessionB: SessionData = {
        id: "sess-b",
        adapter: "antigravity",
        title: "Debugger Session",
        role: "Database Debugger",
        projectPath: "d:/projects/project-beta",
        createdAt: 3000,
        lastActiveAt: 4000,
        firstPrompt: "Debugger prompt",
      };

      const turnsA: TurnData[] = [
        { turnIndex: 1, userPrompt: "A1", assistantResponse: "R1", turnText: "T1", errorCount: 0, createdAt: 1000 },
      ];

      const turnsB: TurnData[] = [
        { turnIndex: 1, userPrompt: "B1", assistantResponse: "R2", turnText: "T2", errorCount: 2, createdAt: 3000 },
      ];

      store.saveSession(sessionA, turnsA);
      store.saveSession(sessionB, turnsB);

      // Filter by role
      const resRole = store.listSessions({ role: "Database Debugger" });
      assert.strictEqual(resRole.length, 1);
      assert.strictEqual(resRole[0].id, "sess-b");

      // Filter by projectPath
      const resProj = store.listSessions({ projectPath: "alpha" });
      assert.strictEqual(resProj.length, 1);
      assert.strictEqual(resProj[0].id, "sess-a");

      // Filter by hasErrors
      const resErrors = store.listSessions({ hasErrors: true });
      assert.strictEqual(resErrors.length, 1);
      assert.strictEqual(resErrors[0].id, "sess-b");

      // Filter by timeRange "2500:5000"
      const resTime = store.listSessions({ timeRange: "2500:5000" });
      assert.strictEqual(resTime.length, 1);
      assert.strictEqual(resTime[0].id, "sess-b");

      store.close();
    });

    it("should resolve recursive subagent relationships and ancestor/descendant hierarchies", () => {
      const store = storeFactory();

      const root: SessionData = {
        id: "root-sess",
        adapter: "antigravity",
        title: "Root Orchestrator",
        role: "Lead Orchestrator",
        createdAt: 1000,
        firstPrompt: "Coordinate tickets 1 to 6",
      };

      const child1: SessionData = {
        id: "child-1",
        adapter: "antigravity",
        title: "Ticket 1 Worker",
        role: "Domain Engineer",
        parentId: "root-sess",
        rootId: "root-sess",
        depth: 1,
        createdAt: 2000,
        firstPrompt: "Implement types and binary vectors",
      };

      const child2: SessionData = {
        id: "child-2",
        adapter: "antigravity",
        title: "Ticket 2 Worker",
        role: "Database Engineer",
        parentId: "root-sess",
        rootId: "root-sess",
        depth: 1,
        createdAt: 2500,
        firstPrompt: "Implement SQLite 2-layer DDL",
      };

      const grandchild: SessionData = {
        id: "grandchild-1",
        adapter: "antigravity",
        title: "FTS5 Subagent",
        role: "FTS Specialist",
        parentId: "child-2",
        rootId: "root-sess",
        depth: 2,
        createdAt: 3000,
        firstPrompt: "Setup FTS5 triggers and ranking",
      };

      store.saveSession(root);
      store.saveSession(child1);
      store.saveSession(child2);
      store.saveSession(grandchild);

      // Query relationship for child2
      const relChild2 = store.getSessionRelationship("child-2");
      assert.ok(relChild2);
      assert.strictEqual(relChild2?.sessionId, "child-2");
      assert.strictEqual(relChild2?.parent?.id, "root-sess");
      assert.strictEqual(relChild2?.siblings.length, 1);
      assert.strictEqual(relChild2?.siblings[0].id, "child-1");
      assert.strictEqual(relChild2?.children.length, 1);
      assert.strictEqual(relChild2?.children[0].id, "grandchild-1");

      // Query relationship for grandchild
      const relGrand = store.getSessionRelationship("grandchild-1");
      assert.ok(relGrand);
      assert.strictEqual(relGrand?.parent?.id, "child-2");
      assert.strictEqual(relGrand?.ancestors.length, 2);
      assert.strictEqual(relGrand?.ancestors[0].id, "root-sess");
      assert.strictEqual(relGrand?.ancestors[1].id, "child-2");

      store.close();
    });

    it("should perform full-text BM25 search across user_prompt, assistant_response, and turn_text", () => {
      const store = storeFactory();

      const session: SessionData = {
        id: "sess-fts-1",
        adapter: "antigravity",
        title: "FTS Test Session",
        projectPath: "d:/projects/fts-app",
        createdAt: 1000,
        firstPrompt: "init",
      };

      const turns: TurnData[] = [
        {
          turnIndex: 1,
          userPrompt: "How to configure PostgreSQL connection pooling with pgbouncer?",
          assistantResponse: "Use transaction pooling mode with max_client_conn set appropriately.",
          turnText: "PostgreSQL connection pooling pgbouncer transaction pooling",
          createdAt: 1000,
        },
        {
          turnIndex: 2,
          userPrompt: "Now explain Redis cluster failover mechanics.",
          assistantResponse: "Redis Sentinel monitors nodes and promotes replicas via quorum voting.",
          turnText: "Redis cluster failover Sentinel quorum voting",
          createdAt: 2000,
        },
      ];

      store.saveSession(session, turns);

      // Search by keyword in user prompt: "pgbouncer"
      const resPgbouncer = store.searchTurnsFTS("pgbouncer", 5);
      assert.strictEqual(resPgbouncer.length, 1);
      assert.strictEqual(resPgbouncer[0].sessionId, "sess-fts-1");
      assert.strictEqual(resPgbouncer[0].turnIndex, 1);

      // Search by keyword in assistant response: "Sentinel"
      const resSentinel = store.searchTurnsFTS("Sentinel", 5);
      assert.strictEqual(resSentinel.length, 1);
      assert.strictEqual(resSentinel[0].sessionId, "sess-fts-1");
      assert.strictEqual(resSentinel[0].turnIndex, 2);

      // Search with projectPath constraint
      const resScoped = store.searchTurnsFTS("PostgreSQL", 5, { projectPath: "fts-app" });
      assert.strictEqual(resScoped.length, 1);

      const resMismatched = store.searchTurnsFTS("PostgreSQL", 5, { projectPath: "other-dir" });
      assert.strictEqual(resMismatched.length, 0);

      store.close();
    });

    it("should retrieve artifacts with and without recursive subtree aggregation", () => {
      const store = storeFactory();

      const root: SessionData = {
        id: "sess-root-art",
        adapter: "antigravity",
        title: "Root",
        createdAt: 1000,
        firstPrompt: "root prompt",
        artifacts: ["brain/root/prd.md"],
      };

      const child: SessionData = {
        id: "sess-child-art",
        adapter: "antigravity",
        title: "Child",
        parentId: "sess-root-art",
        createdAt: 2000,
        firstPrompt: "child prompt",
        artifacts: ["brain/child/plan.md", "brain/shared/notes.md"],
      };

      const grandchild: SessionData = {
        id: "sess-gc-art",
        adapter: "antigravity",
        title: "Grandchild",
        parentId: "sess-child-art",
        createdAt: 3000,
        firstPrompt: "grandchild prompt",
        artifacts: ["brain/grandchild/report.md", "brain/shared/notes.md"], // Contains duplicate
      };

      store.saveSession(root);
      store.saveSession(child);
      store.saveSession(grandchild);

      // 1. Direct artifacts only
      const rootDirect = store.getArtifacts("sess-root-art", false);
      assert.deepStrictEqual(rootDirect, ["brain/root/prd.md"]);

      // 2. Subtree artifacts (recursive, deduplicated)
      const rootSubtree = store.getArtifacts("sess-root-art", true);
      assert.strictEqual(rootSubtree.length, 4);
      assert.ok(rootSubtree.includes("brain/root/prd.md"));
      assert.ok(rootSubtree.includes("brain/child/plan.md"));
      assert.ok(rootSubtree.includes("brain/grandchild/report.md"));
      assert.ok(rootSubtree.includes("brain/shared/notes.md"));

      store.close();
    });

    it("should support transitional compatibility shims without throwing", () => {
      const store = storeFactory();

      const session: SessionData = {
        id: "sess-compat",
        adapter: "antigravity",
        title: "Compat Session",
        projectPath: "d:/projects/compat",
        createdAt: 1700000000000,
        firstPrompt: "init",
        secondPrompt: "",
        chunks: [
          { stepIndex: 0, text: "Chunk 0 text" },
          { stepIndex: 1, text: "Chunk 1 text" },
        ],
        steps: [
          {
            stepIndex: 0,
            type: "USER_INPUT",
            source: "USER_EXPLICIT",
            status: "DONE",
            content: "init",
          },
        ],
      };

      // Call legacy save
      store.save(session, {
        summary: [0.5, 0.5],
        chunks: new Map([
          [0, [1.0, 0.0]],
          [1, [0.0, 1.0]],
        ]),
      });

      // Call legacy query
      const queryRes = store.query({ sessionId: "sess-compat", includeSteps: true });
      assert.strictEqual(queryRes.sessions.length, 1);
      assert.strictEqual(queryRes.sessions[0].id, "sess-compat");
      assert.strictEqual(queryRes.steps.length, 1);

      // Call legacy search
      const searchRes = store.search([1.0, 0.0], 5);
      assert.ok(searchRes.length > 0);

      store.close();
    });
  });
}

// 1. Run test suite against InMemoryHistoryStore
runTestSuite("InMemoryHistoryStore", () => new InMemoryHistoryStore());

// 2. Run test suite against SqliteHistoryStore
const tempDbDir = path.join(os.tmpdir(), "chronicle-mcp-tests-" + Date.now());
if (!fs.existsSync(tempDbDir)) {
  fs.mkdirSync(tempDbDir, { recursive: true });
}

let dbCount = 0;
runTestSuite("SqliteHistoryStore", () => {
  const dbFile = path.join(tempDbDir, `test-${++dbCount}.db`);
  return new SqliteHistoryStore(dbFile);
});
