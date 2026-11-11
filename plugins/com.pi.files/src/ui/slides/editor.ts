/**
 * The editable half of the slides panel — GenOffice's edit path, without Electron.
 *
 * Upstream keeps this in its main process (`apps/slides/src/main/slides-main.ts`,
 * 155 IPC handlers, plus `session-state.ts` for the undo journal). A panel has no
 * main process, so this module is the equivalent: it owns the parsed deck, applies
 * the canonical ops from `@genoffice/pptx-ops` to it, and hands back the single
 * `RenderSlide` the renderer expects from every edit call.
 *
 * That return value is why the port is tractable at all: the renderer applies the
 * slide it gets back to its own state (`App.tsx`'s `commitEdit`), so no
 * broadcast/window layer is needed for single-element edits — only undo/redo
 * return the whole deck.
 *
 * Scope right now: text, font, paragraph format, fill, stroke, transform
 * (move/resize/rotate — one undo step per drag), add/delete element, undo/redo,
 * dirty tracking and save. Every other edit method is still a stub in
 * `stubs.ts`; adding one is mechanical — copy the ~20-line handler from
 * upstream, map its payload to the canonical op, run `runTxn`, rebuild the
 * slide.
 *
 * Not ported on purpose, for now:
 *   - autofit `shrink` sync writes a fontScale back into bodyPr; it needs
 *     GenOffice's exact font metrics, which the panel deliberately does not load
 *     (the renderer uses `HeuristicMetrics`). Text may therefore overflow its box
 *     a little before the user resizes it — same as the render itself.
 *   - slide-level structure ops (add/delete/duplicate) and everything else in the
 *     renderer's toolbar.
 */
import {
  findGroupChild,
  matchesElementRef,
  materializeSlide,
  savePptx,
  type OpenedPptx,
  type Slide,
  type TextElement,
} from '@genoffice/pptx-engine';
import {
  EMU_PER_PT,
  EMU_PER_PX_96,
  buildRenderSlide,
  type MediaResolver,
  type RenderSlide,
  type RenderTextLayout,
} from '@genoffice/pptx-render';
import { resolveGroupChildId, runTxn, type Op } from '@genoffice/pptx-ops';
import type {
  AddElementOp,
  BatchEditTransformOp,
  DeleteElementOp,
  DeleteElementsOp,
  EditFillOp,
  EditStrokeOp,
  EditTextOp,
  EditTransformMultiOp,
  EditTransformOp,
  GradientFillSpec,
  SetElementFontOp,
  SetElementParagraphFormatOp,
} from '../../../vendor/genoffice/apps/slides/src/shared/ipc';

const MAX_HISTORY = 50;

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
  readonly path: string;
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
