import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeSnippet,
  formatSearchHistoryMarkdown,
  formatListSessionsMarkdown,
  formatToolUsageStatsMarkdown,
  projectFields,
} from "../presentation.js";
import type { SearchHistoryResult } from "../search.js";
import type { SessionData, ToolUsageReport } from "../adapters/types.js";

describe("Presentation Layer Tests", () => {
  describe("sanitizeSnippet", () => {
    it("returns empty string for null or empty inputs", () => {
      assert.equal(sanitizeSnippet(null), "");
      assert.equal(sanitizeSnippet(undefined), "");
      assert.equal(sanitizeSnippet(""), "");
    });

    it("collapses newlines, tabs, and multiple spaces into single spaces", () => {
      const multiline = "Line 1\r\n\tLine 2   \n\n  Line 3  ";
      assert.equal(sanitizeSnippet(multiline), "Line 1 Line 2 Line 3");
    });

    it("does not truncate text within maxSnippetChars", () => {
      const text = "Short prompt text";
      assert.equal(sanitizeSnippet(text, 50), "Short prompt text");
    });

    it("truncates text exceeding maxSnippetChars and appends ellipsis", () => {
      const text = "The quick brown fox jumps over the lazy dog";
      assert.equal(sanitizeSnippet(text, 10), "The quick ...");
    });

    it("safely handles UTF-16 surrogate pairs without dangling high surrogate corruption", () => {
      // "Hello " (6 chars) + 😀 (2 code units: \uD83D\uDE00)
      // If maxSnippetChars is 7, slicing at 7 would split the surrogate pair at \uD83D
      const text = "Hello 😀 world";
      const sanitized = sanitizeSnippet(text, 7);
      // High surrogate should be backed off, resulting in "Hello ..."
      assert.equal(sanitized, "Hello ...");
      assert.ok(!sanitized.includes("\uD83D"));
    });
  });

  describe("formatSearchHistoryMarkdown", () => {
    it("returns explicit zero-match notification when results array is empty", () => {
      assert.equal(
        formatSearchHistoryMarkdown("find-bugs", []),
        'No matching history turns found for "find-bugs".'
      );
    });

    it("formats search results into a compact 1-line numbered markdown list", () => {
      const mockResults: SearchHistoryResult[] = [
        {
          sessionId: "105081dd-a4e8-4b79-983e-267df2d178ab",
          turnIndex: 23,
          title: "Session title",
          projectPath: "/d/Projects/chronicle-mcp",
          score: 0.95,
          matchedUserPrompt: "test user prompt\nwith multiple lines",
          matchedAssistantSnippet: "assistant snippet",
          createdAt: 1700000000,
          conversationLink: "conversation://105081dd-a4e8-4b79-983e-267df2d178ab",
        },
        {
          sessionId: "829fc62c-4705-4dce-99dc-2dfd4a8592b9",
          turnIndex: 5,
          title: "Subagent session",
          role: "researcher",
          score: 0.88,
          matchedUserPrompt: "",
          matchedAssistantSnippet: "Found 3 relevant files",
          createdAt: 1700001000,
          conversationLink: "conversation://829fc62c-4705-4dce-99dc-2dfd4a8592b9",
        },
      ];

      const markdown = formatSearchHistoryMarkdown("progressive disclosure", mockResults, "hybrid");

      assert.ok(markdown.startsWith('# Search Results for "progressive disclosure" (2 hits, mode: hybrid)\n\n'));
      assert.ok(markdown.includes('1. [105081dd:T23] (chronicle-mcp) - "test user prompt with multiple lines"'));
      assert.ok(markdown.includes('2. [829fc62c:T5] (role:researcher) - "Found 3 relevant files"'));
    });
  });

  describe("formatListSessionsMarkdown", () => {
    it("returns explicit zero-session notification when sessions array is empty", () => {
      assert.equal(formatListSessionsMarkdown([]), "No indexed sessions found.");
    });

    it("formats sessions into compact 1-line numbered markdown with error badge pluralization", () => {
      const mockSessions: (SessionData & Record<string, any>)[] = [
        {
          id: "105081dd-a4e8-4b79-983e-267df2d178ab",
          adapter: "antigravity",
          title: "Progressive Disclosure Optimization",
          projectPath: "d:\\Projects\\chronicle-mcp",
          totalTurns: 34,
          totalSteps: 857,
          errorCount: 0,
          createdAt: 1700000000,
          firstPrompt: "init",
        },
        {
          id: "829fc62c-4705-4dce-99dc-2dfd4a8592b9",
          adapter: "antigravity",
          title: "Single Error Session",
          project_path: "d:/Projects/chronicle-mcp",
          total_turns: 10,
          total_steps: 40,
          error_count: 1,
          createdAt: 1700001000,
          firstPrompt: "init",
        },
        {
          id: "94564142-f134-4c4e-ba46-1abb0f786c90",
          adapter: "cursor",
          title: "Multiple Errors Session",
          projectPath: null,
          totalTurns: 5,
          totalSteps: 20,
          errorCount: 4,
          createdAt: 1700002000,
          firstPrompt: "init",
        },
      ];

      const markdown = formatListSessionsMarkdown(mockSessions, "workspace");

      assert.ok(markdown.startsWith("# Indexed Sessions (3 sessions, scope: workspace)\n\n"));
      // 0 errors -> no badge
      assert.ok(markdown.includes('1. [105081dd] (chronicle-mcp) - "Progressive Disclosure Optimization" (34 turns, 857 steps)'));
      // 1 error -> singular ", 1 error"
      assert.ok(markdown.includes('2. [829fc62c] (chronicle-mcp) - "Single Error Session" (10 turns, 40 steps, 1 error)'));
      // 4 errors -> plural ", 4 errors"
      assert.ok(markdown.includes('3. [94564142] (cursor) - "Multiple Errors Session" (5 turns, 20 steps, 4 errors)'));
    });
  });

  describe("formatToolUsageStatsMarkdown", () => {
    it("returns empty dataset notification for null or empty stats", () => {
      assert.equal(formatToolUsageStatsMarkdown(null), "No tool usage data recorded.");
      assert.equal(formatToolUsageStatsMarkdown({ summary: { totalCalls: 0, totalErrors: 0, overallFailureRate: 0 }, tools: [], thrashingTools: [] }), "No tool usage data recorded.");
    });

    it("formats tool statistics table with pipe escaping and thrashing status", () => {
      const mockReport: ToolUsageReport = {
        summary: {
          totalCalls: 45,
          totalErrors: 6,
          overallFailureRate: 13.3,
        },
        tools: [
          {
            serverName: "chronicle",
            toolName: "search_history",
            totalCalls: 30,
            errorCount: 0,
            successCount: 30,
            failureRate: 0.0,
            avgDurationMs: 45.2,
          },
          {
            serverName: "github|tools",
            toolName: "create|issue",
            totalCalls: 15,
            errorCount: 6,
            successCount: 9,
            failureRate: 40.0,
            avgDurationMs: 120.8,
          },
        ],
        thrashingTools: [
          {
            sessionId: "105081dd",
            turnIndex: 12,
            serverName: "github|tools",
            toolName: "create|issue",
            consecutiveFailures: 3,
          },
        ],
      };

      const markdown = formatToolUsageStatsMarkdown(mockReport);

      assert.ok(markdown.includes("# Tool Usage & Execution Statistics\n\n"));
      assert.ok(markdown.includes("| Tool Name | Server | Calls | Failures | Error Rate (%) | Avg Duration (ms) | Thrashing Loop |"));
      assert.ok(markdown.includes("| search_history | chronicle | 30 | 0 | 0.0% | 45.2 | No |"));
      // Escaped pipes in names
      assert.ok(markdown.includes("| create\\|issue | github\\|tools | 15 | 6 | 40.0% | 120.8 | YES |"));
      assert.ok(markdown.includes("**Total Tool Executions**: 45 across 2 tools."));
    });

    it("defensively formats NaN and missing numeric values", () => {
      const mockReport: ToolUsageReport = {
        summary: { totalCalls: 0, totalErrors: 0, overallFailureRate: 0 },
        tools: [
          {
            serverName: "custom",
            toolName: "broken_tool",
            totalCalls: 0,
            errorCount: 0,
            successCount: 0,
            failureRate: NaN,
            avgDurationMs: NaN,
          },
        ],
        thrashingTools: [],
      };

      const markdown = formatToolUsageStatsMarkdown(mockReport);
      assert.ok(markdown.includes("| broken_tool | custom | 0 | 0 | 0.0% | 0.0 | No |"));
    });
  });

  describe("projectFields", () => {
    it("returns empty array for empty inputs", () => {
      assert.deepEqual(projectFields([]), []);
    });

    it("projects default compact fields for search entities when fields parameter is omitted", () => {
      const items = [
        {
          sessionId: "105081dd",
          turnIndex: 1,
          title: "Title",
          score: 0.9,
          matchedUserPrompt: "User prompt",
          matchedAssistantSnippet: "Assistant snippet",
          role: "coder",
          projectPath: "/root",
          createdAt: 1000,
        },
      ];

      const projected = projectFields(items, undefined, "search");
      assert.equal(projected.length, 1);
      assert.deepEqual(Object.keys(projected[0]), [
        "sessionId",
        "turnIndex",
        "score",
        "snippet",
        "role",
        "projectPath",
      ]);
      assert.equal(projected[0].snippet, "User prompt");
    });

    it("projects requested fields in exact order and resolves aliases for search entities", () => {
      const items = [
        {
          sessionId: "105081dd",
          turnIndex: 4,
          matchedUserPrompt: "Hello world",
          matchedAssistantSnippet: "Hi there",
        },
      ];

      const projected = projectFields(items, "id, turnIndex, snippet", "search");
      assert.deepEqual(Object.keys(projected[0]), ["id", "turnIndex", "snippet"]);
      assert.equal(projected[0].id, "105081dd");
      assert.equal(projected[0].snippet, "Hello world");
    });

    it("projects requested fields with bidirectional casing resolution for session entities", () => {
      const items = [
        {
          id: "session-123",
          title: "Session 123",
          total_turns: 15,
          total_steps: 45,
          project_path: "/workspace",
        },
      ];

      // Request using camelCase keys
      const projectedCamel = projectFields(items, ["id", "totalTurns", "projectPath"], "session");
      assert.deepEqual(projectedCamel[0], {
        id: "session-123",
        totalTurns: 15,
        projectPath: "/workspace",
      });

      // Request using snake_case keys
      const projectedSnake = projectFields(items, "id, total_turns, project_path", "session");
      assert.deepEqual(projectedSnake[0], {
        id: "session-123",
        total_turns: 15,
        project_path: "/workspace",
      });
    });

    it("safely ignores prototype properties and unknown fields while logging warning", () => {
      const items = [{ sessionId: "105081dd", turnIndex: 1, title: "Test" }];

      const projected = projectFields(items, ["__proto__", "constructor", "unknownField", "sessionId"], "search");
      assert.deepEqual(Object.keys(projected[0]), ["sessionId"]);
      assert.equal(projected[0].sessionId, "105081dd");
    });

    it("creates new immutable objects without mutating source objects", () => {
      const source = { sessionId: "105081dd", turnIndex: 1, title: "Original" };
      const projected = projectFields([source], ["sessionId", "title"], "search");

      projected[0].title = "Mutated";
      assert.equal(source.title, "Original");
    });
  });
});