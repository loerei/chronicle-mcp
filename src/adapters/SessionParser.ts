import { SessionData, ChunkData, StepData } from "./types.js";

function jsonParse(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function cleanUserRequest(text: string): string {
  // Removes <USER_REQUEST>, <ADDITIONAL_METADATA> and similar tags
  let cleaned = text;
  cleaned = cleaned.replace(/<USER_REQUEST>[\s\S]*?<\/USER_REQUEST>/g, (match) => {
    return match.replace(/<\/?USER_REQUEST>/g, "");
  });
  cleaned = cleaned.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "");
  cleaned = cleaned.replace(/<[^>]+>/g, ""); // Strip any leftover HTML/XML tags
  return cleaned.trim();
}

function getPathStringsFromCall(call: any): string[] {
  if (!call) return [];
  const args = call.args || call.arguments || {};
  const paths: string[] = [];

  const addPath = (val: any) => {
    if (typeof val === "string") paths.push(val);
  };

  addPath(args.Cwd);
  addPath(args.cwd);
  addPath(args.DirectoryPath);
  addPath(args.directoryPath);

  if (args.Arguments && typeof args.Arguments === "object") {
    const nested = args.Arguments;
    addPath(nested.Cwd);
    addPath(nested.cwd);
    addPath(nested.DirectoryPath);
    addPath(nested.directoryPath);
    addPath(nested.target_file);
    addPath(nested.TargetFile);
    addPath(nested.AbsolutePath);
    addPath(nested.SearchPath);
  }

  addPath(args.target_file);
  addPath(args.TargetFile);
  addPath(args.AbsolutePath);
  addPath(args.SearchPath);

  return paths;
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
    const pathsToCheck = getPathStringsFromCall(call);
    for (const p of pathsToCheck) {
      if (!p) continue;
      const normalized = p.replaceAll("\\", "/");
      const proj = parseProjectFromPath(normalized);
      if (proj) {
        return proj;
      }
    }
  }
  return null;
}

export class SessionParser {
  private static parseStepData(data: any, steps: StepData[], state: { projectPath: string | null; createdAt: number }): void {
    const stepType = data.type;
    const stepIndex = data.step_index ?? 0;
    const stepSource = data.source || "";
    const stepStatus = data.status || "";
    const stepCreatedAt = data.created_at ? new Date(data.created_at).getTime() : undefined;

    let stepContent = data.content || undefined;
    let stepThinking = data.thinking || undefined;
    let stepToolCalls: string | undefined = undefined;

    if (data.tool_calls) {
      stepToolCalls = JSON.stringify(data.tool_calls);
      if (!state.projectPath && Array.isArray(data.tool_calls)) {
        const extracted = extractProjectPathFromToolCalls(data.tool_calls);
        if (extracted) {
          state.projectPath = extracted;
        }
      }
    }

    steps.push({
      stepIndex,
      type: stepType,
      source: stepSource,
      status: stepStatus,
      content: stepContent,
      thinking: stepThinking,
      toolCalls: stepToolCalls,
      createdAt: stepCreatedAt,
    });

    if (state.createdAt === 0 && data.created_at) {
      state.createdAt = new Date(data.created_at).getTime();
    }
  }

  private static handleUserInput(
    data: any,
    state: {
      firstPrompt: string;
      secondPrompt: string;
      projectPath: string | null;
      currentTurnUserText: string;
      currentTurnAssistantText: string;
      currentStepIndex: number;
    },
    chunks: ChunkData[]
  ): void {
    const text = data.content || "";
    const stepIndex = data.step_index ?? 0;

    // Push previous turn if exists
    if (state.currentTurnUserText) {
      chunks.push({
        stepIndex: state.currentStepIndex,
        text: `User: ${state.currentTurnUserText}\nAssistant: ${state.currentTurnAssistantText}`,
      });
    }

    // Extract projectPath from ADDITIONAL_METADATA if present in user input
    if (text.includes("Workspace mapping") || text.includes("active workspaces")) {
      const match = text.match(/d:\\Projects\\[a-z0-9_-]+/i) || text.match(/[a-zA-Z]:\\[^\s]+/);
      if (match) {
        state.projectPath = match[0].replaceAll("\\", "/");
      }
    }

    const cleanedPrompt = cleanUserRequest(text);
    if (!state.firstPrompt) {
      state.firstPrompt = cleanedPrompt;
    } else if (!state.secondPrompt) {
      state.secondPrompt = cleanedPrompt;
    }

    state.currentTurnUserText = cleanedPrompt;
    state.currentTurnAssistantText = "";
    state.currentStepIndex = stepIndex;
  }

  private static handlePlannerResponse(assistantText: string, state: { currentTurnAssistantText: string }): void {
    if (!assistantText) return;
    if (state.currentTurnAssistantText) {
      state.currentTurnAssistantText += "\n" + assistantText;
    } else {
      state.currentTurnAssistantText = assistantText;
    }
  }

  private static handleConversationHistory(historyText: string, localTitleMap: Map<string, string>): void {
    const linesInHistory = historyText.split("\n");
    for (const hLine of linesInHistory) {
      const match = /## Conversation\s+([a-fA-F0-9-]+):\s*(.*)/.exec(hLine);
      if (match) {
        localTitleMap.set(match[1].trim(), match[2].trim());
      }
    }
  }

  private static handleInvokeSubagent(content: string, subagentIds: string[]): void {
    const regex = /"conversationId"\s*:\s*"([a-fA-F0-9-]+)"/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      subagentIds.push(match[1]);
    }
  }

  private static processStepType(
    data: any,
    state: {
      firstPrompt: string;
      secondPrompt: string;
      projectPath: string | null;
      currentTurnUserText: string;
      currentTurnAssistantText: string;
      currentStepIndex: number;
    },
    chunks: ChunkData[],
    localTitleMap: Map<string, string>,
    subagentIds: string[]
  ): void {
    const stepType = data.type;

    if (stepType === "USER_INPUT") {
      this.handleUserInput(data, state, chunks);
    } else if (stepType === "PLANNER_RESPONSE") {
      this.handlePlannerResponse(data.content || "", state);
    } else if (stepType === "CONVERSATION_HISTORY") {
      this.handleConversationHistory(data.content || "", localTitleMap);
    } else if (stepType === "INVOKE_SUBAGENT") {
      this.handleInvokeSubagent(data.content || "", subagentIds);
    }
  }

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
    const existingTitle = composerState.name || composerState.title;
    if (existingTitle) return existingTitle;

    if (firstPrompt) {
      return firstPrompt.length > 50 ? firstPrompt.slice(0, 50) + "..." : firstPrompt;
    }
    return `Composer ${composerId.slice(0, 8)}`;
  }

  private static parseComposerTurn(
    msg: any,
    i: number,
    conversation: any[],
    composerState: any,
    chunks: ChunkData[],
    steps: StepData[],
    state: { firstPrompt: string; secondPrompt: string }
  ): void {
    const userText = msg.text || "";
    
    if (!state.firstPrompt) {
      state.firstPrompt = userText;
    } else if (!state.secondPrompt) {
      state.secondPrompt = userText;
    }

    const reply = this.findAssistantReply(conversation, i + 1);
    const assistantText = reply ? reply.text : "";
    const assistantStepIndex = reply ? reply.index : i + 1;

    chunks.push({
      stepIndex: i,
      text: `User: ${userText}\nAssistant: ${assistantText}`,
    });

    steps.push({
      stepIndex: i,
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      status: "DONE",
      content: userText,
      createdAt: composerState.createdAt || Date.now(),
    });

    if (assistantText) {
      steps.push({
        stepIndex: assistantStepIndex,
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        content: assistantText,
        createdAt: composerState.createdAt || Date.now(),
      });
    }
  }

  static parseAntigravity(sessionId: string, jsonlContent: string): SessionData | null {
    if (!jsonlContent) return null;

    const lines = jsonlContent.split("\n");
    const state = {
      firstPrompt: "",
      secondPrompt: "",
      projectPath: null as string | null,
      createdAt: 0,
      currentTurnUserText: "",
      currentTurnAssistantText: "",
      currentStepIndex: 0,
    };

    const chunks: ChunkData[] = [];
    const steps: StepData[] = [];
    const localTitleMap = new Map<string, string>();
    const subagentIds: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = jsonParse(line);
        if (!data) continue;

        this.parseStepData(data, steps, state);
        this.processStepType(data, state, chunks, localTitleMap, subagentIds);
      } catch {}
    }

    if (state.currentTurnUserText) {
      chunks.push({
        stepIndex: state.currentStepIndex,
        text: `User: ${state.currentTurnUserText}\nAssistant: ${state.currentTurnAssistantText}`,
      });
    }

    if (steps.length === 0) {
      return null;
    }

    const title = this.getSessionTitle(sessionId, localTitleMap, state.firstPrompt);

    const stepTimestamps = steps.map(s => s.createdAt).filter((t): t is number => t !== undefined);
    const lastActiveAt = stepTimestamps.length > 0 ? Math.max(...stepTimestamps) : state.createdAt;

    return {
      id: sessionId,
      adapter: "antigravity",
      title,
      projectPath: state.projectPath,
      createdAt: state.createdAt,
      lastActiveAt,
      firstPrompt: state.firstPrompt,
      secondPrompt: state.secondPrompt,
      chunks,
      steps,
      subagentIds,
    };
  }

  private static findAssistantReply(conversation: any[], startIndex: number): { text: string, index: number } | null {
    for (let j = startIndex; j < conversation.length; j++) {
      const nextMsg = conversation[j];
      const sender = nextMsg.type || nextMsg.sender || "";
      if (sender === "ai" || sender === "assistant") {
        return { text: nextMsg.text || "", index: j };
      }
    }
    return null;
  }

  static parseCursorComposer(composerId: string, composerState: any): SessionData | null {
    if (!Array.isArray(composerState?.conversation)) {
      return null;
    }

    const conversation = composerState.conversation;
    const chunks: ChunkData[] = [];
    const steps: StepData[] = [];
    const promptState = { firstPrompt: "", secondPrompt: "" };

    // Check if the conversation uses the new bubble-based format
    const isNewFormat = conversation.some((msg: any) => msg && (msg.type === 1 || msg.type === 2));

    if (isNewFormat) {
      let stepIndexCounter = 0;
      let currentUserText = "";
      let currentAssistantTexts: string[] = [];

      for (const bubble of conversation) {
        if (!bubble) continue;
        const bubbleCreatedAt = bubble.createdAt
          ? (typeof bubble.createdAt === "string" ? new Date(bubble.createdAt).getTime() : bubble.createdAt)
          : (composerState.createdAt || Date.now());

        if (bubble.type === 1) { // User
          const userText = bubble.text || "";
          
          if (!promptState.firstPrompt) promptState.firstPrompt = userText;
          else if (!promptState.secondPrompt) promptState.secondPrompt = userText;

          if (currentUserText || currentAssistantTexts.length > 0) {
            chunks.push({
              stepIndex: stepIndexCounter,
              text: `User: ${currentUserText}\nAssistant: ${currentAssistantTexts.join("\n")}`,
            });
            currentAssistantTexts = [];
          }
          currentUserText = userText;

          steps.push({
            stepIndex: stepIndexCounter++,
            type: "USER_INPUT",
            source: "USER_EXPLICIT",
            status: "DONE",
            content: userText,
            createdAt: bubbleCreatedAt,
          });
        } else if (bubble.type === 2) { // AI
          const stepContent = bubble.text || undefined;
          let stepThinking: string | undefined = undefined;
          if (bubble.thinking) {
            stepThinking = typeof bubble.thinking === "string" ? bubble.thinking : (bubble.thinking.text || undefined);
          }

          let stepToolCalls: string | undefined = undefined;
          if (bubble.toolFormerData) {
            const toolName = bubble.toolFormerData.name;
            let args = {};
            try {
              args = bubble.toolFormerData.params ? JSON.parse(bubble.toolFormerData.params) : {};
            } catch {}
            stepToolCalls = JSON.stringify([{
              name: toolName,
              args: args,
            }]);
          }

          if (stepContent) {
            currentAssistantTexts.push(stepContent);
          }

          steps.push({
            stepIndex: stepIndexCounter++,
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: stepContent,
            thinking: stepThinking,
            toolCalls: stepToolCalls,
            createdAt: bubbleCreatedAt,
          });

          // Separate tool result step
          if (bubble.toolFormerData) {
            const toolName = bubble.toolFormerData.name;
            const isCommand = toolName === "execute_command" || toolName === "run_command";
            const type = isCommand ? "COMMAND" : "MCP_TOOL";
            const status = bubble.toolFormerData.status === "completed" ? "DONE" : "ERROR";
            const content = bubble.toolFormerData.result || bubble.toolFormerData.error || "";

            steps.push({
              stepIndex: stepIndexCounter++,
              type,
              source: "SYSTEM",
              status,
              content,
              createdAt: bubbleCreatedAt,
            });
          }
        }
      }

      if (currentUserText || currentAssistantTexts.length > 0) {
        chunks.push({
          stepIndex: stepIndexCounter,
          text: `User: ${currentUserText}\nAssistant: ${currentAssistantTexts.join("\n")}`,
        });
      }
    } else {
      // Legacy parsing
      for (let i = 0; i < conversation.length; i++) {
        const msg = conversation[i];
        if (!msg) continue;
        const sender = msg.type || msg.sender || "";
        if (sender === "user") {
          this.parseComposerTurn(msg, i, conversation, composerState, chunks, steps, promptState);
        }
      }
    }

    const title = this.getComposerTitle(composerId, composerState, promptState.firstPrompt);

    let projectPath = composerState.workspacePath || null;
    if (projectPath && typeof projectPath === "string") {
      projectPath = projectPath.replaceAll("\\", "/");
    }

    const createdAt = composerState.createdAt || Date.now();
    const stepTimestamps = steps.map(s => s.createdAt).filter((t): t is number => t !== undefined);
    const lastActiveAt = stepTimestamps.length > 0 ? Math.max(...stepTimestamps) : createdAt;

    return {
      id: composerId,
      adapter: "cursor",
      title,
      projectPath,
      createdAt,
      lastActiveAt,
      firstPrompt: promptState.firstPrompt,
      secondPrompt: promptState.secondPrompt,
      chunks,
      steps,
    };
  }
}
