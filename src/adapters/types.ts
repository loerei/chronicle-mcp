export interface SessionData {
  id: string;
  adapter: string;
  title: string;
  role?: string;
  projectPath?: string | null;
  createdAt: number;
  lastActiveAt?: number;
  parentId?: string | null;
  rootId?: string | null;
  depth?: number;
  totalTurns?: number;
  totalSteps?: number;
  totalTokens?: number;
  artifacts?: string[];
  filesTouched?: string[];
  firstPrompt: string;
  metadata?: Record<string, any>;
  turns?: TurnData[];

  /** @deprecated Transitional property for legacy module compatibility during S1 */
  secondPrompt?: any;
  /** @deprecated Transitional property for legacy module compatibility during S1 */
  chunks?: any;
  /** @deprecated Transitional property for legacy module compatibility during S1 */
  steps?: StepData[];
  /** @deprecated Transitional property for legacy module compatibility during S1 */
  subagentIds?: string[];
  /** @deprecated Transitional property for legacy module compatibility during S1 */
  childSessionIds?: string[];
}

export interface TurnData {
  turnIndex: number;
  userPrompt: string;
  assistantResponse: string;
  turnSummary?: string;
  turnText: string;
  turnVector?: Float32Array | number[];
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  toolCount?: number;
  errorCount?: number;
  durationMs?: number;
  isUndone?: boolean;
  createdAt?: number;
  steps?: StepData[];
}

export interface StepData {
  stepIndex: number;
  turnIndex?: number;
  stepOrder?: number;
  category?: "user" | "agent" | "execution" | "system";
  kind?: "mcp" | "command" | "native" | "subagent" | null;
  status: string;
  content?: string;
  thinking?: string;
  toolName?: string;
  serverName?: string;
  filePath?: string;
  exitCode?: number;
  errorMessage?: string;
  toolArgs?: string; // stringified JSON
  toolResult?: string; // stringified JSON or text
  toolDurationMs?: number;
  subagentSessionId?: string;
  createdAt?: number;
  isUndone?: boolean;

  /** @deprecated Transitional property for legacy step compatibility during S1 */
  type?: any;
  /** @deprecated Transitional property for legacy step compatibility during S1 */
  source?: any;
  /** @deprecated Transitional property for legacy step compatibility during S1 */
  toolCalls?: any;
}

/** @deprecated Transitional interface for legacy chunk compatibility during S1 */
export interface ChunkData {
  stepIndex: number;
  text: string;
}

export type TranscriptDetailLevel = "compact" | "full" | "summary";

export interface ToolFilterOptions {
  name?: string | string[];
  server?: string;
  status?: "DONE" | "ERROR";
  kind?: "mcp" | "command" | "native" | "subagent";
}

export interface TranscriptQueryOptions {
  sessionId?: string;
  turnIndex?: number;
  startTurn?: number;
  endTurn?: number;
  lastTurns?: number;
  detailLevel?: TranscriptDetailLevel;
  include?: Array<"dialogue" | "thinking" | "executions" | "system_events">;
  filePath?: string;
  toolFilter?: ToolFilterOptions;
  includeSubtree?: boolean;
  maxResultChars?: number;
  query?: string;
  includeUndone?: boolean;
  order?: "chronological" | "reverse_chronological";
  limit?: number;
  output?: string;

  /** @deprecated Transitional property for legacy query compatibility */
  startStep?: number;
  /** @deprecated Transitional property for legacy query compatibility */
  endStep?: number;
  /** @deprecated Transitional property for legacy query compatibility */
  startConversationStep?: number;
  /** @deprecated Transitional property for legacy query compatibility */
  endConversationStep?: number;
  /** @deprecated Transitional property for legacy query compatibility */
  categories?: string[];
  /** @deprecated Transitional property for legacy query compatibility */
  sources?: string[];
  /** @deprecated Transitional property for legacy query compatibility */
  sort?: string;
}

export interface SearchHistoryFilter {
  onlyUserPrompts?: boolean;
  onlySubagents?: boolean;
  role?: string;
  hasErrors?: boolean;
}

export interface SearchHistoryOptions {
  query: string;
  mode?: "hybrid" | "semantic" | "keyword";
  scope?: "workspace" | "all";
  projectPath?: string;
  filter?: SearchHistoryFilter;
  limit?: number;
}

export interface SearchHistoryResult {
  sessionId: string;
  turnIndex: number;
  title: string;
  role?: string;
  projectPath?: string | null;
  score: number;
  matchedUserPrompt?: string;
  matchedAssistantSnippet?: string;
  createdAt: number;
  conversationLink: string;
}

export interface GetSessionArtifactsOptions {
  sessionId: string;
  artifactName?: string;
  includeSubtree?: boolean;
  output?: string;
}

export interface SessionRelationshipNode {
  id: string;
  adapter: string;
  title: string;
  role?: string;
  projectPath?: string | null;
  createdAt: number;
  lastActiveAt?: number;
  parentId?: string | null;
  rootId?: string | null;
  depth?: number;
  totalTurns?: number;
  mandate?: string;
  artifacts?: string[];
  children?: SessionRelationshipNode[];

  /** @deprecated Transitional property */
  initialPrompt?: string;
  /** @deprecated Transitional property */
  finalOutput?: string;
}

export interface SessionRelationshipResult {
  sessionId: string;
  rootSessionId: string;
  parent: SessionRelationshipNode | null;
  ancestors: SessionRelationshipNode[];
  current: SessionRelationshipNode;
  children: SessionRelationshipNode[];
  siblings: SessionRelationshipNode[];
}

export interface HistoryAdapter {
  name: string;
  discoverSessions(reporter?: any): Promise<SessionData[]>;
}

export interface SessionBenchmarkMetrics {
  sessionId: string;
  title: string;
  totalTurns?: number;
  totalSteps: number;
  toolCallsCount: number;
  durationMs: number | null;
  cumulativeInputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheHitRate: number;
  estimatedCostSavings: number;
  peakContextSize: number;
  estimatedOutputTokens: number;
  errorStepsCount: number;
  hasDetailedSteps: boolean;
}
