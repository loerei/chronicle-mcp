import { describe, it } from "node:test";
import assert from "node:assert";
import { SessionParser } from "../adapters/SessionParser.js";

describe("SessionParser Tests", () => {
  describe("parseAntigravity", () => {
    it("should parse valid Antigravity log content", () => {
      const sessionId = "session-1";
      const jsonl = [
        JSON.stringify({
          type: "USER_INPUT",
          step_index: 0,
          source: "USER_EXPLICIT",
          status: "DONE",
          content: "<USER_REQUEST>Setup the project</USER_REQUEST><ADDITIONAL_METADATA>Workspace mapping: d:\\Projects\\my-project</ADDITIONAL_METADATA>",
          created_at: "2026-06-14T12:00:00.000Z"
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 1,
          source: "MODEL",
          status: "DONE",
          content: "I have initialized the project.",
          created_at: "2026-06-14T12:00:05.000Z"
        })
      ].join("\n");

      const session = SessionParser.parseAntigravity(sessionId, jsonl);
      assert.ok(session);
      assert.strictEqual(session.id, sessionId);
      assert.strictEqual(session.adapter, "antigravity");
      assert.strictEqual(session.title, "Setup the project");
      assert.strictEqual(session.projectPath, "d:/Projects/my-project");
      assert.strictEqual(session.firstPrompt, "Setup the project");
      assert.strictEqual(session.chunks.length, 1);
      assert.strictEqual(
        session.chunks[0].text,
        "User: Setup the project\nAssistant: I have initialized the project."
      );
      assert.ok(session.steps);
      assert.strictEqual(session.steps.length, 2);
      assert.strictEqual(session.steps[0].content, "<USER_REQUEST>Setup the project</USER_REQUEST><ADDITIONAL_METADATA>Workspace mapping: d:\\Projects\\my-project</ADDITIONAL_METADATA>");
    });

    it("should extract projectPath from tool calls if not present in user input", () => {
      const sessionId = "session-tool-path";
      const jsonl = [
        JSON.stringify({
          type: "USER_INPUT",
          step_index: 0,
          content: "Run build",
          created_at: "2026-06-14T12:00:00.000Z"
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 1,
          content: "Running build...",
          tool_calls: [{
            name: "run_command",
            arguments: {
              CommandLine: "npm run build",
              Cwd: "d:\\Projects\\my-cool-project"
            }
          }]
        })
      ].join("\n");

      const session = SessionParser.parseAntigravity(sessionId, jsonl);
      assert.ok(session);
      assert.strictEqual(session.projectPath, "d:/Projects/my-cool-project");
    });

    it("should combine sequential PLANNER_RESPONSE steps and multiple turns into chunks", () => {
      const sessionId = "session-2";
      const jsonl = [
        JSON.stringify({
          type: "USER_INPUT",
          step_index: 0,
          content: "Turn 1 request",
          created_at: "2026-06-14T12:00:00.000Z"
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 1,
          content: "Turn 1 reply part 1"
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 2,
          content: "Turn 1 reply part 2"
        }),
        JSON.stringify({
          type: "USER_INPUT",
          step_index: 3,
          content: "Turn 2 request"
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 4,
          content: "Turn 2 reply"
        })
      ].join("\n");

      const session = SessionParser.parseAntigravity(sessionId, jsonl);
      assert.ok(session);
      assert.strictEqual(session.chunks.length, 2);
      assert.strictEqual(
        session.chunks[0].text,
        "User: Turn 1 request\nAssistant: Turn 1 reply part 1\nTurn 1 reply part 2"
      );
      assert.strictEqual(
        session.chunks[1].text,
        "User: Turn 2 request\nAssistant: Turn 2 reply"
      );
      assert.strictEqual(session.firstPrompt, "Turn 1 request");
      assert.strictEqual(session.secondPrompt, "Turn 2 request");
    });

    it("should clean user request XML tags and leftover html tags", () => {
      const sessionId = "session-3";
      const jsonl = JSON.stringify({
        type: "USER_INPUT",
        step_index: 0,
        content: "<USER_REQUEST>Do <b>bold</b> action</USER_REQUEST><ADDITIONAL_METADATA>ignore</ADDITIONAL_METADATA>",
        created_at: "2026-06-14T12:00:00.000Z"
      });

      const session = SessionParser.parseAntigravity(sessionId, jsonl);
      assert.ok(session);
      assert.strictEqual(session.firstPrompt, "Do bold action");
    });

    it("should extract subagent conversation IDs from steps of type INVOKE_SUBAGENT", () => {
      const sessionId = "session-4";
      const jsonl = [
        JSON.stringify({
          type: "USER_INPUT",
          step_index: 0,
          content: "Let's call some subagents",
          created_at: "2026-06-14T12:00:00.000Z"
        }),
        JSON.stringify({
          type: "INVOKE_SUBAGENT",
          step_index: 1,
          content: `Running subagent... details: { "conversationId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d" } and maybe another { "conversationId": "f9e8d7c6-b5a4-3f2e-1d0c-9b8a7f6e5d4c" }`,
          created_at: "2026-06-14T12:00:05.000Z"
        })
      ].join("\n");

      const session = SessionParser.parseAntigravity(sessionId, jsonl);
      assert.ok(session);
      assert.deepStrictEqual(session.subagentIds, [
        "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
        "f9e8d7c6-b5a4-3f2e-1d0c-9b8a7f6e5d4c"
      ]);
    });
  });

  describe("parseCursorComposer", () => {
    it("should parse valid Cursor composer state", () => {
      const composerId = "composer-1";
      const state = {
        createdAt: 1700000000000,
        name: "My Composer Title",
        workspacePath: "d:\\Projects\\another-project",
        conversation: [
          {
            type: "user",
            text: "Hello, can you help?"
          },
          {
            type: "ai",
            text: "Yes, sure!"
          }
        ]
      };

      const session = SessionParser.parseCursorComposer(composerId, state);
      assert.ok(session);
      assert.strictEqual(session.id, composerId);
      assert.strictEqual(session.adapter, "cursor");
      assert.strictEqual(session.title, "My Composer Title");
      assert.strictEqual(session.projectPath, "d:/Projects/another-project");
      assert.strictEqual(session.firstPrompt, "Hello, can you help?");
      assert.strictEqual(session.chunks.length, 1);
      assert.strictEqual(
        session.chunks[0].text,
        "User: Hello, can you help?\nAssistant: Yes, sure!"
      );
    });

    it("should use firstPrompt fallback for title if composer name is missing", () => {
      const composerId = "composer-2";
      const state = {
        conversation: [
          {
            sender: "user",
            text: "A very long prompt that goes on and on to test the character limit truncation feature of the title fallback."
          }
        ]
      };

      const session = SessionParser.parseCursorComposer(composerId, state);
      assert.ok(session);
      assert.strictEqual(session.title, "A very long prompt that goes on and on to test the...");
    });
  });
});
