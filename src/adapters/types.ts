export interface SessionData {
  id: string;
  adapter: string;
  title: string;
  projectPath: string | null;
  createdAt: number;
  lastActiveAt?: number;
  firstPrompt: string;
  secondPrompt: string;
  chunks: ChunkData[];
  steps?: StepData[];
  subagentIds?: string[];
  parentId?: string | null;
}

export interface StepData {
  stepIndex: number;
  type: string;
  source: string;
  status: string;
  content?: string;
  thinking?: string;
  toolCalls?: string; // stringified JSON
  createdAt?: number;
}

export interface ChunkData {
  stepIndex: number;
  text: string;
}

export interface HistoryAdapter {
  name: string;
  discoverSessions(): Promise<SessionData[]>;
}

export interface SessionBenchmarkMetrics {
  sessionId: string;
  title: string;
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
