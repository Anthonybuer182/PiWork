#!/usr/bin/env node
/**
 * Drive the built plugin backend in plain Node — no Electron.
 *
 * The backend's transport is `process.parentPort`, so the whole tool surface
 * can be exercised by installing a stand-in port before the module loads —
 * the SDK takes it at import time. That makes this the cheapest real coverage
 * in the project: it runs the same `dist/main.mjs` the app ships, against the
 * same vendored engines, in about a second.
 *
 * It catches a failure mode that is otherwise invisible — a tool registered in
 * the backend but missing from the manifest (or vice versa) looks fine from
 * both sides and simply never runs — and it pins the two behaviours an agent
 * depends on: rejected ops come back as DATA (the host drops `details` on a
 * throw), and a dry run writes nothing.
 *
 * Run from the plugin root:  node scripts/smoke-backend.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(ROOT, 'dist', 'main.mjs');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

// ── A stand-in for Electron's UtilityProcess parentPort ────────────────
//
// The two directions are separate channels and must not be conflated:
// `postMessage` is backend → host, and the `'message'` event is host →
// backend. Replying to a capability call therefore has to happen from inside
// `postMessage` — a `'message'` listener would never see the backend's own
// outgoing calls, and every capability round-trip would hang.
const outbox = [];
const listeners = [];
/** What the backend asked the host for, so a test can assert the write path. */
const capabilityCalls = [];
const written = new Map();

function replyToCall(msg) {
  capabilityCalls.push(msg);
  const params = msg.params ?? {};
  let result = { ok: true };
  if (msg.method === 'filesystem.write') {
    written.set(params.path, Buffer.from(String(params.contentB64 ?? ''), 'base64'));
    result = { path: params.path, mtime: Date.now() };
  }
  setTimeout(() => hostSend({ type: 'call-result', id: msg.id, result }), 0);
}

const fakePort = {
  postMessage: (m) => {
    outbox.push(m);
    if (m && m.type === 'call') replyToCall(m);
  },
  on: (event, cb) => {
    if (event === 'message') listeners.push(cb);
  },
};
// `ports` only rides the ui-port handshake; every other message is data-only,
// and attaching an empty array would be a lie about what the host sent.
const hostSend = (msg, ports) => {
  for (const cb of listeners) cb(ports ? { data: msg, ports } : { data: msg });
};

/** Wait for an outbound message matching `pred`, or time out. */
function waitFor(pred, what, timeoutMs = 20_000) {
  const started = Date.now();
  return new Promise((resolve_, reject) => {
    const tick = () => {
      const i = outbox.findIndex((m) => pred(m) && m.type !== 'call');
      if (i >= 0) return resolve_(outbox.splice(i, 1)[0]);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timed out waiting for ${what}\n  saw: ${JSON.stringify(outbox.map((m) => ({ type: m.type, name: m.name, method: m.method, message: m.message })))}`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

console.log('backend smoke\n');

// The SDK takes the host port at import time and throws without one, so the
// fake has to be in place *before* the module loads — there is no `main()` to
// call any more.
process.parentPort = fakePort;
// Kept as a binding: the module also re-exports the pptx engine, so the test
// can build a real deck with exactly the code the backend ships.
const backend = await import(pathToFileURL(BACKEND).href);
await waitFor((m) => m.type === 'ready', 'the ready handshake');

// The host always sends this before anything else; the SDK hands the plugin id
// and data dir to onInit, and refuses handler calls until it has.
hostSend({ type: 'init', pluginId: 'com.pi.files', apiVersion: 2, dataDir: join(tmpdir(), 'pi-files-smoke-data') });

async function callTool(name, params) {
  const id = `t${Math.random().toString(36).slice(2, 8)}`;
  hostSend({ type: 'tool-call', id, name, params });
  return waitFor((m) => m.type === 'tool-result' && m.id === id, `tool ${name}`);
}

// ── fixture ─────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'pi-files-smoke-'));
const deckPath = join(dir, 'smoke.pptx');
const original = Buffer.from(await backend.createBlankPptx());
writeFileSync(deckPath, original);
console.log(`  fixture: ${deckPath} (${original.length} bytes)\n`);

// ── office_guide: the vocabulary is served as data, not as tools ───────
{
  const r = await callTool('office_guide', { domain: 'pptx' });
  const t = r.content?.[0]?.text ?? '';
  check('office_guide returns a vocabulary', t.length > 200, `only ${t.length} chars`);
  check('the vocabulary names real ops', /addBlankSlide|setFill/.test(t), t.slice(0, 160));
  check('details carry the op count', typeof r.details?.count === 'number' && r.details.count > 20, JSON.stringify(r.details));
  check('details list the groups', Array.isArray(r.details?.groups) && r.details.groups.length > 0);
}
{
  const r = await callTool('office_guide', { domain: 'pptx', group: 'text' });
  check('office_guide returns one group', (r.content?.[0]?.text ?? '').length > 100);
  const bad = await callTool('office_guide', { domain: 'pptx', group: 'not-a-group' });
  check(
    'an unknown group lists the real ones instead of failing',
    /Available:/.test(bad.content?.[0]?.text ?? ''),
    bad.content?.[0]?.text?.slice(0, 120),
  );
}

// ── unwired domains/extensions answer plainly ──────────────────────────
//
// pdf is the remaining one. These assertions used to name docx, which stopped
// being unwired when GenOffice's editor bridge was switched on — keep them
// pointed at a format that genuinely has no path, so a future wiring shows up
// here as a failure rather than as a stale claim.
{
  const r = await callTool('office_guide', { domain: 'pdf' });
  check('an unwired domain says so', /not wired yet/.test(r.content?.[0]?.text ?? ''), r.content?.[0]?.text?.slice(0, 100));
  const r2 = await callTool('office_read', { path: join(dir, 'nope.pdf') });
  check('an unwired extension says so', /not wired yet/.test(r2.content?.[0]?.text ?? ''));
}

// ── office_read ────────────────────────────────────────────────────────
{
  const r = await callTool('office_read', { path: deckPath });
  check('office_read reads a real deck', /slide\(s\)/.test(r.content?.[0]?.text ?? ''), r.content?.[0]?.text);
  check('office_read reports the slide count', r.details?.slideCount === 1, JSON.stringify(r.details?.slideCount));
}

// ── dryRun validates without writing ───────────────────────────────────
{
  const r = await callTool('office_edit', {
    path: deckPath,
    dryRun: true,
    ops: [{ op: 'addBlankSlide', target: { slide: 0 } }],
  });
  check('dry run validates', r.details?.dryRun === true && r.details?.applied === false, JSON.stringify(r.details));
  check('dry run wrote nothing', written.size === 0, `wrote ${[...written.keys()].join(', ')}`);
}

// ── a rejected op comes back as data, not as a throw ───────────────────
{
  const bad = await callTool('office_edit', {
    path: deckPath,
    ops: [{ op: 'addBlankSlide', target: { slide: 99 } }],
  });
  check('a rejected op does not throw', !bad.error, `threw: ${bad.error}`);
  check('a rejected op returns applied:false', bad.details?.applied === false);
  check(
    'a rejected op returns typed failures',
    Array.isArray(bad.details?.failures) && bad.details.failures.length > 0,
    JSON.stringify(bad.details?.failures),
  );
  check(
    'the failure text is actionable',
    /out of range/i.test(bad.details?.failures?.[0]?.error ?? ''),
    bad.details?.failures?.[0]?.error,
  );
  check('a rejected op wrote nothing', written.size === 0);
}

// ── the real edit ──────────────────────────────────────────────────────
{
  const ok = await callTool('office_edit', {
    path: deckPath,
    ops: [{ op: 'addBlankSlide', target: { slide: 0 } }],
  });
  check('a valid batch applies', ok.details?.applied === true, ok.content?.[0]?.text);
  check('the write went through the host capability', written.has(deckPath), `${capabilityCalls.length} capability call(s)`);
  check(
    'the write carries expectedMtime so external changes are detected',
    capabilityCalls.some((c) => c.method === 'filesystem.write' && typeof c.params?.expectedMtime === 'number'),
  );

  const saved = written.get(deckPath);
  check('the saved bytes differ from the original', saved && !saved.equals(original));

  // Re-read through the tool, so the assertion goes through the same parse path.
  writeFileSync(deckPath, saved);
  const reread = await callTool('office_read', { path: deckPath });
  check('the edit survives a re-read', reread.details?.slideCount === 2, `slideCount=${reread.details?.slideCount}`);
}

// ── the file on disk is what the engine wrote ──────────────────────────
{
  const onDisk = await readFile(deckPath);
  check('the file on disk matches what was handed to the host', onDisk.equals(written.get(deckPath)));
}

// ── docx: the panel carries the edit, this side only routes it ─────────
//
// A docx has no headless engine here — GenOffice's document model IS a live
// editor, so the commands go out to the panel and the outcome comes back. The
// panel half (GenOffice's own bridge, switched on by our shim) is verified
// against the real editor separately; what this pins is OUR half: the routing,
// the guard that stops a command being sent to a viewer showing something else,
// and the command sequence office_edit produces.
{
  const docxPath = join(dir, 'smoke.docx');
  // The backend never reads a docx's bytes on this path — it only stats it — so
  // the fixture does not have to be a real document.
  writeFileSync(docxPath, 'placeholder');

  /** Commands the backend pushed at the "panel", in order. */
  const pushed = [];
  let portListener = null;
  const reply = (requestId, ok, extra) =>
    portListener?.({
      data: { kind: 'request', id: 'r' + Math.random().toString(36).slice(2, 8), method: 'mcp.result', params: { requestId, ok, ...extra } },
    });

  const fakeUiPort = {
    postMessage: (m) => {
      if (m?.kind !== 'event' || m.event !== 'mcp-command') return;
      pushed.push({ command: m.data.command, payload: m.data.payload });
      const { requestId, command, payload } = m.data;
      // Answer on a later tick, like the real bridge (it awaits the editor).
      setTimeout(() => {
        if (command === 'read_document') reply(requestId, true, { result: { text: 'FAKE DOCUMENT CONTEXT' } });
        else if (command === 'apply_ops') reply(requestId, true, { result: { summary: 'ok', mutated: true } });
        else if (command === 'save_document') reply(requestId, true, { result: { ok: true, path: payload.path } });
        else reply(requestId, false, { error: `unexpected command ${command}` });
      }, 0);
    },
    on: (event, cb) => {
      if (event === 'message') portListener = cb;
    },
    start: () => {},
  };

  hostSend({ type: 'ui-port' }, [fakeUiPort]);
  // Which document the viewer has open — this is what the guard reads.
  portListener({ data: { kind: 'event', event: 'panel.mounted', data: { params: { file: docxPath } } } });
  // The real panel announces readiness once its editor has the document
  // loaded; office_edit waits for this before sending any command. Without it
  // the backend would wait the full 60s for an announcement that never comes.
  portListener({ data: { kind: 'request', id: 'ready-1', method: 'mcp.ready', params: { path: docxPath } } });

  const guide = await callTool('office_guide', { domain: 'docx' });
  check('office_guide serves the docx vocabulary', /findReplace/.test(guide.content?.[0]?.text ?? ''));
  check('the docx guide states the viewer requirement', /viewer/i.test(guide.content?.[0]?.text ?? ''));
  check('the docx guide does not advertise hidden ops', !/setParagraphAttrs|stepIndent/.test(guide.content?.[0]?.text ?? ''));

  const read = await callTool('office_read', { path: docxPath });
  check('office_read routes through the bridge', read.content?.[0]?.text === 'FAKE DOCUMENT CONTEXT', read.content?.[0]?.text);
  check('read_document was the command sent', pushed.at(-1)?.command === 'read_document');

  pushed.length = 0;
  const edited = await callTool('office_edit', {
    path: docxPath,
    ops: [
      { op: 'setFont', target: { blockIndexes: [0] }, bold: true },
      { op: 'setHeadingLevel', target: { blockIndexes: [0] }, level: 1 },
    ],
  });
  check('office_edit applies then saves', pushed.map((p) => p.command).join(',') === 'apply_ops,save_document', pushed.map((p) => p.command).join(','));
  check('the two ops ride in ONE apply_ops', pushed[0]?.payload?.ops?.length === 2, JSON.stringify(pushed[0]?.payload));
  check('the save targets the document path', pushed[1]?.payload?.path === docxPath);
  check('the save asks to overwrite', pushed[1]?.payload?.overwrite === true);
  check('a real edit reports applied', edited.details?.applied === true, edited.content?.[0]?.text);

  pushed.length = 0;
  const dry = await callTool('office_edit', {
    path: docxPath,
    dryRun: true,
    ops: [{ op: 'setFont', target: { blockIndexes: [0] }, bold: true }],
  });
  check('a dry run validates without saving', pushed.map((p) => p.command).join(',') === 'apply_ops', pushed.map((p) => p.command).join(','));
  check('the dry run flag reaches the bridge', pushed[0]?.payload?.dryRun === true);
  check('a dry run does not claim to have applied', dry.details?.applied === false);

  // The guard: a live editor is the only place these ops can run, so sending
  // one for a document the viewer is not showing has to fail loudly instead of
  // silently editing whatever happens to be open.
  // The guard throws, and a throw surfaces as `error` on the result — the host
  // drops `details` on a throw, which is why the actionable wording has to be in
  // the message itself.
  pushed.length = 0;
  const wrong = await callTool('office_read', { path: join(dir, 'other.docx') });
  check('editing a document the viewer is not showing is refused', pushed.length === 0, `pushed ${pushed.length} command(s)`);
  check(
    'the refusal names the open document and says what to do',
    /viewer/i.test(wrong.error ?? '') && /other\.docx|smoke\.docx/.test(wrong.error ?? ''),
    wrong.error,
  );
}

// ── xlsx: the third engine, end to end ─────────────────────────────────
//
// Until now this file had no runtime coverage at all — it typechecked and
// nothing else — which is how its imports drifted out of sync with what the
// gateway actually exports. Reading and editing a real workbook is the check
// that would have caught it.
{
  const XLSX = await import('xlsx');
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['姓名', '分数'],
    ['甲', 90],
    ['乙', 85],
  ]), 'Sheet1');
  const xlsxPath = join(dir, 'smoke.xlsx');
  writeFileSync(xlsxPath, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));

  const read = await callTool('office_read', { path: xlsxPath });
  const readText = read.content?.[0]?.text ?? '';
  check('office_read reads a real workbook', /Sheet1/.test(readText), readText);
  check('office_read reports cell addresses, which is what an edit targets', /A1=姓名/.test(readText), readText);

  const dry = await callTool('office_edit', {
    path: xlsxPath,
    dryRun: true,
    ops: [{ sheet: 'Sheet1', cell: 'B2', value: 100 }],
  });
  check('an xlsx dry run validates', dry.details?.dryRun === true, dry.content?.[0]?.text);
  check('an xlsx dry run wrote nothing', !written.has(xlsxPath));

  const applied = await callTool('office_edit', {
    path: xlsxPath,
    ops: [{ sheet: 'Sheet1', cell: 'B2', value: 100 }],
  });
  check('an xlsx edit applies', applied.details?.applied === true, applied.content?.[0]?.text);
  check('the xlsx write went through the host capability', written.has(xlsxPath));

  // The fake host keeps writes in memory; put it on disk so the re-read goes
  // through the same parse path the viewer would use.
  writeFileSync(xlsxPath, written.get(xlsxPath));
  const reread = await callTool('office_read', { path: xlsxPath });
  check('the xlsx edit survives a re-read', /B2=100/.test(reread.content?.[0]?.text ?? ''), reread.content?.[0]?.text);
}

// ── files_search: find a document by what it is about ──────────────────
//
// The index exists because office files cannot be grepped. These assertions
// pin the two halves an agent depends on: titles really are extracted from
// each container format, and an answer is never older than the file system —
// an edit made outside the app changes the next answer, a deleted file
// disappears.
{
  const JSZip = (await import('jszip')).default;
  const reports = join(dir, 'reports');
  mkdirSync(reports, { recursive: true });

  // Minimal containers: the extractor reads one XML part per format, so a
  // single-entry zip is a real test of that path without a generator library.
  const docx = new JSZip();
  docx.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度汇报</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>正文第一段</w:t></w:r></w:p>' +
      // Body-only text: the digest tier's reason to exist.
      '<w:p><w:r><w:t>华东区预算 30 万</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  );
  const docxPath = join(reports, '2026-Q3.docx');
  writeFileSync(docxPath, await docx.generateAsync({ type: 'nodebuffer' }));

  const pptx = new JSZip();
  pptx.file(
    'ppt/slides/slide1.xml',
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Q3 经营分析</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  );
  // A later slide: a title-only index would miss this.
  pptx.file(
    'ppt/slides/slide2.xml',
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>渠道费用明细</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  );
  const pptxPath = join(reports, '2026-Q3.pptx');
  writeFileSync(pptxPath, await pptx.generateAsync({ type: 'nodebuffer' }));

  const mdPath = join(reports, 'notes.md');
  writeFileSync(mdPath, '# 会议记录\n\n正文\n');
  // Word/Excel create this beside an open document; it must not be indexed.
  writeFileSync(join(reports, '~$notes.docx'), 'owner lock');

  // Excel producers disagree about where cell text lives. `smoke.xlsx`
  // (created earlier by SheetJS) covers the `t="str"` form; these two pin the
  // sharedStrings and inline-string forms that Word/Excel exports use.
  const sharedBook = new JSZip();
  sharedBook.file(
    'xl/workbook.xml',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="预算表" sheetId="1"/></sheets></workbook>',
  );
  sharedBook.file(
    'xl/sharedStrings.xml',
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>差旅费用合计</t></si></sst>',
  );
  sharedBook.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
  );
  const sharedPath = join(reports, '预算.xlsx');
  writeFileSync(sharedPath, await sharedBook.generateAsync({ type: 'nodebuffer' }));

  const inlineBook = new JSZip();
  inlineBook.file(
    'xl/workbook.xml',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="会议" sheetId="1"/></sheets></workbook>',
  );
  inlineBook.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>会议纪要</t></is></c></row></sheetData></worksheet>',
  );
  const inlinePath = join(reports, '纪要.xlsx');
  writeFileSync(inlinePath, await inlineBook.generateAsync({ type: 'nodebuffer' }));

  const first = await callTool('files_search', { root: dir, query: '经营分析' });
  const firstText = first.content?.[0]?.text ?? '';
  check('files_search finds a pptx by its slide title', firstText.includes(pptxPath), firstText);
  check('files_search returns the title it extracted', firstText.includes('Q3 经营分析'), firstText);
  check('files_search leaves unrelated documents out', !firstText.includes(mdPath), firstText);

  const byHeading = await callTool('files_search', { root: dir, query: '季度汇报' });
  check('files_search finds a docx by its heading', (byHeading.content?.[0]?.text ?? '').includes(docxPath), byHeading.content?.[0]?.text);

  const byBody = await callTool('files_search', { root: dir, query: '华东区预算' });
  check(
    'files_search matches docx body text, not just the title',
    (byBody.content?.[0]?.text ?? '').includes(docxPath),
    byBody.content?.[0]?.text,
  );
  const punctuated = await callTool('files_search', { root: dir, query: '华东区预算，30' });
  check(
    'Chinese punctuation separates terms instead of poisoning the query',
    (punctuated.content?.[0]?.text ?? '').includes(docxPath),
    punctuated.content?.[0]?.text,
  );
  check(
    'a body match returns the matched snippet',
    (byBody.details?.results?.[0]?.snippet ?? '').includes('华东区预算'),
    JSON.stringify(byBody.details?.results?.[0]),
  );

  const bySlide = await callTool('files_search', { root: dir, query: '渠道费用' });
  check(
    'files_search matches text from a later slide',
    (bySlide.content?.[0]?.text ?? '').includes(pptxPath),
    bySlide.content?.[0]?.text,
  );

  const byCell = await callTool('files_search', { root: dir, query: '姓名' });
  check(
    'files_search matches xlsx text cells, not just the sheet name',
    (byCell.content?.[0]?.text ?? '').includes(join(dir, 'smoke.xlsx')),
    byCell.content?.[0]?.text,
  );

  const byShared = await callTool('files_search', { root: dir, query: '差旅费用' });
  check(
    'files_search reads sharedStrings workbooks',
    (byShared.content?.[0]?.text ?? '').includes(sharedPath),
    byShared.content?.[0]?.text,
  );

  const byInline = await callTool('files_search', { root: dir, query: '会议纪要' });
  check(
    'files_search reads inline-string workbooks',
    (byInline.content?.[0]?.text ?? '').includes(inlinePath),
    byInline.content?.[0]?.text,
  );

  const relative = await callTool('files_search', { root: 'reports', query: 'x' });
  check('a relative root is refused, not resolved against the plugin cwd', /absolute path/.test(relative.error ?? ''), relative.error);

  const missing = await callTool('files_search', { root: join(dir, 'does-not-exist'), query: 'x' });
  check('a missing root is refused', /not a directory/.test(missing.error ?? ''), missing.error);

  const bySheet = await callTool('files_search', { root: dir, query: 'Sheet1' });
  check(
    'files_search finds an xlsx by its sheet name',
    (bySheet.content?.[0]?.text ?? '').includes(join(dir, 'smoke.xlsx')),
    bySheet.content?.[0]?.text,
  );

  const byFolder = await callTool('files_search', { root: dir, query: 'reports' });
  check(
    'files_search matches folder names, so siblings are discoverable',
    (byFolder.content?.[0]?.text ?? '').includes(docxPath),
    byFolder.content?.[0]?.text,
  );

  const newest = await callTool('files_search', { root: dir });
  check('an empty query lists the workspace', (newest.details?.results?.length ?? 0) >= 4, JSON.stringify(newest.details?.results?.map((r) => r.path)));
  check('office owner-lock files (~$...) are skipped', !(newest.details?.results ?? []).some((r) => r.path.includes('~$')), JSON.stringify(newest.details?.results?.map((r) => r.path)));
  check('details carry absolute paths for office_read', newest.details?.results?.every((r) => r.path.startsWith(dir)), JSON.stringify(newest.details?.results?.[0]));

  // The freshness contract: an edit outside the app must show up in the next
  // answer. Rebuild the sharedStrings workbook with new cell text; the size and
  // mtime both change, ruling out a same-mtime edge.
  const revisedBook = new JSZip();
  revisedBook.file(
    'xl/workbook.xml',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="预算表" sheetId="1"/></sheets></workbook>',
  );
  revisedBook.file(
    'xl/sharedStrings.xml',
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>修订版预算</t></si></sst>',
  );
  revisedBook.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
  );
  writeFileSync(sharedPath, await revisedBook.generateAsync({ type: 'nodebuffer' }));
  const edited = await callTool('files_search', { root: dir, query: '修订版预算' });
  check(
    'an external edit is reflected on the next search',
    (edited.content?.[0]?.text ?? '').includes(sharedPath),
    edited.content?.[0]?.text,
  );

  // Plain text is deliberately outside the index (PLUGIN.md: use grep).
  const mdBody = await callTool('files_search', { root: dir, query: '加了一行' });
  check(
    'plain-text bodies stay out of the index',
    !(mdBody.content?.[0]?.text ?? '').includes(mdPath),
    mdBody.content?.[0]?.text,
  );

  rmSync(mdPath);
  rmSync(sharedPath);
  const afterDelete = await callTool('files_search', { root: dir, query: '修订版预算' });
  check('a deleted file disappears from the index', !(afterDelete.content?.[0]?.text ?? '').includes(sharedPath), afterDelete.content?.[0]?.text);
}

rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log('all assertions passed');
