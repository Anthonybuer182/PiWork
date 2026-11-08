import type { Message, ContentBlock, TokenUsage, ContextUsageInfo, SessionStatsInfo, MessageTiming, ToolTiming, QueueState, StreamingBehavior, AgentContextConfig, AgentContextReloadResult, GlobalContextInfo, PluginMessageData, PluginMessagePatch } from '@pi/types';

export interface SendMessageParams {
  sessionId: string;
  content: string;
  /** Image attachments with base64 data for vision models */
  attachments?: { name: string; mimeType: string; data: string }[];
  modelId?: string;
  workspaceCwd?: string;
  /** Queue the message as a steer or follow-up while the agent is working */
  streamingBehavior?: StreamingBehavior;
  /**
   * Skill IDs that should be enabled for this message, filtering what the
   * resource loader discovered. Names come from the loader, e.g.
   * `skill-<name>` for skills on disk or `<pluginId>/<name>` for skills a
   * plugin contributes.
   */
  skills?: string[];
}

export interface StreamChunk {
  type: 'text' | 'block' | 'usage' | 'context' | 'stats' | 'message_start' | 'message_timing' | 'tool_timing' | 'queue_update' | 'done' | 'error';
  content?: string;
  block?: ContentBlock;
  error?: string;
  usage?: TokenUsage;
  contextUsage?: ContextUsageInfo;
  sessionStats?: SessionStatsInfo;
  messageTiming?: MessageTiming;
  toolTiming?: ToolTiming;
  /** Current state of the steering and follow-up queues */
  queueState?: QueueState;
}

export interface NavigateTreeOptions {
  /** If true, AI summarizes the abandoned branch before switching */
  summarize?: boolean;
  /** Custom instructions for the summary prompt */
  customInstructions?: string;
  /** Label to attach to the branch summary entry */
  label?: string;
}

export interface NavigateTreeResult {
  /** Text content of the target user message (for pre-filling editor) */
  editorText?: string;
  /** Whether the user cancelled the operation */
  cancelled: boolean;
}

/** Result of a session compaction operation */
export interface CompactResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
}

export interface ChatService {
  /** Optional: tear down cached sessions so the next prompt rebuilds them
   *  (plugin tool/skill sets changing at runtime). */
  invalidateSessions?(): void;
  /** Optional: retire every cached session (app quit). Extensions such as MCP
   *  close their child processes on `session_shutdown`. */
  dispose?(): Promise<void>;
  sendMessage(params: SendMessageParams): Promise<Message>;
  sendMessageStream(
    params: SendMessageParams,
    onChunk: (chunk: StreamChunk) => void,
    signal?: AbortSignal,
  ): Promise<Message>;
  getMessages(sessionId: string, limit?: number, offset?: number): Promise<Message[]>;
  /**
   * Append a plugin-originated message to a session as a pi `custom` entry.
   *
   * The entry shares the session transcript (so it replays) but is not sent to
   * the model. The plugin backend calls this through the host's `messages`
   * capability; the host owns validation, targeting and persistence.
   */
  appendPluginMessage?(sessionId: string, data: PluginMessageData): Promise<{ entryId: string }>;
  /**
   * Append a new revision of a plugin message. The service verifies the message
   * belongs to `pluginId`, merges the patch, and appends the result. Returns
   * the new revision; throws when the message is missing, owned by another
   * plugin, or already removed.
   */
  updatePluginMessage?(
    sessionId: string,
    messageId: string,
    pluginId: string,
    patch: PluginMessagePatch,
  ): Promise<{ entryId: string; revision: number }>;
  /** Append a tombstone revision for a plugin message (same ownership rules). */
  removePluginMessage?(
    sessionId: string,
    messageId: string,
    pluginId: string,
  ): Promise<{ entryId: string; revision: number }>;
  stopGeneration(sessionId: string): Promise<void>;
  /**
   * Queue a steering message that is delivered after the current assistant turn's
   * tool calls complete, before the next LLM invocation. Use to redirect the agent.
   */
  steer(sessionId: string, content: string, images?: { name: string; mimeType: string; data: string }[]): Promise<void>;
  /**
   * Queue a follow-up message that is delivered only after the agent has finished
   * all work (all tool calls and steering messages processed). Use to append
   * additional tasks.
   */
  followUp(sessionId: string, content: string, images?: { name: string; mimeType: string; data: string }[]): Promise<void>;
  /**
   * Navigate to a different node in the session tree.
   * Moves the leaf pointer to the target entry so the next prompt creates a new branch.
   * @param sessionId - Session ID
   * @param entryId - Raw entry ID from SessionManager (the entryId field on a Message)
   * @param options - Navigation options (summarize, label, etc.)
   */
  navigateTree(sessionId: string, entryId: string, options?: NavigateTreeOptions): Promise<NavigateTreeResult>;
  /**
   * Compacts the conversation context to reduce token usage.
   * Summarizes older messages while preserving key context and decisions.
   * @param sessionId - Session ID
   * @param customInstructions - Optional custom instructions for the summary
   */
  compact(sessionId: string, customInstructions?: string): Promise<CompactResult>;
  /**
   * Read the agent's always-carried context configuration for a workspace —
   * the standing instruction block that is sent on every request regardless of
   * the conversation.
   *
   * Optional: only the main process calls this (through the plugin capability
   * channel). The renderer-side proxy has no use for it.
   */
  /**
   * Read the agent's always-carried context configuration for a workspace —
   * the standing instruction block that is sent on every request regardless of
   * the conversation.
   */
  /**
   * `sessionId` pins the report to one conversation. Without it the reader
   * falls back to the first live session in the workspace — which, now that
   * tool sets are per conversation, may be a different conversation's.
   */
  getAgentContextConfig(
    workspacePath: string,
    workspaceId?: string,
    sessionId?: string,
  ): Promise<AgentContextConfig>;
  /**
   * Rebuild the live agent session's system prompt from disk.
   *
   * Context files and prompt files are read when a session is built, so an edit
   * is otherwise invisible until the user starts a new session. This re-reads
   * them and rebuilds the prompt in place, which makes an edit apply to the very
   * next turn.
   *
   * Refuses while any session is streaming rather than tearing down work in
   * flight; the caller reports that back so the user knows when it will apply.
   */
  reloadAgentContext(workspacePath: string): Promise<AgentContextReloadResult>;
  /**
   * The global prompt/context files in the agent dir, for Settings → 上下文.
   *
   * Separate from `getAgentContextConfig` because it must work with no
   * workspace open: these files apply to every workspace.
   */
  getGlobalContextInfo(): Promise<GlobalContextInfo>;
  /**
   * Rebuild affected live sessions after an ordinary file write.
   *
   * Used by the host to hook plugin `filesystem.write`/`delete`: saving
   * `.pi/SYSTEM.md` or an AGENTS.md must take effect on the next turn, not
   * silently wait for a new session. A no-op for files that are not part of
   * any workspace's standing context.
   *
   * `preferredWorkspace` selects whose reload result is returned; every
   * affected workspace is rebuilt either way (a global file applies to all).
   */
  reloadAgentContextForFile(
    filePath: string,
    preferredWorkspace?: string,
  ): Promise<AgentContextReloadResult>;
  /**
   * Write one of the agent's context/prompt files and rebuild the prompt.
   *
   * Separate from `file.write` because it carries the mtime guard (an editor
   * that read a file must not clobber a concurrent change) and because it
   * rebuilds the live session afterwards — the two always go together.
   *
   * `workspacePath` is omitted when editing a global file with no workspace
   * open; the write still lands, it just has no live session to rebuild.
   */
  writeContextFile(params: {
    workspacePath?: string;
    path: string;
    content: string;
    expectedMtime?: number;
  }): Promise<{ file: { path: string; size: number; mtime: number }; reload: AgentContextReloadResult }>;
  /** Delete one of the agent's context/prompt files and rebuild the prompt. */
  deleteContextFile(params: {
    workspacePath?: string;
    path: string;
    expectedMtime?: number;
  }): Promise<{
    deleted: { path: string; deleted: boolean; reason?: 'not-found' };
    reload: AgentContextReloadResult;
  }>;
}
