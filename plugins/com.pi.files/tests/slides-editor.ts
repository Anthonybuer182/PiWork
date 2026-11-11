/**
 * The panel editor contract — what `src/ui/slides/editor.ts` promises the
 * renderer, exercised headlessly.
 *
 * The renderer applies the `RenderSlide` each edit returns to its own state, so
 * "the edit worked" has two halves that must agree: the model changed AND the
 * returned render shows it. Pinning only the model would let a stale rebuild
 * ship; the panel would look unchanged while the file changed underneath.
 *
 * Also pinned here, because each one was a real decision:
 *   - undo/redo restore the whole deck (the renderer replaces its slide list)
 *   - a rejected op leaves the deck untouched and does not push a history step
 *   - saved bytes carry the edits (a save that writes the pre-edit deck is the
 *     one failure that silently loses the user's work)
 */
import { createBlankPptx, openPptx, type OpenedPptx } from '@genoffice/pptx-engine';
import { runTxn } from '@genoffice/pptx-ops';
import { SlideEditor } from '../src/ui/slides/editor';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const slideText = (opened: OpenedPptx, slideIndex = 0): string =>
  (opened.deck.slides[slideIndex]?.elements ?? [])
    .map((el) => {
      const text = (el as { text?: { paragraphs?: Array<{ runs?: Array<{ text?: string }> }> } }).text;
      return (text?.paragraphs ?? []).map((p) => (p.runs ?? []).map((r) => r.text ?? '').join('')).join('\n');
    })
    .join('\n');

const renderText = (slide: { nodes: Array<{ text?: { lines: Array<{ runs: Array<{ text: string }> }> } }> } | null): string =>
  (slide?.nodes ?? [])
    .map((n) => (n.text?.lines ?? []).map((l) => l.runs.map((r) => r.text).join('')).join('\n'))
    .join('\n');

console.log('slides panel editor\n');

// ── a deck with one text box ────────────────────────────────────────────
const opened = await openPptx(await createBlankPptx());
const added = runTxn(opened, {
  ops: [
    {
      op: 'addElement',
      target: { slide: 0 },
      kind: 'textbox',
      offset: { x: 1143000, y: 1143000, cx: 4572000, cy: 1143000 },
      paragraphs: [{ runs: [{ text: 'Hello' }] }],
    },
  ],
});
check('fixture: a text box exists', added.applied === true, JSON.stringify(added.failures ?? null));
const elId = (opened.deck.slides[0]?.elements ?? []).find((el) => el.type === 'text' || el.type === 'shape')?.id as string;
check('fixture: the text box has an id', typeof elId === 'string' && elId.length > 0);

const editor = new SlideEditor(opened, '/tmp/does-not-matter.pptx', 960, null);
check('fixture: the deck starts clean', editor.dirty === false);

// ── text ────────────────────────────────────────────────────────────────
const textEdit = editor.editText({
  slideIndex: 0,
  sourceId: elId,
  paragraphs: [{ runs: [{ text: '手动改过的标题' }] }],
} as never);
check('editText returns the rebuilt slide', textEdit !== null);
check('editText changed the model', slideText(opened).includes('手动改过的标题'), slideText(opened));
check('the returned render shows the new text', renderText(textEdit).includes('手动改过的标题'), renderText(textEdit));
check('editText marks the deck dirty', editor.dirty === true);

// ── font ────────────────────────────────────────────────────────────────
const fontEdit = editor.setElementFont({
  slideIndex: 0,
  sourceIds: [elId],
  bold: true,
  color: '#C0392B',
} as never);
const run = fontEdit?.nodes[0]?.text?.lines[0]?.runs[0] as { bold?: boolean; color?: string } | undefined;
check('setElementFont returns the rebuilt slide', fontEdit !== null);
check('the returned render carries the bold flag', run?.bold === true, JSON.stringify(run));
check('the returned render carries the colour', run?.color === '#C0392B', JSON.stringify(run));

// ── fill ────────────────────────────────────────────────────────────────
const fillEdit = editor.editFill({ slideIndex: 0, sourceId: elId, fill: '#EAF2FB' } as never);
const fill = fillEdit?.nodes[0]?.fill as { kind?: string; color?: string } | undefined;
check('editFill returns the rebuilt slide', fillEdit !== null);
check('the returned render carries the solid fill', fill?.kind === 'solid' && fill?.color === '#EAF2FB', JSON.stringify(fill));

// ── undo / redo ─────────────────────────────────────────────────────────
const undone = editor.undo();
const undoneFill = undone?.[0]?.nodes[0]?.fill as { color?: string } | undefined;
check('undo restores the previous fill', undoneFill?.color !== '#EAF2FB', JSON.stringify(undoneFill));
check('undo keeps the text edit', slideText(opened).includes('手动改过的标题'));
const redone = editor.redo();
const redoneFill = redone?.[0]?.nodes[0]?.fill as { color?: string } | undefined;
check('redo reapplies the fill', redoneFill?.color === '#EAF2FB', JSON.stringify(redoneFill));

// ── a rejected op changes nothing ───────────────────────────────────────
const beforeText = slideText(opened);
const rejected = editor.editText({
  slideIndex: 0,
  sourceId: 'no-such-element',
  paragraphs: [{ runs: [{ text: 'should not land' }] }],
} as never);
check('a rejected edit returns null', rejected === null);
check('a rejected edit leaves the deck untouched', slideText(opened) === beforeText);
const afterRejectUndo = editor.undo();
const afterRejectUndoFill = afterRejectUndo?.[0]?.nodes[0]?.fill as { color?: string } | undefined;
check('a rejected edit did not push an empty history step', afterRejectUndoFill?.color !== '#EAF2FB');
// The undo above is what removed the fill; put it back so the save below has
// something to lose.
editor.redo();

// ── save ────────────────────────────────────────────────────────────────
const bytes = await editor.toBytes();
const reopened = await openPptx(bytes);
const reopenedSlides = new SlideEditor(reopened, '/tmp/reopened.pptx', 960, null).rebuildAll();
check('the saved bytes carry the text edit', renderText(reopenedSlides[0]).includes('手动改过的标题'), renderText(reopenedSlides[0]));
const reopenedFill = reopenedSlides[0]?.nodes[0]?.fill as { color?: string } | undefined;
check('the saved bytes carry the fill', reopenedFill?.color === '#EAF2FB', JSON.stringify(reopenedFill));
const slides = editor.markSaved(1234);
check('markSaved clears the dirty flag', editor.dirty === false);
check('markSaved adopts the new mtime baseline', editor.mtime === 1234);
check('markSaved returns the re-rendered deck', slides.length === opened.deck.slides.length);

// Dirty is "not at the save point", not a one-way latch: undoing past the save
// is dirty, and redoing back to it is clean again — which is what lets the panel
// accept an external reload once the user has undone everything they had
// unsaved.
editor.undo();
check('undoing past the save point is dirty', editor.dirty === true);
editor.redo();
check('redoing back to the save point is clean', editor.dirty === false);

// ── paragraph format ────────────────────────────────────────────────────
const aligned = editor.setElementParagraphFormat({
  slideIndex: 0,
  sourceIds: [elId],
  align: 'center',
} as never);
check('setElementParagraphFormat returns the rebuilt slide', aligned !== null);
check(
  'the returned render carries the alignment',
  aligned?.nodes[0]?.text?.lines[0]?.align === 'center',
  JSON.stringify(aligned?.nodes[0]?.text?.lines[0]?.align),
);

// ── stroke ──────────────────────────────────────────────────────────────
const stroked = editor.editStroke({
  slideIndex: 0,
  sourceId: elId,
  stroke: { color: '#112233', widthPt: 2 },
} as never);
const stroke = stroked?.nodes[0]?.stroke as { color?: string; widthPt?: number } | undefined;
check('editStroke returns the rebuilt slide', stroked !== null);
check(
  'the returned render carries the stroke',
  stroke?.color === '#112233' && Math.abs((stroke?.widthPt ?? 0) - 2) < 0.01,
  JSON.stringify(stroke),
);

// ── transform ───────────────────────────────────────────────────────────
const box0 = editor.rebuild(0)?.nodes[0]?.box as { x: number; y: number; w: number; h: number };
const moved = editor.editTransform({
  slideIndex: 0,
  sourceId: elId,
  xPx: box0.x + 50,
  yPx: box0.y + 20,
  wPx: box0.w,
  hPx: box0.h,
  rotationDeg: 0,
  fitWidthPx: 960,
} as never);
const box1 = moved?.nodes[0]?.box as { x: number; y: number } | undefined;
check('editTransform returns the rebuilt slide', moved !== null);
check(
  'the returned render box matches the requested pixels',
  !!box1 && Math.abs(box1.x - (box0.x + 50)) < 2 && Math.abs(box1.y - (box0.y + 20)) < 2,
  JSON.stringify(box1),
);

// A drag: many preview frames, one commit — and ONE undo step.
const dragBase = editor.rebuild(0)?.nodes[0]?.box as { x: number; y: number; w: number; h: number };
const dragFrame = (dx: number, preview: boolean) =>
  editor.editTransform({
    slideIndex: 0,
    sourceId: elId,
    xPx: dragBase.x + dx,
    yPx: dragBase.y,
    wPx: dragBase.w,
    hPx: dragBase.h,
    rotationDeg: 0,
    fitWidthPx: 960,
    preview,
  } as never);
dragFrame(10, true);
dragFrame(20, true);
const dragCommitted = dragFrame(30, false);
const dragX = dragCommitted?.nodes[0]?.box as { x: number } | undefined;
check('the committed drag frame lands at +30px', !!dragX && Math.abs(dragX.x - (dragBase.x + 30)) < 2, JSON.stringify(dragX));
const dragUndo = editor.undo();
const dragUndoX = dragUndo?.[0]?.nodes[0]?.box as { x: number } | undefined;
check(
  'one undo reverts the whole drag',
  !!dragUndoX && Math.abs(dragUndoX.x - dragBase.x) < 2,
  JSON.stringify(dragUndoX),
);

// ── element add / delete ────────────────────────────────────────────────
const newBox = editor.addElement({
  slideIndex: 0,
  kind: 'textbox',
  xPx: 100,
  yPx: 400,
  wPx: 300,
  hPx: 80,
  fitWidthPx: 960,
  text: 'new box',
} as never);
check('addElement returns the slide and the new id', !!newBox?.sourceId, JSON.stringify(newBox && Object.keys(newBox)));
check(
  'the returned render contains the new element',
  !!newBox && newBox.slide.nodes.some((n) => n.sourceId === newBox.sourceId),
);
const deleted = editor.deleteElement({ slideIndex: 0, sourceId: newBox?.sourceId } as never);
check(
  'deleteElement removes it from the render',
  !!deleted && !deleted.nodes.some((n) => n.sourceId === newBox?.sourceId),
);

// per_op: an id that is already gone is skipped, the rest still deletes.
const twoBoxes = editor.addElement({
  slideIndex: 0,
  kind: 'textbox',
  xPx: 120,
  yPx: 460,
  wPx: 200,
  hPx: 60,
  fitWidthPx: 960,
  text: 'temp',
} as never);
const multiDelete = editor.deleteElements({
  slideIndex: 0,
  sourceIds: [twoBoxes?.sourceId, 'already-gone'],
} as never);
check(
  'deleteElements skips ids that are already gone',
  !!multiDelete && !multiDelete.nodes.some((n) => n.sourceId === twoBoxes?.sourceId),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
