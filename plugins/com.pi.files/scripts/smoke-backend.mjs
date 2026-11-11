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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
/** Plugin messages the backend posted (messages.post), by payload. */
const posted = [];
const written = new Map();

function replyToCall(msg) {
  capabilityCalls.push(msg);
  const params = msg.params ?? {};
  let result = { ok: true };
  if (msg.method === 'filesystem.write') {
    written.set(params.path, Buffer.from(String(params.contentB64 ?? ''), 'base64'));
    result = { path: params.path, mtime: Date.now() };
  } else if (msg.method === 'messages.post') {
    posted.push(params);
    result = { ok: true, messageId: `m${posted.length}`, entryId: `e${posted.length}` };
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

/**
 * Wait for the backend to ASK the host for a capability (the reverse
 * direction of waitFor). `from` bounds the search so an earlier call with the
 * same method is not mistaken for the one this test is waiting on.
 */
function waitForCapability(method, from = 0, timeoutMs = 20_000) {
  const started = Date.now();
  return new Promise((resolve_, reject) => {
    const tick = () => {
      const call = capabilityCalls.slice(from).find((m) => m.method === method);
      if (call) return resolve_(call);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timed out waiting for capability ${method}`));
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

async function callTool(name, params, sessionId) {
  const id = `t${Math.random().toString(36).slice(2, 8)}`;
  hostSend({
    type: 'tool-call',
    id,
    name,
    params,
    ...(sessionId ? { sessionId } : {}),
  });
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

// ── guide domains: pdf is wired, structural read of a pdf is not ───────
//
// `office_guide({domain:"pdf"})` now serves the pdf_edit vocabulary (GenOffice's
// pdf-lib page surgery), while `office_read` on a PDF still has no text path —
// those are different questions and this pins both.
{
  const r = await callTool('office_guide', { domain: 'pdf' });
  const guide = r.content?.[0]?.text ?? '';
  check('office_guide serves the PDF ops', /insertBlankPage/.test(guide) && /merge/.test(guide), guide.slice(0, 160));
  check('the PDF guide points at pdf_convert', /pdf_convert/.test(guide));
  const unwired = await callTool('office_guide', { domain: 'odt' });
  check('an unwired domain says so', /not wired yet/.test(unwired.content?.[0]?.text ?? ''));
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

// ── one completion card per run, posted when the run settles ───────────
//
// The agent edits in batches, so a card per call stacks N near-identical
// boxes in one run. A tool call WITH a conversation tallies into the run
// ledger and returns no card; `agent.turnEnd` flushes exactly one
// `messages.post` card listing every document the run wrote.
{
  const sessionId = 'smoke-session-1';
  const runDeck = join(dir, 'run-card.pptx');
  writeFileSync(runDeck, Buffer.from(await backend.createBlankPptx()));
  const runPdf = join(dir, 'run-note.pdf');
  const postedBefore = posted.length;

  const first = await callTool(
    'office_edit',
    { path: runDeck, ops: [{ op: 'addBlankSlide', target: { slide: 0 } }] },
    sessionId,
  );
  check('an agent edit returns no per-call card', first.card === undefined, JSON.stringify(first.card));
  check('nothing is posted before the run settles', posted.length === postedBefore, `${posted.length} post(s)`);

  // Same file again, then a second document: the card must fold the repeats
  // and list two documents, not three rows.
  await callTool(
    'office_edit',
    { path: runDeck, ops: [{ op: 'addBlankSlide', target: { slide: 0 } }] },
    sessionId,
  );
  const created = await callTool('office_create', { path: runPdf }, sessionId);
  check('create is tallied too (no per-call card)', created.card === undefined, JSON.stringify(created.card));

  const beforeSettle = capabilityCalls.length;
  hostSend({
    type: 'host-event',
    event: 'agent.turnEnd',
    data: { sessionId, runId: 'run-1', aborted: false, outcome: 'completed' },
  });
  const settleCall = await waitForCapability('messages.post', beforeSettle);
  check('the settle posts one plugin message', posted.length === postedBefore + 1, `${posted.length} post(s)`);
  check('the message targets the run conversation', settleCall.params?.sessionId === sessionId);
  check('a completed run posts a success card', settleCall.params?.status === 'success');

  const paths = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.component === 'Button' && node.props?.path) paths.push(node.props.path);
    for (const child of node.children ?? []) walk(child);
  };
  walk(settleCall.params?.card);
  check(
    'the card lists each written document once',
    paths.length === 2 && paths.includes(runDeck) && paths.includes(runPdf),
    JSON.stringify(paths),
  );
  check(
    'the title reports the document count',
    settleCall.params?.card?.props?.title === '本轮已更新 2 个文档',
    JSON.stringify(settleCall.params?.card?.props?.title),
  );

  // The ledger is consumed: a duplicate settle must not post again.
  hostSend({
    type: 'host-event',
    event: 'agent.turnEnd',
    data: { sessionId, runId: 'run-1', aborted: false, outcome: 'completed' },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  check('a repeated settle does not post twice', posted.length === postedBefore + 1, `${posted.length} post(s)`);

  // A run the user stopped still reports what landed on disk.
  const abortSession = 'smoke-session-2';
  const abortDeck = join(dir, 'run-abort.pptx');
  writeFileSync(abortDeck, Buffer.from(await backend.createBlankPptx()));
  await callTool(
    'office_edit',
    { path: abortDeck, ops: [{ op: 'addBlankSlide', target: { slide: 0 } }] },
    abortSession,
  );
  const beforeAbort = capabilityCalls.length;
  hostSend({
    type: 'host-event',
    event: 'agent.turnEnd',
    data: { sessionId: abortSession, runId: 'run-2', aborted: true, outcome: 'aborted' },
  });
  const abortCall = await waitForCapability('messages.post', beforeAbort);
  check('an aborted run is a warning card', abortCall.params?.status === 'warning');
  check(
    'the aborted card says the edits were saved',
    JSON.stringify(abortCall.params?.card).includes('本轮已停止'),
    JSON.stringify(abortCall.params?.card),
  );

  // No conversation (a direct caller, or a test): keep the per-result card.
  const noSession = await callTool('office_edit', {
    path: runDeck,
    ops: [{ op: 'addBlankSlide', target: { slide: 0 } }],
  });
  check(
    'a call with no conversation keeps its own card',
    noSession.card?.component === 'Card',
    JSON.stringify(noSession.card),
  );
}

// ── the file on disk is what the engine wrote ──────────────────────────
{
  const onDisk = await readFile(deckPath);
  check('the file on disk matches what was handed to the host', onDisk.equals(written.get(deckPath)));
}

// ── an edit tells the open viewer to re-read the file ──────────────────
//
// The renderer holds the parsed deck in memory, and office_edit writes the
// file from THIS process. Without a signal the panel keeps drawing the
// pre-edit deck until its tab is reopened — the "preview is stale after an
// edit" bug, which creation never showed because opening a tab mounts and
// reads. This pins the signal that closes that gap.
{
  const events = [];
  let listener = null;
  const port = {
    postMessage: (m) => {
      if (m?.kind === 'event') events.push({ event: m.event, data: m.data, tabId: m.tabId });
    },
    on: (event, cb) => {
      if (event === 'message') listener = cb;
    },
    start: () => {},
  };
  hostSend({ type: 'ui-port' }, [port]);
  // A tab showing the deck. `panelId`/`tabId` are what teach the SDK which
  // ports to route this panel's traffic to.
  listener({
    data: {
      kind: 'event',
      panelId: 'viewer',
      tabId: 'viewer',
      event: 'panel.mounted',
      data: { tabId: 'viewer', params: { file: deckPath } },
    },
  });

  const edit = await callTool('office_edit', {
    path: deckPath,
    ops: [{ op: 'addBlankSlide', target: { slide: 0 } }],
  });
  check('the edit that should notify applied', edit.details?.applied === true, edit.content?.[0]?.text);
  const changed = events.find((e) => e.event === 'ui.fileChanged');
  check(
    'a tool edit tells the open viewer the bytes changed',
    changed?.data?.path === deckPath,
    JSON.stringify(events.map((e) => e.event)),
  );
  check(
    'the signal is distinct from ui.render',
    !events.some((e) => e.event === 'ui.fileChanged' && !e.data?.path),
  );
}

// ── office_create: new files with no Python in sight ───────────────────
//
// The agent used to reach for python-pptx when asked for a new deck. These
// pin the replacement: the same engines the read/edit paths use, one call,
// atomic content, and a hard refusal to clobber an existing file.
{
  const createdPath = join(dir, 'created.pptx');
  const r = await callTool('office_create', {
    path: createdPath,
    ops: [{ op: 'addBlankSlide', target: { slide: 0 } }],
  });
  check('office_create reports created', r.details?.created === true, r.content?.[0]?.text);
  check('the create went through the host capability', written.has(createdPath));
  writeFileSync(createdPath, written.get(createdPath));
  const reread = await callTool('office_read', { path: createdPath });
  check(
    'the created deck is a real deck the engine can read back',
    reread.details?.slideCount === 2,
    `slideCount=${reread.details?.slideCount}`,
  );

  const refused = await callTool('office_create', { path: createdPath });
  check(
    'office_create refuses to clobber an existing file',
    /already exists/.test(refused.error ?? ''),
    refused.error,
  );
}
{
  // The documented one-shot example: a blank deck plus a centered text box,
  // exactly what "create a PPT saying i am weiqun" needs — no Python.
  const textPath = join(dir, 'hello.pptx');
  const r = await callTool('office_create', {
    path: textPath,
    ops: [
      {
        op: 'addElement',
        target: { slide: 0 },
        kind: 'textbox',
        offset: { x: 914400, y: 2286000, cx: 10363200, cy: 2286000 },
        paragraphs: [
          { runs: [{ text: 'i am weiqun', fontSize: 44, bold: true }], align: 'center' },
        ],
        bodyPr: { anchor: 'ctr' },
      },
    ],
  });
  check(
    'office_create applies a text element in the same call',
    r.details?.created === true && (r.details?.records?.length ?? 0) === 1,
    r.error ?? JSON.stringify(r.details),
  );
}
{
  const badPath = join(dir, 'bad-create.pptx');
  const r = await callTool('office_create', {
    path: badPath,
    ops: [{ op: 'addBlankSlide', target: { slide: 99 } }],
  });
  check('a rejected create batch writes nothing', !written.has(badPath));
  check(
    'a rejected create batch returns typed failures',
    Array.isArray(r.details?.failures) && r.details.failures.length > 0,
    JSON.stringify(r.details),
  );
}
{
  const xlsxPath = join(dir, 'created.xlsx');
  const r = await callTool('office_create', {
    path: xlsxPath,
    sheetName: 'Budget',
    ops: [{ sheet: 'Budget', cell: 'A1', value: 'hello' }],
  });
  check('office_create creates a workbook', r.details?.created === true, r.content?.[0]?.text);
  writeFileSync(xlsxPath, written.get(xlsxPath));
  const read = await callTool('office_read', { path: xlsxPath });
  check(
    'the created workbook carries its first cells',
    /A1=hello/.test(read.content?.[0]?.text ?? ''),
    read.content?.[0]?.text,
  );
}
{
  // GenOffice's own grid → workbook path: a table arrives as CSV, numbers stay
  // numeric, and the result is a workbook office_read can address by cell.
  const csvPath = join(dir, 'csv-created.xlsx');
  const r = await callTool('office_create', {
    path: csvPath,
    sheetName: '预算',
    csv: '项目,金额\n房租,3000\n餐饮,1200',
  });
  check('office_create accepts a CSV grid', r.details?.created === true, r.error ?? r.content?.[0]?.text);
  writeFileSync(csvPath, written.get(csvPath));
  const read = await callTool('office_read', { path: csvPath });
  const body = read.content?.[0]?.text ?? '';
  check(
    'the CSV grid became addressable cells',
    /A1=项目/.test(body) && /B2=3000/.test(body) && /A3=餐饮/.test(body),
    body,
  );
}
{
  // .csv is a file too: GenOffice's create path writes a UTF-8 BOM so Excel
  // reopens it as UTF-8 instead of the local ANSI code page.
  const csvPath = join(dir, 'created-plain.csv');
  const r = await callTool('office_create', { path: csvPath, csv: 'a,b\n1,2' });
  check('office_create creates a CSV', r.details?.created === true, r.error ?? r.content?.[0]?.text);
  const bytes = written.get(csvPath);
  check(
    'the CSV is BOM + the given text',
    bytes && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf && bytes.toString('utf8').includes('a,b\n1,2'),
    bytes ? bytes.subarray(0, 20).toString('hex') : 'no bytes',
  );
}
{
  const rel = await callTool('office_create', { path: 'relative.pptx' });
  check('a relative path is refused', /absolute/.test(rel.error ?? ''), rel.error);
  const unsupported = await callTool('office_create', { path: join(dir, 'plain.txt') });
  check(
    'an unsupported extension is refused',
    /not supported/.test(unsupported.error ?? ''),
    unsupported.error,
  );
}

// ── PDF: create, page surgery, and PDF → Office conversion ─────────────
//
// All of this is GenOffice's own headless layer: blank-pdf.ts for the blank
// page, save-pdf.ts's pdf-lib helpers for the surgery, and pdf2docx for the
// rebuild. The wasm next to dist/main.mjs is what makes the conversion work in
// a plugin process — this block is the check that it is actually there.
{
  const { PDFDocument } = await import('pdf-lib');

  const createdPdf = join(dir, 'created.pdf');
  const c = await callTool('office_create', {
    path: createdPdf,
    pages: 3,
    pageSize: 'Letter',
  });
  check('office_create creates a PDF', c.details?.created === true, c.error ?? c.content?.[0]?.text);
  writeFileSync(createdPdf, written.get(createdPdf));
  const pdf = await PDFDocument.load(readFileSync(createdPdf));
  check('the PDF has the requested pages', pdf.getPageCount() === 3);
  const { width, height } = pdf.getPage(0).getSize();
  check(
    'the PDF has the requested paper size',
    Math.round(width) === 612 && Math.round(height) === 792,
    JSON.stringify({ width, height }),
  );

  const extracted = join(dir, 'extracted.pdf');
  const e = await callTool('pdf_edit', {
    path: createdPdf,
    outputPath: extracted,
    ops: [{ op: 'extractPages', pages: [0, 2] }],
  });
  check('pdf_edit extracts pages', e.details?.applied === true, e.error ?? e.content?.[0]?.text);
  writeFileSync(extracted, written.get(extracted));
  check(
    'the extracted PDF has two pages',
    (await PDFDocument.load(readFileSync(extracted))).getPageCount() === 2,
  );

  const merged = join(dir, 'merged.pdf');
  const m = await callTool('pdf_edit', {
    path: extracted,
    outputPath: merged,
    ops: [{ op: 'merge', sources: [createdPdf] }],
  });
  check('pdf_edit merges PDFs', m.details?.applied === true, m.error ?? m.content?.[0]?.text);
  writeFileSync(merged, written.get(merged));
  check(
    'the merged PDF has five pages',
    (await PDFDocument.load(readFileSync(merged))).getPageCount() === 5,
  );

  const inPlace = await callTool('pdf_edit', {
    path: createdPdf,
    outputPath: createdPdf,
    ops: [{ op: 'insertBlankPage', afterPageIndex: 0 }],
  });
  check('an in-place edit needs overwrite', /overwrite/.test(inPlace.error ?? ''), inPlace.error);

  const deleted = join(dir, 'deleted.pdf');
  const d = await callTool('pdf_edit', {
    path: merged,
    outputPath: deleted,
    ops: [{ op: 'deletePages', pages: [0, 1] }],
  });
  check('pdf_edit deletes pages', d.details?.applied === true, d.error ?? d.content?.[0]?.text);
  writeFileSync(deleted, written.get(deleted));
  check(
    'the trimmed PDF has three pages',
    (await PDFDocument.load(readFileSync(deleted))).getPageCount() === 3,
  );

  const split = await callTool('pdf_edit', {
    path: createdPdf,
    outputPath: join(dir, 'split-out'),
    ops: [{ op: 'split', everyPages: 2 }],
  });
  check(
    'pdf_edit splits into several files',
    (split.details?.files?.length ?? 0) === 2,
    split.error ?? JSON.stringify(split.details),
  );

  // PDF text insertion: GenOffice's text-edit layer resolves a system font,
  // subsets it with harfbuzz and writes a real text object.
  const textEditOut = join(dir, 'text-edited.pdf');
  const te = await callTool('pdf_edit', {
    path: createdPdf,
    outputPath: textEditOut,
    ops: [{ op: 'insertText', text: 'PDF-EDIT-TEXT', pageIndex: 0, x: 72, y: 700, fontSize: 14 }],
  });
  check('pdf_edit inserts text', te.details?.applied === true, te.error ?? te.content?.[0]?.text);
  writeFileSync(textEditOut, written.get(textEditOut));
  check(
    'the text edit produced a different PDF',
    !readFileSync(textEditOut).equals(readFileSync(createdPdf)),
  );

  // office_create with text, then PDF → DOCX: both must carry the text, which
  // is the whole point (and the reason pdfium + harfbuzz wasm are bundled).
  const srcPdf = join(dir, 'convert.pdf');
  const createdText = await callTool('office_create', {
    path: srcPdf,
    text: 'CONVERT-MARKER',
  });
  check(
    'office_create writes text into a PDF',
    createdText.details?.created === true && createdText.details?.textLines === 1,
    createdText.error ?? createdText.content?.[0]?.text,
  );
  writeFileSync(srcPdf, written.get(srcPdf));
  const outDocx = join(dir, 'converted.docx');
  const cv = await callTool('pdf_convert', { path: srcPdf, to: 'docx', outputPath: outDocx });
  check('pdf_convert creates a docx', cv.details?.converted === true, cv.error ?? cv.content?.[0]?.text);
  writeFileSync(outDocx, written.get(outDocx));
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(readFileSync(outDocx));
  const xml = (await zip.file('word/document.xml')?.async('string')) ?? '';
  check('the converted docx carries the PDF text', xml.includes('CONVERT-MARKER'), xml.slice(0, 200));

  // The text layer's system-font fallback is what makes CJK possible; pin it
  // (macOS resolves PingFang/Heiti; Linux/Windows resolve their own CJK face).
  const cjkPdf = join(dir, 'cjk.pdf');
  const cjkCreated = await callTool('office_create', { path: cjkPdf, text: '你好，世界' });
  check(
    'office_create writes CJK text into a PDF',
    cjkCreated.details?.created === true && cjkCreated.details?.textLines === 1,
    cjkCreated.error ?? cjkCreated.content?.[0]?.text,
  );
  writeFileSync(cjkPdf, written.get(cjkPdf));
  const cjkDocx = join(dir, 'cjk-converted.docx');
  const cjkConverted = await callTool('pdf_convert', {
    path: cjkPdf,
    to: 'docx',
    outputPath: cjkDocx,
  });
  check(
    'CJK PDF converts to docx',
    cjkConverted.details?.converted === true,
    cjkConverted.error ?? cjkConverted.content?.[0]?.text,
  );
  writeFileSync(cjkDocx, written.get(cjkDocx));
  const cjkZip = await JSZip.loadAsync(readFileSync(cjkDocx));
  const cjkXml = (await cjkZip.file('word/document.xml')?.async('string')) ?? '';
  check('the converted docx carries the CJK text', cjkXml.includes('你好'), cjkXml.slice(0, 200));

  // PDF → PNG: pdfium rasterizes, GenOffice's own encoder writes the file.
  const render = await callTool('pdf_render', { path: srcPdf, outputDir: join(dir, 'png-out'), scale: 1 });
  check(
    'pdf_render renders the page',
    (render.details?.files?.length ?? 0) === 1,
    render.error ?? JSON.stringify(render.details),
  );
  const png = written.get(join(dir, 'png-out', 'convert-p1.png'));
  check(
    'the rendered file is a PNG',
    png && png[0] === 0x89 && png.toString('ascii', 1, 4) === 'PNG',
    png ? png.subarray(0, 8).toString('hex') : 'no bytes',
  );
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
        else if (command === 'insert_content' || command === 'replace_blocks')
          reply(requestId, true, { result: { summary: 'ok', mutated: true } });
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
  // Tagged with panelId/tabId exactly as the real preload sends them: with
  // another port already speaking for this panel (the re-read test above),
  // untagged traffic has no owner and the SDK can only guess which port to
  // route `mcp-command` to.
  portListener({
    data: {
      kind: 'event',
      panelId: 'viewer',
      tabId: 'viewer',
      event: 'panel.mounted',
      data: { tabId: 'viewer', params: { file: docxPath } },
    },
  });
  // The real panel announces readiness once its editor has the document
  // loaded; office_edit waits for this before sending any command. Without it
  // the backend would wait the full 60s for an announcement that never comes.
  portListener({
    data: {
      kind: 'request',
      id: 'ready-1',
      panelId: 'viewer',
      tabId: 'viewer',
      method: 'mcp.ready',
      params: { path: docxPath },
    },
  });

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

  // office_create docx: the blank is written first, then the content batch
  // runs through the same live editor. The smoke harness has no real panel to
  // mount and announce, so pre-announce readiness for the new path — in the
  // app, office_create opens it and waits for exactly this signal.
  const createdDocx = join(dir, 'created.docx');
  portListener({
    data: {
      kind: 'request',
      panelId: 'viewer',
      tabId: 'viewer',
      method: 'mcp.ready',
      params: { path: createdDocx },
    },
  });
  pushed.length = 0;
  const created = await callTool('office_create', {
    path: createdDocx,
    ops: [{ op: 'insert_content', html: '<p>Hello from office_create</p>' }],
  });
  check(
    'office_create creates a docx',
    created.details?.created === true,
    created.error ?? created.content?.[0]?.text,
  );
  check('the docx blank landed on disk first', written.has(createdDocx));
  check(
    'the docx content ran through the live editor',
    pushed.some((p) => p.command === 'insert_content'),
    pushed.map((p) => p.command).join(','),
  );
  check('the created docx was saved after the batch', pushed.at(-1)?.command === 'save_document', pushed.at(-1)?.command);
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
