/**
 * `window.pdfApi` — the preload API GenOffice's pdf renderer is written against.
 *
 * GenOffice splits this app differently from the others: the renderer owns the
 * *interactions* (annotations, selections, page ops are all collected as a
 * `SavePdfRequest`) and hands the whole batch to main, which does the PDF
 * surgery with pdf-lib. So `save(request)` is the one method that matters, and
 * it is a batch — not a byte stream.
 *
 * That batch is what makes this portable. `apps/pdf/src/main/save-pdf.ts` (1,027
 * lines) and `text-edit.ts` (2,513) are both pure TypeScript — they import
 * pdf-lib, node:fs and their own shared types, and no Electron. So the surgery
 * runs in the plugin BACKEND, which is a real Node process:
 *
 *   renderer → pdfApi.save(request) → plugin backend → save-pdf.ts → bytes → disk
 *
 * The alternative — reimplementing the markup application — would mean
 * reproducing a thousand lines whose whole point is matching what the renderer
 * drew, and any divergence shows up as a PDF that looks different from its
 * preview.
 *
 * Read path: `readFile(path)` returns raw bytes; the renderer paints them with
 * pdf.js itself.
 */

import {
  backend,
  commonApi,
  emitter,
  extOf,
  installThemeBridge,
  persistPendingPath,
  readPersistedPath,
  readDocument,
  reloadForOtherFormat,
} from '../shims/common';
import { pdfApiStubs } from './stubs';

const PDF_EXTS = ['pdf'];

// ── state ───────────────────────────────────────────────────────────────
let pendingPath: string | null = null;
let appBooted = false;
let currentPath: string | null = null;
const renamed = emitter<{ oldPath: string; newPath: string }>();

/** Baselines for the save path's conflict check, keyed by path. */
const openMtimes = new Map<string, number>();

/** Whole-file bytes, so the chunked reader fetches a document only once. */
const bytesByPath = new Map<string, Uint8Array>();

async function fileBytes(path: string): Promise<Uint8Array> {
  const cached = bytesByPath.get(path);
  if (cached) return cached;
  const doc = await readDocument(path);
  const bytes = new Uint8Array(doc.data);
  bytesByPath.set(path, bytes);
  if (doc.mtime !== null) openMtimes.set(path, doc.mtime);
  currentPath = path;
  return bytes;
}

installThemeBridge();

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
  if (reloadForOtherFormat(path, PDF_EXTS) === 'reloading') return;
  currentPath = path;
});

function takePendingPath(timeoutMs = 4000): Promise<string | null> {
  appBooted = true;
  if (pendingPath) {
    const p = pendingPath;
    pendingPath = null;
    currentPath = p;
    return Promise.resolve(p);
  }
  const injected = (window as unknown as { __PI_OPEN_PATH__?: string }).__PI_OPEN_PATH__;
  if (injected) {
    currentPath = injected;
    return Promise.resolve(injected);
  }
  const persisted = readPersistedPath();
  if (persisted) {
    currentPath = persisted;
    return Promise.resolve(persisted);
  }
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });
}

const api: Record<string, unknown> = {
  // Shape-correct stubs first — the renderer calls a scattered handful of the
  // 45 declared members during bootstrap. Everything below overrides the ones
  // that are implemented.
  ...pdfApiStubs,
  ...commonApi(),

  /** Which file this panel was opened for. */
  consumePending: async (): Promise<string | null> => takePendingPath(),

  /** Raw bytes. The renderer paints them with pdf.js; no parsing here. */
  readFile: async (path: string): Promise<ArrayBuffer> => {
    const bytes = await fileBytes(path);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  },

  /**
   * One slice of a file, with its size.
   *
   * GenOffice's reader loops over these instead of asking for one big
   * ArrayBuffer (a 42 MB clone over IPC could kill the renderer). The bytes are
   * fetched once and kept in this renderer, so the "chunks" stay cheap without
   * a second IPC route into the plugin backend.
   */
  readFileChunk: async (
    path: string,
    start: number,
    end: number,
  ): Promise<{ data: Uint8Array; fileSize: number }> => {
    const bytes = await fileBytes(path);
    return {
      data: bytes.slice(Math.max(0, start), Math.max(0, end)),
      fileSize: bytes.byteLength,
    };
  },

  isUntitled: async (path: string) => !path || path.endsWith('/未命名.pdf'),

  autoRename: async (path: string) => ({ renamed: false, path }),

  /**
   * Write a batch of edits back.
   *
   * The renderer has already staged everything into `request`; the plugin
   * backend applies it with GenOffice's own `save-pdf.ts`. The base64 hop is
   * the only concession — `SavePdfRequest` is JSON-shaped by design, so it
   * crosses the plugin port as-is.
   *
   * `targetPath` (Save As) is refused rather than silently ignored: writing to
   * the original while the user asked for a copy is the one failure mode here
   * that destroys data.
   */
  save: async (request: Record<string, unknown>): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const path = String(request?.path ?? currentPath ?? '');
    if (!path) return { ok: false, error: '没有打开的 PDF' };
    if (request?.targetPath) {
      return { ok: false, error: '另存为需要宿主的保存对话框能力，尚未接入' };
    }
    try {
      const res = await backend<{ ok: boolean; error?: string; mtime?: number }>('pdf.save', {
        ...request,
        path,
        expectedMtime: openMtimes.get(path),
      });
      // Re-baseline: `filesystem.write` compares against the mtime read at open,
      // so without this the second save reports a conflict against our own write.
      if (typeof res?.mtime === 'number') openMtimes.set(path, res.mtime);
      // The cached copy is the pre-edit file; the next open must re-read it.
      bytesByPath.delete(path);
      return res?.ok ? { ok: true, path } : { ok: false, error: res?.error ?? '保存失败' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  // The shell owns rename/print/Save-As flows; a plugin panel has no such
  // parent, so these register nothing rather than pretending to.
  onFileRenamed: () => () => undefined,
  onSaveAsRequest: () => () => undefined,
  sendSaveAsResult: () => undefined,
  onSaveAsFlow: () => () => undefined,
  onPrintRequest: () => () => undefined,
  requestRedactionCopy: async () => ({ ok: false, error: '密文副本需要宿主的保存对话框能力' }),
};

// Assigned through a cast rather than a `declare global` of our own, matching
// the other shims: the app declares its own `window.pdfApi`, and a second
// declaration that disagrees on the modifier or the type is a hard error
// (TS2687 / TS2717).
(window as unknown as { pdfApi: Record<string, unknown> }).pdfApi = api;
