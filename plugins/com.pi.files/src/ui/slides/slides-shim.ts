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

import { openPptx as openPptxBytes } from '@genoffice/pptx-engine';
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
  undo: async (): Promise<RenderSlide[] | null> => current?.undo() ?? null,
  redo: async (): Promise<RenderSlide[] | null> => current?.redo() ?? null,
  getRenderSlides: async (): Promise<RenderSlide[]> => current?.rebuildAll() ?? [],
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
  saveAs: async (defaultName: string) => ({
    ok: false,
    error: `另存为需要宿主的保存对话框能力，尚未接入（${defaultName}）`,
  }),

  // ── print / export: the host owns dialogs ───────────────────────────
  exportPdf: async () => ({ ok: false, error: 'PDF 导出尚未接入宿主' }),
  printSlides: async () => ({ ok: false, error: '打印尚未接入宿主' }),
  pickExportDir: async () => null,
  pickExportPdfPath: async () => null,
  exportImages: async () => ({ ok: false, error: '导出图片尚未接入宿主' }),
  consumeHeadlessExport: async () => null,
  headlessExportDone: () => undefined,

  // ── lifecycle ───────────────────────────────────────────────────────
  onCloseSaveRequest: () => () => undefined,
  reportCloseSaveResult: () => undefined,
  onOpenedFile: () => () => undefined,
  masterOpen: async () => undefined,
  masterClose: async () => undefined,
  audienceReady: () => undefined,
  saveStyleSidecar: async () => ({ ok: false }),
  saveStyleTemplate: async () => ({ ok: false }),
};

// `window.slidesApi` is what GenOffice's slides renderer reads.
// Assigned through a cast rather than a `declare global` of our own: GenOffice's
// slides app declares `window.slidesApi: SlidesApi` itself (shared/ipc.ts and
// renderer/env.d.ts), and merging a second declaration whose modifier differs is
// a hard error (TS2687) — as would restating the type (TS2717).
(window as unknown as { slidesApi: Record<string, unknown> }).slidesApi = api;
