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

// ── slide structure & document settings ────────────────────────────────
// A fresh deck: the block above left the first one with a long history.
const deck = await openPptx(await createBlankPptx());
const slideEditor = new SlideEditor(deck, '/tmp/slides-structure.pptx', 960, null);
const initialCount = deck.deck.slides.length;

const addedBlank = slideEditor.addBlankSlide({ sourceIndex: 0, fitWidthPx: 960 } as never);
check('addBlankSlide adds one page', addedBlank?.order.length === initialCount + 1);
check('the update carries the new page', !!addedBlank?.slides.some((s) => s.partPath === addedBlank.order[1]));
check('the update names the new page index', addedBlank?.index === 1, JSON.stringify(addedBlank?.index));

const dup = slideEditor.duplicateSlides({ slideIndexes: [0], fitWidthPx: 960 } as never);
check('duplicateSlides adds one page', dup?.order.length === initialCount + 2);
check('the copy lands right after its source', dup?.index === 1, JSON.stringify(dup?.index));

const movedSlide = slideEditor.moveSlide({ fromIndex: 0, toIndex: 2 } as never);
check('moveSlide reports the new order', movedSlide?.order.length === initialCount + 2);
check('moveSlide returns the section list', Array.isArray(movedSlide?.sections));

const removed = slideEditor.deleteSlides({ slideIndexes: [1] } as never);
check('deleteSlides removes one page', removed?.order.length === initialCount + 1);
const refused = slideEditor.deleteSlides({ slideIndexes: [0, 1, 2] } as never);
check('deleteSlides refuses to empty the deck', refused === null);

const notes = slideEditor.setNotes({ slideIndex: 0, text: '演讲者备注测试' } as never);
check('setNotes reports success', notes === true);
check('getNotes reads it back', slideEditor.getNotes(0) === '演讲者备注测试', slideEditor.getNotes(0));

// findReplace needs text on the page.
const textBox = slideEditor.addElement({
  slideIndex: 0,
  kind: 'textbox',
  xPx: 80,
  yPx: 80,
  wPx: 400,
  hPx: 80,
  fitWidthPx: 960,
  text: 'foo bar foo',
} as never);
check('the fixture text box exists', !!textBox?.sourceId);
const replaced = slideEditor.findReplace({
  find: 'foo',
  replace: 'baz',
  matchCase: false,
} as never);
check('findReplace counts the hits', replaced.count === 2, JSON.stringify(replaced.count));
check(
  'findReplace returns an update for the deck',
  !!replaced.update && replaced.update.order.length === deck.deck.slides.length,
  JSON.stringify(replaced.update && replaced.update.slides.length),
);
check(
  'findReplace changed the model',
  slideText(deck).includes('baz bar baz'),
  slideText(deck),
);

// 4:3 — createBlankPptx ships 16:9, and a same-size request is a no-op the
// op reports as a failure.
const sized = slideEditor.setSlideSize({ cx: 9144000, cy: 6858000 } as never);
check('setSlideSize rebuilds the deck', !!sized && sized.length === deck.deck.slides.length);
check('getSlideSize reports the new size', slideEditor.getSlideSize().cx === 9144000);

const hidden = slideEditor.setSlidesHidden({ slideIndexes: [0], hidden: true } as never);
check('setSlidesHidden returns the changed page', !!hidden?.slides.some((s) => s.partPath === hidden.order[0]));

const bg = await slideEditor.editBackground({
  slideIndex: 0,
  kind: 'solid',
  color: '#102030',
  fitWidthPx: 960,
} as never);
check('editBackground applies in one step', !!bg?.slides.some((s) => s.partPath === bg.order[0]));
check(
  'the returned page carries the background colour',
  (() => {
    const page = bg?.slides.find((s) => s.partPath === bg.order[0]) as
      | { background?: { kind?: string; color?: string } }
      | undefined;
    return page?.background?.color === '#102030';
  })(),
  JSON.stringify(bg?.slides[0]?.background ?? null),
);

// ── arrange, tables, links, transitions, animations ────────────────────
const deck3 = await openPptx(await createBlankPptx());
const ed3 = new SlideEditor(deck3, '/tmp/slides-verbs.pptx', 960, null);
const boxA = ed3.addElement({
  slideIndex: 0,
  kind: 'textbox',
  xPx: 60,
  yPx: 60,
  wPx: 300,
  hPx: 80,
  fitWidthPx: 960,
  text: 'A',
} as never);
const boxB = ed3.addElement({
  slideIndex: 0,
  kind: 'roundRect',
  xPx: 400,
  yPx: 60,
  wPx: 300,
  hPx: 80,
  fitWidthPx: 960,
  fillColor: '#FFE08A',
} as never);

const grouped = ed3.groupElements({ slideIndex: 0, sourceIds: [boxA?.sourceId, boxB?.sourceId] } as never);
check('groupElements returns a group id', !!grouped?.groupId);
check(
  'the returned render contains a group node',
  !!grouped?.slide.nodes.some((n) => n.type === 'group'),
);
const ungrouped = ed3.ungroupElement({ slideIndex: 0, sourceId: grouped?.groupId } as never);
check(
  'ungroupElement dissolves it again',
  !!ungrouped && !ungrouped.nodes.some((n) => n.type === 'group'),
);
// Ungrouping re-parses the page, so ids are re-minted; everything below has to
// address the elements the way the renderer does — by the ids in the new render.
const idA = ungrouped?.nodes.find(
  (n) => (n as { text?: { lines: Array<{ runs: Array<{ text: string }> }> } }).text?.lines[0]?.runs[0]?.text === 'A',
)?.sourceId as string;
const idB = ungrouped?.nodes.find((n) => n.type === 'shape')?.sourceId as string;
check('the ungrouped render has both elements', !!idA && !!idB);

check('flipElements returns the slide', !!ed3.flipElements({ slideIndex: 0, sourceIds: [idA], axis: 'h' } as never));
check('reorderElement returns the slide', !!ed3.reorderElement({ slideIndex: 0, sourceId: idA, dir: 'front' } as never));

const table = ed3.addTable({
  slideIndex: 0,
  rows: 2,
  cols: 3,
  xPx: 80,
  yPx: 300,
  wPx: 640,
  hPx: 200,
  fitWidthPx: 960,
} as never);
check('addTable returns the new table id', !!table?.sourceId);
check(
  'the returned render contains a table node',
  !!table && table.slide.nodes.some((n) => n.type === 'table' && n.sourceId === table.sourceId),
);
const filled = ed3.editTableCell({
  slideIndex: 0,
  sourceId: table?.sourceId,
  row: 0,
  col: 0,
  paragraphs: [{ runs: [{ text: '表头' }] }],
} as never);
check('editTableCell returns the rebuilt slide', !!filled);
const mergedCells = ed3.tableMerge({
  slideIndex: 0,
  sourceId: table?.sourceId,
  kind: 'merge-right',
  row: 0,
  col: 0,
} as never);
check('tableMerge returns the slide and the (possibly new) id', !!mergedCells?.slide);

// Flip/reorder and the table insert re-parse the page, so ids move again —
// read them from the CURRENT render, the way the renderer's own state does.
const idNow = ed3.rebuild(0)?.nodes.find(
  (n) => (n as { text?: { lines: Array<{ runs: Array<{ text: string }> }> } }).text?.lines[0]?.runs[0]?.text === 'A',
)?.sourceId as string;
check('the text element is still addressable after the reparse', !!idNow);

const linked = ed3.setLink({
  slideIndex: 0,
  sourceId: idNow,
  target: { kind: 'url', url: 'https://example.com' },
} as never);
check('setLink returns the rebuilt slide', !!linked);
check(
  'setLink refuses a javascript: target',
  ed3.setLink({
    slideIndex: 0,
    sourceId: idNow,
    target: { kind: 'url', url: 'javascript:alert(1)' },
  } as never) === null,
);

// Link edits re-parse the page too; re-read the id right before animating.
const idAnim = ed3.rebuild(0)?.nodes.find(
  (n) => (n as { text?: { lines: Array<{ runs: Array<{ text: string }> }> } }).text?.lines[0]?.runs[0]?.text === 'A',
)?.sourceId as string;
check('setTransition reports success', ed3.setTransition({ slideIndex: 0, kind: 'fade' } as never) === true);
check('getTransition reads it back', ed3.getTransition(0) === 'fade', String(ed3.getTransition(0)));
check(
  'setAnimations reports success',
  ed3.setAnimations({
    slideIndex: 0,
    items: [
      {
        sourceId: idAnim,
        effect: 'fade',
        trigger: 'onClick',
        durationMs: 500,
        delayMs: 0,
      },
    ],
  } as never) === true,
);
check(
  'getAnimations maps the spid back to the element',
  ed3.getAnimations(0).some((a) => a.sourceId === idAnim),
  JSON.stringify(ed3.getAnimations(0)),
);

const chart = ed3.addChart({
  slideIndex: 0,
  kind: 'bar',
  categories: ['Q1', 'Q2'],
  series: [{ name: '收入', values: [10, 20] }],
  xPx: 80,
  yPx: 520,
  wPx: 500,
  hPx: 300,
  fitWidthPx: 960,
} as never);
check('addChart returns the new chart id', !!chart?.sourceId);
check('getChartData reads the chart back', !!ed3.getChartData(0, chart?.sourceId));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

// ── clipboard, sections, master ────────────────────────────────────────
const deck4 = await openPptx(await createBlankPptx());
const ed4 = new SlideEditor(deck4, '/tmp/slides-clip.pptx', 960, null);
const clipBox = ed4.addElement({
  slideIndex: 0,
  kind: 'textbox',
  xPx: 100,
  yPx: 100,
  wPx: 260,
  hPx: 70,
  fitWidthPx: 960,
  text: 'clip me',
} as never);

check('copyElements counts what it copied', ed4.copyElements({ slideIndex: 0, sourceIds: [clipBox?.sourceId], clipboardToken: 't1' } as never) === 1);
const pastedEls = ed4.pasteElements({ slideIndex: 0, fitWidthPx: 960 } as never);
check(
  'pasteElements returns ids for the copies',
  !!pastedEls && pastedEls.sourceIds.length === 1 && pastedEls.sourceIds[0] !== clipBox?.sourceId,
);
const dupEls = ed4.duplicateElements({
  slideIndex: 0,
  sourceIds: [pastedEls?.sourceIds[0]],
  dxPx: 12,
  dyPx: 12,
  fitWidthPx: 960,
} as never);
check('duplicateElements returns ids for the copies', !!dupEls && dupEls.sourceIds.length === 1);

check('copySlides reports success', ed4.copySlides({ slideIndexes: [0] } as never) === true);
check('hasSlideClipboard reflects the copy', ed4.hasSlideClipboard() === true);
const pastedSlide = ed4.pasteSlide({ afterIndex: 0, fitWidthPx: 960 } as never);
check(
  'pasteSlide inserts the copied page',
  !!pastedSlide && pastedSlide.order.length === 2 && pastedSlide.index === 1,
  JSON.stringify(pastedSlide && { n: pastedSlide.order.length, i: pastedSlide.index }),
);

const sections = ed4.addSection({ atSlideIndex: 1, name: '第二节' } as never);
check('addSection returns the section list', Array.isArray(sections) && sections.length >= 1, JSON.stringify(sections));
const renamed = ed4.renameSection({ id: sections?.[0]?.id, name: '改名了' } as never);
check('renameSection renames it', !!renamed?.some((s) => s.name === '改名了'), JSON.stringify(renamed));
check('removeSection returns the list', Array.isArray(ed4.removeSection({ id: sections?.[0]?.id } as never)));

const master = ed4.masterEnter(960);
check('masterEnter lists the master and its layouts', !!master && master.items.length >= 1, JSON.stringify(master?.items.length));
// A blank deck's master can be empty; add a box to it, then edit that.
const masterBox = ed4.masterAddElement({
  kind: 'textbox',
  xPx: 80,
  yPx: 80,
  wPx: 400,
  hPx: 80,
  fitWidthPx: 960,
  paragraphs: [{ runs: [{ text: '母版上的字' }] }],
} as never);
check('masterAddElement returns the new id', !!masterBox?.sourceId);
const masterEdited = masterBox
  ? ed4.masterEditText({
      sourceId: masterBox.sourceId,
      paragraphs: [{ runs: [{ text: '母版改过的字' }] }],
    } as never)
  : null;
check(
  'masterEditText returns the repainted master',
  !!masterEdited &&
    masterEdited.nodes.some((n) =>
      (n as { text?: { lines: Array<{ runs: Array<{ text: string }> }> } }).text?.lines.some((l) =>
        // CJK runs are one glyph each; join the line before matching.
        l.runs.map((r) => r.text).join('').includes('母版改过的字'),
      ),
    ),
  JSON.stringify(masterEdited?.nodes.length),
);
const closed = ed4.masterClose();
check(
  'masterClose returns every page again',
  !!closed && closed.length === deck4.deck.slides.length,
  JSON.stringify(closed?.length),
);
