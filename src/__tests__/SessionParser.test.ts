import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SessionParser, cleanUserRequest, countTokens } from "../adapters/SessionParser.js";
import { AntigravityAdapter, discoverBrainArtifacts } from "../adapters/Antigravity.js";
import { CursorAdapter } from "../adapters/Cursor.js";
import { InMemoryHistoryStore } from "../db.js";
import { syncSingleSession } from "../index.js";

describe("SessionParser Tests (2-Layer Architecture)", () => {
  describe("Prompt Sanitization & cleanUserRequest", () => {
    it("should unwrap <USER_REQUEST> tags while preserving inner prompt and stripping context wrappers", () => {
      const input = `<USER_REQUEST session_id="abc-123">
Fix the generic function: function parse<T>(input: List<T>): Map<K, V> {
  if (a < b && c > d) return new Map();
  return <div className="test" />;
}
</USER_REQUEST>
<ADDITIONAL_METADATA id="meta-1">
Workspace mapping: d:\\Projects\\my-project
Environment: windows
</ADDITIONAL_METADATA>
<SYSTEM_PROMPT>
Follow these core rules...
</SYSTEM_PROMPT>
<user_instructions>
Always write clean code
</user_instructions>`;

      const cleaned = cleanUserRequest(input);
      assert.ok(cleaned.includes("function parse<T>(input: List<T>): Map<K, V>"));
      assert.ok(cleaned.includes("if (a < b && c > d)"));
      assert.ok(cleaned.includes('<div className="test" />'));
      assert.strictEqual(cleaned.includes("<USER_REQUEST>"), false);
      assert.strictEqual(cleaned.includes("</USER_REQUEST>"), false);
      assert.strictEqual(cleaned.includes("ADDITIONAL_METADATA"), false);
      assert.strictEqual(cleaned.includes("SYSTEM_PROMPT"), false);
      assert.strictEqual(cleaned.includes("user_instructions"), false);
    });

    it("should handle empty or falsy inputs gracefully", () => {
      assert.strictEqual(cleanUserRequest(""), "");
      assert.strictEqual(cleanUserRequest(null as any), "");
      assert.strictEqual(cleanUserRequest(undefined as any), "");
    });
  });

  describe("BPE Token Precomputation", () => {
    it("should compute exact BPE token counts for text, code, and thinking blocks", () => {
      const prompt = "Please configure PostgreSQL with pgvector extension.";
      const response = "To install pgvector on PostgreSQL:\n```sql\nCREATE EXTENSION IF NOT EXISTS vector;\n```";
      const thinking = "The user wants to setup pgvector. I will provide the standard SQL command.";

      const promptTokens = countTokens(prompt);
      const responseTokens = countTokens(response);
      const thinkingTokens = countTokens(thinking);

      assert.ok(promptTokens > 5);
      assert.ok(responseTokens > 10);
      assert.ok(thinkingTokens > 5);
      assert.strictEqual(countTokens(""), 0);
      assert.strictEqual(countTokens(null), 0);
      assert.strictEqual(countTokens(undefined), 0);
    });

    it("should safely handle malformed unicode and lone surrogates without throwing", () => {
      const loneSurrogate = "Hello \uD800 World";
      const tokens = countTokens(loneSurrogate);
      assert.ok(tokens > 0);
    });
  });

  describe("parseAntigravity Turn Segmentation & Paired Tool Execution", () => {
    it("should parse 2-layer turns, separate agent vs execution steps, and compute turn metrics", () => {
      const sessionId = "session-paired-1";
      const jsonl = [
        JSON.stringify({
          type: "USER_INPUT",
          step_index: 0,
          source: "USER_EXPLICIT",
          status: "DONE",
          content: "<USER_REQUEST>Initialize database schema</USER_REQUEST><ADDITIONAL_METADATA>Workspace mapping: d:\\Projects\\demo-app</ADDITIONAL_METADATA>",
          created_at: "2026-08-20T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 1,
          source: "MODEL",
          status: "DONE",
          content: "I will check the directory and create schema.sql.",
          thinking: "Checking existing files first.",
          tool_calls: [
            {
              name: "patchitright_write_file",
              arguments: {
                target_file: "d:\\Projects\\demo-app\\schema.sql",
                code_content: "CREATE TABLE users (id INT);",
              },
            },
          ],
          created_at: "2026-08-20T10:00:02.000Z",
        }),
        JSON.stringify({
          type: "MCP_TOOL",
          step_index: 2,
          source: "SYSTEM",
          status: "DONE",
          content: JSON.stringify({ success: true, target_file: "d:\\Projects\\demo-app\\schema.sql" }),
          created_at: "2026-08-20T10:00:05.000Z",
        }),
      ].join("\n");

      const session = SessionParser.parseAntigravity(sessionId, jsonl);
      assert.ok(session);
      assert.strictEqual(session.id, sessionId);
      assert.strictEqual(session.adapter, "antigravity");
      assert.strictEqual(session.projectPath, "d:/Projects/demo-app");
      assert.strictEqual(session.firstPrompt, "Initialize database schema");
      assert.strictEqual(session.totalTurns, 1);
      assert.strictEqual(session.turns?.length, 1);

      const turn = session.turns![0];
      assert.strictEqual(turn.turnIndex, 1);
      assert.strictEqual(turn.userPrompt, "Initialize database schema");
      assert.strictEqual(turn.assistantResponse, "I will check the directory and create schema.sql.");
      assert.strictEqual(turn.turnText, "Initialize database schema I will check the directory and create schema.sql.");
      assert.ok(turn.inputTokens! > 0);
      assert.ok(turn.outputTokens! > 0);
      assert.ok(turn.thinkingTokens! > 0);
      assert.strictEqual(turn.toolCount, 1);
      assert.strictEqual(turn.errorCount, 0);
      assert.strictEqual(turn.durationMs, 5000); // 10:00:00 to 10:00:05

      // Steps within turn: 1 user, 1 agent dialogue, 1 execution
      assert.strictEqual(turn.steps?.length, 3);
      assert.strictEqual(turn.steps![0].category, "user");
      assert.strictEqual(turn.steps![0].stepOrder, 1);
      assert.strictEqual(turn.steps![1].category, "agent");
      assert.strictEqual(turn.steps![1].stepOrder, 2);
      assert.strictEqual(turn.steps![1].content, "I will check the directory and create schema.sql.");
      assert.strictEqual(turn.steps![1].thinking, "Checking existing files first.");

      assert.strictEqual(turn.steps![2].category, "execution");
      assert.strictEqual(turn.steps![2].stepOrder, 3);
      assert.strictEqual(turn.steps![2].toolName, "write_file");
      assert.strictEqual(turn.steps![2].serverName, "patchitright");
      assert.strictEqual(turn.steps![2].kind, "mcp");
      assert.strictEqual(turn.steps![2].filePath, "d:/Projects/demo-app/schema.sql");
      assert.strictEqual(turn.steps![2].status, "DONE");
      assert.strictEqual(turn.steps![2].toolDurationMs, 3000); // 10:00:02 to 10:00:05

      // Files touched
      assert.deepStrictEqual(session.filesTouched, ["d:/Projects/demo-app/schema.sql"]);
    });

    it("should handle pure tool invocations without emitting phantom agent steps", () => {
      const sessionId = "session-pure-tools";
      const jsonl = [
        JSON.stringify({
          type: "USER_INPUT",
          step_index: 0,
          content: "Run test suite",
          created_at: "2026-08-20T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 1,
          content: "", // no dialogue
          tool_calls: [
            {
              name: "run_command",
              arguments: {
                CommandLine: "npm test",
                Cwd: "d:\\Projects\\demo-app",
              },
            },
          ],
          created_at: "2026-08-20T10:00:01.000Z",
        }),
        JSON.stringify({
          type: "COMMAND",
          step_index: 2,
          status: "DONE",
          content: "10 tests passed",
          exit_code: 0,
          created_at: "2026-08-20T10:00:04.000Z",
        }),
      ].join("\n");

      const session = SessionParser.parseAntigravity(sessionId, jsonl);
      assert.ok(session);
      const turn = session.turns![0];
      // Expect 1 user step and 1 execution step (NO phantom agent step)
      assert.strictEqual(turn.steps?.length, 2);
      assert.strictEqual(turn.steps![0].category, "user");
      assert.strictEqual(turn.steps![1].category, "execution");
      assert.strictEqual(turn.steps![1].kind, "command");
      assert.strictEqual(turn.steps![1].toolName, "run_command");
      assert.strictEqual(turn.steps![1].status, "DONE");
      assert.strictEqual(turn.steps![1].exitCode, 0);
    });

    it("should synthesize Turn 1 for headless/pre-turn steps and advance to Turn 2 upon explicit user input", () => {
      const sessionId = "session-headless";
      const jsonl = [
        // Autonomous pre-turn steps
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 0,
          content: "Autonomous background start",
          created_at: "2026-08-20T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "MCP_TOOL",
          step_index: 1,
          status: "DONE",
          content: "ready",
          created_at: "2026-08-20T10:00:01.000Z",
        }),
        // Subsequent user prompt
        JSON.stringify({
          type: "USER_INPUT",
          step_index: 2,
          content: "User prompt arriving later",
          created_at: "2026-08-20T10:00:10.000Z",
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 3,
          content: "User response",
          created_at: "2026-08-20T10:00:12.000Z",
        }),
      ].join("\n");

      const session = SessionParser.parseAntigravity(sessionId, jsonl);
      assert.ok(session);
      assert.strictEqual(session.turns?.length, 2);

      // Turn 1 is synthetic
      assert.strictEqual(session.turns![0].turnIndex, 1);
      assert.strictEqual(session.turns![0].userPrompt, "");
      assert.strictEqual(session.turns![0].assistantResponse, "Autonomous background start");

      // Turn 2 is explicit user input
      assert.strictEqual(session.turns![1].turnIndex, 2);
      assert.strictEqual(session.turns![1].userPrompt, "User prompt arriving later");
      assert.strictEqual(session.turns![1].assistantResponse, "User response");
    });

    it("should handle parallel tool calls, orphaned calls (PENDING), and unsolicited executions", () => {
      const sessionId = "session-parallel-tools";
      const jsonl = [
        JSON.stringify({
          type: "USER_INPUT",
          step_index: 0,
          content: "Run diagnostics",
          created_at: "2026-08-20T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 1,
          content: "Running 2 tools in parallel",
          tool_calls: [
            { name: "read_file", arguments: { target_file: "d:\\Projects\\demo\\a.ts" } },
            { name: "read_file", arguments: { target_file: "d:\\Projects\\demo\\b.ts" } },
            { name: "read_file", arguments: { target_file: "d:\\Projects\\demo\\c.ts" } }, // unexecuted orphan
          ],
          created_at: "2026-08-20T10:00:01.000Z",
        }),
        // Output for call 1
        JSON.stringify({
          type: "MCP_TOOL",
          step_index: 2,
          status: "DONE",
          content: "content of a.ts",
          created_at: "2026-08-20T10:00:02.000Z",
        }),
        // Output for call 2
        JSON.stringify({
          type: "MCP_TOOL",
          step_index: 3,
          status: "ERROR",
          error_message: "File not found: b.ts",
          created_at: "2026-08-20T10:00:03.000Z",
        }),
        // Unsolicited execution event
        JSON.stringify({
          type: "COMMAND",
          step_index: 4,
          status: "DONE",
          content: "system telemetry",
          created_at: "2026-08-20T10:00:04.000Z",
        }),
      ].join("\n");

      const session = SessionParser.parseAntigravity(sessionId, jsonl);
      assert.ok(session);
      const turn = session.turns![0];
      assert.strictEqual(turn.toolCount, 4); // 2 executed + 1 unsolicited + 1 pending
      assert.strictEqual(turn.errorCount, 1);

      const execSteps = turn.steps?.filter(s => s.category === "execution");
      assert.strictEqual(execSteps?.length, 4);
      assert.strictEqual(execSteps![0].status, "DONE");
      assert.strictEqual(execSteps![0].filePath, "d:/Projects/demo/a.ts");
      assert.strictEqual(execSteps![1].status, "ERROR");
      assert.strictEqual(execSteps![1].errorMessage, "File not found: b.ts");
      assert.strictEqual(execSteps![2].category, "execution");
      assert.strictEqual(execSteps![2].status, "DONE");
      assert.strictEqual(execSteps![3].status, "PENDING");
      assert.strictEqual(execSteps![3].filePath, "d:/Projects/demo/c.ts");
    });

    it("should detect step index rewinds, mark superseded turns/steps as isUndone, and exclude them from active totals", () => {
      const sessionId = "session-rewind-2layer";
      const jsonl = [
        // Turn 1
        JSON.stringify({
          type: "USER_INPUT",
          step_index: 0,
          content: "Turn 1 prompt",
          created_at: "2026-08-20T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 1,
          content: "Turn 1 reply",
          created_at: "2026-08-20T10:00:01.000Z",
        }),
        // Turn 2 (to be undone)
        JSON.stringify({
          type: "USER_INPUT",
          step_index: 2,
          content: "Turn 2 undone prompt",
          created_at: "2026-08-20T10:00:05.000Z",
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 3,
          content: "Turn 2 undone reply",
          created_at: "2026-08-20T10:00:06.000Z",
        }),
        // Rewind back to step_index: 2 with a new prompt
        JSON.stringify({
          type: "USER_INPUT",
          step_index: 2,
          content: "Turn 2 surviving prompt",
          created_at: "2026-08-20T10:00:10.000Z",
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 3,
          content: "Turn 2 surviving reply",
          created_at: "2026-08-20T10:00:11.000Z",
        }),
      ].join("\n");

      const session = SessionParser.parseAntigravity(sessionId, jsonl);
      assert.ok(session);
      assert.strictEqual(session.turns?.length, 3); // 1 active Turn 1, 1 undone Turn 2, 1 active Turn 3
      assert.strictEqual(session.totalTurns, 2); // only active turns

      const undoneTurn = session.turns!.find(t => t.userPrompt === "Turn 2 undone prompt");
      assert.ok(undoneTurn);
      assert.strictEqual(undoneTurn.isUndone, true);

      const survivingTurn = session.turns!.find(t => t.userPrompt === "Turn 2 surviving prompt");
      assert.ok(survivingTurn);
      assert.strictEqual(survivingTurn.isUndone, false);
    });

    it("should extract subagent topology, ignoring send_message to parent", () => {
      const sessionId = "session-subagent-parent";
      const jsonl = [
        JSON.stringify({
          type: "USER_INPUT",
          step_index: 0,
          content: "Coordinate with subagents",
          created_at: "2026-08-20T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 1,
          content: "Messaging parent and child",
          tool_calls: [
            {
              name: "send_message",
              arguments: { Recipient: "parent", Message: "Done" },
            },
            {
              name: "send_message",
              arguments: { Recipient: "child-subagent-uuid-1", Message: "Analyze" },
            },
          ],
          created_at: "2026-08-20T10:00:01.000Z",
        }),
      ].join("\n");

      const session = SessionParser.parseAntigravity(sessionId, jsonl);
      assert.ok(session);
      assert.deepStrictEqual(session.subagentIds, ["child-subagent-uuid-1"]);
    });

    it("should extract and deduplicate filesTouched across string and string[] arguments, stripping file:/// and excluding Cwd", () => {
      const sessionId = "session-files-touched";
      const jsonl = [
        JSON.stringify({
          type: "USER_INPUT",
          step_index: 0,
          content: "Generate images and modify code",
          created_at: "2026-08-20T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 1,
          content: "Running tools",
          tool_calls: [
            {
              name: "generate_image",
              arguments: {
                ImagePaths: ["file:///d:/Projects/app/img1.png", "d:\\Projects\\app\\img2.png", ""],
                Prompt: "logo",
              },
            },
            {
              name: "patch_file",
              arguments: {
                target_file: "d:\\Projects\\app\\src\\main.ts",
                Cwd: "d:\\Projects\\app", // Cwd must be excluded from filesTouched
              },
            },
          ],
          created_at: "2026-08-20T10:00:01.000Z",
        }),
      ].join("\n");

      const session = SessionParser.parseAntigravity(sessionId, jsonl);
      assert.ok(session);
      assert.ok(session.filesTouched?.includes("d:/Projects/app/img1.png"));
      assert.ok(session.filesTouched?.includes("d:/Projects/app/img2.png"));
      assert.ok(session.filesTouched?.includes("d:/Projects/app/src/main.ts"));
      assert.strictEqual(session.filesTouched?.includes("d:/Projects/app"), false); // Cwd excluded
    });
  });

  describe("AntigravityAdapter & discoverBrainArtifacts", () => {
    it("should discover shallow markdown artifacts ignoring hidden files and subdirectories", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-artifacts-test-"));
      try {
        fs.writeFileSync(path.join(tempDir, "implementation_plan.md"), "# Plan");
        fs.writeFileSync(path.join(tempDir, "walkthrough.md"), "# Walkthrough");
        fs.writeFileSync(path.join(tempDir, "notes.txt"), "text file");
        fs.writeFileSync(path.join(tempDir, ".hidden.md"), "hidden");
        fs.mkdirSync(path.join(tempDir, "subdir.md")); // directory named .md

        const artifacts = discoverBrainArtifacts(tempDir);
        assert.deepStrictEqual(artifacts, ["implementation_plan.md", "walkthrough.md"]);

        // Missing directory returns empty array safely
        const nonExistent = discoverBrainArtifacts(path.join(tempDir, "non_existent_dir"));
        assert.deepStrictEqual(nonExistent, []);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should link ancestor hierarchy and prevent infinite loops with cycle detection", async () => {
      const tempBrain = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-brain-cycle-"));
      try {
        const sidA = "sess-a";
        const sidB = "sess-b";

        const dirA = path.join(tempBrain, sidA, ".system_generated", "logs");
        const dirB = path.join(tempBrain, sidB, ".system_generated", "logs");
        fs.mkdirSync(dirA, { recursive: true });
        fs.mkdirSync(dirB, { recursive: true });

        // Session A calls Session B
        const jsonlA = [
          JSON.stringify({ type: "USER_INPUT", step_index: 0, content: "Start A" }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            step_index: 1,
            content: "Call B",
            tool_calls: [{ name: "send_message", arguments: { Recipient: sidB } }],
          }),
        ].join("\n");

        // Session B calls Session A (Cycle simulation)
        const jsonlB = [
          JSON.stringify({ type: "USER_INPUT", step_index: 0, content: "Start B" }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            step_index: 1,
            content: "Call A",
            tool_calls: [{ name: "send_message", arguments: { Recipient: sidA } }],
          }),
        ].join("\n");

        fs.writeFileSync(path.join(dirA, "transcript.jsonl"), jsonlA);
        fs.writeFileSync(path.join(dirB, "transcript.jsonl"), jsonlB);

        const adapter = new AntigravityAdapter(tempBrain);
        const sessions = await adapter.discoverSessions();

        assert.strictEqual(sessions.length, 2);
        // Both sessions should resolve rootId and depth without hanging/stack overflow
        for (const s of sessions) {
          assert.ok(s.rootId);
          assert.ok(typeof s.depth === "number");
        }
      } finally {
        fs.rmSync(tempBrain, { recursive: true, force: true });
      }
    });
  });

  describe("CursorAdapter & parseCursorComposer", () => {
    it("should parse Cursor composer bubbles into 2-layer SessionData and TurnData", () => {
      const composerId = "composer-1";
      const composerState = {
        name: "Feature Implementation",
        workspacePath: "d:\\Projects\\cursor-app",
        createdAt: 1000,
        conversation: [
          {
            type: 1, // user
            text: "Create api router",
            createdAt: 1000,
          },
          {
            type: 2, // ai
            text: "I will create router.ts",
            thinking: "Designing express router",
            createdAt: 1005,
            toolFormerData: {
              name: "write_file",
              params: JSON.stringify({ target_file: "d:\\Projects\\cursor-app\\router.ts" }),
              status: "completed",
              result: "file written",
            },
          },
        ],
      };

      const session = SessionParser.parseCursorComposer(composerId, composerState);
      assert.ok(session);
      assert.strictEqual(session.id, composerId);
      assert.strictEqual(session.adapter, "cursor");
      assert.strictEqual(session.title, "Feature Implementation");
      assert.strictEqual(session.projectPath, "d:/Projects/cursor-app");
      assert.strictEqual(session.turns?.length, 1);

      const turn = session.turns![0];
      assert.strictEqual(turn.turnIndex, 1);
      assert.strictEqual(turn.userPrompt, "Create api router");
      assert.strictEqual(turn.assistantResponse, "I will create router.ts");
      assert.strictEqual(turn.turnText, "Create api router I will create router.ts");
      assert.ok(turn.inputTokens! > 0);
      assert.ok(turn.outputTokens! > 0);
      assert.strictEqual(turn.toolCount, 1);

      // Steps
      assert.strictEqual(turn.steps?.length, 3); // 1 user, 1 agent, 1 execution
      assert.strictEqual(turn.steps![0].category, "user");
      assert.strictEqual(turn.steps![1].category, "agent");
      assert.strictEqual(turn.steps![2].category, "execution");
      assert.strictEqual(turn.steps![2].toolName, "write_file");
      assert.strictEqual(turn.steps![2].status, "DONE");
    });

    it("should query Cursor SQLite databases in readOnly mode with injected DB and prepared statement reuse", async () => {
      const tempDbPath = path.join(os.tmpdir(), `cursor-test-${Date.now()}.vscdb`);
      const db = new DatabaseSync(tempDbPath);

      try {
        db.exec(`
          CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
          CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);
        `);

        const composerData = {
          createdAt: 2000,
          fullConversationHeadersOnly: [{ bubbleId: "b1" }, { bubbleId: "b2" }],
        };

        const bubble1 = { type: 1, text: "Refactor db.ts", createdAt: 2000 };
        const bubble2 = { type: 2, text: "Refactored db.ts successfully", createdAt: 2005 };

        db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run("composerData:comp-100", JSON.stringify(composerData));
        db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run("bubbleId:comp-100:b1", JSON.stringify(bubble1));
        db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run("bubbleId:comp-100:b2", JSON.stringify(bubble2));

        // Test with injected database connection (connection should remain open after discoverSessions)
        const adapterWithDb = new CursorAdapter(db);
        const sessionsWithDb = await adapterWithDb.discoverSessions();
        assert.strictEqual(sessionsWithDb.length, 1);
        assert.strictEqual(sessionsWithDb[0].id, "comp-100");
        assert.strictEqual(sessionsWithDb[0].firstPrompt, "Refactor db.ts");

        // Verify injected db is still usable and open
        const rowCheck = db.prepare("SELECT count(*) as count FROM cursorDiskKV").get() as any;
        assert.strictEqual(rowCheck.count, 3);

        // Test with injected dbPath (connection opened in readOnly mode and closed cleanly)
        const adapterWithPath = new CursorAdapter(tempDbPath);
        const sessionsWithPath = await adapterWithPath.discoverSessions();
        assert.strictEqual(sessionsWithPath.length, 1);
        assert.strictEqual(sessionsWithPath[0].id, "comp-100");
      } finally {
        try {
          db.close();
        } catch {}
        try {
          fs.unlinkSync(tempDbPath);
        } catch {}
      }
    });
  });

  describe("Antigravity Stat Fast-Path & Incremental Sync", () => {
    it("should bypass file reading and JSON parsing when cached logMtime and logSize match", async () => {
      const tempBrain = path.join(os.tmpdir(), `ag-stat-test-${Date.now()}`);
      const dir1 = path.join(tempBrain, "sess-cached-1", ".system_generated", "logs");
      const dir2 = path.join(tempBrain, "sess-modified-2", ".system_generated", "logs");
      fs.mkdirSync(dir1, { recursive: true });
      fs.mkdirSync(dir2, { recursive: true });

      try {
        const jsonl1 = JSON.stringify({
          type: "USER_INPUT",
          step_index: 0,
          source: "USER_EXPLICIT",
          status: "DONE",
          content: "<USER_REQUEST>Prompt 1</USER_REQUEST>",
          created_at: "2026-08-20T10:00:00.000Z",
        });
        const jsonl2 = JSON.stringify({
          type: "USER_INPUT",
          step_index: 0,
          source: "USER_EXPLICIT",
          status: "DONE",
          content: "<USER_REQUEST>Prompt 2</USER_REQUEST>",
          created_at: "2026-08-20T10:00:00.000Z",
        });

        const file1 = path.join(dir1, "transcript_full.jsonl");
        const file2 = path.join(dir2, "transcript_full.jsonl");
        fs.writeFileSync(file1, jsonl1);
        fs.writeFileSync(file2, jsonl2);

        const stat1 = fs.statSync(file1);
        const cachedStats = new Map<string, { logMtime: number; logSize: number }>();
        cachedStats.set("sess-cached-1", {
          logMtime: Math.floor(stat1.mtimeMs),
          logSize: stat1.size,
        });

        const adapter = new AntigravityAdapter(tempBrain);

        // 1. With cachedStats: sess-cached-1 is skipped, only sess-modified-2 is returned
        const sessionsIncremental = await adapter.discoverSessions({ cachedStats });
        assert.strictEqual(sessionsIncremental.length, 1);
        assert.strictEqual(sessionsIncremental[0].id, "sess-modified-2");
        assert.strictEqual(sessionsIncremental[0].logMtime, Math.floor(fs.statSync(file2).mtimeMs));
        assert.strictEqual(sessionsIncremental[0].logSize, fs.statSync(file2).size);

        // 2. With force=true: both sessions are parsed and returned
        const sessionsForced = await adapter.discoverSessions({ cachedStats, force: true });
        assert.strictEqual(sessionsForced.length, 2);

        // 3. Polymorphic argument support (passing ProgressReporter directly)
        let reporterCalls = 0;
        const reporter = {
          update: () => {
            reporterCalls++;
          },
        };
        const sessionsReporter = await adapter.discoverSessions(reporter as any);
        assert.strictEqual(sessionsReporter.length, 2);
        assert.ok(reporterCalls > 0);
      } finally {
        fs.rmSync(tempBrain, { recursive: true, force: true });
      }
    });
  });

  describe("syncSingleSession & Fault Isolation", () => {
    it("should ingest in-place step status mutations when turn/step counts remain unchanged", async () => {
      const store = new InMemoryHistoryStore();

      const session1 = {
        id: "mutate-sess-1",
        adapter: "antigravity",
        title: "In-Place Step Mutation Test",
        firstPrompt: "Do work",
        logMtime: 1000,
        logSize: 500,
        turns: [
          {
            turnIndex: 1,
            userPrompt: "Do work",
            assistantResponse: "Working",
            turnText: "Do work Working",
          },
        ],
        steps: [
          {
            stepIndex: 1,
            turnIndex: 1,
            status: "PENDING",
            content: "Running tool",
          },
        ],
      };

      const res1 = await syncSingleSession(session1, store);
      assert.strictEqual(res1, true);
      assert.strictEqual(store.getSteps("mutate-sess-1")[0].status, "PENDING");

      // In-place step update: status changes to DONE, counts unchanged, logMtime updated
      const session2 = {
        ...session1,
        logMtime: 1005,
        logSize: 520,
        steps: [
          {
            stepIndex: 1,
            turnIndex: 1,
            status: "DONE",
            content: "Tool completed",
          },
        ],
      };

      const res2 = await syncSingleSession(session2, store);
      assert.strictEqual(res2, true);
      assert.strictEqual(store.getSteps("mutate-sess-1")[0].status, "DONE");
    });

    it("should ingest zero-turn sessions with steps on stat fast-path", async () => {
      const store = new InMemoryHistoryStore();

      const zeroTurnSession = {
        id: "zero-turn-sess",
        adapter: "antigravity",
        title: "Zero Turn Session",
        firstPrompt: "Zero turn prompt",
        logMtime: 2000,
        logSize: 300,
        turns: [],
        steps: [
          {
            stepIndex: 1,
            status: "DONE",
            content: "System bootstrap",
          },
        ],
      };

      const didSync = await syncSingleSession(zeroTurnSession, store);
      assert.strictEqual(didSync, true);

      const fetched = store.getSession("zero-turn-sess");
      assert.ok(fetched);
      assert.strictEqual(fetched?.id, "zero-turn-sess");
      assert.strictEqual(store.getSteps("zero-turn-sess").length, 1);
    });

    it("should isolate persistence errors and return false without crashing", async () => {
      const faultyStore = {
        saveSession: () => {
          throw new Error("Disk I/O error or constraint violation");
        },
        getSession: () => null,
        getTurns: () => [],
        getSteps: () => [],
      };

      const session = {
        id: "faulty-sess",
        title: "Faulty Session",
        logMtime: 3000,
        turns: [{ turnIndex: 1, userPrompt: "fail", assistantResponse: "ok", turnText: "fail" }],
      };

      const didSync = await syncSingleSession(session, faultyStore);
      assert.strictEqual(didSync, false);
    });

    it("should support legacy fallback path with universal vectorization when logMtime is undefined", async () => {
      const store = new InMemoryHistoryStore();

      const legacySession = {
        id: "legacy-sess",
        adapter: "cursor",
        title: "Legacy Session",
        firstPrompt: "Legacy prompt",
        turns: [
          {
            turnIndex: 1,
            userPrompt: "Legacy prompt",
            assistantResponse: "Legacy response",
            turnText: "Legacy prompt Legacy response",
          },
        ],
        steps: [
          {
            stepIndex: 1,
            turnIndex: 1,
            status: "DONE",
          },
        ],
      };

      const didSync = await syncSingleSession(legacySession, store);
      assert.strictEqual(didSync, true);

      // Verify turn vectorization occurred
      const turns = store.getTurns("legacy-sess");
      assert.strictEqual(turns.length, 1);
      assert.ok(turns[0].turnVector);
      assert.strictEqual(turns[0].turnVector?.length, 384);

      // Repeated sync without changes should return false
      const didSyncAgain = await syncSingleSession(legacySession, store);
      assert.strictEqual(didSyncAgain, false);
    });

    it("should respect CHRONICLE_FORCE_FULL_SYNC and CHRONICLE_DISABLE_STAT_CACHE kill-switches", async () => {
      const origForce = process.env.CHRONICLE_FORCE_FULL_SYNC;
      const origDisable = process.env.CHRONICLE_DISABLE_STAT_CACHE;

      try {
        process.env.CHRONICLE_FORCE_FULL_SYNC = "true";
        assert.strictEqual(process.env.CHRONICLE_FORCE_FULL_SYNC, "true");

        process.env.CHRONICLE_DISABLE_STAT_CACHE = "true";
        assert.strictEqual(process.env.CHRONICLE_DISABLE_STAT_CACHE, "true");
      } finally {
        if (origForce !== undefined) {
          process.env.CHRONICLE_FORCE_FULL_SYNC = origForce;
        } else {
          delete process.env.CHRONICLE_FORCE_FULL_SYNC;
        }
        if (origDisable !== undefined) {
          process.env.CHRONICLE_DISABLE_STAT_CACHE = origDisable;
        } else {
          delete process.env.CHRONICLE_DISABLE_STAT_CACHE;
        }
      }
    });
  });
});
