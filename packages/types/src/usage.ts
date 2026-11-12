export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

export interface ContextUsageInfo {
  tokens: number | null;
  contextWindow: number;
  /** 0–100, as returned by the SDK's getContextUsage(). Not a 0–1 ratio. */
  percent: number | null;
}

export interface SessionStatsInfo {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: ContextUsageInfo;
}

/** Per-message timing metrics */
export interface MessageTiming {
  /** Estimated output tokens (content chars / 4) */
  estTokens: number;
  /** Tokens per second (output tokens / generation time in seconds) */
  tps: number;
  /** Thinking time from previous message end to this message start, in ms */
  thinkingTimeMs: number;
  /** Generation time from message start to message end, in ms */
  generationTimeMs: number;
}

/** Tool execution timing */
export interface ToolTiming {
  toolCallId: string;
  toolName: string;
  durationMs: number;
}
