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

function extractProjectPathFromToolCalls(toolCalls: any[]): string | null {
  for (const call of toolCalls) {
    if (!call) continue;
    const args = call.args || call.arguments || {};
    const pathsToCheck: string[] = [];

    if (args.Cwd && typeof args.Cwd === "string") pathsToCheck.push(args.Cwd);
    if (args.cwd && typeof args.cwd === "string") pathsToCheck.push(args.cwd);
    if (args.DirectoryPath && typeof args.DirectoryPath === "string") pathsToCheck.push(args.DirectoryPath);
    if (args.directoryPath && typeof args.directoryPath === "string") pathsToCheck.push(args.directoryPath);

    if (args.Arguments && typeof args.Arguments === "object") {
      const nested = args.Arguments;
      if (nested.Cwd && typeof nested.Cwd === "string") pathsToCheck.push(nested.Cwd);
      if (nested.cwd && typeof nested.cwd === "string") pathsToCheck.push(nested.cwd);
      if (nested.DirectoryPath && typeof nested.DirectoryPath === "string") pathsToCheck.push(nested.DirectoryPath);
      if (nested.directoryPath && typeof nested.directoryPath === "string") pathsToCheck.push(nested.directoryPath);
      if (nested.target_file && typeof nested.target_file === "string") pathsToCheck.push(nested.target_file);
      if (nested.TargetFile && typeof nested.TargetFile === "string") pathsToCheck.push(nested.TargetFile);
      if (nested.AbsolutePath && typeof nested.AbsolutePath === "string") pathsToCheck.push(nested.AbsolutePath);
      if (nested.SearchPath && typeof nested.SearchPath === "string") pathsToCheck.push(nested.SearchPath);
    }

    if (args.target_file && typeof args.target_file === "string") pathsToCheck.push(args.target_file);
    if (args.TargetFile && typeof args.TargetFile === "string") pathsToCheck.push(args.TargetFile);
    if (args.AbsolutePath && typeof args.AbsolutePath === "string") pathsToCheck.push(args.AbsolutePath);
    if (args.SearchPath && typeof args.SearchPath === "string") pathsToCheck.push(args.SearchPath);

    for (const p of pathsToCheck) {
      if (!p) continue;
      const normalized = p.replaceAll("\\", "/");
      const projMatch = normalized.match(/^([a-zA-Z]:\/[Pp]rojects\/[a-zA-Z0-9_-]+)/);
      if (projMatch) {
        return projMatch[1];
      }

      const parts = normalized.split("/");
      if (parts.length >= 3 && parts[0].match(/^[a-zA-Z]:$/)) {
        if (parts[1].toLowerCase() === "projects" && parts[2]) {
          return `${parts[0]}/${parts[1]}/${parts[2]}`;
        }
        if (parts[1].toLowerCase() === "users" && parts[2] && parts[3]) {
          if (parts[3] === ".gemini" && parts[4]) {
            return `${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}/${parts[4]}`;
          }
          if (parts[3].toLowerCase() === "projects" && parts[4]) {
            return `${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}/${parts[4]}`;
          }
        }
      }
    }
  }
  return null;
}

export class SessionParser {
  static parseAntigravity(sessionId: string, jsonlContent: string): SessionData | null {
    if (!jsonlContent) return null;

    const lines = jsonlContent.split("\n");
    let firstPrompt = "";
    let secondPrompt = "";
    let projectPath: string | null = null;
    let createdAt = 0;

    const chunks: ChunkData[] = [];
    const steps: StepData[] = [];
    let currentTurnUserText = "";
    let currentTurnAssistantText = "";
    let currentStepIndex = 0;
    const localTitleMap = new Map<string, string>();
    const subagentIds: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = jsonParse(line);
        if (!data) continue;

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
          if (!projectPath && Array.isArray(data.tool_calls)) {
            const extracted = extractProjectPathFromToolCalls(data.tool_calls);
            if (extracted) {
              projectPath = extracted;
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

        if (createdAt === 0 && data.created_at) {
          createdAt = new Date(data.created_at).getTime();
        }

        if (stepType === "USER_INPUT") {
          const text = data.content || "";
          
          // Push previous turn if exists
          if (currentTurnUserText) {
            chunks.push({
              stepIndex: currentStepIndex,
              text: `User: ${currentTurnUserText}\nAssistant: ${currentTurnAssistantText}`,
            });
          }

          // Extract projectPath from ADDITIONAL_METADATA if present in user input
          if (text.includes("Workspace mapping") || text.includes("active workspaces")) {
            const match = text.match(/d:\\Projects\\[a-zA-Z0-9_-]+/i) || text.match(/[a-zA-Z]:\\[^\s]+/);
            if (match) {
              projectPath = match[0].replaceAll("\\", "/");
            }
          }

          if (!firstPrompt) {
            firstPrompt = cleanUserRequest(text);
          } else if (!secondPrompt) {
            secondPrompt = cleanUserRequest(text);
          }

          currentTurnUserText = cleanUserRequest(text);
          currentTurnAssistantText = "";
          currentStepIndex = stepIndex;
        } else if (stepType === "PLANNER_RESPONSE") {
          const assistantText = data.content || "";
          if (assistantText) {
            if (currentTurnAssistantText) {
              currentTurnAssistantText += "\n" + assistantText;
            } else {
              currentTurnAssistantText = assistantText;
            }
          }
        } else if (stepType === "CONVERSATION_HISTORY") {
          const historyText = data.content || "";
          const linesInHistory = historyText.split("\n");
          for (const hLine of linesInHistory) {
            const match = hLine.match(/## Conversation\s+([a-fA-F0-9-]+):\s*(.*)/);
            if (match) {
              const id = match[1].trim();
              const title = match[2].trim();
              localTitleMap.set(id, title);
            }
          }
        } else if (stepType === "INVOKE_SUBAGENT") {
          const content = data.content || "";
          const regex = /"conversationId"\s*:\s*"([a-fA-F0-9-]+)"/g;
          let match;
          while ((match = regex.exec(content)) !== null) {
            subagentIds.push(match[1]);
          }
        }
      } catch {}
    }

    // Push the final turn if exists
    if (currentTurnUserText) {
      chunks.push({
        stepIndex: currentStepIndex,
        text: `User: ${currentTurnUserText}\nAssistant: ${currentTurnAssistantText}`,
      });
    }

    // If no USER_INPUT was encountered or steps is empty, return null
    if (steps.length === 0) {
      return null;
    }

    let title = localTitleMap.get(sessionId);
    if (!title) {
      const cleanPrompt = firstPrompt.trim();
      if (cleanPrompt) {
        title = cleanPrompt.length > 50 ? cleanPrompt.slice(0, 47) + "..." : cleanPrompt;
      } else {
        title = `Session ${sessionId.slice(0, 8)}`;
      }
    }

    return {
      id: sessionId,
      adapter: "antigravity",
      title,
      projectPath,
      createdAt,
      firstPrompt,
      secondPrompt,
      chunks,
      steps,
      subagentIds,
    };
  }

  static parseCursorComposer(composerId: string, composerState: any): SessionData | null {
    if (!composerState || !composerState.conversation || !Array.isArray(composerState.conversation)) {
      return null;
    }

    const conversation = composerState.conversation;
    const chunks: ChunkData[] = [];
    const steps: StepData[] = [];
    let firstPrompt = "";
    let secondPrompt = "";

    // Parse turns: User message followed by Assistant reply
    for (let i = 0; i < conversation.length; i++) {
      const msg = conversation[i];
      if (msg.type === "user" || msg.sender === "user") {
        const userText = msg.text || "";
        
        if (!firstPrompt) {
          firstPrompt = userText;
        } else if (!secondPrompt) {
          secondPrompt = userText;
        }

        // Find subsequent assistant reply
        let assistantText = "";
        let assistantStepIndex = i + 1;
        for (let j = i + 1; j < conversation.length; j++) {
          const nextMsg = conversation[j];
          if (nextMsg.type === "ai" || nextMsg.sender === "ai" || nextMsg.sender === "assistant") {
            assistantText = nextMsg.text || "";
            assistantStepIndex = j;
            break;
          }
        }

        chunks.push({
          stepIndex: i,
          text: `User: ${userText}\nAssistant: ${assistantText}`,
        });

        // Add dummy steps
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
    }

    // Try to get title
    let title = composerState.name || composerState.title;
    if (!title) {
      title = firstPrompt
        ? firstPrompt.slice(0, 50) + (firstPrompt.length > 50 ? "..." : "")
        : `Composer ${composerId.slice(0, 8)}`;
    }

    // Workspace folder/project path
    let projectPath = composerState.workspacePath || null;
    if (projectPath && typeof projectPath === "string") {
      projectPath = projectPath.replaceAll("\\", "/");
    }

    return {
      id: composerId,
      adapter: "cursor",
      title,
      projectPath,
      createdAt: composerState.createdAt || Date.now(),
      firstPrompt,
      secondPrompt,
      chunks,
      steps,
    };
  }
}
