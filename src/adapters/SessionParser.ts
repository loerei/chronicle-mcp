import { getEncoding, type Tiktoken } from "js-tiktoken";
import { SessionData, TurnData, StepData, ChunkData, SessionLifecycle } from "./types.js";

// Top-level pre-compiled regular expressions for prompt sanitization
const RE_ADDITIONAL_METADATA = /<ADDITIONAL_METADATA\b[^>]*>[\s\S]*?<\/ADDITIONAL_METADATA>/gi;
const RE_SYSTEM_PROMPT = /<SYSTEM_PROMPT\b[^>]*>[\s\S]*?<\/SYSTEM_PROMPT>/gi;
const RE_USER_INSTRUCTIONS = /<user_instructions\b[^>]*>[\s\S]*?<\/user_instructions>/gi;
const RE_USER_REQUEST_TAGS = /<\/?USER_REQUEST\b[^>]*>/gi;

let cachedTokenizer: Tiktoken | null = null;

function getTokenizer(): Tiktoken {
  cachedTokenizer ??= getEncoding("cl100k_base");
  return cachedTokenizer;
}

export function countTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const str = String(text);
  const clean = typeof (str as any).toWellFormed === "function" ? (str as any).toWellFormed() : str;
  try {
    return getTokenizer().encode(clean).length;
  } catch {
    return Math.ceil(clean.length / 4);
  }
}

export function cleanUserRequest(text: string): string {
  if (!text) return "";
  let cleaned = text;
  cleaned = cleaned.replace(RE_ADDITIONAL_METADATA, "");
  cleaned = cleaned.replace(RE_SYSTEM_PROMPT, "");
  cleaned = cleaned.replace(RE_USER_INSTRUCTIONS, "");
  cleaned = cleaned.replace(RE_USER_REQUEST_TAGS, "");
  return cleaned.trim();
}

function jsonParse(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

export function normalizePayload(val: any): string | undefined {
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val === "string") {
    return val;
  }
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

const FILE_ARG_KEYS = [
  "target_file",
  "TargetFile",
  "AbsolutePath",
  "filePath",
  "file_path",
  "NotebookPath",
  "ImagePaths",
  "image_paths",
  "target_path",
  "TargetPath",
];

const DIR_ARG_KEYS = [
  "Cwd",
  "cwd",
  "DirectoryPath",
  "directoryPath",
  "SearchPath",
  "search_path",
];

function sanitizePath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim();
  if (!p) return null;
  if (p.startsWith("file:///")) {
    p = p.slice(8);
  } else if (p.startsWith("file://")) {
    p = p.slice(7);
  }
  return p.replaceAll("\\", "/");
}

export function extractFilePathsFromCall(call: any): string[] {
  if (!call) return [];
  const args = call.args || call.arguments || {};
  const paths: string[] = [];

  const checkValue = (val: any) => {
    if (typeof val === "string") {
      const sanitized = sanitizePath(val);
      if (sanitized) paths.push(sanitized);
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string") {
          const sanitized = sanitizePath(item);
          if (sanitized) paths.push(sanitized);
        }
      }
    }
  };

  for (const key of FILE_ARG_KEYS) {
    if (args[key] !== undefined) {
      checkValue(args[key]);
    }
  }

  if (args.Arguments && typeof args.Arguments === "object") {
    const nested = args.Arguments;
    for (const key of FILE_ARG_KEYS) {
      if (nested[key] !== undefined) {
        checkValue(nested[key]);
      }
    }
  }

  return paths;
}

export function extractDirectoryPathsFromCall(call: any): string[] {
  if (!call) return [];
  const args = call.args || call.arguments || {};
  const dirs: string[] = [];

  const checkValue = (val: any) => {
    if (typeof val === "string") {
      const sanitized = sanitizePath(val);
      if (sanitized) dirs.push(sanitized);
    }
  };

  for (const key of DIR_ARG_KEYS) {
    if (args[key] !== undefined) {
      checkValue(args[key]);
    }
  }

  if (args.Arguments && typeof args.Arguments === "object") {
    const nested = args.Arguments;
    for (const key of DIR_ARG_KEYS) {
      if (nested[key] !== undefined) {
        checkValue(nested[key]);
      }
    }
  }

  return dirs;
}

function parseUsersPath(parts: string[]): string | null {
  if (parts.length >= 5 && parts[1].toLowerCase() === "users" && parts[2]) {
    const isGemini = parts[3] === ".gemini";
    const isProjects = parts[3].toLowerCase() === "projects";
    if ((isGemini || isProjects) && parts[4]) {
      return `${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}/${parts[4]}`;
    }
  }
  return null;
}

function parseProjectFromPath(normalized: string): string | null {
  const projMatch = /^([a-zA-Z]:\/[Pp]rojects\/[a-zA-Z0-9_-]+)/.exec(normalized);
  if (projMatch) {
    return projMatch[1];
  }

  const parts = normalized.split("/");
  if (parts.length >= 3 && /^[a-zA-Z]:$/.exec(parts[0])) {
    if (parts[1].toLowerCase() === "projects" && parts[2]) {
      return `${parts[0]}/${parts[1]}/${parts[2]}`;
    }
    const usersProj = parseUsersPath(parts);
    if (usersProj) return usersProj;
  }
  return null;
}

function extractProjectPathFromToolCalls(toolCalls: any[]): string | null {
  for (const call of toolCalls) {
    const dirs = extractDirectoryPathsFromCall(call);
    for (const d of dirs) {
      const proj = parseProjectFromPath(d);
      if (proj) return proj;
    }
    const files = extractFilePathsFromCall(call);
    for (const f of files) {
      const proj = parseProjectFromPath(f);
      if (proj) return proj;
    }
  }
  return null;
}

export type ParserToolKind = "mcp" | "command" | "native" | "subagent";

interface PendingToolCall {
  toolName: string;
  serverName?: string;
  kind?: ParserToolKind;
  filePath?: string;
  toolArgs?: string;
  stepIndex: number;
  createdAt?: number;
  isUndone?: boolean;
}

function inferToolKind(toolName: string, serverName?: string): ParserToolKind {
  const lowerTool = (toolName || "").toLowerCase();
  const lowerServer = (serverName || "").toLowerCase();

  if (lowerServer === "github" || lowerServer === "google-workspace" || lowerServer === "patchitright" || lowerServer === "chronicle" || lowerServer === "jcodemunch" || lowerServer === "jdocmunch" || lowerServer === "sonarqube" || lowerServer === "chrome-devtools-mcp") {
    return "mcp";
  }
  if (lowerTool === "run_command" || lowerTool === "execute_command" || lowerTool === "bash" || lowerTool === "terminal") {
    return "command";
  }
  if (lowerTool === "invoke_subagent" || lowerTool === "send_message" || lowerTool === "spawn_subagent" || lowerTool === "manage_subagents") {
    return "subagent";
  }
  if (lowerServer || lowerTool.startsWith("mcp_")) {
    return "mcp";
  }
  return "native";
}

const KNOWN_SERVERS = [
  "github",
  "google-workspace",
  "google_workspace",
  "patchitright",
  "chronicle",
  "jcodemunch",
  "jdocmunch",
  "sonarqube",
  "chrome-devtools-mcp",
  "chrome_devtools_mcp",
];

function parseToolCallMeta(call: any): { toolName: string; serverName?: string; kind: "mcp" | "command" | "native" | "subagent"; filePath?: string; toolArgs?: string } {
  let rawName: string = call.name || call.tool_name || call.ToolName || "";
  let serverName: string | undefined = call.server_name || call.ServerName || undefined;
  const args = call.args || call.arguments || call.Arguments || {};

  // Handle call_mcp_tool wrapper pattern
  if (rawName === "call_mcp_tool" && args.ToolName) {
    rawName = args.ToolName;
    if (args.ServerName) {
      serverName = args.ServerName;
    }
  } else if (rawName.startsWith("mcp_")) {
    const parts = rawName.split("_");
    if (parts.length >= 3) {
      serverName = parts[1];
      rawName = parts.slice(2).join("_");
    }
  } else {
    for (const s of KNOWN_SERVERS) {
      if (rawName.startsWith(s + "_")) {
        serverName = s.replaceAll("_", "-");
        rawName = rawName.slice(s.length + 1);
        break;
      }
    }
  }

  const kind = inferToolKind(rawName, serverName);
  const filePaths = extractFilePathsFromCall(call);
  const filePath = filePaths.length > 0 ? filePaths[0] : undefined;
  const toolArgs = normalizePayload(args);

  return { toolName: rawName, serverName, kind, filePath, toolArgs };
}

export class SessionParser {
  private static getSessionTitle(sessionId: string, localTitleMap: Map<string, string>, firstPrompt: string): string {
    const existingTitle = localTitleMap.get(sessionId);
    if (existingTitle) return existingTitle;

    const cleanPrompt = firstPrompt.trim();
    if (cleanPrompt) {
      return cleanPrompt.length > 50 ? cleanPrompt.slice(0, 47) + "..." : cleanPrompt;
    }
    return `Session ${sessionId.slice(0, 8)}`;
  }

  private static getComposerTitle(composerId: string, composerState: any, firstPrompt: string): string {
    const existingTitle = composerState?.name || composerState?.title;
    if (existingTitle) return existingTitle;

    if (firstPrompt) {
      return firstPrompt.length > 50 ? firstPrompt.slice(0, 50) + "..." : firstPrompt;
    }
    return `Composer ${composerId.slice(0, 8)}`;
  }

  private static parseSubagentMetadata(call: any, subagentIds: string[], currentSessionId?: string, parentId?: string): void {
    const args = call.args || call.arguments || call.Arguments || {};
    const toolName = call.name || call.tool_name || call.ToolName || "";

    if (toolName === "invoke_subagent" || toolName === "spawn_subagent") {
      if (Array.isArray(args.Subagents)) {
        for (const sub of args.Subagents) {
          if (sub?.conversationId) {
            const cleanId = String(sub.conversationId).replace(/^["']|["']$/g, "").trim();
            if (cleanId && cleanId !== currentSessionId) {
              subagentIds.push(cleanId);
            }
          }
        }
      }
    }
  }

  static parseAntigravity(sessionId: string, jsonlContent: string): SessionData | null {
    if (!jsonlContent) return null;

    const lines = jsonlContent.split("\n");
    const rawEvents: any[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const data = jsonParse(line);
      if (data) rawEvents.push(data);
    }

    if (rawEvents.length === 0) {
      return null;
    }

    // Stable sort by step_index ASC to handle asynchronous log flush ordering
    rawEvents.sort((a, b) => (a.step_index ?? a.stepIndex ?? 0) - (b.step_index ?? b.stepIndex ?? 0));

    let projectPath: string | null = null;
    let sessionCreatedAt = 0;
    const localTitleMap = new Map<string, string>();
    const subagentIds: string[] = [];
    const filesTouchedSet = new Set<string>();

    interface InternalTurn {
      turnIndex: number;
      userPrompt: string;
      assistantResponses: string[];
      thinkingBlocks: string[];
      steps: StepData[];
      pendingCalls: PendingToolCall[];
      isUndone: boolean;
      createdAt?: number;
      stepOrderCounter: number;
    }

    const turns: InternalTurn[] = [];
    let activeTurn: InternalTurn | null = null;
    let turnCounter = 0;

    const activeStack: Array<{ stepIndex: number; turnIndex: number; isUndone: boolean }> = [];

    for (const raw of rawEvents) {
      const stepIndex = raw.step_index ?? raw.stepIndex ?? 0;
      const stepType = raw.type || "";
      const stepSource = raw.source || "";
      const stepStatus = raw.status || "DONE";
      const rawCreatedAt = raw.created_at ? new Date(raw.created_at).getTime() : undefined;

      if (sessionCreatedAt === 0 && rawCreatedAt) {
        sessionCreatedAt = rawCreatedAt;
      }

      // Rollback detection: when step_index decreases, mark popped items as undone
      while (activeStack.length > 0 && activeStack.at(-1)!.stepIndex >= stepIndex) {
        const popped = activeStack.pop()!;
        popped.isUndone = true;
        for (const t of turns) {
          if (t.turnIndex === popped.turnIndex) {
            for (const s of t.steps) {
              if (s.stepIndex === popped.stepIndex) {
                s.isUndone = true;
              }
            }
          }
        }
      }

      // Handle USER_INPUT: demarcates a new turn
      if (stepType === "USER_INPUT") {
        const rawContent = raw.content || "";

        // Extract projectPath from user prompt if present
        if (rawContent.includes("Workspace mapping") || rawContent.includes("active workspaces")) {
          const match = rawContent.match(/d:\\Projects\\[a-z0-9_-]+/i) || rawContent.match(/[a-zA-Z]:\\[^\s]+/);
          if (match) {
            projectPath = match[0].replaceAll("\\", "/");
          }
        }

        const cleanedPrompt = cleanUserRequest(rawContent);

        // Advance turn counter
        turnCounter += 1;
        const newTurn: InternalTurn = {
          turnIndex: turnCounter,
          userPrompt: cleanedPrompt,
          assistantResponses: [],
          thinkingBlocks: [],
          steps: [],
          pendingCalls: [],
          isUndone: false,
          createdAt: rawCreatedAt || sessionCreatedAt,
          stepOrderCounter: 1,
        };

        // Emit user input step
        newTurn.steps.push({
          stepIndex,
          turnIndex: turnCounter,
          stepOrder: newTurn.stepOrderCounter++,
          category: "user",
          type: stepType || "USER_INPUT",
          source: stepSource || "USER_EXPLICIT",
          status: "DONE",
          content: cleanedPrompt,
          createdAt: rawCreatedAt,
          isUndone: false,
        });

        turns.push(newTurn);
        activeTurn = newTurn;
        activeStack.push({ stepIndex, turnIndex: turnCounter, isUndone: false });
        continue;
      }

      // If non-USER_INPUT arrives before any turn is created, synthesize Turn 1
      if (!activeTurn) {
        turnCounter = 1;
        activeTurn = {
          turnIndex: 1,
          userPrompt: "",
          assistantResponses: [],
          thinkingBlocks: [],
          steps: [],
          pendingCalls: [],
          isUndone: false,
          createdAt: rawCreatedAt || sessionCreatedAt,
          stepOrderCounter: 1,
        };
        turns.push(activeTurn);
      }

      // Handle CONVERSATION_HISTORY for session titles
      if (stepType === "CONVERSATION_HISTORY") {
        const historyText = raw.content || "";
        const linesInHistory = historyText.split("\n");
        for (const hLine of linesInHistory) {
          const match = /## Conversation\s+([a-fA-F0-9-]+):\s*(.*)/.exec(hLine);
          if (match) {
            localTitleMap.set(match[1].trim(), match[2].trim());
          }
        }
      }

      // Handle CHECKPOINT explicitly as a system event
      if (stepType === "CHECKPOINT" || (raw.content && typeof raw.content === "string" && raw.content.startsWith("{{ CHECKPOINT"))) {
        activeTurn.steps.push({
          stepIndex,
          turnIndex: activeTurn.turnIndex,
          stepOrder: activeTurn.stepOrderCounter++,
          category: "system",
          type: "CHECKPOINT",
          source: stepSource || "SYSTEM",
          status: "DONE",
          content: normalizePayload(raw.content),
          createdAt: rawCreatedAt,
          isUndone: false,
        });
        activeStack.push({ stepIndex, turnIndex: activeTurn.turnIndex, isUndone: false });
        continue;
      }

      // Handle PLANNER_RESPONSE (agent thoughts / dialogue & tool calls)
      if (stepType === "PLANNER_RESPONSE") {
        const content = raw.content || "";
        const thinking = raw.thinking || undefined;
        const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];

        if (content) {
          activeTurn.assistantResponses.push(content);
        }
        if (thinking) {
          activeTurn.thinkingBlocks.push(thinking);
        }

        // Project path detection from tool calls
        if (!projectPath && toolCalls.length > 0) {
          const extracted = extractProjectPathFromToolCalls(toolCalls);
          if (extracted) projectPath = extracted;
        }

        // Subagent discovery from tool calls
        for (const call of toolCalls) {
          this.parseSubagentMetadata(call, subagentIds, sessionId);
          const filePaths = extractFilePathsFromCall(call);
          for (const f of filePaths) filesTouchedSet.add(f);
        }

        // Emit agent step iff non-empty content or thinking exists
        if (content.trim() || thinking?.trim()) {
          activeTurn.steps.push({
            stepIndex,
            turnIndex: activeTurn.turnIndex,
            stepOrder: activeTurn.stepOrderCounter++,
            category: "agent",
            type: stepType || "PLANNER_RESPONSE",
            source: stepSource || "MODEL",
            status: "DONE",
            content: content || undefined,
            thinking: thinking || undefined,
            createdAt: rawCreatedAt,
            isUndone: false,
          });
        }

        // Flush any orphaned pending calls from earlier response as PENDING execution steps
        while (activeTurn.pendingCalls.length > 0) {
          const pending = activeTurn.pendingCalls.shift()!;
          activeTurn.steps.push({
            stepIndex: pending.stepIndex,
            turnIndex: activeTurn.turnIndex,
            stepOrder: activeTurn.stepOrderCounter++,
            category: "execution",
            kind: pending.kind,
            status: "PENDING",
            toolName: pending.toolName,
            serverName: pending.serverName,
            filePath: pending.filePath,
            toolArgs: pending.toolArgs,
            createdAt: pending.createdAt,
            isUndone: pending.isUndone || false,
          });
        }

        // Enqueue tool calls into pending queue
        for (const call of toolCalls) {
          const meta = parseToolCallMeta(call);
          activeTurn.pendingCalls.push({
            toolName: meta.toolName,
            serverName: meta.serverName,
            kind: meta.kind,
            filePath: meta.filePath,
            toolArgs: meta.toolArgs,
            stepIndex,
            createdAt: rawCreatedAt,
            isUndone: false,
          });
        }

        activeStack.push({ stepIndex, turnIndex: activeTurn.turnIndex, isUndone: false });
        continue;
      }

      // Handle tool execution outputs / error steps (MCP_TOOL, COMMAND, INVOKE_SUBAGENT, etc.)
      const isExecutionEvent =
        stepType === "MCP_TOOL" ||
        stepType === "COMMAND" ||
        stepType === "INVOKE_SUBAGENT" ||
        stepType === "TOOL_RESULT" ||
        (activeTurn.pendingCalls.length > 0 && (stepType === "GENERIC" || !stepType) && raw.content && stepType !== "CHECKPOINT" && stepType !== "SYSTEM_MESSAGE") ||
        (stepSource === "SYSTEM" && raw.content && stepType !== "CHECKPOINT" && stepType !== "SYSTEM_MESSAGE");

      if (isExecutionEvent) {
        let matchedCall: PendingToolCall | undefined = undefined;

        // Try to match a pending tool call from activeTurn.pendingCalls
        const eventToolName = raw.tool_name || raw.name || undefined;
        let matchIdx = -1;

        if (eventToolName) {
          matchIdx = activeTurn.pendingCalls.findIndex(c => c.toolName === eventToolName || eventToolName.endsWith(c.toolName));
        } else if (stepType === "COMMAND") {
          matchIdx = activeTurn.pendingCalls.findIndex(c => c.kind === "command" || c.toolName === "run_command" || c.toolName === "execute_command");
        } else if (stepType === "MCP_TOOL") {
          matchIdx = activeTurn.pendingCalls.findIndex(c => c.kind === "mcp" || c.kind === "native");
        } else if (stepType === "INVOKE_SUBAGENT") {
          matchIdx = activeTurn.pendingCalls.findIndex(c => c.kind === "subagent");
        } else if (stepType === "GENERIC" || !stepType) {
          // Heuristic matching based on content signatures for GENERIC events
          if (raw.content && typeof raw.content === "string") {
            if (raw.content.includes("File Path:")) {
              const fileIdx = activeTurn.pendingCalls.findIndex(c => c.filePath && raw.content.includes(c.filePath));
              matchIdx = fileIdx >= 0 ? fileIdx : activeTurn.pendingCalls.findIndex(c => c.toolName === "view_file" || c.toolName === "write_to_file" || c.toolName === "replace_file_content");
            } else if (raw.content.includes("Message sent to")) {
              matchIdx = activeTurn.pendingCalls.findIndex(c => c.toolName === "send_message");
            } else if (raw.content.includes("Tool is running as a background task") || raw.content.includes("Timer:")) {
              matchIdx = activeTurn.pendingCalls.findIndex(c => c.toolName === "schedule" || c.kind === "command");
            } else if (raw.content.includes("active subagent(s)")) {
              matchIdx = activeTurn.pendingCalls.findIndex(c => c.toolName === "manage_subagents");
            } else if (raw.content.includes("Empty directory") || raw.content.includes("Total lines:") || raw.content.includes("Found ")) {
              matchIdx = activeTurn.pendingCalls.findIndex(c => c.toolName === "list_dir" || c.toolName === "find_by_name" || c.toolName === "grep_search");
            }
          }
          if (matchIdx < 0 && activeTurn.pendingCalls.length > 0) {
            matchIdx = 0;
          }
        }

        if (matchIdx >= 0) {
          matchedCall = activeTurn.pendingCalls.splice(matchIdx, 1)[0];
        }

        // Extract execution details
        const toolResult = normalizePayload(raw.content || raw.result || raw.output || undefined);
        let exitCode = 0;
        if (typeof raw.exit_code === "number") {
          exitCode = raw.exit_code;
        } else if (stepStatus === "ERROR") {
          exitCode = 1;
        }

        let errorMessage: string | undefined = undefined;
        if (stepStatus === "ERROR") {
          errorMessage = raw.error || raw.error_message || (exitCode !== 0 ? `Process exited with code ${exitCode}` : undefined);
        }

        let subagentSessionId: string | undefined = undefined;
        if (raw.content && typeof raw.content === "string") {
          const regex = /"conversationId"\s*:\s*"([^"]+)"/g;
          let match: RegExpExecArray | null;
          while ((match = regex.exec(raw.content)) !== null) {
            const cleanId = match[1].replace(/^["']|["']$/g, "").trim();
            if (cleanId && cleanId !== sessionId) {
              subagentSessionId = cleanId;
              subagentIds.push(cleanId);
            }
          }
        }

        const toolName = matchedCall?.toolName || raw.tool_name || (stepType === "COMMAND" ? "run_command" : "mcp_tool");
        const serverName = matchedCall?.serverName || raw.server_name || undefined;
        const kind = matchedCall?.kind || inferToolKind(toolName, serverName);
        const filePath = matchedCall?.filePath || undefined;
        const toolArgs = matchedCall?.toolArgs || undefined;

        let toolDurationMs: number | undefined = undefined;
        if (matchedCall?.createdAt && rawCreatedAt && rawCreatedAt >= matchedCall.createdAt) {
          toolDurationMs = rawCreatedAt - matchedCall.createdAt;
        }

        activeTurn.steps.push({
          stepIndex,
          turnIndex: activeTurn.turnIndex,
          stepOrder: activeTurn.stepOrderCounter++,
          category: "execution",
          type: stepType || (kind === "command" ? "COMMAND" : "MCP_TOOL"),
          source: stepSource || "SYSTEM",
          kind,
          status: stepStatus === "ERROR" || exitCode !== 0 ? "ERROR" : "DONE",
          toolName,
          serverName,
          filePath,
          exitCode,
          errorMessage,
          toolArgs,
          toolResult,
          toolDurationMs,
          subagentSessionId,
          createdAt: rawCreatedAt,
          isUndone: false,
        });

        activeStack.push({ stepIndex, turnIndex: activeTurn.turnIndex, isUndone: false });
        continue;
      }

      // Generic fallback for other system/custom steps
      activeTurn.steps.push({
        stepIndex,
        turnIndex: activeTurn.turnIndex,
        stepOrder: activeTurn.stepOrderCounter++,
        category: "system",
        type: stepType || "SYSTEM_MESSAGE",
        source: stepSource || "SYSTEM",
        status: stepStatus,
        content: normalizePayload(raw.content),
        createdAt: rawCreatedAt,
        isUndone: false,
      });
      activeStack.push({ stepIndex, turnIndex: activeTurn.turnIndex, isUndone: false });
    }

    // Flush any remaining pending tool calls as PENDING execution steps
    for (const t of turns) {
      while (t.pendingCalls.length > 0) {
        const pending = t.pendingCalls.shift()!;
        t.steps.push({
          stepIndex: pending.stepIndex,
          turnIndex: t.turnIndex,
          stepOrder: t.stepOrderCounter++,
          category: "execution",
          kind: pending.kind,
          status: "PENDING",
          toolName: pending.toolName,
          serverName: pending.serverName,
          filePath: pending.filePath,
          toolArgs: pending.toolArgs,
          createdAt: pending.createdAt,
          isUndone: pending.isUndone || false,
        });
      }
    }

    // Assemble final TurnData[]
    const finalTurns: TurnData[] = [];
    const allStepsFlat: StepData[] = [];
    const chunks: ChunkData[] = [];

    for (const t of turns) {
      // Determine if turn is undone (if all steps in turn are undone)
      const hasActiveSteps = t.steps.some(s => !s.isUndone);
      const isTurnUndone = t.steps.length > 0 ? !hasActiveSteps : t.isUndone;
      t.isUndone = isTurnUndone;

      const assistantCombined = t.assistantResponses.join("\n").trim();
      const turnText = [t.userPrompt, assistantCombined].filter(Boolean).join(" ").trim();

      const inputTokens = countTokens(t.userPrompt);
      const outputTokens = countTokens(assistantCombined);
      const thinkingTokens = countTokens(t.thinkingBlocks.join("\n"));

      const executionSteps = t.steps.filter(s => s.category === "execution");
      const toolCount = executionSteps.length;
      const errorCount = executionSteps.filter(s => s.status === "ERROR" || (s.exitCode && s.exitCode !== 0)).length;

      const stepTimestamps = t.steps.map(s => s.createdAt).filter((ts): ts is number => typeof ts === "number" && !Number.isNaN(ts));
      const durationMs = stepTimestamps.length >= 2 ? Math.max(0, Math.max(...stepTimestamps) - Math.min(...stepTimestamps)) : 0;

      const turnObj: TurnData = {
        turnIndex: t.turnIndex,
        userPrompt: t.userPrompt,
        assistantResponse: assistantCombined,
        turnSummary: t.userPrompt.length > 120 ? t.userPrompt.slice(0, 117) + "..." : t.userPrompt,
        turnText,
        inputTokens,
        outputTokens,
        thinkingTokens,
        toolCount,
        errorCount,
        durationMs,
        isUndone: isTurnUndone,
        createdAt: t.createdAt || sessionCreatedAt,
        steps: t.steps,
      };

      finalTurns.push(turnObj);
      allStepsFlat.push(...t.steps);

      if (t.userPrompt || assistantCombined) {
        chunks.push({
          stepIndex: t.steps[0]?.stepIndex ?? t.turnIndex,
          text: `User: ${t.userPrompt}\nAssistant: ${assistantCombined}`,
        });
      }
    }

    // Compute active metrics (strictly where !isUndone)
    const activeTurns = finalTurns.filter(t => !t.isUndone);
    const activeSteps = allStepsFlat.filter(s => !s.isUndone);

    const totalTurns = activeTurns.length;
    const totalSteps = activeSteps.length;
    const totalTokens = activeTurns.reduce((sum, t) => sum + (t.inputTokens || 0) + (t.outputTokens || 0) + (t.thinkingTokens || 0), 0);

    const firstPrompt = activeTurns[0]?.userPrompt || finalTurns[0]?.userPrompt || "";
    const secondPrompt = activeTurns[1]?.userPrompt || finalTurns[1]?.userPrompt || "";
    const title = this.getSessionTitle(sessionId, localTitleMap, firstPrompt);

    const allTimestamps = allStepsFlat.map(s => s.createdAt).filter((ts): ts is number => typeof ts === "number" && !Number.isNaN(ts));
    const lastActiveAt = allTimestamps.length > 0 ? Math.max(...allTimestamps) : (sessionCreatedAt || Date.now());

    // Determine session lifecycle state
    let lifecycle: SessionLifecycle = {
      status: "completed",
      hasTurnCompletion: true,
      lastStepIndex: allStepsFlat.length > 0 ? allStepsFlat[allStepsFlat.length - 1].stepIndex : undefined,
    };

    if (allStepsFlat.length > 0) {
      const lastStep = allStepsFlat[allStepsFlat.length - 1];
      const lastTurn = finalTurns[finalTurns.length - 1];
      const hasDialogue = Boolean(lastTurn?.assistantResponse && lastTurn.assistantResponse.trim());

      if (lastStep.category === "execution") {
        lifecycle = {
          status: "interrupted_mid_turn",
          hasTurnCompletion: false,
          lastStepIndex: lastStep.stepIndex,
          lastToolExecuted: lastStep.toolName,
        };
      } else if (lastStep.category === "user" || !hasDialogue) {
        lifecycle = {
          status: "interrupted_mid_turn",
          hasTurnCompletion: false,
          lastStepIndex: lastStep.stepIndex,
          lastToolExecuted: lastStep.toolName,
        };
      }
    }

    return {
      id: sessionId,
      adapter: "antigravity",
      title,
      projectPath,
      createdAt: sessionCreatedAt || Date.now(),
      lastActiveAt,
      totalTurns,
      totalSteps,
      totalTokens,
      firstPrompt,
      secondPrompt,
      artifacts: [],
      filesTouched: Array.from(filesTouchedSet),
      turns: finalTurns,
      steps: allStepsFlat,
      chunks,
      subagentIds: Array.from(new Set(subagentIds)),
      lifecycle,
    };
  }

  static parseCursorComposer(composerId: string, composerState: any): SessionData | null {
    if (!Array.isArray(composerState?.conversation)) {
      return null;
    }

    const conversation = composerState.conversation;
    const turns: TurnData[] = [];
    const allSteps: StepData[] = [];
    const chunks: ChunkData[] = [];
    const filesTouchedSet = new Set<string>();

    let turnCounter = 0;
    let stepIndexCounter = 0;
    const defaultCreatedAt = composerState.createdAt || Date.now();

    for (let i = 0; i < conversation.length; i++) {
      const msg = conversation[i];
      if (!msg) continue;

      const isUser = msg.type === 1 || msg.type === "user" || msg.sender === "user";

      if (isUser) {
        turnCounter += 1;
        const userText = cleanUserRequest(msg.text || "");
        const createdAt = msg.createdAt ? new Date(msg.createdAt).getTime() : defaultCreatedAt;

        const turnSteps: StepData[] = [];
        turnSteps.push({
          stepIndex: stepIndexCounter++,
          turnIndex: turnCounter,
          stepOrder: 1,
          category: "user",
          type: "USER_INPUT",
          source: "USER_EXPLICIT",
          status: "DONE",
          content: userText,
          createdAt,
          isUndone: false,
        });

        // Look ahead for AI response
        let assistantText = "";
        let assistantThinking: string | undefined = undefined;
        let stepOrderCounter = 2;

        if (i + 1 < conversation.length) {
          const nextMsg = conversation[i + 1];
          const nextIsAI = nextMsg && (nextMsg.type === 2 || nextMsg.type === "ai" || nextMsg.sender === "ai" || nextMsg.sender === "assistant");
          if (nextIsAI) {
            assistantText = nextMsg.text || "";
            if (nextMsg.thinking) {
              assistantThinking = typeof nextMsg.thinking === "string" ? nextMsg.thinking : nextMsg.thinking.text;
            }

            if (assistantText.trim() || assistantThinking?.trim()) {
              turnSteps.push({
                stepIndex: stepIndexCounter++,
                turnIndex: turnCounter,
                stepOrder: stepOrderCounter++,
                category: "agent",
                type: "PLANNER_RESPONSE",
                source: "MODEL",
                status: "DONE",
                content: assistantText || undefined,
                thinking: assistantThinking || undefined,
                createdAt: nextMsg.createdAt ? new Date(nextMsg.createdAt).getTime() : createdAt,
                isUndone: false,
              });
            }

            // Parse tool former data if present
            if (nextMsg.toolFormerData) {
              const toolName = nextMsg.toolFormerData.name || "tool";
              const isCommand = toolName === "execute_command" || toolName === "run_command";
              const kind = isCommand ? "command" : "mcp";
              const status = nextMsg.toolFormerData.status === "completed" ? "DONE" : "ERROR";
              const toolResult = nextMsg.toolFormerData.result || nextMsg.toolFormerData.error || undefined;
              let toolArgs: string | undefined = undefined;
              try {
                toolArgs = nextMsg.toolFormerData.params ? JSON.stringify(JSON.parse(nextMsg.toolFormerData.params)) : undefined;
              } catch {
                toolArgs = nextMsg.toolFormerData.params;
              }

              turnSteps.push({
                stepIndex: stepIndexCounter++,
                turnIndex: turnCounter,
                stepOrder: stepOrderCounter++,
                category: "execution",
                type: isCommand ? "COMMAND" : "MCP_TOOL",
                source: "SYSTEM",
                kind,
                status,
                toolName,
                toolArgs,
                toolResult,
                createdAt: nextMsg.createdAt ? new Date(nextMsg.createdAt).getTime() : createdAt,
                isUndone: false,
              });
            }

            i++; // skip processed AI message
          }
        }

        const turnText = [userText, assistantText].filter(Boolean).join(" ").trim();
        const inputTokens = countTokens(userText);
        const outputTokens = countTokens(assistantText);
        const thinkingTokens = countTokens(assistantThinking);

        const executionSteps = turnSteps.filter(s => s.category === "execution");
        const toolCount = executionSteps.length;
        const errorCount = executionSteps.filter(s => s.status === "ERROR").length;

        turns.push({
          turnIndex: turnCounter,
          userPrompt: userText,
          assistantResponse: assistantText,
          turnSummary: userText.length > 120 ? userText.slice(0, 117) + "..." : userText,
          turnText,
          inputTokens,
          outputTokens,
          thinkingTokens,
          toolCount,
          errorCount,
          durationMs: 0,
          isUndone: false,
          createdAt,
          steps: turnSteps,
        });

        allSteps.push(...turnSteps);
        chunks.push({
          stepIndex: turnSteps[0].stepIndex,
          text: `User: ${userText}\nAssistant: ${assistantText}`,
        });
      }
    }

    const firstPrompt = turns[0]?.userPrompt || "";
    const secondPrompt = turns[1]?.userPrompt || "";
    const title = this.getComposerTitle(composerId, composerState, firstPrompt);

    let projectPath = composerState.workspacePath || null;
    if (projectPath && typeof projectPath === "string") {
      projectPath = projectPath.replaceAll("\\", "/");
    }

    const totalTurns = turns.length;
    const totalSteps = allSteps.length;
    const totalTokens = turns.reduce((sum, t) => sum + (t.inputTokens || 0) + (t.outputTokens || 0) + (t.thinkingTokens || 0), 0);

    const stepTimestamps = allSteps.map(s => s.createdAt).filter((t): t is number => typeof t === "number" && !Number.isNaN(t));
    const lastActiveAt = stepTimestamps.length > 0 ? Math.max(...stepTimestamps) : defaultCreatedAt;

    return {
      id: composerId,
      adapter: "cursor",
      title,
      projectPath,
      createdAt: defaultCreatedAt,
      lastActiveAt,
      totalTurns,
      totalSteps,
      totalTokens,
      firstPrompt,
      secondPrompt,
      artifacts: [],
      filesTouched: Array.from(filesTouchedSet),
      turns,
      steps: allSteps,
      chunks,
      lifecycle: {
        status: "completed",
        hasTurnCompletion: true,
      },
    };
  }
}
