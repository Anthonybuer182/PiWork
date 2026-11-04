import * as path from 'path';
import { statSync, readFileSync, existsSync } from 'node:fs';
import type { ChatService, SendMessageParams, StreamChunk } from '../services/chat.js';
import type { Message, AssistantMessage, ContentBlock, ToolResultBlock, TokenUsage, ContextUsageInfo, SessionStatsInfo, MessageTiming, AgentContextConfig, AgentContextReloadResult, AgentToolInfo, AppendSegmentInfo, ContextFileInfo, ContextFileScope, PromptFileInfo, GlobalContextFile, GlobalContextInfo, ModelCapabilities } from '@pi/types';
import { ASK_TOOL_NAME, TODO_TOOL_NAME } from '@pi/types';
import { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir, SettingsManager, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import type { AgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModelRegistry, getSharedModelRuntime } from './model-runtime.js';
import { extractThinkContent } from '../utils/think-parser.js';
import { deleteFileWithMtimeGuard, writeFileWithMtimeGuard } from '../utils/safe-write.js';
import { detectWrittenFiles } from '../utils/file-detection.js';
import { migrateModelsConfig, modelCapabilitiesOf } from './config.js';

/**
 * Built-in tools this app activates.
 *
 * The SDK's own default is `read` / `bash` / `edit` / `write`; `grep`, `find`
 * and `ls` are opt-in. The app opts in because search is a conversation's most
 * common need: without them the model can only search by running a shell
 * command, which asks for approval every time. All three are read-only, so the
 * permission gate auto-allows them.
 *
 * Passed explicitly rather than left to the default so the set is reviewable
 * here; `excludeTools` (the user's global switches) still filters it.
 */
export const ACTIVE_BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

/**
 * The filenames the SDK tries, in order, for a directory's context file.
 *
 * The first one that exists wins; the rest are not read. Mirrored here so the
 * Settings page can report which candidate is actually in effect.
 */
const GLOBAL_CONTEXT_NAMES = ['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'] as const;

/**
 * Real chat adapter using createAgentSessionFromServices.
 *
 * Creates interactive AgentSession instances backed by the real SDK.
 * For existing sessions, opens via SessionManager and attaches to AgentSession.
 * For new sessions, creates via SessionManager.create().
 *
 * `options.customToolsProvider` supplies plugin-contributed agent tools;
 * they are snapshotted at session creation — call `invalidateSessions()`
 * (wired to the plugin system's extensions-changed hook) to rebuild.
 */
/**
 * A plugin's usage doc, as it reaches the prompt.
 *
 * `description` is the entire match surface — the agent only opens the file
 * when that line fits the task at hand.
 */
export interface PluginDoc {
  name: string;
  pluginId?: string;
  description: string;
  /** Absolute path to the plugin's PLUGIN.md. */
  location: string;
}

/**
 * The plugin index, shaped like the SDK's own `<available_skills>` block.
 *
 * Same contract as skills, and for the same reason: only name, description and
 * path go in the prompt, and the body is read on demand. A plugin's full doc
 * would be a permanent tax on every request; its one-line description is not.
 * The agent reads the file itself when that line matches.
 */
export function formatPluginDocsForPrompt(docs: PluginDoc[]): string {
  if (docs.length === 0) return '';
  const lines = [
    '',
    'The following plugins are installed. Each one ships a PLUGIN.md describing what it can do and how to drive it.',
    "Use the read tool to load a plugin's file when the task matches its description.",
    '',
    '<available_plugins>',
  ];
  for (const doc of docs) {
    lines.push('  <plugin>');
    lines.push(`    <name>${escapeXml(doc.name)}</name>`);
    lines.push(`    <description>${escapeXml(doc.description)}</description>`);
    lines.push(`    <location>${escapeXml(doc.location)}</location>`);
    lines.push('  </plugin>');
  }
  lines.push('</available_plugins>');
  return lines.join('\n');
}

const escapeXml = (str: string): string =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * The host's own contribution to `appendSystemPrompt`, ahead of the plugin
 * index. Named so the context reader can attribute each appended segment back
 * to its origin instead of guessing from the text.
 */
export const HOST_VISION_PROMPT =
  'You are equipped with vision capabilities. When users attach images or when the read tool loads image files, analyze the visual content directly. This includes: screenshots of code/errors, UI designs, architecture diagrams, charts, photos, and any other images the user shares. Describe what you see clearly and use it to provide better coding assistance.';

/**
 * The active model explicitly lists its inputs and does not include 'image'.
 *
 * Saying this plainly is the point: without it the agent still receives a
 * silent "image omitted" note and can spend turns screenshotting, installing
 * image libraries, or cropping a picture it will never see.
 */
export const HOST_TEXT_ONLY_PROMPT =
  'The active model cannot receive images in this session. Images from user attachments or tool results are omitted (or replaced with a short note). Do not plan around seeing screenshots, charts or image files, and do not retry the same visual approach after an image is omitted. Use text or structured APIs instead; if the task genuinely requires inspecting an image, tell the user to switch to a vision-capable model.';

/**
 * The model did not declare its input modalities. Neither claim — "you have
 * vision" nor "you cannot see images" — is safe, so state only what the host
 * actually does when an image cannot be delivered.
 */
export const HOST_UNKNOWN_CAPABILITY_PROMPT =
  'Image support depends on the active model. If a tool result says an image was omitted, do not retry the same visual approach; use a text or structured route instead, or ask the user to switch to a vision-capable model.';

/** The host capability notes, in no particular order. */
const HOST_CAPABILITY_PROMPTS = [
  HOST_VISION_PROMPT,
  HOST_TEXT_ONLY_PROMPT,
  HOST_UNKNOWN_CAPABILITY_PROMPT,
] as const;

/** True for whichever capability note a session's prompt used. */
export function isHostCapabilityPrompt(text: string): boolean {
  return HOST_CAPABILITY_PROMPTS.includes(text as (typeof HOST_CAPABILITY_PROMPTS)[number]);
}

/** Where the capability note starts in an assembled prompt, or -1. */
function capabilityPromptIndex(text: string): number {
  let first = -1;
  for (const prompt of HOST_CAPABILITY_PROMPTS) {
    const at = text.indexOf(prompt);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  return first;
}

/** The single host capability note for a model's declared inputs. */
export function capabilityPromptFor(capabilities?: ModelCapabilities | null): string {
  if (!capabilities) return HOST_UNKNOWN_CAPABILITY_PROMPT;
  return capabilities.vision ? HOST_VISION_PROMPT : HOST_TEXT_ONLY_PROMPT;
}

/**
 * The interaction tools' standing policy.
 *
 * Their descriptions already say what they do; this block is the behavioral
 * half that must not drift with a single tool's wording — and the one thing a
 * tool description cannot say from inside the tool: the checklist is not the
 * user's planner. Without that line the model writes "remind me tomorrow" into
 * a list that dies with the turn, or plans its own work inside the 事项
 * plugin's persistent store.
 */
export function buildInteractionPrompt(toolNames?: ReadonlySet<string>): string {
  // No set = the caller does not know the tool list (tests, a bare loader);
  // describe both rather than silently dropping policy.
  const hasTodo = toolNames ? toolNames.has(TODO_TOOL_NAME) : true;
  const hasAsk = toolNames ? toolNames.has(ASK_TOOL_NAME) : true;

  // Name the planner tool only when it is actually in the list: telling the
  // model to call `item_add` on a machine without that plugin invites a
  // nonexistent tool call.
  const plannerHint =
    !toolNames || toolNames.has('item_add')
      ? 'use the planner plugin (`item_add`) instead'
      : "use the user's planner/reminder plugin instead, if one is available";

  const parts: string[] = [];
  if (hasTodo) {
    parts.push(
      '`todotool` keeps the working checklist for a task that needs three or more steps or spans multiple files: ' +
        'write it before the first step, keep exactly one item in_progress, and mark an item completed only after ' +
        'verifying it. When the task ends, leave no item pending or in_progress. That checklist is your own ' +
        `working memory for this task — it is NOT the user's planner; when the user asks you to remember, ` +
        `schedule, or be reminded of something, ${plannerHint}.`,
    );
  }
  if (hasAsk) {
    parts.push(
      '`asktool` asks the user questions and waits for the answer: use it only when a decision you cannot make ' +
        'blocks progress, batch everything you need into one call, and never re-ask a question the user skipped.',
    );
  }
  return parts.join(' ');
}

/**
 * The host's own contribution to `appendSystemPrompt`, in the order the SDK
 * receives it.
 *
 * A single builder because two callers need the same list and must not drift:
 * session creation, and the context reader that reports what is in the prompt.
 * The list is supplied by *us*, not by the SDK's defaults — a bare
 * `DefaultResourceLoader` returns an empty `getAppendSystemPrompt()`, which is
 * exactly how the reader first reported these segments as costing nothing.
 */
/** The names the model will actually see, for prompt/context decisions. */
function toolNamesOf(tools: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    const name = (tool as { name?: unknown } | null)?.name;
    if (typeof name === 'string') names.add(name);
  }
  return names;
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.filter((name) => typeof name === 'string' && name.trim()))];
}

function sameNames(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((name) => set.has(name));
}

export function buildHostAppendSystemPrompt(
  pluginDocs: string,
  toolNames?: ReadonlySet<string>,
  capabilities?: ModelCapabilities | null,
): string[] {
  const interaction = buildInteractionPrompt(toolNames);
  // A switched-off tool is absent from the tool list AND from this block: the
  // model should not be told about a capability the user turned off.
  return [
    capabilityPromptFor(capabilities),
    ...(interaction ? [interaction] : []),
    ...(pluginDocs ? [pluginDocs] : []),
  ];
}

/**
 * Build the loader's `appendSystemPromptOverride`.
 *
 * Deliberately NOT `appendSystemPrompt`: passing the array sets the loader's
 * `appendSystemPromptSource`, and the loader only falls back to discovering
 * `APPEND_SYSTEM.md` when that source is absent. So the direct form makes the
 * user's own append file silently inert — it exists on disk, reads fine, and
 * never reaches the prompt. The override form is handed whatever was
 * discovered and returns the final list, so both survive.
 *
 * Host segments come first and the user's file after: the vision line and the
 * plugin index are host metadata, while the append file is the user's own
 * instruction and reads as the last thing added.
 */
export function buildAppendSystemPromptOverride(
  pluginDocs: string,
  toolNames?: ReadonlySet<string>,
  capabilities?: ModelCapabilities | null,
): (discovered: string[]) => string[] {
  return (discovered) => [
    ...buildHostAppendSystemPrompt(pluginDocs, toolNames, capabilities),
    ...discovered,
  ];
}

export interface RealChatServiceOptions {
  customToolsProvider?: () => unknown[];
  /** Enabled plugins' PLUGIN.md index. Read per session, so installs take effect without a restart. */
  pluginDocsProvider?: () => PluginDoc[];
  /**
   * Called once for every agent session this service creates (including
   * rebuilds after a workspace/skill change). Lets the host install
   * process-level hooks on the raw session — e.g. a permission gate that
   * wraps `session.agent.beforeToolCall`. Receives the resolved session key
   * ('default' when the caller had no session id yet).
   */
  onSessionCreated?: (session: AgentSession, info: { sessionKey: string; cwd: string }) => void;
  /**
   * Settings → 工具 switches. Applied on every session creation, on top of the
   * per-conversation list, so a globally disabled tool can never be re-enabled
   * by a stale renderer.
   */
  getGlobalDisabledTools?: () => string[];
}

export function createRealChatService(
  cwd: string,
  modelRuntime?: ModelRuntime,
  settingsManager?: SettingsManager,
  options?: RealChatServiceOptions,
): ChatService {
  const activeSessions = new Map<
    string,
    {
      session: AgentSession;
      unsubscribe: () => void;
      cwd: string;
      skills?: string[];
      disabledTools?: string[];
      /** The model capability the standing prompt was built for. */
      capabilityKey?: 'vision' | 'text' | 'unknown';
    }
  >();
  /**
   * Sessions that were invalidated while a run was in progress. They stay
   * cached (a second AgentSession over the same transcript would race the
   * first) and are rebuilt the first time the run is idle again.
   */
  const staleSessions = new Set<string>();
  // Track last message end time per session for thinking time calculation
  const sessionTimings = new Map<string, number>();

  // Shared ModelRuntime — picks up built-in models + models from ~/.pi/agent/models.json.
  // pi 1.x resolves models/auth through ModelRuntime (async); the registry is a
  // synchronous read facade over it, created on first use.
  let runtimePromise: Promise<ModelRuntime> | undefined = modelRuntime
    ? Promise.resolve(modelRuntime)
    : undefined;
  let registry: ModelRegistry | undefined;

  async function modelAccess(): Promise<{ runtime: ModelRuntime; registry: ModelRegistry }> {
    runtimePromise ??= getSharedModelRuntime();
    const runtime = await runtimePromise;
    registry ??= createModelRegistry(runtime);
    return { runtime, registry };
  }

  /** Find a model among the available ones by its ID string.
   *  Supports "provider/modelId" format for disambiguation.
   *  When multiple models share the same ID, prefers models with configured
   *  auth (from models.json or env vars) over built-in ones without auth. */
  function findModelById(modelId: string, available: ReturnType<ModelRegistry['getAvailable']>) {
    // An aggregator provider may name its model "deepseek/deepseek-flash", so
    // the id itself can contain a slash. Splitting first would read "deepseek"
    // as a provider and look up an id that does not exist. An exact id match
    // must win; the "provider/modelId" split stays as the fallback for the
    // case it was actually written for (disambiguating a bare id).
    const exact = available.find((m) => m.id === modelId);
    if (exact) return exact;

    const slashIdx = modelId.lastIndexOf('/');
    if (slashIdx > 0) {
      const provider = modelId.substring(0, slashIdx);
      const id = modelId.substring(slashIdx + 1);
      return available.find((m) => m.id === id && m.provider === provider);
    }
    return undefined;
  }

  /** Convert SDK Usage to our TokenUsage format */
  function sdkUsageToTokenUsage(usage: any): TokenUsage {
    return {
      inputTokens: usage.input ?? 0,
      outputTokens: usage.output ?? 0,
      totalTokens: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
      cacheReadTokens: usage.cacheRead ?? 0,
      cacheWriteTokens: usage.cacheWrite ?? 0,
      cost: usage.cost?.total ?? 0,
    };
  }

  // extractThinkContent is imported from ../utils/think-parser.js
  // so the streaming adapter and the session loader share one implementation.
  // detectWrittenFiles and getMimeType are imported from ../utils/file-detection.js

  async function createResourceLoader(
    workCwd: string,
    selectedSkillIds?: string[],
    toolNames?: ReadonlySet<string>,
    capabilities?: ModelCapabilities | null,
  ) {
    // Read at session creation, not cached: enabling a plugin takes effect on
    // the next conversation instead of needing an app restart.
    const pluginDocs = formatPluginDocsForPrompt(options?.pluginDocsProvider?.() ?? []);
    const resourceLoader = new DefaultResourceLoader({
      cwd: workCwd,
      agentDir: getAgentDir(),
      appendSystemPromptOverride: buildAppendSystemPromptOverride(pluginDocs, toolNames, capabilities),
      skillsOverride: selectedSkillIds
        ? (base) => {
            const enabledNames = new Set(
              selectedSkillIds.map((id) => id.startsWith('skill-') ? id.slice(6) : id),
            );
            return {
              skills: base.skills.filter((s) => enabledNames.has(s.name)),
              diagnostics: base.diagnostics,
            };
          }
        : undefined,
    });
    await resourceLoader.reload();
    return resourceLoader;
  }

  async function getOrCreateAgentSession(
    sessionId?: string,
    workspaceCwd?: string,
    skills?: string[],
    capabilities?: ModelCapabilities | null,
  ): Promise<AgentSession> {
    const key = sessionId || 'default';
    const workCwd = workspaceCwd || cwd;
    // undefined means "the caller has no opinion" (steer/followUp and other
    // post-creation calls); null means "explicitly unknown" (a send without a
    // model id). Only a real key may invalidate a cached session.
    //
    // A stale rebuild can be triggered by a steer, which passes no
    // capabilities. Recover them from the session being replaced BEFORE it is
    // dropped; otherwise the rebuilt loader falls back to the neutral prompt
    // even though the session's model is still known.
    let effectiveCapabilities = capabilities;
    const stale = activeSessions.get(key);
    if (stale && staleSessions.has(key) && !stale.session.isStreaming) {
      if (effectiveCapabilities === undefined && stale.session.model) {
        effectiveCapabilities = modelCapabilitiesOf(stale.session.model) ?? null;
      }
      try { stale.unsubscribe(); } catch { /* best-effort */ }
      activeSessions.delete(key);
      staleSessions.delete(key);
    }
    const capabilityKey: 'vision' | 'text' | 'unknown' | undefined =
      effectiveCapabilities === undefined
        ? undefined
        : effectiveCapabilities === null
          ? 'unknown'
          : effectiveCapabilities.vision
            ? 'vision'
            : 'text';

    // Tool availability is a global setting only. Settings → 工具 is the single
    // source; there is no per-conversation tool list (a stable set also keeps
    // the prompt cache warm).
    const effectiveDisabled = uniqueNames(options?.getGlobalDisabledTools?.() ?? []);

    // If a cached session exists, return it directly unless the caller provided
    // an explicit workspaceCwd that differs from the session's cwd (e.g. user
    // switched workspaces), skills changed, or the tool set changed. steer/
    // followUp/navigateTree don't pass these, so they safely reuse the session.
    const cached = activeSessions.get(key);
    if (cached) {
      const skillsChanged = skills && !cached.skills
        ? true
        : skills && cached.skills
          ? skills.length !== cached.skills.length || !skills.every((s) => cached.skills!.includes(s))
          : false;
      // Rebuild when the global tool switches changed — but never under a live
      // run: a steer/followUp would otherwise construct a second writer on the
      // same transcript. After the run ends, the next request rebuilds.
      const toolsChanged =
        !cached.session.isStreaming &&
        !sameNames(cached.disabledTools ?? [], effectiveDisabled);
      // A model switch changes the standing capability note. Rebuild only when
      // idle: a steer must not construct a second writer mid-run, and the
      // current turn may keep the old (still accurate for that run) prompt.
      const capabilityChanged =
        capabilityKey !== undefined &&
        cached.capabilityKey !== capabilityKey &&
        !cached.session.isStreaming;
      if (
        (!workspaceCwd || cached.cwd === workspaceCwd) &&
        !skillsChanged &&
        !toolsChanged &&
        !capabilityChanged
      ) {
        return cached.session;
      }
      // cwd / skills / tools / capabilities mismatch — tear down and create a new session
      cached.unsubscribe();
      activeSessions.delete(key);
    }
    let sessionManager: SessionManager;

    if (sessionId) {
      // Open existing session
      sessionManager = SessionManager.open(sessionId, undefined, workCwd);
    } else {
      // Create new session
      sessionManager = SessionManager.create(workCwd);
    }

    // One call, used twice: the tool list and the interaction paragraph that
    // describes its two host tools must agree even when a switch turned one off.
    const customTools = options?.customToolsProvider?.() ?? [];
    const toolNames = toolNamesOf(customTools);
    for (const name of effectiveDisabled) toolNames.delete(name);

    // `tools` is an ALLOWLIST in the SDK, not just "which built-ins to switch
    // on": `createAgentSession` turns it into `allowedToolNames`, and
    // `_refreshToolRegistry` filters custom tools through the same set. Passing
    // only the built-ins therefore silently dropped every plugin tool and every
    // host tool (asktool / todotool / context audit) from the model's list —
    // the agent reported "Tool browser_show not found" while the host's own
    // aggregate still listed it. So: built-ins we want ON, plus every custom
    // tool the providers contributed. Disabled names still come off via
    // `excludeTools`, which is the denylist for both families.
    const { runtime } = await modelAccess();
    const { session } = await createAgentSession({
      cwd: workCwd,
      sessionManager,
      modelRuntime: runtime, // share the runtime so custom models are visible
      resourceLoader: await createResourceLoader(workCwd, skills, toolNames, effectiveCapabilities),
      settingsManager,         // share settings so shell path is respected
      tools: [...ACTIVE_BUILTIN_TOOLS, ...toolNames],
      customTools: customTools as never,
      // `createAgentSession` calls this denylist `excludeTools` (the lower
      // AgentSessionConfig names it `excludedToolNames`); it applies to
      // built-ins and custom tools alike.
      excludeTools: effectiveDisabled.length > 0 ? effectiveDisabled : undefined,
    });

    // Host-level per-session hooks (permission gate, audit, …). Runs before the
    // session is cached so the gate is live for the very first prompt.
    options?.onSessionCreated?.(session, { sessionKey: key, cwd: workCwd });

    const unsubscribe = session.subscribe((_event) => {
      // Events are handled at the call site level
    });

    activeSessions.set(key, {
      session,
      unsubscribe,
      cwd: workCwd,
      skills,
      disabledTools: effectiveDisabled,
      capabilityKey: capabilityKey ?? 'unknown',
    });
    return session;
  }

  // ── Standing context (plugin capability: agent.context.config.read) ──

  /**
   * Approximate token count for a block of text.
   *
   * Deliberately crude: no API attributes real token cost to a prompt section,
   * so every number derived here is an estimate and callers must present it as
   * one. ~4 chars/token is the usual rule of thumb and is close enough for the
   * question these numbers actually answer — who is eating the budget.
   */
  function estimateTextTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  function isInside(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  function classifyContextFile(filePath: string, workspacePath: string): ContextFileScope {
    if (isInside(filePath, getAgentDir())) return 'global';
    if (isInside(filePath, workspacePath)) return 'workspace';
    return 'ancestor';
  }

  /** Shape of the SDK's ToolInfo / AgentCustomTool, narrowed to what we report. */
  type AnyTool = {
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
    /** Present on plugin-contributed tools; absent on the SDK's own. */
    pluginId?: unknown;
  };

  function toToolInfo(tool: AnyTool, fallbackSource: string): AgentToolInfo {
    return {
      name: String(tool.name ?? ''),
      description: typeof tool.description === 'string' ? tool.description : undefined,
      source: fallbackSource,
      schemaBytes: JSON.stringify(tool.parameters ?? {}).length,
    };
  }

  /**
   * The built-in tool names for when no live session is available to ask.
   * `getAllTools()` is authoritative but needs a session; this is the set the
   * session is created with, so the two agree.
   */
  const DEFAULT_BUILTIN_TOOLS = ACTIVE_BUILTIN_TOOLS;

  /**
   * The SDK's prompt-file discovery, mirrored.
   *
   * `discoverSystemPromptFile()` / `discoverAppendSystemPromptFile()` are
   * private on the loader, so the rule is restated here: a file under
   * `<cwd>/.pi/` shadows the global one under the agent dir, and only the
   * winner is read. Reporting the loser too is the point — a shadowed global
   * file looks like it should be in effect and silently is not.
   */
  const PROMPT_CONFIG_DIR = '.pi';

  function discoverPromptPaths(cwd: string): {
    system: { global: string; project: string };
    append: { global: string; project: string };
  } {
    const agentDir = getAgentDir();
    return {
      system: {
        global: path.join(agentDir, 'SYSTEM.md'),
        project: path.join(cwd, PROMPT_CONFIG_DIR, 'SYSTEM.md'),
      },
      append: {
        global: path.join(agentDir, 'APPEND_SYSTEM.md'),
        project: path.join(cwd, PROMPT_CONFIG_DIR, 'APPEND_SYSTEM.md'),
      },
    };
  }

  function readPromptFile(kind: 'system' | 'append', scope: 'global' | 'project', filePath: string): PromptFileInfo {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const stat = statSync(filePath);
      return {
        kind,
        scope,
        path: filePath,
        exists: true,
        active: false,
        content,
        bytes: Buffer.byteLength(content, 'utf-8'),
        chars: content.length,
        mtimeMs: stat.mtimeMs,
      };
    } catch {
      return {
        kind,
        scope,
        path: filePath,
        exists: false,
        active: false,
        content: null,
        bytes: 0,
        chars: 0,
        mtimeMs: 0,
      };
    }
  }

  /** Both scopes for both kinds, with the winner of each pair marked active. */
  function collectPromptFiles(cwd: string): PromptFileInfo[] {
    const paths = discoverPromptPaths(cwd);
    const out: PromptFileInfo[] = [];
    for (const kind of ['system', 'append'] as const) {
      const pair = [readPromptFile(kind, 'project', paths[kind].project), readPromptFile(kind, 'global', paths[kind].global)];
      const winner = pair.find((f) => f.exists);
      if (winner) winner.active = true;
      out.push(...pair);
    }
    return out;
  }

  /**
   * Read one file in the agent dir, tolerating absence.
   *
   * Kept separate from `readPromptFile` because these rows also carry the
   * shadowed AGENTS.md candidates, which are a fact about the whole directory
   * rather than about one file.
   */
  function readGlobalFile(
    kind: GlobalContextFile['kind'],
    filePath: string,
    shadowed: string[] = [],
  ): GlobalContextFile {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const st = statSync(filePath);
      return {
        kind,
        path: filePath,
        exists: true,
        content,
        bytes: Buffer.byteLength(content, 'utf-8'),
        chars: content.length,
        mtimeMs: st.mtimeMs,
        shadowed,
      };
    } catch {
      return {
        kind,
        path: filePath,
        exists: false,
        content: null,
        bytes: 0,
        chars: 0,
        mtimeMs: 0,
        shadowed,
      };
    }
  }

  /**
   * The global files Settings → 上下文 edits.
   *
   * The agent dir is outside every workspace, so this is the only reader for
   * them. AGENTS.md follows the SDK's candidate order; the variants that lose
   * are reported so the page can say why editing one would do nothing.
   */
  function getGlobalContextInfo(): GlobalContextInfo {
    const agentDir = getAgentDir();
    const candidates = GLOBAL_CONTEXT_NAMES.map((name) => path.join(agentDir, name));
    const existing = candidates.filter((p) => existsSync(p));
    const active = existing[0] ?? candidates[0];
    return {
      agentDir,
      files: [
        readGlobalFile('system', path.join(agentDir, 'SYSTEM.md')),
        readGlobalFile('append', path.join(agentDir, 'APPEND_SYSTEM.md')),
        readGlobalFile('agents', active, existing.slice(1)),
      ],
    };
  }

  async function readAgentContextConfig(
    workspacePath: string,
    workspaceId?: string,
    sessionId?: string,
  ): Promise<AgentContextConfig> {
    const resolvedWorkspace = path.resolve(workspacePath);
    // The appended segments are the host's own list, not an SDK default — a bare
    // loader reports none. Built through the same helper session creation uses,
    // so what this reports is what the model actually receives.
    const pluginDocsBlock = formatPluginDocsForPrompt(options?.pluginDocsProvider?.() ?? []);
    const toolNames = toolNamesOf(options?.customToolsProvider?.() ?? []);
    // The standing-context reader has no conversation in hand; it can only
    // subtract the global switches, not a per-conversation choice.
    for (const name of options?.getGlobalDisabledTools?.() ?? []) toolNames.delete(name);
    const interactionPrompt = buildInteractionPrompt(toolNames);

    // A live session for this workspace is the only source of the assembled
    // prompt: the SDK's buildSystemPrompt is not exported, so the built-in base
    // prompt cannot be reproduced without one. Prefer the exact conversation:
    // tool sets are per conversation now, so "first session in this workspace"
    // can report another one's tools.
    let live: AgentSession | undefined = sessionId
      ? activeSessions.get(sessionId)?.session
      : undefined;
    if (!live) {
      for (const cached of activeSessions.values()) {
        if (path.resolve(cached.cwd) === resolvedWorkspace) {
          live = cached.session;
          break;
        }
      }
    }

    // The standing capability note is chosen from the conversation's model;
    // with no live session we cannot know it, so the neutral variant is shown.
    const capabilities = live?.model ? modelCapabilitiesOf(live.model) : undefined;
    const hostSegments = buildHostAppendSystemPrompt(pluginDocsBlock, toolNames, capabilities);
    const loader = new DefaultResourceLoader({
      cwd: resolvedWorkspace,
      agentDir: getAgentDir(),
      appendSystemPromptOverride: buildAppendSystemPromptOverride(pluginDocsBlock, toolNames, capabilities),
    });
    await loader.reload();

    // ── appended segments (host vision line + plugin index + the user's own
    // APPEND_SYSTEM.md, in the order the override builds them) ──
    const promptFiles = collectPromptFiles(resolvedWorkspace);
    const appended: AppendSegmentInfo[] = loader.getAppendSystemPrompt().map((text) => {
      // Identify host segments by content, not by position: the interaction
      // paragraph is absent when both tools are switched off, and an index-based
      // label would then claim the plugin index was something else.
      if (isHostCapabilityPrompt(text)) {
        return { label: '模型能力说明', source: 'host' as const, text, chars: text.length };
      }
      if (interactionPrompt && text === interactionPrompt) {
        return { label: '交互工具说明', source: 'host' as const, text, chars: text.length };
      }
      if (pluginDocsBlock && text === pluginDocsBlock) {
        return { label: '插件索引', source: 'plugin-docs' as const, text, chars: text.length };
      }
      return { label: '追加提示词', source: 'user-append' as const, text, chars: text.length };
    });

    // ── context files (global AGENTS.md + every ancestor of the workspace) ──
    const contextFiles: ContextFileInfo[] = loader.getAgentsFiles().agentsFiles.map((file) => {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(file.path).mtimeMs;
      } catch {
        // Vanished between discovery and here. Left at 0 so a write from the
        // panel is refused instead of silently recreating the file.
      }
      return {
        path: file.path,
        scope: classifyContextFile(file.path, resolvedWorkspace),
        bytes: Buffer.byteLength(file.content, 'utf-8'),
        chars: file.content.length,
        content: file.content,
        mtimeMs,
      };
    });

    // ── skills ──
    const skillList = loader.getSkills().skills;
    const renderedSkills = formatSkillsForPrompt(skillList);
    const skills = {
      items: skillList.map((s) => ({
        name: s.name,
        description: s.description,
        path: s.filePath,
        chars: (s.description ?? '').length,
      })),
      rendered: renderedSkills,
      chars: renderedSkills.length,
    };

    // ── tools ──
    // The SDK's own tool list carries no notion of which plugin contributed a
    // tool, so attribution comes from the aggregate: a name → plugin index built
    // once and used on both paths. Without it every plugin tool would be
    // reported as built-in, which is exactly the number this panel exists to
    // break down.
    const pluginTools = (options?.customToolsProvider?.() ?? []) as AnyTool[];
    const pluginOf = new Map<string, string>();
    for (const tool of pluginTools) {
      if (typeof tool.pluginId === 'string') pluginOf.set(String(tool.name ?? ''), tool.pluginId);
    }

    const tools: AgentToolInfo[] = [];
    if (live) {
      for (const tool of live.getAllTools()) {
        const name = String((tool as AnyTool).name ?? '');
        tools.push(toToolInfo(tool as AnyTool, pluginOf.get(name) ?? 'builtin'));
      }
    } else {
      // No live session: report the standing set, minus the global switches.
      // (Per-conversation exclusions need a conversation, so they are not
      // knowable here.)
      const globalDisabled = new Set(options?.getGlobalDisabledTools?.() ?? []);
      for (const name of DEFAULT_BUILTIN_TOOLS) {
        if (globalDisabled.has(name)) continue;
        tools.push({ name, source: 'builtin', schemaBytes: 0 });
      }
      for (const tool of pluginTools) {
        const name = String(tool.name ?? '');
        if (globalDisabled.has(name)) continue;
        tools.push(toToolInfo(tool, typeof tool.pluginId === 'string' ? tool.pluginId : 'plugin'));
      }
    }

    // ── the assembled prompt, when a live session can hand it over ──
    const activeSystemFile = promptFiles.find((f) => f.kind === 'system' && f.active);
    let assembled: AgentContextConfig['assembled'] = null;
    // A SYSTEM.md is a file, so its text is readable with or without a session —
    // which makes the base prompt knowable in exactly the case where the user
    // replaced it. Only the SDK's own built-in text needs a session to reach.
    let baseText: string | null = activeSystemFile?.content ?? null;
    let baseNote = activeSystemFile
      ? '由你的 SYSTEM.md 提供。'
      : '尚未建立会话，读不到 SDK 内置的基础提示词正文。发一次消息后再打开本面板即可看到。';

    if (live) {
      const text = live.systemPrompt;
      assembled = { text, chars: text.length, tokensEst: estimateTextTokens(text) };
      // Anchor on the vision line: the append override places the host's segments
      // immediately after the base prompt, so everything before it is the base —
      // whether that is the SDK's built-in text or a SYSTEM.md replacing it.
      const anchor = capabilityPromptIndex(text);
      if (anchor > 0) {
        baseText = text.slice(0, anchor).trimEnd();
        baseNote = activeSystemFile
          ? '由你的 SYSTEM.md 提供，已在当前会话中生效。'
          : 'SDK 内置基础提示词。';
      } else if (!activeSystemFile) {
        baseText = null;
        baseNote = '已读到完整系统提示词，但基础段无法与追加段可靠切分，请以上方完整内容为准。';
      }
    }

    // ── plugin docs (what the appended index actually costs per plugin) ──
    const pluginDocs = (options?.pluginDocsProvider?.() ?? []).map((doc) => ({
      pluginId: doc.pluginId ?? '',
      name: doc.name,
      description: doc.description,
      path: doc.location,
      chars: doc.name.length + doc.description.length + doc.location.length,
    }));

    // ── totals ──
    const sectionChars =
      (baseText?.length ?? 0) +
      appended.reduce((n, s) => n + s.chars, 0) +
      contextFiles.reduce((n, f) => n + f.chars, 0) +
      skills.chars +
      tools.reduce((n, t) => n + t.schemaBytes, 0);
    const chars = assembled?.chars ?? sectionChars;
    const tokensEst = estimateTextTokens(
      assembled?.text ??
        [
          ...appended.map((s) => s.text),
          ...contextFiles.map((f) => f.content),
          skills.rendered,
        ].join('\n'),
    );

    const windowTokens = live?.model?.contextWindow;
    return {
      workspace: { id: workspaceId, path: resolvedWorkspace, name: path.basename(resolvedWorkspace) },
      agentDir: getAgentDir(),
      assembled,
      promptFiles,
      sections: {
        base: {
          text: baseText,
          chars: baseText?.length ?? null,
          note: baseNote,
          overridden: activeSystemFile !== undefined,
        },
        appended,
        contextFiles,
        skills,
        tools,
      },
      pluginDocs,
      totals: {
        chars,
        tokensEst,
        windowTokens,
        share: windowTokens ? Math.min(1, tokensEst / windowTokens) : undefined,
      },
    };
  }

  /**
   * Rebuild every live session in a workspace from disk.
   *
   * Context files are read when a session is built, so an AGENTS.md edit is
   * otherwise invisible until the user starts a new session. `session.reload()`
   * re-reads the resource loader and rebuilds the base prompt from it, which
   * makes the edit apply to the next turn.
   *
   * A workspace can have several live sessions (one per conversation, possibly
   * in different windows), and each has its own resource loader — rebuilding
   * only the first would leave the others on the old prompt.
   *
   * Refuses while anything is streaming: `reload()` resets global API providers
   * and tears down the extension runtime, which is not something to do under a
   * request that is already in flight. The caller surfaces the refusal instead
   * of the edit silently appearing to do nothing.
   */
  async function reloadAgentContext(workspacePath: string): Promise<AgentContextReloadResult> {
    const resolvedWorkspace = path.resolve(workspacePath);
    const live: AgentSession[] = [];
    for (const cached of activeSessions.values()) {
      if (path.resolve(cached.cwd) === resolvedWorkspace) live.push(cached.session);
    }
    // No session yet: the file is read when one is created, so the edit lands
    // on its own without anything to rebuild.
    if (live.length === 0) return { applied: false, reason: 'no-session' };

    for (const cached of activeSessions.values()) {
      if (cached.session.isStreaming) return { applied: false, reason: 'busy' };
    }

    for (const session of live) await session.reload();
    return { applied: true };
  }

  /**
   * Rebuild after a write, without letting a rebuild failure masquerade as a
   * failed write.
   *
   * By the time this runs the file is already on disk. If `reload()` throws, the
   * edit happened and only *applying* it did not — reporting the whole operation
   * as failed would send the user looking for a problem that isn't there, and
   * likely re-editing a file that is already correct.
   */
  async function reloadAfterWrite(workspacePath: string): Promise<AgentContextReloadResult> {
    try {
      return await reloadAgentContext(workspacePath);
    } catch (err) {
      return {
        applied: false,
        reason: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Rebuild any live session whose standing context was just edited through an
   * ordinary file write.
   *
   * The file viewer and other plugins write through `filesystem.write`, which
   * knows nothing about agent context. Without this, saving `.pi/SYSTEM.md` in
   * the file tree looks like it did nothing until a new session is created —
   * there is no host editor writing through its own API any more. Called after
   * every plugin write/delete; the filename check keeps the cost to a few
   * string comparisons for ordinary files.
   */
  async function reloadAgentContextForFile(
    filePath: string,
    preferredWorkspace?: string,
  ): Promise<AgentContextReloadResult> {
    const resolvedFile = path.resolve(filePath);
    const fileDir = path.dirname(resolvedFile);
    const name = path.basename(resolvedFile);
    const isPromptName = name === 'SYSTEM.md' || name === 'APPEND_SYSTEM.md';
    const isContextName = (GLOBAL_CONTEXT_NAMES as readonly string[]).includes(name);
    if (!isPromptName && !isContextName) return { applied: false, reason: 'no-session' };

    const agentDir = path.resolve(getAgentDir());
    // A global prompt/context file is read by every workspace.
    const affectsEveryWorkspace = fileDir === agentDir;

    const targets = new Set<string>();
    for (const cached of activeSessions.values()) {
      const cwd = path.resolve(cached.cwd);
      let hit = affectsEveryWorkspace;
      if (!hit && isPromptName) {
        hit = fileDir === path.join(cwd, PROMPT_CONFIG_DIR);
      }
      if (!hit && isContextName) {
        // The loader reads a context file from the workspace and from every
        // ancestor directory, so a write anywhere on that chain matters.
        let dir = cwd;
        for (;;) {
          if (dir === fileDir) {
            hit = true;
            break;
          }
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      }
      if (hit) targets.add(cwd);
    }

    const results = new Map<string, AgentContextReloadResult>();
    for (const cwd of targets) results.set(cwd, await reloadAfterWrite(cwd));

    if (preferredWorkspace) {
      return (
        results.get(path.resolve(preferredWorkspace)) ?? {
          applied: false,
          reason: 'no-session',
        }
      );
    }
    return results.values().next().value ?? { applied: false, reason: 'no-session' };
  }

  return {
    /** Tear down all cached sessions so the next prompt rebuilds them
     *  (used when the plugin tool/skill set changes at runtime). */
    invalidateSessions(): void {
      for (const [key, cached] of activeSessions) {
        // A busy session must survive: dropping it lets the next steer build a
        // second AgentSession over the same transcript, with two writers.
        if (cached.session.isStreaming) {
          staleSessions.add(key);
          continue;
        }
        try { cached.unsubscribe(); } catch { /* best-effort */ }
        activeSessions.delete(key);
        staleSessions.delete(key);
      }
    },

    getAgentContextConfig(
      workspacePath: string,
      workspaceId?: string,
      sessionId?: string,
    ): Promise<AgentContextConfig> {
      return readAgentContextConfig(workspacePath, workspaceId, sessionId);
    },

    reloadAgentContext(workspacePath: string): Promise<AgentContextReloadResult> {
      return reloadAgentContext(workspacePath);
    },

    getGlobalContextInfo(): Promise<GlobalContextInfo> {
      return Promise.resolve(getGlobalContextInfo());
    },

    reloadAgentContextForFile(
      filePath: string,
      preferredWorkspace?: string,
    ): Promise<AgentContextReloadResult> {
      return reloadAgentContextForFile(filePath, preferredWorkspace);
    },

    async writeContextFile({ workspacePath, path: filePath, content, expectedMtime }) {
      // Guard first: a refused write must not leave a half-applied reload.
      const file = writeFileWithMtimeGuard(filePath, content, expectedMtime);
      // Path-based rather than workspace-based: a global file affects every
      // live workspace, and the caller's workspace is only the one whose
      // outcome the UI reports. No workspace open still writes — the next
      // session reads it from disk.
      return {
        file,
        reload: await reloadAgentContextForFile(filePath, workspacePath),
      };
    },

    async deleteContextFile({ workspacePath, path: filePath, expectedMtime }) {
      const deleted = deleteFileWithMtimeGuard(filePath, expectedMtime);
      return {
        deleted,
        reload: await reloadAgentContextForFile(filePath, workspacePath),
      };
    },

    async sendMessage(params: SendMessageParams): Promise<Message> {
      // Refresh the registry BEFORE the session is built: the standing prompt
      // depends on the requested model's input modalities, and a model added
      // to models.json since startup must be resolvable here.
      migrateModelsConfig();
      const { registry } = await modelAccess();
      await registry.refresh();
      const requestedModel = params.modelId ? findModelById(params.modelId, registry.getAvailable()) : undefined;
      if (params.modelId && !requestedModel) {
        throw new Error(`Model "${params.modelId}" not found. Please configure a valid model in Settings or set the correct API key environment variable.`);
      }
      const session = await getOrCreateAgentSession(
        params.sessionId,
        params.workspaceCwd,
        params.skills,
        requestedModel ? modelCapabilitiesOf(requestedModel) : null,
      );

      try {
        if (requestedModel) await session.setModel(requestedModel);

        const images = params.attachments?.length
          ? params.attachments
              .filter((a) => a.mimeType.startsWith('image/') && a.data)
              .map((a) => ({
                type: 'image' as const,
                data: a.data,
                mimeType: a.mimeType,
              }))
          : undefined;
        await session.prompt(params.content, images?.length ? { images } : undefined);

      // Get session stats for cost/usage on the returned message
      let totalUsage: TokenUsage | undefined;
      try {
        const stats = session.getSessionStats();
        totalUsage = {
          inputTokens: stats.tokens.input,
          outputTokens: stats.tokens.output,
          totalTokens: stats.tokens.total,
          cacheReadTokens: stats.tokens.cacheRead,
          cacheWriteTokens: stats.tokens.cacheWrite,
          cost: stats.cost,
        };
      } catch { /* stats are best-effort */ }

      const asstMsg: AssistantMessage = {
        id: `msg-${Date.now()}-asst`,
        sessionId: params.sessionId,
        role: 'assistant',
        status: 'complete',
        modelId: params.modelId ?? 'unknown',
        content: session.getLastAssistantText() || '',
        blocks: [],
        usage: totalUsage,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      return asstMsg;
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : 'Failed to send message');
      }
    },

    async sendMessageStream(
      params: SendMessageParams,
      onChunk: (chunk: StreamChunk) => void,
      signal?: AbortSignal,
    ): Promise<Message> {
      // Same ordering as sendMessage: refresh, resolve the requested model,
      // then build the session with that model's capability note.
      migrateModelsConfig();
      const { registry } = await modelAccess();
      await registry.refresh();
      const requestedModel = params.modelId ? findModelById(params.modelId, registry.getAvailable()) : undefined;
      if (params.modelId && !requestedModel) {
        const errMsg = `Model "${params.modelId}" not found. Please configure a valid model in Settings or set the correct API key environment variable.`;
        onChunk({ type: 'error', error: errMsg });
        throw new Error(errMsg);
      }
      const session = await getOrCreateAgentSession(
        params.sessionId,
        params.workspaceCwd,
        params.skills,
        requestedModel ? modelCapabilitiesOf(requestedModel) : null,
      );
      const sessionKey = params.sessionId || 'default';
      const workspaceCwd = params.workspaceCwd;

      // Guard to prevent writing to a closed SSE stream
      let streamActive = true;
      const safeChunk = (chunk: StreamChunk) => {
        if (streamActive) {
          try { onChunk(chunk); } catch { /* ignore write-after-end */ }
        }
      };

      // Timing tracking
      let messageStartTime = 0;
      let messageEndTime = 0;
      let outputText = '';
      let thinkingBlockId: string | null = null; // stable ID per message turn
      let textBlockId: string | null = null; // stable ID per message turn
      const toolStartTimes = new Map<string, number>();
      const toolNames = new Map<string, string>();
  const toolArgs = new Map<string, Record<string, unknown>>();

      const unsubscribe = session.subscribe((event: any) => {
        // Skip sending chunks if stream is already closed
        if (!streamActive) return;
        switch (event.type) {
          case 'message_start': {
            messageStartTime = Date.now();
            thinkingBlockId = null; // reset for new turn
            textBlockId = null; // reset for new turn
            // Signal frontend that a new message group is starting,
            // so it creates fresh blocks instead of overwriting prior group.
            safeChunk({ type: 'message_start' });
            break;
          }
          case 'message_update': {
            const msg = event.message;
            if (msg && msg.content) {
              const content = msg.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text' && block.text) {
                    // block.text carries the full accumulated text, not a delta.
                    outputText = block.text;

                    // Extract <think>...</think> tags from text (Minimax, DeepSeek-R1).
                    // These models return thinking content as XML tags in the text stream
                    // rather than structured reasoning_content blocks.
                    const thinkResult = extractThinkContent(block.text);

                    // Emit thinking block when think content is present
                    if (thinkResult.thinking !== null) {
                      if (!thinkingBlockId) {
                        thinkingBlockId = `b-think-${Date.now()}`;
                      }
                      safeChunk({
                        type: 'block',
                        block: {
                          id: thinkingBlockId,
                          type: 'thinking',
                          content: thinkResult.thinking,
                          thinking: thinkResult.thinking,
                        },
                      });
                    }

                    // Always emit text block with think tags stripped (may be empty during thinking phase)
                    if (!textBlockId) textBlockId = `bt-stream-${Date.now()}`;
                    safeChunk({
                      type: 'block',
                      block: {
                        id: textBlockId,
                        type: 'text',
                        content: thinkResult.text,
                      },
                    });
                  } else if (block.type === 'image') {
                    // Image blocks in streaming — send as block for display
                    safeChunk({
                      type: 'block',
                      block: {
                        id: `b-img-${Date.now()}`,
                        type: 'image',
                        content: block.data || '',
                        mimeType: block.mimeType || 'image/png',
                        data: block.data || '',
                        width: block.width,
                        height: block.height,
                      },
                    });
                  } else if (block.type === 'thinking') {
                    if (!thinkingBlockId) {
                      thinkingBlockId = `b-think-${Date.now()}`;
                    }
                    safeChunk({
                      type: 'block',
                      block: {
                        id: thinkingBlockId,
                        type: 'thinking',
                        content: block.thinking || '',
                        thinking: block.thinking,
                      },
                    });
                  } else if (block.type === 'toolCall' || block.type === 'tool_call') {
                    // Only emit tool_call from message_update if it has a toolCallId.
                    // Without an ID we can't dedup against tool_execution_start blocks,
                    // which would cause duplicate empty entries.
                    if (!block.toolCallId) continue;
                    // block.input carries tool arguments from the SDK
                    const args = (block as any).input ?? (block as any).args;
                    // Store args for file detection in tool_execution_end
                    if (block.toolCallId && args) {
                      toolArgs.set(block.toolCallId, typeof args === 'object' ? args : undefined);
                    }
                    if (block.toolCallId && block.toolName) {
                      toolNames.set(block.toolCallId, block.toolName);
                    }
                    safeChunk({
                      type: 'block',
                      block: {
                        id: `b-tc-${Date.now()}`,
                        type: 'tool_call',
                        content: block.name || 'tool',
                        toolCallId: block.toolCallId,
                        toolName: block.name || block.toolName,
                        args: typeof args === 'object' && args !== null ? args : undefined,
                      },
                    });
                  }
                }
              } else if (typeof content === 'string') {
                outputText += content;
                safeChunk({ type: 'text', content });
              }
            }
            break;
          }
          case 'tool_execution_start': {
            toolStartTimes.set(event.toolCallId, Date.now());
            toolArgs.set(event.toolCallId, (event as any).args);
            toolNames.set(event.toolCallId, event.toolName);
            safeChunk({
              type: 'block',
              block: {
                id: `b-te-${Date.now()}`,
                type: 'tool_call',
                content: event.toolName || 'tool execution',
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: (event as any).args ?? undefined,
              },
            });
            break;
          }
          case 'tool_execution_end': {
            const startTime = toolStartTimes.get(event.toolCallId);
            const durationMs = startTime ? Date.now() - startTime : undefined;
            const storedArgs = toolArgs.get(event.toolCallId);
            toolStartTimes.delete(event.toolCallId);
            toolArgs.delete(event.toolCallId);
            const toolName = toolNames.get(event.toolCallId) ?? undefined;
            toolNames.delete(event.toolCallId);

            // event.result is { content: Array<{type, text}>, isError: boolean }
            // Extract text from content blocks for display
            const rawResult = (event as any).result;
            // Plugin message-renderer card tree (declarative chat cards).
            const cardTree = rawResult?.details?.card ?? undefined;
            let resultText: string;
            if (rawResult && typeof rawResult === 'object' && Array.isArray(rawResult.content)) {
              resultText = rawResult.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text || '')
                .join('\n');
            } else if (typeof rawResult === 'string') {
              resultText = rawResult;
            } else {
              resultText = String(rawResult ?? '');
            }

            safeChunk({
              type: 'block',
              block: {
                id: `b-ter-${Date.now()}`,
                type: 'tool_result',
                content: event.isError ? `Error: ${resultText}` : resultText || 'Done',
                toolCallId: event.toolCallId,
                toolName,
                result: resultText,
                card: cardTree,
                isError: (event as any).isError || rawResult?.isError || false,
              } as ToolResultBlock,
            });

            // Emit image blocks from tool result content
            if (rawResult && Array.isArray(rawResult.content)) {
              for (const c of rawResult.content as any[]) {
                if (c.type === 'image') {
                  safeChunk({
                    type: 'block',
                    block: {
                      id: `b-ter-img-${Date.now()}`,
                      type: 'image',
                      content: c.data || '',
                      mimeType: c.mimeType || 'image/png',
                      data: c.data || '',
                    },
                  });
                }
              }
            }

            // Emit file blocks for files written by tools
            const effectiveArgs = storedArgs || (event as any).args;
            if (!event.isError && effectiveArgs) {
              const writtenFiles = detectWrittenFiles(
                event.toolName,
                effectiveArgs,
                resultText,
                workspaceCwd,
              );
              for (const file of writtenFiles) {
                safeChunk({
                  type: 'block',
                  block: {
                    id: `b-ter-file-${file.relPath}`,
                    type: 'file',
                    content: path.basename(file.absPath),
                    mimeType: file.mimeType,
                    fileName: path.basename(file.absPath),
                    fileSize: file.size,
                    workspacePath: file.absPath,
                  },
                });
              }
            }

            // Emit tool timing
            if (durationMs !== undefined) {
              safeChunk({
                type: 'tool_timing',
                toolTiming: {
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  durationMs,
                },
              });
            }
            break;
          }
          case 'message_end': {
            messageEndTime = Date.now();
            // Surface API errors: the SDK records stopReason "error" +
            // errorMessage on the assistant message instead of throwing —
            // without this the UI shows an empty response with no feedback.
            const endMsg = event.message;
            if (endMsg?.stopReason === 'error') {
              safeChunk({
                type: 'error',
                error: endMsg.errorMessage || `Model request failed (${endMsg.provider ?? ''} ${endMsg.model ?? ''}). Check the provider baseUrl / API key in Settings.`,
              });
            }
            // Forward usage data from the completed message
            const msgUsage = endMsg?.usage;
            if (msgUsage) {
              const tokenUsage = sdkUsageToTokenUsage(msgUsage);
              safeChunk({ type: 'usage', usage: tokenUsage });

              // Calculate per-message timing metrics
              const prevEndTime = sessionTimings.get(sessionKey) ?? 0;
              const thinkingTimeMs = prevEndTime > 0 ? Math.max(0, messageStartTime - prevEndTime) : 0;
              const generationTimeMs = Math.max(1, messageEndTime - messageStartTime);
              const outputTokens = tokenUsage.outputTokens || 0;
              const estTokens = Math.ceil(outputText.length / 4);
              const tps = outputTokens / (generationTimeMs / 1000);

              safeChunk({
                type: 'message_timing',
                messageTiming: {
                  estTokens,
                  tps: Math.round(tps * 10) / 10,
                  thinkingTimeMs,
                  generationTimeMs,
                },
              });

              // Update last message end time for this session
              sessionTimings.set(sessionKey, messageEndTime);
            }
            break;
          }
          case 'agent_end': {
            // Agent ended (may retry or finalize)
            if (!event.willRetry) {
              // Send context usage before done
              try {
                const ctxUsage = session.getContextUsage();
                if (ctxUsage) {
                  safeChunk({
                    type: 'context',
                    contextUsage: {
                      tokens: ctxUsage.tokens,
                      contextWindow: ctxUsage.contextWindow,
                      percent: ctxUsage.percent,
                    },
                  });
                }
              } catch { /* best-effort */ }

              // Send session stats before done
              try {
                const stats = session.getSessionStats();
                const ctxUsage = stats.contextUsage ?? session.getContextUsage();
                safeChunk({
                  type: 'stats',
                  sessionStats: {
                    tokens: {
                      input: stats.tokens.input,
                      output: stats.tokens.output,
                      cacheRead: stats.tokens.cacheRead,
                      cacheWrite: stats.tokens.cacheWrite,
                      total: stats.tokens.total,
                    },
                    cost: stats.cost,
                    contextUsage: ctxUsage
                      ? { tokens: ctxUsage.tokens, contextWindow: ctxUsage.contextWindow, percent: ctxUsage.percent }
                      : undefined,
                  },
                });
              } catch { /* best-effort */ }

              safeChunk({ type: 'done' });
            }
            break;
          }
          case 'queue_update': {
            safeChunk({
              type: 'queue_update',
              queueState: {
                steering: Array.isArray(event.steering) ? event.steering : [],
                followUp: Array.isArray(event.followUp) ? event.followUp : [],
              },
            });
            break;
          }
        }
      });

      if (signal) {
        signal.addEventListener('abort', () => {
          streamActive = false;
          session.abort();
        }, { once: true });
      }

      try {
        if (requestedModel) await session.setModel(requestedModel);

        // Build image content array for vision models
        const images = params.attachments?.length
          ? params.attachments
              .filter((a) => a.mimeType.startsWith('image/') && a.data)
              .map((a) => ({
                type: 'image' as const,
                data: a.data,
                mimeType: a.mimeType,
              }))
          : undefined;

        await session.prompt(params.content, images?.length ? { images } : undefined);

        // Build final usage for returned message
        let totalUsage: TokenUsage | undefined;
        try {
          const stats = session.getSessionStats();
          totalUsage = {
            inputTokens: stats.tokens.input,
            outputTokens: stats.tokens.output,
            totalTokens: stats.tokens.total,
            cacheReadTokens: stats.tokens.cacheRead,
            cacheWriteTokens: stats.tokens.cacheWrite,
            cost: stats.cost,
          };
        } catch { /* stats are best-effort */ }

        const asstMsg: AssistantMessage = {
          id: `msg-${Date.now()}-asst`,
          sessionId: params.sessionId,
          role: 'assistant',
          status: 'complete',
          modelId: params.modelId ?? 'unknown',
          content: session.getLastAssistantText() || '',
          blocks: [],
          usage: totalUsage,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        streamActive = false;
        return asstMsg;
      } catch (err) {
        safeChunk({ type: 'error', error: err instanceof Error ? err.message : 'Unknown error' });
        throw err;
      } finally {
        streamActive = false;
        unsubscribe();
      }
    },

    async getMessages(sessionId: string, _limit?: number, _offset?: number): Promise<Message[]> {
      if (!sessionId) return [];

      try {
        const sm = SessionManager.open(sessionId);
        const entries = sm.getEntries();
        return entries
          .filter((e) => e.type === 'message')
          .map((e) => {
            const msg = (e as any).message;
            const timestamp = msg.timestamp
              ? new Date(msg.timestamp).toISOString()
              : new Date().toISOString();
            return {
              id: `msg-${sessionId}-${e.id}`,
              sessionId,
              role: msg.role === 'assistant' ? 'assistant' : msg.role === 'user' ? 'user' : 'system',
              status: 'complete',
              content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
              blocks: [],
              createdAt: timestamp,
              updatedAt: timestamp,
            } as Message;
          });
      } catch {
        return [];
      }
    },

    async stopGeneration(sessionId?: string): Promise<void> {
      if (sessionId) {
        const entry = activeSessions.get(sessionId);
        if (entry) {
          try { await entry.session.abort(); } catch { /* ignore */ }
          entry.unsubscribe();
          activeSessions.delete(sessionId);
          staleSessions.delete(sessionId);
        }
        return;
      }
      // Abort all active sessions (backward compatibility)
      for (const [, { session }] of activeSessions) {
        try {
          await session.abort();
        } catch { /* ignore */ }
      }
      activeSessions.clear();
      staleSessions.clear();
    },

    async steer(sessionId: string, content: string, images?: { name: string; mimeType: string; data: string }[]): Promise<void> {
      const session = await getOrCreateAgentSession(sessionId);
      await session.steer(content, images?.length ? images.map((img) => ({
        type: 'image' as const,
        data: img.data,
        mimeType: img.mimeType,
      })) : undefined);
    },

    async followUp(sessionId: string, content: string, images?: { name: string; mimeType: string; data: string }[]): Promise<void> {
      const session = await getOrCreateAgentSession(sessionId);
      await session.followUp(content, images?.length ? images.map((img) => ({
        type: 'image' as const,
        data: img.data,
        mimeType: img.mimeType,
      })) : undefined);
    },

    async navigateTree(sessionId: string, entryId: string, options?: { summarize?: boolean; customInstructions?: string; label?: string }): Promise<{ editorText?: string; cancelled: boolean }> {
      const session = await getOrCreateAgentSession(sessionId);
      const result = await session.navigateTree(entryId, options);
      return { editorText: result.editorText, cancelled: result.cancelled };
    },

    async compact(sessionId: string, customInstructions?: string) {
      const session = await getOrCreateAgentSession(sessionId);
      return session.compact(customInstructions);
    },
  };
}
