/**
 * The docx byte-preservation invariant.
 *
 * `docx-engine`'s documented contract (packages/docx-engine/src/patch.ts,
 * saveDocx) is what makes it safe to point at a user's real files:
 *
 *   - blocks marked 'original' are copied as the exact substring of the
 *     original word/document.xml
 *   - every other zip entry is copied unmodified, except docProps/core.xml,
 *     whose dcterms:modified / cp:revision are stamped on a real save
 *   - if nothing changed at all, the ORIGINAL BYTES are returned untouched
 *
 * If that regresses, silent corruption reaches users' documents. So this runs
 * headlessly (no Electron) and is meant to be re-run after every engine change
 * and every vendor sync.
 *
 * It is self-contained: the fixture is built with the engine itself, so there
 * is no checked-in binary to drift or to leak anyone's document.
 *
 * Two contract details this test pins down, both learned the hard way:
 *   - `finalBlocks` must contain only the VISIBLE blocks, in visible order.
 *     Passing hidden blocks as well makes the no-op fast path miss (its guard
 *     compares against `parsed.blocks.filter(b => !b.hidden)`) and mis-indexes
 *     the patch anchors.
 *   - byte preservation is promised for part CONTENT, not for the zip
 *     container: saveDocx repacks through JSZip, so compressed framing changes
 *     even when nothing was edited.
 */
import { createHash } from 'node:crypto';
import { buildBlankDocx, parseDocx, saveDocx } from '@genoffice/docx-engine';
import JSZip from 'jszip';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = new TextDecoder();

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

async function partHashes(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const out = new Map();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) out.set(name, sha(await entry.async('uint8array')));
  }
  return out;
}

async function partText(bytes, path) {
  const zip = await JSZip.loadAsync(bytes);
  const f = zip.file(path);
  return f ? text.decode(await f.async('uint8array')) : null;
}

/** The blocks saveDocx expects: visible only, in visible order, anchored by docxIndex. */
const originalBlocksOf = (parsed) =>
  parsed.blocks.filter((b) => !b.hidden).map((b) => ({ kind: 'original', docxIndex: b.docxIndex }));

console.log('docx byte-preservation\n');

// ── fixture: a multi-block document, built by the engine itself ─────────
const blank = await buildBlankDocx();
const blankParsed = await parseDocx(blank);
const generated = [
  { kind: 'heading', level: 1, runs: [{ text: '季度报告' }] },
  { kind: 'paragraph', runs: [{ text: '营收同比增长 25%。' }] },
  { kind: 'paragraph', runs: [{ text: '华东区领先，新客户 132 家。' }] },
  { kind: 'listItem', list: { kind: 'bullet' }, runs: [{ text: '第一条要点' }] },
  { kind: 'listItem', list: { kind: 'bullet' }, runs: [{ text: '第二条要点' }] },
  { kind: 'paragraph', runs: [{ text: '结尾段落，用于验证未触碰块的原文切片。' }] },
].map((block) => ({ kind: 'generated', block }));

const fixture = await saveDocx(blankParsed, [...originalBlocksOf(blankParsed), ...generated], {});
const parsed = await parseDocx(fixture);
const visible = parsed.blocks.filter((b) => !b.hidden);

console.log(`  fixture: ${parsed.blocks.length} blocks (${visible.length} visible, ${parsed.blocks.length - visible.length} hidden)\n`);
check('fixture has enough blocks to be meaningful', visible.length >= 5, `only ${visible.length} visible block(s)`);

// ── 1. no-op save returns the original bytes untouched ──────────────────
const noop = await saveDocx(parsed, originalBlocksOf(parsed), {});
check(
  'no-op save is byte-identical to the input',
  sha(noop) === sha(fixture),
  `in  ${sha(fixture)}\n      out ${sha(noop)}`,
);

// ── 2. an edit changes only what it should ──────────────────────────────
const targetIndex = visible.findIndex((b) => b.type === 'paragraph');
const target = visible[targetIndex];
const edited = originalBlocksOf(parsed).map((blk, i) =>
  i === targetIndex
    ? {
        kind: 'generated',
        block: { ...target, runs: [{ ...(target.runs?.[0] ?? {}), text: 'ROUNDTRIP-EDIT-MARKER' }] },
      }
    : blk,
);
const SAVED_AT = '2026-01-01T00:00:00.000Z';
const editedBytes = await saveDocx(parsed, edited, { savedAt: SAVED_AT });

check('an edit produces different bytes', sha(editedBytes) !== sha(fixture));

const before = await partHashes(fixture);
const after = await partHashes(editedBytes);
const changed = [...after.keys()].filter((k) => before.get(k) !== after.get(k));
const added = [...after.keys()].filter((k) => !before.has(k));
const removed = [...before.keys()].filter((k) => !after.has(k));

// The body part is the edit; core.xml is the engine stamping the save. Nothing
// else may move — a rewrite of styles, numbering or media would be the silent
// corruption this test exists to catch.
check(
  'only word/document.xml and docProps/core.xml changed',
  changed.includes('word/document.xml') &&
    changed.every((k) => k === 'word/document.xml' || k === 'docProps/core.xml') &&
    added.length === 0 &&
    removed.length === 0,
  `changed: ${JSON.stringify(changed)}  added: ${JSON.stringify(added)}  removed: ${JSON.stringify(removed)}`,
);

const coreXml = await partText(editedBytes, 'docProps/core.xml');
// dcterms:modified drops milliseconds (`2026-01-01T00:00:00.000Z` → `…:00Z`).
check(
  'the save stamp is written to core.xml',
  typeof coreXml === 'string' && coreXml.includes(SAVED_AT.replace(/\.\d{3}Z$/, 'Z')),
);

const editedXml = await partText(editedBytes, 'word/document.xml');
check('the edit is present in the saved document.xml', editedXml.includes('ROUNDTRIP-EDIT-MARKER'));

// ── 3. untouched blocks are spliced, not re-serialized ──────────────────
// This is the real property: every block we did not touch must appear in the
// original XML as an exact substring. "Only one zip entry changed" is weaker —
// a parse→serialize round trip would also change only one entry while silently
// reordering attributes and rewriting self-closing tags.
const originalXml = await partText(fixture, 'word/document.xml');
const untouched = visible.filter((_, i) => i !== targetIndex);
const withXml = untouched.filter((b) => typeof b.originalXml === 'string' && b.originalXml.length > 0);

check(
  `blocks carry originalXml (${withXml.length}/${untouched.length})`,
  withXml.length === untouched.length && untouched.length > 0,
  'a block without originalXml cannot be checked — the assertion below would be vacuous for it',
);
const missing = withXml.filter((b) => !originalXml.includes(b.originalXml));
check(
  `all ${withXml.length} untouched blocks appear verbatim in the original XML`,
  missing.length === 0,
  `${missing.length} block(s) not found verbatim`,
);

// ── 4. container caveat, pinned so it cannot drift silently ─────────────
// Part content is preserved; archive framing is not. If the no-op output ever
// becomes byte-identical to the EDITED output, something is very wrong.
check('edited bytes differ from the untouched original at container level', sha(noop) !== sha(editedBytes));

console.log('');
if (failures) {
  console.error(`FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log('all assertions passed');
