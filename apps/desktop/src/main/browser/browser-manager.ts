import { WebContentsView, BrowserWindow, session, nativeImage } from 'electron';
import { readFile } from 'node:fs/promises';
import { BROWSER_HELPERS_JS } from './browser-helpers';
import {
  ensureBrowserSessionCookieWatcher,
  persistBrowserSessionCookies,
  scheduleBrowserSessionCookiePersist,
} from './browser-session';
import type { VlmAnalyzer } from './vlm-analyzer';

/** Snapshot node — simplified accessibility tree. */
export interface SnapshotNode {
  role: string;
  name: string;
  ref?: string;
  children?: SnapshotNode[];
}

/** Page analysis — platform-agnostic page classification after navigation. */
export interface PageAnalysis {
  /** 'content' = normal page, 'gate' = few elements (login/auth), 'error' = error page, 'empty' = nothing rendered yet  */
  pageState: 'content' | 'gate' | 'error' | 'loading' | 'empty';
  /** Count of visible interactive elements */
  elementCount: number;
  /** Action-oriented buttons/links found on the page with risk classification */
  coreActions: Array<{ text: string; risk: 'low' | 'high' }>;
  /** Whether the page has text/password/email input fields */
  hasForm: boolean;
  /** Human-readable summary of page state, e.g. "Gate page with low-risk action(s): '登录'. Safe to auto-click." */
  summary: string;
  /**
   * Human-only gates. 'captcha' asserts a person is present; 'login' asserts
   * whose account this is. The agent must hand these back to the user rather
   * than clicking or typing through them.
   */
  authKind?: 'captcha' | 'login' | null;
}

/** Result of a single navigation step in a walk. */
export interface WalkStep {
  /** The text label that was searched for */
  action: string;
  /** The element that was clicked */
  selector: string;
  /** Whether this step succeeded */
  success: boolean;
  /** Error message if step failed */
  error?: string;
}

/** Result of a goal-oriented navigation via walk(). */
export interface WalkResult {
  /** Original goal description */
  goal: string;
  /** Destination URL after walk completed */
  url: string;
  /** Destination page title */
  title: string;
  /** Whether the walk reached a new page (not stuck on the starting page) */
  reached: boolean;
  /** Individual steps taken */
  steps: WalkStep[];
  /** Final page analysis after walk */
  page: PageAnalysis;
}

/** One live tab, as reported by tabList(). */
export interface TabInfo {
  id: string;
  url: string;
  title: string;
  /** Whether this tab is the visible one. */
  active: boolean;
  /** True when the tab was closed by the LRU cap — re-activation reloads `url`. */
  evicted?: boolean;
}

type UrlChangedCallback = (tabId: string, url: string) => void;
type WindowOpenCallback = (url: string, disposition: string, sourceTabId: string) => void;

/**
 * Web preferences shared by every engine view — one Chromium profile
 * (cookies/storage), one renderer process per tab.
 */
const ENGINE_WEB_PREFS = {
  partition: 'persist:pi-browser',
  contextIsolation: true,
  sandbox: true,
  backgroundThrottling: false,
} as const;

/**
 * Spoof a standard Chrome UA — zhipin.com and similar CDNs drop Electron's
 * default.
 *
 * The version has to come from the Chromium this build actually ships:
 * `Sec-CH-UA` is not spoofable the same way, so a UA claiming Chrome/130 while
 * the client hints say Chromium/140 is a fingerprint mismatch Cloudflare can
 * see — its challenge then spins at "Checking your Browser…" forever.
 */
const CHROME_MAJOR = (process.versions.chrome || '130.0.0.0').split('.')[0];
export const ENGINE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

/**
 * Hard ceiling on live engine views — each tab is a renderer process
 * (~tens of MB). Past it the least-recently-shown tab is closed, keeping its
 * URL so re-activation reloads rather than resurrecting.
 */
const MAX_TABS = 8;

/**
 * One browser tab: a live engine view plus everything scoped to it. The
 * manager owns the tab SET and the one-visible invariant; a tab never manages
 * its own visibility or lifecycle.
 */
class BrowserTab {
  readonly id: string;
  readonly view: WebContentsView;
  readonly wc: Electron.WebContents;
  /** CDP debugger attached — lazily, on first automation command. */
  debuggerAttached = false;
  /** Live zoom factor of this tab's page. */
  currentZoom = 1;
  /** A navigate() is in flight — load handlers skip their work. */
  isNavigating = false;
  zoomComputing = false;
  zoomChainTimers: ReturnType<typeof setTimeout>[] = [];
  metricsWidth = 0;
  /** The panel width this tab last knew — the fit target. */
  webviewWidth = 600;
  /** Last non-degenerate bounds — the compositor-refresh restore target. */
  lastBounds: { x: number; y: number; width: number; height: number } | null = null;
  refreshCompositorTimer: ReturnType<typeof setTimeout> | null = null;
  /** Millis of the last show — the LRU eviction rank. */
  lastShownAt = 0;
  /** Isolated-world context per child frame — the only way into cross-origin ones. */
  frameContexts: Map<string, number> | null = null;
  /** Ref numbers handed to each frame's documents start at this base. */
  frameRefBase: Map<string, number> | null = null;
  /** Ref id → frameId, so an action on a frame's ref runs in that frame. */
  refFrames: Map<string, string> | null = null;
  /** Monotonic allocator for frame ref bases. */
  frameSeq = 0;
  /** Message of the last JS dialog (confirm/alert/beforeunload), cleared per action. */
  lastDialog: string | null = null;
  /** How to answer the next JS dialog. Dismiss is the safe default. */
  dialogPolicy: 'accept' | 'dismiss' = 'dismiss';

  constructor(id: string, view: WebContentsView) {
    this.id = id;
    this.view = view;
    this.wc = view.webContents;
  }

  alive(): boolean {
    try {
      return !this.wc.isDestroyed();
    } catch {
      return false;
    }
  }
}

/** Returned instead of typing into a password field. */
const PASSWORD_REFUSAL = (selector: string) => ({
  selector,
  value: '',
  error:
    '密码字段必须由用户本人填写——认证动作（登录、验证码）不由 agent 完成。' +
    '请在右侧浏览器面板里由用户登录，完成后再继续。',
});

/** What the page looked like around an action, for the "what happened" line. */
export interface PageProbe {
  url: string;
  text: string;
}

/**
 * Turn the before/after probes into one short sentence.
 *
 * The agent used to spend a `browser_evaluate` or a screenshot after almost
 * every action just to answer "did that work?". The host can answer it from
 * the page itself, for free, and hand back the line the model was looking for.
 */
export function describePageChange(before: PageProbe | undefined, after: PageProbe | undefined): string {
  if (!after) return '';
  if (!before) return '页面已加载';
  if (before.url !== after.url) return `页面跳转到 ${after.url}`;

  const seen = new Set(
    before.text.split('\n').map((s) => s.trim()).filter(Boolean),
  );
  for (const line of after.text.split('\n')) {
    const t = line.trim();
    if (t && !seen.has(t)) return `页面出现「${t.slice(0, 120)}」`;
  }
  if (before.text !== after.text) return '页面内容已变化，但没有新增文字';
  return '页面没有明显变化';
}

/**
 * BrowserManager — the tab set of the embedded browser engine.
 *
 * Each tab is one `WebContentsView` on the host window's contentView, one
 * renderer process, one lazily-attached CDP debugger session. The invariant
 * the whole host relies on: **at most one tab has non-zero bounds at any
 * moment, and that view sits last in the contentView's children** (native
 * views stack in child order; a stale non-zero view would paint over the
 * visible panel and eat real clicks). `showTab` is the only writer of
 * non-zero bounds; `hide` and every switch go through it.
 *
 * Session configuration (UA, permission handlers, the shared partition) is
 * per-profile, applied once; everything page-scoped — zoom, navigation state,
 * compositor repairs — is per tab.
 *
 * Uses Electron's webContents.debugger API instead of Playwright's
 * page enumeration because Playwright's connectOverCDP does not expose
 * `type: "webview"` CDP targets (Electron 38).
 */
export class BrowserManager {
  private mainWindow: BrowserWindow | null = null;
  private tabs = new Map<string, BrowserTab>();
  private tabSeq = 0;
  private activeTabId: string | null = null;
  /** Profile-level session config applied once (UA, permissions, cert policy). */
  private sessionConfigured = false;
  private urlChangedCallbacks: UrlChangedCallback[] = [];
  private windowOpenCallbacks: WindowOpenCallback[] = [];
  /** Tabs closed by the LRU cap: their URL survives so re-activation reloads. */
  private evictedTabs = new Map<string, { url: string; title: string }>();
  /** Serializes surface borrows (see withTabSurface). */
  private surfaceChain: Promise<unknown> = Promise.resolve();

  /** ─── Manual zoom (ctrl+wheel / pinch), Chrome-style ─── */

  private static readonly ZOOM_MIN = 0.5;
  private static readonly ZOOM_MAX = 3;
  private static readonly ZOOM_STEP = 1.1;
  /**
   * Auto-fit never shrinks below this: a desktop page wider than the panel
   * scrolls horizontally instead of rendering at ant size — the 0.3 floor used
   * to make every wide page unreadable. Manual zoom can still go lower; the
   * user asked for it.
   */
  private static readonly AUTO_FIT_MIN = 0.75;

  /**
   * The user's manual zoom, remembered per origin like a browser remembers it:
   * it survives navigation, page loads and panel resizes, and outranks
   * auto-fit — auto-fit computes where the content WOULD sit, the user says
   * where they want it. Cleared per origin with Cmd+0 / Ctrl+0. Per PROFILE
   * (not per tab): it is the site the user remembers, whichever tab shows it.
   */
  private userZoomByOrigin = new Map<string, number>();

  /**
   * `idPrefix` namespaces tab ids for a multi-window app (`w2:t3`). Tab ids
   * are reported to plugin backends and carried in host events, so they must
   * stay unique across windows; the window that owns a tab is resolved by
   * asking each manager whether it knows the id.
   */
  constructor(private readonly opts: { idPrefix?: string } = {}) {}

  /** True when this manager owns (or has an evicted record for) the tab. */
  knowsTab(tabId: string): boolean {
    return this.tabs.has(tabId) || this.evictedTabs.has(tabId);
  }

  /** ——— Host window / tab lifecycle ——— */

  /** Give the manager the window tabs attach to. Call once at startup. */
  attach(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow;
  }

  /** Resolve a tab by id, or the active one when omitted. */
  private tab(tabId?: string): BrowserTab | null {
    if (tabId) return this.tabs.get(tabId) ?? null;
    return (this.activeTabId && this.tabs.get(this.activeTabId)) || null;
  }

  private requireTab(tabId?: string): BrowserTab {
    const t = this.tab(tabId);
    if (!t) {
      throw new Error(tabId ? `no such browser tab: ${tabId}` : 'no active browser tab');
    }
    return t;
  }

  /**
   * Create a tab. `activate: true` (default) makes it the target of the next
   * show; the slot's bounds report positions it. The LRU cap closes the
   * least-recently-shown other tab first.
   */
  createTab(opts: { url?: string; activate?: boolean; id?: string } = {}): BrowserTab {
    if (!this.mainWindow) {
      throw new Error('BrowserManager.attach() has not been called');
    }
    if (opts.id && this.tabs.has(opts.id)) return this.tabs.get(opts.id)!;

    this.evictIfNeeded();

    const seq = `t${++this.tabSeq}`;
    const id = opts.id ?? (this.opts.idPrefix ? `${this.opts.idPrefix}:${seq}` : seq);
    const view = new WebContentsView({ webPreferences: { ...ENGINE_WEB_PREFS } });
    const t = new BrowserTab(id, view);
    this.wireTab(t);
    // Hidden until the slot shows it: a fresh view must never paint anywhere.
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    this.mainWindow.contentView.addChildView(view);
    this.tabs.set(id, t);
    t.wc.loadURL(opts.url ?? 'about:blank').catch(() => {});
    if (opts.activate !== false) {
      this.activeTabId = id;
      t.lastShownAt = Date.now();
    }
    return t;
  }

  /** Close a tab. `keepRecord` (LRU eviction) keeps the URL for re-activation. */
  closeTab(tabId: string, opts: { keepRecord?: boolean } = {}): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    // A closed tab cannot keep the split's second pane — the panel re-reports
    // after collapsing, but the stale view must not outlive the tab.
    if (this.splitPartner === tabId) this.splitPartner = null;
    if (opts.keepRecord) {
      let title = '';
      try {
        title = t.wc.getTitle() ?? '';
      } catch {
        /* destroyed */
      }
      this.evictedTabs.set(tabId, { url: t.wc.getURL() ?? '', title });
    }
    try {
      if (t.debuggerAttached) t.wc.debugger.detach();
    } catch { /* ignore */ }
    try {
      this.mainWindow?.contentView.removeChildView(t.view);
      t.wc.close();
    } catch { /* ignore */ }
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) this.activeTabId = null;
  }

  /**
   * Past the cap, close the least-recently-shown tab that is not the active
   * one — its URL is kept so the tab strip can bring it back.
   */
  private evictIfNeeded(): void {
    if (this.tabs.size < MAX_TABS) return;
    let coldest: BrowserTab | null = null;
    for (const t of this.tabs.values()) {
      if (t.id === this.activeTabId) continue;
      if (!coldest || t.lastShownAt < coldest.lastShownAt) coldest = t;
    }
    if (coldest) {
      console.log(`[BrowserManager] LRU: closing tab ${coldest.id} (${coldest.wc.getURL()})`);
      this.closeTab(coldest.id, { keepRecord: true });
    }
  }

  /** All tabs, live and LRU-evicted, in creation order. */
  tabList(): TabInfo[] {
    const live: TabInfo[] = [];
    for (const t of this.tabs.values()) {
      if (!t.alive()) continue;
      live.push({
        id: t.id,
        url: t.wc.getURL() ?? '',
        title: ((): string => {
          try {
            return t.wc.getTitle() ?? '';
          } catch {
            return '';
          }
        })(),
        active: t.id === this.activeTabId,
      });
    }
    for (const [id, rec] of this.evictedTabs) {
      live.push({ id, url: rec.url, title: rec.title, active: false, evicted: true });
    }
    return live;
  }

  /**
   * Focus a tab. If it was LRU-evicted, it is recreated from its kept URL —
   * page state is lost (that is what eviction means) but the address survives.
   */
  activateTab(tabId: string): void {
    if (this.tabs.has(tabId)) {
      this.activeTabId = tabId;
      this.tabs.get(tabId)!.lastShownAt = Date.now();
      return;
    }
    const rec = this.evictedTabs.get(tabId);
    if (!rec) throw new Error(`no such browser tab: ${tabId}`);
    this.evictedTabs.delete(tabId);
    this.createTab({ id: tabId, url: rec.url, activate: true });
  }

  /** The currently focused tab, if any. */
  activeTab(): BrowserTab | null {
    return this.tab();
  }

  /**
   * The tab currently shown in the split view's SECOND pane (null = no
   * split). `showTab` must not zero it, or the two panes would fight.
   */
  private splitPartner: string | null = null;

  /** Record which tab the panel's secondary engine slot is showing (or none). */
  setSplitPartner(tabId: string | null): void {
    this.splitPartner = tabId && this.tabs.has(tabId) ? tabId : null;
  }

  /**
   * Show a tab at `bounds` — the ONLY writer of non-zero bounds. Enforces the
   * one-visible invariant: every other view goes to 0×0 first (the split
   * partner excepted — the two panes coexist), then the target is sized and
   * re-topped (native views stack in child order — the engine must sit above
   * panel views or clicks land on the DOM beneath).
   */
  showTab(tabId: string | undefined, bounds: { x: number; y: number; width: number; height: number }): void {
    const t = this.tab(tabId);
    if (!t) return;
    const others = [...this.tabs.values()].filter((x) => x !== t && x.id !== this.splitPartner);
    for (const o of others) {
      try {
        o.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      } catch { /* ignore */ }
    }
    try {
      t.view.setBounds(bounds);
      t.lastBounds = { ...bounds };
      t.lastShownAt = Date.now();
      this.activeTabId = t.id;
      // Re-top: if a panel view joined the tree after this engine view, it
      // would paint over the engine — re-append to keep the engine last.
      this.retop(t);
      void this.setDeviceMetrics(bounds.width, bounds.height, t).catch(() => {});
    } catch (err) {
      console.warn('[BrowserManager] showTab failed:', err);
    }
  }

  /**
   * The split view's secondary pane: size and reveal THIS tab without
   * touching the primary's view. Focus stays with the primary — the address
   * bar and navigation act on it.
   */
  showSecondary(tabId: string | undefined, bounds: { x: number; y: number; width: number; height: number }): void {
    const t = this.tab(tabId);
    if (!t) return;
    this.splitPartner = t.id;
    const others = [...this.tabs.values()].filter((x) => x !== t && x.id !== this.activeTabId);
    for (const o of others) {
      try {
        o.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      } catch { /* ignore */ }
    }
    try {
      t.view.setBounds(bounds);
      t.lastBounds = { ...bounds };
      t.lastShownAt = Date.now();
      this.retop(t);
      void this.setDeviceMetrics(bounds.width, bounds.height, t).catch(() => {});
    } catch (err) {
      console.warn('[BrowserManager] showSecondary failed:', err);
    }
  }

  /**
   * Show one engine tab at `bounds` WITHOUT enforcing the one-visible rule.
   *
   * Used by per-host-tab engine slots: in a right-column split two browser
   * panels are on screen at once and each owns a different engine tab, so
   * hiding "all the others" on every report would make the panes fight. Hiding
   * is explicit per tab (`hideTab`) when a panel goes away.
   */
  showTabTile(
    tabId: string | undefined,
    bounds: { x: number; y: number; width: number; height: number },
  ): void {
    const t = this.tab(tabId);
    if (!t) return;
    try {
      t.view.setBounds(bounds);
      t.lastBounds = { ...bounds };
      t.lastShownAt = Date.now();
      this.activeTabId = t.id;
      this.retop(t);
      void this.setDeviceMetrics(bounds.width, bounds.height, t).catch(() => {});
    } catch (err) {
      console.warn('[BrowserManager] showTabTile failed:', err);
    }
  }

  /** Zero one engine tab's view, leaving every other pane alone. */
  hideTab(tabId: string | undefined): void {
    const t = this.tab(tabId);
    if (!t) return;
    try {
      t.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      t.lastBounds = null;
    } catch {
      /* view already gone */
    }
  }

  /** Zero the secondary pane's view (split collapsed or its slot hidden). */
  hideSecondary(): void {
    this.splitPartner = null;
    // The next primary slot report re-lays the single pane; zero the rest now
    // so no stale secondary view keeps painting.
    for (const t of this.tabs.values()) {
      if (t.id === this.activeTabId) continue;
      try {
        t.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        t.lastBounds = null;
      } catch { /* ignore */ }
    }
  }

  /** Re-append a tab's view so it sits above every other view in the tree. */
  private retop(t: BrowserTab): void {
    const children = this.mainWindow?.contentView.children ?? [];
    if (children.length > 0 && children[children.length - 1] !== t.view) {
      this.mainWindow!.contentView.removeChildView(t.view);
      this.mainWindow!.contentView.addChildView(t.view);
    }
  }

  /** Hide every tab (set zero-size bounds). The slot reports a degenerate rect. */
  hide(): void {
    for (const t of this.tabs.values()) {
      try {
        t.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        t.lastBounds = null;
      } catch { /* ignore */ }
    }
  }

  /**
   * Borrow the visible surface for a background tab's operation. Some CDP
   * work (viewport screenshots, VLM walk) needs a real painted surface; a
   * 0×0 view has none. The visible tab is hidden for the duration and
   * restored after. Borrowings serialize — two walks must not fight over the
   * one rectangle. DOM-level automation (click/fill/evaluate/snapshot) does
   * NOT go through this and runs on any tab concurrently.
   */
  private withTabSurface<T>(t: BrowserTab, fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const visible = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
      const borrow = t !== visible;
      const restore = visible?.lastBounds ?? null;
      if (borrow) {
        if (visible && restore) {
          try {
            visible.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
          } catch { /* ignore */ }
        }
        const bounds = restore ?? { x: 0, y: 0, width: 800, height: 600 };
        try {
          t.view.setBounds(bounds);
          const children = this.mainWindow?.contentView.children ?? [];
          if (children.length > 0 && children[children.length - 1] !== t.view) {
            this.mainWindow!.contentView.removeChildView(t.view);
            this.mainWindow!.contentView.addChildView(t.view);
          }
        } catch { /* ignore */ }
      }
      try {
        return await fn();
      } finally {
        if (borrow) {
          try {
            t.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
          } catch { /* ignore */ }
          if (visible && restore) {
            try {
              visible.view.setBounds(restore);
            } catch { /* ignore */ }
          }
        }
      }
    };
    const next = this.surfaceChain.then(run, run);
    this.surfaceChain = next.catch(() => undefined);
    return next;
  }

  /** Wire a fresh tab's webContents to the profile-level policies and events. */
  private wireTab(t: BrowserTab): void {
    const wc = t.wc;

    // Start watching the shared profile for login cookies the first time a tab
    // is wired; the watcher is process-wide and idempotent.
    ensureBrowserSessionCookieWatcher();
    wc.setUserAgent(ENGINE_UA);

    // Ignore certificate errors for user-browsed content (equivalent to
    // clicking "Proceed anyway" in a regular browser). The browser loads
    // arbitrary user-chosen URLs, so strict cert rejection is
    // counterproductive.
    wc.on('certificate-error', (event, _url, _error, _certificate, callback) => {
      event.preventDefault();
      callback(true); // proceed
    });

    // Configure the shared profile once: allow permissions for user-browsed
    // content, and allow insecure content (HTTP subresources on HTTPS pages)
    // which is common on Chinese sites like zhipin.com.
    if (!this.sessionConfigured) {
      const ses = session.fromPartition('persist:pi-browser');
      // The session default also covers frames/workers that outlive a tab's
      // own override — the app-wide fallback is set in main, this keeps the
      // browser partition self-consistent even if that changes.
      ses.setUserAgent(ENGINE_UA);
      ses.setPermissionRequestHandler((_wc, _permission, callback) => {
        callback(true);
      });
      this.sessionConfigured = true;
    }

    // ── Manual zoom wiring ──
    // Chromium routes ctrl+wheel and trackpad pinch to the embedder's
    // ContentsZoomChange; Electron re-emits that here WITHOUT applying a
    // zoom. Whether that delegation fires varies by input path, so the
    // deterministic channel is the helpers' zoom hook (see browser-helpers):
    // the page reports gestures as console lines and this watches for them.
    wc.on('zoom-changed', (_event, zoomDirection: 'in' | 'out') => {
      this.applyManualZoom(t, zoomDirection === 'in' ? BrowserManager.ZOOM_STEP : 1 / BrowserManager.ZOOM_STEP);
    });
    // Electron 45 moved the payload onto the event object; the positional
    // (level, message, …) arguments are deprecated.
    wc.on('console-message', (event) => {
      const message = event.message;
      if (message === '__pi-zoom:in') this.applyManualZoom(t, BrowserManager.ZOOM_STEP);
      else if (message === '__pi-zoom:out') this.applyManualZoom(t, 1 / BrowserManager.ZOOM_STEP);
    });
    // Cmd+0 / Ctrl+0 — Chrome's reset: drop this site's manual zoom and
    // re-fit. (Keyboard is the one input before-input-event can see.)
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.meta || input.control) && input.key === '0') {
        event.preventDefault();
        this.resetManualZoom(t);
      }
    });

    wc.on('did-navigate', (_event, url) => {
      if (url && !url.startsWith('about:')) {
        this.urlChangedCallbacks.forEach((cb) => cb(t.id, url));
      }
      // A login redirect lands here; persist soon after the page settles.
      scheduleBrowserSessionCookiePersist();
    });
    wc.on('did-navigate-in-page', (_event, url) => {
      if (url) {
        this.urlChangedCallbacks.forEach((cb) => cb(t.id, url));
      }
    });
    // Popups open as a NEW TAB rather than hijacking the current page — the
    // multi-tab engine can afford it, and `target=_blank` links mean "new
    // page" exactly. The handler stays deny (the host creates the view), and
    // the url is handed to whoever registered interest (main wires it to
    // createTab + a host event). about:blank is dropped outright: sites open
    // it to grab a window handle, never to be seen.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (/^https?:/i.test(url)) {
        this.windowOpenCallbacks.forEach((cb) => cb(url, disposition ?? 'foreground-tab', t.id));
      }
      return { action: 'deny' };
    });
    wc.on('did-finish-load', () => {
      if (!t.isNavigating) {
        this.injectHelpers(t);
        this.scheduleAutoZoom(t);
      }
      // Session cookies set by the login flow are memory-only until this
      // converts them to disk-backed cookies.
      scheduleBrowserSessionCookiePersist();
      // embedded-view compositing workaround: after a page load (especially
      // SPA navigations like zhipin.com's anti-bot triggered ones), the
      // native composited surface can go blank while the webContents still
      // has rendered content. Re-applying the bounds nudges the compositor
      // to redraw the surface.
      this.refreshCompositor(t);
    });

    // A tab whose webContents dies outside closeTab (the page closed itself,
    // the view was torn down) used to stay in the map: the tab strip kept the
    // old URL, every getUrl answered "about:blank", and the renderer was gone.
    // Drop the record so the tab list tells the truth.
    (wc as unknown as { on(e: 'close', cb: () => void): void }).on('close', () => {
      console.warn('[BrowserManager] page requested close:', t.id);
    });
    wc.on('destroyed', () => {
      if (this.tabs.has(t.id)) {
        console.warn('[BrowserManager] tab died outside closeTab:', t.id);
        this.closeTab(t.id);
      }
    });

    // Log renderer crashes for diagnosis (GPU/renderer process death causes
    // the embedded view's surface to go permanently white).
    wc.on('render-process-gone', (_event, details) => {
      console.error('[BrowserManager] render-process-gone:', details.reason, details);
      // A dead renderer cannot be reused. Leaving the tab in the map makes
      // every later navigate fail with "Browser tab not available" until the
      // app restarts; dropping it lets the next navigate create a fresh one.
      try {
        this.closeTab(t.id);
      } catch {}
    });
    wc.on('unresponsive', () => {
      console.warn('[BrowserManager] webContents became unresponsive');
    });
    wc.on('responsive', () => {
      console.log('[BrowserManager] webContents became responsive again');
    });
  }

  /**
   * Force a tab's compositor to redraw by re-applying its bounds. This fixes
   * the "page loads then goes white" issue caused by Chromium's compositor
   * culling the embedded view's surface after certain navigations. Debounced
   * to avoid hammering during rapid SPA route changes (zhipin.com triggers
   * many of these).
   */
  private refreshCompositor(t: BrowserTab): void {
    if (!t.lastBounds) return;
    const { x, y, width, height } = t.lastBounds;
    if (width <= 0 || height <= 0) return;
    if (t.refreshCompositorTimer) clearTimeout(t.refreshCompositorTimer);
    t.refreshCompositorTimer = setTimeout(() => {
      t.refreshCompositorTimer = null;
      try {
        // Nudge bounds by 1px then restore — forces the compositor to
        // re-evaluate and redraw the embedded view's surface.
        t.view.setBounds({ x, y, width: width + 1, height });
        t.view.setBounds({ x, y, width, height });
      } catch {
        // ignore
      }
    }, 50);
  }

  /**
   * The active tab's view, for z-order management: the slot host re-appends
   * it to the contentView when an engine slot shows, because lazily-created
   * plugin panel views join the view tree above it and would otherwise paint
   * over it.
   */
  getView(): WebContentsView | null {
    const t = this.tab();
    if (!t || !t.alive()) return null;
    return t.view;
  }

  /**
   * One engine tab's view by id. Used by the slot snapshot to capture the
   * page layer that sits inside a plugin panel's own view.
   */
  getTabView(tabId: string | undefined): WebContentsView | null {
    const t = this.tab(tabId);
    if (!t || !t.alive()) return null;
    return t.view;
  }

  /**
   * Set the ACTIVE tab's bounds (viewport-relative position and size).
   * Call from renderer via IPC to position the native overlay over the
   * placeholder div. showTab() is the multi-tab-aware writer; this stays for
   * the single-slot geometry path.
   */
  setBounds(x: number, y: number, width: number, height: number): void {
    const t = this.tab();
    if (!t) {
      console.warn('[BrowserManager] setBounds called but no tab exists');
      return;
    }
    // No log: resize streams one call per frame while a panel edge is dragged.
    t.view.setBounds({ x, y, width, height });
    t.lastBounds = { x, y, width, height };
    if (width > 0 && t.webviewWidth !== width) {
      t.webviewWidth = width;
    }
  }

  /** Get the active tab's bounds. */
  getBounds(): { x: number; y: number; width: number; height: number } {
    const t = this.tab();
    if (!t) return { x: 0, y: 0, width: 0, height: 0 };
    return t.view.getBounds();
  }

  /** ─── Connection ─── */

  /**
   * Ensure a debugger session on a tab (creating the initial tab when there
   * is none). Debugger sessions are per tab and attach lazily — eight tabs
   * must not hold eight idle CDP sessions from boot.
   */
  async connect(tabId?: string): Promise<void> {
    let t = this.tab(tabId);
    if (!t) {
      t = this.createTab({ activate: true });
    }
    const wc = t.wc;
    // Increase max listeners
    wc.setMaxListeners(50);

    // Detach any existing debugger session before attaching (handles
    // dangling sessions left after CDP errors like "target navigated").
    try { wc.debugger.detach(); } catch {}
    t.debuggerAttached = false;

    // Attach the debugger
    try {
      wc.debugger.attach('1.3');
      t.debuggerAttached = true;
    } catch (err) {
      if (err instanceof Error && err.message.includes('already attached')) {
        t.debuggerAttached = true;
      } else {
        throw err;
      }
    }

    // Listen for CDP events
    wc.debugger.on('message', (_event, method: string, params: Record<string, unknown>) => {
      if (method === 'Page.frameNavigated' && params?.frame) {
        const frame = params.frame as { id?: string; url?: string; parentId?: string };
        // A new top document invalidates every frame world and ref mapping.
        if (!frame.parentId) {
          t.frameContexts = null;
          t.frameRefBase = null;
          t.refFrames = null;
          t.frameSeq = 0;
        } else if (frame.id) {
          // A child frame that navigates gets a NEW execution context; keeping
          // the old id would make every later frame snapshot fail silently.
          t.frameContexts?.delete(frame.id);
          t.frameRefBase?.delete(frame.id);
          if (t.refFrames) {
            for (const [ref, fid] of t.refFrames) {
              if (fid === frame.id) t.refFrames.delete(ref);
            }
          }
        }
        const url = frame.url || '';
        if (url && !url.startsWith('about:')) {
          this.urlChangedCallbacks.forEach((cb) => cb(t.id, url));
        }
        if (!t.isNavigating) {
          this.injectHelpers(t);
          this.scheduleAutoZoom(t);
        }
      }

      if (method === 'Page.javascriptDialogOpening') {
        // A confirm() blocks the renderer until someone answers. Electron's
        // default is to accept, which silently confirms "删除全部" — the worst
        // possible default. Dismiss unless the caller asked to accept, and
        // remember the text so the action can report what was asked.
        const p = params as { message?: string; type?: string };
        t.lastDialog = p.message || p.type || '(对话框)';
        void this.sendCommand(t, 'Page.handleJavaScriptDialog', {
          accept: t.dialogPolicy === 'accept',
        }).catch(() => {});
      }

      if (method === 'Page.loadEventFired') {
        console.log('[BrowserManager] Page.loadEventFired');
        if (!t.isNavigating) {
          this.injectHelpers(t);
          this.scheduleAutoZoom(t);
        }
        // Refresh compositor surface after every load event (fixes the
        // "page loads then goes white" compositing bug on sites like
        // zhipin.com that trigger multiple sub-frame loads).
        this.refreshCompositor(t);
      }
    });

    // Enable necessary CDP domains
    await this.sendCommand(t, 'Page.enable');
    await this.sendCommand(t, 'Runtime.enable');
    await this.sendCommand(t, 'Accessibility.enable');

    // Inject the helpers immediately
    this.injectHelpers(t);

    // Same guard, but BEFORE any page script runs: an anti-bot script that
    // calls window.close() during load would otherwise beat the injection
    // that happens at did-finish-load (zhipin.com does exactly that).
    try {
      await this.sendCommand(t, 'Page.addScriptToEvaluateOnNewDocument', {
        source: 'try { window.close = function () {}; } catch (e) {}',
      });
    } catch {
      /* older engines: the did-finish-load copy still covers most pages */
    }

    console.log('[BrowserManager] Connected to tab', t.id, 'via debugger API');
  }

  /** Check if the debugger is attached to the target tab and it is alive. */
  isConnected(tabId?: string): boolean {
    const t = this.tab(tabId);
    if (!t || !t.debuggerAttached) return false;
    return t.alive();
  }

  /** ——— Toolbar navigation ——— */

  /** Navigate back in browsing history. */
  navigateBack(tabId?: string): void {
    const t = this.tab(tabId);
    if (t && t.wc.canGoBack()) {
      t.wc.goBack();
    }
  }

  /** Navigate forward in browsing history. */
  navigateForward(tabId?: string): void {
    const t = this.tab(tabId);
    if (t && t.wc.canGoForward()) {
      t.wc.goForward();
    }
  }

  /** Reload the current page. */
  reload(tabId?: string): void {
    this.tab(tabId)?.wc.reload();
  }

  /** Load a URL directly via webContents (handles redirects natively). */
  loadURL(url: string, tabId?: string): void {
    this.tab(tabId)?.wc.loadURL(url).catch(() => {});
  }

  /** Inject JS helpers (selector resolver, snapshot, window.open override) into a tab. */
  private injectHelpers(t: BrowserTab): void {
    const wc = t.wc;
    if (!t.alive()) return;
    try {
      // Inject the helpers (idempotent — checks window.__piHelpers)
      wc.executeJavaScript(BROWSER_HELPERS_JS).catch((err) => {
        // A syntax error in the helpers used to vanish here, leaving every
        // page without a snapshot or resolver. Never swallow it silently.
        console.error('[BrowserManager] helper injection failed:', err);
      });
      // Also inject window.open override
      wc.executeJavaScript(`
        if (!window.__pi_open_override) {
          window.__pi_open_override = true;
          window.open = function(url) {
            // about:blank is how a script grabs a window handle; sending THIS
            // tab there would blank the page (zhipin.com does exactly that
            // through an anti-bot path). A popup is denied anyway.
            if (url && !/^about:blank/i.test(String(url))) location.href = url;
            return null;
          };
        }
        document.querySelectorAll('a[target="_blank"]').forEach(function(a) {
          a.target = '_self';
        });
        // A page may not close a tab it did not open — Chrome ignores
        // window.close() there, Electron instead DESTROYS the tab's
        // webContents. zhipin.com calls close() on load, which left a blank
        // tab that no longer answered anything. Keep the tab, like Chrome.
        try { window.close = function () {}; } catch (e) {}
      `).catch(() => {});
    } catch {
      // Silently ignore — helpers are best-effort
    }
  }

  /** ─── Manual zoom ─── */

  private currentOrigin(t: BrowserTab): string {
    try {
      // Opaque origins (error pages) stringify as "null" — not a site, not a
      // zoom to remember.
      const origin = new URL(t.wc.getURL() ?? '').origin;
      return origin && origin !== 'null' ? origin : '';
    } catch {
      return '';
    }
  }

  /**
   * One notch of user zoom (a ctrl+wheel step or a pinch). The choice is
   * remembered per origin — auto-fit stops touching this site until reset.
   */
  private applyManualZoom(t: BrowserTab, factor: number): void {
    const origin = this.currentOrigin(t);
    if (!origin) return;
    const base = this.userZoomByOrigin.get(origin) ?? t.currentZoom;
    const next = Math.min(BrowserManager.ZOOM_MAX, Math.max(BrowserManager.ZOOM_MIN, base * factor));
    this.userZoomByOrigin.set(origin, next);
    t.currentZoom = next;
    this.applyZoom(t);
    // A load's auto-fit chain may still be pending; the map check in
    // computeAutoZoom would neutralize it anyway, but skip the work.
    this.cancelScheduledZoom(t);
  }

  /** Cmd+0 / Ctrl+0: forget this site's manual zoom and re-fit. */
  private resetManualZoom(t: BrowserTab): void {
    this.userZoomByOrigin.delete(this.currentOrigin(t));
    t.currentZoom = 1;
    this.applyZoom(t);
    this.scheduleAutoZoom(t);
  }

  /**
   * Re-fit zoom after a load, on a short chain rather than once: pages render
   * progressively, and the width a page reports 200ms after load is often not
   * the width it reports once images and late right-hand columns arrive. Each
   * check is cheap (one CDP evaluate, no zoom reset), so a chain of a few is
   * fine — extra runs on an already-fitted page are no-ops. Cancelled by
   * navigation (`cancelScheduledZoom`).
   */
  private scheduleAutoZoom(t: BrowserTab): void {
    this.cancelScheduledZoom(t);
    t.zoomChainTimers = [200, 800, 2000, 4000].map((delay) =>
      setTimeout(() => void this.computeAutoZoom(t), delay),
    );
  }

  /** Cancel any pending scheduled zoom (e.g., when navigate starts). */
  private cancelScheduledZoom(t: BrowserTab): void {
    for (const timer of t.zoomChainTimers) clearTimeout(timer);
    t.zoomChainTimers = [];
  }

  /** Measure page content width vs webview width and auto-fit zoom. */
  private async computeAutoZoom(t: BrowserTab): Promise<void> {
    // Re-entrant guard — prevent concurrent zoom computations on one tab
    if (t.zoomComputing) return;
    const wc = t.wc;
    if (!t.alive()) return;
    t.zoomComputing = true;
    try {
      const panelW = t.webviewWidth;
      if (panelW <= 0) return;
      // The user's manual zoom outranks the fit: apply it and leave the page
      // alone — they zoomed on purpose, and re-fitting would fight them.
      const userZoom = this.userZoomByOrigin.get(this.currentOrigin(t));
      if (userZoom !== undefined) {
        if (Math.abs(userZoom - t.currentZoom) > 0.01) {
          t.currentZoom = userZoom;
          await this.applyZoom(t);
        }
        return;
      }
      // Measure at the CURRENT zoom — no reset-to-1, no relayout wait. The
      // old reset→wait→measure loop was visible as a flash on every resize
      // step, and its re-entrancy guard silently dropped overlapping fits,
      // leaving the page at a stale zoom.
      const result = await this.sendCommand(t, 'Runtime.evaluate', {
        expression: `JSON.stringify({s: Math.max(
          document.documentElement ? document.documentElement.scrollWidth : 0,
          document.body ? document.body.scrollWidth : 0
        ), c: document.documentElement ? document.documentElement.clientWidth : 0})`,
        returnByValue: true,
      });
      const dims = JSON.parse(
        (result?.result as { value?: string })?.value ?? '{"s":0,"c":0}',
      ) as { s: number; c: number };
      if (!dims.s || !dims.c) return;
      // `overflow-x: clip` pages report documentElement.scrollWidth ==
      // clientWidth no matter how wide their content is — comparing the html
      // element alone concludes "fits" while the right side is being clipped
      // (baidu's results page does exactly this). body.scrollWidth still sees
      // through the clip, hence the max. Both sides exclude the scrollbar, so
      // the comparison does not drift with scrollbar presence.
      let target = t.currentZoom;
      if (dims.s > dims.c + 2) {
        // Content wider than the viewport → shrink so it just fits.
        target = Math.max(BrowserManager.AUTO_FIT_MIN, panelW / dims.s);
      } else if (dims.s < dims.c - 2) {
        // Dead margin (fixed-width page seen through a zoom inherited from a
        // wider one) → grow so the content fills the panel.
        target = Math.max(BrowserManager.AUTO_FIT_MIN, panelW / dims.s);
      }
      // Exact fit and fluid pages (s == c at any zoom) are fixed points —
      // left alone. The hysteresis keeps a scrollbar-noise step from
      // re-applying a ~2% zoom forever.
      if (Math.abs(target - t.currentZoom) > 0.02) {
        t.currentZoom = target;
        await this.applyZoom(t);
      }
    } catch (err) {
      // "Inspected target navigated or closed" lands here when a page
      // navigates mid-measure — the post-load chain re-checks shortly after.
      console.warn('[BrowserManager] computeAutoZoom error:', err);
    } finally {
      t.zoomComputing = false;
    }
  }

  private async applyZoom(t: BrowserTab): Promise<void> {
    // No log: panel drags apply a zoom per width step.
    try { t.wc.setZoomFactor(t.currentZoom); } catch {}
  }

  /** ——— CDP communication ——— */

  /**
   * Send a CDP command to a tab via Electron's debugger API, attaching the
   * session lazily on first use.
   * Electron automatically manages CDP message IDs and routes responses.
   */
  private async sendCommand(
    t: BrowserTab,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (!t.debuggerAttached) {
      await this.connect(t.id);
    }
    if (!t.debuggerAttached) {
      throw new Error('Debugger not attached');
    }
    // Wrap with timeout
    const timeoutMs = 30000;
    return Promise.race([
      t.wc.debugger.sendCommand(method, params),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`CDP command "${method}" timed out`)), timeoutMs),
      ),
    ]) as Promise<Record<string, unknown>>;
  }

  /** ——— Core browser operations ——— */

  /**
   * Navigate to a URL and analyze the resulting page.
   *
   * By default, automatically handles gate pages (login, authorization, etc.)
   * by clicking low-risk action buttons. Set `autoHandleGate: false` to disable.
   */
  async navigate(
    url: string,
    options?: { autoHandleGate?: boolean; maxGateRetries?: number },
    tabId?: string,
  ): Promise<{ url: string; title: string; page: PageAnalysis }> {
    const t = this.requireTab(tabId);
    const autoHandleGate = options?.autoHandleGate !== false;
    const maxGateRetries = options?.maxGateRetries ?? 2;

    t.isNavigating = true;
    this.cancelScheduledZoom(t);
    try {
      // Use webContents.loadURL() for navigation — handles redirects natively
      if (!t.alive()) throw new Error('Browser tab not available');
      t.wc.loadURL(url);
      // Wait for page to load (DOM complete)
      await this.waitForPageLoad(t);
      // Extra wait for SPA rendering (JS-heavy pages like WeChat, DingTalk)
      await this.waitForSpaReady(t);
      let title = await this.getTitle(t);
      let currentUrl = await this.getCurrentUrl(t);
      // Analyze page to help LLM determine next action
      let page = await this.analyzePage(t);

      // Auto-handle gate pages: click low-risk actions (login, agree, confirm, etc.)
      // Never click through a human-verification or login gate: those exist to
      // prove a person is here, and the agent must not stand in for one.
      if (autoHandleGate && !page.authKind) {
        let retries = 0;
        while (page.pageState === 'gate' && retries < maxGateRetries) {
          const lowRiskAction = page.coreActions.find((a) => a.risk === 'low');
          if (!lowRiskAction) break;

          console.log('[BrowserManager] Gate page detected, auto-clicking:', lowRiskAction.text);
          const clickResult = await this.click(`text="${lowRiskAction.text}"`, t.id);
          if (!clickResult.clicked) {
            console.warn('[BrowserManager] Auto-click failed:', clickResult.error);
            break;
          }

          // Wait for page to change after click
          await this.waitForPageLoad(t);
          await this.waitForSpaReady(t);

          title = await this.getTitle(t);
          currentUrl = await this.getCurrentUrl(t);
          page = await this.analyzePage(t);
          retries++;
        }

        if (page.pageState === 'gate' && retries >= maxGateRetries) {
          console.warn(
            '[BrowserManager] Gate page persists after',
            maxGateRetries,
            'retries. May require manual action (e.g., QR code scan).',
          );
        }
      }

      // Re-inject helpers and compute auto-zoom now that navigation is complete.
      // This compensates for skipped calls in the CDP event handler during navigation.
      this.injectHelpers(t);
      await this.computeAutoZoom(t);

      return { url: currentUrl, title, page };
    } finally {
      t.isNavigating = false;
    }
  }

  /** Get the current URL. */
  async getUrl(tabId?: string): Promise<{ url: string; title: string }> {
    const t = this.requireTab(tabId);
    const [url, title] = await Promise.all([this.getCurrentUrl(t), this.getTitle(t)]);
    return { url, title };
  }

  /** Get the current page title via CDP. */
  private async getTitle(t: BrowserTab): Promise<string> {
    try {
      const result = await this.sendCommand(t, 'Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true,
      });
      return (result?.result as { value?: string })?.value ?? '';
    } catch {
      return '';
    }
  }

  /** Get the current page URL via CDP. */
  private async getCurrentUrl(t: BrowserTab): Promise<string> {
    try {
      const result = await this.sendCommand(t, 'Runtime.evaluate', {
        expression: 'window.location.href',
        returnByValue: true,
      });
      return (result?.result as { value?: string })?.value ?? 'about:blank';
    } catch {
      return 'about:blank';
    }
  }

  /** Wait for the page to finish loading (domcontentloaded). */
  private async waitForPageLoad(t: BrowserTab, timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const result = await this.sendCommand(t, 'Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        });
        const state = (result?.result as { value?: string })?.value;
        if (state === 'complete' || state === 'interactive') {
          // Extra small delay for rendering
          await new Promise((r) => setTimeout(r, 500));
          return;
        }
      } catch {
        // Ignore evaluation errors during load
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('Page load timed out');
  }

  /**
   * Wait for SPA (React/Vue/Angular) pages to finish rendering.
   *
   * After `readyState === 'complete'`, JS-heavy pages still need time to
   * bootstrap the framework and render the actual UI. We wait a minimum
   * time, then poll for DOM stability (no new children added).
   */
  private async waitForSpaReady(t: BrowserTab, timeoutMs = 8000): Promise<void> {
    const minWaitMs = 1500; // Minimum time for SPA to bootstrap
    const stabilityPollMs = 500;
    const stableThreshold = 2; // Consecutive stable polls needed

    const start = Date.now();

    // Minimum wait for SPA to bootstrap
    const elapsed = Date.now() - start;
    if (elapsed < minWaitMs) {
      await new Promise((r) => setTimeout(r, minWaitMs - elapsed));
    }

    // Poll for DOM stability
    let stableCount = 0;
    let lastCount = -1;

    while (Date.now() - start < timeoutMs) {
      try {
        const result = await this.sendCommand(t, 'Runtime.evaluate', {
          expression: 'document.body ? document.body.children.length : 0',
          returnByValue: true,
        });
        const count = (result?.result as { value?: number })?.value ?? 0;

        if (count === lastCount) {
          stableCount++;
          if (stableCount >= stableThreshold) return; // DOM stable
        } else {
          stableCount = 0;
          lastCount = count;
        }
      } catch {
        // Ignore transient eval errors
      }
      await new Promise((r) => setTimeout(r, stabilityPollMs));
    }
    // If we time out, proceed anyway — the page is as ready as it'll get
  }

  /**
   * Analyze the current page state. Runs `piAnalyzePage()` in the page context
   * to classify the page type and extract core actions the LLM might want to take.
   */
  private async analyzePage(t: BrowserTab): Promise<PageAnalysis> {
    try {
      // Ensure helpers are injected
      await this.sendCommand(t, 'Runtime.evaluate', {
        expression: BROWSER_HELPERS_JS,
        returnByValue: true,
      });
      const result = await this.sendCommand(t, 'Runtime.evaluate', {
        expression: 'window.piAnalyzePage ? JSON.stringify(window.piAnalyzePage()) : null',
        returnByValue: true,
      });
      const value = (result?.result as { value?: string })?.value;
      if (value) return JSON.parse(value) as PageAnalysis;
    } catch {
      // Page analysis is best-effort
    }

    return {
      pageState: 'empty',
      elementCount: 0,
      coreActions: [],
      hasForm: false,
      summary: 'Page analysis unavailable',
    };
  }

  /** ——— Snapshot / accessibility ——— */

  // ── Frames ──
  // A cross-origin iframe is a separate document the top page cannot touch:
  // `contentDocument` is null, so neither the snapshot nor the resolver sees
  // it. CDP can still reach it through an isolated world per frame — that is
  // how the agent gets the same fill/click it has on the main document.

  private static originOf(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  }

  private async listFrames(t: BrowserTab): Promise<Array<{ frameId: string; url: string; parentId?: string }>> {
    const out: Array<{ frameId: string; url: string; parentId?: string }> = [];
    try {
      type Node = { frame: { id: string; url: string; parentId?: string }; childFrames?: Node[] };
      const tree = await this.sendCommand(t, 'Page.getFrameTree');
      const walk = (n: Node) => {
        out.push({ frameId: n.frame.id, url: n.frame.url, parentId: n.frame.parentId });
        for (const c of n.childFrames ?? []) walk(c);
      };
      const root = (tree as { frameTree?: Node })?.frameTree;
      if (root) walk(root);
    } catch {}
    return out;
  }

  /** An isolated world in `frameId` with the helpers loaded, created once. */
  private async frameContext(t: BrowserTab, frameId: string): Promise<number | null> {
    if (!t.frameContexts) t.frameContexts = new Map();
    if (!t.frameRefBase) t.frameRefBase = new Map();
    const cached = t.frameContexts.get(frameId);
    if (cached) return cached;
    try {
      const world = await this.sendCommand(t, 'Page.createIsolatedWorld', { frameId, worldName: 'pi-helpers' });
      const ctx = (world as { executionContextId?: number })?.executionContextId;
      if (!ctx) return null;
      await this.sendCommand(t, 'Runtime.evaluate', {
        expression: BROWSER_HELPERS_JS,
        contextId: ctx,
      });
      // Refs from different documents must not collide — the model passes a
      // bare [N] and the host routes it by number. Each frame gets a wide
      // number band: a big main document can hand out refs past 999, which
      // would otherwise land inside the next frame's range.
      const base = 100000 * ++t.frameSeq;
      await this.sendCommand(t, 'Runtime.evaluate', {
        expression: `window.__piRefSeq = ${base};`,
        contextId: ctx,
      });
      t.frameContexts.set(frameId, ctx);
      t.frameRefBase.set(frameId, base);
      return ctx;
    } catch {
      return null;
    }
  }

  private async evaluateInFrame(t: BrowserTab, frameId: string, expression: string): Promise<unknown> {
    const ctx = await this.frameContext(t, frameId);
    if (!ctx) return undefined;
    try {
      const r = await this.sendCommand(t, 'Runtime.evaluate', {
        expression,
        contextId: ctx,
        returnByValue: true,
        awaitPromise: true,
      });
      return (r as { result?: { value?: unknown } })?.result?.value;
    } catch {
      return undefined;
    }
  }

  /** The frame a ref belongs to, when it belongs to a child frame. */
  private frameForSelector(t: BrowserTab, selector: string): string | null {
    const m = /^\[(\d+)\]$/.exec(selector) || /^ref:(\d+)$/.exec(selector);
    if (!m || !t.refFrames) return null;
    return t.refFrames.get(m[1]) ?? null;
  }

  /**
   * Which frame a NON-ref selector lives in.
   *
   * Refs carry their frame in the snapshot map, but a saved recipe holds a
   * stable selector like "#xn" — and a cross-origin frame's document is
   * invisible to the top page. Without this, every recorded step inside such
   * a frame resolves in the wrong document and "fails" on replay.
   *
   * Same-origin frames are skipped: the top document already reaches them.
   */
  private async resolveFrameForSelector(t: BrowserTab, selector: string): Promise<string | null> {
    const byRef = this.frameForSelector(t, selector);
    if (byRef !== null) return byRef;
    if (/^\[(\d+)\]$/.test(selector) || /^ref:\d+$/.test(selector)) return null; // stale ref
    const frames = await this.listFrames(t);
    if (frames.length <= 1) return null;
    let topOrigin = '';
    try {
      const u = await this.sendCommand(t, 'Runtime.evaluate', { expression: 'location.origin', returnByValue: true });
      topOrigin = String((u as { result?: { value?: string } })?.result?.value ?? '');
    } catch {}
    const hits: string[] = [];
    for (const f of frames) {
      if (!f.parentId) continue;
      if (f.url && BrowserManager.originOf(f.url) === topOrigin) continue;
      const found = await this.evaluateInFrame(
        t,
        f.frameId,
        `!!window.piResolveSelector(${JSON.stringify(selector)})`,
      );
      if (found === true) hits.push(f.frameId);
    }
    return hits.length === 1 ? hits[0] : null;
  }

  /** Snapshot of every cross-origin child frame, appended to the main one. */
  private async crossOriginSnapshot(t: BrowserTab, topOrigin: string): Promise<string> {
    const frames = await this.listFrames(t);
    if (frames.length <= 1) return '';
    if (!t.refFrames) t.refFrames = new Map();
    const parts: string[] = [];
    for (const f of frames) {
      if (!f.parentId) continue;
      // Same-origin frames are already walked by piSnapshot via contentDocument.
      if (f.url && BrowserManager.originOf(f.url) === topOrigin) continue;
      const text = await this.evaluateInFrame(t, f.frameId, 'window.piSnapshot ? window.piSnapshot() : ""');
      if (typeof text !== 'string' || !text.trim()) continue;
      const refs = await this.evaluateInFrame(
        t,
        f.frameId,
        'JSON.stringify(Array.prototype.map.call(document.querySelectorAll("[data-pi-ref]"), function(e){return e.getAttribute("data-pi-ref");}))',
      );
      try {
        for (const ref of JSON.parse(String(refs ?? '[]')) as string[]) t.refFrames.set(ref, f.frameId);
      } catch {}
      parts.push(`\n--- Frame (跨域 ${f.url.slice(0, 90)}) ---\n${text}`);
    }
    return parts.join('\n');
  }

  /** Take a snapshot of interactive elements with ref IDs for easy targeting. */
  async getSnapshot(tabId?: string): Promise<string> {
    const t = this.requireTab(tabId);
    try {
      // Ensure helpers are injected
      await this.sendCommand(t, 'Runtime.evaluate', {
        expression: BROWSER_HELPERS_JS,
        returnByValue: true,
      });
      const result = await this.sendCommand(t, 'Runtime.evaluate', {
        expression: 'window.piSnapshot ? window.piSnapshot() : "(helpers not loaded)"',
        returnByValue: true,
      });
      const value = (result?.result as { value?: string })?.value ?? '(empty page)';
      // Cross-origin frames are invisible to the page's own JS; ask CDP.
      let topOrigin = '';
      try {
        const u = await this.sendCommand(t, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true });
        topOrigin = BrowserManager.originOf(
          String((u as { result?: { value?: string } })?.result?.value ?? ''),
        );
      } catch {}
      const extra = await this.crossOriginSnapshot(t, topOrigin);
      return extra ? `${value}\n${extra}` : value;
    } catch {
      return '(snapshot unavailable)';
    }
  }

  /** Search for interactive elements matching a semantic query.
   *  Returns scored matches with text, role, ref ID, and page section. */
  async find(query: string, tabId?: string): Promise<Array<{ score: number; role: string; text: string; section: string }>> {
    const t = this.requireTab(tabId);
    try {
      await this.sendCommand(t, 'Runtime.evaluate', {
        expression: BROWSER_HELPERS_JS,
        returnByValue: true,
      });
      const result = await this.sendCommand(t, 'Runtime.evaluate', {
        expression: `window.piFind ? JSON.stringify(window.piFind(${JSON.stringify(query)})) : null`,
        returnByValue: true,
      });
      const value = (result?.result as { value?: string })?.value;
      if (value) return JSON.parse(value);
    } catch (err) {
      console.warn('[BrowserManager] find error:', err);
    }
    return [];
  }

  /** Take a snapshot grouped by page section (sidebar, header, main, footer). */
  async getStructuredSnapshot(tabId?: string): Promise<string> {
    const t = this.requireTab(tabId);
    try {
      await this.sendCommand(t, 'Runtime.evaluate', {
        expression: BROWSER_HELPERS_JS,
        returnByValue: true,
      });
      const result = await this.sendCommand(t, 'Runtime.evaluate', {
        expression: 'window.piSnapshotStructured ? window.piSnapshotStructured() : "(structured snapshot unavailable)"',
        returnByValue: true,
      });
      return (result?.result as { value?: string })?.value ?? '(empty page)';
    } catch {
      return '(structured snapshot unavailable)';
    }
  }

  /**
   * Goal-oriented navigation: use VLM to plan a navigation path from a screenshot,
   * then execute it automatically.
   *
   * This is the universal, platform-agnostic navigation method. The LLM only
   * specifies a GOAL (e.g. "article editor"), and the VLM reads the actual UI
   * text from the screenshot to plan the path. Works on ANY platform.
   */
  async walk(
    goal: string,
    vlmAnalyzer: VlmAnalyzer,
    maxSteps = 5,
    tabId?: string,
  ): Promise<WalkResult> {
    const t = this.requireTab(tabId);

    const startUrl = await this.getCurrentUrl(t);
    const startTitle = await this.getTitle(t);
    const steps: WalkStep[] = [];

    // Step 1: Plan the path with VLM. The screenshot needs a painted surface —
    // a hidden tab borrows the visible one for the planning pass (restored
    // after), while the execution clicks go through CDP and need no surface.
    const pathPlan = await this.withTabSurface(t, async () => {
      const screenshot = await this.screenshot(undefined, t.id);
      const snapshot = await this.getSnapshot(t.id).catch(() => '(unavailable)');

      const pathPlanPrompt =
        `You are a navigation planner. The user wants to reach: "${goal}".\n\n` +
        `The current page snapshot shows these interactive elements:\n${snapshot.slice(0, 2500)}\n\n` +
        `Look at the screenshot and plan a path of clicks to reach the goal. ` +
        `Return ONLY a JSON array like [{"text":"Label","where":"sidebar"},...] ` +
        `where "text" is the exact visible text to click and "where" is optional context ` +
        `(sidebar, header, main, footer). Be concise — plan the shortest path. ` +
        `If the goal is already reached (page appears to be the destination), return [].`;

      let plan: Array<{ text: string; where?: string }> = [];
      try {
        const rawPlan = await vlmAnalyzer.analyze(screenshot.base64, pathPlanPrompt);
        if (rawPlan) {
          // Try to extract JSON from the response (it may be wrapped in markdown)
          const jsonMatch = rawPlan.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            plan = JSON.parse(jsonMatch[0]);
          }
        }
      } catch (err) {
        console.warn('[walk] VLM path planning failed, falling back to heuristic', err);
      }
      return plan;
    });

    // Heuristic fallback: if VLM returned nothing, split goal into keywords
    if (pathPlan.length === 0 && goal) {
      const keywords = goal.split(/[\s,，、]+/).filter(k => k.length > 1);
      for (const keyword of keywords.slice(0, maxSteps)) {
        const matches = await this.find(keyword, t.id);
        if (matches.length > 0 && matches[0].score >= 30) {
          pathPlan.push({ text: matches[0].text, where: matches[0].section });
        }
      }
    }

    // If we still have no path, we can't navigate
    if (pathPlan.length === 0) {
      return {
        goal,
        url: startUrl,
        title: startTitle,
        reached: false,
        steps: [],
        page: await this.analyzePage(t).catch(() => ({ type: 'unknown' } as unknown as PageAnalysis)),
      };
    }

    // Step 2: Execute the path
    for (const plannedStep of pathPlan) {
      // Try exact text match first
      let clickResult = await this.click(`text="${plannedStep.text}"`, t.id);
      // On failure, try fuzzy find
      if (!clickResult.clicked) {
        const matches = await this.find(plannedStep.text, t.id);
        if (matches.length > 0 && matches[0].score >= 30) {
          clickResult = await this.click(`text="${matches[0].text}"`, t.id);
        }
      }

      steps.push({
        action: `click "${plannedStep.text}"`,
        selector: `text="${plannedStep.text}"`,
        success: clickResult.clicked,
        error: clickResult.clicked ? undefined : clickResult.error || 'Element not found',
      });

      if (!clickResult.clicked) break; // Stop on first failure

      // Wait for navigation / SPA transition
      await this.waitForPageLoad(t).catch(() => {});
      await this.waitForSpaReady(t).catch(() => {});
    }

    const finalUrl = await this.getCurrentUrl(t).catch(() => startUrl);
    const finalTitle = await this.getTitle(t).catch(() => startTitle);

    return {
      goal,
      url: finalUrl,
      title: finalTitle,
      reached: steps.every(s => s.success),
      steps,
      page: await this.analyzePage(t).catch(() => ({ type: 'unknown' } as unknown as PageAnalysis)),
    };
  }

  /** ——— Interaction ——— */

  /** Build an expression that ensures helpers are loaded, then runs the given code. */
  private buildExpression(code: string): string {
    return `${BROWSER_HELPERS_JS}\n${code}`;
  }

  /** Wait for an element to exist and be visible, with timeout. Returns true if found. */
  async waitForElement(selector: string, timeoutMs: number | undefined, tabId?: string): Promise<boolean>;
  async waitForElement(selector: string, timeoutMs: number | undefined, t: BrowserTab): Promise<boolean>;
  async waitForElement(
    selector: string,
    timeoutMs: number | undefined = 5000,
    target?: string | BrowserTab,
  ): Promise<boolean> {
    const t = target instanceof BrowserTab ? target : this.requireTab(target);
    const expr = this.buildExpression(`(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      return !!el;
    })()`);
    const start = Date.now();
    while (Date.now() - start < (timeoutMs ?? 5000)) {
      try {
        const result = await this.sendCommand(t, 'Runtime.evaluate', {
          expression: expr,
          returnByValue: true,
        });
        if ((result?.result as { value?: boolean })?.value) return true;
      } catch {
        // Ignore transient errors
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  /** Click an element by selector. Supports CSS, :has-text(), role=, text=, and [N] ref. */
  /**
   * A password input is a credential the agent must never type. Authentication
   * is the user's act: a CAPTCHA proves a person is present, a login asserts
   * whose account this is. Enforced here, not just asked for in a description —
   * a model that ignores the warning must not be able to proceed.
   */
  private async isPasswordField(t: BrowserTab, selector: string, frameId: string | null): Promise<boolean> {
    const expr = `(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el || el.tagName !== 'INPUT') return false;
      var type = String(el.type || '').toLowerCase();
      var ac = String(el.getAttribute('autocomplete') || '').toLowerCase();
      return type === 'password' || ac === 'current-password' || ac === 'new-password';
    })()`;
    try {
      if (frameId) return (await this.evaluateInFrame(t, frameId, expr)) === true;
      const r = await this.sendCommand(t, 'Runtime.evaluate', {
        expression: this.buildExpression(expr),
        returnByValue: true,
      });
      return (r as { result?: { value?: boolean } })?.result?.value === true;
    } catch {
      return false;
    }
  }

  /**
   * Describe an element in a form that survives the next page load: id, then
   * name/placeholder, then role+name, then visible text — never a ref, which
   * is a handle into THIS document. Resolves through frames exactly like the
   * actions do, so a step recorded inside an iframe stays usable.
   */
  async describe(selector: string, tabId?: string): Promise<{ target: string; targets: string[] }> {
    const t = this.requireTab(tabId);
    const expr = `(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el) return [];
      var tag = el.tagName.toLowerCase();
      var out = [];
      var id = el.getAttribute('id') || '';
      if (id && !/^(r\\d|vue-|__|react-|aria-|\\d+$|^[a-f0-9]{8}-)/i.test(id)) out.push('#' + id);
      var name = el.getAttribute('name') || '';
      if (name) out.push('[name="' + name + '"]');
      var ph = el.getAttribute('placeholder') || '';
      if (ph) out.push('input[placeholder="' + ph + '"]');
      var label = el.getAttribute('aria-label') || '';
      if (label) out.push(tag === 'button' ? 'role=button[name="' + label + '"]' : 'text="' + label + '"');
      var text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
      if (tag === 'button' && text && text.length <= 24) out.push('role=button[name="' + text + '"]');
      if (text && text.length <= 24) out.push('text="' + text + '"');
      return out;
    })()`;
    try {
      const frameId = await this.resolveFrameForSelector(t, selector);
      let value: unknown;
      if (frameId) {
        value = await this.evaluateInFrame(t, frameId, expr);
      } else {
        const r = await this.sendCommand(t, 'Runtime.evaluate', {
          expression: this.buildExpression(expr),
          returnByValue: true,
        });
        value = (r as { result?: { value?: unknown } })?.result?.value;
      }
      const seen = new Set<string>();
      const targets: string[] = [];
      if (Array.isArray(value)) {
        for (const v of value) {
          const s = String(v ?? '').trim();
          if (!s || seen.has(s)) continue;
          seen.add(s);
          targets.push(s);
        }
      }
      if (targets.length === 0) targets.push(selector);
      return { target: targets[0], targets };
    } catch {
      return { target: selector, targets: [selector] };
    }
  }

  /**
   * Wait until an element can actually be acted on: visible, enabled, still,
   * and (for clicks) the click point belongs to it. Returns the last reason
   * when it never becomes ready, so the agent learns WHAT is in the way.
   */
  private async waitActionable(
    t: BrowserTab,
    selector: string,
    frameId: string | null,
    needHit: boolean,
    timeoutMs = 2000,
  ): Promise<{ ok: boolean; reason?: string }> {
    const expr = `(async function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el || !window.piActionable) return { ok: true };
      return await window.piActionable(el, ${needHit});
    })()`;
    const started = Date.now();
    let last: { ok: boolean; reason?: string } = { ok: false, reason: '未知原因' };
    while (Date.now() - started < timeoutMs) {
      try {
        let value: unknown;
        if (frameId) {
          value = await this.evaluateInFrame(t, frameId, expr);
        } else {
          const r = await this.sendCommand(t, 'Runtime.evaluate', {
            expression: this.buildExpression(expr),
            returnByValue: true,
            awaitPromise: true,
          });
          value = (r as { result?: { value?: unknown } })?.result?.value;
        }
        if (value && typeof value === 'object') last = value as { ok: boolean; reason?: string };
        if (last.ok) return last;
      } catch {
        /* page busy mid-action; keep polling */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return last;
  }

  /** Cheap before/after view of the page, used to say what an action did. */
  private async probe(t: BrowserTab): Promise<PageProbe | undefined> {
    try {
      const r = await this.sendCommand(t, 'Runtime.evaluate', {
        expression:
          '(function(){return {url: location.href, text: (document.body && document.body.innerText || "").slice(0, 4000)};})()',
        returnByValue: true,
      });
      return (r?.result as { value?: PageProbe })?.value;
    } catch {
      return undefined;
    }
  }

  /**
   * Type like a person: one trusted key event per character.
   *
   * `Input.insertText` inserts the whole string at once and fires `input`
   * without any `keydown`, which fields that gate on real keystrokes (masks,
   * amount inputs, components that ignore programmatic writes) reject. Long
   * values switch to a single keydown + insert so a paragraph does not turn
   * into hundreds of round trips.
   */
  private async typeText(t: BrowserTab, value: string): Promise<void> {
    const chars = Array.from(value);
    if (chars.length > 120) {
      await this.sendCommand(t, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Unidentified' });
      await this.sendCommand(t, 'Input.insertText', { text: value });
      return;
    }
    for (const ch of chars) {
      try {
        await this.sendCommand(t, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          text: ch,
          unmodifiedText: ch,
          key: ch,
        });
        await this.sendCommand(t, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      } catch {
        // Fall back to a bulk insert for the rest — a failed single key must
        // not lose the value.
        await this.sendCommand(t, 'Input.insertText', { text: value });
        return;
      }
    }
  }

  async click(
    selector: string,
    tabId?: string,
    dialog?: 'accept' | 'dismiss',
  ): Promise<{ selector: string; clicked: boolean; effect?: string; error?: string }> {
    const t = this.requireTab(tabId);
    t.lastDialog = null;
    t.dialogPolicy = dialog === 'accept' ? 'accept' : 'dismiss';
    const frameId = await this.resolveFrameForSelector(t, selector);
    if (frameId) return this.clickInFrame(t, selector, frameId);
    // Auto-wait: poll for element up to 5s
    const found = await this.waitForElement(selector, 5000, t);
    if (!found) {
      // Get suggestions for similar elements
      let suggestions = '';
      try {
        const sugResult = await this.sendCommand(t, 'Runtime.evaluate', {
          expression: this.buildExpression(`(window.piFindSimilar ? window.piFindSimilar(${JSON.stringify(selector)}, 5) : []).join('\\n')`),
          returnByValue: true,
        });
        suggestions = (sugResult?.result as { value?: string })?.value ?? '';
      } catch {}
      const errorMsg = suggestions
        ? `Element not found: "${selector}". Did you mean one of these?\n${suggestions}`
        : `Element not found: "${selector}"`;
      return { selector, clicked: false, error: errorMsg };
    }

    const actionable = await this.waitActionable(t, selector, null, true);
    if (!actionable.ok) {
      return { selector, clicked: false, error: `"${selector}" 现在不可操作：${actionable.reason ?? '未知原因'}` };
    }

    const before = await this.probe(t);
    const expr = this.buildExpression(`(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({block:'center', behavior:'instant'});
      el.click();
      return true;
    })()`);
    const result = await this.sendCommand(t, 'Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });
    const clicked = (result?.result as { value?: boolean })?.value ?? false;
    // Give the page a beat to render, then say what changed — that is the
    // question the model used to answer with an extra evaluate or screenshot.
    if (clicked) await new Promise((r) => setTimeout(r, 150));
    const after = clicked ? await this.probe(t) : undefined;
    return {
      selector,
      clicked,
      effect: [describePageChange(before, after), this.takeDialogNote(t)].filter(Boolean).join('；'),
    };
  }

  /** What the page asked in a confirm() during the last action, if anything. */
  private takeDialogNote(t: BrowserTab): string {
    if (!t.lastDialog) return '';
    const note = `页面弹出确认框「${t.lastDialog.slice(0, 80)}」，${
      t.dialogPolicy === 'accept' ? '已确认' : '已取消'
    }`;
    t.lastDialog = null;
    return note;
  }

  /** Click inside a child frame (cross-origin included). */
  private async clickInFrame(
    t: BrowserTab,
    selector: string,
    frameId: string,
  ): Promise<{ selector: string; clicked: boolean; effect?: string; error?: string }> {
    const ctx = await this.frameContext(t, frameId);
    if (!ctx) return { selector, clicked: false, error: '无法进入该 iframe' };
    const actionableFrame = await this.waitActionable(t, selector, frameId, true);
    if (!actionableFrame.ok) {
      return { selector, clicked: false, error: `"${selector}" 现在不可操作：${actionableFrame.reason ?? '未知原因'}` };
    }
    const before = String(
      (await this.evaluateInFrame(t, frameId, '(document.body && document.body.innerText || "")')) ?? '',
    );
    let clicked = false;
    try {
      const r = await this.sendCommand(t, 'Runtime.evaluate', {
        expression: `(function(){var el=window.piResolveSelector(${JSON.stringify(selector)});if(!el)return false;el.scrollIntoView({block:'center'});el.click();return true;})()`,
        contextId: ctx,
        returnByValue: true,
      });
      clicked = (r as { result?: { value?: boolean } })?.result?.value === true;
    } catch {}
    if (!clicked) return { selector, clicked: false, error: `Element not found: "${selector}"` };
    await new Promise((r) => setTimeout(r, 150));
    const after = String(
      (await this.evaluateInFrame(t, frameId, '(document.body && document.body.innerText || "")')) ?? '',
    );
    return {
      selector,
      clicked,
      effect: [describePageChange({ url: '', text: before }, { url: '', text: after }), this.takeDialogNote(t)]
        .filter(Boolean)
        .join('；'),
    };
  }

  /** Fill inside a child frame (cross-origin included). */
  private async fillInFrame(
    t: BrowserTab,
    selector: string,
    value: string,
    frameId: string,
  ): Promise<{ selector: string; value: string; effect?: string; error?: string }> {
    const ctx = await this.frameContext(t, frameId);
    if (!ctx) return { selector, value, error: '无法进入该 iframe' };
    if (await this.isPasswordField(t, selector, frameId)) return PASSWORD_REFUSAL(selector);
    const actionableFillFrame = await this.waitActionable(t, selector, frameId, false);
    if (!actionableFillFrame.ok) {
      return { selector, value, error: `"${selector}" 现在不可填写：${actionableFillFrame.reason ?? '未知原因'}` };
    }
    const focusExpr = `(function(){
      var el=window.piResolveSelector(${JSON.stringify(selector)});
      if(!el) return null;
      el.scrollIntoView({block:'center'});
      try{el.focus();}catch(e){}
      var doc=el.ownerDocument;
      var editable=el.isContentEditable||el.getAttribute('contenteditable')==='true'||el.getAttribute('contenteditable')==='';
      if(editable){var rg=doc.createRange();rg.selectNodeContents(el);rg.collapse(false);var s=doc.defaultView.getSelection();s.removeAllRanges();s.addRange(rg);}
      else if(el.select){try{el.select();}catch(e){}}
      return {focused: doc.activeElement===el};
    })()`;
    let focused = false;
    try {
      const r = await this.sendCommand(t, 'Runtime.evaluate', { expression: focusExpr, contextId: ctx, returnByValue: true });
      focused = ((r as { result?: { value?: { focused?: boolean } } })?.result?.value?.focused) === true;
    } catch {}
    if (focused) {
      try {
        await this.typeText(t, value);
      } catch {}
    }
    // Same rule as the main-document path: read the field back, repair if the
    // value did not stick, and report what is actually there.
    const verify = `(function(){
      var el=window.piResolveSelector(${JSON.stringify(selector)});
      if(!el) return {ok:false, actual:''};
      var want=${JSON.stringify(value)};
      var editable=el.isContentEditable||el.getAttribute('contenteditable')==='true'||el.getAttribute('contenteditable')==='';
      var read=function(){return editable?(el.textContent||''):(el.value!=null?String(el.value):'');};
      var actual=read();
      if(actual.indexOf(want)!==-1) return {ok:true,actual:actual.slice(0,80)};
      try{
        el.focus();
        if(editable){el.textContent=want;el.dispatchEvent(new Event('input',{bubbles:true}));}
        else if(el.value!=null){var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;var setter=Object.getOwnPropertyDescriptor(proto,'value').set;setter.call(el,want);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
        actual=read();
      }catch(e){}
      return {ok:actual.indexOf(want)!==-1,actual:actual.slice(0,80)};
    })()`;
    const verified = (await this.evaluateInFrame(t, frameId, verify)) as
      | { ok?: boolean; actual?: string }
      | undefined;
    if (!verified?.ok) {
      return {
        selector,
        value,
        error: `Value did not stick on "${selector}" (field contains "${verified?.actual ?? ''}")`,
      };
    }
    return { selector, value, effect: `已写入，当前值「${(verified.actual || '').slice(0, 60)}」` };
  }

  /** Select inside a child frame (cross-origin included). */
  private async selectInFrame(
    t: BrowserTab,
    selector: string,
    value: string,
    frameId: string,
  ): Promise<{ selector: string; value: string; selected: boolean; effect?: string; error?: string }> {
    const ctx = await this.frameContext(t, frameId);
    if (!ctx) return { selector, value, selected: false, error: '无法进入该 iframe' };
    const actionableSelectFrame = await this.waitActionable(t, selector, frameId, false);
    if (!actionableSelectFrame.ok) {
      return { selector, value, selected: false, error: `"${selector}" 现在不可选择：${actionableSelectFrame.reason ?? '未知原因'}` };
    }
    const expr = `(function(){
      var el=window.piResolveSelector(${JSON.stringify(selector)});
      if(!el||el.tagName.toLowerCase()!=='select') return {ok:false};
      var opts=Array.from(el.options);
      var target=opts.find(function(o){return o.value===${JSON.stringify(value)};})
        ||opts.find(function(o){return o.textContent.trim()===${JSON.stringify(value)};})
        ||opts.find(function(o){return o.textContent.trim().indexOf(${JSON.stringify(value)})!==-1;});
      if(!target) return {ok:false};
      el.value=target.value;
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return {ok:true,text:target.textContent.trim()};
    })()`;
    let picked: { ok?: boolean; text?: string } | undefined;
    try {
      const r = await this.sendCommand(t, 'Runtime.evaluate', { expression: expr, contextId: ctx, returnByValue: true });
      picked = (r as { result?: { value?: { ok?: boolean; text?: string } } })?.result?.value;
    } catch {}
    return {
      selector,
      value,
      selected: picked?.ok === true,
      effect: picked?.ok ? `已选中「${(picked.text ?? '').slice(0, 60)}」` : '',
    };
  }

  /**
   * Attach files by synthesising a drop.
   *
   * Some upload widgets have no input[type=file] at all — a drag-and-drop
   * zone is the only way in — and a control inside a cross-origin frame
   * cannot be clicked with a trusted event from the top viewport. Both land
   * here: the host reads the bytes, the page receives a real DataTransfer.
   */
  private async uploadByDrop(
    t: BrowserTab,
    selector: string,
    files: string[],
    frameId: string | null,
  ): Promise<{ attached: boolean; files: string[]; via?: 'drop'; effect?: string; error?: string }> {
    const names = files.map((f) => f.split(/[\\/]/).pop() || f);
    let total = 0;
    const payload: Array<{ name: string; b64: string }> = [];
    try {
      for (const f of files) {
        const data = await readFile(f);
        total += data.byteLength;
        if (total > 10 * 1024 * 1024) {
          return { attached: false, files: names, error: '拖拽模式单次最多 10MB' };
        }
        payload.push({ name: f.split(/[\\/]/).pop() || f, b64: data.toString('base64') });
      }
    } catch (err) {
      return { attached: false, files: names, error: `读取文件失败: ${(err as Error).message}` };
    }

    const expr = `(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el) return {ok:false, error:'element not found'};
      var files = ${JSON.stringify(payload)}.map(function(p){
        var bin = atob(p.b64);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new File([arr], p.name);
      });
      var dt = new DataTransfer();
      files.forEach(function(f){ dt.items.add(f); });
      ['dragenter','dragover','drop'].forEach(function(type){
        el.dispatchEvent(new DragEvent(type, {bubbles:true, cancelable:true, dataTransfer:dt}));
      });
      return {ok:true};
    })()`;

    let res: { ok?: boolean; error?: string } | undefined;
    try {
      if (frameId) {
        res = (await this.evaluateInFrame(t, frameId, expr)) as typeof res;
      } else {
        const r = await this.sendCommand(t, 'Runtime.evaluate', { expression: expr, returnByValue: true });
        res = (r as { result?: { value?: { ok?: boolean; error?: string } } })?.result?.value;
      }
    } catch (err) {
      return { attached: false, files: names, error: `拖拽派发失败: ${(err as Error).message}` };
    }
    if (!res?.ok) return { attached: false, files: names, error: res?.error ?? '拖拽失败' };
    await new Promise((r) => setTimeout(r, 200));
    return { attached: true, files: names, via: 'drop', effect: `已拖入 ${names.join('、')}` };
  }

  /**
   * Attach local files to a page's upload control.
   *
   * The page itself says which input it wants: clicking the control makes
   * Chromium open a file chooser, and with interception on we learn the exact
   * node (backendNodeId) instead of guessing a selector. Hidden, dynamically
   * created and iframe-hosted inputs all work the same way, on any site —
   * no per-site adapter needed.
   *
   * `selector` may also point straight at an <input type=file>, in which case
   * no click happens at all.
   */
  async upload(
    selector: string,
    files: string[],
    tabId?: string,
  ): Promise<{ attached: boolean; files: string[]; via?: 'chooser' | 'input' | 'drop'; effect?: string; error?: string }> {
    const t = this.requireTab(tabId);
    if (!files.length) return { attached: false, files, error: 'No files given' };
    const frameId = await this.resolveFrameForSelector(t, selector);
    // A trusted click inside a cross-origin frame needs coordinates in the
    // top viewport; a synthesised drop needs only the frame's own context.
    if (frameId) return this.uploadByDrop(t, selector, files, frameId);
    const found = await this.waitForElement(selector, 5000, t);
    if (!found) return { attached: false, files, error: `Element not found: "${selector}"` };

    const names = files.map((f) => f.split(/[\\/]/).pop() || f);

    // 1. The target may already BE the file input — set it directly.
    const direct = await this.sendCommand(t, 'Runtime.evaluate', {
      expression: this.buildExpression(`(function(){
        var el = window.piResolveSelector(${JSON.stringify(selector)});
        return !!(el && el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'file');
      })()`),
      returnByValue: true,
    });
    if ((direct?.result as { value?: boolean })?.value) {
      const handle = await this.sendCommand(t, 'Runtime.evaluate', {
        expression: this.buildExpression(`window.piResolveSelector(${JSON.stringify(selector)})`),
        returnByValue: false,
      });
      const objectId = (handle as { result?: { objectId?: string } })?.result?.objectId;
      if (!objectId) return { attached: false, files, error: 'Could not grab the file input' };
      try {
        await this.sendCommand(t, 'DOM.enable');
        const described = await this.sendCommand(t, 'DOM.describeNode', { objectId });
        const backendNodeId = (described as { node?: { backendNodeId?: number } })?.node?.backendNodeId;
        if (!backendNodeId) return { attached: false, files, error: 'Could not resolve the file input node' };
        await this.sendCommand(t, 'DOM.setFileInputFiles', { files, backendNodeId });
        return { attached: true, files: names, via: 'input', effect: `已附加 ${names.join('、')}` };
      } catch (err) {
        return { attached: false, files, error: `setFileInputFiles failed: ${(err as Error).message}` };
      }
    }

    // 2. Otherwise click the control with a TRUSTED event (a JS .click() is
    //    not a user gesture, so Chromium refuses to open a chooser for it)
    //    and take the node Chromium reports.
    const rectResult = await this.sendCommand(t, 'Runtime.evaluate', {
      expression: this.buildExpression(`(function(){
        var el = window.piResolveSelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({block:'center', behavior:'instant'});
        var r = window.piAbsoluteRect(el);
        return {x: r.left + r.width/2, y: r.top + r.height/2};
      })()`),
      returnByValue: true,
    });
    const pt = (rectResult?.result as { value?: { x: number; y: number } })?.value;
    if (!pt) return { attached: false, files, error: `Cannot locate: "${selector}"` };

    const actionableUpload = await this.waitActionable(t, selector, null, true);
    if (!actionableUpload.ok) {
      return {
        attached: false,
        files,
        error: `"${selector}" 现在不可操作：${actionableUpload.reason ?? '未知原因'}`,
      };
    }
    const beforeUpload = await this.probe(t);
    const wc = t.wc;
    const captured: { backendNodeId?: number } = {};
    let notify: (() => void) | null = null;
    const opened = new Promise<void>((resolve) => { notify = resolve; });
    const onMessage = (_e: unknown, method: string, params: Record<string, unknown>) => {
      if (method === 'Page.fileChooserOpened') {
        captured.backendNodeId = (params as { backendNodeId?: number }).backendNodeId;
        notify?.();
      }
    };
    wc.debugger.on('message', onMessage);
    try {
      await this.sendCommand(t, 'Page.setInterceptFileChooserDialog', { enabled: true });
      await this.sendCommand(t, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1,
      });
      await this.sendCommand(t, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1,
      });
      const timedOut = await Promise.race([
        opened.then(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(true), 3000)),
      ]);
      if (timedOut || !captured.backendNodeId) {
        // No chooser: this is probably a drag-and-drop zone. Try a real drop
        // before giving up — that is the only way into such widgets.
        const dropped = await this.uploadByDrop(t, selector, files, null);
        if (dropped.attached) return dropped;
        return {
          attached: false,
          files,
          error:
            dropped.error ??
            'The click opened no file chooser and the drop did not register. Point at the upload control itself.',
        };
      }
      await this.sendCommand(t, 'DOM.enable');
      await this.sendCommand(t, 'DOM.setFileInputFiles', {
        files,
        backendNodeId: captured.backendNodeId,
      });
      // The page usually renders an attachment chip; saying so saves the model
      // a verification round trip.
      await new Promise((r) => setTimeout(r, 200));
      const after = await this.probe(t);
      return {
        attached: true,
        files: names,
        via: 'chooser',
        effect: `${describePageChange(beforeUpload, after) || '已写入文件框'}（${names.join('、')}）`,
      };
    } catch (err) {
      return { attached: false, files, error: `Upload failed: ${(err as Error).message}` };
    } finally {
      wc.debugger.removeListener('message', onMessage);
      try {
        await this.sendCommand(t, 'Page.setInterceptFileChooserDialog', { enabled: false });
      } catch {}
    }
  }

  /** Fill an input by selector. Uses native value setter for React/Vue. Supports all selector formats. */
  async fill(selector: string, value: string, tabId?: string): Promise<{ selector: string; value: string; effect?: string; error?: string }> {
    const t = this.requireTab(tabId);
    const frameId = await this.resolveFrameForSelector(t, selector);
    if (frameId) return this.fillInFrame(t, selector, value, frameId);
    const found = await this.waitForElement(selector, 5000, t);
    if (await this.isPasswordField(t, selector, null)) return PASSWORD_REFUSAL(selector);
    const actionableFill = await this.waitActionable(t, selector, null, false);
    if (!actionableFill.ok) {
      return { selector, value, error: `"${selector}" 现在不可填写：${actionableFill.reason ?? '未知原因'}` };
    }
    if (!found) {
      return { selector, value, error: `Element not found: "${selector}"` };
    }

    // Step 1: focus the field and select what is already there. This used to
    // be a triple-click at the element's centre; when the page had shifted (or
    // the frame offset was wrong) the click landed on the PREVIOUS field and
    // the text went there — the classic "张三 ended up in the memo box".
    // Programmatic focus fires the same focus/blur handlers, so coordinates
    // are only a fallback for components that refuse focus without a click.
    const focusExpr = this.buildExpression(`(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({block:'center', behavior:'instant'});
      try { el.focus(); } catch (e) {}
      var doc = el.ownerDocument;
      var editable = el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '';
      if (editable) {
        var range = doc.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        var sel = doc.defaultView.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } else if (el.select) {
        try { el.select(); } catch (e) {}
      }
      return { focused: doc.activeElement === el, editable: editable };
    })()`);
    const focusResult = await this.sendCommand(t, 'Runtime.evaluate', {
      expression: focusExpr,
      returnByValue: true,
    });
    const focus = (focusResult?.result as { value?: { focused: boolean; editable: boolean } })?.value;

    // Step 2: type into the focused field. Input.insertText goes through the
    // browser's input pipeline, which is what makes React/Vue see the change.
    if (focus?.focused) {
      await this.typeText(t, value);
    }

    // Step 3: read the target back and repair it if the text did not land
    // here. A focus that silently failed used to send the whole value into
    // whatever field still held focus ("张三" ending up in the memo box).
    // Direct assignment is deterministic and still notifies frameworks,
    // through the native value setter plus input/change events.
    const verifyExpr = this.buildExpression(`(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, actual: '' };
      var want = ${JSON.stringify(value)};
      var editable = el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '';
      var read = function() {
        return editable ? (el.textContent || '') : (el.value != null ? String(el.value) : '');
      };
      var actual = read();
      if (actual.indexOf(want) !== -1) return { ok: true, actual: actual.slice(0, 80) };
      try {
        el.focus();
        if (editable) {
          el.textContent = want;
          el.dispatchEvent(new Event('input', {bubbles: true}));
        } else if (el.value != null) {
          var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, want);
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
        }
        actual = read();
      } catch (e) {}
      return { ok: actual.indexOf(want) !== -1, actual: actual.slice(0, 80) };
    })()`);
    const verifyResult = await this.sendCommand(t, 'Runtime.evaluate', {
      expression: verifyExpr,
      returnByValue: true,
    });
    const verified = (verifyResult?.result as { value?: { ok: boolean; actual: string } })?.value;
    if (!verified?.ok) {
      return {
        selector,
        value,
        error: `Value did not stick on "${selector}" (field contains "${verified?.actual ?? ''}")`,
      };
    }

    return {
      selector,
      value,
      effect: `已写入，当前值「${(verified.actual || '').slice(0, 60)}」`,
    };
  }

  /**
   * Hover an element with a real pointer move.
   *
   * Dispatching mouseover/mouseenter never triggers CSS :hover, so a menu
   * that only appears on hover used to stay closed and the model clicked a
   * hidden item (which JS .click() happily fires). A CDP mouse move produces
   * the genuine hover state every stylesheet and menu expects.
   */
  async hover(selector: string, tabId?: string): Promise<{ selector: string; hovered: boolean; error?: string }> {
    const t = this.requireTab(tabId);
    const found = await this.waitForElement(selector, 5000, t);
    if (!found) {
      return { selector, hovered: false, error: `Element not found: "${selector}"` };
    }

    const rectExpr = this.buildExpression(`(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({block:'center', behavior:'instant'});
      var r = window.piAbsoluteRect(el);
      return {x: r.left + r.width/2, y: r.top + r.height/2};
    })()`);
    const rectResult = await this.sendCommand(t, 'Runtime.evaluate', {
      expression: rectExpr,
      returnByValue: true,
    });
    const pt = (rectResult?.result as { value?: { x: number; y: number } })?.value;
    if (!pt) return { selector, hovered: false, error: `Cannot locate: "${selector}"` };

    await this.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    await new Promise((r) => setTimeout(r, 150));
    return { selector, hovered: true };
  }

  /** Select an option in a <select> element by value or visible text. */
  async selectOption(selector: string, value: string, tabId?: string): Promise<{ selector: string; value: string; selected: boolean; effect?: string; error?: string }> {
    const t = this.requireTab(tabId);
    const frameId = await this.resolveFrameForSelector(t, selector);
    if (frameId) return this.selectInFrame(t, selector, value, frameId);
    const found = await this.waitForElement(selector, 5000, t);
    if (!found) {
      return { selector, value, selected: false, error: `Element not found: "${selector}"` };
    }
    const actionableSelect = await this.waitActionable(t, selector, null, false);
    if (!actionableSelect.ok) {
      return { selector, value, selected: false, error: `"${selector}" 现在不可选择：${actionableSelect.reason ?? '未知原因'}` };
    }

    const expr = this.buildExpression(`(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el || el.tagName.toLowerCase() !== 'select') return { ok: false };
      var opts = Array.from(el.options);
      // Try exact value match, then text match
      var target = opts.find(function(o) { return o.value === ${JSON.stringify(value)}; })
        || opts.find(function(o) { return o.textContent.trim() === ${JSON.stringify(value)}; })
        || opts.find(function(o) { return o.textContent.trim().includes(${JSON.stringify(value)}); });
      if (!target) return { ok: false };
      el.value = target.value;
      el.dispatchEvent(new Event('input', {bubbles: true}));
      el.dispatchEvent(new Event('change', {bubbles: true}));
      return { ok: true, text: target.textContent.trim() };
    })()`);
    const result = await this.sendCommand(t, 'Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });
    const picked = (result?.result as { value?: { ok: boolean; text?: string } })?.value;
    return {
      selector,
      value,
      selected: picked?.ok === true,
      effect: picked?.ok ? `已选中「${(picked.text ?? '').slice(0, 60)}」` : '',
    };
  }

  /**
   * Type text into an input, wait for suggestion dropdown to appear, then select matching option.
   * Compound operation for autocomplete / typeahead fields.
   *
   * @param selector - Selector for the input element
   * @param text - Text to type into the input
   * @param optionMatcher - Text to match against suggestion options (case-insensitive substring)
   * @param waitMs - How long to wait for suggestions to appear (default 1500ms)
   */
  async typeAndSelect(
    selector: string,
    text: string,
    optionMatcher: string,
    waitMs = 1500,
    tabId?: string,
  ): Promise<{ selector: string; typed: string; matched: string | null; selected: boolean; error?: string }> {
    const t = this.requireTab(tabId);
    // 1. Focus and clear the input
    const found = await this.waitForElement(selector, 5000, t);
    if (!found) {
      return { selector, typed: text, matched: null, selected: false, error: `Input element not found: "${selector}"` };
    }

    // Focus + select first, mouse clicks only as a fallback (see fill()).
    const focusExpr = this.buildExpression(`(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({block:'center', behavior:'instant'});
      try { el.focus(); } catch (e) {}
      var doc = el.ownerDocument;
      var editable = el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '';
      if (editable) {
        var range = doc.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        var sel = doc.defaultView.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } else if (el.select) {
        try { el.select(); } catch (e) {}
      }
      return { focused: doc.activeElement === el };
    })()`);
    const focusResult = await this.sendCommand(t, 'Runtime.evaluate', {
      expression: focusExpr,
      returnByValue: true,
    });
    const focus = (focusResult?.result as { value?: { focused: boolean } })?.value;

    if (!focus?.focused) {
      const rectExpr = this.buildExpression(`(function(){
        var el = window.piResolveSelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({block:'center', behavior:'instant'});
        var r = window.piAbsoluteRect(el);
        return {x: r.left + r.width/2, y: r.top + r.height/2, width: r.width, height: r.height};
      })()`);
      const rectResult = await this.sendCommand(t, 'Runtime.evaluate', {
        expression: rectExpr,
        returnByValue: true,
      });
      const rect = (rectResult?.result as { value?: { x: number; y: number; width: number; height: number } })?.value;
      if (!rect) {
        return { selector, typed: text, matched: null, selected: false, error: `Cannot get rect for: "${selector}"` };
      }
      for (let i = 0; i < 3; i++) {
        await this.sendCommand(t, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: i + 1,
        });
        await this.sendCommand(t, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: i + 1,
        });
      }
    }

    // 2. Type the text with real key events (autocomplete listens for them)
    await this.typeText(t, text);

    // Dispatch DOM input/change events so React/Vue/vanilla JS listeners fire (e.g., autocomplete dropdowns)
    await this.sendCommand(t, 'Runtime.evaluate', {
      expression: this.buildExpression(`(function(){
        var el = window.piResolveSelector(${JSON.stringify(selector)});
        if (el) {
          el.dispatchEvent(new Event('input', {bubbles: true, cancelable: true}));
          el.dispatchEvent(new Event('change', {bubbles: true, cancelable: true}));
        }
      })()`),
    });

    // 3. Wait for suggestion dropdown to appear
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    // 4. Take a fresh snapshot to find the suggestion options
    await this.sendCommand(t, 'Runtime.evaluate', {
      expression: BROWSER_HELPERS_JS,
      returnByValue: true,
    });

    // 5. Try to find and click a matching option
    const matcherEscaped = JSON.stringify(optionMatcher.toLowerCase());
    const expr = this.buildExpression(`(function(){
      // Look for options in dropdown layers
      var candidates = [];

      // Strategy A: role="option" elements that contain the target text
      var options = document.querySelectorAll('[role="option"]');
      for (var o = 0; o < options.length; o++) {
        if (piIsVisible(options[o]) && (options[o].textContent || '').toLowerCase().includes(${matcherEscaped})) {
          candidates.push(options[o]);
        }
      }

      // Strategy B: <li> elements in floating containers
      if (candidates.length === 0) {
        var lis = document.querySelectorAll('li');
        for (var l = 0; l < lis.length; l++) {
          if (piIsVisible(lis[l])) {
            var txt = (lis[l].textContent || '').trim().toLowerCase();
            if (txt.includes(${matcherEscaped}) && txt.length < 200) {
              candidates.push(lis[l]);
            }
          }
        }
      }

      // Strategy C: Any visible element with matching text and onclick/href
      if (candidates.length === 0) {
        var all = document.querySelectorAll('div, span, a, button, p');
        for (var a = 0; a < all.length; a++) {
          if (piIsVisible(all[a])) {
            var atxt = (all[a].textContent || '').trim().toLowerCase();
            if (atxt === ${matcherEscaped}) {
              candidates.push(all[a]);
              break;
            }
          }
        }
        // Fall back to partial match
        if (candidates.length === 0) {
          for (var a2 = 0; a2 < all.length; a2++) {
            if (piIsVisible(all[a2])) {
              var atxt2 = (all[a2].textContent || '').trim().toLowerCase();
              if (atxt2.includes(${matcherEscaped}) && atxt2.length < 100) {
                candidates.push(all[a2]);
                break;
              }
            }
          }
        }
      }

      if (candidates.length > 0) {
        // Click the first matching candidate
        var target = candidates[0];
        var rect = target.getBoundingClientRect();
        var x = rect.left + rect.width / 2;
        var y = rect.top + rect.height / 2;
        target.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:x, clientY:y}));
        target.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:x, clientY:y}));
        target.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, clientX:x, clientY:y}));
        return (target.textContent || '').trim().slice(0, 100);
      }
      return null;
    })()`);

    const result = await this.sendCommand(t, 'Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });

    const matched = (result?.result as { value?: string | null })?.value ?? null;

    if (matched) {
      return { selector, typed: text, matched, selected: true };
    }

    // If no match found, try keyboard navigation approach
    const isSingleChar = text.length === 1;
    if (!matched && !isSingleChar) {
      // Could try pressing ArrowDown + Enter as fallback
      return {
        selector,
        typed: text,
        matched: null,
        selected: false,
        error: `No option matching "${optionMatcher}" found in dropdown. Try re-snapshotting to see available options.`,
      };
    }

    return { selector, typed: text, matched: null, selected: false, error: `No matching option found for "${optionMatcher}"` };
  }

  /**
   * Universal popup handler: click a trigger element, wait for a popup/dropdown/modal
   * to appear, find a matching option by text, and click it.
   *
   * Works for any popup type: dropdown menus, context menus, selection panels,
   * modal dialogs, date pickers, color pickers, etc.
   *
   * Platform-agnostic — works on WeChat, DingTalk, Xiaohongshu, and any web app.
   *
   * @param triggerSelector - Selector for the element that opens the popup
   * @param optionText - Text to match in the popup options (case-insensitive substring)
   * @param waitMs - Time to wait for popup to render (default 2000ms)
   */
  async clickAndSelect(
    triggerSelector: string,
    optionText: string,
    waitMs = 2000,
    tabId?: string,
  ): Promise<{ trigger: string; matched: string | null; selected: boolean; error?: string }> {
    const t = this.requireTab(tabId);
    // 1. Click the trigger element
    const clickResult = await this.click(triggerSelector, t.id);
    if (!clickResult.clicked) {
      return { trigger: triggerSelector, matched: null, selected: false, error: clickResult.error ?? 'Click failed' };
    }

    // 2. Wait for popup to appear (animation + network delay)
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    // 3. Re-inject helpers so piIsVisible etc. work inside the popup
    await this.sendCommand(t, 'Runtime.evaluate', {
      expression: BROWSER_HELPERS_JS,
      returnByValue: true,
    });

    // 4. Multi-strategy search for matching option inside popup containers
    const matcherEscaped = JSON.stringify(optionText.toLowerCase());
    const expr = this.buildExpression(`(function(){
      // Find popup/floating containers (must be visible NOW, after delay)
      var floatingContainers = [];

      // Strategy for finding containers: high z-index + position fixed/absolute
      var containers = document.querySelectorAll('div, ul, ol, section, aside, nav, [role="listbox"], [role="menu"], [role="dialog"], [role="tooltip"], [role="alertdialog"], [role="presentation"], [role="tree"]');
      for (var c = 0; c < containers.length; c++) {
        var el = containers[c];
        if (!el.isConnected) continue;
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;

        var role = el.getAttribute('role') || '';
        var isFloating = false;

        // ARIA role indicates overlay
        if (role === 'listbox' || role === 'menu' || role === 'dialog' || role === 'tooltip' || role === 'alertdialog' || role === 'tree') {
          isFloating = true;
        }

        // High z-index positioned element
        if (!isFloating && (cs.position === 'fixed' || cs.position === 'absolute')) {
          var zIndex = parseInt(cs.zIndex, 10);
          if (zIndex > 10) isFloating = true;
        }

        // Class-based popup patterns
        if (!isFloating && el.children.length > 0 && el.children.length <= 100) {
          var cls = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
          if (/(dropdown|popup|popover|overlay|menu|suggest|select|autocomplete|tooltip|modal|drawer|picker|panel|flyout|pulldown)/.test(cls)) {
            var zIdx = parseInt(cs.zIndex, 10);
            if (zIdx > 0 || cs.position === 'absolute' || cs.position === 'fixed') {
              isFloating = true;
            }
          }
        }

        if (isFloating && piIsVisible(el)) {
          floatingContainers.push(el);
        }
      }

      // Deduplicate: remove parent containers (keep only top-level floating containers)
      var rootContainers = [];
      for (var d = 0; d < floatingContainers.length; d++) {
        var isChild = false;
        for (var p = 0; p < floatingContainers.length; p++) {
          if (d !== p && floatingContainers[p].contains(floatingContainers[d])) {
            isChild = true;
            break;
          }
        }
        if (!isChild) rootContainers.push(floatingContainers[d]);
      }

      if (rootContainers.length === 0) return null;

      // Search inside each floating container for matching option
      var searchSelectors = [
        '[role="option"]', '[role="menuitem"]', '[role="treeitem"]',
        'li', 'a', 'button', 'option',
        'div[onclick]', 'span[onclick]',
        '.menu-item', '.dropdown-item', '.popup-item',
        '.select-option', '.picker-option'
      ].join(', ');

      var matcher = ${matcherEscaped};

      for (var rc = 0; rc < rootContainers.length; rc++) {
        var container = rootContainers[rc];
        var items = container.querySelectorAll(searchSelectors);

        for (var i = 0; i < items.length; i++) {
          if (!piIsVisible(items[i])) continue;
          var text = (items[i].textContent || '').trim().toLowerCase();

          // Substring match, but exclude very long text (descriptive paragraphs, not menu items)
          if (text.includes(matcher) && text.length < 200) {
            // Click it via DOM events
            items[i].scrollIntoView({block:'center', behavior:'instant'});
            var rect = items[i].getBoundingClientRect();
            items[i].dispatchEvent(new MouseEvent('mouseover', {bubbles:true, clientX:rect.left+rect.width/2, clientY:rect.top+rect.height/2}));
            items[i].dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:rect.left+rect.width/2, clientY:rect.top+rect.height/2}));
            items[i].dispatchEvent(new MouseEvent('mouseup', {bubbles:true, clientX:rect.left+rect.width/2, clientY:rect.top+rect.height/2}));
            items[i].dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:rect.left+rect.width/2, clientY:rect.top+rect.height/2}));
            // Also try native click() for good measure
            try { items[i].click(); } catch(e) {}
            return items[i].textContent.trim().slice(0, 100);
          }
        }
      }

      // Second pass: search for ANY visible element with matching text inside float containers
      for (var rc2 = 0; rc2 < rootContainers.length; rc2++) {
        var container2 = rootContainers[rc2];
        var allEls = container2.querySelectorAll('*');
        for (var j = 0; j < allEls.length; j++) {
          if (!piIsVisible(allEls[j])) continue;
          var t = (allEls[j].textContent || '').trim().toLowerCase();
          // Exact match on deeper elements
          if (t === matcher && t.length < 100 && allEls[j].children.length === 0) {
            allEls[j].scrollIntoView({block:'center', behavior:'instant'});
            var r = allEls[j].getBoundingClientRect();
            allEls[j].dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2}));
            try { allEls[j].click(); } catch(e) {}
            return allEls[j].textContent.trim().slice(0, 100);
          }
        }
      }

      return null;
    })()`);

    const result = await this.sendCommand(t, 'Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });

    const matched = (result?.result as { value?: string | null })?.value ?? null;

    if (matched) {
      // Small delay for the popup to close after selection
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { trigger: triggerSelector, matched, selected: true };
    }

    return {
      trigger: triggerSelector,
      matched: null,
      selected: false,
      error: `No option matching "${optionText}" found in popup triggered by "${triggerSelector}". The popup may have a different structure — use browser_find with the option text to inspect available options.`,
    };
  }

  /** CDP key code mappings for common special keys. */
  private static KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; nativeVirtualKeyCode: number }> = {
    'Enter':     { key: 'Enter',     code: 'Enter',     windowsVirtualKeyCode: 13,  nativeVirtualKeyCode: 36 },
    'Tab':       { key: 'Tab',       code: 'Tab',       windowsVirtualKeyCode: 9,   nativeVirtualKeyCode: 48 },
    'Escape':    { key: 'Escape',    code: 'Escape',    windowsVirtualKeyCode: 27,  nativeVirtualKeyCode: 53 },
    'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40,  nativeVirtualKeyCode: 125 },
    'ArrowUp':   { key: 'ArrowUp',   code: 'ArrowUp',   windowsVirtualKeyCode: 38,  nativeVirtualKeyCode: 126 },
    'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37,  nativeVirtualKeyCode: 123 },
    'ArrowRight':{ key: 'ArrowRight',code: 'ArrowRight',windowsVirtualKeyCode: 39,  nativeVirtualKeyCode: 124 },
    'Backspace': { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,   nativeVirtualKeyCode: 51 },
    'Delete':    { key: 'Delete',    code: 'Delete',    windowsVirtualKeyCode: 46,  nativeVirtualKeyCode: 117 },
    'Home':      { key: 'Home',      code: 'Home',      windowsVirtualKeyCode: 36,  nativeVirtualKeyCode: 115 },
    'End':       { key: 'End',       code: 'End',       windowsVirtualKeyCode: 35,  nativeVirtualKeyCode: 119 },
    'PageUp':    { key: 'PageUp',    code: 'PageUp',    windowsVirtualKeyCode: 33,  nativeVirtualKeyCode: 116 },
    'PageDown':  { key: 'PageDown',  code: 'PageDown',  windowsVirtualKeyCode: 34,  nativeVirtualKeyCode: 121 },
    'Space':     { key: ' ',         code: 'Space',     windowsVirtualKeyCode: 32,  nativeVirtualKeyCode: 49 },
    'Shift':     { key: 'Shift',     code: 'ShiftLeft', windowsVirtualKeyCode: 16,  nativeVirtualKeyCode: 56 },
    'Control':   { key: 'Control',   code: 'ControlLeft',windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 59 },
    'Alt':       { key: 'Alt',       code: 'AltLeft',   windowsVirtualKeyCode: 18,  nativeVirtualKeyCode: 58 },
    'Meta':      { key: 'Meta',      code: 'MetaLeft',  windowsVirtualKeyCode: 91,  nativeVirtualKeyCode: 55 },
    'F5':        { key: 'F5',        code: 'F5',        windowsVirtualKeyCode: 116, nativeVirtualKeyCode: 96 },
  };

  /**
   * Press a keyboard key using CDP Input.dispatchKeyEvent — real OS-level keyboard input
   * that works with React/Vue event systems (unlike JS dispatchEvent).
   *
   * Supports special keys (Enter, Tab, ArrowDown, etc.) and regular characters.
   */
  async pressKey(key: string, tabId?: string): Promise<{ key: string; pressed: boolean }> {
    const t = this.requireTab(tabId);
    const keyDef = BrowserManager.KEY_MAP[key];

    if (keyDef) {
      // Special key — send keyDown + keyUp via CDP
      const base: Record<string, unknown> = {
        type: 'rawKeyDown',
        key: keyDef.key,
        code: keyDef.code,
        windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode,
        nativeVirtualKeyCode: keyDef.nativeVirtualKeyCode,
        isSystemKey: false,
      };

      await this.sendCommand(t, 'Input.dispatchKeyEvent', {
        ...base,
        type: 'rawKeyDown',
      });

      // For keys that produce characters (Enter, Space, Tab), also send a char event
      if (['Enter', 'Tab', 'Space'].includes(key)) {
        await this.sendCommand(t, 'Input.dispatchKeyEvent', {
          ...base,
          type: 'char',
          text: key === 'Enter' ? '\r' : key === 'Tab' ? '\t' : ' ',
          unmodifiedText: key === 'Enter' ? '\r' : key === 'Tab' ? '\t' : ' ',
        });
      }

      await this.sendCommand(t, 'Input.dispatchKeyEvent', {
        ...base,
        type: 'keyUp',
      });
    } else {
      // Regular character — use char event which triggers React onChange properly
      await this.sendCommand(t, 'Input.dispatchKeyEvent', {
        type: 'char',
        key: key,
        text: key,
        unmodifiedText: key,
      });

      // Also send keyDown/keyUp pair for completeness
      await this.sendCommand(t, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: key,
        windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
      });
      await this.sendCommand(t, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: key,
        windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
      });
    }

    return { key, pressed: true };
  }

  /** Wait for a selector to appear on the page. */
  async waitForSelector(selector: string, timeoutMs = 10000, tabId?: string): Promise<{ selector: string; found: boolean }> {
    const found = await this.waitForElement(selector, timeoutMs, tabId);
    return { selector, found };
  }

  /** Get text content of an element (or entire page if no selector). */
  async getText(selector?: string, tabId?: string): Promise<{ text: string; selector?: string }> {
    const t = this.requireTab(tabId);
    const expr = this.buildExpression(`(function(){
      ${selector ? `var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el) return '';
      return (el.innerText || el.textContent || '').trim();` : `return (document.body.innerText || document.body.textContent || '').trim();`}
    })()`);
    const result = await this.sendCommand(t, 'Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });
    return { text: (result?.result as { value?: string })?.value ?? '', selector };
  }

  /** Get the value of an attribute on an element. */
  async getAttribute(selector: string, attribute: string, tabId?: string): Promise<{ selector: string; attribute: string; value: string | null }> {
    const t = this.requireTab(tabId);
    const expr = this.buildExpression(`(function(){
      var el = window.piResolveSelector(${JSON.stringify(selector)});
      if (!el) return null;
      return el.getAttribute(${JSON.stringify(attribute)});
    })()`);
    const result = await this.sendCommand(t, 'Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });
    return { selector, attribute, value: (result?.result as { value?: string | null })?.value ?? null };
  }

  /** Take a screenshot. Resets zoom to 1.0 for full resolution, restores after.
   *  Default: viewport only. Pass fullPage: true for full page (scrolls to trigger lazy load first).
   *  A hidden tab borrows the visible surface for a viewport capture (restored
   *  after); full-page capture works on DOM metrics alone and needs no surface. */
  async screenshot(
    options?: { fullPage?: boolean },
    tabId?: string,
  ): Promise<{ base64: string; mimeType: string }> {
    const t = this.requireTab(tabId);
    const savedZoom = t.currentZoom;

    const capture = async (): Promise<{ base64: string }> => {
      // For full-page: scroll through the page to trigger lazy-loaded content
      if (options?.fullPage) {
        await this.triggerLazyLoad(t);
        // Scroll back to top before capturing
        await this.sendCommand(t, 'Runtime.evaluate', {
          expression: 'window.scrollTo(0, 0)',
          returnByValue: true,
        });

        // Reset zoom to 1.0 for accurate content dimension measurement
        try { t.wc.setZoomFactor(1); } catch {}
        // Wait for the renderer to repaint after zoom change
        await new Promise((r) => setTimeout(r, 300));
      }

      try {
        if (options?.fullPage) {
          // Use Math.max to include horizontal overflow (scrollWidth > clientWidth)
          // and account for body-level dimensions on pages where html is constrained.
          const metrics = await this.sendCommand(t, 'Runtime.evaluate', {
            expression: `JSON.stringify({
              width: Math.max(
                document.documentElement.scrollWidth,
                document.documentElement.clientWidth,
                document.body ? document.body.scrollWidth : 0,
                document.body ? document.body.clientWidth : 0
              ),
              height: Math.max(
                document.documentElement.scrollHeight,
                document.documentElement.clientHeight,
                document.body ? document.body.scrollHeight : 0
              )
            })`,
            returnByValue: true,
          });
          const dims = JSON.parse((metrics?.result as { value?: string })?.value ?? '{"width":800,"height":600}');
          const width = Math.min(dims.width || 1920, 16384);
          const height = Math.min(dims.height || 600, 16384);

          const result = await this.sendCommand(t, 'Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width, height, scale: 1 },
          });
          return { base64: (result?.data as string) ?? '' };
        } else {
          // Viewport screenshot: capture at current zoom level.
          // Do NOT reset zoom — the user wants to see exactly what they're viewing.
          // Use Page.getLayoutMetrics for accurate viewport dimensions.
          const layoutMetrics = await this.sendCommand(t, 'Page.getLayoutMetrics', {}) as Record<string, unknown>;
          const cssViewport = layoutMetrics?.cssVisualViewport as Record<string, number> | undefined;
          const vpWidth = cssViewport?.clientWidth ?? 0;
          const vpHeight = cssViewport?.clientHeight ?? 0;

          const result = await this.sendCommand(t, 'Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
            clip: vpWidth > 0 && vpHeight > 0 ? {
              x: 0,
              y: 0,
              width: Math.floor(vpWidth),
              height: Math.floor(vpHeight),
              scale: 1,
            } : undefined,
          });
          return { base64: (result?.data as string) ?? '' };
        }
      } finally {
        // Restore zoom (only if we changed it for full-page)
        if (options?.fullPage) {
          try { t.wc.setZoomFactor(savedZoom); } catch {}
        }
      }
    };

    const shot = options?.fullPage
      ? // DOM-metrics capture works without a painted surface.
        await capture()
      : await this.withTabSurface(t, capture);
    return this.compressScreenshot(shot.base64);
  }

  /**
   * Keep a screenshot small enough for a model request.
   *
   * A full-page PNG of a long page is several megabytes; the next request then
   * fails outright (observed on v.qq.com: a 6.3 MB capture killed the turn).
   * Downscale to a sane width/height, then pick whichever encoding is smaller.
   */
  private compressScreenshot(base64: string): { base64: string; mimeType: string } {
    try {
      const raw = Buffer.from(base64, 'base64');
      const img = nativeImage.createFromBuffer(raw);
      if (img.isEmpty()) return { base64, mimeType: 'image/png' };
      const { width, height } = img.getSize();
      const MAX_W = 1400;
      const MAX_H = 4000;
      const scale = Math.min(1, MAX_W / width, MAX_H / height);
      const out =
        scale < 1
          ? img.resize({
              width: Math.max(1, Math.round(width * scale)),
              height: Math.max(1, Math.round(height * scale)),
              quality: 'good',
            })
          : img;
      const png = out.toPNG();
      if (png.length <= raw.length && png.length < 1_500_000) {
        return { base64: png.toString('base64'), mimeType: 'image/png' };
      }
      const jpeg = out.toJPEG(80);
      if (jpeg.length < png.length) return { base64: jpeg.toString('base64'), mimeType: 'image/jpeg' };
      return { base64: png.toString('base64'), mimeType: 'image/png' };
    } catch {
      return { base64, mimeType: 'image/png' };
    }
  }

  /** Scroll through the page to trigger lazy-loaded content.
   *  Uses a two-pass approach: first scrolls down in steps, then back up.
   *  Caps at 40 steps to avoid infinite pages, with 400ms between steps
   *  to give lazy loaders and image decoders time to complete. */
  private async triggerLazyLoad(t: BrowserTab): Promise<void> {
    try {
      const stepExpr = `(function(){
        var step = window.innerHeight * 0.75;
        var maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        if (window.scrollY + 5 >= maxScroll) { window.scrollTo(0, maxScroll); return false; }
        window.scrollBy(0, step);
        return true;
      })()`;
      // Pass 1: scroll down through the entire page
      let hasMore = true;
      let count = 0;
      while (hasMore && count < 40) {
        const result = await this.sendCommand(t, 'Runtime.evaluate', {
          expression: stepExpr,
          returnByValue: true,
        });
        hasMore = (result?.result as { value?: boolean })?.value ?? false;
        count++;
        await new Promise((r) => setTimeout(r, 400));
        // Also dispatch scroll events to wake IntersectionObserver-based loaders
        await this.sendCommand(t, 'Runtime.evaluate', {
          expression: 'window.dispatchEvent(new Event("scroll", {bubbles: true}))',
          returnByValue: true,
        }).catch(() => {});
      }
      // Pass 2: scroll back up to trigger any reverse-direction lazy content
      await this.sendCommand(t, 'Runtime.evaluate', {
        expression: 'window.scrollTo(0, 0)',
        returnByValue: true,
      });
      // Wait for final render to stabilize
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.warn('[BrowserManager] triggerLazyLoad error:', err);
    }
  }

  /** Scroll the page. */
  async scroll(direction: 'up' | 'down', amount = 500, tabId?: string): Promise<{ direction: string; amount: number }> {
    const t = this.requireTab(tabId);
    const dy = direction === 'down' ? amount : -amount;
    await this.sendCommand(t, 'Runtime.evaluate', {
      expression: `window.scrollBy(0, ${dy})`,
      returnByValue: true,
    });
    return { direction, amount };
  }

  /** Evaluate a JavaScript expression in the page. */
  async evaluate(expression: string, tabId?: string): Promise<{ result: unknown }> {
    const t = this.requireTab(tabId);
    const result = await this.sendCommand(t, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    return { result: (result?.result as { value?: unknown })?.value };
  }

  /** ——— Events ——— */

  /** Register a callback for URL changes (any tab; the tab id rides along). */
  onUrlChanged(cb: UrlChangedCallback): void {
    this.urlChangedCallbacks.push(cb);
  }

  /** Register interest in popup-open attempts (window.open / target=_blank). */
  onWindowOpen(cb: WindowOpenCallback): void {
    this.windowOpenCallbacks.push(cb);
  }

  /** ——— Viewport ——— */

  /** Override the webview's device metrics to match the panel width. */
  async setDeviceMetrics(width: number, height: number, tabIdOrTab?: string | BrowserTab): Promise<void> {
    const t = tabIdOrTab instanceof BrowserTab ? tabIdOrTab : this.requireTab(tabIdOrTab);
    t.webviewWidth = width;
    if (width <= 0 || width === t.metricsWidth) return;
    t.metricsWidth = width;
    // Re-fit live: the measure is one cheap CDP evaluate (no zoom reset, no
    // relayout wait), so a panel drag tracks step by step and each step
    // converges to the page's current natural width — no cached state to go
    // stale when a page reflows or lazy-renders.
    await this.computeAutoZoom(t);
  }

  /** ——— Cleanup ——— */

  /**
   * Tear down every tab — called when the owning window closes. Unlike
   * `closeTab` this also forgets LRU-evicted records: the window they would
   * reopen into no longer exists.
   */
  async destroy(): Promise<void> {
    // Capture the session cookies before the views go away: closing every tab
    // may end the renderer processes that own them.
    await persistBrowserSessionCookies().catch((err) => {
      console.warn('[browser-session] destroy persist failed:', err instanceof Error ? err.message : err);
    });
    for (const id of [...this.tabs.keys()]) {
      this.closeTab(id);
    }
    this.evictedTabs.clear();
    this.splitPartner = null;
    this.activeTabId = null;
    await this.disconnect();
    this.mainWindow = null;
  }

  /** Disconnect the debugger from every tab. */
  async disconnect(): Promise<void> {
    for (const t of this.tabs.values()) {
      if (t.debuggerAttached) {
        try {
          t.wc.debugger.detach();
        } catch {
          // Ignore detach errors
        }
        t.debuggerAttached = false;
      }
    }
  }
}
