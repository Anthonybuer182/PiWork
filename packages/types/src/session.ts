import type { Message } from './message.js';

/**
 * The pi custom-entry type that records where the conversation was left.
 *
 * A pi session file is an append-only tree whose current position ("leaf") is
 * simply the last entry. Switching to an earlier branch does not append
 * anything, so without a marker the file would reopen at the newest entry and
 * the switch would be forgotten. Marking appends an invisible entry as a child
 * of the chosen branch tip — the same mechanism pi itself uses for any other
 * custom entry — which makes the file's last entry belong to that branch.
 *
 * The entry never enters model context: `custom` entries are host state.
 */
export const SESSION_LEAF_CUSTOM_TYPE = 'piwork.session-leaf';

export type SessionStatus = 'active' | 'archived' | 'deleted';

export interface Session {
  id: string;
  workspaceId: string;
  title: string;
  status: SessionStatus;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface SessionWithMessages extends Session {
  messages: Message[];
}

export interface TreeNodeToolCall {
  toolCallId: string;
  toolName: string;
  argsPreview?: string;
  resultPreview?: string;
  isError?: boolean;
  duration?: number;
}

export interface SessionTreeNode {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  label?: string;
  /** For message entries */
  role?: 'user' | 'assistant';
  preview?: string;
  /** For model change entries */
  provider?: string;
  modelId?: string;
  /** For thinking level changes */
  thinkingLevel?: string;
  /** For custom entries */
  customType?: string;
  /** For compaction / branch summary */
  summary?: string;
  /** Children (branched sessions) */
  children: SessionTreeNode[];
  /** Tool and thinking chain summary for message entries */
  toolCount?: number;
  toolCalls?: TreeNodeToolCall[];
  hasThinking?: boolean;
  thinkingDuration?: number;
}

export interface SessionTreeResult {
  sessionId: string;
  leafId: string | null;
  nodes: SessionTreeNode[];
}
