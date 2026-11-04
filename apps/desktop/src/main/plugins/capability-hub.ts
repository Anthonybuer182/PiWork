import { app, BrowserWindow, dialog, Notification, net } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { CapabilityMethod, PluginEvent, PluginPanelStatus } from '@pi/types';
import { PLUGIN_PROTOCOL_VERSION } from '@pi/types';
import { deleteFileWithMtimeGuard, writeFileWithMtimeGuard } from '@pi/sdk-wrapper/adapters';
import type { PluginRegistry } from './registry';
import type { BrowserManager } from '@main/browser/browser-manager';
import type { VlmAnalyzer } from '@main/browser/vlm-analyzer';
import { TabRegistry } from '@main/browser/tab-registry';
import { extractOfficeText } from './office-extract';

/**
 * One window's browser engine: the manager that owns the tab views plus the
 * conversation buckets that live in that window.
 */
export interface BrowserTarget {
  windowId: number;
  manager: BrowserManager;
  tabRegistry: TabRegistry;
}

/**
 * Picks the window a `browser.*` call runs against. Plugin backends are
 * process-global, so they cannot name a window directly: the host resolves it
 * from the tab id (unambiguous) or the conversation (the window that owns the
 * session), falling back to the focused window.
 */
export interface BrowserRouter {
  resolve(params: Record<string, unknown>): BrowserTarget | undefined;
}

export interface CapabilityDeps {
  registry: PluginRegistry;
  emitEvent: (evt: PluginEvent) => void;
  /** Window-aware resolver for the per-window browser engines. */
  browserRouter?: BrowserRouter;
  /** Screenshot-based planner for browser.walk (needs a configured VLM model). */
  vlmAnalyzer?: VlmAnalyzer;
  /** Push a message to the renderer (used by chat.send). */
  sendToRenderer?: (channel: string, payload: unknown) => void;
  /** The conversation's permission mode (默认 / 完全访问), for dialog policy. */
  getPermissionMode?: (sessionId: string) => 'default' | 'full';
  /** Whether a TTS provider is ready; plugins get the error text when not. */
  voiceReady?: () => { ok: boolean; error?: string };
  /**
   * Called after a plugin write/delete lands. The host decides whether the
   * path is part of an agent's standing context and rebuilds the affected
   * live session — saving `.pi/SYSTEM.md` from the file viewer must apply to
   * the next turn, not wait for a new session.
   */
  onContextFileWrite?: (filePath: string) => void;
}

interface CapabilitySpec {
  /** Manifest permission required to invoke; omit for always-allowed. */
  permission?: string;
  handler: (ctx: { pluginId: string; dataDir: string; params: Record<string, unknown> }) => Promise<unknown> | unknown;
}

/**
 * Routes host.* capability calls from plugin backends, enforcing the
 * permissions declared in each plugin's manifest.
 */
export class CapabilityHub {
  private readonly registry: PluginRegistry;
  private readonly emitEvent: (evt: PluginEvent) => void;
  private readonly browserRouter?: BrowserRouter;
  private readonly vlmAnalyzer?: VlmAnalyzer;
  private readonly sendToRenderer?: (channel: string, payload: unknown) => void;
  private readonly getPermissionMode?: (sessionId: string) => 'default' | 'full';
  private readonly voiceReady?: () => { ok: boolean; error?: string };
  private readonly onContextFileWrite?: (filePath: string) => void;
  private readonly capabilities = new Map<string, CapabilitySpec>();

  constructor(deps: CapabilityDeps) {
    this.registry = deps.registry;
    this.emitEvent = deps.emitEvent;
    this.browserRouter = deps.browserRouter;
    this.vlmAnalyzer = deps.vlmAnalyzer;
    this.sendToRenderer = deps.sendToRenderer;
    this.getPermissionMode = deps.getPermissionMode;
    this.voiceReady = deps.voiceReady;
    this.onContextFileWrite = deps.onContextFileWrite;

    this.registerCapabilities();
  }

  private registerCapabilities(): void {
    // ── chat.send (always allowed, but attributed) ──
    // Deliberately unpermissioned: this is precisely what the user typing in
    // the composer does, and the plugin already runs with the user's
    // authority. The renderer owns the composer, so the message is relayed
    // there and sent through the same path as a keystroke — streaming, tool
    // calls and persistence behave identically. The plugin owns the input UI;
    // the host only provides the ability to reach the conversation.
    //
    // What a plugin does NOT get is the user's VOICE. The message is prefixed
    // with an attribution line before it reaches the conversation, so the
    // agent and the transcript can tell a plugin-sent message from a typed
    // one. Without this, a misbehaving plugin could inject instructions that
    // read as the user's own intent — the one trust boundary the rest of this
    // permissioned architecture cannot afford to leave open.
    this.capabilities.set('chat.send', {
      handler: ({ pluginId, params }) => {
        const text = String(params.text ?? '').trim();
        if (!text) throw new Error('chat.send: text is required');
        if (!this.sendToRenderer) throw new Error('chat.send: no renderer attached');
        const plugin = this.registry.get(pluginId);
        const name = plugin?.manifest.name ?? pluginId;
        // `workspaceId` is routing, not content: the shell delivers the message
        // to the window showing that workspace. A scheduled job must reach the
        // conversation it was scheduled from, not whichever window is focused.
        const workspaceId =
          typeof params.workspaceId === 'string' && params.workspaceId ? params.workspaceId : undefined;
        this.sendToRenderer('pi:chat:send', {
          text: `[插件消息 · 来自 ${name}（${pluginId}）]\n${text}`,
          pluginId,
          ...(workspaceId ? { workspaceId } : {}),
        });
        return { ok: true };
      },
    });

    // ── voice.speak / voice.stop (permission: voice) ──
    // Audio playback lives in the shell renderer, so the capability only
    // relays the request there. Plugins cannot stream their own audio into the
    // player; text is capped like the composer path.
    this.capabilities.set('voice.speak', {
      permission: 'voice',
      handler: ({ pluginId, params }) => {
        const raw = String(params.text ?? '');
        const text = raw.trim().slice(0, 8000);
        if (!text) throw new Error('voice.speak: text is required');
        const ready = this.voiceReady?.() ?? { ok: true };
        if (!ready.ok) throw new Error(ready.error ?? '语音合成未配置');
        if (!this.sendToRenderer) throw new Error('voice.speak: no renderer attached');
        this.sendToRenderer('pi:voice:speak', {
          text,
          key: `plugin:${pluginId}`,
          toggle: params.toggle !== false,
          pluginId,
        });
        return { ok: true };
      },
    });

    this.capabilities.set('voice.stop', {
      permission: 'voice',
      handler: () => {
        if (!this.sendToRenderer) throw new Error('voice.stop: no renderer attached');
        this.sendToRenderer('pi:voice:stop', {});
        return { ok: true };
      },
    });

    // ── app.info (always allowed) ──
    this.capabilities.set('app.info', {
      handler: ({ pluginId }) => ({
        pluginId,
        apiVersion: PLUGIN_PROTOCOL_VERSION,
        appVersion: app.getVersion(),
        platform: process.platform,
      }),
    });

    // ── storage.* (permission: storage) ──
    this.capabilities.set('storage.get', {
      permission: 'storage',
      handler: ({ dataDir, params }) => this.readStorage(dataDir)[String(params.key)],
    });
    this.capabilities.set('storage.set', {
      permission: 'storage',
      handler: ({ dataDir, params }) => {
        const store = this.readStorage(dataDir);
        store[String(params.key)] = params.value;
        this.writeStorage(dataDir, store);
        return { ok: true };
      },
    });
    this.capabilities.set('storage.delete', {
      permission: 'storage',
      handler: ({ dataDir, params }) => {
        const store = this.readStorage(dataDir);
        delete store[String(params.key)];
        this.writeStorage(dataDir, store);
        return { ok: true };
      },
    });

    // ── notify.show (permission: notify) ──
    this.capabilities.set('notify.show', {
      permission: 'notify',
      handler: ({ params }) => {
        const title = String(params.title ?? '插件通知');
        const body = String(params.body ?? '');
        if (Notification.isSupported()) {
          new Notification({ title, body }).show();
        }
        return { ok: true };
      },
    });

    // ── panel.setStatus (requires contributing the panel) ──
    this.capabilities.set('panel.setStatus', {
      handler: ({ pluginId, params }) => {
        const plugin = this.registry.get(pluginId);
        const panels = plugin?.manifest.contributes?.panels ?? [];
        const panelId = params.panelId ? String(params.panelId) : panels[0]?.id;
        if (!panelId || !panels.some((p: { id: string }) => p.id === panelId)) {
          throw new Error(`plugin "${pluginId}" does not contribute panel "${panelId}"`);
        }
        const status: PluginPanelStatus = {
          pluginId,
          panelId,
          badge: params.badge as number | string | undefined,
          activity: params.activity as PluginPanelStatus['activity'],
          detail: params.detail ? String(params.detail) : undefined,
        };
        this.emitEvent({ type: 'status', status });
        return { ok: true };
      },
    });

    // ── panel.open (requires contributing the panel) ──
    // focus=false (default) follows the no-focus-steal principle: the rail
    // shows a pending badge and the active panel is NOT switched.
    this.capabilities.set('panel.open', {
      handler: ({ pluginId, params }) => {
        const plugin = this.registry.get(pluginId);
        const panels = plugin?.manifest.contributes?.panels ?? [];
        const panelId = params.panelId ? String(params.panelId) : panels[0]?.id;
        if (!panelId || !panels.some((p: { id: string }) => p.id === panelId)) {
          throw new Error(`plugin "${pluginId}" does not contribute panel "${panelId}"`);
        }
        const focus = params.focus === true;
        // `params` ride the open (the viewer pane's `{ file }`).
        const openParams =
          params.params && typeof params.params === 'object' && !Array.isArray(params.params)
            ? (params.params as Record<string, unknown>)
            : undefined;
        this.emitEvent({ type: 'panel-open', pluginId, panelId, focus, params: openParams });
        return { ok: true, panelId, focus };
      },
    });

    // ── panel.close (requires contributing the panel) ──
    // The closing counterpart of panel.open: a plugin collapsing its own
    // split pane (the viewer's 取消拆分) has no other way back.
    this.capabilities.set('panel.close', {
      handler: ({ pluginId, params }) => {
        const plugin = this.registry.get(pluginId);
        const panels = plugin?.manifest.contributes?.panels ?? [];
        const panelId = params.panelId ? String(params.panelId) : panels[0]?.id;
        if (!panelId || !panels.some((p: { id: string }) => p.id === panelId)) {
          throw new Error(`plugin "${pluginId}" does not contribute panel "${panelId}"`);
        }
        const tabId = params.tabId ? String(params.tabId) : undefined;
        if (tabId) {
          // A plugin may only close tabs of its own panels. The tab key is the
          // panel entry id, optionally suffixed with `##<instance>`.
          const prefix = `plugin:${pluginId}:${panelId}`;
          if (tabId !== prefix && !tabId.startsWith(`${prefix}##`)) {
            throw new Error(`panel.close: "${tabId}" is not a tab of "${prefix}"`);
          }
        }
        this.emitEvent({ type: 'panel-close', pluginId, panelId, tabId });
        return { ok: true, panelId, tabId };
      },
    });

    // ── panel.updateTab (requires contributing the panel) ──
    // A panel can change its own host tab's label/params — the viewer's file
    // tree opens a document inside an already-empty tab, the browser's page
    // title changes on navigation. Main only relays; the shell owns the state.
    this.capabilities.set('panel.updateTab', {
      handler: ({ pluginId, params }) => {
        const plugin = this.registry.get(pluginId);
        const panels = plugin?.manifest.contributes?.panels ?? [];
        const tabId = params.tabId ? String(params.tabId) : '';
        if (!tabId) throw new Error('panel.updateTab needs a tabId');
        const panelId = params.panelId ? String(params.panelId) : undefined;
        if (panelId && !panels.some((p: { id: string }) => p.id === panelId)) {
          throw new Error(`plugin "${pluginId}" does not contribute panel "${panelId}"`);
        }
        const prefix = panelId ? `plugin:${pluginId}:${panelId}` : `plugin:${pluginId}:`;
        if (!tabId.startsWith(prefix)) {
          throw new Error(`panel.updateTab: "${tabId}" does not belong to plugin "${pluginId}"`);
        }
        const title =
          typeof params.title === 'string'
            ? params.title
            : params.title === null
              ? ''
              : undefined;
        const openParams =
          params.params && typeof params.params === 'object' && !Array.isArray(params.params)
            ? (params.params as Record<string, unknown>)
            : undefined;
        this.emitEvent({ type: 'tab-update', pluginId, tabId, title, params: openParams });
        return { ok: true, tabId };
      },
    });

    // ── panel.focusTab (requires contributing the panel) ──
    // Focus a host tab by its key. Distinct from panel.open: the tab is
    // already open and its params may not identify it (a browser favorites
    // tab keeps `{}` until its first navigation).
    this.capabilities.set('panel.focusTab', {
      handler: ({ pluginId, params }) => {
        const tabId = params.tabId ? String(params.tabId) : '';
        if (!tabId) throw new Error('panel.focusTab needs a tabId');
        if (!tabId.startsWith(`plugin:${pluginId}:`)) {
          throw new Error(`panel.focusTab: "${tabId}" does not belong to plugin "${pluginId}"`);
        }
        const focus = params.focus !== false;
        this.emitEvent({ type: 'tab-focus', pluginId, tabId, focus });
        return { ok: true, tabId };
      },
    });

    // ── dialog.openFile / dialog.saveFile (always allowed) ──
    //
    // Deliberately unpermissioned, for the same reason `chat.send` is: the user
    // is the one who answers. A plugin cannot name a path — it can only put a
    // native picker in front of the user and receive what the user picks, which
    // is exactly the authorization. There is nothing here for a manifest to
    // pre-approve.
    //
    // Without this, a plugin had no way at all to ask for a path: the panel-side
    // shim (`com.pi.files/src/ui/docx/desktop-shim.ts`) has always called
    // `file.pickOpenPath` / `file.pickSavePath`, and the plugin backend answered
    // `unknown ui request` — so "open" and "save as" silently did nothing.
    this.capabilities.set('dialog.openFile', {
      handler: async ({ params }) => {
        const options: OpenDialogOptions = {
          properties: params.multi === true ? ['openFile', 'multiSelections'] : ['openFile'],
          ...(typeof params.title === 'string' ? { title: params.title.slice(0, 120) } : {}),
          ...(sanitizeFilters(params.filters) ? { filters: sanitizeFilters(params.filters) } : {}),
        };
        const window = dialogParentWindow();
        const result = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options);
        return {
          canceled: result.canceled,
          path: result.canceled ? null : (result.filePaths[0] ?? null),
          paths: result.canceled ? [] : result.filePaths,
        };
      },
    });
    this.capabilities.set('dialog.saveFile', {
      handler: async ({ params }) => {
        const defaultName =
          typeof params.defaultName === 'string' ? params.defaultName.slice(0, 200) : '';
        const options: SaveDialogOptions = {
          ...(typeof params.title === 'string' ? { title: params.title.slice(0, 120) } : {}),
          ...(defaultName ? { defaultPath: defaultName } : {}),
          ...(typeof params.defaultPath === 'string'
            ? { defaultPath: params.defaultPath.slice(0, 1000) }
            : {}),
          ...(sanitizeFilters(params.filters) ? { filters: sanitizeFilters(params.filters) } : {}),
        };
        const window = dialogParentWindow();
        const result = window
          ? await dialog.showSaveDialog(window, options)
          : await dialog.showSaveDialog(options);
        return { canceled: result.canceled, path: result.canceled ? null : (result.filePath ?? null) };
      },
    });

    // ── filesystem.read (permission: filesystem) ──
    this.capabilities.set('filesystem.read', {
      permission: 'filesystem',
      handler: ({ params }) => {
        const path = String(params.path ?? '');
        if (!path) throw new Error('missing path');
        if (!existsSync(path)) throw new Error(`file not found: ${path}`);
        const ext = path.toLowerCase().split('.').pop() ?? '';
        if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') {
          throw new Error(`office file (${ext}) — use office.read instead`);
        }
        const size = (() => {
          try { return statSync(path).size; } catch { return 0; }
        })();
        if (size > 2 * 1024 * 1024) throw new Error('file too large (>2MB) for filesystem.read');
        return { path, content: readFileSync(path, 'utf-8'), size };
      },
    });

    // ── filesystem.write (permission: filesystem) — plugin write-back with
    // conflict detection: an expectedMtime older than the on-disk mtime means
    // the file changed since the plugin last read it; refuse to clobber. ──
    this.capabilities.set('filesystem.write', {
      permission: 'filesystem',
      handler: ({ params }) => {
        const path = String(params.path ?? '');
        if (!path) throw new Error('missing path');
        const expectedMtime = typeof params.expectedMtime === 'number' ? params.expectedMtime : undefined;
        // Binary write: contentB64 (base64) — zip-based formats (docx/xlsx/
        // pptx) must not round-trip through utf-8 strings.
        const content =
          typeof params.contentB64 === 'string'
            ? Buffer.from(params.contentB64, 'base64')
            : String(params.content ?? '');
        const written = writeFileWithMtimeGuard(path, content, expectedMtime);
        // No-op for ordinary files; rebuilds a live session when this was one
        // of its prompt/context files.
        this.onContextFileWrite?.(path);
        return written;
      },
    });

    // ── filesystem.delete (permission: filesystem) ──
    // Same conflict check as write: refusing to delete a file that changed
    // underneath the caller is the whole point of passing the expected mtime.
    this.capabilities.set('filesystem.delete', {
      permission: 'filesystem',
      handler: ({ params }) => {
        const path = String(params.path ?? '');
        const deleted = deleteFileWithMtimeGuard(
          path,
          typeof params.expectedMtime === 'number' ? params.expectedMtime : undefined,
        );
        this.onContextFileWrite?.(path);
        return deleted;
      },
    });

    // ── office.read (permission: filesystem) — text-level office extraction ──
    this.capabilities.set('office.read', {
      permission: 'filesystem',
      handler: ({ params }) => {
        const path = String(params.path ?? '');
        if (!path) throw new Error('missing path');
        if (!existsSync(path)) throw new Error(`file not found: ${path}`);
        const size = (() => {
          try { return statSync(path).size; } catch { return 0; }
        })();
        if (size > 20 * 1024 * 1024) throw new Error('file too large (>20MB)');
        const result = extractOfficeText(path, readFileSync(path));
        return { path, size, type: result.type, text: result.text, meta: result.meta };
      },
    });

    // ── network.fetch (permission: network:<host-pattern>) ──
    // Connector egress channel: every call is checked against the host
    // patterns the plugin declared in its manifest.
    this.capabilities.set('network.fetch', {
      handler: async ({ pluginId, params }) => {
        const plugin = this.registry.get(pluginId);
        const url = String(params.url ?? '');
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error(`invalid url: ${url}`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`unsupported protocol: ${parsed.protocol}`);
        }
        const granted = (plugin?.manifest.permissions ?? [])
          .filter((p) => p.startsWith('network:'))
          .map((p) => p.slice('network:'.length))
          .some((pattern) => hostMatches(parsed.hostname, pattern));
        if (!granted) {
          throw new Error(
            `network access to "${parsed.hostname}" not granted — declare "network:${parsed.hostname}" in the manifest`,
          );
        }
        const init: RequestInit = { method: String(params.method ?? 'GET').toUpperCase() };
        if (params.headers && typeof params.headers === 'object') init.headers = params.headers as Record<string, string>;
        if (params.body != null) init.body = String(params.body);
        const res = await net.fetch(url, init);
        const text = await res.text();
        if (text.length > 2 * 1024 * 1024) throw new Error('response too large (>2MB)');
        return { ok: res.ok, status: res.status, body: text };
      },
    });

    // ── browser.* (permission: browser) — host-owned BrowserManager ──
    // Page-level calls take an optional `tabId` (default: the manager's
    // active tab — the backend resolves the conversation's focused tab and
    // passes it explicitly). The four tab-management capabilities are the
    // ones that need the CONVERSATION: the bucket mapping lives in the host.
    const tabIdOf = (params: Record<string, unknown>): string | undefined =>
      typeof params.tabId === 'string' && params.tabId ? params.tabId : undefined;
    const targetOf = (params: Record<string, unknown>): BrowserTarget => {
      const target = this.browserRouter?.resolve(params ?? {});
      if (!target) throw new Error('browser capability unavailable (no window)');
      return target;
    };
    const bm = async (params: Record<string, unknown> = {}) => {
      const { manager } = targetOf(params);
      // The legacy flow connected CDP from the preview panel mount; plugin
      // panels may not be open yet, so ensure the debugger is attached.
      if (!manager.isConnected()) {
        await manager.connect().catch(() => {});
      }
      return manager;
    };
    this.capabilities.set('browser.navigate', {
      permission: 'browser',
      handler: async ({ params }) => {
        const url = String(params.url ?? '');
        if (!url) throw new Error('missing url');
        const manager = await bm(params);
        const result = await manager.navigate(url, undefined, tabIdOf(params));
        return result;
      },
    });
    this.capabilities.set('browser.back', {
      permission: 'browser',
      handler: async ({ params }) => { (await bm(params)).navigateBack(tabIdOf(params)); return { ok: true }; },
    });
    this.capabilities.set('browser.forward', {
      permission: 'browser',
      handler: async ({ params }) => { (await bm(params)).navigateForward(tabIdOf(params)); return { ok: true }; },
    });
    this.capabilities.set('browser.reload', {
      permission: 'browser',
      handler: async ({ params }) => { (await bm(params)).reload(tabIdOf(params)); return { ok: true }; },
    });
    this.capabilities.set('browser.getUrl', {
      permission: 'browser',
      handler: async ({ params }) => (await bm(params)).getUrl(tabIdOf(params)),
    });
    this.capabilities.set('browser.getState', {
      permission: 'browser',
      handler: async ({ params }) => {
        const manager = await bm(params);
        const state = await manager.getUrl(tabIdOf(params));
        // The interactive-element snapshot is what makes the page actionable —
        // without it the agent has a URL but no idea what to click. Failure to
        // snapshot (odd page, cross-origin frame) must not fail the whole call.
        const snapshot = await manager.getSnapshot(tabIdOf(params)).catch(() => '(unavailable)');
        return { ...state, snapshot };
      },
    });
    this.capabilities.set('browser.screenshot', {
      permission: 'browser',
      handler: async ({ params }) =>
        (await bm(params)).screenshot({ fullPage: params?.fullPage === true }, tabIdOf(params)),
    });
    this.capabilities.set('browser.click', {
      permission: 'browser',
      handler: async ({ params }) => {
        const explicit =
          params.dialog === 'accept' || params.dialog === 'dismiss' ? params.dialog : undefined;
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
        // 完全访问 means the user already handed over the whole session, so a
        // page's confirm() is answered instead of bouncing back for an explicit
        // retry. In 默认 the dialog stays dismissed — the approval card is
        // where the user says yes.
        const fallback =
          sessionId && this.getPermissionMode?.(sessionId) === 'full' ? 'accept' : 'dismiss';
        return (await bm(params)).click(String(params.selector ?? ''), tabIdOf(params), explicit ?? fallback);
      },
    });
    this.capabilities.set('browser.describe', {
      permission: 'browser',
      handler: async ({ params }) =>
        (await bm(params)).describe(String(params.selector ?? ''), tabIdOf(params)),
    });
    this.capabilities.set('browser.upload', {
      permission: 'browser',
      handler: async ({ params }) =>
        (await bm(params)).upload(
          String(params.selector ?? ''),
          Array.isArray(params.files) ? (params.files as unknown[]).map(String) : [],
          tabIdOf(params),
        ),
    });
    this.capabilities.set('browser.getText', {
      permission: 'browser',
      handler: async ({ params }) =>
        (await bm(params)).getText(params.selector ? String(params.selector) : undefined, tabIdOf(params)),
    });
    this.capabilities.set('browser.evaluate', {
      permission: 'browser',
      handler: async ({ params }) => (await bm(params)).evaluate(String(params.expression ?? ''), tabIdOf(params)),
    });
    this.capabilities.set('browser.fill', {
      permission: 'browser',
      handler: async ({ params }) =>
        (await bm(params)).fill(String(params.selector ?? ''), String(params.value ?? ''), tabIdOf(params)),
    });
    this.capabilities.set('browser.hover', {
      permission: 'browser',
      handler: async ({ params }) => (await bm(params)).hover(String(params.selector ?? ''), tabIdOf(params)),
    });
    this.capabilities.set('browser.select', {
      permission: 'browser',
      handler: async ({ params }) =>
        (await bm(params)).selectOption(String(params.selector ?? ''), String(params.value ?? ''), tabIdOf(params)),
    });
    this.capabilities.set('browser.scroll', {
      permission: 'browser',
      handler: async ({ params }) => {
        const direction = params.direction === 'up' ? 'up' : 'down';
        const amount = typeof params.amount === 'number' ? params.amount : undefined;
        return amount !== undefined
          ? (await bm(params)).scroll(direction, amount, tabIdOf(params))
          : (await bm(params)).scroll(direction, 500, tabIdOf(params));
      },
    });
    this.capabilities.set('browser.find', {
      permission: 'browser',
      handler: async ({ params }) => (await bm(params)).find(String(params.query ?? ''), tabIdOf(params)),
    });
    this.capabilities.set('browser.walk', {
      permission: 'browser',
      handler: async ({ params }) => {
        if (!this.vlmAnalyzer) {
          throw new Error('browser.walk unavailable: no VLM model configured');
        }
        const maxSteps = typeof params.maxSteps === 'number' ? params.maxSteps : undefined;
        return maxSteps !== undefined
          ? (await bm(params)).walk(String(params.goal ?? ''), this.vlmAnalyzer, maxSteps, tabIdOf(params))
          : (await bm(params)).walk(String(params.goal ?? ''), this.vlmAnalyzer, 5, tabIdOf(params));
      },
    });
    // ── tab management: the conversation-scoped view of the engine ──
    this.capabilities.set('browser.tabList', {
      permission: 'browser',
      handler: async ({ params }) =>
        targetOf(params).tabRegistry.list(String(params.sessionId ?? 'default')),
    });
    this.capabilities.set('browser.newTab', {
      permission: 'browser',
      handler: async ({ params }) => {
        const t = targetOf(params).tabRegistry.newTab(String(params.sessionId ?? 'default'), {
          url: params.url ? String(params.url) : undefined,
          activate: params.activate !== false,
        });
        return { tabId: t.id, url: t.url };
      },
    });
    this.capabilities.set('browser.reorderTab', {
      permission: 'browser',
      handler: async ({ params }) => {
        const tabId = String(params.tabId ?? '');
        if (!tabId) throw new Error('missing tabId');
        targetOf(params).tabRegistry.reorderTab(
          String(params.sessionId ?? 'default'),
          tabId,
          params.beforeTabId ? String(params.beforeTabId) : null,
        );
        return { ok: true };
      },
    });
    this.capabilities.set('browser.setSplitTabs', {
      permission: 'browser',
      handler: async ({ params }) => {
        const tabId = params.tabId ? String(params.tabId) : null;
        (await bm(params)).setSplitPartner(tabId);
        return { ok: true };
      },
    });
    this.capabilities.set('browser.activateTab', {
      permission: 'browser',
      handler: async ({ params }) => {
        const tabId = String(params.tabId ?? '');
        if (!tabId) throw new Error('missing tabId');
        targetOf(params).tabRegistry.activateTab(String(params.sessionId ?? 'default'), tabId);
        return { ok: true };
      },
    });
    this.capabilities.set('browser.closeTab', {
      permission: 'browser',
      handler: async ({ params }) => {
        const tabId = String(params.tabId ?? '');
        if (!tabId) throw new Error('missing tabId');
        targetOf(params).tabRegistry.closeTab(tabId);
        return { ok: true };
      },
    });
  }

  /** Validate permissions and dispatch a capability call. */
  async dispatch(pluginId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const spec = this.capabilities.get(method as CapabilityMethod);
    if (!spec) {
      throw new Error(`unknown capability: ${method}`);
    }

    const plugin = this.registry.get(pluginId);
    if (!plugin) {
      throw new Error(`unknown plugin: ${pluginId}`);
    }

    if (spec.permission && !(plugin.manifest.permissions ?? []).includes(spec.permission)) {
      throw new Error(`permission denied: "${spec.permission}" not granted to ${pluginId}`);
    }

    return spec.handler({
      pluginId,
      dataDir: this.registry.getDataDir(pluginId),
      params: params ?? {},
    });
  }

  // ── Plugin-private JSON storage (plugins-data/<id>/storage.json) ──

  private storagePath(dataDir: string): string {
    return join(dataDir, 'storage.json');
  }

  private readStorage(dataDir: string): Record<string, unknown> {
    try {
      const p = this.storagePath(dataDir);
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'));
    } catch (err) {
      console.warn('[plugins] storage read failed:', err);
    }
    return {};
  }

  private writeStorage(dataDir: string, store: Record<string, unknown>): void {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(this.storagePath(dataDir), JSON.stringify(store, null, 2), 'utf-8');
  }
}


/** Glob host match: "api.example.com", "*.example.com", "*" patterns. */
function hostMatches(hostname: string, pattern: string): boolean {
  if (!pattern || pattern === '*') return true;
  const parts = hostname.split('.');
  const patternParts = pattern.split('.');
  if (patternParts.length > parts.length) return false;
  const offset = parts.length - patternParts.length;
  return patternParts.every((p, i) => p === '*' || p === parts[offset + i]);
}

/**
 * The window a plugin's dialog should hang off.
 *
 * Parented where possible so the picker is a sheet on the app rather than a
 * free-floating window that can end up behind it — but never required: a dialog
 * with no parent still works, so a plugin calling during startup is not an
 * error.
 */
function dialogParentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

/**
 * A plugin-supplied filter list, reduced to something Electron will accept.
 *
 * The shapes differ enough to matter: Electron wants `{ name, extensions }`
 * with bare extensions, while a plugin is likely to write what its own file
 * pickers use — `.docx` with the dot, or a bare extension string. A malformed
 * entry makes `showOpenDialog` throw, which would surface to the user as a
 * broken picker, so bad entries are dropped rather than passed through.
 */
function sanitizeFilters(raw: unknown): { name: string; extensions: string[] }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: { name: string; extensions: string[] }[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String((entry as { name?: unknown }).name ?? '').slice(0, 80);
    const extensions = (entry as { extensions?: unknown }).extensions;
    if (!name || !Array.isArray(extensions)) continue;
    const cleaned = extensions
      .filter((e): e is string => typeof e === 'string')
      .map((e) => e.replace(/^\.+/, '').trim())
      .filter(Boolean)
      .slice(0, 30);
    if (cleaned.length > 0) out.push({ name, extensions: cleaned });
    if (out.length >= 12) break;
  }
  return out.length > 0 ? out : undefined;
}
