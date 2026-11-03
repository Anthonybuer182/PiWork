import { join } from 'path';
import type { BrowserWindow, WebContents } from 'electron';
import { WebContentsView, shell } from 'electron';
import { panelUrl } from '@pi/types';
import type { BrowserManager } from '@main/browser/browser-manager';
import type { LiveSlotHandler, LiveSlotRegistry } from './slots';
import type { PluginRegistry } from './registry';

/**
 * Name of the engine live slot a plugin page can bind with
 * `piSDK.liveSlot(ENGINE_SLOT_NAME, element)`. The host registers
 * `<pluginId>:<ENGINE_SLOT_NAME>` for plugins holding the `browser`
 * permission; the slot's view is the shared browser engine, not a page.
 * Must not collide with any panel id of that plugin.
 */
export const ENGINE_SLOT_NAME = 'page';

/**
 * The split view's secondary engine slot. A plugin page holding `browser`
 * permission may bind a SECOND element with `piSDK.liveSlot(ENGINE_SLOT_B_NAME,
 * element)`; when shown, the engine displays two tabs side by side — the
 * focused one in the primary slot, the split partner here. Focus (address
 * bar, navigation, agent tools) always stays with the primary.
 */
export const ENGINE_SLOT_B_NAME = 'page-b';

/**
 * Plugin web panels as native views.
 *
 * Every plugin panel — a manifest panel with an `entry` — is a web page. This
 * hosts those pages in a `WebContentsView` instead of an iframe, so
 * a panel gets a real top-level frame: correct IME, working print/alert/download
 * (an iframe sandbox blocks all three), its own renderer process, and no
 * dependence on the shell's DOM.
 *
 * Three consequences, all deliberate:
 *
 *  - **The shell cannot draw over a panel.** Native views sit above ALL DOM.
 *    Popups drawn *inside* a panel are unaffected (that is how genoffice does
 *    its selection popover); only host-level overlays over a panel are lost.
 *  - **Panel bounds are reported, not laid out.** A WebContentsView keeps
 *    exactly the rectangle it is given, so the renderer measures its slot and
 *    reports the rect here. 0×0 means "hide" — leaving a stale view visible
 *    would swallow real mouse clicks.
 *  - **The UI message channel moves.** The page can no longer reach the shell
 *    via `window.parent`; `preload/plugin-view.ts` re-establishes it, and
 *    `plugin-sdk-js.ts` shims `window.parent` so existing plugin code is
 *    unchanged.
 */
export class PluginWebViews {
  private readonly views = new Map<string, WebContentsView>();
  /** Slots we have registered a handler for, so re-registration is cheap. */
  private readonly registered = new Set<string>();
  /** Engine slots (`<pluginId>:page`) this class registered — cleanup must NOT close their view. */
  private readonly engineRegistered = new Set<string>();
  /**
   * Last theme the shell pushed. A view created after that push would
   * otherwise never learn the shell's colours, because the shell only
   * broadcasts on change and on panel mount of the panels IT renders.
   */
  private lastTheme: Record<string, string> | null = null;
  /** Last `panel.mounted` report per slot, replayed after a page reload. */
  private readonly mounted = new Map<
    string,
    {
      panelId?: string;
      tabId?: string;
      params?: unknown;
      sessionId?: string;
      workspaceId?: string;
    }
  >();

  constructor(
    private readonly opts: {
      registry: PluginRegistry;
      liveSlots: LiveSlotRegistry;
      getWindow: () => BrowserWindow | null;
      browserManager?: BrowserManager;
      /** Registry id of the window these views belong to (diagnostics). */
      windowId?: number;
      /** Shell theme from before this window existed — replayed to panel views. */
      initialTheme?: Record<string, string> | null;
    },
  ) {
    this.lastTheme = opts.initialTheme ?? null;
    // Multi-instance panels are not known at boot: their slot ids carry a
    // per-tab instance suffix, so the renderer's first attach is what tells us
    // which view to create. Singleton slots still resolve through this factory
    // too — it is the one place that validates the pane belongs to the plugin.
    opts.liveSlots.setFactory((slotId, meta) => this.createSlot(slotId, meta));
  }

  /**
   * Route a `panel.mounted` report to the plugin page's view. The shell owns
   * the panel's open params; the view owns the MessagePort they must travel
   * on. Registered once per process by the window registry, which resolves
   * the sender window first — so two windows mounting the same panel each
   * deliver to their own view.
   */
  handlePanelMounted(msg: {
    pluginId?: string;
    panelId?: string;
    tabId?: string;
    slotId?: string;
    params?: unknown;
    sessionId?: string;
    workspaceId?: string;
  }): { ok: boolean; error?: string } {
    const slotId = msg?.slotId || `${msg?.pluginId}:${msg?.panelId}`;
    const view = this.views.get(slotId);
    if (!view || view.webContents.isDestroyed()) {
      return { ok: false, error: `no view for ${slotId}` };
    }
    const payload = {
      panelId: msg?.panelId,
      tabId: msg?.tabId,
      params: msg?.params,
      sessionId: msg?.sessionId,
      // The shell reports this, rather than main reading it off the window
      // context: React flushes the panel's mount effect before the shell's own
      // "active workspace changed" IPC, so ctx still holds the PREVIOUS
      // workspace at this moment — and that stale value would stick.
      workspaceId: msg?.workspaceId,
    };
    // Kept so a panel page that reloads (crash recovery, dev reload) gets the
    // same report again. The shell only reports on mount, and a page reload is
    // not a mount — without this the page comes back believing it serves no
    // workspace, and every scoped panel silently falls back to "everything".
    this.mounted.set(slotId, payload);
    view.webContents.send('pi:plugin:panel-mounted', payload);
    return { ok: true };
  }

  /**
   * Forward "this tab is now active" to its view. The backend uses it to keep
   * "current document / current page" per conversation correct when several
   * tabs of a multi-instance panel share one backend process.
   */
  handlePanelActivated(msg: {
    pluginId?: string;
    panelId?: string;
    tabId?: string;
    slotId?: string;
    params?: unknown;
    sessionId?: string;
    workspaceId?: string;
  }): { ok: boolean; error?: string } {
    const slotId = msg?.slotId || `${msg?.pluginId}:${msg?.panelId}`;
    const view = this.views.get(slotId);
    if (!view || view.webContents.isDestroyed()) {
      return { ok: false, error: `no view for ${slotId}` };
    }
    view.webContents.send('pi:plugin:panel-activated', msg);
    return { ok: true };
  }

  /** Theme tokens are collected by any shell renderer; fan them out to this window's views. */
  applyTheme(tokens: Record<string, string>): void {
    if (!tokens || typeof tokens !== 'object') return;
    this.lastTheme = tokens;
    for (const view of this.views.values()) {
      if (view.webContents.isDestroyed()) continue;
      view.webContents.send('pi:plugin:theme', tokens);
    }
  }

  /** True when `wc` is one of this window's panel views. */
  ownsWebContents(wc: WebContents): boolean {
    for (const view of this.views.values()) {
      if (view.webContents === wc) return true;
    }
    return false;
  }

  /**
   * Window is going away: unregister every slot (this registry is per window),
   * detach the views from its contentView and close their pages.
   */
  dispose(): void {
    for (const slotId of [...this.registered]) {
      this.opts.liveSlots.unregister(slotId);
    }
    const win = this.opts.getWindow();
    for (const [slotId, view] of this.views) {
      try {
        win?.contentView.removeChildView(view);
      } catch {
        /* window already gone */
      }
      try {
        view.webContents.close();
      } catch {
        /* already closed */
      }
      this.attached.delete(slotId);
    }
    this.views.clear();
    this.registered.clear();
    this.engineRegistered.clear();
  }

  /**
   * Register a live slot for every plugin web panel, plus the engine slot
   * for plugins holding the `browser` permission. Called at boot and again
   * whenever the plugin set changes (install / enable / disable / uninstall —
   * which is also where stale slots get reconciled away).
   */
  sync(): void {
    const { registry, liveSlots } = this.opts;

    for (const plugin of registry.all()) {
      if (!plugin.enabled || plugin.state === 'incompatible' || plugin.state === 'error') continue;
      const pluginId = plugin.manifest.id;

      // ── Engine slot ──
      // A plugin page holding `browser` permission may bind the shared browser
      // engine into its own layout via `piSDK.liveSlot('page', el)`. The view
      // is the host's singleton — the plugin only positions it.
      const wantsEngine = (plugin.manifest.permissions ?? []).includes('browser');
      if (wantsEngine && this.opts.browserManager) {
        // Several host tabs share this one engine view. A hidden tab's live
        // slot reports 0×0 (hide) while the newly active tab's slot reports
        // bounds (show); whichever IPC lands last must not hide a page that
        // just became visible. A hide is therefore deferred one tick and only
        // wins if no show happened in between.
        let engineShowSeq = 0;
        const engineSlotId = `${pluginId}:${ENGINE_SLOT_NAME}`;
        const panelIds = new Set((plugin.manifest.contributes?.panels ?? []).map((p) => p.id));
        if (panelIds.has(ENGINE_SLOT_NAME)) {
          console.warn(
            `[plugin-view] plugin "${pluginId}" has a panel named "${ENGINE_SLOT_NAME}" — ` +
              `engine slot not registered (slot ids would collide)`,
          );
        } else if (!this.engineRegistered.has(engineSlotId)) {
          this.engineRegistered.add(engineSlotId);
          this.registered.add(engineSlotId);
          const bm = this.opts.browserManager;
          liveSlots.register(engineSlotId, {
            attach: () => {
              if (!bm.isConnected()) bm.connect().catch(() => {});
            },
            show: (bounds, tag) => {
              // `bounds` are the PLUGIN PAGE's local coordinates — the page
              // measured its own slot div, with the page's top-left as origin.
              // The engine view is positioned in window-content coordinates,
              // so translate by whichever panel view currently hosts the page.
              // `tag` names WHICH engine tab to show (the panel's active one);
              // without it the manager's active tab shows. showTab enforces the
              // one-visible invariant (all other tabs to 0×0, target re-topped).
              engineShowSeq++;
              const host = this.attachedPanelView(pluginId);
              if (!host) {
                bm.hide();
                return;
              }
              const hostBounds = host.getBounds();
              bm.showTab(tag ?? undefined, {
                x: hostBounds.x + bounds.x,
                y: hostBounds.y + bounds.y,
                width: bounds.width,
                height: bounds.height,
              });
            },
            hide: () => {
              const seq = ++engineShowSeq;
              setTimeout(() => {
                if (engineShowSeq === seq) bm.hide();
              }, 60);
            },
          });
        }
        // The split view's second pane — same translation, but it sizes its
        // tab BESIDE the primary instead of enforcing the one-visible rule.
        const engineSlotBId = `${pluginId}:${ENGINE_SLOT_B_NAME}`;
        if (
          !panelIds.has(ENGINE_SLOT_B_NAME) &&
          !this.engineRegistered.has(engineSlotBId)
        ) {
          this.engineRegistered.add(engineSlotBId);
          this.registered.add(engineSlotBId);
          const bm = this.opts.browserManager;
          liveSlots.register(engineSlotBId, {
            attach: () => {
              if (!bm.isConnected()) bm.connect().catch(() => {});
            },
            show: (bounds, tag) => {
              const host = this.attachedPanelView(pluginId);
              if (!host || !tag) {
                bm.hideSecondary();
                return;
              }
              const hostBounds = host.getBounds();
              bm.showSecondary(tag, {
                x: hostBounds.x + bounds.x,
                y: hostBounds.y + bounds.y,
                width: bounds.width,
                height: bounds.height,
              });
            },
            hide: () => bm.hideSecondary(),
          });
        }
      }

      // ── Panel slots ──
      // Deliberately NOT pre-registered: one multi-instance panel can have N
      // views, and their slot ids only exist once a host tab mounts. The
      // factory installed in the constructor creates (and validates) the
      // handler from the renderer's attach payload.
    }

    this.reconcile();
  }

  /**
   * Build the live-slot handler for one panel view from the renderer's attach
   * payload. The slot id alone is opaque (it carries an instance suffix for
   * multi-instance tabs); pluginId/panelId/entry/tabKey come from the shell,
   * and this is where main re-validates that the plugin really contributes
   * that panel and that the entry matches its manifest.
   */
  private createSlot(
    slotId: string,
    meta?: Record<string, unknown>,
  ): LiveSlotHandler | undefined {
    const pluginId = String(meta?.pluginId ?? '');
    const panelId = String(meta?.panelId ?? '');
    const entry = String(meta?.entry ?? '');
    const tabKey = String(meta?.tabKey ?? slotId);
    if (!pluginId || !panelId || !entry) return undefined;
    const plugin = this.opts.registry.get(pluginId);
    if (
      !plugin ||
      !plugin.enabled ||
      plugin.state === 'incompatible' ||
      plugin.state === 'error'
    ) {
      return undefined;
    }
    const panel = (plugin.manifest.contributes?.panels ?? []).find((p) => p.id === panelId);
    if (!panel || panel.entry !== entry) return undefined;

    this.registered.add(slotId);
    return {
      attach: () => {
        this.ensureView(slotId, pluginId, panelId, entry, tabKey);
      },
      show: (bounds) => {
        const view = this.ensureView(slotId, pluginId, panelId, entry, tabKey);
        if (!view) return;
        const win = this.opts.getWindow();
        if (!win) return;
        view.setBounds({
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
        });
        // addChildView is idempotent-by-replacement: adding an already
        // attached child would reorder it, so track attachment explicitly.
        if (!this.attached.has(slotId)) {
          win.contentView.addChildView(view);
          this.attached.add(slotId);
        }
        // The panel view remounts with its page exactly as it was — no resize
        // inside the page, so its live slot will not re-report and the engine
        // view positioned there stays hidden. Replay it (both panes when a
        // split is showing).
        const engineId = `${pluginId}:${ENGINE_SLOT_NAME}`;
        if (this.engineRegistered.has(engineId)) void this.opts.liveSlots.reshow(engineId);
        const engineIdB = `${pluginId}:${ENGINE_SLOT_B_NAME}`;
        if (this.engineRegistered.has(engineIdB)) void this.opts.liveSlots.reshow(engineIdB);
      },
      hide: () => this.hideSlot(slotId),
      destroy: () => this.destroySlot(slotId),
    };
  }

  /**
   * Drop slots whose plugin is gone, hide slots whose plugin is disabled or
   * broken. Runs at the end of every sync — install / uninstall / rollback /
   * enable / disable all funnel through `onExtensionsChanged → sync()`.
   */
  private reconcile(): void {
    const { registry } = this.opts;
    for (const slotId of [...this.registered]) {
      const pluginId = slotId.slice(0, slotId.indexOf(':'));
      const plugin = pluginId ? registry.get(pluginId) : undefined;
      if (!plugin) this.destroyPluginSlots(pluginId);
      else if (!plugin.enabled || plugin.state === 'incompatible' || plugin.state === 'error')
        this.hidePluginSlots(pluginId);
    }
  }

  /** Slots currently present in the window's view tree. */
  private readonly attached = new Set<string>();

  private hideSlot(slotId: string): void {
    const view = this.views.get(slotId);
    if (!view) return;
    const win = this.opts.getWindow();
    if (win && this.attached.has(slotId)) {
      try {
        win.contentView.removeChildView(view);
      } catch {
        /* window or view already gone */
      }
    }
    this.attached.delete(slotId);
    // The panel went away, so any engine view positioned inside its page must
    // go too — a hidden panel with a live engine rectangle would eat clicks.
    const pluginId = slotId.slice(0, slotId.indexOf(':'));
    this.detachEngineSlots(pluginId);
  }

  /** Hide the engine slot(s) of one plugin (handler.hide — the view itself is untouched). */
  private detachEngineSlots(pluginId: string): void {
    for (const id of this.engineRegistered) {
      if (id.startsWith(`${pluginId}:`)) this.opts.liveSlots.detach(id);
    }
  }

  /**
   * The plugin's panel view that is currently on screen — the coordinate
   * anchor for translating page-local engine-slot bounds into window space.
   * A plugin page can only report while its view is attached, so exactly one
   * of these exists whenever an engine slot shows; if none does, the caller
   * hides the engine rather than positioning it somewhere imaginary.
   */
  private attachedPanelView(pluginId: string): WebContentsView | null {
    for (const slotId of this.attached) {
      if (!slotId.startsWith(`${pluginId}:`)) continue;
      const view = this.views.get(slotId);
      if (view && !view.webContents.isDestroyed()) return view;
    }
    return null;
  }

  /** Hide every panel view — the stale-overlay guard for renderer reloads. */
  hideAll(): void {
    for (const slotId of [...this.attached]) this.hideSlot(slotId);
  }

  /**
   * Hand every surviving panel view of `pluginId` to `wire` — which should
   * push a fresh backend MessagePort (PluginSystem.ensureUiPort).
   *
   * Views are reused across disable/enable and crash restarts: the page never
   * reloads, so its preload never re-requests the port, and without this the
   * panel would keep talking into the dead process's port — every
   * piSDK.request timing out, every backend push silently dropped.
   */
  rewirePluginPorts(pluginId: string, wire: (wc: WebContents) => void): void {
    for (const [slotId, view] of this.views) {
      if (!slotId.startsWith(`${pluginId}:`)) continue;
      if (view.webContents.isDestroyed()) continue;
      wire(view.webContents);
    }
  }

  /** Tear down one panel view entirely. Only ever for a plugin that is GONE
   *  (uninstalled) or a dead webContents being rebuilt — disable keeps views. */
  private destroySlot(slotId: string): void {
    this.hideSlot(slotId);
    const view = this.views.get(slotId);
    const mounted = this.mounted.get(slotId);
    this.views.delete(slotId);
    this.registered.delete(slotId);
    this.mounted.delete(slotId);
    // Tell the backend this tab is gone before the page dies, so per-tab
    // state (the viewer's open document, "current file" bookkeeping) is
    // released. The send is queued to the renderer; closing on the next tick
    // gives the preload a chance to forward it onto the panel's port.
    if (view && mounted?.tabId && !view.webContents.isDestroyed()) {
      try {
        view.webContents.send('pi:plugin:panel-closed', {
          panelId: mounted.panelId,
          tabId: mounted.tabId,
        });
      } catch {
        /* page already gone */
      }
    }
    setTimeout(() => {
      try {
        view?.webContents.close();
      } catch {
        /* already gone */
      }
    }, 0);
  }

  /**
   * Uninstall cleanup: close every panel view of `pluginId` (its webContents
   * and renderer process go away) and unregister its engine slot handler —
   * which hides the engine view but must NOT close it, since the engine and
   * its persisted session belong to the host, not to the plugin.
   */
  destroyPluginSlots(pluginId: string): void {
    for (const slotId of [...this.registered]) {
      if (!slotId.startsWith(`${pluginId}:`)) continue;
      if (this.engineRegistered.has(slotId)) {
        this.opts.liveSlots.unregister(slotId);
        this.engineRegistered.delete(slotId);
        this.registered.delete(slotId);
      } else {
        this.destroySlot(slotId);
      }
    }
  }

  /**
   * Disable / error cleanup: hide everything the plugin has on screen — panel
   * views and engine — but keep views, slots and their pages intact so a
   * re-enable brings them back exactly as they were (藏而不毁).
   */
  hidePluginSlots(pluginId: string): void {
    for (const slotId of [...this.registered]) {
      if (!slotId.startsWith(`${pluginId}:`)) continue;
      this.opts.liveSlots.detach(slotId);
    }
  }

  /**
   * Lazily create the view for a slot, or return the existing one.
   *
   * Created on first attach rather than at boot so that a plugin with many
   * panels costs nothing until a panel is actually shown, and so a panel that
   * is never opened never loads its page.
   */
  private ensureView(
    slotId: string,
    pluginId: string,
    panelId: string,
    entry: string,
    tabKey?: string,
  ): WebContentsView | null {
    const existing = this.views.get(slotId);
    if (existing && !existing.webContents.isDestroyed()) return existing;
    if (existing) this.destroySlot(slotId); // dead webContents (crash) → rebuild

    const view = new WebContentsView({
      webPreferences: {
        // Same posture as the shell window (window-manager.ts): the preload
        // needs Node's process.argv to learn its plugin id, and runs with
        // contextIsolation on so the page never sees ipcRenderer directly.
        preload: join(__dirname, '../preload/plugin-view.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // The preload reads this to know which plugin it is serving — a view is
        // created per panel, so it cannot be baked into the script.
        additionalArguments: [
          `--pi-plugin-id=${pluginId}`,
          `--pi-tab-key=${tabKey ?? ''}`,
        ],
      },
    });
    // Start hidden at 0×0: the renderer reports real bounds in show().
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

    // A plugin page must not escape the panel system. `window.open` /
    // target=_blank would pop a child window outside the app's layout, and a
    // top-frame navigation to the wider web would REPLACE the panel page —
    // the panel, its backend channel and its open params gone with it. (The
    // browser engine carries the same two guards for the same reason.)
    // External http(s) links open in the user's browser instead; navigations
    // within the plugin's own origin are its own business (multi-page UIs).
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) {
        void shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (event, url) => {
      let target: URL | null = null;
      try {
        target = new URL(url);
      } catch {
        /* unparseable → treat as external below */
      }
      if (target && target.protocol === 'pi-plugin:' && target.host === pluginId) return;
      event.preventDefault();
      if (target && /^https?:$/.test(target.protocol)) {
        void shell.openExternal(url).catch(() => {});
      }
    });

    // The pi-plugin:// handler injects __pi_sdk.js into HTML responses, so the
    // page gets the SDK exactly as it did inside an iframe. The panel id on the
    // query string is how the handler learns which panel is loading — a
    // pi-plugin:// request carries no caller identity of its own.
    const url = panelUrl(pluginId, panelId, entry);
    view.webContents.loadURL(url).catch((err) => {
      console.error(`[plugin-view] load failed for ${slotId}:`, err?.message ?? err);
    });

    // Late-created views miss the shell's last theme push, so replay it once
    // the page can receive it. The same goes for the mount report on a RELOAD:
    // the shell only reports when it mounts the slot, so a page that comes
    // back on its own would otherwise never learn its session or workspace.
    view.webContents.on('did-finish-load', () => {
      if (view.webContents.isDestroyed()) return;
      if (this.lastTheme) view.webContents.send('pi:plugin:theme', this.lastTheme);
      const mounted = this.mounted.get(slotId);
      if (mounted) view.webContents.send('pi:plugin:panel-mounted', mounted);
    });

    // A crashed renderer leaves a blank rectangle above the shell; surface it
    // rather than letting it silently swallow clicks. The page is gone, so its
    // engine slot has no live reporter either — hide the plugin's everything.
    view.webContents.on('render-process-gone', (_e, details) => {
      console.error(`[plugin-view] ${slotId} renderer gone: ${details.reason}`);
      this.hidePluginSlots(pluginId);
      this.hideSlot(slotId);
      this.views.delete(slotId);
    });

    // A different-document navigation (incl. reload) tears down the page's
    // live-slot binding: the fresh page re-binds on load and its first bounds
    // report re-positions the engine, but until then the old rect must not
    // linger. Same-document (SPA) navigations keep the page alive — skip them.
    view.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      this.detachEngineSlots(pluginId);
    });

    this.views.set(slotId, view);
    return view;
  }
}
