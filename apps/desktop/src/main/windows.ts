import { BrowserWindow } from 'electron';
import type { Rectangle, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { basename } from 'path';
import { createMainWindow } from './window-manager';
import { WindowStateStore, type PersistedWindowState } from './window-state';
import { BrowserManager } from '@main/browser/browser-manager';
import { TabRegistry } from '@main/browser/tab-registry';
import { LiveSlotRegistry } from './plugins/slots';
import { PluginWebViews } from './plugins/plugin-webview';
import type { BrowserRouter, BrowserTarget } from './plugins/capability-hub';
import type { PluginSystem } from './plugins';

/**
 * Everything that belongs to exactly one window.
 *
 * The host used to keep a single `mainWindow` and hang the browser engine,
 * the live-slot registry and the plugin panel views off it. Each of those
 * owns native views that must live in ONE window's contentView, so with more
 * than one window they all become per-context objects — while the services
 * that are genuinely global (chat, permissions, plugin backends) stay
 * singletons and route their pushes by session.
 */
export interface WindowContext {
  /** 1..N, never reused in-process. Exposed to the renderer as `windowId`. */
  windowId: number;
  /**
   * Stable across restarts, used by the renderer to key its OWN persisted
   * state (open panels). A NEW window gets a fresh one, so it never inherits
   * another window's panels.
   */
  layoutId: string;
  win: BrowserWindow;
  /**
   * Captured at creation: after `closed`, `win.webContents` is unusable, and
   * the registry still has to delete map entries keyed by these ids.
   */
  browserWindowId: number;
  hostWebContentsId: number;
  browserManager: BrowserManager;
  /** This window's tab→conversation buckets (one engine per window). */
  tabRegistry: TabRegistry;
  liveSlots: LiveSlotRegistry;
  pluginWebViews: PluginWebViews | null;
  workspaceId: string | null;
  workspacePath: string | null;
  activeSessionId: string | null;
  createdAt: number;
}

export interface CreateWindowOptions {
  workspaceId?: string | null;
  workspacePath?: string | null;
  /** Session to open. If another window already owns it, that window is focused instead. */
  sessionId?: string | null;
  /** Restored geometry (multi-window restore). */
  bounds?: Rectangle;
  maximized?: boolean;
  /** Restored per-window renderer-state id; a new window omits it. */
  layoutId?: string;
}

export interface WindowHooks {
  /** Fired when a window takes focus (and when the focused window closes). */
  onFocus?: (ctx: WindowContext | null) => void;
  /**
   * Fired after a window is gone. `sessions` lists every conversation that
   * window was showing or running; the caller decides whether anything still
   * needs cancelling (another window may have adopted one).
   */
  onClosed?: (ctx: WindowContext, sessions: string[]) => void;
}

interface SessionState {
  workspaceId: string | null;
  workspacePath: string | null;
  sessionId: string | null;
}

export interface ClaimResult {
  ok: boolean;
  ownerWindowId?: number;
}

export class WindowRegistry implements BrowserRouter {
  private readonly byWindowId = new Map<number, WindowContext>();
  private readonly byBrowserWindowId = new Map<number, WindowContext>();
  private readonly byHostWebContentsId = new Map<number, WindowContext>();
  /**
   * sessionId → window that started a run on it. Distinct from the active
   * ownership below: a window that starts a long run and then switches to
   * another conversation still receives that run's permission cards, ask
   * cards and todo snapshots.
   */
  private readonly lastRunOwners = new Map<string, number>();
  private lastFocusedWindowId: number | null = null;
  /** Last focused window's view state — seeds the single window a restart restores. */
  private lastRunState: SessionState | null = null;
  /** Last theme tokens pushed by any shell renderer; replayed into new windows. */
  private themeTokens: Record<string, string> | null = null;
  private nextWindowId = 1;
  private system: PluginSystem | null = null;
  private hooks: WindowHooks = {};
  /** Disk-backed window layout; attached after app ready (userData exists then). */
  private stateStore: WindowStateStore | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private quitting = false;

  get lastState(): SessionState | null {
    return this.lastRunState;
  }

  attachStateStore(store: WindowStateStore): void {
    this.stateStore = store;
  }

  // ── window state (multi-window restore) ──

  /**
   * Reopen every window from the last run. Returns how many were restored;
   * the caller creates a default window when that is zero.
   */
  restoreWindows(): number {
    const saved = this.stateStore?.load() ?? [];
    // Two windows saved at identical rectangles (the OS may have clamped
    // both on the same screen) must not reopen perfectly on top of each
    // other — cascade only the duplicates, keep genuine positions intact.
    const seen = new Set<string>();
    let restored = 0;
    for (const state of saved) {
      let bounds = state.bounds;
      let key = `${bounds.x},${bounds.y}`;
      let nudge = 0;
      while (seen.has(key) && nudge < 8) {
        nudge += 1;
        bounds = { ...bounds, x: bounds.x + 28 * nudge, y: bounds.y + 28 * nudge };
        key = `${bounds.x},${bounds.y}`;
      }
      seen.add(key);
      this.create({
        workspaceId: state.workspaceId,
        workspacePath: state.workspacePath,
        sessionId: state.sessionId,
        layoutId: state.layoutId,
        bounds,
        maximized: state.maximized,
      });
      restored += 1;
    }
    return restored;
  }

  /** Save now — called on quit, before windows start closing. */
  prepareToQuit(): void {
    this.flushState();
    this.quitting = true;
  }

  /** Debounced save: move/resize fire continuously during a drag. */
  private scheduleSave(): void {
    if (this.quitting || !this.stateStore) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushState();
    }, 500);
  }

  private flushState(): void {
    if (!this.stateStore || this.quitting) return;
    const windows: PersistedWindowState[] = [];
    for (const ctx of this.byWindowId.values()) {
      if (ctx.win.isDestroyed()) continue;
      windows.push({
        layoutId: ctx.layoutId,
        bounds: ctx.win.getBounds(),
        maximized: ctx.win.isMaximized(),
        workspaceId: ctx.workspaceId,
        workspacePath: ctx.workspacePath,
        sessionId: ctx.activeSessionId,
      });
    }
    this.stateStore.save(windows);
  }

  /** Window title names the workspace, so Mission Control / the Window menu are legible. */
  private updateTitle(ctx: WindowContext): void {
    if (ctx.win.isDestroyed()) return;
    const name = ctx.workspacePath ? basename(ctx.workspacePath) : null;
    ctx.win.setTitle(name ? `${name} — Pi Coding Agent` : 'Pi Coding Agent');
  }

  setHooks(hooks: WindowHooks): void {
    this.hooks = hooks;
  }

  // ── lifecycle ──

  create(opts: CreateWindowOptions = {}): WindowContext {
    // A session belongs to one window at a time. Opening a second copy is
    // refused by focusing the owner: two writers on one transcript would let
    // one window's composer steer the other's run, and permission cards would
    // have two candidate destinations.
    if (opts.sessionId) {
      const owner = this.activeOwnerOf(opts.sessionId);
      if (owner) {
        this.focus(owner.windowId);
        return owner;
      }
    }

    const windowId = this.nextWindowId++;
    // Restored windows keep the identity their renderer state is keyed by; a
    // genuinely new window starts with a blank slate.
    const layoutId = opts.layoutId ?? randomUUID();
    const browserManager = new BrowserManager({ idPrefix: `w${windowId}` });
    const win = createMainWindow({
      windowId,
      layoutId,
      workspaceId: opts.workspaceId ?? null,
      sessionId: opts.sessionId ?? null,
      title: opts.workspacePath ? `${basename(opts.workspacePath)} — Pi Coding Agent` : undefined,
      bounds: opts.bounds,
      maximized: opts.maximized,
    });

    const ctx: WindowContext = {
      windowId,
      layoutId,
      win,
      browserWindowId: win.id,
      hostWebContentsId: win.webContents.id,
      browserManager,
      tabRegistry: new TabRegistry(browserManager),
      liveSlots: new LiveSlotRegistry(),
      pluginWebViews: null,
      workspaceId: opts.workspaceId ?? null,
      workspacePath: opts.workspacePath ?? opts.workspaceId ?? null,
      activeSessionId: opts.sessionId ?? null,
      createdAt: Date.now(),
    };

    // The engine's tab views attach to this window's contentView.
    browserManager.attach(win);

    this.byWindowId.set(windowId, ctx);
    this.byBrowserWindowId.set(ctx.browserWindowId, ctx);
    this.byHostWebContentsId.set(ctx.hostWebContentsId, ctx);

    win.on('focus', () => this.handleFocus(ctx));
    win.on('closed', () => this.destroy(ctx));
    // Geometry changes are saved debounced; the final save runs on close
    // (through destroy) and on quit (prepareToQuit).
    win.on('move', () => this.scheduleSave());
    win.on('resize', () => this.scheduleSave());
    win.on('maximize', () => this.scheduleSave());
    win.on('unmaximize', () => this.scheduleSave());

    // A renderer reload never runs React cleanup, so its slots vanish without
    // detaching — their views would keep stale bounds and invisibly eat
    // clicks. Per window: reloading one window must not hide another's views.
    win.webContents.on('did-start-navigation', () => {
      console.log(`[windows] w${windowId} renderer navigation — hiding its native views`);
      ctx.liveSlots.hideAll();
    });

    if (this.system) this.attachPluginViews(ctx);
    if (win.isFocused()) this.handleFocus(ctx);

    return ctx;
  }

  /** Create a window for the focused window's workspace with a fresh session. */
  newFromFocused(): WindowContext {
    const focused = this.focused();
    return this.create({
      workspaceId: focused?.workspaceId ?? null,
      workspacePath: focused?.workspacePath ?? null,
    });
  }

  openWorkspaceInNewWindow(workspaceId: string): { ok: boolean; windowId: number } {
    const ctx = this.create({ workspaceId, workspacePath: workspaceId });
    return { ok: true, windowId: ctx.windowId };
  }

  /** The window currently showing `workspaceId`, if any. */
  byWorkspace(workspaceId: string): WindowContext | undefined {
    for (const ctx of this.byWindowId.values()) {
      if (ctx.workspaceId === workspaceId || ctx.workspacePath === workspaceId) return ctx;
    }
    return undefined;
  }

  /**
   * Open a workspace the way VS Code's "open folder" does: focus the window
   * that already shows it, otherwise open a new one. `forceNew` is the
   * explicit "open in new window" action and always creates.
   */
  openWorkspace(workspaceId: string, opts: { forceNew?: boolean } = {}): {
    ok: boolean;
    windowId: number;
    focusedExisting: boolean;
  } {
    if (!opts.forceNew) {
      const existing = this.byWorkspace(workspaceId);
      if (existing) {
        this.focus(existing.windowId);
        return { ok: true, windowId: existing.windowId, focusedExisting: true };
      }
    }
    const ctx = this.create({ workspaceId, workspacePath: workspaceId });
    return { ok: true, windowId: ctx.windowId, focusedExisting: false };
  }

  /**
   * Focus a DIFFERENT window that already shows this workspace. The caller
   * (a renderer sitting on its own workspace) uses this before switching:
   * a workspace open elsewhere is brought to the front instead of being
   * silently opened twice.
   */
  focusWorkspaceElsewhere(workspaceId: string, callerWindowId: number): boolean {
    const existing = this.byWorkspace(workspaceId);
    if (!existing || existing.windowId === callerWindowId) return false;
    this.focus(existing.windowId);
    return true;
  }

  openSessionInNewWindow(
    sessionId: string,
    workspaceId: string,
  ): { ok: boolean; windowId?: number; ownerWindowId?: number } {
    const owner = this.activeOwnerOf(sessionId);
    if (owner) {
      this.focus(owner.windowId);
      return { ok: false, ownerWindowId: owner.windowId };
    }
    const ctx = this.create({ workspaceId, workspacePath: workspaceId, sessionId });
    return { ok: true, windowId: ctx.windowId };
  }

  focus(windowId: number): void {
    const ctx = this.byWindowId.get(windowId);
    if (!ctx || ctx.win.isDestroyed()) return;
    if (ctx.win.isMinimized()) ctx.win.restore();
    ctx.win.focus();
  }

  private destroy(ctx: WindowContext): void {
    const sessions = new Set<string>();
    if (ctx.activeSessionId) sessions.add(ctx.activeSessionId);
    for (const [sessionId, ownerId] of [...this.lastRunOwners]) {
      if (ownerId === ctx.windowId) {
        this.lastRunOwners.delete(sessionId);
        sessions.add(sessionId);
      }
    }

    this.byWindowId.delete(ctx.windowId);
    this.byBrowserWindowId.delete(ctx.browserWindowId);
    this.byHostWebContentsId.delete(ctx.hostWebContentsId);
    if (this.lastFocusedWindowId === ctx.windowId) this.lastFocusedWindowId = null;

    try {
      ctx.pluginWebViews?.dispose();
    } catch (err) {
      console.warn(`[windows] w${ctx.windowId} plugin view dispose failed:`, err);
    }
    ctx.liveSlots.hideAll();
    void ctx.browserManager.destroy().catch(() => {});

    // Persist what is left AFTER this window is gone: closing one of three
    // windows must not resurrect it on the next launch.
    this.flushState();

    this.hooks.onClosed?.(ctx, [...sessions]);

    const next = this.focused() ?? this.first() ?? null;
    if (next) this.handleFocus(next);
    else this.hooks.onFocus?.(null);
  }

  destroyAll(): void {
    for (const ctx of [...this.byWindowId.values()]) {
      if (!ctx.win.isDestroyed()) ctx.win.destroy();
      else this.destroy(ctx);
    }
  }

  // ── lookups ──

  get(windowId: number): WindowContext | undefined {
    return this.byWindowId.get(windowId);
  }

  all(): WindowContext[] {
    return [...this.byWindowId.values()];
  }

  byBrowserWindow(win: BrowserWindow): WindowContext | undefined {
    return this.byBrowserWindowId.get(win.id);
  }

  /**
   * Resolve the window a webContents belongs to: either a host shell
   * renderer, or one of the panel views that window hosts.
   */
  byWebContents(wc: WebContents): WindowContext | undefined {
    const direct = this.byHostWebContentsId.get(wc.id);
    if (direct) return direct;
    for (const ctx of this.byWindowId.values()) {
      if (ctx.pluginWebViews?.ownsWebContents(wc)) return ctx;
    }
    return undefined;
  }

  focused(): WindowContext | null {
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      const ctx = this.byBrowserWindowId.get(win.id);
      if (ctx) {
        this.lastFocusedWindowId = ctx.windowId;
        return ctx;
      }
    }
    if (this.lastFocusedWindowId != null) {
      return this.byWindowId.get(this.lastFocusedWindowId) ?? null;
    }
    return this.first();
  }

  private first(): WindowContext | null {
    return this.byWindowId.values().next().value ?? null;
  }

  activeOwnerOf(sessionId: string): WindowContext | undefined {
    for (const ctx of this.byWindowId.values()) {
      if (ctx.activeSessionId === sessionId) return ctx;
    }
    return undefined;
  }

  forSession(sessionId: string | null | undefined): WindowContext | undefined {
    if (!sessionId || sessionId === 'default') return undefined;
    const active = this.activeOwnerOf(sessionId);
    if (active) return active;
    const runOwner = this.lastRunOwners.get(sessionId);
    return runOwner != null ? this.byWindowId.get(runOwner) : undefined;
  }

  /** True when a live window other than `exceptWindowId` still holds this session. */
  hasOtherOwner(sessionId: string, exceptWindowId: number): boolean {
    const owner = this.activeOwnerOf(sessionId);
    if (owner && owner.windowId !== exceptWindowId) return true;
    for (const ctx of this.byWindowId.values()) {
      if (ctx.windowId !== exceptWindowId && ctx.activeSessionId === sessionId) return true;
    }
    return false;
  }

  // ── view state ──

  /** Renderer reports the workspace it is showing (no conflict possible). */
  setWorkspace(windowId: number, workspace: { id?: string; path?: string } | null): void {
    const ctx = this.byWindowId.get(windowId);
    if (!ctx) return;
    ctx.workspaceId = workspace?.path ? (workspace.id ?? workspace.path) : null;
    ctx.workspacePath = workspace?.path ?? null;
    this.updateTitle(ctx);
    if (this.lastFocusedWindowId === windowId || ctx.win.isFocused()) this.captureLastState(ctx);
    this.scheduleSave();
  }

  claimActiveSession(windowId: number, sessionId: string | null): ClaimResult {
    const ctx = this.byWindowId.get(windowId);
    if (!ctx) return { ok: false };
    if (!sessionId) {
      ctx.activeSessionId = null;
      this.notifyFocusState(ctx);
      return { ok: true };
    }
    const owner = this.activeOwnerOf(sessionId);
    if (owner && owner.windowId !== windowId) {
      this.focus(owner.windowId);
      return { ok: false, ownerWindowId: owner.windowId };
    }
    // Deliberately keep `lastRunOwners`: a run started in this window keeps
    // routing its cards here even after the window moves to another session.
    ctx.activeSessionId = sessionId;
    this.notifyFocusState(ctx);
    this.scheduleSave();
    return { ok: true };
  }

  releaseActiveSession(sessionId: string): void {
    for (const ctx of this.byWindowId.values()) {
      if (ctx.activeSessionId === sessionId) ctx.activeSessionId = null;
    }
    this.lastRunOwners.delete(sessionId);
  }

  /** The window started (or continued) a run on this session. */
  touchRunOwner(sessionId: string, windowId: number): void {
    if (!sessionId || sessionId === 'default') return;
    this.lastRunOwners.set(sessionId, windowId);
  }

  // ── delivery ──

  send(window: BrowserWindow | null | undefined, channel: string, payload: unknown): void {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(channel, payload);
  }

  sendToSession(sessionId: string | null | undefined, channel: string, payload: unknown): void {
    const target = this.forSession(sessionId) ?? this.focused() ?? this.first();
    this.send(target?.win, channel, payload);
  }

  sendToFocused(channel: string, payload: unknown): void {
    const target = this.focused() ?? this.first();
    this.send(target?.win, channel, payload);
  }

  /**
   * Deliver to the window showing `workspaceId`, falling back to the focused
   * one when no window shows it (the project was switched away from, or a
   * workspace-scoped send arrived while that window was closed).
   */
  sendToWorkspace(workspaceId: string | null | undefined, channel: string, payload: unknown): void {
    const target =
      (workspaceId ? this.byWorkspace(workspaceId) : undefined) ?? this.focused() ?? this.first();
    this.send(target?.win, channel, payload);
  }

  broadcast(channel: string, payload: unknown): void {
    for (const ctx of this.byWindowId.values()) this.send(ctx.win, channel, payload);
  }

  setTheme(tokens: Record<string, string>): void {
    if (!tokens || typeof tokens !== 'object') return;
    this.themeTokens = tokens;
    for (const ctx of this.byWindowId.values()) ctx.pluginWebViews?.applyTheme(tokens);
  }

  // ── plugins ──

  /** Create this window's plugin panel views and wire its browser events. */
  attachPluginViews(ctx: WindowContext): void {
    if (!this.system) return;
    if (!ctx.pluginWebViews) {
      ctx.pluginWebViews = new PluginWebViews({
        registry: this.system.registry,
        liveSlots: ctx.liveSlots,
        getWindow: () => (ctx.win.isDestroyed() ? null : ctx.win),
        browserManager: ctx.browserManager,
        windowId: ctx.windowId,
        initialTheme: this.themeTokens,
      });
      ctx.pluginWebViews.sync();
    }
    this.wireBrowserEvents(ctx);
  }

  /**
   * Called once after PluginSystem.init(). Every window that already exists
   * gets its panel views; windows created later get them in `create()`.
   */
  bindPlugins(system: PluginSystem): void {
    this.system = system;
    for (const ctx of this.byWindowId.values()) this.attachPluginViews(ctx);
  }

  private readonly wired = new Set<number>();

  private wireBrowserEvents(ctx: WindowContext): void {
    if (this.wired.has(ctx.windowId)) return;
    this.wired.add(ctx.windowId);

    // Push browser state to plugin backends. The tab id is globally unique
    // (w<id>:t<n>) and the window id rides along so a backend holding several
    // tabs can tell windows apart.
    ctx.browserManager.onUrlChanged((tabId, url) => {
      this.system?.pushHostEvent('browser.urlChanged', 'browser', {
        tabId,
        url,
        windowId: ctx.windowId,
      });
    });
    // window.open / target=_blank lands as a NEW TAB in the opener's window,
    // in the same conversation's bucket.
    ctx.browserManager.onWindowOpen((url, _disposition, sourceTabId) => {
      try {
        const t = ctx.tabRegistry.newTabFromPopup(sourceTabId, url);
        this.system?.pushHostEvent('browser.tabOpened', 'browser', {
          tabId: t.id,
          url,
          windowId: ctx.windowId,
          sessionId: sourceTabId ? ctx.tabRegistry.ownerOf(sourceTabId) : undefined,
        });
      } catch (err) {
        console.warn('[windows] popup tab failed:', err);
      }
    });
  }

  // ── routing for browser.* capabilities ──

  /**
   * Pick the window a plugin's browser call runs against: an explicit tab id
   * is unambiguous; a conversation id names the window that owns it; anything
   * else falls back to the focused window.
   */
  resolve(params: Record<string, unknown>): BrowserTarget | undefined {
    const tabId =
      typeof params.tabId === 'string' && params.tabId
        ? params.tabId
        : typeof params.beforeTabId === 'string' && params.beforeTabId
          ? params.beforeTabId
          : undefined;
    if (tabId) {
      for (const ctx of this.byWindowId.values()) {
        if (ctx.browserManager.knowsTab(tabId)) return this.target(ctx);
      }
    }
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    const bySession = this.forSession(sessionId);
    if (bySession) return this.target(bySession);
    const fallback = this.focused() ?? this.first();
    return fallback ? this.target(fallback) : undefined;
  }

  private target(ctx: WindowContext): BrowserTarget {
    return {
      windowId: ctx.windowId,
      manager: ctx.browserManager,
      tabRegistry: ctx.tabRegistry,
    };
  }

  // ── launch arguments ──

  /**
   * `--new-window` opens another window (used by the packaged app's second
   * launch and by `open -n`). Without it a second launch focuses the existing
   * instance, which is what the single-instance lock promised before.
   */
  handleLaunchArgs(argv: string[], opts: { secondInstance: boolean }): void {
    const flag = (name: string): string | null => {
      const prefix = `--${name}=`;
      const hit = argv.find((a) => a.startsWith(prefix));
      return hit ? hit.slice(prefix.length) : null;
    };

    const newWindow = argv.includes('--new-window');
    const workspace = flag('workspace');
    const session = flag('session');

    if (!newWindow && !workspace && !session) {
      if (opts.secondInstance) {
        const focused = this.focused() ?? this.first();
        if (focused) this.focus(focused.windowId);
      }
      return;
    }

    if (session) {
      const owner = this.activeOwnerOf(session);
      if (owner) {
        this.focus(owner.windowId);
        return;
      }
      this.create({ workspaceId: workspace, workspacePath: workspace, sessionId: session });
      return;
    }

    if (workspace) {
      // `--workspace=` is an external "open folder" request: reuse the window
      // that already shows it unless the caller asked for a new window.
      this.openWorkspace(workspace, { forceNew: newWindow });
      return;
    }

    this.newFromFocused();
  }

  // ── internals ──

  private handleFocus(ctx: WindowContext): void {
    this.lastFocusedWindowId = ctx.windowId;
    this.captureLastState(ctx);
    this.hooks.onFocus?.(ctx);
  }

  private captureLastState(ctx: WindowContext): void {
    this.lastRunState = {
      workspaceId: ctx.workspaceId,
      workspacePath: ctx.workspacePath,
      sessionId: ctx.activeSessionId,
    };
  }

  /**
   * A session claim changes what plugin backends consider "the current
   * conversation" — but only when it happens in the focused window.
   */
  private notifyFocusState(ctx: WindowContext): void {
    if (ctx.windowId !== this.lastFocusedWindowId && !ctx.win.isFocused()) return;
    this.captureLastState(ctx);
    this.hooks.onFocus?.(ctx);
  }
}

/** Process-wide window registry. */
export const windows = new WindowRegistry();
