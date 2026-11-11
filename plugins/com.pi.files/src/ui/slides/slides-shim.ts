/**
 * `window.slidesApi` — the preload API GenOffice's slides renderer is written against.
 *
 * GenOffice's design puts the *parsing, layout and edit journal* in its main
 * process: the renderer receives plain-data `RenderSlide[]` and only paints them
 * with Konva. That is why `openPptx(fitWidthPx)` takes no path and `save()` takes
 * no bytes — main owns the file.
 *
 * Here the plugin owns it instead, which is fine because the packages that do
 * that work are pure TypeScript and already vendored:
 *   pptx-engine  → openPptx(bytes) / savePptx(opened)
 *   pptx-render  → buildRenderSlide(...)   (canvas-free by design)
 *   pptx-ops     → runTxn(opened, { ops }) (the edit registry)
 *
 * This file is the preload surface: open/close, the deck handed to the renderer,
 * save. The edits themselves live in `editor.ts` — the same split upstream has
 * between main and session-state.
 *
 * Deliberate simplification: GenOffice injects exact metrics by parsing system
 * font files with opentype.js on the Node side. `pptx-render` documents a
 * heuristic fallback for exactly this case, so we let it use that rather than
 * proxy font files through the backend. Text metrics will be a shade less exact;
 * everything else — shapes, fills, images, tables, charts, layout — is identical.
 */

import { createBlankPptx, openPptx as openPptxBytes } from '@genoffice/pptx-engine';
import type { RenderSlide } from '@genoffice/pptx-render';
import {
  commonApi,
  emitter,
  installThemeBridge,
  persistPendingPath,
  readPersistedPath,
  readDocument,
  reloadForOtherFormat,
  backend,
} from '../shims/common';
import { slidesApiStubs } from './stubs';
import type {
  AudienceNavAction,
  ShowInkEvent,
  ShowSyncState,
} from '../../../vendor/genoffice/apps/slides/src/shared/ipc';
import { SlideEditor } from './editor';

const SLIDES_EXTS = ['pptx', 'ppt'] as const;

interface OpenResult {
  path: string;
  slides: RenderSlide[];
  size: { cx: number; cy: number };
  defaultFont?: string;
}

// ── state ───────────────────────────────────────────────────────────────
let current: SlideEditor | null = null;
let pendingPath: string | null = null;
let appBooted = false;
const opened = emitter<OpenResult | null>();
const history = emitter<{ canUndo: boolean; canRedo: boolean }>();
// ── presenter view / audience window ───────────────────────────────────
// The audience window is the same page opened with `?mode=audience` (the
// vendored renderer mounts AudienceView on that flag). Electron does not expose
// `window.opener` to that child, so the two windows talk over a BroadcastChannel
// scoped to this origin.
let audienceWindow: Window | null = null;
let lastShowSync: ShowSyncState | null = null;
/** Set when the audience window announces itself (window.open returns null to the page). */
let audienceSeen = false;
const showSync = emitter<ShowSyncState>();
const showInk = emitter<ShowInkEvent>();
const audienceNav = emitter<AudienceNavAction>();
const showChannel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('pi-slides-show') : null;

showChannel?.addEventListener('message', (event) => {
  const msg = event.data as
    | { type?: string; state?: ShowSyncState; ink?: ShowInkEvent; action?: AudienceNavAction }
    | null;
  switch (msg?.type) {
    case 'pi-show-sync':
      if (msg.state) {
        lastShowSync = msg.state;
        showSync.fire(msg.state);
      }
      break;
    case 'pi-show-ink':
      if (msg.ink) showInk.fire(msg.ink);
      break;
    case 'pi-audience-nav':
      if (msg.action) audienceNav.fire(msg.action);
      break;
    case 'pi-audience-ready':
      // The audience window mounted late: hand it the state it missed.
      audienceSeen = true;
      showChannel?.postMessage({ type: 'pi-show-sync', state: lastShowSync });
      break;
    case 'pi-close':
      // The presenter asked its audience to go away; a child window can close
      // itself even though the opener never received a WindowProxy.
      window.close();
      break;
  }
});

/**
 * The audience window has its own page instance, so it has to load the deck
 * itself. `presenterStart` puts the path on the URL; persisted/injected paths
 * cover the case where the viewer was opened some other way.
 */
let lazyLoad: Promise<void> | null = null;

function openTargetPath(): string | null {
  try {
    const fromUrl = new URLSearchParams(location.search).get('piOpen');
    if (fromUrl) return fromUrl;
  } catch {
    /* malformed query */
  }
  const injected = (window as unknown as { __PI_OPEN_PATH__?: string }).__PI_OPEN_PATH__;
  return injected || readPersistedPath() || null;
}

async function ensureLoaded(): Promise<void> {
  if (current) return;
  if (lazyLoad) return lazyLoad;
  const path = openTargetPath();
  if (!path) return;
  lazyLoad = loadSlides(path, current?.fitWidthPx ?? 960)
    .then(() => undefined)
    .catch((err) => console.error('[slides-shim] audience load failed:', err))
    .finally(() => {
      lazyLoad = null;
    });
  return lazyLoad;
}

// ── recent files (per-viewer convenience, not document state) ──────────
const RECENT_KEY = 'pi.slides.recent';

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function rememberRecent(path: string): void {
  try {
    const next = [path, ...readRecent().filter((p) => p !== path)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage disabled */
  }
}


/**
 * Set while the deck has unsaved edits.
 *
 * The panel dispatcher (`ui/panel/main.ts`) consults this before reloading for
 * `ui.fileChanged`: a reload throws away the in-memory deck, so an edit made
 * here but not saved yet must not be lost to an agent's write. When it is set,
 * the dispatcher leaves the page alone and this module shows the conflict banner.
 */
function setViewerDirty(dirty: boolean): void {
  (window as unknown as { __PI_VIEWER_DIRTY__?: boolean }).__PI_VIEWER_DIRTY__ = dirty;
  if (!dirty) document.getElementById('pi-external-change')?.remove();
}

async function loadSlides(path: string, fitWidthPx: number): Promise<OpenResult> {
  const doc = await readDocument(path);
  const parsed = await openPptxBytes(new Uint8Array(doc.data));
  const editor = new SlideEditor(parsed, path, fitWidthPx, doc.mtime);
  rememberRecent(path);
  editor.onHistoryChanged = (state) => history.fire(state);
  editor.onDirtyChanged = (dirty) => setViewerDirty(dirty);
  current = editor;
  setViewerDirty(false);
  return {
    path,
    slides: editor.rebuildAll(),
    size: { cx: parsed.deck.size.cx, cy: parsed.deck.size.cy },
  };
}

/** Chunked: spreading a whole-deck buffer into `String.fromCharCode` overflows the stack. */
function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * The file on disk changed while this panel holds unsaved edits.
 *
 * Two writers, no coordination: the agent (or another window) rewrote the file,
 * and the deck here is based on the bytes it parsed. Reloading silently would
 * discard the user's work, and saving blindly would clobber theirs — so the
 * conflict is surfaced with one choice or the other, never resolved by guessing.
 */
function showExternalChangeBanner(editor: SlideEditor): void {
  if (document.getElementById('pi-external-change')) return;
  const box = document.createElement('div');
  box.id = 'pi-external-change';
  box.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:20px',
    'transform:translateX(-50%)',
    'z-index:2147483000',
    'display:flex',
    'align-items:center',
    'gap:12px',
    'padding:10px 14px',
    'border-radius:10px',
    'border:1px solid hsl(var(--border, 214 32% 91%))',
    'background:hsl(var(--card, 0 0% 100%))',
    'color:hsl(var(--foreground, 222.2 84% 4.9%))',
    'font:12px/1.4 var(--font-sans, -apple-system, "PingFang SC", sans-serif)',
    'box-shadow:0 8px 24px rgb(0 0 0 / 0.12)',
  ].join(';');

  const text = document.createElement('span');
  text.textContent = '文件已被外部修改（AI 或其他窗口保存过），你还有未保存的编辑。';
  box.appendChild(text);

  const button = (label: string, primary: boolean, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = [
      'border:1px solid hsl(var(--border, 214 32% 91%))',
      'border-radius:6px',
      'padding:4px 10px',
      'font:inherit',
      'cursor:pointer',
      'white-space:nowrap',
      primary ? 'background:hsl(var(--accent, 210 40% 96%));color:hsl(var(--accent-foreground, 222 47% 11%))' : 'background:transparent;color:inherit',
    ].join(';');
    b.addEventListener('click', onClick);
    return b;
  };

  const reload = button('重新加载（丢弃我的修改）', false, () => location.reload());
  const overwrite = button('覆盖保存', true, () => {
    overwrite.disabled = true;
    void (async () => {
      try {
        // A deliberate overwrite: no expectedMtime, because the user just chose
        // this file over the other writer's version.
        await backend('file.write', { path: editor.path, base64: toBase64(await editor.toBytes()) });
        location.reload();
      } catch (err) {
        overwrite.disabled = false;
        console.error('[slides-shim] overwrite failed:', err);
      }
    })();
  });
  box.append(reload, overwrite);
  document.body.appendChild(box);
}

// ── install ─────────────────────────────────────────────────────────────
installThemeBridge();

window.addEventListener('pi:external-change', () => {
  if (current) showExternalChangeBanner(current);
});

window.piSDK?.onMessage((payload) => {
  const msg = payload as { event?: string; data?: { path?: string } } | null;
  if (msg?.event !== 'ui.render') return;
  const path = msg.data?.path;
  if (typeof path !== 'string' || !path) return;

  if (!appBooted) {
    pendingPath = path;
    return;
  }
  // A keepAlive panel keeps THIS renderer mounted; another format must reload
  // so the dispatcher can pick the right one. See shims/common.ts.
  if (reloadForOtherFormat(path, SLIDES_EXTS) === 'reloading') return;
  if (path === current?.path) return;
  void loadSlides(path, current?.fitWidthPx ?? 960)
    .then((r) => opened.fire(r))
    .catch((err) => console.error('[slides-shim] switch failed:', err));
});

function takePendingPath(timeoutMs = 4000): Promise<string | null> {
  appBooted = true;
  if (pendingPath) {
    const p = pendingPath;
    pendingPath = null;
    return Promise.resolve(p);
  }
  const injected = (window as unknown as { __PI_OPEN_PATH__?: string }).__PI_OPEN_PATH__;
  if (injected) return Promise.resolve(injected);
  const persisted = readPersistedPath();
  if (persisted) return Promise.resolve(persisted);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    void timer;
    void ((p: string | null) => {
      pendingPath = p;
    });
  });
}

const api: Record<string, unknown> = {
  // Shape-correct stubs first: the renderer calls a scattered handful of the
  // 180 declared members during bootstrap, and a missing one throws deep inside
  // its effects. Everything below overrides what is actually implemented.
  ...slidesApiStubs,
  ...commonApi(),

  consumePendingOpen: async (fitWidthPx: number): Promise<OpenResult | null> => {
    const path = await takePendingPath();
    if (!path) return null;
    try {
      return await loadSlides(path, fitWidthPx || 960);
    } catch (err) {
      console.error('[slides-shim] open failed:', err);
      throw err;
    }
  },

  /** GenOffice names this separately for the "open another file" path. */
  openPptxPath: async (path: string, fitWidthPx = 960): Promise<OpenResult | null> => {
    persistPendingPath(path);
    return loadSlides(path, fitWidthPx);
  },
  openPptx: async (fitWidthPx: number): Promise<OpenResult | null> => {
    const path = current?.path ?? (await takePendingPath());
    if (!path) return null;
    return loadSlides(path, fitWidthPx || 960);
  },
  /**
   * File > New: a blank deck has to live somewhere before it can be edited and
   * saved, so the host asks for a path first (upstream drops it in a drafts
   * folder; the panel has no such folder of its own).
   */
  newBlank: async (fitWidthPx: number, size?: { cx: number; cy: number }): Promise<OpenResult | null> => {
    const picked = await backend<{ path?: string | null }>('file.pickSavePath', {
      title: '新建演示文稿',
      defaultName: '演示文稿.pptx',
      filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
    });
    if (!picked?.path) return null;
    const fresh = await openPptxBytes(await createBlankPptx());
    const tmp = new SlideEditor(fresh, picked.path, fitWidthPx || 960, null);
    if (size) tmp.setSlideSize(size);
    const bytes = await tmp.toBytes();
    await backend('file.write', { path: picked.path, base64: toBase64(bytes) });
    return loadSlides(picked.path, fitWidthPx || 960);
  },
  onOpened: (h: (r: OpenResult | null) => void) => opened.on(h),

  // ── edits ───────────────────────────────────────────────────────────
  // Each returns the rebuilt slide; the renderer applies it to its own state.
  // The methods NOT listed here are still stubs — see editor.ts for why, and
  // for what adding one costs.
  editText: async (op: Parameters<SlideEditor['editText']>[0]) => current?.editText(op) ?? null,
  setElementFont: async (op: Parameters<SlideEditor['setElementFont']>[0]) =>
    current?.setElementFont(op) ?? null,
  setElementParagraphFormat: async (op: Parameters<SlideEditor['setElementParagraphFormat']>[0]) =>
    current?.setElementParagraphFormat(op) ?? null,
  editFill: async (op: Parameters<SlideEditor['editFill']>[0]) => current?.editFill(op) ?? null,
  editStroke: async (op: Parameters<SlideEditor['editStroke']>[0]) => current?.editStroke(op) ?? null,
  editImageFill: async (op: Parameters<SlideEditor['editImageFill']>[0]) =>
    (await current?.editImageFill(op)) ?? null,
  editConnectorEndpoints: async (op: Parameters<SlideEditor['editConnectorEndpoints']>[0]) =>
    current?.editConnectorEndpoints(op) ?? null,
  editTransform: async (op: Parameters<SlideEditor['editTransform']>[0]) =>
    current?.editTransform(op) ?? null,
  cancelTransformPreview: async (op: { slideIndex: number }) =>
    current?.cancelTransformPreview(op.slideIndex) ?? null,
  editTransformMulti: async (op: Parameters<SlideEditor['editTransformMulti']>[0]) =>
    current?.editTransformMulti(op) ?? null,
  batchEditTransform: async (op: Parameters<SlideEditor['batchEditTransform']>[0]) =>
    current?.batchEditTransform(op) ?? null,
  addElement: async (op: Parameters<SlideEditor['addElement']>[0]) => current?.addElement(op) ?? null,
  deleteElement: async (op: Parameters<SlideEditor['deleteElement']>[0]) =>
    current?.deleteElement(op) ?? null,
  deleteElements: async (op: Parameters<SlideEditor['deleteElements']>[0]) =>
    current?.deleteElements(op) ?? null,
  // ── arrange & shape ─────────────────────────────────────────────────
  flipElements: async (op: Parameters<SlideEditor['flipElements']>[0]) =>
    current?.flipElements(op) ?? null,
  groupElements: async (op: Parameters<SlideEditor['groupElements']>[0]) =>
    current?.groupElements(op) ?? null,
  ungroupElement: async (op: Parameters<SlideEditor['ungroupElement']>[0]) =>
    current?.ungroupElement(op) ?? null,
  reorderElement: async (op: Parameters<SlideEditor['reorderElement']>[0]) =>
    current?.reorderElement(op) ?? null,
  changeShape: async (op: Parameters<SlideEditor['changeShape']>[0]) =>
    current?.changeShape(op) ?? null,
  setShapeAdjust: async (op: Parameters<SlideEditor['setShapeAdjust']>[0]) =>
    current?.setShapeAdjust(op) ?? null,
  setShapeGeometry: async (op: Parameters<SlideEditor['setShapeGeometry']>[0]) =>
    current?.setShapeGeometry(op) ?? null,
  setTextAnchor: async (op: Parameters<SlideEditor['setTextAnchor']>[0]) =>
    current?.setTextAnchor(op) ?? null,
  setTextBodyProps: async (op: Parameters<SlideEditor['setTextBodyProps']>[0]) =>
    current?.setTextBodyProps(op) ?? null,
  setEffects: async (op: Parameters<SlideEditor['setEffects']>[0]) =>
    current?.setEffects(op) ?? null,
  // ── pictures ────────────────────────────────────────────────────────
  editPictureSrcRect: async (op: Parameters<SlideEditor['editPictureSrcRect']>[0]) =>
    current?.editPictureSrcRect(op) ?? null,
  editPictureOpacity: async (op: Parameters<SlideEditor['editPictureOpacity']>[0]) =>
    current?.editPictureOpacity(op) ?? null,
  addImageBytes: async (op: Parameters<SlideEditor['addImageBytes']>[0]) =>
    current?.addImageBytes(op) ?? null,
  replacePictureBytes: async (op: Parameters<SlideEditor['replacePictureBytes']>[0]) =>
    current?.replacePictureBytes(op) ?? null,
  addInk: async (op: Parameters<SlideEditor['addInk']>[0]) => current?.addInk(op) ?? null,
  pickPictureFile: async () => current?.pickPictureFile() ?? null,
  insertImage: async (slideIndex: number, fitWidthPx: number) =>
    current?.insertImage(slideIndex, fitWidthPx) ?? null,
  // ── media / 3D ──────────────────────────────────────────────────────
  insertMedia: async (slideIndex: number, kind: 'video' | 'audio', fitWidthPx: number) =>
    current?.insertMedia(slideIndex, kind, fitWidthPx) ?? null,
  addMediaBytes: async (op: Parameters<SlideEditor['addMediaBytes']>[0]) =>
    current?.addMediaBytes(op) ?? null,
  getMediaData: async (slideIndex: number, sourceId: string) =>
    current?.mediaData(slideIndex, sourceId) ?? null,
  pickModel3d: async () => current?.pickModel3d() ?? null,
  addModel3d: async (op: Parameters<SlideEditor['addModel3d']>[0]) => current?.addModel3d(op) ?? null,
  getModel3dData: async (slideIndex: number, sourceId: string) =>
    current?.model3dData(slideIndex, sourceId) ?? null,
  setModel3dView: async (op: Parameters<SlideEditor['setModel3dView']>[0]) =>
    current?.setModel3dView(op) ?? null,
  // The slide show runs in this page, so fullscreen is the page's own.
  setShowFullScreen: async (on: boolean) => {
    try {
      if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
      else if (!on && document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* requestFullscreen needs a user gesture; a refused call is not an error */
    }
  },
  // ── tables ──────────────────────────────────────────────────────────
  addTable: async (op: Parameters<SlideEditor['addTable']>[0]) => current?.addTable(op) ?? null,
  editTableCell: async (op: Parameters<SlideEditor['editTableCell']>[0]) =>
    current?.editTableCell(op) ?? null,
  tableMerge: async (op: Parameters<SlideEditor['tableMerge']>[0]) =>
    current?.tableMerge(op) ?? null,
  tableStructure: async (op: Parameters<SlideEditor['tableStructure']>[0]) =>
    current?.tableStructure(op) ?? null,
  setTableRowHeight: async (op: Parameters<SlideEditor['setTableRowHeight']>[0]) =>
    current?.setTableRowHeight(op) ?? null,
  setTableColWidth: async (op: Parameters<SlideEditor['setTableColWidth']>[0]) =>
    current?.setTableColWidth(op) ?? null,
  setTableCellAnchor: async (op: Parameters<SlideEditor['setTableCellAnchor']>[0]) =>
    current?.setTableCellAnchor(op) ?? null,
  editTableStyle: async (op: Parameters<SlideEditor['editTableStyle']>[0]) =>
    current?.editTableStyle(op) ?? null,
  // ── charts ──────────────────────────────────────────────────────────
  addChart: async (op: Parameters<SlideEditor['addChart']>[0]) => current?.addChart(op) ?? null,
  editChart: async (op: Parameters<SlideEditor['editChart']>[0]) => current?.editChart(op) ?? null,
  getChartColorSchemes: async () => current?.chartColorSchemes() ?? [],
  getChartData: async (slideIndex: number, sourceId: string) =>
    current?.getChartData(slideIndex, sourceId) ?? null,
  addSmartArt: async (op: Parameters<SlideEditor['addSmartart']>[0]) =>
    current?.addSmartart(op) ?? null,
  // ── links ───────────────────────────────────────────────────────────
  setLink: async (op: Parameters<SlideEditor['setLink']>[0]) => current?.setLink(op) ?? null,
  getLink: async (slideIndex: number, sourceId: string) =>
    current?.getLink(slideIndex, sourceId) ?? null,
  getSlideLinks: async (slideIndex: number) => current?.getSlideLinks(slideIndex) ?? [],
  getRunLinks: async (slideIndex: number) => current?.getRunLinks(slideIndex) ?? [],
  // ── theme / header-footer ───────────────────────────────────────────
  applyTheme: async (op: Parameters<SlideEditor['applyTheme']>[0]) =>
    current?.applyTheme(op) ?? null,
  applyHeaderFooter: async (op: Parameters<SlideEditor['applyHeaderFooter']>[0]) =>
    current?.applyHeaderFooter(op) ?? null,
  getHeaderFooter: async (slideIndex: number) =>
    current?.getHeaderFooter(slideIndex) ?? { footer: null, slideNum: false, date: null },
  // ── transitions / animations ────────────────────────────────────────
  setTransition: async (op: Parameters<SlideEditor['setTransition']>[0]) =>
    current?.setTransition(op) ?? false,
  getTransition: async (slideIndex: number) => {
    await ensureLoaded();
    return current?.getTransition(slideIndex) ?? 'none';
  },
  getShowTiming: async (slideIndex: number) =>
    current?.getShowTiming(slideIndex) ?? { advanceMs: null, narrationIds: [] },
  setAdvanceTimes: async (op: Parameters<SlideEditor['setAdvanceTimes']>[0]) =>
    current?.setAdvanceTimes(op) ?? false,
  // ── narration ───────────────────────────────────────────────────────
  saveRecording: async (op: Parameters<SlideEditor['saveRecording']>[0]) =>
    current?.saveRecording(op) ?? null,
  clearNarration: async (slideIndexes: number[]) => current?.clearNarration(slideIndexes) ?? null,
  // getUserMedia asks the OS itself; there is no Electron permission gate here.
  microphoneAccess: async () => true,
  getAnimations: async (slideIndex: number) => {
    await ensureLoaded();
    return current?.getAnimations(slideIndex) ?? [];
  },
  setAnimations: async (op: Parameters<SlideEditor['setAnimations']>[0]) =>
    current?.setAnimations(op) ?? false,
  getShapeKeys: async (slideIndex: number) => {
    await ensureLoaded();
    return current?.getShapeKeys(slideIndex) ?? [];
  },
  setSlideHidden: async (op: Parameters<SlideEditor['setHidden']>[0]) =>
    current?.setHidden(op) ?? null,
  // ── clipboard ───────────────────────────────────────────────────────
  copyElements: async (op: Parameters<SlideEditor['copyElements']>[0]) =>
    current?.copyElements(op) ?? 0,
  // The panel cannot write the system clipboard's custom flavours; the internal
  // copy is the contract, and the renderer treats a false here as "no image
  // rendering available", which is exactly true.
  copyElementsImage: async () => false,
  pasteElements: async (op: Parameters<SlideEditor['pasteElements']>[0]) =>
    current?.pasteElements(op) ?? null,
  duplicateElements: async (op: Parameters<SlideEditor['duplicateElements']>[0]) =>
    current?.duplicateElements(op) ?? null,
  clipboardExternal: async () =>
    (await current?.clipboardExternal()) ?? { kind: 'none' as const },
  clipboardProbe: async () => current?.clipboardProbe() ?? false,
  copySlides: async (op: Parameters<SlideEditor['copySlides']>[0]) =>
    current?.copySlides(op) ?? false,
  hasSlideClipboard: async () => current?.hasSlideClipboard() ?? false,
  pasteSlide: async (op: Parameters<SlideEditor['pasteSlide']>[0]) =>
    current?.pasteSlide(op) ?? null,
  repasteSlide: async (op: Parameters<SlideEditor['repasteSlide']>[0]) =>
    current?.repasteSlide(op) ?? null,
  // ── sections ────────────────────────────────────────────────────────
  setSections: async (sections: Parameters<SlideEditor['setSections']>[0]) =>
    current?.setSections(sections) ?? null,
  addSection: async (op: Parameters<SlideEditor['addSection']>[0]) =>
    current?.addSection(op) ?? null,
  renameSection: async (op: Parameters<SlideEditor['renameSection']>[0]) =>
    current?.renameSection(op) ?? null,
  removeSection: async (op: Parameters<SlideEditor['removeSection']>[0]) =>
    current?.removeSection(op) ?? null,
  removeSectionSlides: async (op: Parameters<SlideEditor['removeSectionSlides']>[0]) =>
    current?.removeSectionSlides(op) ?? null,
  // ── master editing ──────────────────────────────────────────────────
  masterEnter: async (fitWidthPx: number) => current?.masterEnter(fitWidthPx) ?? null,
  masterOpen: async (partPath: string) => current?.masterOpen(partPath) ?? null,
  masterClose: async () => current?.masterClose() ?? null,
  masterEditText: async (op: Parameters<SlideEditor['masterEditText']>[0]) =>
    current?.masterEditText(op) ?? null,
  masterEditTransform: async (op: Parameters<SlideEditor['masterEditTransform']>[0]) =>
    current?.masterEditTransform(op) ?? null,
  masterEditFill: async (op: Parameters<SlideEditor['masterEditFill']>[0]) =>
    current?.masterEditFill(op) ?? null,
  masterEditStroke: async (op: Parameters<SlideEditor['masterEditStroke']>[0]) =>
    current?.masterEditStroke(op) ?? null,
  masterDeleteElement: async (op: Parameters<SlideEditor['masterDeleteElement']>[0]) =>
    current?.masterDeleteElement(op) ?? null,
  masterAddElement: async (op: Parameters<SlideEditor['masterAddElement']>[0]) =>
    current?.masterAddElement(op) ?? null,
  // ── slide structure & document settings ─────────────────────────────
  addSlide: async (op: Parameters<SlideEditor['addSlide']>[0]) => current?.addSlide(op) ?? null,
  addBlankSlide: async (op: Parameters<SlideEditor['addBlankSlide']>[0]) =>
    current?.addBlankSlide(op) ?? null,
  addSlideWithLayout: async (op: Parameters<SlideEditor['addSlideWithLayout']>[0]) =>
    current?.addSlideWithLayout(op) ?? null,
  getLayouts: async () => current?.getLayouts() ?? null,
  deleteSlide: async (slideIndex: number) => current?.deleteSlide(slideIndex) ?? null,
  deleteSlides: async (op: Parameters<SlideEditor['deleteSlides']>[0]) =>
    current?.deleteSlides(op) ?? null,
  duplicateSlides: async (op: Parameters<SlideEditor['duplicateSlides']>[0]) =>
    current?.duplicateSlides(op) ?? null,
  moveSlide: async (op: Parameters<SlideEditor['moveSlide']>[0]) => current?.moveSlide(op) ?? null,
  moveSlides: async (op: Parameters<SlideEditor['moveSlides']>[0]) =>
    current?.moveSlides(op) ?? null,
  setSlidesHidden: async (op: Parameters<SlideEditor['setSlidesHidden']>[0]) =>
    current?.setSlidesHidden(op) ?? null,
  setSlideSize: async (op: Parameters<SlideEditor['setSlideSize']>[0]) =>
    current?.setSlideSize(op) ?? null,
  getSlideSize: async () => current?.getSlideSize() ?? null,
  setSlideLayout: async (op: Parameters<SlideEditor['setSlideLayout']>[0]) =>
    current?.setSlideLayout(op) ?? null,
  getSections: async () => current?.getSections() ?? [],
  getNotes: async (slideIndex: number) => current?.getNotes(slideIndex) ?? '',
  setNotes: async (op: Parameters<SlideEditor['setNotes']>[0]) => current?.setNotes(op) ?? false,
  getComments: async (slideIndex: number) => current?.getComments(slideIndex) ?? [],
  addComment: async (op: Parameters<SlideEditor['addComment']>[0]) =>
    current?.addComment(op) ?? null,
  deleteComment: async (op: Parameters<SlideEditor['deleteComment']>[0]) =>
    current?.deleteComment(op) ?? null,
  findReplace: async (op: Parameters<SlideEditor['findReplace']>[0]) =>
    current?.findReplace(op) ?? { count: 0, update: null },
  editBackground: async (op: Parameters<SlideEditor['editBackground']>[0]) =>
    (await current?.editBackground(op)) ?? null,
  undo: async (): Promise<RenderSlide[] | null> => current?.undo() ?? null,
  redo: async (): Promise<RenderSlide[] | null> => current?.redo() ?? null,
  getRenderSlides: async (): Promise<RenderSlide[]> => {
    await ensureLoaded();
    return current?.rebuildAll() ?? [];
  },
  isDirty: async (): Promise<boolean> => current?.dirty ?? false,
  // Dirty is derived from the editor's history depth (its save point), so a
  // renderer-side "I'm dirty" claim cannot be adopted without a step to match.
  setDirty: () => undefined,
  onHistoryChanged: (h: (state: { canUndo: boolean; canRedo: boolean }) => void) => history.on(h),

  // ── save ────────────────────────────────────────────────────────────
  save: async () => {
    const editor = current;
    if (!editor) return { ok: false, error: '没有打开的演示文稿' };
    try {
      const bytes = await editor.toBytes();
      const written = await backend<{ mtime?: number }>('file.write', {
        path: editor.path,
        base64: toBase64(bytes),
        // Compare-and-swap against the bytes this deck was parsed from: a file
        // rewritten since (an agent edit, another app) refuses the save instead
        // of clobbering it.
        ...(editor.mtime !== null ? { expectedMtime: editor.mtime } : {}),
      });
      const slides = editor.markSaved(typeof written?.mtime === 'number' ? written.mtime : editor.mtime);
      return { ok: true, path: editor.path, slides };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The host's conflict message is precise but English and written for
      // tools; the toast is read by a person who needs to know what to do next.
      return {
        ok: false,
        error: /conflict/i.test(message)
          ? '文件已被其他程序修改（可能是 AI 的编辑），请重新加载文件后再保存'
          : message,
      };
    }
  },
  /**
   * Save As: the host owns the picker, the panel owns the bytes. The editor is
   * rebound to the new path so later saves and conflict checks target the copy.
   */
  saveAs: async (defaultName: string) => {
    const editor = current;
    if (!editor) return { ok: false, error: '没有打开的演示文稿' };
    try {
      const picked = await backend<{ path?: string | null }>('file.pickSavePath', {
        defaultName,
        filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
      });
      if (!picked?.path) return { ok: false, error: '已取消' };
      const bytes = await editor.toBytes();
      const written = await backend<{ mtime?: number }>('file.write', {
        path: picked.path,
        base64: toBase64(bytes),
      });
      const slides = editor.relocate(
        picked.path,
        typeof written?.mtime === 'number' ? written.mtime : null,
      );
      return { ok: true, path: picked.path, slides };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  // ── print / export: the host owns dialogs ───────────────────────────
  exportPdf: async (op: Parameters<SlideEditor['exportPdf']>[0]) =>
    (await current?.exportPdf(op)) ?? { ok: false, error: '没有打开的演示文稿' },
  printSlides: async (op: Parameters<SlideEditor['printSlides']>[0]) =>
    (await current?.printSlides(op)) ?? { ok: false, error: '没有打开的演示文稿' },
  pickExportDir: async () => (await current?.pickExportDir()) ?? null,
  pickExportPdfPath: async (defaultName: string) =>
    (await current?.pickExportPdfPath(defaultName)) ?? null,
  exportImages: async (op: Parameters<SlideEditor['exportImages']>[0]) =>
    (await current?.exportImages(op)) ?? { ok: false, error: '没有打开的演示文稿' },
  savePicture: async (op: Parameters<SlideEditor['savePicture']>[0]) =>
    (await current?.savePicture(op)) ?? { ok: false },
  consumeHeadlessExport: async () => null,
  headlessExportDone: () => undefined,

  // ── lifecycle ───────────────────────────────────────────────────────
  // Auto-save is a per-viewer preference; localStorage is enough (it is a
  // convenience, not document state).
  getAutoSaveDefault: async () => {
    try {
      const raw = localStorage.getItem('pi.slides.autoSave');
      return raw === null ? { on: false, updatedAt: 0 } : { on: raw === '1', updatedAt: 1 };
    } catch {
      return { on: false, updatedAt: 0 };
    }
  },
  setAutoSavePref: (on: boolean) => {
    try {
      localStorage.setItem('pi.slides.autoSave', on ? '1' : '0');
    } catch {
      /* storage disabled */
    }
  },
  nativeClipboard: async (op: 'cut' | 'copy' | 'paste') => {
    // Text-editing context menus: the page's own clipboard commands. `paste` is
    // blocked by Chromium for script; it degrades to the keyboard shortcut.
    try {
      document.execCommand(op);
    } catch {
      /* not available */
    }
  },
  // ── presenter view / audience window ───────────────────────────────
  presenterStart: async (): Promise<{ audience: boolean }> => {
    const url = new URL(location.href);
    url.searchParams.set('mode', 'audience');
    if (current?.path) url.searchParams.set('piOpen', current.path);
    // A reused window keeps the name; a fresh one announces itself over the
    // channel. Either way the answer is "did an audience appear" — Electron
    // hands the page null from window.open here.
    window.open(url.toString(), `pi-audience-${Date.now().toString(36)}`, 'width=1280,height=720');
    const deadline = Date.now() + 1500;
    while (!audienceSeen && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { audience: audienceSeen };
  },
  presenterSync: (state: ShowSyncState) => {
    lastShowSync = state;
    showChannel?.postMessage({ type: 'pi-show-sync', state });
  },
  presenterInk: (ev: ShowInkEvent) => {
    showChannel?.postMessage({ type: 'pi-show-ink', ink: ev });
  },
  // A panel cannot move windows between displays; the user drags the audience
  // window to the projector instead.
  presenterSwap: async () => false,
  presenterEnd: async () => {
    showChannel?.postMessage({ type: 'pi-close' });
    audienceWindow?.close();
    audienceWindow = null;
    audienceSeen = false;
    lastShowSync = null;
  },
  audienceReady: async (): Promise<ShowSyncState | null> => {
    showChannel?.postMessage({ type: 'pi-audience-ready' });
    return lastShowSync;
  },
  audienceNav: (action: AudienceNavAction) => {
    showChannel?.postMessage({ type: 'pi-audience-nav', action });
  },
  onShowSync: (h: (state: ShowSyncState) => void) => showSync.on(h),
  onShowInk: (h: (ev: ShowInkEvent) => void) => showInk.on(h),
  onAudienceNav: (h: (action: AudienceNavAction) => void) => audienceNav.on(h),
  getRecentFiles: async () => readRecent(),

  onCloseSaveRequest: () => () => undefined,
  reportCloseSaveResult: () => undefined,
  onOpenedFile: () => () => undefined,
  saveStyleSidecar: async () => ({ ok: false }),
  saveStyleTemplate: async () => ({ ok: false }),
};

// `window.slidesApi` is what GenOffice's slides renderer reads.
// Assigned through a cast rather than a `declare global` of our own: GenOffice's
// slides app declares `window.slidesApi: SlidesApi` itself (shared/ipc.ts and
// renderer/env.d.ts), and merging a second declaration whose modifier differs is
// a hard error (TS2687) — as would restating the type (TS2717).
(window as unknown as { slidesApi: Record<string, unknown> }).slidesApi = api;
