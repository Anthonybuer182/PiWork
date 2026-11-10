/**
 * The agent's *always-carried* context — what goes into a request regardless of
 * the conversation.
 *
 * This is deliberately not the message history: the conversation lives in the
 * session tree and is someone else's subject. What is described here is the
 * standing instruction block — system prompt, context files, skills, tools —
 * which is a property of the workspace and the installed plugins, not of any
 * one session.
 */

/** Where a context file was discovered from. */
export type ContextFileScope = 'global' | 'ancestor' | 'workspace';

export interface ContextFileInfo {
  path: string;
  scope: ContextFileScope;
  bytes: number;
  chars: number;
  content: string;
  /**
   * Modification time at read time. Pass back on write so a concurrent
   * external edit is refused instead of silently overwritten.
   */
  mtimeMs: number;
}

/** One segment of the host's `appendSystemPrompt` list. */
export interface AppendSegmentInfo {
  label: string;
  /**
   * Where the segment came from. `user-append` is the user's own
   * APPEND_SYSTEM.md; `plugin-docs` is generated from installed plugins'
   * PLUGIN.md and is not editable here.
   */
  source: 'host' | 'plugin-docs' | 'user-append';
  text: string;
  chars: number;
}

/**
 * A prompt-defining file the SDK reads.
 *
 * Distinct from a context file: these *are* the system prompt rather than
 * workspace context folded into it. Both are ordinary files, which is exactly
 * why the prompt is editable at all — the SDK's prompt builder is not exported,
 * but it does read these.
 */
export interface PromptFileInfo {
  /** `system` replaces the built-in prompt; `append` adds to it. */
  kind: 'system' | 'append';
  scope: 'global' | 'project';
  path: string;
  exists: boolean;
  /**
   * True when this file is the one actually read. Within a kind the project
   * file shadows the global one, so a global file with `active: false` is on
   * disk and doing nothing — worth surfacing rather than hiding.
   */
  active: boolean;
  content: string | null;
  bytes: number;
  chars: number;
  mtimeMs: number;
}

export interface SkillInfo {
  name: string;
  description?: string;
  path?: string;
  chars: number;
}

export interface AgentToolInfo {
  name: string;
  description?: string;
  /** `builtin` for the SDK's own tools, otherwise the contributing plugin id. */
  source: 'builtin' | string;
  schemaBytes: number;
}

export interface PluginDocInfo {
  pluginId: string;
  name: string;
  description: string;
  /** Absolute path to the plugin's PLUGIN.md. */
  path: string;
  /** Characters this doc's summary contributes to the appended prompt. */
  chars: number;
}

export interface AgentContextConfig {
  workspace: { id?: string; path: string; name?: string };
  /**
   * The agent config directory (`~/.pi/agent` unless overridden). Reported
   * because a plugin cannot infer it, and it is where the *global* context file
   * lives — the place a new one has to be written to be global rather than
   * workspace-scoped.
   */
  agentDir: string;
  /**
   * The fully assembled system prompt, exactly as the model receives it.
   *
   * `null` when no live agent session exists for this workspace: the SDK's
   * prompt builder is not part of its public export surface, so the built-in
   * base prompt cannot be reproduced without a session. Callers must render
   * that state honestly rather than substituting an empty string.
   */
  assembled: { text: string; chars: number; tokensEst: number } | null;
  /**
   * The `SYSTEM.md` / `APPEND_SYSTEM.md` files the SDK reads, in both scopes.
   * These are how the prompt itself is edited — write the file, reload.
   */
  promptFiles: PromptFileInfo[];
  sections: {
    base: {
      text: string | null;
      chars: number | null;
      /** Why the text may be missing, or where it came from. */
      note: string;
      /** True when a SYSTEM.md is replacing the SDK's built-in prompt. */
      overridden: boolean;
    };
    appended: AppendSegmentInfo[];
    contextFiles: ContextFileInfo[];
    skills: { items: SkillInfo[]; rendered: string; chars: number };
    tools: AgentToolInfo[];
  };
  pluginDocs: PluginDocInfo[];
  totals: {
    chars: number;
    /**
     * Approximate — derived from character counts, not from provider usage.
     * There is no API that attributes real token cost per prompt section.
     */
    tokensEst: number;
    /** Model context window, when a model is selected. */
    windowTokens?: number;
    /** tokensEst / windowTokens in 0..1, when both are known. */
    share?: number;
  };
}

/**
 * One of the global prompt/context files the Settings → 上下文 page edits.
 *
 * These live in the agent config dir, so they are outside every workspace and
 * cannot be reached through the file tree unless the user opens that directory
 * as a workspace of its own.
 */
export type GlobalContextFileKind = 'system' | 'append' | 'agents';

export interface GlobalContextFile {
  kind: GlobalContextFileKind;
  /** The file the SDK reads; the path a create would write when absent. */
  path: string;
  exists: boolean;
  content: string | null;
  bytes: number;
  chars: number;
  mtimeMs: number;
  /**
   * AGENTS.md / CLAUDE.md variants that exist beside the active file but are
   * not read: the loader takes the first name that exists in a fixed order.
   */
  shadowed: string[];
}

export interface GlobalContextInfo {
  agentDir: string;
  files: GlobalContextFile[];
}

/** Outcome of rebuilding the live session's prompt from disk. */
export interface AgentContextReloadResult {
  /** True when the live session's prompt was rebuilt and the edit is live. */
  applied: boolean;
  /**
   * Why it did not apply, when `applied` is false:
   *   `no-session` — nothing is live yet; the next session reads the file anyway
   *   `busy`       — a session is streaming; rebuilding now would disrupt it
   *   `error`      — the rebuild itself failed. The file WAS written; only
   *                  applying it did not happen, and the caller must say so
   *                  rather than reporting the whole operation as failed.
   */
  reason?: 'no-session' | 'busy' | 'error';
  /** Detail for `reason: 'error'`. */
  message?: string;
}

