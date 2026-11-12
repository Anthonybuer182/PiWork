/**
 * `window.desktop` — the preload API GenOffice's docs renderer is written against.
 *
 * This is the seam. The renderer never touches Electron: it calls ~80 methods
 * on this object, and that is the whole coupling surface for 277 files and
 * ~102k lines. Implementing this is what lets GenOffice's own editor run inside
 * the plugin unmodified — no fork, no port of the renderer itself.
 *
 * Two channels back it:
 *
 *  - **Reading** goes straight to `pi-plugin://…/ws-file?path=`, which the panel
 *    can fetch itself. No base64 round-trip through the backend for what can be
 *    a multi-megabyte document.
 *  - **Writing** goes through the plugin backend, which calls the host's
 *    `filesystem.write` — that is where the mtime conflict check lives, and a
 *    document editor that silently clobbers an externally-changed file is worse
 *    than one that refuses.
 *
 * AI methods deliberately do NOT reach GenOffice's provider. They route to the
 * host's own agent over `chat.send`, which is the same path as the user typing
 * in the composer.
 *
 * Server-side pieces that need Node (font metrics — the vendored package reads
 * font files off disk) are proxied to the backend.
 */

type Unsubscribe = () => void;

/** The plugin SDK injected into every panel page by the host. */
interface PiSdk {
  pluginId: string;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  emit(event: string, data?: unknown): void;
  onMessage(cb: (payload: unknown) => void): void;
  /** Native popup menu (desktop): resolves the clicked item id, null on dismiss. */
  showPopupMenu?(
    items: { id: string; label: string }[],
    x: number,
    y: number,
  ): Promise<string | null>;
}

interface PiViewBridge {
  send(payload: unknown): void;
  onMessage(cb: (payload: unknown) => void): void;
  onTheme(cb: (tokens: Record<string, string>) => void): void;
}

declare global {
  interface Window {
    piSDK?: PiSdk;
    __piViewBridge?: PiViewBridge;
    /** Set by index.html so the shim knows which file to open. */
    __PI_OPEN_PATH__?: string;
    __PI_PLUGIN_ID__?: string;
  }
}

import { reloadForOtherFormat } from '../shims/common';

const PLUGIN_ID = 'com.pi.files';

/** The extensions this renderer can actually open. Anything else must not be
 *  handed to it — see reloadForOtherFormat. */
const DOCX_EXTS = ['docx'] as const;

/** Ask the backend for something that needs real Node. */
function backend<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const sdk = window.piSDK;
  if (!sdk) return Promise.reject(new Error('plugin SDK unavailable'));
  return sdk.request(method, params) as Promise<T>;
}

const wsFileUrl = (path: string): string =>
  `pi-plugin://${PLUGIN_ID}/ws-file?path=${encodeURIComponent(path)}`;

const baseName = (path: string): string => path.split('/').pop() ?? path;

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── listeners ───────────────────────────────────────────────────────────
// GenOffice's API returns an unsubscribe function from every `on*`; several
// call sites rely on that to tear down on unmount.
function emitter<T>() {
  const handlers = new Set<(v: T) => void>();
  return {
    fire(value: T) {
      for (const h of [...handlers]) {
        try {
          h(value);
        } catch (err) {
          console.error('[desktop-shim] listener threw:', err);
        }
      }
    },
    on(handler: (v: T) => void): Unsubscribe {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

const themeChanged = emitter<string>();
const languageChanged = emitter<string>();
const autoSaveChanged = emitter<string>();
const aiStreamed = emitter<unknown>();
const viewImage = emitter<string>();
const teardown = emitter<void>();

// ── MCP bridge transport ────────────────────────────────────────────────
//
// GenOffice ships the bridge itself (`apps/docs/src/renderer/mcp-bridge.ts`,
// mounted by App.tsx): an external agent drives the LIVE Tiptap editor through
// the built-in agent's own `executeTool`, so it inherits the same parsing,
// atomicity, formatting rules and stale-index guard as GenOffice's own AI. It
// exposes read_document / replace_blocks / insert_content / apply_ops /
// save_document — read, edit and save.
//
// Its only gate is
//
//     if (!desktop?.onMcpCommand || !desktop.reportMcpResult) return () => {}
//
// so it has been inert here purely because those were no-ops. Switching it on
// is the three members below plus this subscription.
//
// The channel is the plugin's OWN point-to-point panel↔backend port: the
// commands travel from this plugin's backend to this plugin's panel and no
// further. The host relays nothing here and never sees a method name, so
// bridging GenOffice this way adds no host capability and no protocol surface.

interface McpCommandMessage {
  requestId: string;
  command: string;
  payload?: unknown;
}

const mcpCommands = emitter<McpCommandMessage>();

window.piSDK?.onMessage((payload) => {
  const msg = payload as { kind?: string; event?: string; data?: unknown } | null;
  if (msg?.kind !== 'event' || msg.event !== 'mcp-command') return;
  const data = msg.data as McpCommandMessage | undefined;
  if (!data || typeof data.requestId !== 'string' || typeof data.command !== 'string') return;
  // The bridge serializes its own runs; this only avoids a second listener pass.
  mcpCommands.fire(data);
});

/** Theme tokens the host streams into every panel → `data-theme` for GenOffice. */
function installThemeBridge(): void {
  let last: string | null = null;
  const apply = (dark: boolean) => {
    const next = dark ? 'dark' : 'light';
    // Re-applying the same value must NOT notify: GenOffice's own
    // `onThemeChanged` handler writes `data-theme` back out, so notifying on a
    // no-op change closes a feedback loop and pins a core at 100%.
    if (next === last) return;
    last = next;
    document.documentElement.setAttribute('data-theme', next);
    themeChanged.fire(next);
  };
  const read = () => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
    // The host's tokens are HSL triplets; a low lightness means a dark shell.
    const l = Number((bg.match(/([\d.]+)%\s*$/) ?? [])[1]);
    return Number.isFinite(l) ? l < 50 : true;
  };
  const applyTokens = (tokens?: Record<string, string>) => {
    // The bridge now fans tokens out to several subscribers, so this panel
    // writes them itself rather than assuming the SDK already did.
    if (tokens) {
      for (const [name, value] of Object.entries(tokens)) {
        document.documentElement.style.setProperty(name, value);
      }
    }
    apply(read());
  };
  applyTokens();
  // The host pushes tokens on a theme change; that is the only signal. (An
  // earlier version also watched `data-theme` with a MutationObserver as a
  // fallback — which is exactly the loop described above.)
  window.__piViewBridge?.onTheme(applyTokens);
}

// ── the pending document ────────────────────────────────────────────────
//
// GenOffice's App calls `consumePendingOpenDocx()` on mount to learn which
// document to open. The host already tells the panel which file it wants: the
// backend pushes `ui.render { path }` when the panel mounts (the same event the
// old viewer used).
//
// The panel is keepAlive, so App mounts ONCE and never calls consume again.
// Clicking a second file therefore has to arrive through `onOpenDocx`, which is
// the channel GenOffice's own main process uses for exactly this. Without it the
// panel silently keeps editing the first document — and saves it.
let pendingPath: string | null = null;
let pendingWaiters: Array<(p: string | null) => void> = [];
let appBooted = false;
let currentPath: string | null = null;
const openDocxListeners = new Set<(result: unknown) => void>();

/** Tell the backend which document the editor now holds. `ensureDocxActive`
 *  on the backend waits for the target path to be announced, so a tab switch
 *  (or a panel reload for another format) can never race a queued command onto
 *  the wrong editor. Redundant announcements are harmless. */
function announceMcpReady(): void {
  void backend('mcp.ready', { path: currentPath ?? '' }).catch(() => undefined);
}

window.piSDK?.onMessage((payload) => {
  const msg = payload as { event?: string; data?: { path?: string } } | null;
  if (msg?.event !== 'ui.render') return;
  const path = msg.data?.path;
  if (typeof path !== 'string' || !path) return;

  if (pendingPath === null && pendingWaiters.length > 0) {
    // App is still booting: hand it over as the pending document.
    pendingPath = path;
    const waiters = pendingWaiters;
    pendingWaiters = [];
    for (const w of waiters) w(path);
    return;
  }

  if (!appBooted) {
    pendingPath = path;
    return;
  }

  // App is already mounted — this is a file switch.
  //
  // A keepAlive panel keeps THIS renderer mounted, so a file of another format
  // must not be handed to it: a .pptx fed to the docx engine fails with
  // "document.xml has no <w:body> element". Reload instead, and let the panel's
  // dispatcher choose the right renderer.
  // docs is the one renderer that opens a second file IN PLACE (openDocxPath
  // below) — see reloadForOtherFormat for why the others reload instead.
  if (reloadForOtherFormat(path, DOCX_EXTS, { handlesSameFormat: true }) === 'reloading') return;

  if (path === currentPath) return;
  void openDocxPath(path)
    .then((result) => {
      currentPath = path;
      // Announce before the listeners fire: the backend may unblock a queued
      // command that opens more documents behind this one.
      announceMcpReady();
      for (const h of openDocxListeners) {
        try {
          h(result);
        } catch (err) {
          console.error('[desktop-shim] onOpenDocx listener threw:', err);
        }
      }
    })
    .catch((err) => console.error('[desktop-shim] switch failed:', err));
});

function takePendingPath(timeoutMs = 4000): Promise<string | null> {
  appBooted = true;
  if (pendingPath) {
    const p = pendingPath;
    pendingPath = null;
    currentPath = p;
    return Promise.resolve(p);
  }
  const injected = window.__PI_OPEN_PATH__;
  if (injected) {
    currentPath = injected;
    return Promise.resolve(injected);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingWaiters = pendingWaiters.filter((w) => w !== onPath);
      resolve(null);
    }, timeoutMs);
    const onPath = (p: string | null) => {
      clearTimeout(timer);
      currentPath = p;
      resolve(p);
    };
    pendingWaiters.push(onPath);
  });
}

// ── the API ─────────────────────────────────────────────────────────────

/** Paths the renderer has opened, so a save can carry a conflict baseline. */
const openMtimes = new Map<string, number>();

async function openDocxPath(path: string): Promise<unknown> {
  const res = await fetch(wsFileUrl(path));
  if (!res.ok) throw new Error(`cannot open ${path}: ${res.status} ${res.statusText}`);
  const data = await res.arrayBuffer();
  const meta = await backend<{ mtime?: number }>('file.stat', { path }).catch(() => ({ mtime: undefined }));
  if (typeof meta?.mtime === 'number') openMtimes.set(path, meta.mtime);

  // Newer GenOffice opens through a ONE-SHOT URL (`dataUrl`) and fetches it
  // exactly once, rather than handing the renderer an ArrayBuffer over IPC.
  // A blob URL is the equivalent in this host: same-origin under the plugin
  // page and fetchable by the renderer. Release it after the open has had
  // time to read it — a document replaced in place must not keep its old
  // bytes alive for the panel's whole lifetime.
  const dataUrl = URL.createObjectURL(
    new Blob([data], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
  );
  setTimeout(() => URL.revokeObjectURL(dataUrl), 60_000);

  return {
    path,
    name: baseName(path),
    dataUrl,
    hash: await sha256Hex(data),
  };
}

/**
 * Base64 of the bytes, chunked.
 *
 * `String.fromCharCode(...bytes)` spreads every byte as an argument and
 * overflows the call stack past roughly 64 KB — a limit real documents pass
 * routinely (the 188 KB fixture here did, and the save silently failed with
 * "[office_edit] the document could not be saved").
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function saveBytes(path: string, data: ArrayBuffer): Promise<{ ok: boolean; error?: string }> {
  try {
    const base64 = bytesToBase64(new Uint8Array(data));
    const res = await backend<{ mtime?: number }>('file.write', {
      path,
      base64,
      expectedMtime: openMtimes.get(path),
    });
    // Re-baseline. `filesystem.write` is a compare-and-swap against the mtime we
    // read at open, so without this every save AFTER the first would report a
    // conflict against our own write.
    if (typeof res?.mtime === 'number') openMtimes.set(path, res.mtime);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A save target the user picks. The host owns the dialog, so this asks the
 * backend, which calls the host's dialog capability.
 */
async function pickSavePath(defaultName: string): Promise<string | null> {
  try {
    const res = await backend<{ path?: string | null }>('file.pickSavePath', { defaultName });
    return res?.path ?? null;
  } catch {
    return null;
  }
}

export function installDesktopShim(): void {
  installThemeBridge();

  const api: Record<string, unknown> = {
    // ── environment ───────────────────────────────────────────────────
    getLanguage: async () => 'zh',
    onLanguageChanged: (h: (l: string) => void) => languageChanged.on(h),
    getTheme: async () => 'system',
    onThemeChanged: (h: (t: string) => void) => themeChanged.on(h),
    // The host owns auto-save policy; the editor just reports dirty state.
    getAutoSaveDefault: async () => 'on',
    onAutoSaveDefaultChanged: (h: (v: string) => void) => autoSaveChanged.on(h),

    // ── documents ─────────────────────────────────────────────────────
    openDocxPath,
    openDocx: async () => {
      const res = await backend<{ path?: string | null }>('file.pickOpenPath', {
        filters: [{ name: 'Word', extensions: ['docx'] }],
      });
      return res?.path ? openDocxPath(res.path) : null;
    },
    // Encrypted OOXML needs the engine's decrypt path, which is not wired yet.
    openDocxDecrypt: async () => ({ ok: false, reason: 'unsupported' }),
    consumePendingOpenDocx: async () => {
      const path = await takePendingPath();
      if (!path) return null;
      try {
        const result = await openDocxPath(path);
        // Boot announcement — the editor now holds `path` (same signal the
        // in-place switch sends; the bridge's own signalMcpReady carries the
        // same value, whichever lands first).
        announceMcpReady();
        return result;
      } catch (err) {
        console.error('[desktop-shim] open failed:', err);
        return null;
      }
    },
    consumeNewBlankDoc: async () => false,
    consumeAiDocContent: async () => null,
    consumeHeadlessExport: async () => null,
    headlessExportDone: () => undefined,
    createDocument: async () => ({ ok: false, error: 'not supported in this host' }),
    setDocPassword: async () => ({ ok: false }),
    docPasswordIntentRevision: async () => 0,
    discardDocPasswordIntents: async () => ({ ok: true }),
    convertAltChunkHtml: async () => null,

    saveDocx: (path: string, data: ArrayBuffer) => saveBytes(path, data),
    saveDocxAs: async (defaultName: string, data: ArrayBuffer) => {
      const path = await pickSavePath(defaultName);
      if (!path) return { ok: false, error: 'cancelled' };
      return { ...(await saveBytes(path, data)), path };
    },
    saveDocxNew: async (defaultName: string, data: ArrayBuffer) => {
      const path = await pickSavePath(defaultName);
      if (!path) return { ok: false, error: 'cancelled' };
      return { ...(await saveBytes(path, data)), path };
    },
    saveDocxTo: async (path: string, data: ArrayBuffer) => {
      const r = await saveBytes(path, data);
      return r.ok ? { ok: true, path } : { ok: false, error: r.error };
    },
    writeRecoveryCopy: async () => ({ ok: false }),

    // ── media ─────────────────────────────────────────────────────────
    pickImage: async () => {
      const res = await backend<{ path?: string | null }>('file.pickOpenPath', {
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif'] }],
      });
      if (!res?.path) return null;
      const bytes = await (await fetch(wsFileUrl(res.path))).arrayBuffer();
      const b64 = bytesToBase64(new Uint8Array(bytes));
      const ext = (res.path.split('.').pop() ?? 'png').toLowerCase();
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : 'image/png';
      return { base64: b64, mime, name: baseName(res.path) };
    },
    copyImageToClipboard: async (dataUrl: string) => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': await (await fetch(dataUrl)).blob() })]);
        return true;
      } catch {
        return false;
      }
    },
    getPathForFile: () => '',
    saveImageAs: async () => ({ ok: false }),
    onViewImage: (h: (src: string) => void) => viewImage.on(h),

    // ── measurement (Node-side, so it is proxied) ─────────────────────
    fontMetrics: async (family: string) => {
      try {
        return await backend('font.metrics', { family });
      } catch {
        // A null tells the renderer to fall back to its own heuristics, which
        // is exactly what it does when a face is not installed.
        return null;
      }
    },

    // ── print / export: the host owns dialogs, so these are not wired yet ──
    print: async () => ({ ok: false, error: '打印尚未接入宿主' }),
    exportPdf: async () => ({ ok: false, error: 'PDF 导出尚未接入宿主' }),
    exportHtml: async () => ({ ok: false, error: 'HTML 导出尚未接入宿主' }),
    printPdfBuffer: async () => ({ ok: false, error: 'not supported' }),
    saveMergedPdf: async () => ({ ok: false, error: 'not supported' }),
    pickExportImagesTarget: async () => null,
    takeExportPdf: async () => ({ ok: false }),
    writeExportImage: async () => ({ ok: false }),

    // ── AI: routed to the HOST's agent, not GenOffice's provider ──────
    //
    // The AiPanel component is ours (see AiPanel.tsx); these exist so any
    // remaining call site resolves. They deliberately do nothing clever.
    aiChat: async () => ({ text: '', error: 'AI 由宿主的 agent 处理，见 AiPanel' }),
    aiStream: async () => undefined,
    aiStreamCancel: async () => undefined,
    aiGskStatus: async () => ({ loggedIn: false }),
    aiGskLogin: async () => undefined,
    getAiSettings: async () => ({ providers: {}, activeProvider: null }),
    setAiSettings: async () => undefined,
    getAiPanelPrefs: async () => ({}),
    setAiPanelPrefs: async (p: unknown) => p,
    onAiPanelPrefsChanged: () => () => undefined,
    onAiStream: (h: (c: unknown) => void) => aiStreamed.on(h),
    webSearch: async () => ({ results: [], method: 'unavailable', error: '搜索未接入宿主' }),
    imageSearch: async () => ({ images: [], method: 'unavailable', error: '图片搜索未接入宿主' }),
    fetchImage: async () => null,
    aiGenerateImage: async () => ({ error: '图片生成未接入宿主' }),
    pickAttachments: async () => null,
    addAttachmentPaths: async () => ({ ok: false }),
    addPastedImage: async () => ({ ok: false }),
    readAttachment: async () => ({ ok: false }),
    readAttachmentImage: async () => ({ ok: false }),

    // ── tabs / lifecycle / menus: the host owns these, so no-ops ──────
    openNewTab: async () => undefined,
    listDocsTabs: async () => [],
    focusDocsTab: async () => undefined,
    onOpenDocx: (h: (result: unknown) => void) => {
      openDocxListeners.add(h);
      return () => openDocxListeners.delete(h);
    },
    onRenamedDocx: () => () => undefined,
    onTeardown: (h: () => void) => teardown.on(h),
    onChromePressed: () => () => undefined,
    onMenuCommand: () => () => undefined,
    onCloseCheck: () => () => undefined,
    reportCloseCheck: () => undefined,
    onCloseSaveRequest: () => () => undefined,
    reportCloseSaveResult: () => undefined,
    reportViewMenuState: () => undefined,
    getRecentFiles: async () => [],
    respellKick: async () => undefined,
    spellDiag: () => undefined,
    // GenOffice's own external-agent bridge — see the transport block above.
    onMcpCommand: (handler: (msg: McpCommandMessage) => void) => mcpCommands.on(handler),
    reportMcpResult: (result: Record<string, unknown>) => {
      void backend('mcp.result', result).catch(() => undefined);
    },
    signalMcpReady: () => {
      // Announce WHICH document is loaded — the backend's multi-doc
      // `ensureDocxActive` gates on it. `currentPath` is set by the time the
      // bridge signals (takePendingPath resolved during App boot); an empty
      // string means no document and is ignored backend-side.
      announceMcpReady();
    },
    zoteroCommand: async () => ({ ok: false }),
    onZoteroRequest: () => () => undefined,
    respondToZotero: () => undefined,
  };

  // Assigned through a cast rather than a `declare global` of our own:
  // GenOffice's `apps/docs/src/renderer/env.d.ts` already declares
  // `window.desktop: DesktopApi`, and merging a second declaration whose
  // modifier differs is a hard error (TS2687) — as would restating the type
  // (TS2717). Their declaration is the accurate one; ours only needs to write
  // to it.
  (window as unknown as { desktop: Record<string, unknown> }).desktop = api;
}

// Install on import, not via a call from the entry.
//
// ES module evaluation follows import order, so a bare `import './desktop-shim'`
// placed FIRST is guaranteed to run before GenOffice's renderer is evaluated.
// Calling an install function from the entry would not be: imports are hoisted,
// so the renderer's module body would already have run — and it reads
// window.desktop at module scope.
installDesktopShim();
