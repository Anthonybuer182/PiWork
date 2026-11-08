import { app, BrowserWindow, MessageChannelMain } from 'electron';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import type {
  CapabilityCallMessage,
  InstallPhase,
  InstallResult,
  MarketEntry,
  PluginEvent,
  PluginInfo,
  PluginToolContent,
  UiNode,
  PluginMessageData,
  PluginMessagePatch,
} from '@pi/types';
import { PLUGIN_PROTOCOL_VERSION } from '@pi/types';
import { PluginRegistry } from './registry';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { CapabilityHub } from './capability-hub';
import type { BrowserRouter } from './capability-hub';
import type { VlmAnalyzer } from '@main/browser/vlm-analyzer';
import { PluginProcess, spawnBackend } from './plugin-process';
import { takeToolSession } from './session-context';
import { registerPluginProtocolHandler } from './protocol';
import { PluginMarketplace } from './marketplace';
import type { AgentCustomTool } from '@main/agent-tools';
import { toolContracts } from '@main/tools/contracts';

/**
 * Where plugin events go now that there can be several windows. `sessionId`
 * null means "the focused window".
 */
export interface PluginEventSink {
  broadcast(channel: string, payload: unknown): void;
  sendToSession(sessionId: string | null, channel: string, payload: unknown): void;
  sendToFocused(channel: string, payload: unknown): void;
}

export { registerPluginSchemePrivileges, PI_PLUGIN_SCHEME } from './protocol';
export { PluginRegistry } from './registry';
export { PluginMarketplace, DEFAULT_REGISTRY_URL } from './marketplace';

/**
 * A plugin's own usage doc, in the shape the prompt index needs.
 *
 * Only these three fields reach the agent; the file's body is read on demand.
 */
export interface PluginDoc {
  name: string;
  pluginId: string;
  /** From PLUGIN.md's frontmatter — says WHEN to use the plugin, not what it is. */
  description: string;
  /** Absolute path to PLUGIN.md, for the agent to `read`. */
  location: string;
}

/**
 * Agent tool definition shape expected by createAgentSession({ customTools }).
 *
 * Defined in agent-tools.ts because the host contributes tools of its own now;
 * re-exported here for the plugin code that already refers to it.
 */
export type { AgentCustomTool };

/**
 * Facade wiring the plugin kernel together:
 * registry (discovery) + UtilityProcess backends + capability routing +
 * pi-plugin:// protocol + event fan-out to renderer windows.
 */
export class PluginSystem {
  readonly registry: PluginRegistry;
  readonly capabilityHub: CapabilityHub;
  readonly marketplace: PluginMarketplace;
  private processes = new Map<string, PluginProcess>();
  /** Active UI port pairs: `${pluginId}:${webContentsId}` — ensureUiPort is idempotent on these. */
  private uiPortKeys = new Map<string, boolean>();
  /**
   * WebContents we have already subscribed to navigation events, so the
   * per-document port reset below is installed exactly once per renderer.
   */
  private uiPortNavigating = new Set<number>();
  /** Notified whenever the aggregate tool/skill set changes. */
  onExtensionsChanged: (() => void) | null = null;
  /**
   * Notified after any plugin write/delete so the host can rebuild a live
   * session when the path was one of its prompt/context files. Assigned once
   * the chat service exists; the hub captures this lazily.
   */
  onContextFileWrite: ((filePath: string) => void) | null = null;
  /**
   * Append a plugin-originated message to a conversation (assigned once the
   * chat service exists). The capability hub calls this lazily; `messages` is
   * permission-gated and validated there.
   */
  appendPluginMessage:
    | ((sessionId: string, data: PluginMessageData) => Promise<{ entryId: string }>)
    | null = null;
  /** Append an update/tombstone revision of a plugin message (assigned with append). */
  updatePluginMessage:
    | ((
        sessionId: string,
        messageId: string,
        pluginId: string,
        patch: PluginMessagePatch,
      ) => Promise<{ entryId: string; revision: number }>)
    | null = null;
  removePluginMessage:
    | ((
        sessionId: string,
        messageId: string,
        pluginId: string,
      ) => Promise<{ entryId: string; revision: number }>)
    | null = null;
  /**
   * A plugin's backend just (re)started — activate, re-enable, or crash
   * restart. Panel views reused across those events hold ports to the dead
   * process; the host uses this to push fresh ones (see PluginWebViews.
   * rewirePluginPorts).
   */
  onBackendStarted: ((pluginId: string) => void) | null = null;
  /** Resolves when init() has finished — IPC handlers gate reads on this. */
  private initPromise: Promise<void> | null = null;
  /**
   * The conversation the renderer has on screen. A view fact only the renderer
   * holds (set-active-session); session-scoped backends resolve "the current
   * document/page" against it, and freshly spawned ones get it replayed —
   * broadcasts only reach processes that already run.
   */
  private activeSessionId: string | null = null;
  /** Renderer delivery; null falls back to broadcasting to every window. */
  private readonly eventSink?: PluginEventSink;
  /**
   * session → workspace, resolved once when the session is built.
   *
   * Deliberately not `windows.forSession(sessionId)`: that returns the
   * window's CURRENT workspace, and a window may switch workspace while a run
   * is in flight — the run would then be attributed to the new project. Null
   * when unknown, and a plugin must read null as "no workspace" rather than
   * guessing.
   */
  private readonly resolveSessionWorkspace?: (sessionId?: string) => string | null;

  constructor(opts?: {
    agentDir?: string;
    browserRouter?: BrowserRouter;
    vlmAnalyzer?: VlmAnalyzer;
    sendToRenderer?: (channel: string, payload: unknown) => void;
    getPermissionMode?: (sessionId: string) => 'default' | 'full';
    /** Whether the app's TTS is usable; exposed as the `voice` capability. */
    voiceReady?: () => { ok: boolean; error?: string };
    /** Renderer delivery for plugin events (one PluginEvent has one target). */
    eventSink?: PluginEventSink;
    /** session → workspace id; see `resolveSessionWorkspace`. */
    resolveSessionWorkspace?: (sessionId?: string) => string | null;
  }) {
    this.eventSink = opts?.eventSink;
    this.resolveSessionWorkspace = opts?.resolveSessionWorkspace;
    this.registry = new PluginRegistry({ ...opts, appVersion: app.getVersion() });
    this.capabilityHub = new CapabilityHub({
      registry: this.registry,
      emitEvent: (evt) => this.emitEvent(evt),
      browserRouter: opts?.browserRouter,
      vlmAnalyzer: opts?.vlmAnalyzer,
      sendToRenderer: opts?.sendToRenderer,
      getPermissionMode: opts?.getPermissionMode,
      voiceReady: opts?.voiceReady,
      // Lazy on purpose: the chat service is created after the kernel, and the
      // hook is only invoked by a later plugin write.
      onContextFileWrite: (filePath) => this.onContextFileWrite?.(filePath),
      appendPluginMessage: (sessionId, data) =>
        this.appendPluginMessage
          ? this.appendPluginMessage(sessionId, data)
          : Promise.reject(new Error('messages.post: no conversation store attached')),
      updatePluginMessage: (sessionId, messageId, pluginId, patch) =>
        this.updatePluginMessage
          ? this.updatePluginMessage(sessionId, messageId, pluginId, patch)
          : Promise.reject(new Error('messages.update: no conversation store attached')),
      removePluginMessage: (sessionId, messageId, pluginId) =>
        this.removePluginMessage
          ? this.removePluginMessage(sessionId, messageId, pluginId)
          : Promise.reject(new Error('messages.remove: no conversation store attached')),
      sendToSession: (sessionId, channel, payload) =>
        this.eventSink?.sendToSession(sessionId, channel, payload),
    });
    this.marketplace = new PluginMarketplace(this.registry);
  }

  /** Scan roots, activate enabled plugins (spawn backends), serve the protocol. */
  init(): Promise<void> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  /**
   * Await kernel boot. The file:// renderer loads in milliseconds in packaged
   * builds and its first `pi:plugin:list` may race `init()` — handlers
   * registered before boot queue on this instead of seeing an empty registry.
   */
  async whenReady(): Promise<void> {
    if (this.initPromise) await this.initPromise;
  }

  private async doInit(): Promise<void> {
    this.registry.scan();
    registerPluginProtocolHandler(this.registry);

    const appVersion = app.getVersion();
    for (const plugin of this.registry.all()) {
      if (!plugin.enabled) continue;
      if (plugin.state === 'incompatible') {
        console.warn(`[plugins] ${plugin.manifest.id} incompatible: ${plugin.error}`);
        continue;
      }
      this.syncPluginSkills(plugin);
      if (!plugin.manifest.backend) continue; // UI-only plugin — no process
      await this.activate(plugin.manifest.id, plugin.rootPath, plugin.manifest.backend, appVersion);
    }

    console.log(
      `[plugins] kernel ready — ${this.registry.all().length} plugin(s) discovered, ` +
      `${this.processes.size} backend(s) running, ${this.aggregateTools().length} agent tool(s) (api ${PLUGIN_PROTOCOL_VERSION})`,
    );
    this.onExtensionsChanged?.();
  }

  private async activate(pluginId: string, rootPath: string, backendEntry: string, appVersion: string): Promise<void> {
    try {
      this.registry.setState(pluginId, 'activating');
      const dataDir = this.registry.getDataDir(pluginId);
      mkdirSync(dataDir, { recursive: true });

      const proc = await spawnBackend({ pluginId, rootPath, backendEntry, dataDir, appVersion });
      proc.onCapabilityCall = (msg) => this.handleCapabilityCall(pluginId, msg);
      proc.onStateChange = (state, error) => {
        this.registry.setState(pluginId, state, error);
        this.emitEvent({ type: 'state-changed', pluginId, state, error });
        // Crash restart: the backend was replaced under the same process object,
        // so activate() does not run. Panel views survive untouched — their
        // ports point at the dead process until we rewire.
        if (state === 'crashed' || state === 'error') this.clearUiPorts(pluginId);
        if (state === 'active') {
          this.onBackendStarted?.(pluginId);
          this.pushSessionSnapshot(proc);
        }
      };
      this.processes.set(pluginId, proc);
      this.registry.setState(pluginId, 'active');
      this.emitEvent({ type: 'state-changed', pluginId, state: 'active' });
      // Fresh backend → any panel view kept alive across a disable/enable (or
      // install/rollback) still holds the OLD backend's port and never
      // re-requests one (its page did not reload). Let the host push new ports.
      this.onBackendStarted?.(pluginId);
      this.pushSessionSnapshot(proc);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[plugins] activate ${pluginId} failed:`, message);
      this.registry.setState(pluginId, 'error', message);
      this.emitEvent({ type: 'state-changed', pluginId, state: 'error', error: message });
    }
  }

  /** Drop the UI port registration for a plugin (backend stopped/crashed). */
  private clearUiPorts(pluginId: string): void {
    for (const key of [...this.uiPortKeys.keys()]) {
      if (key.startsWith(`${pluginId}:`)) this.uiPortKeys.delete(key);
    }
  }

  /** Kill a running backend (if any) and drop it from the process map. */
  private stopPlugin(pluginId: string): void {
    const proc = this.processes.get(pluginId);
    if (proc) {
      proc.kill();
      this.clearUiPorts(pluginId);
      this.processes.delete(pluginId);
    }
  }

  /**
   * After a registry re-scan (install/uninstall/enable), restore the runtime
   * state of unaffected plugins: scan() rebuilds entries as 'registered',
   * but their backends are still running.
   */
  private refreshRuntimeStates(): void {
    for (const [pluginId, proc] of this.processes) {
      const plugin = this.registry.get(pluginId);
      if (plugin && plugin.enabled && proc.running) {
        this.registry.setState(pluginId, 'active');
      }
    }
  }

  /** Activate one registry entry at runtime (used by init / install / enable). */
  private async activateResolved(pluginId: string): Promise<void> {
    const plugin = this.registry.get(pluginId);
    if (!plugin || !plugin.enabled) return;
    if (plugin.state === 'incompatible') return;
    this.syncPluginSkills(plugin);
    if (!plugin.manifest.backend) {
      this.registry.setState(pluginId, 'active');
      this.emitEvent({ type: 'state-changed', pluginId, state: 'active' });
      return;
    }
    await this.activate(pluginId, plugin.rootPath, plugin.manifest.backend, app.getVersion());
  }

  /**
   * Sync contributes.skills into ~/.pi/agent/skills/<pluginId>/ so the SDK's
   * DefaultResourceLoader discovers them (namespaced per plugin).
   */
  private syncPluginSkills(plugin: { manifest: { id: string; contributes?: { skills?: Array<{ path: string }> } }; rootPath: string }): void {
    const skills = plugin.manifest.contributes?.skills ?? [];
    if (skills.length === 0) return;
    const agentSkillsDir = join(this.registry.pluginsRoot, '..', 'skills');
    const pluginSkillDir = join(agentSkillsDir, plugin.manifest.id);
    try {
      rmSync(pluginSkillDir, { recursive: true, force: true });
      for (const skill of skills) {
        const src = join(plugin.rootPath, skill.path);
        if (!existsSync(src)) {
          console.warn(`[plugins] skill path missing: ${src}`);
          continue;
        }
        cpSync(src, join(pluginSkillDir, basename(skill.path)), { recursive: true });
      }
    } catch (err) {
      console.warn(`[plugins] skill sync failed for ${plugin.manifest.id}:`, err);
    }
  }

  /** Remove a plugin's contributed skills from the agent skills dir. */
  private removePluginSkills(pluginId: string): void {
    const pluginSkillDir = join(this.registry.pluginsRoot, '..', 'skills', pluginId);
    try {
      rmSync(pluginSkillDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  /**
   * Every enabled plugin that ships a `PLUGIN.md`, indexed for the prompt.
   *
   * The contract mirrors skills deliberately: only name, one-line description
   * and path reach the system prompt, and the agent reads the file itself when
   * that description matches the task. So the description carries the whole
   * matching burden — a plugin whose line does not say WHEN to reach for it is
   * a plugin the agent never opens. That is why a missing description is
   * reported rather than silently shipped.
   *
   * Read from the plugin directory directly: nothing is copied, so installing,
   * enabling or uninstalling a plugin changes this on the next session, and
   * `~/.pi/agent/skills/` stays the user's own.
   */
  listPluginDocs(): PluginDoc[] {
    const docs: PluginDoc[] = [];
    for (const plugin of this.registry.all()) {
      if (!plugin.enabled || plugin.state === 'incompatible') continue;
      const file = join(plugin.rootPath, 'PLUGIN.md');
      if (!existsSync(file)) continue;
      try {
        const { frontmatter } = parseFrontmatter(readFileSync(file, 'utf-8'));
        const description =
          typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
        if (!description) {
          console.warn(
            `[plugins] ${plugin.manifest.id}: PLUGIN.md has no description — the agent will not see this plugin`,
          );
          continue;
        }
        docs.push({
          name: plugin.manifest.name,
          pluginId: plugin.manifest.id,
          description,
          location: file,
        });
      } catch (err) {
        console.warn(`[plugins] ${plugin.manifest.id}: PLUGIN.md unreadable:`, err);
      }
    }
    return docs;
  }

  /** Record the conversation the renderer put on screen. */
  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  /** The conversation currently on screen (null = none). */
  getActiveSession(): string | null {
    return this.activeSessionId;
  }

  /**
   * Hand a (re)started backend the current session. Host events broadcast only
   * to processes that already run, so without this replay a backend spawned
   * after the last session switch — first boot, enable, crash restart — would
   * resolve every "current document/page" against the wrong conversation.
   */
  private pushSessionSnapshot(proc: PluginProcess): void {
    try {
      proc.pushHostEvent('session.changed', { sessionId: this.activeSessionId });
    } catch { /* best-effort — the backend re-learns on the next switch */ }
  }

  /**
   * Push a host event to every running backend holding the permission — or,
   * without a permission, to every running backend (e.g. session.changed,
   * which every session-scoped backend needs regardless of its capabilities).
   */
  pushHostEvent(event: string, permission: string | undefined, data?: unknown): void {
    for (const [pluginId, proc] of this.processes) {
      const plugin = this.registry.get(pluginId);
      if (!plugin?.enabled) continue;
      if (permission !== undefined && !(plugin.manifest.permissions ?? []).includes(permission)) continue;
      try {
        proc.pushHostEvent(event, data);
      } catch { /* best-effort */ }
    }
  }

  /** All agent tools contributed by enabled plugins (for customTools). */
  aggregateTools(): AgentCustomTool[] {
    const tools: AgentCustomTool[] = [];
    // Tool names are one flat namespace across all plugins (authors prefix
    // their own names; the host does not rewrite them). On a cross-plugin
    // collision the first contributor wins — registry order is dev > user,
    // the same rule that governs plugin-id shadowing — and the loser is
    // named in the log rather than silently dropped.
    const seen = new Map<string, string>();
    for (const plugin of this.registry.all()) {
      if (!plugin.enabled || plugin.state === 'incompatible') continue;
      for (const tool of plugin.manifest.contributes?.tools ?? []) {
        const pluginId = plugin.manifest.id;
        const owner = seen.get(tool.name);
        if (owner !== undefined) {
          console.error(
            `[plugins] tool name collision: "${tool.name}" is contributed by both ${owner} and ${pluginId} — keeping ${owner}'s, ignoring ${pluginId}'s`,
          );
          continue;
        }
        seen.set(tool.name, pluginId);
        // Manifest contract, if any. An empty contract must not erase a core
        // contract for the same tool (most first-party manifests predate the
        // field); the registry keeps the stronger source in that case.
        toolContracts.register(tool.name, tool.contract, 'manifest');
        const guidelines = toolContracts.guidelinesFor(tool.name);
        tools.push({
          name: tool.name,
          label: tool.name,
          // Carried on the tool itself so anything reporting on the tool set —
          // the context-audit tool's per-plugin schema cost, most directly —
          // can attribute a tool to its plugin without re-deriving it from the
          // registry.
          pluginId,
          description: tool.description ?? `Plugin tool from ${pluginId}`,
          readOnly: tool.readOnly,
          // Without this the SDK omits the tool from the system prompt's
          // Available tools section; only its JSON schema reaches the model.
          promptSnippet: toolContracts.snippetFor(tool.name, tool.description),
          ...(guidelines ? { promptGuidelines: guidelines } : {}),
          parameters: tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false },
          execute: async (_toolCallId, params) => {
            // The permission gate correlated this call with its session; the
            // handler is session-scoped (concurrent conversations must not
            // share "the current document/page"). A miss (direct test
            // invocation) yields undefined — handlers fall back to global
            // state, which is exactly the pre-session-scoping behaviour.
            const sessionId = takeToolSession(_toolCallId);
            // Workspace comes from the session's own record, not from window
            // focus — see `resolveSessionWorkspace`. Undefined stays undefined
            // all the way down, so a plugin can tell "global" from "unknown".
            const workspaceId = this.resolveSessionWorkspace?.(sessionId) ?? undefined;
            const result = await this.executeTool(
              pluginId,
              tool.name,
              params ?? {},
              sessionId,
              workspaceId,
            );
            const content = (result.content ?? []).map((c) =>
              c.type === 'image' && c.data
                ? { type: 'image' as const, data: c.data, mimeType: c.mimeType ?? 'image/png' }
                : { type: 'text' as const, text: c.text ?? '' },
            );
            // Card tree rides in details → adapter lifts it into the block.
            return { content, details: { ...(result.details ?? null), card: result.card } };
          },
        });
      }
    }
    return tools;
  }

  /**
   * Route a chat-card interaction (Button click / Input submit in a
   * declarative card) to the plugin that produced the card. Returns false
   * when the plugin has no backend — the renderer treats that as "event
   * dropped" and says so in its own console.
   */
  sendCardEvent(
    pluginId: string,
    toolName: string,
    eventId: string,
    kind: 'click' | 'submit',
    payload?: unknown,
  ): boolean {
    const proc = this.processes.get(pluginId);
    if (!proc) return false;
    proc.sendCardEvent(toolName, eventId, kind, payload);
    return true;
  }

  /** Route a click/submit inside a plugin-originated message's card. */
  sendMessageAction(
    pluginId: string,
    messageId: string,
    eventId: string,
    kind: 'click' | 'submit',
    payload?: unknown,
    sessionId?: string,
  ): boolean {
    const proc = this.processes.get(pluginId);
    if (!proc) return false;
    proc.sendMessageAction(messageId, eventId, kind, payload, sessionId);
    return true;
  }

  /** Execute one agent tool in its plugin backend (agent loop entry point). */
  async executeTool(
    pluginId: string,
    name: string,
    params: Record<string, unknown>,
    sessionId?: string,
    workspaceId?: string,
  ): Promise<{ content?: PluginToolContent[]; details?: unknown; card?: UiNode }> {
    const proc = this.processes.get(pluginId);
    if (!proc) {
      throw new Error(`plugin "${pluginId}" has no backend (tool "${name}")`);
    }
    const result = await proc.executeTool(name, params, sessionId, workspaceId);
    // Agent-activity linkage: a tool that just ran means the plugin is doing
    // visible work — surface its primary panel so the effect is shown. Plugins
    // that contribute no panel have nothing to open, and `openPanelForActivity`
    // no-ops.
    this.openPanelForActivity(pluginId);
    return result;
  }

  /** Open a plugin's first rail-visible panel (hidden panels need panel.open). */
  private openPanelForActivity(pluginId: string): void {
    const plugin = this.registry.get(pluginId);
    const panel = plugin?.manifest.contributes?.panels?.find((p) => !p.hidden);
    if (!panel) return;
    this.emitEvent({ type: 'panel-open', pluginId, panelId: panel.id, focus: true });
  }

  /** Collect auto-injected context from one provider (pre-send hook). */
  async executeContextProvider(pluginId: string, providerId: string, message: string): Promise<string | undefined> {
    const proc = this.processes.get(pluginId);
    if (!proc) return undefined;
    const plugin = this.registry.get(pluginId);
    const providers = plugin?.manifest.contributes?.contextProviders ?? [];
    if (!providers.some((p) => p.id === providerId)) {
      throw new Error(`plugin "${pluginId}" does not contribute context provider "${providerId}"`);
    }
    return proc.requestContext(providerId, message);
  }

  /** All auto context providers of enabled plugins. */
  listAutoContextProviders(): Array<{ pluginId: string; providerId: string }> {
    const out: Array<{ pluginId: string; providerId: string }> = [];
    for (const plugin of this.registry.all()) {
      if (!plugin.enabled || plugin.state === 'incompatible' || plugin.state === 'error') continue;
      for (const provider of plugin.manifest.contributes?.contextProviders ?? []) {
        if (provider.auto) out.push({ pluginId: plugin.manifest.id, providerId: provider.id });
      }
    }
    return out;
  }

  /** Read plugin settings (manifest defaults merged with stored values). */
  getPluginSettings(pluginId: string): Record<string, unknown> {
    const plugin = this.registry.get(pluginId);
    if (!plugin) return {};
    const declared = plugin.manifest.contributes?.settings ?? [];
    const stored = this.readPluginStorage(pluginId);
    const out: Record<string, unknown> = {};
    for (const setting of declared) {
      const key = `settings.${setting.key}`;
      out[setting.key] = key in stored ? stored[key] : setting.default;
    }
    return out;
  }

  /** Write one plugin setting into its private storage. */
  setPluginSetting(pluginId: string, key: string, value: unknown): { ok: boolean; error?: string } {
    const plugin = this.registry.get(pluginId);
    if (!plugin) return { ok: false, error: `unknown plugin: ${pluginId}` };
    const declared = plugin.manifest.contributes?.settings ?? [];
    if (!declared.some((s) => s.key === key)) {
      return { ok: false, error: `plugin "${pluginId}" does not declare setting "${key}"` };
    }
    const stored = this.readPluginStorage(pluginId);
    stored[`settings.${key}`] = value;
    this.writePluginStorage(pluginId, stored);
    return { ok: true };
  }

  private readPluginStorage(pluginId: string): Record<string, unknown> {
    try {
      const file = join(this.registry.getDataDir(pluginId), 'storage.json');
      if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8'));
    } catch { /* corrupted → start fresh */ }
    return {};
  }

  private writePluginStorage(pluginId: string, store: Record<string, unknown>): void {
    try {
      mkdirSync(this.registry.getDataDir(pluginId), { recursive: true });
      writeFileSync(join(this.registry.getDataDir(pluginId), 'storage.json'), JSON.stringify(store, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[plugins] settings write failed for ${pluginId}:`, err);
    }
  }

  // ── Marketplace / lifecycle management ──

  async catalog(force = false): Promise<MarketEntry[]> {
    return this.marketplace.catalog(force);
  }

  /** Install (or update) a plugin from the marketplace catalog. */
  async installFromMarket(pluginId: string, onPhase?: (phase: InstallPhase) => void): Promise<InstallResult> {
    try {
      const entry = await this.marketplace.getEntry(pluginId);
      if (!entry) return { ok: false, error: `"${pluginId}" not found in registry` };

      // Stop the running backend before replacing files.
      this.stopPlugin(pluginId);

      const { stagedDir } = await this.marketplace.stageInstall(entry, (p) => onPhase?.(p));
      this.marketplace.commitInstall(stagedDir, pluginId);

      // Re-scan (picks up the new dir), then activate.
      this.registry.scan();
      this.refreshRuntimeStates();
      await this.activateResolved(pluginId);

      console.log(`[plugins] installed ${pluginId}@${entry.version}`);
      this.emitEvent({ type: 'plugins-changed' });
      this.onExtensionsChanged?.();
      return { ok: true, pluginId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[plugins] install ${pluginId} failed:`, message);
      this.emitEvent({ type: 'plugins-changed' });
      return { ok: false, error: message, pluginId };
    }
  }

  /**
   * Put an upgraded plugin's previous version back.
   *
   * The escape hatch for an update that broke something: reinstalling would
   * only fetch the same broken version again.
   */
  async rollback(pluginId: string): Promise<InstallResult> {
    const plugin = this.registry.get(pluginId);
    if (!plugin) return { ok: false, error: `"${pluginId}" is not installed` };

    this.stopPlugin(pluginId);
    try {
      const { from, to } = this.marketplace.rollback(pluginId);
      this.registry.scan();
      this.refreshRuntimeStates();
      await this.activateResolved(pluginId);
      console.log(`[plugins] rolled ${pluginId} back: ${from} → ${to}`);
      this.emitEvent({ type: 'plugins-changed' });
      this.onExtensionsChanged?.();
      return { ok: true, pluginId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[plugins] rollback ${pluginId} failed:`, message);
      // The swap may have got halfway; re-scan so the registry matches disk
      // rather than whatever it believed a moment ago.
      this.registry.scan();
      this.refreshRuntimeStates();
      this.emitEvent({ type: 'plugins-changed' });
      return { ok: false, error: message, pluginId };
    }
  }

  /** Remove a plugin's code; plugin data is preserved unless asked otherwise. */
  async uninstall(pluginId: string, opts?: { keepData?: boolean }): Promise<InstallResult> {
    const plugin = this.registry.get(pluginId);
    if (!plugin) return { ok: false, error: `"${pluginId}" is not installed` };
    if (plugin.source !== 'user') {
      // rmSync below removes plugin.rootPath — for a dev plugin that is the
      // checkout's source tree, uncommitted work and all. That is not an
      // installation; refuse instead of deleting.
      return {
        ok: false,
        error: `"${pluginId}" is a ${plugin.source} plugin, not an installed copy — nothing to uninstall`,
        pluginId,
      };
    }

    this.stopPlugin(pluginId);
    this.removePluginSkills(pluginId);
    try {
      rmSync(plugin.rootPath, { recursive: true, force: true });
      if (opts?.keepData === false) {
        rmSync(this.registry.getDataDir(pluginId), { recursive: true, force: true });
      }
      this.registry.scan();
      this.refreshRuntimeStates();
      console.log(`[plugins] uninstalled ${pluginId} (data ${opts?.keepData === false ? 'removed' : 'kept'})`);
      this.emitEvent({ type: 'plugins-changed' });
      this.onExtensionsChanged?.();
      return { ok: true, pluginId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message, pluginId };
    }
  }

  /** Enable/disable a plugin at runtime. */
  async setEnabled(pluginId: string, enabled: boolean): Promise<InstallResult> {
    const plugin = this.registry.get(pluginId);
    if (!plugin) return { ok: false, error: `"${pluginId}" is not installed` };

    this.registry.setEnabled(pluginId, enabled);
    if (!enabled) {
      this.stopPlugin(pluginId);
      this.registry.setState(pluginId, 'disabled');
    } else {
      // fresh scan so state resets from 'disabled'
      this.registry.scan();
      this.refreshRuntimeStates();
      await this.activateResolved(pluginId);
    }
    this.emitEvent({ type: 'plugins-changed' });
    this.onExtensionsChanged?.();
    return { ok: true, pluginId };
  }

  /** All installed plugins, including disabled/incompatible ones. */
  listAllInfos(): PluginInfo[] {
    return this.registry.all().map((p) => this.registry.toInfo(p));
  }

  /**
   * Resolve which plugin panel handles a file preview (filePreview
   * contribution, matched by extension). Returns a panel id like
   * "plugin:<id>:<panelId>", or null when no plugin claims the extension.
   */
  findPreviewHandler(filePath: string): string | null {
    const ext = filePath.toLowerCase().split('.').pop()?.split('?')[0] ?? '';
    if (!ext) return null;
    // Source priority: dev (under development) > user (market-installed) — a
    // higher-priority viewer wins the extensions it claims.
    const ranked = [...this.registry.all()].sort(
      (a, b) => sourcePriority(b.source) - sourcePriority(a.source),
    );
    for (const plugin of ranked) {
      if (!plugin.enabled || plugin.state === 'incompatible' || plugin.state === 'error') continue;
      const previews = plugin.manifest.contributes?.filePreview ?? [];
      if (!previews.some((p) => (p.match ?? []).includes(ext))) continue;
      const panel = plugin.manifest.contributes?.panels?.[0];
      if (!panel) continue;
      return `plugin:${plugin.manifest.id}:${panel.id}`;
    }
    return null;
  }

  private handleCapabilityCall(pluginId: string, msg: CapabilityCallMessage): void {
    const proc = this.processes.get(pluginId);
    if (!proc) return;
    this.capabilityHub
      .dispatch(pluginId, msg.method, msg.params)
      .then((result) => proc.sendCallResult(msg.id, result))
      .catch((err) => proc.sendCallResult(msg.id, undefined, err instanceof Error ? err.message : String(err)));
  }

  /**
   * Hand a fresh UI MessagePort pair to the plugin: one end goes to the
   * backend process, the other is transferred to the requesting renderer.
   * A fresh pair per call makes renderer reloads (dev HMR) self-healing.
   */
  ensureUiPort(pluginId: string, sender: Electron.WebContents): { ok: boolean; error?: string; reused?: boolean } {
    const proc = this.processes.get(pluginId);
    if (!proc) {
      return { ok: false, error: `plugin "${pluginId}" has no backend` };
    }

    const portKey = `${pluginId}:${sender.id}`;

    // A reload keeps the WebContents id but builds a renderer whose preload has
    // no port. Left alone, the idempotence check below would answer that new
    // renderer with `reused` forever and it would never reach its backend
    // again — every piSDK.request would hang, with no error anywhere, because
    // the SDK's request() has no timeout and the preload buffers silently.
    //
    // It is not an edge case: the viewer switches renderers by reloading the
    // whole page on every format change (see reloadForOtherFormat in the files
    // plugin), so this is the path a user takes by opening a second document.
    //
    // Cleared on `did-start-loading`, which fires before the new document's
    // preload runs its own ensurePort — so the fresh transfer that follows is
    // not raced. The transfer is safe to repeat: the preload closes the old
    // port and flushes its outbox onto the new one.
    if (!this.uiPortNavigating.has(sender.id)) {
      this.uiPortNavigating.add(sender.id);
      const drop = (): void => {
        for (const key of [...this.uiPortKeys.keys()]) {
          // Keys are `${pluginId}:${webContentsId}`, and plugin ids are
          // reverse-DNS with no colon, so the id is always the last segment.
          if (key.slice(key.lastIndexOf(':') + 1) === String(sender.id)) {
            this.uiPortKeys.delete(key);
          }
        }
      };
      sender.on('did-start-loading', drop);
      sender.once('destroyed', () => {
        drop();
        this.uiPortNavigating.delete(sender.id);
      });
    }

    // Idempotent per (plugin, renderer): each new port pair replaces the
    // backend's state.uiPort, so a second ensurePort while the renderer's
    // FIRST port is still queued would leave the renderer's outbox messages
    // stranded on a port pair the backend no longer listens to.
    if (this.uiPortKeys.get(portKey)) {
      return { ok: true, reused: true };
    }
    this.uiPortKeys.set(portKey, true);
    const { port1, port2 } = new MessageChannelMain();
    try {
      proc.sendUiPort(port1);
      sender.postMessage('pi:plugin:port', { pluginId }, [port2]);
    } catch (err) {
      console.error(`[plugins] ensureUiPort(${pluginId}) transfer failed:`, err);
      return { ok: false, error: String(err) };
    }
    return { ok: true };
  }

  listInfos(): PluginInfo[] {
    return this.registry.listInfos();
  }

  /** Execute a plugin-contributed command in its backend. */
  async executeCommand(pluginId: string, name: string, args?: string): Promise<unknown> {
    const proc = this.processes.get(pluginId);
    if (!proc) {
      throw new Error(`plugin "${pluginId}" has no backend`);
    }
    return proc.executeCommand(name, args);
  }

  /** Build the pi-plugin:// URL for a panel. */
  panelUrl(pluginId: string, entry: string): string {
    return `pi-plugin://${pluginId}/${entry.replace(/^\/+/, '')}`;
  }

  /**
   * Deliver a plugin event to the renderer that owns it.
   *
   * Kernel state (which plugins exist, install progress) is the same
   * everywhere and goes to every window. Panel events are conversation
   * events: a background backend opening a panel must not open the same panel
   * in an unrelated window, so they follow the active-session owner.
   */
  private emitEvent(evt: PluginEvent): void {
    const global = evt.type === 'state-changed' || evt.type === 'plugins-changed' || evt.type === 'install-phase';
    if (this.eventSink) {
      if (global) this.eventSink.broadcast('pi:plugin:event', evt);
      else this.eventSink.sendToSession(this.activeSessionId, 'pi:plugin:event', evt);
      return;
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('pi:plugin:event', evt);
      }
    }
  }

  dispose(): void {
    for (const proc of this.processes.values()) {
      proc.kill();
    }
    this.processes.clear();
  }
}

function sourcePriority(source: 'dev' | 'user'): number {
  return source === 'dev' ? 3 : 2;
}
