/**
 * The editable half of the slides panel — GenOffice's edit path, without Electron.
 *
 * Upstream keeps this in its main process (`apps/slides/src/main/slides-main.ts`,
 * 155 IPC handlers, plus `session-state.ts` for the undo journal). A panel has no
 * main process, so this module is the equivalent: it owns the parsed deck, applies
 * the canonical ops from `@genoffice/pptx-ops` to it, and hands back the single
 * `RenderSlide` the renderer expects from every edit call.
 *
 * Two lanes need no main process at all: a structural edit returns a
 * `SlideUpdate` (order + the render trees that changed) which the renderer
 * merges by part path, and undo/redo return the whole deck.
 *
 * Wired: text/font/paragraph format, fill/stroke, transform, add/delete/group/
 * flip/reorder, inserts (table/chart/SmartArt/picture/audio-video/3D), table &
 * chart editing, background, slide size/layout, slide CRUD/reorder/hidden,
 * notes, comments, find/replace, links, theme, header/footer, transitions,
 * animations, narration, clipboard (in-panel), sections, master editing, save /
 * save-as, fullscreen show.
 * Export/print are wired too, with two known deltas from upstream: the PDF is
 * assembled from 2× page rasters (no vector text, no link annotations), and
 * printing always goes through the system dialog (no silent printer jobs).
 * Font management and the AI surfaces stay out: the panel has no system font
 * scan, and the host agent replaces GenOffice's AI panel entirely.
 *
 * Text metrics are the panel's one deliberate shortcut: upstream injects exact
 * metrics by parsing system font files, while the panel renders with
 * `HeuristicMetrics`. The autofit write-back uses the same provider, so the
 * model and the render agree with each other even when both differ from
 * PowerPoint by a hair.
 */
import {
  BUILTIN_LAYOUT_PREFIX,
  builtinLayoutInfos,
  copyElementData,
  copySlide,
  editChartElement,
  elementSpid,
  ensureBuiltinLayout,
  findGroupChild,
  getChartElementData,
  getElementLink,
  getRunLinks,
  getSections,
  getSlideAdvanceTime,
  getSlideAnimations,
  getSlideComments,
  getSlideLinks,
  getSlideNotes,
  getSlideTransition,
  listMasterParts,
  listSlideLayouts,
  materializeSlide,
  matchesElementRef,
  narrationSpids,
  normalizeSections,
  parseMasterPart,
  parseTheme,
  patchBodyPrAutofit,
  readHeaderFooter,
  reparseDeck,
  savePptx,
  shouldOfferBuiltinLayouts,
  type OpenedPptx,
  type Slide,
  type SlideBundle,
  type SlideElement,
  type TextElement,
} from '@genoffice/pptx-engine';
import {
  EMU_PER_PT,
  EMU_PER_PX_96,
  HeuristicMetrics,
  buildRenderSlide,
  imageDpiFromBytes,
  layoutText,
  makeViewport,
  type MediaResolver,
  type RenderSlide,
  type RenderTextLayout,
} from '@genoffice/pptx-render';
import { resolveGroupChildId, runTxn, type Op } from '@genoffice/pptx-ops';
import { safeExternalUrl } from '../docx/shims/electron-utils';
import { DECK_LINK_PROTOCOLS } from '../../../vendor/genoffice/apps/slides/src/shared/run-link';
import { newPasteCascade, pageKey, pasteShiftPx, recordPaste } from '../../../vendor/genoffice/apps/slides/src/main/paste-cascade';
import { audioFrame, videoFrame, videoSize } from '../../../vendor/genoffice/apps/slides/src/main/video-size';
import { planSlideDuplicates, planSlideMoves } from '../../../vendor/genoffice/apps/slides/src/shared/slide-selection';
import { backend, wsFileUrl } from '../shims/common';
import type {
  AddBlankSlideOp,
  AddChartOp,
  AddCommentOp,
  AddElementOp,
  AddSectionOp,
  AddImageBytesOp,
  AddInkOp,
  AddMediaBytesOp,
  AddModel3dOp,
  AddSlideOp,
  AddSlideWithLayoutOp,
  AddSmartArtOp,
  AddTableOp,
  AnimationItem,
  ApplyThemeOp,
  BatchEditTransformOp,
  CopyElementsOp,
  CopySlidesOp,
  DeleteCommentOp,
  DeleteElementOp,
  DeleteElementsOp,
  DeleteSlidesOp,
  DuplicateElementsOp,
  DuplicateSlidesOp,
  EditBackgroundOp,
  EditChartOp,
  EditConnectorEndpointsOp,
  EditFillImageOp,
  EditFillOp,
  EditPictureOpacityOp,
  EditPictureSrcRectOp,
  EditStrokeOp,
  EditTableCellOp,
  EditTableStyleOp,
  EditTextOp,
  EditTransformMultiOp,
  EditTransformOp,
  ExportImagesOp,
  ExportImagesResult,
  ExportPdfOp,
  ExportPdfPage,
  ExportPdfResult,
  FindReplaceOp,
  FlipElementOp,
  GetLayoutsResult,
  GradientFillSpec,
  GroupElementsOp,
  HeaderFooterOp,
  MasterAddElementOp,
  MasterDeleteElementOp,
  MasterEditFillOp,
  MasterEditStrokeOp,
  MasterEditTextOp,
  MasterEditTransformOp,
  MasterEnterResult,
  MoveSlideOp,
  MoveSlidesOp,
  PasteElementsOp,
  PasteSlideOp,
  PasteSlideResult,
  PrintSlidesOp,
  RemoveSectionOp,
  RemoveSectionSlidesOp,
  RenameSectionOp,
  RepasteSlideOp,
  ReorderElementOp,
  ReplacePictureBytesOp,
  SectionInfo,
  SetAdvanceTimesOp,
  SetAnimationsOp,
  SetElementFontOp,
  SetElementParagraphFormatOp,
  SetLinkOp,
  SetModel3dViewOp,
  SavePictureOp,
  SavePictureResult,
  SaveRecordingOp,
  SetNotesOp,
  SetShapeGeometryOp,
  SetSlideHiddenOp,
  SetSlideLayoutOp,
  SetSlideSizeOp,
  SetSlidesHiddenOp,
  SetTableCellAnchorOp,
  SetTableColWidthOp,
  SetTableRowHeightOp,
  SetTransitionOp,
  ShapeKey,
  ShowTiming,
  SlideUpdate,
  TableMergeIpcOp,
  TableStructureIpcOp,
  UngroupElementOp,
} from '../../../vendor/genoffice/apps/slides/src/shared/ipc';

const MAX_HISTORY = 50;

/**
 * Comment author name. Upstream reads Settings → General, falling back to the OS
 * account; the panel has neither, and an empty author renders as a blank card.
 */
const COMMENT_AUTHOR = '我';

/** Read a file through the plugin's own file origin (the panel cannot touch disk). */
async function readFileBytes(path: string): Promise<Uint8Array> {
  const res = await fetch(wsFileUrl(path));
  if (!res.ok) throw new Error(`cannot read ${path}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** PowerPoint's default theme accent sequence (fallback when the deck has no theme). */
const FALLBACK_ACCENTS = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];

/** Named chart palettes for the "change colors" presets. */
const CHART_COLOR_SCHEMES: Record<string, string[]> = {
  default: [],
  blue: ['#2E75B6', '#4472C4', '#5B9BD5', '#70AD47', '#ED7D31'],
  warm: ['#ED7D31', '#FFC000', '#FF0000', '#C55A11', '#833C00'],
  cool: ['#0070C0', '#00B0F0', '#00B0A0', '#7030A0', '#2E75B6'],
  mono: ['#404040', '#666666', '#888888', '#AAAAAA', '#CCCCCC'],
};

/** Mix a hex colour with black/white by ratio (mono gradient steps). */
function mixHex(hex: string, target: number, ratio: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1]!, 16);
  const ch = (x: number): number => Math.round(x + (target - x) * ratio);
  const r = ch((v >> 16) & 255);
  const g = ch((v >> 8) & 255);
  const b = ch(v & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase()}`;
}

/** The same heuristic provider `buildRenderSlide` defaults to — used for autofit re-layout. */
const HEURISTIC_METRICS = new HeuristicMetrics();

/**
 * PowerPoint for Mac lays untagged bitmaps out at 2 px per point; Windows at
 * 96 dpi. Upstream reads `process.platform`; the panel has no process, so the
 * platform comes from the user agent.
 */
const DEFAULT_PICTURE_DPI =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent)
    ? 144
    : 96;

/** Measured cap: every oversize landscape picture came in exactly 8.5 in wide. */
const OVERSIZE_FIT_WIDTH_EMU = 612 * 12700;

/**
 * PowerPoint placement for an inserted picture: physical size from the pixel
 * grid and the declared dpi, shrunk (never enlarged) to fit min(8.5in, slide
 * width) by slide height, centred on the slide or the drop point.
 *
 * A local port of upstream's `main/picture-frame.ts`: that module reads
 * `process.platform` at import time, which the panel bundle does not have.
 */
function pictureFrame(
  slide: { width: number; height: number },
  naturalPx: { width: number; height: number } | null,
  dpi: { x: number; y: number } | undefined,
  fallbackDpi = DEFAULT_PICTURE_DPI,
  { center, minEmu = 0 }: { center?: { x: number; y: number }; minEmu?: number } = {},
): { x: number; y: number; cx: number; cy: number } {
  const boxW = Math.min(slide.width, OVERSIZE_FIT_WIDTH_EMU);
  const known = naturalPx !== null && naturalPx.width > 0 && naturalPx.height > 0;
  const w = known ? (naturalPx.width / (dpi?.x ?? fallbackDpi)) * 72 * 12700 : boxW;
  const h = known
    ? (naturalPx.height / (dpi?.y ?? fallbackDpi)) * 72 * 12700
    : (boxW * 3) / 4;
  const fit = Math.min(boxW / w, slide.height / h);
  let scale = Math.min(1, fit);
  const smaller = Math.min(w, h) * scale;
  if (smaller < minEmu) scale = Math.min(fit, (scale * minEmu) / smaller);
  const cx = Math.round(w * scale);
  const cy = Math.round(h * scale);
  const c = center ?? { x: slide.width / 2, y: slide.height / 2 };
  return { x: Math.round(c.x - cx / 2), y: Math.round(c.y - cy / 2), cx, cy };
}



/** Rasterize one PDF page (SVG or PNG) at 2× the layout size, as base64 PNG. */
async function rasterizePage(
  page: ExportPdfPage,
  widthPx: number,
  heightPx: number,
): Promise<string> {
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(widthPx * scale));
  canvas.height = Math.max(1, Math.round(heightPx * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  const src =
    'png' in page
      ? `data:image/png;base64,${page.png}`
      // A data: URL avoids blob lifetime bookkeeping, and encodeURIComponent keeps
      // non-ASCII text intact (btoa alone throws on it).
      : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(page.svg)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('a page failed to decode'));
    img.src = src;
  });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png').split(',')[1] ?? '';
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The print document. Full pages keep the slide's own size (one page per
 * slide); handouts and notes use A4 with the chosen orientation. The system
 * dialog that follows is Chromium's, so paper choice lives there.
 */
function printHtml(op: PrintSlidesOp): string {
  const imgs = op.pngsBase64.map((b64) => `data:image/png;base64,${b64}`);
  const base = 'html,body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}';
  const layout = op.layout ?? 'full';
  if (layout === 'full') {
    const border = op.frame ? 'border:1px solid #999;box-sizing:border-box' : '';
    return `<!doctype html><meta charset="utf-8"><style>
      @page { size: ${op.widthPx}px ${op.heightPx}px; margin: 0 }
      ${base}
      .p{page-break-after:always;display:flex;align-items:center;justify-content:center;width:${op.widthPx}px;height:${op.heightPx}px;overflow:hidden}
      .p:last-child{page-break-after:auto}
      .p img{width:100%;height:100%;object-fit:contain;${border}}
    </style><body>${imgs.map((src) => `<div class="p"><img src="${src}"></div>`).join('')}</body>`;
  }
  const notes = layout === 'notes';
  const perPage = layout === 'handout2' ? 2 : layout === 'handout3' ? 3 : notes ? 1 : 6;
  const cols = perPage === 6 ? 2 : 1;
  const cells = imgs.map((src, i) =>
    notes
      ? `<div class="cell"><img src="${src}"><div class="notes">${escapeHtml(op.notes?.[i] ?? '')}</div></div>`
      : `<div class="cell"><img src="${src}"></div>`,
  );
  return `<!doctype html><meta charset="utf-8"><style>
    @page { size: A4 ${op.orientation ?? 'landscape'}; margin: 10mm }
    ${base}
    body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
    .grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:6mm;page-break-after:always}
    .grid:last-child{page-break-after:auto}
    .cell img{width:100%;display:block;border:1px solid #ddd}
    .notes{margin-top:4mm;font-size:11pt;line-height:1.5;white-space:pre-wrap}
  </style><body>${chunk(cells, perPage)
    .map((group) => `<div class="grid">${group.join('')}</div>`)
    .join('')}</body>`;
}

// ── clipboard state (module-level: it outlives editor instances on a file switch) ──
let elementClipboard: {
  items: Array<ReturnType<typeof copyElementData>>;
  cascade: ReturnType<typeof newPasteCascade>;
  token: string;
} | null = null;
let slideClipboard: { bundles: SlideBundle[]; pngs?: string[] } | null = null;
let lastSlidePaste: { afterIndex: number; undoLen: number; changed: number[] } | null = null;

function randomToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? String(Date.now());
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff'];
const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm'];
const AUDIO_EXTS = ['mp3', 'm4a', 'wav', 'ogg', 'aac'];

/** Container → MIME for playback; mirrors upstream's AV_MIME (mov is served as mp4). */
const AV_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
};

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Ask the host for a file path (the panel cannot open dialogs itself). */
async function pickFile(title: string, extensions: string[]): Promise<string | null> {
  const picked = await backend<{ path?: string | null }>('file.pickFile', {
    title,
    filters: [{ name: title, extensions }],
  });
  return picked?.path ?? null;
}

/** Natural pixel size of an image, decoded by the browser (null when it cannot). */
async function naturalSizeOf(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  emf: 'image/emf',
  wmf: 'image/wmf',
};

/** One undo step: the parts of the parsed deck that edits mutate. */
interface Snapshot {
  slides: Slide[];
  entries: Map<string, Uint8Array>;
  size: { cx: number; cy: number };
}

const cloneSnapshot = (snap: Snapshot): Snapshot => ({
  slides: structuredClone(snap.slides),
  entries: new Map(snap.entries),
  size: { ...snap.size },
});

/**
 * Resolve a media part to something the renderer can draw.
 *
 * Same rationale as the shim's original copy: `pptx-render` returns a URL string
 * that ends up in a Konva image, so embedded media has to become a data URL.
 */
function makeMediaResolver(opened: OpenedPptx): MediaResolver {
  const cache = new Map<string, string | undefined>();
  return (mediaRef: string): string | undefined => {
    if (cache.has(mediaRef)) return cache.get(mediaRef);
    let url: string | undefined;
    try {
      const bytes = opened.archive.readBytes(mediaRef);
      if (bytes) {
        const ext = (mediaRef.split('.').pop() ?? '').toLowerCase();
        const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        url = `data:${mime};base64,${btoa(bin)}`;
      }
    } catch (err) {
      console.warn('[slides-editor] media failed:', mediaRef, err);
    }
    cache.set(mediaRef, url);
    return url;
  };
}

/** Text/shape element by parse-time id, mirroring upstream's `findEl`. */
function findTextEl(slide: Slide, sourceId: string): TextElement | undefined {
  const el = slide.elements.find((e) => matchesElementRef(e, sourceId));
  if (el && (el.type === 'text' || el.type === 'shape')) return el as TextElement;
  return undefined;
}

/** Box width a nowrap body needs: widest laid-out line plus the insets. */
function nowrapContentWidth(text: RenderTextLayout): number {
  let left = Infinity;
  let right = -Infinity;
  for (const line of text.lines) {
    for (const run of line.runs) {
      left = Math.min(left, run.x);
      right = Math.max(right, run.x + run.widthPx);
    }
  }
  const content = right > left ? right - left : 0;
  return content + text.insets.l + text.insets.r;
}

/** IPC gradient → engine stop list (full stop list wins over the two-color form). */
const gradientStops = (g: GradientFillSpec['gradient']): Array<{ pos: number; color: string }> =>
  g.stops?.length
    ? g.stops
    : [
        { pos: 0, color: g.from },
        { pos: 1, color: g.to },
      ];

/** IPC gradient → path kind (radial is a legacy alias for circle; undefined = linear). */
const gradientPathKind = (
  g: GradientFillSpec['gradient'],
): 'circle' | 'rect' | 'shape' | undefined => g.path ?? (g.radial ? 'circle' : undefined);

/** IPC gradient focus point → <a:fillToRect> insets (undefined when unspecified). */
const gradientFillTo = (
  g: GradientFillSpec['gradient'],
): { l: number; t: number; r: number; b: number } | undefined =>
  g.center ? { l: g.center.x, t: g.center.y, r: 1 - g.center.x, b: 1 - g.center.y } : undefined;

export class SlideEditor {
  /** The file this deck is bound to; Save As rebinds it. */
  path: string;
  opened: OpenedPptx;
  fitWidthPx: number;
  /** mtime of the bytes this deck was parsed from — the save conflict baseline. */
  mtime: number | null;
  dirty = false;

  /** QAT undo/redo button state, pushed after every history change. */
  onHistoryChanged: (state: { canUndo: boolean; canRedo: boolean }) => void = () => undefined;
  onDirtyChanged: (dirty: boolean) => void = () => undefined;

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  /**
   * `undoStack.length` at the last save. Dirty is "the stack is not back at that
   * depth" rather than a one-way latch, so undoing every edit since the save
   * really does return the deck to clean (and lets an external reload proceed
   * again). -1 = the save point fell off the bottom of the history.
   */
  private cleanDepth = 0;
  /**
   * Built lazily and kept for the life of the editor: every rebuild would
   * otherwise re-encode each picture on the slide into a data URL, and rebuilds
   * happen on every committed edit. Invalidate this when the first image op
   * lands (addPicture / replacePicture / media fill) — those change the bytes
   * behind a media ref.
   */
  private media: MediaResolver | null = null;

  constructor(opened: OpenedPptx, path: string, fitWidthPx: number, mtime: number | null) {
    this.opened = opened;
    this.path = path;
    this.fitWidthPx = fitWidthPx;
    this.mtime = mtime;
  }

  // ── rendering ───────────────────────────────────────────────────────

  /** Rebuild one page exactly the way the initial load does. */
  rebuild(slideIndex: number): RenderSlide | null {
    const slide = this.opened.deck.slides[slideIndex];
    if (!slide) return null;
    return buildRenderSlide(slide, this.opened.deck.size, {
      fitWidthPx: this.fitWidthPx,
      media: (this.media ??= makeMediaResolver(this.opened)),
      slideNo: slideIndex + 1,
    });
  }

  rebuildAll(): RenderSlide[] {
    return this.opened.deck.slides
      .map((_, i) => this.rebuild(i))
      .filter((s): s is RenderSlide => s !== null);
  }

  // ── history ─────────────────────────────────────────────────────────

  private snapshot(): Snapshot {
    return {
      slides: structuredClone(this.opened.deck.slides),
      entries: new Map(this.opened.archive.entries),
      size: { ...this.opened.deck.size },
    };
  }

  private pushHistory(): void {
    this.undoStack.push(this.snapshot());
    while (this.undoStack.length > MAX_HISTORY) {
      this.undoStack.shift();
      // The save point slid off the bottom with it; the deck can no longer be
      // "back at the saved state", so there is nothing left to compare against.
      this.cleanDepth = Math.max(-1, this.cleanDepth - 1);
    }
    // A new edit invalidates the redo branch, as in every editor.
    this.redoStack = [];
  }

  private restore(snap: Snapshot): void {
    const fresh = cloneSnapshot(snap);
    this.opened.deck.slides = fresh.slides;
    this.opened.deck.size = fresh.size;
    const entries = this.opened.archive.entries;
    entries.clear();
    for (const [k, v] of fresh.entries) entries.set(k, v);
  }

  private notifyHistory(): void {
    this.onHistoryChanged({ canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 });
  }

  undo(): RenderSlide[] | null {
    const snap = this.undoStack.pop();
    if (!snap) return null;
    this.redoStack.push(this.snapshot());
    this.restore(snap);
    this.refreshDirty();
    this.notifyHistory();
    return this.rebuildAll();
  }

  redo(): RenderSlide[] | null {
    const snap = this.redoStack.pop();
    if (!snap) return null;
    this.undoStack.push(this.snapshot());
    this.restore(snap);
    this.refreshDirty();
    this.notifyHistory();
    return this.rebuildAll();
  }

  // ── dirty / save ────────────────────────────────────────────────────

  private refreshDirty(): void {
    const dirty = this.undoStack.length !== this.cleanDepth;
    if (dirty === this.dirty) return;
    this.dirty = dirty;
    this.onDirtyChanged(dirty);
  }

  /** The bytes to write. Also the point where save may re-mint element ids. */
  async toBytes(): Promise<Uint8Array> {
    return savePptx(this.opened);
  }

  /**
   * Called after the bytes landed on disk. Adopts the new mtime as the next save
   * baseline and returns the re-rendered deck — saving can rebuild element ids,
   * and the renderer has to adopt the ones now in the file.
   */
  markSaved(mtime: number | null): RenderSlide[] {
    this.mtime = mtime;
    this.cleanDepth = this.undoStack.length;
    this.refreshDirty();
    return this.rebuildAll();
  }

  /** Save As: this editor now owns the newly written file. */
  relocate(path: string, mtime: number | null): RenderSlide[] {
    this.path = path;
    return this.markSaved(mtime);
  }

  // ── edits ───────────────────────────────────────────────────────────

  /**
   * Apply one transaction. Returns false when nothing was applied — the op
   * registry validates as a batch, so a rejection means the deck is untouched.
   */
  private apply(ops: Op[], isolation: 'atomic' | 'per_op' = 'atomic'): boolean {
    return this.commit(ops, isolation, true).applied;
  }

  /**
   * The shared transaction path. `push` is false only for transform previews and
   * their commit, where the caller owns the one-snapshot-per-gesture bookkeeping
   * (see `editTransform`).
   */
  private commit(
    ops: Op[],
    isolation: 'atomic' | 'per_op',
    push: boolean,
  ): { applied: boolean; records?: Array<{ created?: string[] }>; failures?: Array<{ error: string }> } {
    if (push) this.pushHistory();
    const r = runTxn(this.opened, { ops, isolation });
    if (!r.applied) {
      if (push) this.undoStack.pop(); // nothing happened; a pushed snapshot would be an empty undo step
      if (r.failures?.length) {
        console.warn('[slides-editor] op rejected:', r.failures.map((f) => f.error).join('; '));
      }
    }
    this.refreshDirty();
    this.notifyHistory();
    return r;
  }

  editText(op: EditTextOp): RenderSlide | null {
    const ok = this.apply([
      {
        op: 'setText',
        target: { slide: op.slideIndex, el: op.sourceId },
        paragraphs: op.paragraphs,
        ...(op.groupId ? { group: op.groupId } : {}),
      },
    ]);
    if (!ok) return null;
    return this.applyAutofitResize(op.slideIndex, op.sourceId, this.rebuild(op.slideIndex));
  }

  setElementFont(op: SetElementFontOp): RenderSlide | null {
    const font = {
      fontFamily: op.fontFamily,
      fontSizePt: op.fontSizePt,
      fontSizeStep: op.fontSizeStep,
      strike: op.strike,
      bold: op.bold,
      italic: op.italic,
      underline: op.underline,
      color: op.color,
    };
    // per_op: a selection can mix text and pictures; the pictures fail their own
    // op and are skipped, matching upstream's "changed if any succeeded".
    const ok = this.apply(
      op.sourceIds.map((id) => ({
        op: 'setFont',
        target: { slide: op.slideIndex, el: id },
        font,
        ...(op.groupId ? { group: op.groupId } : {}),
      })),
      'per_op',
    );
    if (!ok) return null;
    let rendered = this.rebuild(op.slideIndex);
    for (const id of op.sourceIds) {
      rendered = this.applyAutofitResize(op.slideIndex, id, rendered);
    }
    return rendered;
  }

  /** Connector endpoint drag: the box is re-derived from the two endpoints. */
  editConnectorEndpoints(op: EditConnectorEndpointsOp): RenderSlide | null {
    const scale = op.fitWidthPx / (this.opened.deck.size.cx / EMU_PER_PX_96);
    const toEmu = (px: number): number => Math.round((px / scale) * EMU_PER_PX_96);
    const ok = this.apply([
      {
        op: 'setConnectorEndpoints',
        target: { slide: op.slideIndex, el: op.sourceId },
        p1: { x: toEmu(op.x1Px), y: toEmu(op.y1Px) },
        p2: { x: toEmu(op.x2Px), y: toEmu(op.y2Px) },
        start: op.start,
        end: op.end,
      },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  /**
   * Picture/texture fill: the picked bytes land as one media part; the other
   * targets only add a rel to it. One undo step for the whole selection.
   */
  async editImageFill(op: EditFillImageOp): Promise<RenderSlide | null> {
    const slide = this.opened.deck.slides[op.slideIndex];
    if (!slide || op.targets.length === 0) return null;
    let bytes: Uint8Array;
    let ext: string;
    if (op.source) {
      bytes = base64ToBytes(op.source.base64);
      ext = op.source.ext.toLowerCase();
    } else {
      const filePath = await pickFile('插入图片', IMAGE_EXTS);
      if (!filePath) return null;
      bytes = await readFileBytes(filePath);
      ext = filePath.split('.').pop()!.toLowerCase();
    }
    this.pushHistory();
    let landed: string | null = null;
    let applied = 0;
    for (const target of op.targets) {
      const r = runTxn(this.opened, {
        ops: [
          {
            op: 'setImageFill',
            target: { slide: op.slideIndex, el: target.sourceId },
            source: landed ? { mediaPath: landed } : { bytes, ext },
            tile: op.mode === 'tile',
            ...(target.groupId ? { group: target.groupId } : {}),
          },
        ],
      });
      if (r.applied) {
        applied += 1;
        const used = (r.records?.[0]?.after as { mediaPath?: string } | undefined)?.mediaPath;
        if (used) landed = used;
      }
    }
    if (!applied) {
      this.undoStack.pop();
      this.refreshDirty();
      this.notifyHistory();
      return null;
    }
    this.refreshDirty();
    this.notifyHistory();
    return this.rebuild(op.slideIndex);
  }

  editFill(op: EditFillOp): RenderSlide | null {
    const fill =
      typeof op.fill === 'string'
        ? op.fill
        : {
            stops: gradientStops(op.fill.gradient),
            ...((pk) =>
              pk
                ? {
                    path: pk,
                    ...((ft) => (ft ? { fillTo: ft } : {}))(gradientFillTo(op.fill.gradient)),
                  }
                : { angle: Math.round((op.fill.gradient.angleDeg ?? 0) * 60000) })(
              gradientPathKind(op.fill.gradient),
            ),
          };
    const ok = this.apply([
      {
        op: 'setFill',
        target: { slide: op.slideIndex, el: op.sourceId },
        fill,
        ...(op.groupId ? { group: op.groupId } : {}),
      },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  setElementParagraphFormat(op: SetElementParagraphFormatOp): RenderSlide | null {
    const format = {
      bullet: op.bullet,
      bulletChar: op.bulletChar,
      bulletFont: op.bulletFont,
      numType: op.numType,
      startAt: op.startAt,
      bulletImage: op.bulletImage,
      bulletHangEmu: op.bulletHangEmu,
      bulletSizePct: op.bulletSizePct,
      bulletColor: op.bulletColor,
      lineSpacingPct: op.lineSpacingPct,
      spaceBeforePt: op.spaceBeforePt,
      spaceAfterPt: op.spaceAfterPt,
      align: op.align,
      rtl: op.rtl,
      indentDelta: op.indentDelta,
    };
    // Same per_op selection semantics as setFont: non-text elements fail their
    // own op and are skipped.
    const ok = this.apply(
      op.sourceIds.map((id) => ({
        op: 'setParagraphFormat',
        target: { slide: op.slideIndex, el: id },
        format,
        ...(op.groupId ? { group: op.groupId } : {}),
      })),
      'per_op',
    );
    if (!ok) return null;
    if (op.indentDelta) {
      // Level changes affect inherited defaults; bake into bytes then reparse.
      materializeSlide(this.opened, op.slideIndex);
      return this.rebuild(op.slideIndex);
    }
    let rendered = this.rebuild(op.slideIndex);
    for (const id of op.sourceIds) {
      rendered = this.applyAutofitResize(op.slideIndex, id, rendered);
    }
    return rendered;
  }

  editStroke(op: EditStrokeOp): RenderSlide | null {
    // pt→EMU and deg→60000ths are surface translation; the op owns the rest.
    const patch = op.stroke
      ? {
          color: op.stroke.color,
          widthEmu: Math.round(op.stroke.widthPt * EMU_PER_PT),
          ...(op.stroke.dash ? { dash: op.stroke.dash } : {}),
          ...(op.stroke.cap ? { cap: op.stroke.cap } : {}),
          ...(op.stroke.join ? { join: op.stroke.join } : {}),
          ...(op.stroke.compound ? { compound: op.stroke.compound } : {}),
          ...(op.stroke.gradient
            ? {
                gradient: {
                  stops: op.stroke.gradient.stops,
                  angle: Math.round(op.stroke.gradient.angleDeg * 60000),
                },
              }
            : {}),
        }
      : null;
    const ok = this.apply([
      {
        op: 'setStroke',
        target: { slide: op.slideIndex, el: op.sourceId },
        stroke: patch,
        ...(op.groupId ? { group: op.groupId } : {}),
      },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  // ── transform ───────────────────────────────────────────────────────

  /**
   * Pixel box (fit-width viewport) → EMU setTransform op, group-aware.
   *
   * A drag sends many `preview: true` frames and one commit; the whole gesture
   * must be ONE undo step. The first preview pushes the snapshot, later previews
   * and the commit push nothing, and a failed first frame restores the redo stack
   * it had just cleared — the same bookkeeping upstream keeps in its session.
   */
  private transformPreview = false;
  private previewRedo: Snapshot[] | undefined;

  private transformPayload(
    slideIndex: number,
    fitWidthPx: number,
    item: {
      sourceId: string;
      groupId?: string;
      xPx: number;
      yPx: number;
      wPx: number;
      hPx: number;
      rotationDeg: number;
    },
  ): Op | null {
    const slide = this.opened.deck.slides[slideIndex];
    if (!slide) return null;
    const childId = item.groupId ? resolveGroupChildId(slide, item.groupId, item.sourceId) : item.sourceId;
    const grpChild = item.groupId ? findGroupChild(slide, item.groupId, childId) : null;
    if (item.groupId && !grpChild) return null;
    const baseWidthPx = this.opened.deck.size.cx / EMU_PER_PX_96;
    const scale = fitWidthPx / baseWidthPx;
    const toEmu = (px: number): number => Math.round((px / scale) * EMU_PER_PX_96);
    let box: { x: number; y: number; cx: number; cy: number };
    if (grpChild) {
      // Child coordinates are group-local: undo the group's own scale, then add
      // the child offset rect.
      const ch = grpChild.grp.childOffset;
      const chX = ch?.x ?? grpChild.grp.transform.offset.x;
      const chY = ch?.y ?? grpChild.grp.transform.offset.y;
      const gExt = grpChild.grp.transform.offset;
      const gsx = ch?.cx ? gExt.cx / ch.cx : 1;
      const gsy = ch?.cy ? gExt.cy / ch.cy : 1;
      box = {
        x: toEmu(item.xPx / gsx) + chX,
        y: toEmu(item.yPx / gsy) + chY,
        cx: toEmu(item.wPx / gsx),
        cy: toEmu(item.hPx / gsy),
      };
    } else {
      box = { x: toEmu(item.xPx), y: toEmu(item.yPx), cx: toEmu(item.wPx), cy: toEmu(item.hPx) };
    }
    return {
      op: 'setTransform',
      target: { slide: slideIndex, el: item.sourceId },
      box,
      rotDeg: item.rotationDeg,
      // Tables redistribute gridCol widths / tr heights so the file matches the
      // frame; group children are edited in group-local space instead.
      ...(item.groupId ? { group: item.groupId } : { resizeTableGrid: true }),
    };
  }

  editTransform(op: EditTransformOp): RenderSlide | null {
    const payload = this.transformPayload(op.slideIndex, op.fitWidthPx, op);
    if (!payload) return null;
    // Validate before touching history: a failed first preview frame must not
    // set the gesture flag (later frames would skip the snapshot) or clear redo.
    if (runTxn(this.opened, { dryRun: true, ops: [payload] }).failures?.length) return null;

    let pushed = false;
    if (op.preview) {
      if (!this.transformPreview) {
        this.previewRedo = this.redoStack;
        this.pushHistory();
        pushed = true;
        this.transformPreview = true;
      }
    } else if (this.transformPreview) {
      this.transformPreview = false;
      this.previewRedo = undefined;
    } else {
      this.pushHistory();
      pushed = true;
    }

    const r = runTxn(this.opened, { ops: [payload] });
    if (!r.applied) {
      // Unwind everything this call did, including the preview flag: a stuck flag
      // would make later frames skip the snapshot and cost the commit its undo step.
      if (pushed) {
        this.undoStack.pop();
        if (op.preview) {
          this.transformPreview = false;
          if (this.previewRedo) this.redoStack = this.previewRedo;
          this.previewRedo = undefined;
        }
      }
      if (r.failures?.length) {
        console.warn('[slides-editor] op rejected:', r.failures.map((f) => f.error).join('; '));
      }
      this.refreshDirty();
      this.notifyHistory();
      return null;
    }
    this.refreshDirty();
    this.notifyHistory();
    return this.rebuild(op.slideIndex);
  }

  /** Escape mid-gesture: restore the pre-gesture snapshot and drop it. */
  cancelTransformPreview(slideIndex: number): RenderSlide | null {
    if (!this.transformPreview) return null;
    this.transformPreview = false;
    const snap = this.undoStack.pop();
    if (snap) this.restore(snap);
    if (this.previewRedo) this.redoStack = this.previewRedo;
    this.previewRedo = undefined;
    this.refreshDirty();
    this.notifyHistory();
    return this.rebuild(slideIndex);
  }

  editTransformMulti(op: EditTransformMultiOp): RenderSlide | null {
    const ops = op.items.map((item) => this.transformPayload(op.slideIndex, op.fitWidthPx, item));
    if (ops.length === 0 || ops.some((o) => o === null)) return null;
    // One transaction = one undo step for the whole selection.
    const r = this.commit(ops as Op[], 'atomic', true);
    return r.applied ? this.rebuild(op.slideIndex) : null;
  }

  batchEditTransform(op: BatchEditTransformOp): RenderSlide | null {
    const baseWidthPx = this.opened.deck.size.cx / EMU_PER_PX_96;
    const scale = op.fitWidthPx / baseWidthPx;
    const toEmu = (px: number): number => Math.round((px / scale) * EMU_PER_PX_96);
    // Legacy parity: the batch path never redistributed table grids.
    const r = this.commit(
      op.items.map((item) => ({
        op: 'setTransform',
        target: { slide: op.slideIndex, el: item.sourceId },
        box: { x: toEmu(item.xPx), y: toEmu(item.yPx), cx: toEmu(item.wPx), cy: toEmu(item.hPx) },
        rotDeg: item.rotationDeg,
      })),
      'atomic',
      true,
    );
    return r.applied ? this.rebuild(op.slideIndex) : null;
  }

  // ── element add / remove ────────────────────────────────────────────

  addElement(op: AddElementOp): { slide: RenderSlide; sourceId: string } | null {
    const baseWidthPx = this.opened.deck.size.cx / EMU_PER_PX_96;
    const scale = op.fitWidthPx / baseWidthPx;
    const toEmu = (px: number): number => Math.round((px / scale) * EMU_PER_PX_96);
    const paragraphs = op.paragraphs?.length
      ? op.paragraphs
      : op.text
        ? op.text.split('\n').map((line) => ({ runs: [{ text: line }] }))
        : undefined;
    const r = this.commit(
      [
        {
          op: 'addElement',
          target: { slide: op.slideIndex },
          kind: op.kind,
          offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
          ...(paragraphs ? { paragraphs } : {}),
          ...(op.fillColor ? { fill: op.fillColor } : {}),
          ...(op.stroke
            ? { stroke: { color: op.stroke.color, widthEmu: Math.round(op.stroke.widthPt * EMU_PER_PT) } }
            : {}),
          ...(op.bodyPr ? { bodyPr: op.bodyPr } : {}),
        },
      ],
      'atomic',
      true,
    );
    const sourceId = r.records?.[0]?.created?.[0];
    const slide = r.applied ? this.rebuild(op.slideIndex) : null;
    return slide && sourceId ? { slide, sourceId } : null;
  }

  deleteElement(op: DeleteElementOp): RenderSlide | null {
    const ok = this.apply([
      { op: 'deleteElement', target: { slide: op.slideIndex, el: op.sourceId } },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  deleteElements(op: DeleteElementsOp): RenderSlide | null {
    const r = this.commit(
      op.sourceIds.map((id) => ({ op: 'deleteElement', target: { slide: op.slideIndex, el: id } })),
      // An id that already vanished is skipped, not fatal: the strip can delete
      // a selection something else just removed.
      'per_op',
      true,
    );
    return r.applied ? this.rebuild(op.slideIndex) : null;
  }

  // ── slides: structure & document settings ───────────────────────────

  private beforePaths(): string[] {
    return this.opened.deck.slides.map((s) => s.path);
  }

  /**
   * The renderer's partial-update contract: `order` plus render trees for the
   * slides that changed. Unchanged trees stay in the renderer, keyed by part
   * path (`mergeSlideUpdate`), so inserting one page does not repay the whole
   * deck — which matters on a 100-slide file.
   */
  slideUpdate(before: string[], changed: number[] = []): SlideUpdate {
    const previous = new Map(before.map((path, i) => [path, i]));
    const hasSlideNumber = (el: SlideElement): boolean =>
      el.type === 'group'
        ? el.children.some(hasSlideNumber)
        : !!(el as TextElement).text?.paragraphs.some((p) =>
            p.runs.some((r) => r.field === 'slidenum'),
          );
    return {
      order: this.opened.deck.slides.map((s) => s.path),
      slides: this.opened.deck.slides.flatMap((slide, i) => {
        const oldIndex = previous.get(slide.path);
        // A moved slide's page-number field now renders a different number.
        const renumber =
          oldIndex !== undefined &&
          oldIndex !== i &&
          [...slide.elements, ...(slide.decorations ?? [])].some(hasSlideNumber);
        if (oldIndex !== undefined && !changed.includes(i) && !renumber) return [];
        const rendered = this.rebuild(i);
        return rendered ? [rendered] : [];
      }),
    };
  }

  /** Copy a page after it (toolbar "新建幻灯片" when a layout is not chosen). */
  addSlide(op: AddSlideOp): (SlideUpdate & { index: number }) | null {
    const before = this.beforePaths();
    const r = this.commit(
      [
        {
          op: 'duplicateSlide',
          target: { slide: op.sourceIndex },
          ...(op.clearText ? { clearText: true } : {}),
        },
      ],
      'atomic',
      true,
    );
    if (!r.applied) return null;
    this.fitWidthPx = op.fitWidthPx;
    return { ...this.slideUpdate(before), index: op.sourceIndex + 1 };
  }

  addBlankSlide(op: AddBlankSlideOp): (SlideUpdate & { index: number }) | null {
    const before = this.beforePaths();
    const r = this.commit(
      [
        { op: 'addBlankSlide', target: { slide: op.sourceIndex } },
        // Ops validate against the pre-transaction deck, so move the existing
        // source slide down past the new one instead of targeting its new index.
        ...(op.before
          ? [{ op: 'moveSlide', target: { slide: op.sourceIndex }, to: op.sourceIndex + 1 }]
          : []),
      ],
      'atomic',
      true,
    );
    if (!r.applied) return null;
    this.fitWidthPx = op.fitWidthPx;
    return {
      ...this.slideUpdate(before),
      index: op.before ? op.sourceIndex : op.sourceIndex + 1,
    };
  }

  /** 'builtin:<key>' virtual layout paths get injected into the package on first use. */
  private resolveLayoutPath(layoutPath?: string): string | undefined {
    if (!layoutPath?.startsWith(BUILTIN_LAYOUT_PREFIX)) return layoutPath;
    return (
      ensureBuiltinLayout(
        this.opened.archive,
        this.opened.deck.size,
        layoutPath.slice(BUILTIN_LAYOUT_PREFIX.length),
      ) ?? undefined
    );
  }

  addSlideWithLayout(op: AddSlideWithLayoutOp): (SlideUpdate & { index: number }) | null {
    const before = this.beforePaths();
    // Resolve BEFORE the undo snapshot: a builtin injection mutates the package,
    // and a failed insert must not leave an undo step pointing at a half state.
    this.pushHistory();
    const layoutPath = this.resolveLayoutPath(op.layoutPath);
    const r = layoutPath
      ? runTxn(this.opened, {
          ops: [{ op: 'addSlideWithLayout', target: { slide: op.sourceIndex }, layoutPath }],
        })
      : null;
    if (!r?.applied) {
      this.undoStack.pop();
      this.refreshDirty();
      this.notifyHistory();
      return null;
    }
    this.refreshDirty();
    this.notifyHistory();
    this.fitWidthPx = op.fitWidthPx;
    return { ...this.slideUpdate(before), index: op.sourceIndex + 1 };
  }

  getLayouts(): GetLayoutsResult {
    const layouts = listSlideLayouts(this.opened.archive);
    // Decks whose own layouts carry no placeholders (AI-generated single blank
    // layout) get the built-in standard set, injected on first use.
    if (shouldOfferBuiltinLayouts(layouts)) {
      layouts.push(
        ...builtinLayoutInfos(this.opened.deck.size, new Set(layouts.map((l) => l.name))),
      );
    }
    return { layouts, size: { ...this.opened.deck.size } };
  }

  deleteSlide(slideIndex: number): SlideUpdate | null {
    const before = this.beforePaths();
    const r = this.commit([{ op: 'deleteSlide', target: { slide: slideIndex } }], 'atomic', true);
    return r.applied ? this.slideUpdate(before) : null;
  }

  deleteSlides(op: DeleteSlidesOp): SlideUpdate | null {
    const before = this.beforePaths();
    // Highest index first: every op is validated against the pre-transaction deck
    // and applied in sequence, so the remaining indexes stay valid.
    const indexes = [...new Set(op.slideIndexes)].sort((a, b) => b - a);
    if (indexes.length === 0 || indexes.length >= this.opened.deck.slides.length) return null;
    const r = this.commit(
      indexes.map((i) => ({ op: 'deleteSlide', target: { slide: i } })),
      'atomic',
      true,
    );
    return r.applied ? this.slideUpdate(before) : null;
  }

  duplicateSlides(op: DuplicateSlidesOp): (SlideUpdate & { index: number }) | null {
    const steps = planSlideDuplicates(op.slideIndexes);
    if (steps.length === 0) return null;
    const before = this.beforePaths();
    const r = this.commit(
      steps.map((st) =>
        'duplicate' in st
          ? { op: 'duplicateSlide', target: { slide: st.duplicate } }
          : { op: 'moveSlide', target: { slide: st.from }, to: st.to },
      ),
      'atomic',
      true,
    );
    if (!r.applied) return null;
    this.fitWidthPx = op.fitWidthPx;
    return { ...this.slideUpdate(before), index: Math.max(...op.slideIndexes) + 1 };
  }

  moveSlide(op: MoveSlideOp): (SlideUpdate & { sections: SectionInfo[] }) | null {
    const before = this.beforePaths();
    const r = this.commit(
      [{ op: 'moveSlide', target: { slide: op.fromIndex }, to: op.toIndex }],
      'atomic',
      true,
    );
    if (!r.applied) return null;
    return { ...this.slideUpdate(before), sections: getSections(this.opened) };
  }

  moveSlides(op: MoveSlidesOp): (SlideUpdate & { sections: SectionInfo[] }) | null {
    const steps = planSlideMoves(this.opened.deck.slides.length, op.slideIndexes, op.insertAt);
    if (steps.length === 0) return null;
    const before = this.beforePaths();
    const r = this.commit(
      steps.map((st) => ({ op: 'moveSlide', target: { slide: st.from }, to: st.to })),
      'atomic',
      true,
    );
    if (!r.applied) return null;
    return { ...this.slideUpdate(before), sections: getSections(this.opened) };
  }

  setSlidesHidden(op: SetSlidesHiddenOp): SlideUpdate | null {
    if (op.slideIndexes.length === 0) return null;
    const before = this.beforePaths();
    const r = this.commit(
      op.slideIndexes.map((i) => ({ op: 'setHidden', target: { slide: i }, hidden: op.hidden })),
      'atomic',
      true,
    );
    return r.applied ? this.slideUpdate(before, op.slideIndexes) : null;
  }

  setSlideSize(op: SetSlideSizeOp): RenderSlide[] | null {
    const r = this.commit([{ op: 'setSlideSize', cx: op.cx, cy: op.cy }], 'atomic', true);
    return r.applied ? this.rebuildAll() : null;
  }

  getSlideSize(): { cx: number; cy: number } {
    return { ...this.opened.deck.size };
  }

  getSections(): SectionInfo[] {
    return getSections(this.opened);
  }

  setSlideLayout(op: SetSlideLayoutOp): RenderSlide | null {
    this.pushHistory();
    // A named layout that fails to resolve is an error; an absent path = reset.
    const layoutPath = this.resolveLayoutPath(op.layoutPath);
    const r =
      op.layoutPath && !layoutPath
        ? null
        : runTxn(this.opened, {
            ops: [
              {
                op: 'setSlideLayout',
                target: { slide: op.slideIndex },
                ...(layoutPath ? { layoutPath } : {}),
              },
            ],
          });
    if (!r?.applied) {
      this.undoStack.pop();
      this.refreshDirty();
      this.notifyHistory();
      return null;
    }
    this.refreshDirty();
    this.notifyHistory();
    return this.rebuild(op.slideIndex);
  }

  // ── arrange & shape ─────────────────────────────────────────────────

  flipElements(op: FlipElementOp): RenderSlide | null {
    const ok = this.apply([
      {
        op: 'flipElements',
        target: { slide: op.slideIndex },
        els: op.sourceIds,
        axis: op.axis,
        ...(op.groupId ? { group: op.groupId } : {}),
      },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  groupElements(op: GroupElementsOp): { slide: RenderSlide; groupId: string } | null {
    const r = this.commit(
      [{ op: 'groupElements', target: { slide: op.slideIndex }, els: op.sourceIds }],
      'atomic',
      true,
    );
    const groupId = r.records?.[0]?.created?.[0];
    const slide = r.applied ? this.rebuild(op.slideIndex) : null;
    return slide && groupId ? { slide, groupId } : null;
  }

  ungroupElement(op: UngroupElementOp): RenderSlide | null {
    const ok = this.apply([
      { op: 'ungroupElement', target: { slide: op.slideIndex, el: op.sourceId } },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  reorderElement(op: ReorderElementOp): RenderSlide | null {
    const ok = this.apply([
      { op: 'reorderElement', target: { slide: op.slideIndex, el: op.sourceId }, dir: op.dir },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  changeShape(op: {
    slideIndex: number;
    sourceId: string;
    prst: string;
    groupId?: string;
  }): RenderSlide | null {
    const ok = this.apply([
      {
        op: 'setShapeGeometry',
        target: { slide: op.slideIndex, el: op.sourceId },
        prst: op.prst,
        ...(op.groupId ? { group: op.groupId } : {}),
      },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  /**
   * Shared preview bookkeeping for gesture-driven shape edits: one drag = one
   * undo step. The first preview pushes the snapshot, later previews and the
   * commit push nothing, and a failed first frame restores the redo stack it
   * had just cleared. Same contract as `editTransform`.
   */
  private applyPreviewOp(payload: Op, preview: boolean): boolean {
    if (runTxn(this.opened, { dryRun: true, ops: [payload] }).failures?.length) return false;
    let pushed = false;
    if (preview) {
      if (!this.transformPreview) {
        this.previewRedo = this.redoStack;
        this.pushHistory();
        this.transformPreview = true;
        pushed = true;
      }
    } else if (this.transformPreview) {
      this.transformPreview = false;
      this.previewRedo = undefined;
    } else {
      this.pushHistory();
      pushed = true;
    }
    const r = runTxn(this.opened, { ops: [payload] });
    if (!r.applied) {
      if (pushed) {
        this.undoStack.pop();
        if (preview) {
          this.transformPreview = false;
          if (this.previewRedo) this.redoStack = this.previewRedo;
          this.previewRedo = undefined;
        }
      }
      if (r.failures?.length) {
        console.warn('[slides-editor] op rejected:', r.failures.map((f) => f.error).join('; '));
      }
    }
    this.refreshDirty();
    this.notifyHistory();
    return r.applied;
  }

  setShapeAdjust(op: {
    slideIndex: number;
    sourceId: string;
    adjust: Record<string, number>;
    groupId?: string;
    preview?: boolean;
  }): RenderSlide | null {
    const ok = this.applyPreviewOp(
      {
        op: 'setShapeAdjust',
        target: { slide: op.slideIndex, el: op.sourceId },
        adjust: op.adjust,
        ...(op.groupId ? { group: op.groupId } : {}),
      },
      op.preview === true,
    );
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  /** Edit Points commit: the freeform path arrives in box-local px and becomes EMU. */
  setShapeGeometry(op: SetShapeGeometryOp): RenderSlide | null {
    const scale = op.fitWidthPx / (this.opened.deck.size.cx / EMU_PER_PX_96);
    const toEmu = (px: number): number => Math.round((px / scale) * EMU_PER_PX_96);
    const ok = this.applyPreviewOp(
      {
        op: 'setShapeCustomGeometry',
        target: { slide: op.slideIndex, el: op.sourceId },
        path: {
          w: toEmu(op.pathPx.w),
          h: toEmu(op.pathPx.h),
          cmds: op.pathPx.cmds.map((c) => ({ op: c.op, pts: c.pts.map(toEmu) })),
        },
        ...(op.groupId ? { group: op.groupId } : {}),
      },
      op.preview === true,
    );
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  setTextAnchor(op: {
    slideIndex: number;
    sourceId: string;
    anchor: 'top' | 'middle' | 'bottom';
  }): RenderSlide | null {
    const ok = this.apply([
      {
        op: 'setTextAnchor',
        target: { slide: op.slideIndex, el: op.sourceId },
        anchor: op.anchor,
      },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  setTextBodyProps(op: {
    slideIndex: number;
    sourceId: string;
    props: {
      vert?: 'horz' | 'eaVert' | 'vert' | 'vert270' | 'wordArtVert';
      autofit?: 'none' | 'shrink' | 'resize';
      insets?: Partial<{ l: number; t: number; r: number; b: number }>;
      wrap?: boolean;
    };
  }): RenderSlide | null {
    const ok = this.apply([
      {
        op: 'setTextBodyProps',
        target: { slide: op.slideIndex, el: op.sourceId },
        props: op.props,
      },
    ]);
    if (!ok) return null;
    // Autofit must take effect now, not on the next text edit: 'resize' fits the
    // box to the content, 'shrink' runs the ladder and writes the used fontScale
    // back (a bare <a:normAutofit/> opens at 100% in PowerPoint).
    const rendered = this.applyAutofitResize(
      op.slideIndex,
      op.sourceId,
      this.rebuild(op.slideIndex),
    );
    return this.syncAutofitScale(op.slideIndex, op.sourceId, rendered);
  }

  setEffects(op: {
    slideIndex: number;
    sourceId: string;
    effects: Record<string, unknown>;
  }): RenderSlide | null {
    const ok = this.apply([
      {
        op: 'setEffects',
        target: { slide: op.slideIndex, el: op.sourceId },
        effects: op.effects,
      },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  /**
   * One freehand stroke: the renderer rasterizes it to a transparent PNG and
   * sends the vector path along; the element is an ordinary picture whose name
   * carries the ink marker and whose descr carries the path (undo/save/thumbnail
   * all ride the picture pipeline).
   */
  addInk(op: AddInkOp): { slide: RenderSlide; sourceId: string } | null {
    if (!this.opened.deck.slides[op.slideIndex]) return null;
    const scale = op.fitWidthPx / (this.opened.deck.size.cx / EMU_PER_PX_96);
    const toEmu = (px: number): number => Math.round((px / scale) * EMU_PER_PX_96);
    const r = this.commit(
      [
        {
          op: 'addPicture',
          target: { slide: op.slideIndex },
          bytes: base64ToBytes(op.base64),
          ext: 'png',
          offset: {
            x: toEmu(op.xPx),
            y: toEmu(op.yPx),
            cx: Math.max(1, toEmu(op.wPx)),
            cy: Math.max(1, toEmu(op.hPx)),
          },
          name: `aislides-ink ${Date.now().toString(36)}`,
          descr: op.payload,
        },
      ],
      'atomic',
      true,
    );
    if (!r.applied) return null;
    this.fitWidthPx = op.fitWidthPx;
    const sourceId = r.records?.[0]?.created?.[0];
    const rebuilt = this.rebuild(op.slideIndex);
    return rebuilt && sourceId ? { slide: rebuilt, sourceId } : null;
  }

  // ── pictures ────────────────────────────────────────────────────────

  editPictureSrcRect(op: EditPictureSrcRectOp): RenderSlide | null {
    let box: { x: number; y: number; cx: number; cy: number } | undefined;
    if (op.boxPx && op.fitWidthPx) {
      const scale = op.fitWidthPx / (this.opened.deck.size.cx / EMU_PER_PX_96);
      const toEmu = (px: number): number => Math.round((px / scale) * EMU_PER_PX_96);
      box = {
        x: toEmu(op.boxPx.x),
        y: toEmu(op.boxPx.y),
        cx: toEmu(op.boxPx.w),
        cy: toEmu(op.boxPx.h),
      };
    }
    const ok = this.apply([
      {
        op: 'setPictureSrcRect',
        target: { slide: op.slideIndex, el: op.sourceId },
        srcRect: op.srcRect,
        ...(box ? { box } : {}),
      },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  editPictureOpacity(op: EditPictureOpacityOp): RenderSlide | null {
    const ok = this.apply([
      {
        op: 'setPictureOpacity',
        target: { slide: op.slideIndex, el: op.sourceId },
        opacity: op.opacity,
      },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  /** Insert a picture from inline bytes; placement comes from its pixel grid + DPI. */
  addImageBytes(
    op: AddImageBytesOp,
  ): { slide: RenderSlide; sourceId: string } | { error: 'unsupported'; ext: string } | null {
    const slide = this.opened.deck.slides[op.slideIndex];
    if (!slide) return null;
    const deckSize = this.opened.deck.size;
    const scale = op.fitWidthPx / (deckSize.cx / EMU_PER_PX_96);
    const toEmu = (px: number): number => Math.round((px / scale) * EMU_PER_PX_96);
    const bytes = base64ToBytes(op.base64);
    let offset: { x: number; y: number; cx: number; cy: number };
    if ('naturalPx' in op) {
      // `AddImageBytesOp` is an intersection of two placement variants; the `in`
      // check narrows the runtime value, the casts name the two sides.
      const natural = op as Extract<AddImageBytesOp, { naturalPx: unknown }>;
      offset = pictureFrame(
        { width: deckSize.cx, height: deckSize.cy },
        natural.naturalPx,
        imageDpiFromBytes(bytes),
        DEFAULT_PICTURE_DPI,
        {
          center: natural.centerPx
            ? { x: toEmu(natural.centerPx.x), y: toEmu(natural.centerPx.y) }
            : undefined,
          minEmu: toEmu(24),
        },
      );
    } else {
      const boxed = op as Extract<AddImageBytesOp, { xPx: number }>;
      offset = {
        x: toEmu(boxed.xPx),
        y: toEmu(boxed.yPx),
        cx: Math.max(1, toEmu(boxed.wPx)),
        cy: Math.max(1, toEmu(boxed.hPx)),
      };
    }
    const r = this.commit(
      [
        {
          op: 'addPicture',
          target: { slide: op.slideIndex },
          bytes,
          ext: op.ext,
          offset,
          ...(op.name ? { name: op.name } : {}),
        },
      ],
      'atomic',
      true,
    );
    if (!r.applied) return { error: 'unsupported', ext: op.ext };
    this.fitWidthPx = op.fitWidthPx;
    const sourceId = r.records?.[0]?.created?.[0];
    const rebuilt = this.rebuild(op.slideIndex);
    return rebuilt && sourceId ? { slide: rebuilt, sourceId } : null;
  }

  replacePictureBytes(op: ReplacePictureBytesOp): RenderSlide | { error: 'unsupported'; ext: string } | null {
    const r = this.commit(
      [
        {
          op: 'replacePicture',
          target: { slide: op.slideIndex, el: op.sourceId },
          bytes: base64ToBytes(op.base64),
          ext: op.ext,
          ...(op.keepSrcRect ? { keepSrcRect: true } : {}),
        },
      ],
      'atomic',
      true,
    );
    if (!r.applied) return { error: 'unsupported', ext: op.ext };
    return this.rebuild(op.slideIndex);
  }

  // ── tables ──────────────────────────────────────────────────────────

  addTable(op: AddTableOp): { slide: RenderSlide; sourceId: string } | null {
    if (!this.opened.deck.slides[op.slideIndex]) return null;
    const scale = op.fitWidthPx / (this.opened.deck.size.cx / EMU_PER_PX_96);
    const toEmu = (px: number): number => Math.round((px / scale) * EMU_PER_PX_96);
    const rowH = op.rowHeightEmu && op.rowHeightEmu > 0 ? Math.round(op.rowHeightEmu) : null;
    const r = this.commit(
      [
        {
          op: 'addTable',
          target: { slide: op.slideIndex },
          rows: op.rows,
          cols: op.cols,
          offset: {
            x: toEmu(op.xPx),
            y: toEmu(op.yPx),
            cx: toEmu(op.wPx),
            cy: rowH ? rowH * op.rows : toEmu(op.hPx),
          },
          ...(rowH ? { rowHeightsEmu: Array.from({ length: op.rows }, () => rowH) } : {}),
        },
      ],
      'atomic',
      true,
    );
    if (!r.applied) return null;
    this.fitWidthPx = op.fitWidthPx;
    const sourceId = r.records?.[0]?.created?.[0];
    const rebuilt = this.rebuild(op.slideIndex);
    return rebuilt && sourceId ? { slide: rebuilt, sourceId } : null;
  }

  editTableCell(op: EditTableCellOp): RenderSlide | null {
    const ok = this.apply([
      {
        op: 'setTableCell',
        target: { slide: op.slideIndex, el: op.sourceId },
        row: op.row,
        col: op.col,
        paragraphs: op.paragraphs,
      },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  tableMerge(op: TableMergeIpcOp): { slide: RenderSlide; sourceId: string } | null {
    const r = this.commit(
      [
        {
          op: 'tableMerge',
          target: { slide: op.slideIndex, el: op.sourceId },
          kind: op.kind,
          row: op.row,
          col: op.col,
        },
      ],
      'atomic',
      true,
    );
    if (!r.applied) return null;
    const rebuilt = this.rebuild(op.slideIndex);
    const sourceId = (r.records?.[0] as unknown as { after?: { elementId?: string } })?.after?.elementId;
    return rebuilt && sourceId ? { slide: rebuilt, sourceId } : null;
  }

  tableStructure(op: TableStructureIpcOp): { slide: RenderSlide; sourceId: string } | null {
    const r = this.commit(
      [
        {
          op: 'tableStructure',
          target: { slide: op.slideIndex, el: op.sourceId },
          kind: op.kind,
          index: op.index,
          ...(op.before ? { before: true } : {}),
        },
      ],
      'atomic',
      true,
    );
    if (!r.applied) return null;
    const rebuilt = this.rebuild(op.slideIndex);
    const sourceId = (r.records?.[0] as unknown as { after?: { elementId?: string } })?.after?.elementId;
    return rebuilt && sourceId ? { slide: rebuilt, sourceId } : null;
  }

  setTableRowHeight(op: SetTableRowHeightOp): RenderSlide | null {
    const scale = op.fitWidthPx / (this.opened.deck.size.cx / EMU_PER_PX_96);
    const ok = this.apply([
      {
        op: 'setTableRowHeight',
        target: { slide: op.slideIndex, el: op.sourceId },
        row: op.row,
        hEmu: (op.hPx / scale) * EMU_PER_PX_96,
      },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  setTableColWidth(op: SetTableColWidthOp): RenderSlide | null {
    const scale = op.fitWidthPx / (this.opened.deck.size.cx / EMU_PER_PX_96);
    const ok = this.apply([
      {
        op: 'setTableColWidth',
        target: { slide: op.slideIndex, el: op.sourceId },
        col: op.col,
        wEmu: (op.wPx / scale) * EMU_PER_PX_96,
      },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  setTableCellAnchor(op: SetTableCellAnchorOp): RenderSlide | null {
    const ok = this.apply([
      {
        op: 'setTableCellAnchor',
        target: { slide: op.slideIndex, el: op.sourceId },
        row: op.row,
        col: op.col,
        anchor: op.anchor,
      },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  editTableStyle(op: EditTableStyleOp): { slide: RenderSlide; sourceId: string } | null {
    const slide = this.opened.deck.slides[op.slideIndex];
    if (!slide) return null;
    // A reparse regenerates element ids; remember the element's position so the
    // renderer's selection can follow it.
    const elIdx = slide.elements.findIndex((el) => matchesElementRef(el, op.sourceId));
    const { slideIndex, sourceId, ...style } = op;
    const ok = this.apply([
      { op: 'setTableStyle', target: { slide: slideIndex, el: sourceId }, ...style },
    ]);
    if (!ok) return null;
    // The patch lands on anchor.originalXml; a materialize reparse is needed
    // before the render model shows it.
    const rebuilt = this.rebuildWithReparse(op.slideIndex);
    if (!rebuilt) return null;
    const newId = this.opened.deck.slides[op.slideIndex]?.elements[elIdx]?.id ?? null;
    return newId ? { slide: rebuilt, sourceId: newId } : null;
  }

  // ── charts ──────────────────────────────────────────────────────────

  chartColorSchemes(): Array<{ key: string; label: string; colors: string[] }> {
    const acc = this.deckAccents();
    const rot = [...acc.slice(3), ...acc.slice(0, 3)];
    const mono = (c: string): string[] => [
      mixHex(c, 0, 0.25),
      c,
      mixHex(c, 255, 0.25),
      mixHex(c, 255, 0.45),
      mixHex(c, 255, 0.65),
    ];
    return [
      { key: 'default', label: '默认', colors: [] },
      { key: 'colorful', label: '彩色', colors: acc },
      { key: 'colorful2', label: '彩色（换序）', colors: rot },
      ...acc.map((c, i) => ({ key: `mono-accent${i + 1}`, label: `单色 ${i + 1}`, colors: mono(c) })),
    ];
  }

  /** Accent1..6 from the theme part of the first slide's inheritance chain. */
  private deckAccents(): string[] {
    const slide = this.opened.deck.slides[0];
    if (!slide) return FALLBACK_ACCENTS;
    try {
      const chain = this.opened.archive.resolveSlideChain(slide.path);
      const xml = chain.themePath ? this.opened.archive.readText(chain.themePath) : null;
      const colors = xml ? parseTheme(xml).colors : undefined;
      const acc = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
        .map((k) => colors?.[k])
        .filter((c): c is string => !!c);
      return acc.length >= 3 ? acc : FALLBACK_ACCENTS;
    } catch {
      return FALLBACK_ACCENTS;
    }
  }

  getChartData(slideIndex: number, sourceId: string): unknown {
    const slide = this.opened.deck.slides[slideIndex];
    return slide ? getChartElementData(slide, sourceId) : null;
  }

  addChart(op: AddChartOp): { slide: RenderSlide; sourceId: string } | null {
    if (!this.opened.deck.slides[op.slideIndex]) return null;
    const scale = op.fitWidthPx / (this.opened.deck.size.cx / EMU_PER_PX_96);
    const toEmu = (px: number): number => Math.round((px / scale) * EMU_PER_PX_96);
    const r = this.commit(
      [
        {
          op: 'addChart',
          target: { slide: op.slideIndex },
          kind: op.kind === 'barH' ? 'bar' : op.kind,
          ...(op.kind === 'barH' ? { barDir: 'bar' } : {}),
          ...(op.title ? { title: op.title } : {}),
          categories: op.categories,
          series: op.series,
          offset: {
            x: toEmu(op.xPx),
            y: toEmu(op.yPx),
            cx: toEmu(op.wPx),
            cy: toEmu(op.hPx),
          },
        },
      ],
      'atomic',
      true,
    );
    if (!r.applied) return null;
    this.fitWidthPx = op.fitWidthPx;
    const sourceId = r.records?.[0]?.created?.[0];
    const rebuilt = this.rebuild(op.slideIndex);
    return rebuilt && sourceId ? { slide: rebuilt, sourceId } : null;
  }

  /**
   * Chart edits. Upstream asks for confirmation before rebuilding a foreign
   * chart (fine-grained formatting is lost); a panel has no native dialog, and
   * the confirm was a courtesy — the edit itself is what the user asked for.
   */
  editChart(op: EditChartOp): { slide: RenderSlide; sourceId: string } | null {
    const slide = this.opened.deck.slides[op.slideIndex];
    if (!slide) return null;
    const elIdx = slide.elements.findIndex((el) => matchesElementRef(el, op.sourceId));
    const patch: Parameters<typeof editChartElement>[3] = {
      ...(op.kind ? { kind: op.kind === 'barH' ? 'bar' : op.kind } : {}),
      ...(op.kind === 'barH' ? { barDir: 'bar' as const } : {}),
      ...(op.categories ? { categories: op.categories } : {}),
      ...(op.series ? { series: op.series } : {}),
      ...(op.title !== undefined ? { title: op.title } : {}),
      ...(op.colorScheme
        ? {
            colorScheme:
              this.chartColorSchemes().find((s) => s.key === op.colorScheme)?.colors ??
              CHART_COLOR_SCHEMES[op.colorScheme],
          }
        : {}),
      ...(op.legendPos ? { legendPos: op.legendPos } : {}),
      ...(op.dataLabels !== undefined ? { dataLabels: op.dataLabels } : {}),
      ...(op.gridlines !== undefined ? { gridlines: op.gridlines } : {}),
      ...(op.catAxisTitle !== undefined ? { catAxisTitle: op.catAxisTitle } : {}),
      ...(op.valAxisTitle !== undefined ? { valAxisTitle: op.valAxisTitle } : {}),
      ...(op.gapWidthPct !== undefined ? { gapWidthPct: op.gapWidthPct } : {}),
      ...(op.switchRowCol ? { switchRowCol: true } : {}),
      ...(op.pointColors ? { pointColors: op.pointColors } : {}),
    };
    const ok = this.apply([
      { op: 'setChart', target: { slide: op.slideIndex, el: op.sourceId }, patch },
    ]);
    if (!ok) return null;
    // The chart part XML is updated; reparse the page so the model catches up.
    const rebuilt = this.rebuildWithReparse(op.slideIndex);
    if (!rebuilt) return null;
    const newId = this.opened.deck.slides[op.slideIndex]?.elements[elIdx]?.id ?? null;
    return newId ? { slide: rebuilt, sourceId: newId } : null;
  }

  addSmartart(op: AddSmartArtOp): { slide: RenderSlide; sourceId: string } | null {
    if (!this.opened.deck.slides[op.slideIndex]) return null;
    const scale = op.fitWidthPx / (this.opened.deck.size.cx / EMU_PER_PX_96);
    const toEmu = (px: number): number => Math.round((px / scale) * EMU_PER_PX_96);
    const r = this.commit(
      [
        {
          op: 'addSmartArt',
          target: { slide: op.slideIndex },
          layout: op.layout,
          items: op.items,
          offset: {
            x: toEmu(op.xPx),
            y: toEmu(op.yPx),
            cx: toEmu(op.wPx),
            cy: toEmu(op.hPx),
          },
        },
      ],
      'atomic',
      true,
    );
    if (!r.applied) return null;
    this.fitWidthPx = op.fitWidthPx;
    const sourceId = r.records?.[0]?.created?.[0];
    const rebuilt = this.rebuild(op.slideIndex);
    return rebuilt && sourceId ? { slide: rebuilt, sourceId } : null;
  }

  // ── links ───────────────────────────────────────────────────────────

  setLink(op: SetLinkOp): RenderSlide | null {
    // A javascript:/file: target must never be saved into the package.
    if (
      op.target?.kind === 'url' &&
      safeExternalUrl(op.target.url, { allowedProtocols: DECK_LINK_PROTOCOLS }) === null
    ) {
      return null;
    }
    const ok = this.apply([
      { op: 'setLink', target: { slide: op.slideIndex, el: op.sourceId }, link: op.target },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  getLink(slideIndex: number, sourceId: string): unknown {
    return getElementLink(this.opened, slideIndex, sourceId);
  }

  getSlideLinks(slideIndex: number): unknown[] {
    return getSlideLinks(this.opened, slideIndex).map(({ elementId, target }) => ({
      sourceId: elementId,
      target,
    }));
  }

  getRunLinks(slideIndex: number): unknown[] {
    return getRunLinks(this.opened, slideIndex).map(({ elementId, ...rest }) => ({
      sourceId: elementId,
      ...rest,
    }));
  }

  // ── theme / header-footer ───────────────────────────────────────────

  applyTheme(op: ApplyThemeOp): { error: string } | RenderSlide[] | null {
    const payload = {
      op: 'applyTheme',
      name: op.name,
      colors: op.colors,
      ...(op.majorFont ? { majorFont: op.majorFont } : {}),
      ...(op.minorFont ? { minorFont: op.minorFont } : {}),
    };
    // Plan first so an invalid request does not clear the redo stack.
    const plan = runTxn(this.opened, { ops: [payload], dryRun: true });
    if (plan.failures?.length) return { error: plan.failures[0]!.error };
    this.pushHistory();
    const r = runTxn(this.opened, { ops: [payload] });
    if (!r.applied) {
      this.undoStack.pop();
      this.refreshDirty();
      this.notifyHistory();
      return { error: r.failures?.[0]?.error ?? 'applyTheme failed' };
    }
    const after = r.records?.[0]?.after as { patched?: number; remapped?: number } | undefined;
    if ((after?.patched ?? 0) === 0 && (after?.remapped ?? 0) === 0) {
      // Nothing matched the spec; the op only baked pending edits — not a step.
      this.undoStack.pop();
      this.refreshDirty();
      this.notifyHistory();
      return null;
    }
    // Reparse so every element's resolved colours/fonts refresh.
    this.opened = reparseDeck(this.opened);
    this.media = null; // new archive object: cached media data URLs belong to the old one
    this.fitWidthPx = op.fitWidthPx;
    this.refreshDirty();
    this.notifyHistory();
    return this.rebuildAll();
  }

  applyHeaderFooter(op: HeaderFooterOp): RenderSlide[] | null {
    const r = this.commit(
      [
        {
          op: 'applyHeaderFooter',
          settings: {
            footer: op.footer ?? null,
            slideNum: !!op.slideNum,
            date: op.date ?? null,
            ...(op.dateAuto ? { dateAuto: true } : {}),
          },
        },
      ],
      'atomic',
      true,
    );
    if (!r.applied) return null;
    this.fitWidthPx = op.fitWidthPx;
    return this.rebuildAll();
  }

  getHeaderFooter(slideIndex: number): unknown {
    const slide = this.opened.deck.slides[slideIndex];
    return slide ? readHeaderFooter(slide) : { footer: null, slideNum: false, date: null };
  }

  // ── transitions / animations ────────────────────────────────────────

  setTransition(op: SetTransitionOp): boolean {
    const slides = this.opened.deck.slides;
    const idxs =
      op.slideIndex === -1
        ? slides.map((_, i) => i)
        : slides[op.slideIndex]
          ? [op.slideIndex]
          : [];
    if (idxs.length === 0) return false;
    return this.commit(
      idxs.map((i) => ({ op: 'setTransition', target: { slide: i }, kind: op.kind })),
      'atomic',
      true,
    ).applied;
  }

  getTransition(slideIndex: number): unknown {
    const slide = this.opened.deck.slides[slideIndex];
    return slide ? getSlideTransition(slide) : 'none';
  }

  getShowTiming(slideIndex: number): ShowTiming {
    const slide = this.opened.deck.slides[slideIndex];
    if (!slide) return { advanceMs: null, narrationIds: [] };
    const narration = new Set(narrationSpids(slide));
    return {
      advanceMs: getSlideAdvanceTime(slide),
      narrationIds: slide.elements
        .filter((el) => narration.has(elementSpid(el) ?? -1))
        .map((el) => el.id),
    };
  }

  setAdvanceTimes(op: SetAdvanceTimesOp): boolean {
    const slides = this.opened.deck.slides;
    const targets = op.times.filter((t) => slides[t.slideIndex]);
    if (targets.length === 0) return false;
    return this.commit(
      targets.map((t) => ({ op: 'setAdvanceTime', target: { slide: t.slideIndex }, ms: t.ms })),
      'atomic',
      true,
    ).applied;
  }

  // ── narration ───────────────────────────────────────────────────────

  /** Slide Show > Record: narration + its advance time, one undo step. */
  saveRecording(op: SaveRecordingOp): RenderSlide[] | null {
    const slides = this.opened.deck.slides;
    const recorded = op.slides.filter((s) => slides[s.slideIndex]);
    if (recorded.length === 0) return null;
    const r = this.commit(
      recorded.flatMap((s) => [
        {
          op: 'addNarration',
          target: { slide: s.slideIndex },
          bytes: base64ToBytes(s.wavBase64),
          ext: 'wav',
          durationMs: s.durationMs,
        },
        { op: 'setAdvanceTime', target: { slide: s.slideIndex }, ms: s.advanceMs },
      ]),
      'atomic',
      true,
    );
    return r.applied ? this.rebuildAll() : null;
  }

  clearNarration(slideIndexes: number[]): RenderSlide[] | null {
    const slides = this.opened.deck.slides;
    const targets = slideIndexes.filter((i) => slides[i] && narrationSpids(slides[i]).length > 0);
    if (targets.length === 0) return null;
    const r = this.commit(
      targets.map((i) => ({ op: 'clearNarration', target: { slide: i } })),
      'atomic',
      true,
    );
    return r.applied ? this.rebuildAll() : null;
  }

  getAnimations(slideIndex: number): AnimationItem[] {
    const slide = this.opened.deck.slides[slideIndex];
    if (!slide) return [];
    const bySpid = new Map<number, SlideElement>();
    for (const el of slide.elements) {
      const spid = elementSpid(el);
      if (spid != null && !bySpid.has(spid)) bySpid.set(spid, el);
    }
    const typeLabel: Record<string, string> = {
      text: '文本框',
      shape: '形状',
      picture: '图片',
      group: '组合',
      table: '表格',
      chart: '图表',
      passthrough: '对象',
    };
    const out: AnimationItem[] = [];
    for (const a of getSlideAnimations(slide)) {
      const el = bySpid.get(a.spid);
      // Leftover animations whose target shape was deleted are not echoed back.
      if (!el) continue;
      out.push({
        sourceId: el.id,
        targetName: el.name || typeLabel[el.type] || '对象',
        effect: a.effect,
        trigger: a.trigger,
        durationMs: a.durationMs,
        delayMs: a.delayMs,
        ...(a.direction != null ? { direction: a.direction } : {}),
        ...(a.motionPath != null ? { motionPath: a.motionPath } : {}),
        ...(a.paragraph != null ? { paragraph: a.paragraph } : {}),
      });
    }
    return out;
  }

  setAnimations(op: SetAnimationsOp): boolean {
    return this.commit(
      [{ op: 'setAnimations', target: { slide: op.slideIndex }, items: op.items }],
      'atomic',
      true,
    ).applied;
  }

  /** Pairing keys for Morph transitions: sourceId changes on reparse, cNvPr id/name do not. */
  getShapeKeys(slideIndex: number): ShapeKey[] {
    const slide = this.opened.deck.slides[slideIndex];
    if (!slide) return [];
    return slide.elements.map((el) => ({
      sourceId: el.id,
      spid: elementSpid(el),
      name: el.name ?? '',
    }));
  }

  setHidden(op: SetSlideHiddenOp): RenderSlide | null {
    const ok = this.apply([
      { op: 'setHidden', target: { slide: op.slideIndex }, hidden: op.hidden },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  // ── export / print ──────────────────────────────────────────────────

  async pickExportDir(): Promise<string | null> {
    const picked = await backend<{ path?: string | null }>('file.pickDirectory', {
      title: '选择导出文件夹',
    });
    return picked?.path ?? null;
  }

  async pickExportPdfPath(defaultName: string): Promise<string | null> {
    const picked = await backend<{ path?: string | null }>('file.pickSavePath', {
      title: '导出 PDF',
      defaultName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    return picked?.path ?? null;
  }

  /** Export → images: the renderer rasterized each page; this writes them in order. */
  async exportImages(op: ExportImagesOp): Promise<ExportImagesResult> {
    if (op.pngsBase64.length === 0) return { ok: false, error: '没有可导出的页面' };
    const ext = op.format === 'jpg' ? 'jpg' : 'png';
    const dir = op.dir.replace(/[\\/]+$/, '');
    const paths: string[] = [];
    try {
      for (let i = 0; i < op.pngsBase64.length; i++) {
        const path = `${dir}/${op.baseName}-${String(i + 1).padStart(2, '0')}.${ext}`;
        await backend('file.write', { path, base64: op.pngsBase64[i] });
        paths.push(path);
      }
      return { ok: true, paths };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Export → PDF. The renderer hands over one vector (SVG) or bitmap page per
   * slide; the panel rasterizes at 2× and the backend assembles the PDF. Upstream
   * prints a hidden window, which keeps SVG text vector and carries link
   * annotations; a panel has no printToPDF, so exported PDFs are images and have
   * no clickable links.
   */
  async exportPdf(op: ExportPdfOp): Promise<ExportPdfResult> {
    try {
      const pages: string[] = [];
      for (const page of op.pages) {
        pages.push(await rasterizePage(page, op.widthPx, op.heightPx));
      }
      const written = await backend<{ ok?: boolean }>('pdf.writeFromImages', {
        path: op.filePath,
        pages,
        widthPx: op.widthPx,
        heightPx: op.heightPx,
      });
      return written?.ok === false
        ? { ok: false, error: '写入 PDF 失败' }
        : { ok: true, path: op.filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Print: the renderer hands over ready page bitmaps and a layout. The panel
   * prints an offscreen iframe, so the system print dialog is Chromium's —
   * silent printing to a named printer (`op.job`) is not available here.
   */
  async printSlides(op: PrintSlidesOp): Promise<{ ok: boolean; error?: string }> {
    if (op.pngsBase64.length === 0) return { ok: false, error: '没有可打印的页面' };
    try {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText =
        'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0;pointer-events:none';
      document.body.appendChild(frame);
      const doc = frame.contentDocument;
      if (!doc) {
        frame.remove();
        return { ok: false, error: '无法创建打印文档' };
      }
      doc.open();
      doc.write(printHtml(op));
      doc.close();
      // Images are data URLs; give the iframe a beat to decode before printing.
      await new Promise((resolve) => setTimeout(resolve, 500));
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      setTimeout(() => frame.remove(), 60_000);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Save as Picture: one PNG of the selection. */
  async savePicture(op: SavePictureOp): Promise<SavePictureResult> {
    const picked = await backend<{ path?: string | null }>('file.pickSavePath', {
      title: '另存为图片',
      defaultName: `${op.defaultName}.png`,
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (!picked?.path) return { ok: false };
    try {
      await backend('file.write', { path: picked.path, base64: op.pngBase64 });
      return { ok: true, path: picked.path };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── pictures / media / 3D ───────────────────────────────────────────

  /** Replace Picture's file picker: the host chooses the file, the panel reads it. */
  async pickPictureFile(): Promise<{ base64: string; ext: string } | null> {
    const filePath = await pickFile('替换图片', IMAGE_EXTS);
    if (!filePath) return null;
    return {
      base64: bytesToBase64(await readFileBytes(filePath)),
      ext: filePath.split('.').pop()!.toLowerCase(),
    };
  }

  /** Insert > Picture: pick, decode the natural size, place at PowerPoint's size. */
  async insertImage(
    slideIndex: number,
    fitWidthPx: number,
  ): Promise<{ slide: RenderSlide; sourceId: string } | { error: 'unsupported'; ext: string } | null> {
    if (!this.opened.deck.slides[slideIndex]) return null;
    const filePath = await pickFile('插入图片', IMAGE_EXTS);
    if (!filePath) return null;
    const bytes = await readFileBytes(filePath);
    const ext = filePath.split('.').pop()!.toLowerCase();
    const deckSize = this.opened.deck.size;
    const offset = pictureFrame(
      { width: deckSize.cx, height: deckSize.cy },
      await naturalSizeOf(bytes),
      imageDpiFromBytes(bytes),
      DEFAULT_PICTURE_DPI,
    );
    const r = this.commit(
      [{ op: 'addPicture', target: { slide: slideIndex }, bytes, ext, offset }],
      'atomic',
      true,
    );
    if (!r.applied) return { error: 'unsupported', ext };
    this.fitWidthPx = fitWidthPx;
    const sourceId = r.records?.[0]?.created?.[0];
    const rebuilt = this.rebuild(slideIndex);
    return rebuilt && sourceId ? { slide: rebuilt, sourceId } : null;
  }

  /** Insert > Video / Audio: the host picks, the panel embeds the bytes. */
  async insertMedia(
    slideIndex: number,
    kind: 'video' | 'audio',
    fitWidthPx: number,
  ): Promise<{ slide: RenderSlide; sourceId: string } | null> {
    if (!this.opened.deck.slides[slideIndex]) return null;
    const filePath = await pickFile(
      kind === 'video' ? '插入视频' : '插入音频',
      kind === 'video' ? VIDEO_EXTS : AUDIO_EXTS,
    );
    if (!filePath) return null;
    const bytes = await readFileBytes(filePath);
    const ext = filePath.split('.').pop()!.toLowerCase();
    return this.embedMedia(slideIndex, kind, bytes, ext, filePath.split(/[\\/]/).pop(), { fitWidthPx });
  }

  async addMediaBytes(op: AddMediaBytesOp): Promise<{ slide: RenderSlide; sourceId: string } | null> {
    if (!this.opened.deck.slides[op.slideIndex]) return null;
    let bytes: Uint8Array;
    try {
      bytes = 'path' in op ? await readFileBytes(op.path) : base64ToBytes(op.base64);
    } catch {
      return null;
    }
    const scale = op.fitWidthPx / (this.opened.deck.size.cx / EMU_PER_PX_96);
    const toEmu = (px: number): number => Math.round((px / scale) * EMU_PER_PX_96);
    return this.embedMedia(op.slideIndex, op.kind, bytes, op.ext, op.name, {
      natural: op.natural,
      center: op.centerPx ? { x: toEmu(op.centerPx.x), y: toEmu(op.centerPx.y) } : undefined,
      fitWidthPx: op.fitWidthPx,
    });
  }

  /**
   * Shared embed path. Upstream also grabs a QuickLook poster frame for videos;
   * the panel has no native image bridge, so the video renders without a poster
   * (the show still plays it — the poster is only the still frame).
   */
  private embedMedia(
    slideIndex: number,
    kind: 'video' | 'audio',
    bytes: Uint8Array,
    ext: string,
    name: string | undefined,
    opts: {
      natural?: { width: number; height: number } | null;
      center?: { x: number; y: number };
      fitWidthPx: number;
    },
  ): { slide: RenderSlide; sourceId: string } | null {
    const deckSize = this.opened.deck.size;
    const slideSize = { width: deckSize.cx, height: deckSize.cy };
    const offset =
      kind === 'video'
        ? videoFrame(slideSize, opts.natural ?? videoSize(bytes, ext), opts.center)
        : audioFrame(slideSize, opts.center);
    const r = this.commit(
      [
        {
          op: 'addMedia',
          target: { slide: slideIndex },
          kind,
          bytes,
          ext,
          offset,
          ...(name ? { name } : {}),
        },
      ],
      'atomic',
      true,
    );
    if (!r.applied) return null;
    this.fitWidthPx = opts.fitWidthPx;
    const sourceId = r.records?.[0]?.created?.[0];
    const rebuilt = this.rebuild(slideIndex);
    return rebuilt && sourceId ? { slide: rebuilt, sourceId } : null;
  }

  /** Double-click playback: the media bytes as a data URL (embedded) or the link (external). */
  mediaData(
    slideIndex: number,
    sourceId: string,
  ): { kind: 'video' | 'audio'; dataUrl: string } | null {
    const slide = this.opened.deck.slides[slideIndex];
    const el = slide?.elements.find((x) => x.id === sourceId);
    if (!el || el.type !== 'picture') return null;
    const media = (el as { media?: { kind: 'video' | 'audio'; target?: string; external?: boolean } })
      .media;
    if (!media?.target) return null;
    if (media.external) return { kind: media.kind, dataUrl: media.target };
    const bytes = this.opened.archive.readBytes(media.target);
    if (!bytes) return null;
    const ext = media.target.split('.').pop()?.toLowerCase() ?? '';
    const mime = AV_MIME[ext] ?? (media.kind === 'video' ? 'video/mp4' : 'audio/mpeg');
    return { kind: media.kind, dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}` };
  }

  async pickModel3d(): Promise<{ name: string; bytes: Uint8Array } | null> {
    const filePath = await pickFile('插入 3D 模型', ['glb']);
    if (!filePath) return null;
    return {
      name: filePath.split(/[\\/]/).pop() ?? 'model.glb',
      bytes: await readFileBytes(filePath),
    };
  }

  /** 3D model: glb embed, sized to half the slide height, centred. */
  addModel3d(op: AddModel3dOp): { slide: RenderSlide; sourceId: string } | null {
    if (!this.opened.deck.slides[op.slideIndex]) return null;
    const deckSize = this.opened.deck.size;
    const cy = Math.round(deckSize.cy * 0.5);
    const cx = Math.round(cy * op.aspect);
    const r = this.commit(
      [
        {
          op: 'addModel3d',
          target: { slide: op.slideIndex },
          bytes: op.bytes,
          ext: 'glb',
          ...(op.posterBase64
            ? { poster: { bytes: base64ToBytes(op.posterBase64), ext: 'png' } }
            : {}),
          offset: {
            x: Math.round((deckSize.cx - cx) / 2),
            y: Math.round((deckSize.cy - cy) / 2),
            cx,
            cy,
          },
          name: op.name,
        },
      ],
      'atomic',
      true,
    );
    if (!r.applied) return null;
    this.fitWidthPx = op.fitWidthPx;
    const sourceId = r.records?.[0]?.created?.[0];
    const rebuilt = this.rebuild(op.slideIndex);
    return rebuilt && sourceId ? { slide: rebuilt, sourceId } : null;
  }

  model3dData(slideIndex: number, sourceId: string): Uint8Array | null {
    const el = this.opened.deck.slides[slideIndex]?.elements.find((x) => x.id === sourceId);
    const target = el?.type === 'picture' ? el.model3d?.target : undefined;
    const bytes = target ? this.opened.archive.readBytes(target) : undefined;
    return bytes ? new Uint8Array(bytes) : null;
  }

  setModel3dView(op: SetModel3dViewOp): RenderSlide | null {
    if (!this.opened.deck.slides[op.slideIndex]) return null;
    const ok = this.apply([
      {
        op: 'setModel3dView',
        target: { slide: op.slideIndex, el: op.sourceId },
        ...op.rot,
        ...(op.posterBase64 ? { poster: op.posterBase64, posterExt: 'png' } : {}),
      },
    ]);
    return ok ? this.rebuild(op.slideIndex) : null;
  }

  // ── clipboard ───────────────────────────────────────────────────────

  /**
   * In-app clipboard. Upstream also mirrors copies to the OS clipboard (a marker
   * token, plus a PNG rendering) so another app's copy supersedes them; a panel
   * page cannot write arbitrary clipboard formats, so the internal copy is the
   * whole contract here. External pastes still work — see `clipboardExternal`.
   */
  copyElements(op: CopyElementsOp): number {
    const slide = this.opened.deck.slides[op.slideIndex];
    if (!slide) return 0;
    const items = op.sourceIds
      .map((id) => slide.elements.find((el) => el.id === id))
      .filter((el): el is SlideElement => !!el)
      .map((el) => copyElementData(this.opened, slide, el as never));
    if (items.length) {
      elementClipboard = {
        items,
        cascade: newPasteCascade(op.cut ? null : pageKey(0, op.slideIndex)),
        token: op.clipboardToken || randomToken(),
      };
    }
    return items.length;
  }

  pasteElements(op: PasteElementsOp): { slide: RenderSlide; sourceIds: string[] } | null {
    const clip = elementClipboard;
    if (!clip?.items.length || !this.opened.deck.slides[op.slideIndex]) return null;
    const scale = op.fitWidthPx / (this.opened.deck.size.cx / EMU_PER_PX_96);
    // Cascade only past occupied spots: the first paste onto another page lands
    // at the source coordinates; repeats shift 16px per landing.
    const target = pageKey(0, op.slideIndex);
    const shiftPx = pasteShiftPx(clip.cascade, target);
    const shift = Math.round((shiftPx / scale) * EMU_PER_PX_96);
    const r = this.commit(
      [
        {
          op: 'pasteElements',
          target: { slide: op.slideIndex },
          items: clip.items,
          dx: shift,
          dy: shift,
        },
      ],
      'atomic',
      true,
    );
    if (!r.applied) return null;
    recordPaste(clip.cascade, target);
    this.fitWidthPx = op.fitWidthPx;
    const rebuilt = this.rebuild(op.slideIndex);
    const sourceIds = r.records?.[0]?.created ?? [];
    return rebuilt ? { slide: rebuilt, sourceIds } : null;
  }

  /** ⌘D / Option-drag: duplicate in place, no clipboard involvement. */
  duplicateElements(op: DuplicateElementsOp): { slide: RenderSlide; sourceIds: string[] } | null {
    const slide = this.opened.deck.slides[op.slideIndex];
    if (!slide) return null;
    const items = op.sourceIds
      .map((id) => slide.elements.find((el) => el.id === id))
      .filter((el): el is SlideElement => !!el)
      .map((el) => copyElementData(this.opened, slide, el as never));
    if (!items.length) return null;
    const scale = op.fitWidthPx / (this.opened.deck.size.cx / EMU_PER_PX_96);
    const toEmu = (px: number): number => Math.round((px / scale) * EMU_PER_PX_96);
    const r = this.commit(
      [
        {
          op: 'pasteElements',
          target: { slide: op.slideIndex },
          items,
          dx: toEmu(op.dxPx),
          dy: toEmu(op.dyPx),
        },
      ],
      'atomic',
      true,
    );
    if (!r.applied) return null;
    this.fitWidthPx = op.fitWidthPx;
    const rebuilt = this.rebuild(op.slideIndex);
    const sourceIds = r.records?.[0]?.created ?? [];
    return rebuilt ? { slide: rebuilt, sourceIds } : null;
  }

  /**
   * What a plain ⌘V would paste, in the renderer's priority order: internal
   * slide copy, internal element copy, then the browser clipboard (image/text).
   */
  async clipboardExternal(): Promise<{
    kind: 'slide' | 'internal' | 'image' | 'text' | 'none';
    base64?: string;
    ext?: string;
    text?: string;
  }> {
    if (slideClipboard) return { kind: 'slide' };
    if (elementClipboard) return { kind: 'internal' };
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        return { kind: 'image', base64: await blobToBase64(blob), ext: type.split('/')[1] };
      }
    } catch {
      /* no permission, or nothing readable: fall through */
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) return { kind: 'text', text };
    } catch {
      /* same */
    }
    return { kind: 'none' };
  }

  clipboardProbe(): boolean {
    return slideClipboard !== null || elementClipboard !== null;
  }

  copySlides(op: CopySlidesOp): boolean {
    if (!op.slideIndexes.length) return false;
    const bundles: SlideBundle[] = [];
    for (const i of op.slideIndexes) {
      const bundle = copySlide(this.opened, i);
      if (!bundle) return false;
      bundles.push(bundle);
    }
    const pngs = op.pngs?.length === bundles.length ? op.pngs : undefined;
    slideClipboard = { bundles, ...(pngs ? { pngs } : {}) };
    return true;
  }

  hasSlideClipboard(): boolean {
    return slideClipboard !== null;
  }

  /**
   * Several copied slides paste in order; 'picture' mode stacks every bitmap on
   * the anchor slide. The paste-options floater can then re-run the same paste
   * with another mode (see `repasteSlide`).
   */
  private performSlidePaste(
    op: PasteSlideOp,
    before: string[],
    restored: number[] = [],
  ): PasteSlideResult | null {
    if (!slideClipboard) return null;
    const picture = op.mode === 'picture';
    const { bundles, pngs } = slideClipboard;
    if (picture && !pngs) return null;
    const r = this.commit(
      bundles.map((bundle, j) => ({
        op: 'pasteSlide',
        afterIndex: picture ? op.afterIndex : op.afterIndex + j,
        mode: op.mode,
        ...(picture ? { png: pngs![j] } : { bundle }),
      })),
      'atomic',
      true,
    );
    if (!r.applied || !r.records?.length) return null;
    this.fitWidthPx = op.fitWidthPx;
    const rec = r.records[0] as unknown as { after?: { index?: number } };
    const index = rec.after?.index ?? 0;
    const created = r.records.flatMap((x) => x.created ?? []);
    return {
      ...this.slideUpdate(before, [
        ...restored,
        ...Array.from({ length: picture ? 1 : bundles.length }, (_, j) => index + j),
      ]),
      index,
      count: picture ? 0 : bundles.length,
      ...(created.length ? { sourceIds: created } : {}),
    };
  }

  pasteSlide(op: PasteSlideOp): PasteSlideResult | null {
    if (!slideClipboard) return null;
    const before = this.beforePaths();
    this.pushHistory();
    const r = this.performSlidePaste(op, before);
    if (!r) {
      this.undoStack.pop();
      this.refreshDirty();
      this.notifyHistory();
      return null;
    }
    lastSlidePaste = {
      afterIndex: op.afterIndex,
      undoLen: this.undoStack.length,
      changed: op.mode === 'picture' ? [r.index] : [],
    };
    return r;
  }

  /**
   * Paste-options floater: undo the just-completed paste and redo it with another
   * mode. Refused when anything (an edit, ⌘Z) touched the deck in between.
   */
  repasteSlide(op: RepasteSlideOp): PasteSlideResult | null {
    const rec = lastSlidePaste;
    if (!slideClipboard || !rec) return null;
    if (this.undoStack.length !== rec.undoLen) return null;
    const snap = this.undoStack.pop();
    if (!snap) return null;
    const before = this.beforePaths();
    this.restore(snap);
    this.pushHistory();
    const r = this.performSlidePaste(
      { afterIndex: rec.afterIndex, fitWidthPx: op.fitWidthPx, mode: op.mode },
      before,
      rec.changed,
    );
    if (!r) {
      this.undoStack.pop();
      this.refreshDirty();
      this.notifyHistory();
      return null;
    }
    rec.undoLen = this.undoStack.length;
    rec.changed = op.mode === 'picture' ? [r.index] : [];
    return r;
  }

  // ── sections ────────────────────────────────────────────────────────

  setSections(sections: SectionInfo[]): SectionInfo[] | null {
    const r = this.commit([{ op: 'setSections', sections }], 'atomic', true);
    return r.applied ? getSections(this.opened) : null;
  }

  addSection(op: AddSectionOp): SectionInfo[] | null {
    const r = this.commit(
      [{ op: 'addSection', atSlideIndex: op.atSlideIndex, name: op.name }],
      'atomic',
      true,
    );
    return r.applied ? getSections(this.opened) : null;
  }

  renameSection(op: RenameSectionOp): SectionInfo[] | null {
    const r = this.commit(
      [{ op: 'renameSection', id: op.id, name: op.name }],
      'atomic',
      true,
    );
    return r.applied ? getSections(this.opened) : null;
  }

  removeSection(op: RemoveSectionOp): SectionInfo[] | null {
    const r = this.commit([{ op: 'removeSection', id: op.id }], 'atomic', true);
    return r.applied ? getSections(this.opened) : null;
  }

  /** A section header + its slides in one undo step; the deck keeps ≥1 slide. */
  removeSectionSlides(op: RemoveSectionSlidesOp): (SlideUpdate & { sections: SectionInfo[] }) | null {
    const before = this.beforePaths();
    const total = this.opened.deck.slides.length;
    const { lead, sections } = normalizeSections(getSections(this.opened), total);
    const indices = op.id == null ? lead : sections.find((s) => s.id === op.id)?.slideIndices;
    if (!indices || indices.length >= total) return null;
    // Highest index first: the numeric targets stay valid as the deck shrinks.
    const ops: Op[] = [...indices]
      .reverse()
      .map((i) => ({ op: 'deleteSlide', target: { slide: i } }));
    if (op.id != null) ops.push({ op: 'removeSection', id: op.id });
    if (!ops.length) return null;
    const r = this.commit(ops, 'atomic', true);
    if (!r.applied) return null;
    return { ...this.slideUpdate(before), sections: getSections(this.opened) };
  }

  // ── master editing ──────────────────────────────────────────────────

  private masterEdit: { partPath: string; slide: Slide } | null = null;

  /** Enter master view: [master, ...layouts] as render trees; the master is the edit target. */
  masterEnter(fitWidthPx: number): MasterEnterResult | null {
    this.fitWidthPx = fitWidthPx;
    const items: MasterEnterResult['items'] = [];
    for (const p of listMasterParts(this.opened.archive)) {
      const slide = parseMasterPart(this.opened.archive, p.partPath);
      if (!slide) continue;
      const rendered = buildRenderSlide(slide, this.opened.deck.size, {
        fitWidthPx,
        media: (this.media ??= makeMediaResolver(this.opened)),
      });
      items.push({ partPath: p.partPath, kind: p.kind, name: p.name, slide: rendered });
      if (!this.masterEdit) this.masterEdit = { partPath: p.partPath, slide };
    }
    return items.length ? { items } : null;
  }

  masterOpen(partPath: string): RenderSlide | null {
    const slide = parseMasterPart(this.opened.archive, partPath);
    if (!slide) return null;
    this.masterEdit = { partPath, slide };
    return this.masterRender();
  }

  masterClose(): RenderSlide[] | null {
    this.masterEdit = null;
    return this.rebuildAll();
  }

  private masterRender(): RenderSlide | null {
    const me = this.masterEdit;
    if (!me) return null;
    return buildRenderSlide(me.slide, this.opened.deck.size, {
      fitWidthPx: this.fitWidthPx,
      media: (this.media ??= makeMediaResolver(this.opened)),
    });
  }

  /**
   * Master edits are part-addressed ops seeded with the live master slide: ops
   * mutate that object (parse-time ids stay stable for the renderer's selection)
   * and the executor flushes it back into the package entries.
   */
  private masterTxn(op: Op): boolean {
    const me = this.masterEdit;
    if (!me) return false;
    this.pushHistory();
    const r = runTxn(this.opened, { ops: [op], parts: new Map([[me.partPath, me.slide]]) });
    if (!r.applied) {
      this.undoStack.pop();
      this.refreshDirty();
      this.notifyHistory();
      return false;
    }
    this.refreshDirty();
    this.notifyHistory();
    return true;
  }

  masterEditText(op: MasterEditTextOp): RenderSlide | null {
    const me = this.masterEdit;
    if (!me) return null;
    const ok = this.masterTxn({
      op: 'setText',
      target: { part: me.partPath, el: op.sourceId },
      paragraphs: op.paragraphs,
    });
    return ok ? this.masterRender() : null;
  }

  masterEditTransform(op: MasterEditTransformOp): RenderSlide | null {
    const me = this.masterEdit;
    if (!me) return null;
    const el = me.slide.elements.find((x) => x.id === op.sourceId);
    if (!el) return null;
    const scale = op.fitWidthPx / (this.opened.deck.size.cx / EMU_PER_PX_96);
    const toEmu = (px: number): number => Math.round((px / scale) * EMU_PER_PX_96);
    if (op.preview) {
      // Preview frames are not persisted: mutate the live master slide only; the
      // final commit goes through the op executor against the entry bytes.
      if (!this.transformPreview) {
        this.pushHistory();
        this.transformPreview = true;
      }
      const mutable = el as unknown as {
        transform: { offset: { x: number; y: number; cx: number; cy: number }; rot: number };
      };
      mutable.transform = {
        ...mutable.transform,
        offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
        rot: Math.round(op.rotationDeg * 60000),
      };
      this.refreshDirty();
      this.notifyHistory();
      return this.masterRender();
    }
    const payload: Op = {
      op: 'setTransform',
      target: { part: me.partPath, el: op.sourceId },
      box: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
      rotDeg: op.rotationDeg,
    };
    if (this.transformPreview) {
      // The gesture's first preview frame already pushed the undo step.
      this.transformPreview = false;
      const r = runTxn(this.opened, { ops: [payload], parts: new Map([[me.partPath, me.slide]]) });
      if (!r.applied) return null;
      this.refreshDirty();
      this.notifyHistory();
      return this.masterRender();
    }
    return this.masterTxn(payload) ? this.masterRender() : null;
  }

  masterEditFill(op: MasterEditFillOp): RenderSlide | null {
    const me = this.masterEdit;
    if (!me) return null;
    const fill =
      typeof op.fill === 'string'
        ? op.fill
        : {
            stops: gradientStops(op.fill.gradient),
            ...((pk) =>
              pk
                ? {
                    path: pk,
                    ...((ft) => (ft ? { fillTo: ft } : {}))(gradientFillTo(op.fill.gradient)),
                  }
                : { angle: Math.round((op.fill.gradient.angleDeg ?? 0) * 60000) })(
              gradientPathKind(op.fill.gradient),
            ),
          };
    const ok = this.masterTxn({
      op: 'setFill',
      target: { part: me.partPath, el: op.sourceId },
      fill,
    });
    return ok ? this.masterRender() : null;
  }

  masterEditStroke(op: MasterEditStrokeOp): RenderSlide | null {
    const me = this.masterEdit;
    if (!me) return null;
    const ok = this.masterTxn({
      op: 'setStroke',
      target: { part: me.partPath, el: op.sourceId },
      stroke: op.stroke
        ? { color: op.stroke.color, widthEmu: Math.round(op.stroke.widthPt * EMU_PER_PT) }
        : null,
    });
    return ok ? this.masterRender() : null;
  }

  masterDeleteElement(op: MasterDeleteElementOp): RenderSlide | null {
    const me = this.masterEdit;
    if (!me) return null;
    const ok = this.masterTxn({
      op: 'deleteElement',
      target: { part: me.partPath, el: op.sourceId },
    });
    return ok ? this.masterRender() : null;
  }

  masterAddElement(op: MasterAddElementOp): { slide: RenderSlide; sourceId: string } | null {
    const me = this.masterEdit;
    if (!me) return null;
    const scale = op.fitWidthPx / (this.opened.deck.size.cx / EMU_PER_PX_96);
    const toEmu = (px: number): number => Math.round((px / scale) * EMU_PER_PX_96);
    this.pushHistory();
    const r = runTxn(this.opened, {
      ops: [
        {
          op: 'addElement',
          target: { part: me.partPath },
          kind: op.kind,
          offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
          ...(op.paragraphs?.length ? { paragraphs: op.paragraphs } : {}),
          ...(op.fillColor ? { fill: op.fillColor } : {}),
          ...(op.stroke
            ? { stroke: { color: op.stroke.color, widthEmu: Math.round(op.stroke.widthPt * EMU_PER_PT) } }
            : {}),
          ...(op.bodyPr ? { bodyPr: op.bodyPr } : {}),
        },
      ],
      parts: new Map([[me.partPath, me.slide]]),
    });
    const sourceId = r.records?.[0]?.created?.[0];
    if (!r.applied || !sourceId) {
      this.undoStack.pop();
      this.refreshDirty();
      this.notifyHistory();
      return null;
    }
    this.refreshDirty();
    this.notifyHistory();
    const slide = this.masterRender();
    return slide ? { slide, sourceId } : null;
  }

  /** Parse the page again after an archive-level edit (tables/charts rebuild ids). */
  rebuildWithReparse(slideIndex: number): RenderSlide | null {
    const fresh = materializeSlide(this.opened, slideIndex);
    if (!fresh) return null;
    return buildRenderSlide(fresh, this.opened.deck.size, {
      fitWidthPx: this.fitWidthPx,
      media: (this.media ??= makeMediaResolver(this.opened)),
      slideNo: slideIndex + 1,
    });
  }

  /**
   * `autofit="shrink"` write-back: when the shrink ratio the layout now uses
   * differs from the stored one, sync the model and patch bodyPr — only then
   * does PowerPoint show the same size on open. Ported from upstream; metrics
   * are the same heuristic provider the render uses.
   */
  private syncAutofitScale(
    slideIndex: number,
    sourceId: string,
    rendered: RenderSlide | null,
  ): RenderSlide | null {
    if (!rendered) return rendered;
    const slide = this.opened.deck.slides[slideIndex];
    const el = slide ? findTextEl(slide, sourceId) : undefined;
    if (!el?.text || el.text.autofit !== 'shrink') return rendered;
    const node = rendered.nodes.find((n) => n.sourceId === el.id);
    if (!node || (node.type !== 'shape' && node.type !== 'text') || !node.text) return rendered;
    const refit = layoutText({
      body: el.text,
      boxWidthPx: node.box.w,
      boxHeightPx: node.box.h,
      metrics: HEURISTIC_METRICS,
      vp: makeViewport(this.opened.deck.size, this.fitWidthPx),
      refitAutofit: true,
    });
    const effective = refit.fontScale;
    const effectiveRed = refit.lnSpcReduction ?? 0;
    if (
      Math.abs(effective - (el.text.fontScale ?? 1)) < 0.005 &&
      Math.abs(effectiveRed - (el.text.lnSpcReduction ?? 0)) < 0.005
    ) {
      return rendered;
    }
    el.text.fontScale = effective;
    if (effectiveRed) el.text.lnSpcReduction = effectiveRed;
    else delete el.text.lnSpcReduction;
    el.anchor.originalXml = patchBodyPrAutofit(el.anchor.originalXml, effective, effectiveRed);
    slide!.structureDirty = true;
    return this.rebuild(slideIndex) ?? rendered;
  }

  // ── notes / comments ────────────────────────────────────────────────

  getNotes(slideIndex: number): string {
    const slide = this.opened.deck.slides[slideIndex];
    return slide ? getSlideNotes(this.opened.archive, slide.path) : '';
  }

  setNotes(op: SetNotesOp): boolean {
    const r = this.commit(
      [{ op: 'setNotes', target: { slide: op.slideIndex }, text: op.text }],
      'atomic',
      true,
    );
    return r.applied;
  }

  getComments(slideIndex: number): ReturnType<typeof getSlideComments> {
    const slide = this.opened.deck.slides[slideIndex];
    return slide ? getSlideComments(this.opened.archive, slide.path) : [];
  }

  addComment(op: AddCommentOp): ReturnType<typeof getSlideComments> | null {
    const r = this.commit(
      [
        {
          op: 'addComment',
          target: { slide: op.slideIndex },
          author: COMMENT_AUTHOR,
          text: op.text,
        },
      ],
      'atomic',
      true,
    );
    return r.applied ? this.getComments(op.slideIndex) : null;
  }

  deleteComment(op: DeleteCommentOp): ReturnType<typeof getSlideComments> | null {
    const r = this.commit(
      [
        {
          op: 'deleteComment',
          target: { slide: op.slideIndex },
          authorId: op.authorId,
          idx: op.idx,
        },
      ],
      'atomic',
      true,
    );
    return r.applied ? this.getComments(op.slideIndex) : null;
  }

  // ── find / replace ──────────────────────────────────────────────────

  findReplace(op: FindReplaceOp): { count: number; update: SlideUpdate | null } {
    const before = this.beforePaths();
    const r = this.commit(
      [
        {
          op: 'findReplace',
          find: op.find,
          replace: op.replace,
          matchCase: op.matchCase,
          firstOnly: op.firstOnly,
          slideIndex: op.slideIndex,
          elementId: op.elementId,
        },
      ],
      'atomic',
      true,
    );
    if (!r.applied) return { count: 0, update: null };
    const { count, changedSlides } = (r.records?.[0] as unknown as {
      after?: { count: number; changedSlides: number[] };
    })?.after ?? { count: 0, changedSlides: [] };
    return { count, update: this.slideUpdate(before, changedSlides) };
  }

  // ── background ──────────────────────────────────────────────────────

  /**
   * Background edits. The image kind needs a file, which the host owns: the
   * panel asks it for a path and reads the bytes itself, the same split the
   * reader uses.
   */
  async editBackground(op: EditBackgroundOp): Promise<SlideUpdate | null> {
    const slides = this.opened.deck.slides;
    const before = this.beforePaths();
    const targets = (op.slideIndex === -1 ? slides : [slides[op.slideIndex]]).filter(
      (s): s is Slide => !!s,
    );
    if (targets.length === 0) return null;

    if (op.kind === 'image') {
      let source: { bytes: Uint8Array; ext: string } | { mediaPath: string };
      if (op.pick !== false) {
        const picked = await backend<{ path?: string | null }>('file.pickFile', {
          title: '插入图片',
          filters: [
            {
              name: '图片',
              extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff'],
            },
          ],
        });
        if (!picked?.path) return null;
        source = {
          bytes: await readFileBytes(picked.path),
          ext: picked.path.split('.').pop()!.toLowerCase(),
        };
      } else {
        // Reuse an already-landed background image (mode change / apply-to-all).
        const src = slides[op.sourceSlideIndex ?? op.slideIndex];
        if (src?.background?.type !== 'image') return null;
        source = { mediaPath: src.background.mediaRef };
      }
      this.pushHistory();
      // The picked bytes land as one media part; the other slides only add a rel
      // to it — each op reports the landed media path for the next one.
      let landed: string | null = null;
      for (const [i, s] of slides.entries()) {
        if (!targets.includes(s)) continue;
        const r = runTxn(this.opened, {
          ops: [
            {
              op: 'setBackground',
              target: { slide: i },
              kind: 'image',
              source: landed ? { mediaPath: landed } : source,
              tile: op.mode === 'tile',
            },
          ],
        });
        if (r.applied) {
          const used = (r.records?.[0]?.after as { mediaPath?: string } | undefined)?.mediaPath;
          if (used) landed = used;
        }
      }
      if (!landed) {
        this.undoStack.pop();
        this.refreshDirty();
        this.notifyHistory();
        return null;
      }
      this.refreshDirty();
      this.notifyHistory();
    } else {
      const common: Record<string, unknown> =
        op.kind === 'solid'
          ? { kind: 'solid', color: op.color }
          : op.kind === 'gradient'
            ? {
                kind: 'gradient',
                from: op.from,
                to: op.to,
                ...(op.angleDeg !== undefined ? { angleDeg: op.angleDeg } : {}),
                ...(op.radial ? { radial: true } : {}),
              }
            : op.kind === 'reset'
              ? { kind: 'reset' }
              : { kind: 'graphics', hidden: op.hidden };
      // One transaction for every target page = one undo step.
      const r = this.commit(
        slides
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => targets.includes(s))
          .map(({ i }) => ({ op: 'setBackground', target: { slide: i }, ...common })),
        'atomic',
        true,
      );
      if (!r.applied) return null;
    }
    this.fitWidthPx = op.fitWidthPx;
    return this.slideUpdate(
      before,
      targets.map((s) => slides.indexOf(s)),
    );
  }

  // ── autofit (resize only) ───────────────────────────────────────────

  /**
   * `autofit="resize"` boxes grow/shrink to their text. Ported from upstream's
   * `applyAutofitResize`: the mutation lands on the model's transform, so the
   * next save writes the new box size.
   */
  private applyAutofitResize(
    slideIndex: number,
    sourceId: string,
    rendered: RenderSlide | null,
  ): RenderSlide | null {
    if (!rendered) return rendered;
    const slide = this.opened.deck.slides[slideIndex];
    const el = slide ? findTextEl(slide, sourceId) : undefined;
    if (!el?.text || el.text.autofit !== 'resize') return rendered;
    const node = rendered.nodes.find((n) => n.sourceId === el.id);
    if (!node || (node.type !== 'shape' && node.type !== 'text') || !node.text) return rendered;
    const text = node.text;
    const needH = text.contentHeight + text.insets.t + text.insets.b;
    const needW = !text.wrap && !text.vert ? nowrapContentWidth(text) : node.box.w;
    if (Math.abs(needH - node.box.h) < 1 && Math.abs(needW - node.box.w) < 1) return rendered;
    const baseWidthPx = this.opened.deck.size.cx / EMU_PER_PX_96;
    const scale = this.fitWidthPx / baseWidthPx;
    const toEmu = (px: number): number => Math.max(Math.round((px / scale) * EMU_PER_PX_96), 1);
    // A nowrap box grows around its alignment: right-aligned keeps the right edge.
    const align = text.lines[0]?.align;
    const shiftX = align === 'right' ? node.box.w - needW : align === 'center' ? (node.box.w - needW) / 2 : 0;
    // The model's transform is mutable state, not a readonly render structure.
    const mutable = el as unknown as {
      transform: { offset: { x: number; cx: number; cy: number } };
      dirtyTransform?: boolean;
    };
    mutable.transform = {
      ...mutable.transform,
      offset: {
        ...mutable.transform.offset,
        x: mutable.transform.offset.x + Math.round((shiftX / scale) * EMU_PER_PX_96),
        cx: toEmu(needW),
        cy: toEmu(needH),
      },
    };
    mutable.dirtyTransform = true;
    return this.rebuild(slideIndex);
  }
}
