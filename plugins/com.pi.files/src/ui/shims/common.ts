/**
 * The part of GenOffice's preload API that every app shares.
 *
 * Each app is written against its own global (`window.desktop` for docs,
 * `window.pdfApi` for pdf, `window.slidesApi` for slides, `window.desktopApi`
 * for sheets), but roughly a quarter of each surface is the same: language,
 * theme, the AI-panel prefs, and a pile of lifecycle no-ops whose real
 * implementation lives in GenOffice's own main process.
 *
 * Written once here, so a new app is its own 30-50 methods rather than 80.
 *
 * Two conventions this file keeps, because the apps depend on them:
 *   - every `on*` returns an unsubscribe function (apps call it on unmount)
 *   - nothing throws for a missing feature; it returns a shape the UI can
 *     render a disabled state from. A rejected promise here surfaces as an
 *     unhandled rejection in an app that has no error boundary for it.
 */

type Unsubscribe = () => void;

export interface PiSdk {
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

export interface PiViewBridge {
  send(payload: unknown): void;
  onMessage(cb: (payload: unknown) => void): void;
  onTheme(cb: (tokens: Record<string, string>) => void): void;
}

export const PLUGIN_ID = 'com.pi.files';

/** Ask the plugin backend for something the panel cannot do itself. */
export function backend<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const sdk = (window as unknown as { piSDK?: PiSdk }).piSDK;
  if (!sdk) return Promise.reject(new Error('plugin SDK unavailable'));
  return sdk.request(method, params) as Promise<T>;
}

export const wsFileUrl = (path: string): string =>
  `pi-plugin://${PLUGIN_ID}/ws-file?path=${encodeURIComponent(path)}`;

/**
 * Write UTF-8 text through the plugin backend.
 *
 * `file.write` takes base64 of the BYTES under the key `base64` — the same call
 * carries a .docx, so a text round-trip through a JS string would mangle
 * anything outside Latin-1. Two things went wrong when each shim rolled its own:
 * one passed `content` (the backend reads `base64`, so the file was written
 * empty — a silent 0-byte write, not an error), and `btoa(text)` throws on CJK.
 * Encoding here, once, is so neither can happen again.
 */
export async function writeTextFile(
  path: string,
  text: string,
  expectedMtime?: number,
): Promise<unknown> {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  // Chunked: `String.fromCharCode(...bytes)` on a large buffer overflows the
  // argument stack, and these can be whole documents.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return backend('file.write', {
    path,
    base64: btoa(binary),
    ...(expectedMtime !== undefined ? { expectedMtime } : {}),
  });
}

export const baseName = (path: string): string => path.split('/').pop() ?? path;

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A tiny subscribe/broadcast pair. Every `on*` in the API is one of these.
 *
 * The coalescing guard matters: an app's own theme handler writes `data-theme`
 * back out, so notifying on a no-op change closes a feedback loop that pins a
 * core at 100% (that happened; it is why `fire` compares first).
 */
export function emitter<T>() {
  const handlers = new Set<(v: T) => void>();
  let last: T | undefined;
  let hasLast = false;
  return {
    fire(value: T) {
      if (hasLast && value === last) return;
      last = value;
      hasLast = true;
      for (const h of [...handlers]) {
        try {
          h(value);
        } catch (err) {
          console.error('[pi-shim] listener threw:', err);
        }
      }
    },
    on(handler: (v: T) => void): Unsubscribe {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
  };
}

/** The shared signals, so apps and shims agree on one instance each. */
export const signals = {
  theme: emitter<string>(),
  language: emitter<string>(),
  autoSave: emitter<string>(),
  aiStream: emitter<unknown>(),
  viewImage: emitter<string>(),
  teardown: emitter<void>(),
};

/**
 * Theme tokens the host streams into every panel → `data-theme` for GenOffice.
 *
 * The host pushes tokens via the preload bridge; that is the only signal. An
 * earlier version also watched `data-theme` with a MutationObserver as a
 * fallback, which is exactly the feedback loop described above.
 */
export function installThemeBridge(): void {
  const read = () => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
    // The host's tokens are HSL triplets; a low lightness means a dark shell.
    const l = Number((bg.match(/([\d.]+)%\s*$/) ?? [])[1]);
    return Number.isFinite(l) ? (l < 50 ? 'dark' : 'light') : 'dark';
  };
  const apply = (theme: string) => {
    document.documentElement.setAttribute('data-theme', theme);
    signals.theme.fire(theme);
  };
  const applyTokens = (tokens?: Record<string, string>) => {
    // Write the tokens before reading: the bridge hands them to every
    // subscriber, but the SDK that normally writes them may not have run yet.
    if (tokens) {
      for (const [name, value] of Object.entries(tokens)) {
        document.documentElement.style.setProperty(name, value);
      }
    }
    apply(read());
  };
  applyTokens();
  (window as unknown as { __piViewBridge?: PiViewBridge }).__piViewBridge?.onTheme(applyTokens);
}

/** Read a document's bytes, plus a hash and an mtime baseline for save. */
export async function readDocument(path: string): Promise<{
  path: string;
  name: string;
  data: ArrayBuffer;
  hash: string;
  mtime: number | null;
}> {
  const res = await fetch(wsFileUrl(path));
  if (!res.ok) throw new Error(`cannot read ${path}: ${res.status} ${res.statusText}`);
  const data = await res.arrayBuffer();
  // The fallback is annotated, not left as `{}`: an unannotated `() => ({})`
  // widens the awaited type to `{ mtime?: number } | {}`, and reading `.mtime`
  // off that union is an error on the `{}` branch.
  // Time-bounded: a page without a host tab identity (the slides audience
  // window opened by window.open) gets no reply to backend requests, and an
  // unbounded await here would hang the whole load. mtime is only the save
  // conflict baseline; null is a valid answer.
  const meta = await Promise.race([
    backend<{ mtime?: number }>('file.stat', { path }).catch((): { mtime?: number } => ({})),
    new Promise<{ mtime?: number }>((resolve) => setTimeout(() => resolve({}), 1500)),
  ]);
  return {
    path,
    name: baseName(path),
    data,
    hash: await sha256Hex(data),
    mtime: typeof meta?.mtime === 'number' ? meta.mtime : null,
  };
}

/**
 * The methods every app's preload surface contains, minus the app's own.
 *
 * `readDocument`/`writeDocument` are not here: each app names them differently
 * (`openDocx` vs `readFile` vs `openPptx`), so the app module wires its own
 * names to these.
 */
export function commonApi(): Record<string, unknown> {
  return {
    getLanguage: async () => 'zh',
    onLanguageChanged: (h: (l: string) => void) => signals.language.on(h),
    getTheme: async () => 'system',
    onThemeChanged: (h: (t: string) => void) => signals.theme.on(h),
    getAutoSaveDefault: async () => 'on',
    onAutoSaveDefaultChanged: (h: (v: string) => void) => signals.autoSave.on(h),

    // AI: the host's agent owns this, and the panel that would consume these
    // prefs is replaced by nothing — see src/ui/ai/no-ai-surface.tsx. The apps
    // still call them during boot, so they have to answer; the values are inert.
    getAiPanelPrefs: async () => ({}),
    setAiPanelPrefs: async (p: unknown) => p,
    onAiPanelPrefsChanged: () => () => undefined,
    getAiSettings: async () => ({ providers: {}, activeProvider: null }),
    setAiSettings: async () => undefined,
    gskStatus: async () => ({ loggedIn: false }),
    aiStream: async () => undefined,
    aiStreamCancel: async () => undefined,
    onAiStream: (h: (c: unknown) => void) => signals.aiStream.on(h),
    imageSearch: async () => ({ images: [], method: 'unavailable', error: '搜索未接入宿主' }),
    fetchImage: async () => null,
    generateImage: async () => ({ error: '图片生成未接入宿主' }),
    webSearch: async () => ({ results: [], method: 'unavailable', error: '搜索未接入宿主' }),

    // Lifecycle / window chrome: the host owns these.
    onChromePressed: () => () => undefined,
    onTeardown: (h: () => void) => signals.teardown.on(h),
    onMenuCommand: () => () => undefined,
    onViewImage: (h: (src: string) => void) => signals.viewImage.on(h),
    getUsername: async () => '',
    setDirty: () => undefined,
  };
}

// ── Format routing across a keepAlive panel ─────────────────────────────
//
// The panel is keepAlive, so whichever renderer mounted first stays mounted.
// That is right for switching between two files of the same kind, and WRONG for
// anything else: handing a .pptx to the docx engine fails with
// "document.xml has no <w:body> element" — a pptx is a zip with no
// word/document.xml, and the message names the format it wanted rather than the
// one it got, which reads like a corrupt file instead of a routing mistake.
//
// So: same format class → hand it to the mounted renderer. Different → remember
// the path and reload, which re-runs the panel's dispatcher and mounts the
// right one.
export const PENDING_PATH_KEY = 'pi.files.openPath';

export const extOf = (p: string): string => p.toLowerCase().split('.').pop() ?? '';

export function persistPendingPath(path: string): void {
  try {
    sessionStorage.setItem(PENDING_PATH_KEY, path);
  } catch {
    /* private mode; the reload lands on the empty state */
  }
}

export function readPersistedPath(): string {
  try {
    return sessionStorage.getItem(PENDING_PATH_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Returns 'reloading' when the panel is being reloaded for a different format,
 * or null when the caller should handle the file itself.
 */
/**
 * Decide what to do when the host hands this panel a new file.
 *
 * Returns `'reloading'` when it has taken over — the caller must stop, because
 * the page is going away.
 *
 * ## Why a same-format switch reloads
 *
 * The panel is keepAlive, so the mounted renderer stays mounted. Two files of
 * the SAME format could therefore be handed straight to it… but only docs can
 * actually take one: it has an `onOpenDocx` channel and an in-place open path.
 * The other five (sheets, slides, pdf, markdown, html) have neither, so a second
 * file used to arrive, be recorded, and change nothing — the panel kept showing
 * the FIRST file indefinitely, which reads as the viewer hanging on click.
 *
 * Reloading is the one mechanism that already works for every renderer (a
 * cross-format switch has always done it, measured at ~120–350 ms), so it is
 * what they get. The cost is the panel's in-memory state — scroll position, an
 * unsaved edit — which is why `handlesSameFormat` exists for the one renderer
 * that can do better.
 */
export function reloadForOtherFormat(
  path: string,
  myExts: readonly string[],
  opts: { handlesSameFormat?: boolean } = {},
): 'reloading' | null {
  const own = myExts.includes(extOf(path));
  if (own) {
    if (opts.handlesSameFormat) return null; // the shim opens it in place
    // Nothing to do if this is the file already on screen — the host can repeat
    // a `ui.render` for the same path, and reloading on that would loop.
    if (readPersistedPath() === path) return null;
  }
  persistPendingPath(path);
  location.reload();
  return 'reloading';
}
