import type { TokenUsage } from './usage.js';

export type MessageRole = 'user' | 'assistant' | 'system' | 'plugin';

export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'error';

export interface ContentBlock {
  id: string;
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'image' | 'file';
  content: string;
  metadata?: Record<string, unknown>;
  // Subtype-specific optional properties
  thinking?: string;
  duration?: number;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  // Image/file specific
  mimeType?: string;
  data?: string;
  width?: number;
  height?: number;
  fileName?: string;
  fileSize?: number;
  workspacePath?: string;
  durationMs?: number;
  // Source position (quoting / preview provenance)
  filePath?: string;
  source?: string;
  startLine?: number;
  endLine?: number;
  pageNumber?: number;
  slideNumber?: number;
  sheetName?: string;
}

export interface ThinkingBlock extends ContentBlock {
  type: 'thinking';
  thinking: string;
  duration?: number;
}

export interface ToolCallBlock extends ContentBlock {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  durationMs?: number;
}

export interface ToolResultBlock extends ContentBlock {
  type: 'tool_result';
  toolCallId: string;
  result: string;
  isError?: boolean;
  /** Tool name (for plugin message-renderer dispatch). */
  toolName?: string;
  /** Plugin declarative card tree (messageRenderer contribution). */
  card?: import('./plugin/ui-tree.js').UiNode;
}

export interface ImageBlock {
  id: string;
  type: 'image';
  content: string;       // alt text or description
  mimeType: string;
  data: string;          // base64 encoded image data
  width?: number;
  height?: number;
}

export interface FileBlock {
  id: string;
  type: 'file';
  content: string;       // filename or description
  mimeType: string;
  data?: string;         // base64 data (for displayable files)
  fileName?: string;
  fileSize?: number;
  /** Workspace-relative path for opening file in right-panel preview */
  workspacePath?: string;
}

/**
 * Where a message sits among the versions of the same turn.
 *
 * A conversation is a tree: editing a question — or retrying its answer —
 * appends a new turn next to the old one instead of rewriting it. The
 * timeline shows one path through that tree, and every user message on that
 * path that has siblings carries the information needed to switch versions.
 */
export interface MessageBranch {
  /** 0-based position of this version among its siblings. */
  index: number;
  /** Number of sibling versions. */
  count: number;
  /**
   * Entry id of every sibling, in order. `targets[index]` is this message's
   * own entry; the others are the versions the user can switch to.
   */
  targets: string[];
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  status: MessageStatus;
  content: string;
  blocks: ContentBlock[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  /** Raw entry ID from SessionManager, used for tree navigation (branch/edit) */
  entryId?: string;
  /**
   * Raw entry ID of the LAST SDK entry folded into this message.
   *
   * One model turn is persisted as several entries — an assistant entry per
   * model call plus a tool result per call — and the timeline shows them as
   * one message. `entryId` points at the first of them, so anything that has
   * to cut the conversation "through this message" (creating a branch from a
   * reply) must use this one instead, or it would sever the tool loop.
   */
  lastEntryId?: string;
  /** Present when this turn has sibling versions (see MessageBranch). */
  branch?: MessageBranch;
}

export interface UserMessage extends Message {
  role: 'user';
  attachments?: string[];
}

export interface AssistantMessage extends Message {
  role: 'assistant';
  modelId: string;
  usage?: TokenUsage;
}

export interface SystemMessage extends Message {
  role: 'system';
}

/**
 * A plugin-originated message in the timeline.
 *
 * Persisted as a pi `custom` session entry, so it is part of the transcript
 * and replays with the conversation, but it is not sent to the model. The
 * renderer gives it its own style (plugin name/icon) instead of blending it
 * into assistant replies.
 */
export interface PluginMessage extends Message {
  role: 'plugin';
  pluginId: string;
  /** The plugin's own stable id for this message (updates share it). */
  pluginMessageId: string;
  revision: number;
  card?: import('./plugin/ui-tree.js').UiNode;
  files?: import('./plugin/plugin-message.js').PluginMessageFile[];
  /** Visual state the plugin chose: info / success / warning / error / loading. */
  pluginStatus?: import('./plugin/plugin-message.js').PluginMessageStatus;
  /** True when this revision also entered model context (agentVisible). */
  agentVisible?: boolean;
  /** Short headline for a request card, e.g. 「解释网页内容」. */
  title?: string;
  /** The passage the request is about, rendered as a quote block. */
  quote?: string;
  /** Where that passage came from (page, document, file). */
  source?: import('./plugin/plugin-message.js').PluginMessageSource;
  /** This message started an agent turn (posted through `chat.send`). */
  triggered?: boolean;
}
