/**
 * com.pi.files backend — office engine host + file viewer controller.
 *
 * Two jobs:
 *
 *  1. **Panel controller** — the viewer panel fetches file bytes itself over
 *     `pi-plugin://com.pi.files/ws-file?path=…`; the backend only pushes the
 *     current path on `panel.mounted({file})` and handles the write-back.
 *
 *  2. **The agent's office engine** — the whole point of this plugin: read,
 *     edit, check and create real Office files through the vendored GenOffice
 *     engines, exposed as `contributes.tools`. This is what replaces the
 *     officecli skill + binary that the desktop app used to install.
 *
 * Bytes are read with `node:fs` rather than the `filesystem.read` capability,
 * because that capability deliberately refuses docx/xlsx/pptx (it is a generic
 * text-read tool for other plugins). Writes go back through `filesystem.write`
 * so the host's mtime-conflict check still applies.
 *
 * The one thing this plugin has that no other does is a second, plugin-private
 * channel: docx editing drives a live editor in the panel through GenOffice's
 * own agent bridge, and those commands travel over the plugin's own panel port.
 * It is still plugin-internal — it never reaches the host — it just goes through
 * `ctx.send` like everything else now.
 */
import {
  plugin,
  type AgentTurnEndEvent,
  type PluginContext,
  type ToolResult,
} from '@pi/plugin-sdk';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { createBlankPptx, openPptx, savePptx } from '@genoffice/pptx-engine';
import { buildBlankDocx } from '@genoffice/docx-engine';
import { blankXlsxBuffer, sheetCsvToXlsxBuffer } from '@genoffice/xlsx-gateway/gateway/csv-import';
import { applyXlsxEdits, planXlsxEdits, readXlsxStructure, type CellOp } from './xlsx';
import { DOCX_OP_GROUPS, docxGuide, planDocxCommands, type DocxOp } from './docx';
import {
  PDF_PAPER,
  applyPdfOps,
  blankPdf,
  convertPdfToOffice,
  insertPdfText,
  pdfGuide,
  pdfPageCount,
  pdfPageInfo,
  renderPdfPages,
  type PdfOp,
} from './pdf';
import { searchWorkspace } from './file-index';
import {
  OP_GROUPS,
  opGuide,
  opNames,
  opSignatureIndex,
  opVocabulary,
  runTxn,
  type Op,
} from '@genoffice/pptx-ops';

/**
 * The SDK's context, kept at module scope.
 *
 * One backend process serves exactly one plugin, so there is one context — and
 * the engine helpers, the viewer controller and the docx bridge all need it.
 */
let ctx: PluginContext;

const MAX_READ_BYTES = 200 * 1024 * 1024;

/** Whether two paths name the same file, forgiving `.` `..` and a trailing slash. */
function samePath(a: string, b: string): boolean {
  try {
    return resolvePath(a) === resolvePath(b);
  } catch {
    return a === b;
  }
}

/** The one panel this plugin draws into. */
const PANEL = 'viewer';

/** Push a render to one host tab's viewer (or to every viewer tab when omitted). */
const renderViewer = (data: unknown, tabId?: string): boolean =>
  tabId ? ctx.send(PANEL, 'ui.render', data, tabId) : ctx.send(PANEL, 'ui.render', data);

// ── Viewer tabs (one host tab = one document) ────────────────────────
//
// The host owns the tab strip now. Every tab is a separate native view with
// its own panel.mounted/panel.activated (and its own `tabId`), so this backend
// keeps one document per tab:
//
//   tabFiles            tabId → absolute path ('' = the empty viewer tab)
//   tabSessions         tabId → the conversation it serves (for scoping)
//   activeTabBySession  sessionId → the tab the user is looking at
//
// The last map is what `office_*` means by "the current document" when a tool
// omits `path`. The host re-fires panel.activated on every tab switch.

const tabFiles = new Map<string, string>();
const tabSessions = new Map<string, string | null>();
const activeTabBySession = new Map<string, string>();
/** The conversation the viewer last mounted for (fallback for unscoped tools). */
let panelSession: string | null = null;

function tabTitle(path: string): string {
  return path ? basename(path) : '';
}

/** Find a tab showing a path (first match). */
function tabForPath(path: string): string | null {
  for (const [tabId, file] of tabFiles) {
    if (file && samePath(file, path)) return tabId;
  }
  return null;
}

function isOpenInViewer(path: string): boolean {
  return tabForPath(path) !== null;
}

function renderTabFile(tabId: string): void {
  const file = tabFiles.get(tabId) ?? '';
  renderViewer(
    file ? { path: file, tabs: [file], activePath: file } : { tabs: [], activePath: '' },
    tabId,
  );
}

/** Tell the host tab its label/params after a file change. */
async function publishTab(tabId: string): Promise<void> {
  const file = tabFiles.get(tabId) ?? '';
  try {
    await ctx.call('panel.updateTab', {
      panelId: PANEL,
      tabId,
      // '' clears the override, so an unchosen tab falls back to the panel
      // title ("文件查看器") instead of an empty label.
      title: tabTitle(file),
      params: file ? { file } : {},
    });
  } catch (err) {
    ctx.log.warn(`panel.updateTab failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function setTabFile(tabId: string, path: string): void {
  tabFiles.set(tabId, path);
}

function activeTabOf(sessionId?: string | null): string | null {
  return activeTabBySession.get(sessionId ?? panelSession ?? 'default') ?? null;
}

/** The current document of a conversation ('' when none). */
function activeFileOf(sessionId?: string | null): string {
  const tabId = activeTabOf(sessionId);
  return tabId ? (tabFiles.get(tabId) ?? '') : '';
}

/**
 * Open a file in the viewer through the HOST: a tab already showing the file
 * is focused, an unloaded viewer tab is reused, otherwise a new tab is made.
 * The host answers by mounting the tab and firing panel.mounted.
 */
async function openInViewer(path: string, focus = true): Promise<void> {
  await ctx.call('panel.open', { panelId: PANEL, focus, params: { file: path } });
}

/**
 * Open a file in a specific existing tab (the viewer's own empty-state tree).
 * This is a same-tab navigation: the page reloads onto the new renderer and
 * the host tab's label/params follow.
 */
async function openInTab(tabId: string, path: string): Promise<void> {
  setTabFile(tabId, path);
  renderTabFile(tabId);
  await publishTab(tabId);
}

// ── GenOffice's external-agent bridge (docx) ─────────────────────────
//
// Editing a docx means driving a LIVE Tiptap editor, so the work happens in
// the panel: GenOffice ships exactly that bridge itself
// (`apps/docs/src/renderer/mcp-bridge.ts`), and its executors are the built-in
// agent's own `executeTool` — so an external command inherits the same
// parsing, atomicity, formatting rules and stale-index guard.
//
// This side only carries the commands. They travel over the plugin's OWN
// point-to-point panel port and come back as an ordinary UI request, so
// nothing here reaches the host: no host capability, no protocol surface,
// no manifest change. The plugin's `office_*` tools are the only thing the
// agent sees, exactly as for any other plugin.
//
// The one consequence worth knowing: the document has to be OPEN in the
// viewer. That is GenOffice's own model — its built-in AI works the same way —
// and it is why `requireDocxOpen` below fails loudly instead of hanging.
const mcpPending = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
let mcpSeq = 0;

/** True once a docs panel has announced it can take commands. */
let mcpReady = false;

/**
 * Which document the panel's editor currently holds, as announced by
 * `mcp.ready { path }`. One panel, one live editor — this is the truth about
 * what a `mcp-command` would land on. A stale value (the panel reloaded away
 * from docs) simply fails the fast path below, and the next announcement
 * overwrites it.
 */
let mcpReadyPath: string | null = null;

/** Waiters blocked until the panel announces a specific document ready. */
const readyWaiters = new Map<string, Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }>>();

function waitMcpReady(path: string, timeoutMs: number): Promise<void> {
  if (mcpReadyPath !== null && samePath(mcpReadyPath, path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const entry = { resolve, timer: null as unknown as ReturnType<typeof setTimeout> };
    const remove = () => {
      clearTimeout(entry.timer);
      const arr = readyWaiters.get(path);
      if (!arr) return;
      const i = arr.indexOf(entry);
      if (i >= 0) arr.splice(i, 1);
      if (arr.length === 0) readyWaiters.delete(path);
    };
    entry.timer = setTimeout(() => {
      remove();
      reject(
        new Error(
          `the viewer did not finish opening ${basename(path)} within ${Math.round(timeoutMs / 1000)}s — ` +
            'is the file still readable?',
        ),
      );
    }, timeoutMs);
    const arr = readyWaiters.get(path) ?? [];
    arr.push(entry);
    readyWaiters.set(path, arr);
  });
}

function announceMcpReady(path: string): void {
  mcpReadyPath = path;
  const arr = readyWaiters.get(path);
  if (!arr) return;
  readyWaiters.delete(path);
  for (const w of arr) {
    clearTimeout(w.timer);
    w.resolve();
  }
}

/**
 * All docx bridge traffic for one tool call runs under this lock. The panel
 * has ONE live editor, so two concurrent calls (e.g. two conversations editing
 * two documents) must not interleave: each call re-points the editor at its
 * own document first, and letting a second call switch it mid-sequence would
 * land the first call's remaining commands on the wrong document.
 */
let mcpChain: Promise<unknown> = Promise.resolve();
function withMcpLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mcpChain.then(fn, fn);
  mcpChain = run.catch(() => undefined);
  return run;
}

function requireDocxOpen(path: string): void {
  if (isOpenInViewer(path)) return;
  const current = activeFileOf();
  throw new Error(
    current
      ? `the viewer is showing ${current}, not ${path} — open the document you want to edit in the viewer, then retry`
      : `no document is open in the viewer — open ${path} there, then retry`,
  );
}

/**
 * Point the panel's editor at `path` and wait until it says so. Activating the
 * tab is what makes the switch visible (the tab strip moves, and a format
 * switch reloads the panel onto the docs renderer) — GenOffice's model is that
 * the document being edited IS the one open in the viewer.
 */
async function ensureDocxActive(path: string, _sessionId?: string | null): Promise<void> {
  if (mcpReadyPath !== null && samePath(mcpReadyPath, path)) return;
  // Focus the tab already showing it, reuse an unloaded viewer tab, or open a
  // new one — the host decides, then mounts it and the editor announces ready.
  await openInViewer(path, true);
  await waitMcpReady(path, 60_000);
}

function mcpCommand(
  command: string,
  payload: Record<string, unknown>,
  timeoutMs = 120_000,
  tabId?: string,
): Promise<unknown> {
  const requestId = 'm' + ++mcpSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mcpPending.delete(requestId);
      reject(
        new Error(
          `the viewer did not answer "${command}" within ${Math.round(timeoutMs / 1000)}s — ` +
            'is the document still open and finished loading?',
        ),
      );
    }, timeoutMs);
    mcpPending.set(requestId, { resolve, reject, timer });
    const delivered = ctx.send(PANEL, 'mcp-command', { requestId, command, payload }, tabId);
    if (!delivered) {
      // Nothing is listening. Waiting out the full timeout would only delay a
      // failure the caller can act on right now — and this is the case the old
      // `requireDocxOpen` port check used to catch, from the other side.
      clearTimeout(timer);
      mcpPending.delete(requestId);
      reject(new Error('the file viewer is not open — open the document in the viewer, then retry'));
      return;
    }
    if (!mcpReady) {
      // Not fatal: readiness is only a hint (the panel announces it once the
      // editor has a loaded document), and the command may still be answered.
      ctx.log.info('docx bridge: no ready signal yet, sending anyway');
    }
  });
}

// ── Office engine helpers ────────────────────────────────────────────

async function readOfficeBytes(path: string): Promise<Uint8Array> {
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) throw new Error(`not a file: ${path}`);
  if (info.size > MAX_READ_BYTES) {
    throw new Error(`file too large for the engine (${Math.round(info.size / 1e6)}MB > ${MAX_READ_BYTES / 1e6}MB)`);
  }
  return new Uint8Array(await readFile(path));
}

/**
 * Tell every viewer tab showing `path` that its bytes changed on disk.
 *
 * A renderer loads the document once and keeps the parsed form in memory; a
 * write made HERE (office_edit runs in this process) leaves the panel drawing
 * the pre-edit copy until its tab is reopened — which is exactly the "preview
 * is stale after an edit" bug. `ui.render` cannot say it: every renderer treats
 * a repeat of the path it already shows as a no-op, precisely so a re-mount
 * cannot reload in a loop. So this is a separate signal, and the page re-reads
 * the file itself.
 */
function notifyFileChanged(path: string): void {
  let shown = false;
  for (const [tabId, file] of tabFiles) {
    if (!file || !samePath(file, path)) continue;
    shown = true;
    ctx.send(PANEL, 'ui.fileChanged', { path: file }, tabId);
  }
  // A page that is actually being reloaded loses its editor's "ready" claim.
  // Without this, a docx create over a document that is already open could let
  // the next bridged command go to a page that is navigating away. Only when a
  // tab shows the file: with none, nothing reloads and the claim still holds.
  if (shown && mcpReadyPath !== null && samePath(mcpReadyPath, path)) {
    mcpReadyPath = null;
    mcpReady = false;
  }
}

/** Save engine output back to disk through the host, keeping the conflict check. */
async function writeOfficeBytes(path: string, bytes: Uint8Array, expectedMtime?: number): Promise<unknown> {
  const written = await ctx.call('filesystem.write', {
    path,
    contentB64: Buffer.from(bytes).toString('base64'),
    expectedMtime: typeof expectedMtime === 'number' ? expectedMtime : undefined,
  });
  // After a successful write only: a refused write leaves the panel's copy
  // correct, and reloading it then would look like the edit had landed.
  notifyFileChanged(path);
  return written;
}

// ── Tools ────────────────────────────────────────────────────────────

const text = (t: string, details?: unknown): ToolResult => ({
  content: [{ type: 'text', text: t }],
  details,
});

/**
 * Declarative card for office_edit / office_create (messageRenderer): what
 * changed, plus a one-click open in the viewer. The file path rides in the
 * Button's props — the click event loops it back as the payload — so each card
 * opens ITS document even when several edits are stacked in one conversation.
 * Cards render only what the host can draw from data; the plugin ships no UI
 * code.
 *
 * One line of content, not three: the icon + title say what happened, the row
 * says which file, and the action sits on the right where the eye ends. The
 * batch size is already the tool row's preview ("迎国庆.pptx · 6 个操作").
 */
const docCard = (
  filePath: string,
  ext: string,
  mode: 'updated' | 'created' = 'updated',
): unknown => ({
  component: 'Card',
  props: {
    title: mode === 'created' ? '文档已创建' : '文档已更新',
    icon: 'file',
    status: 'success',
  },
  children: [
    {
      component: 'Row',
      props: { justify: 'between', gap: 'md' },
      children: [
        {
          component: 'Row',
          props: { gap: 'md', grow: true },
          children: [
            { component: 'Text', props: { text: basename(filePath), weight: 'bold', truncate: true } },
            { component: 'Badge', props: { text: ext.toUpperCase() } },
          ],
        },
        {
          component: 'Button',
          props: { label: '打开', variant: 'outline', path: filePath },
          events: { onClick: 'open_viewer' },
        },
      ],
    },
  ],
});

// ── One completion card per agent run ────────────────────────────────
//
// The agent edits in batches, so a per-call card stacks N near-identical
// boxes in one run. The interesting unit is the RUN, and the host already
// tells every backend when one settles (`agent.turnEnd` — success, abort or
// error). Tool calls tally here; the settle flushes one card through
// `messages.post`, which is transcript-only and never starts another turn.
//
// A tool call with no conversation (direct callers, tests) keeps the
// per-result card: there is no session to post into.

interface RunDocTally {
  path: string;
  ext: string;
  created: boolean;
  ops: number;
  /** Insertion order, so the card lists documents in the order touched. */
  order: number;
}

/** conversation → (resolved path → tally). Bounded by MAX_LEDGER_SESSIONS. */
const runLedgers = new Map<string, Map<string, RunDocTally>>();
const MAX_LEDGER_SESSIONS = 20;
let ledgerOrder = 0;

function recordDocWork(
  sessionId: string,
  filePath: string,
  ext: string,
  mode: 'created' | 'updated',
  ops: number,
): void {
  let ledger = runLedgers.get(sessionId);
  if (!ledger) {
    if (runLedgers.size >= MAX_LEDGER_SESSIONS) {
      const oldest = runLedgers.keys().next().value;
      if (oldest !== undefined) runLedgers.delete(oldest);
    }
    ledger = new Map();
    runLedgers.set(sessionId, ledger);
  }
  const key = (() => {
    try {
      return resolvePath(filePath);
    } catch {
      return filePath;
    }
  })();
  const tally = ledger.get(key);
  if (tally) {
    tally.ops += ops;
    tally.created = tally.created || mode === 'created';
    tally.order = ++ledgerOrder;
    return;
  }
  ledger.set(key, { path: filePath, ext, created: mode === 'created', ops, order: ++ledgerOrder });
}

/**
 * Tally this write for the run, or — without a conversation — keep the old
 * per-result card so non-agent callers see the same thing as before.
 */
function reportDocWork(
  sessionId: string | null,
  filePath: string,
  ext: string,
  mode: 'created' | 'updated',
  ops: number,
): { card?: unknown } {
  if (!sessionId) return { card: docCard(filePath, ext, mode) };
  recordDocWork(sessionId, filePath, ext, mode, ops);
  return {};
}

/** The one card a run ends with: every document it wrote, with an open action. */
function runSummaryCard(docs: RunDocTally[], outcome: AgentTurnEndEvent['outcome']): unknown {
  const allCreated = docs.every((d) => d.created);
  const title =
    docs.length > 1
      ? `本轮已更新 ${docs.length} 个文档`
      : allCreated
        ? '文档已创建'
        : '文档已更新';
  const note =
    outcome === 'aborted'
      ? '本轮已停止，以上改动已保存'
      : outcome === 'error'
        ? '本轮出错，以上改动已保存'
        : null;
  return {
    component: 'Card',
    props: {
      title,
      icon: 'file',
      status: outcome === 'completed' ? 'success' : 'warning',
    },
    children: [
      ...docs.map((d) => ({
        component: 'Row',
        props: { justify: 'between', gap: 'md' },
        children: [
          {
            component: 'Row',
            props: { gap: 'md', grow: true },
            children: [
              { component: 'Text', props: { text: basename(d.path), weight: 'bold', truncate: true } },
              { component: 'Badge', props: { text: d.ext.toUpperCase() } },
              ...(d.ops > 0
                ? [{ component: 'Text', props: { text: `${d.ops} 个操作`, variant: 'small' } }]
                : []),
            ],
          },
          {
            component: 'Button',
            props: { label: '打开', variant: 'outline', path: d.path },
            events: { onClick: 'open_viewer' },
          },
        ],
      })),
      ...(note ? [{ component: 'Text', props: { text: note, variant: 'muted' } }] : []),
    ],
  };
}

/**
 * The run is over: post its one completion card and drop the ledger.
 *
 * Fire-and-forget from the host event, which is synchronous and must not
 * block on a capability round-trip. Nothing is posted when the run wrote no
 * documents — a read-only turn needs no result card.
 */
async function settleRun(ev: AgentTurnEndEvent | null | undefined): Promise<void> {
  const sessionId = String(ev?.sessionId ?? '');
  // Tool calls without a conversation are recorded under the adapter's
  // 'default' key; drop that ledger without posting (there is nowhere to post).
  const ledger = runLedgers.get(sessionId || 'default');
  if (!ledger) return;
  runLedgers.delete(sessionId || 'default');
  if (!sessionId) return;
  const docs = [...ledger.values()].sort((a, b) => a.order - b.order);
  if (docs.length === 0) return;
  const outcome = ev?.outcome ?? 'completed';
  try {
    await ctx.messages.post({
      sessionId,
      card: runSummaryCard(docs, outcome),
      status: outcome === 'completed' ? 'success' : 'warning',
    });
  } catch (err) {
    ctx.log.warn(
      `completion card not posted: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The op vocabulary is served as DATA, not as one tool per op.
 *
 * `contributes.tools` is aggregated into the agent's tool list at session
 * creation, so a 70-variant schema would be paid on every request. Instead
 * the model asks for the vocabulary (or one group's field tables) when it
 * needs them — the same split genoffice's own AI surfaces use, and the
 * reason `op-docs.ts` exposes vocabulary / signature-index / guide
 * separately.
 */
async function toolGuide(p: Record<string, unknown>): Promise<ToolResult> {
  const domain = String(p.domain ?? 'pptx');
  if (domain === 'xlsx') {
    // Not the pptx op vocabulary: a spreadsheet edit addresses a cell, and
    // there is no op registry behind it to enumerate.
    return text(
      'xlsx ops are cell edits. Each one is:\n' +
        '  { sheet: string, cell: string, value: string | number | boolean | null }\n' +
        '\n' +
        '  sheet — a sheet name exactly as office_read reported it\n' +
        '  cell  — an A1-style address, also from office_read\n' +
        '  value — null clears the cell\n' +
        '\n' +
        'Put them in office_edit\'s `ops` array. Read first; the addresses come from office_read.\n' +
        'NOT yet supported for xlsx: adding or removing sheets, formulas, formatting,\n' +
        'charts, merged cells. Those need a different op set; say so instead of retrying.',
      { domain, op: 'setCell' },
    );
  }
  if (domain === 'docx') {
    // Not a byte-level engine: see backend/docx.ts. The ops drive the editor
    // the document is open in, which is why the guide leads with that.
    return text(docxGuide(), { domain, ops: DOCX_OP_GROUPS });
  }
  if (domain === 'pdf') {
    return text(pdfGuide(), { domain, tool: 'pdf_edit' });
  }
  if (domain !== 'pptx') {
    return text(`domain "${domain}" is not wired yet — pptx, docx, xlsx and pdf are. Do not retry with another argument; tell the user this format has no structural editing yet.`);
  }
  const group = p.group === undefined ? undefined : String(p.group);
  if (group !== undefined) {
    const guide = opGuide(group);
    if (!guide) {
      return text(`unknown op group "${group}". Available: ${OP_GROUPS.join(', ')}`);
    }
    return text(guide, { domain, group });
  }
  if (p.style === 'signatures') {
    return text(opSignatureIndex(), { domain, count: opNames().length });
  }
  return text(
    `${opVocabulary()}\n\nCall office_guide again with { group } for one group's field tables and examples.`,
    { domain, groups: OP_GROUPS, count: opNames().length },
  );
}

/** `2026-10-18 15:22`, local, stable — never locale-dependent. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Find documents by what they are about, not by their path.
 *
 * `office_read` needs a path; this is how the agent gets one when the user only
 * described the document ("the Q3 report"). The index behind it is a cache —
 * every call re-stats the workspace, so the answer reflects edits made outside
 * the app. It answers "which file", never "what is inside": the agent still
 * calls office_read on the path it picks.
 */
async function toolSearch(p: Record<string, unknown>): Promise<ToolResult> {
  const root = String(p.root ?? '').trim();
  if (!root) throw new Error('files_search: root is required (the workspace directory to search)');
  const query = String(p.query ?? '').trim();
  const rawLimit = Number(p.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 20;

  const { index, rows } = await searchWorkspace(root, ctx.dataDir, query, limit);
  const heading = query
    ? `${rows.length} match(es) for "${query}" in ${index.root} — ${index.total} document(s) indexed`
    : `${rows.length} most recently modified document(s) in ${index.root} — ${index.total} indexed`;

  const lines = rows.flatMap((row) => {
    const facts = `  ${row.path}  [${row.ext}]  ${stamp(row.mtimeMs)}${row.title ? `  ${row.title}` : ''}`;
    // The snippet is why the file came back: a body match is invisible in the
    // path/title line, and the agent should not have to open the document to
    // find out whether this is the right hit.
    return row.snippet ? [facts, `      ${row.snippet}`] : [facts];
  });
  const notes: string[] = [];
  if (rows.length === 0) {
    notes.push(
      'Nothing matched. The index covers Office documents (docx/docm/pptx/pptm/xlsx/xlsm), ' +
        'legacy Word/PowerPoint (doc/ppt) and PDFs, with their opening body text (PDF is ' +
        'title-only). Plain text and code are not indexed — search those with grep. Try fewer ' +
        'words, a folder name, or an empty query to list the newest documents.',
    );
  }
  if (index.pending > 0) {
    notes.push(`${index.pending} file(s) still have no extracted title — call again to continue indexing.`);
  }
  if (index.truncated) {
    notes.push(
      'The scan hit its size/time limit, so some folders were not indexed. ' +
        'Pass a narrower workspace folder if the document you need is not here.',
    );
  }
  if (rows.length > 0) {
    notes.push(
      'Open the chosen file with office_read (docx/pptx/xlsx). doc/ppt preview as extracted ' +
        'text only. PDFs can be shown in the viewer, but their text cannot be read yet. ' +
        'This index is a cache and the path is the truth.',
    );
  }

  return text(
    `${heading}\n${lines.join('\n')}${notes.length ? `\n\n${notes.join('\n')}` : ''}`,
    {
      root: index.root,
      query,
      total: index.total,
      pending: index.pending,
      truncated: index.truncated,
      indexedAt: index.scannedAt,
      results: rows.map((row) => ({
        path: row.path,
        relPath: row.relPath,
        ext: row.ext,
        size: row.size,
        mtime: row.mtimeMs,
        title: row.title,
        snippet: row.snippet,
      })),
    },
  );
}

async function toolRead(p: Record<string, unknown>, sessionId?: string | null): Promise<ToolResult> {
  const path = String(p.path ?? '');
  if (!path) throw new Error('office_read: path is required');
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'xlsx') {
    const sheets = await readXlsxStructure(await readOfficeBytes(path));
    // Capped per sheet: a real workbook holds more cells than an agent needs
    // to see, and the ADDRESSES are the point — they are what an edit targets.
    const MAX_CELLS = 40;
    return text(
      `${path}: ${sheets.length} sheet(s)\n` +
        sheets
          .map((s) => {
            const shown = s.cells.slice(0, MAX_CELLS);
            const more = s.cells.length - shown.length;
            const cells = shown
              .map((c) => `${c.address}=${c.value === null ? '∅' : c.value}${c.formula ? ` [${c.formula}]` : ''}`)
              .join(', ');
            return `  ${s.name} — ${s.cells.length} cell(s)${cells ? `: ${cells}` : ''}${more > 0 ? ` … ${more} more` : ''}`;
          })
          .join('\n'),
      { sheetCount: sheets.length, sheets },
    );
  }
  if (ext === 'docx') {
    // Read through the bridge, because the useful readout — block indexes
    // against the CURRENT editor state — only exists there. Reading the bytes
    // instead would produce indexes that go stale the moment anything else
    // touches the document.
    requireDocxOpen(path);
    const result = (await withMcpLock(async () => {
      await ensureDocxActive(path, sessionId);
      return mcpCommand('read_document', {}, undefined, tabForPath(path) ?? undefined);
    })) as { text?: string } | undefined;
    return text(String(result?.text ?? ''), { path, via: 'viewer' });
  }
  if (ext !== 'pptx') {
    return text(`office_read: "${ext}" is not wired yet — pptx, xlsx and docx are. Do not retry; this format has no structural reading yet.`);
  }
  const opened = await openPptx(await readOfficeBytes(path));
  const slides = opened.deck.slides.map((s, i) => ({
    index: i,
    id: (s as unknown as { slideId?: string }).slideId ?? null,
    path: s.path,
    elements: (s.elements ?? []).map((el) => {
      const e = el as unknown as Record<string, unknown>;
      return {
        id: e.id ?? null,
        name: e.name ?? null,
        kind: e.kind ?? e.type ?? null,
        // The box is what an agent needs to reason about position; keep it
        // flat and numeric rather than dumping the element.
        ...(e.box ? { box: e.box } : {}),
      };
    }),
  }));
  return text(
    `${path}: ${slides.length} slide(s)\n` +
      slides
        .map((s) => `  [${s.index}] ${s.path} — ${s.elements.length} element(s): ` +
          s.elements.map((e) => `${e.id}(${e.kind})`).join(', '))
        .join('\n'),
    { slideCount: slides.length, slides },
  );
}

async function toolEdit(p: Record<string, unknown>, sessionId?: string | null): Promise<ToolResult> {
  const path = String(p.path ?? '');
  if (!path) throw new Error('office_edit: path is required');
  const ops = Array.isArray(p.ops) ? (p.ops as Op[]) : [];
  if (ops.length === 0) throw new Error('office_edit: ops is required and must be non-empty');
  const dryRun = p.dryRun === true;
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'xlsx') {
    // Same mtime baseline as pptx below: `filesystem.write` is a
    // compare-and-swap, so an edit made between read and save is refused
    // rather than clobbered.
    const info = await stat(path);
    const bytes = await readOfficeBytes(path);
    const cellOps = ops as unknown as CellOp[];
    if (dryRun) {
      const planned = await planXlsxEdits(bytes, cellOps);
      return text(
        `dry run ok — ${cellOps.length} op(s) validated, nothing written:\n` +
          `  would touch: ${planned.touchedEntries.join(', ') || '(nothing)'}`,
        { applied: false, dryRun: true, plan: planned.touchedEntries },
      );
    }
    const next = await applyXlsxEdits(bytes, cellOps);
    const written = await writeOfficeBytes(path, next, info.mtimeMs);
    return {
      ...text(`applied ${cellOps.length} op(s) to ${path} and saved (${next.length} bytes)`, {
        applied: true,
        mtime: (written as { mtime?: number })?.mtime,
      }),
      ...reportDocWork(sessionId ?? null, path, ext, 'updated', cellOps.length),
    };
  }
  if (ext === 'docx') {
    // GenOffice's editor bridge does the work — see backend/docx.ts for why
    // there is no byte-level path here. `apply_ops` is validated as a batch by
    // the op registry itself, so a rejection names the offending op. The lock
    // spans activate → apply → save: one panel, one live editor, so another
    // call switching documents mid-sequence would land the rest of THIS
    // sequence on the wrong file.
    requireDocxOpen(path);
    const commands = planDocxCommands(ops as unknown as DocxOp[], dryRun);
    const steps: unknown[] = [];
    const saved = await withMcpLock(async () => {
      for (const step of commands) {
        // Re-verify before EVERY command: a strip click can switch the editor
        // mid-sequence, and the next command must re-point it rather than land
        // on the user's document. Unchanged target = fast path, no switch.
        await ensureDocxActive(path, sessionId);
        steps.push(await mcpCommand(step.command, step.payload, undefined, tabForPath(path) ?? undefined));
      }
      if (dryRun) return undefined;
      // The edits so far are in the LIVE editor; the file on disk still holds
      // the old bytes until this save. `overwrite` says "write this path
      // deliberately" — the real guard is `filesystem.write`'s mtime
      // compare-and-swap, which refuses if the file changed since the viewer
      // opened it.
      return (await mcpCommand('save_document', { path, overwrite: true }, undefined, tabForPath(path) ?? undefined)) as
        | { ok?: boolean; path?: string }
        | undefined;
    });
    if (dryRun) {
      const plan = (steps[0] as { output?: string } | undefined)?.output ?? '';
      return text(`dry run ok — ${ops.length} op(s) validated, nothing written:\n${plan}`, {
        applied: false,
        dryRun: true,
        steps,
      });
    }
    if (saved?.ok !== true) throw new Error(`office_edit: the document could not be saved to ${path}`);
    const info = await stat(path).catch(() => null);
    return {
      ...text(`applied ${ops.length} op(s) to ${path} and saved`, {
        applied: true,
        path,
        mtime: info?.mtimeMs,
        steps,
      }),
      ...reportDocWork(sessionId ?? null, path, ext, 'updated', ops.length),
    };
  }
  if (ext !== 'pptx') {
    return text(`office_edit: "${ext}" is not wired yet — pptx, xlsx and docx are. Do not retry; this format has no structural editing yet.`);
  }

  // The mtime read here is the baseline the host's conflict check compares
  // against on write, so an edit made between read and save is refused
  // rather than silently clobbered.
  const info = await stat(path);
  const opened = await openPptx(await readOfficeBytes(path));
  const result = runTxn(opened, { dryRun, ops });

  // Order matters: failures first, THEN dryRun, then a real apply.
  // `runTxn` reports `applied: false` for a dry run too (nothing was
  // applied), so testing `applied` before `dryRun` sends every dry run down
  // the rejection path with an empty failure list.
  if (result.failures && result.failures.length > 0) {
    // Validation failures must NOT throw: the host turns a thrown error into
    // a bare string and drops `details`, and the typed fields are the whole
    // value — an agent self-corrects from `failures[].error`, not from prose.
    const lines = result.failures.map((f) => `  [${f.index}] ${f.error}`);
    return text(
      `nothing applied — ${result.failures.length} op(s) rejected:\n${lines.join('\n')}\n\n` +
        `Fix the listed op(s) and resend the whole batch.`,
      {
        applied: false,
        failures: result.failures,
        // Lets the agent notice its cached op list is stale.
        opsAvailable: opNames().length,
      },
    );
  }

  if (dryRun) {
    return text(`dry run ok — ${ops.length} op(s) validated, nothing written:\n  ${(result.plan ?? []).join('\n  ')}`, {
      applied: false,
      dryRun: true,
      plan: result.plan ?? [],
    });
  }

  const bytes = await savePptx(opened);
  const written = await writeOfficeBytes(path, bytes, info.mtimeMs);
  return {
    ...text(
      `applied ${result.records?.length ?? ops.length} op(s) to ${path} and saved (${bytes.length} bytes)`,
      { applied: true, records: result.records ?? [], mtime: (written as { mtime?: number })?.mtime },
    ),
    ...reportDocWork(sessionId ?? null, path, ext, 'updated', result.records?.length ?? ops.length),
  };
}

/**
 * Show a file the agent just created, and switch the right column to it.
 *
 * Creation is a foreground request: the user asked for this file and expects
 * to see it. (Background edits still go through `notifyFileChanged`, which
 * reloads a tab without changing focus.) Best-effort: the file is already on
 * disk, so a host that refuses the open must not turn a successful create into
 * a failed tool call.
 */
async function revealCreated(path: string): Promise<void> {
  try {
    await openInViewer(path, true);
  } catch (err) {
    ctx.log.warn(
      `could not reveal ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Create a NEW Office document, optionally with its first content.
 *
 * Why this exists: without it the agent reaches for Python (python-pptx,
 * python-docx, openpyxl) when the user asks for a new deck/sheet/doc — and a
 * machine with this app installed has no reason to have a Python toolchain.
 * The engines are the same ones the read/edit paths already use, so a created
 * file is exactly the kind of file `office_edit` can edit afterwards:
 *
 *   pptx  createBlankPptx() + the office_edit op registry (one blank slide)
 *   xlsx  GenOffice's blank workbook + the cell ops office_edit uses
 *   docx  GenOffice's blank document; content ops run in the live editor,
 *         exactly as office_edit does (the document opens in the viewer)
 *
 * Two safety rules: an existing path is refused unless `overwrite: true`, and
 * a rejected pptx/xlsx batch writes NOTHING (validation happens in memory
 * before the write). docx is the one exception — its editor needs the file to
 * exist before it can open it, so a rejected content batch leaves the blank
 * document behind and says so.
 */
async function toolCreate(p: Record<string, unknown>, sessionId?: string | null): Promise<ToolResult> {
  const path = String(p.path ?? '');
  if (!path) throw new Error('office_create: path is required');
  if (!isAbsolute(path)) {
    throw new Error(
      `office_create: path must be absolute — "${path}" would resolve against the app's own ` +
        "directory, not the user's workspace. Join the workspace root in first.",
    );
  }
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext !== 'pptx' && ext !== 'docx' && ext !== 'xlsx' && ext !== 'pdf' && ext !== 'csv') {
    throw new Error(
      `office_create: "${ext}" is not supported — .pptx, .docx, .xlsx, .pdf and .csv can be created. ` +
        'For markdown or plain text, write the file with the ordinary file tools.',
    );
  }
  const ops = Array.isArray(p.ops) ? (p.ops as Record<string, unknown>[]) : [];
  const csv = typeof p.csv === 'string' ? p.csv : '';
  const textContent = typeof p.text === 'string' ? p.text : '';
  if (csv.trim() && ext !== 'xlsx' && ext !== 'csv') {
    throw new Error(
      'office_create: "csv" only applies to .xlsx (a sheet grid) and .csv (the file itself) — ' +
        'for pptx/docx/pdf use "ops" (or text/pages/pageSize for pdf).',
    );
  }
  if (textContent.trim() && ext !== 'pdf') {
    throw new Error(
      `office_create: "text" only applies to .pdf — for .${ext} use "ops" (or "csv" for xlsx).`,
    );
  }
  if (ops.length > 0 && (ext === 'pdf' || ext === 'csv')) {
    throw new Error(
      `office_create: .${ext} takes no "ops" — ` +
        (ext === 'pdf' ? 'use "pages" and "pageSize", then pdf_edit for page surgery.' : 'use the "csv" text.'),
    );
  }
  const existing = await stat(path).catch(() => null);
  if (existing?.isDirectory()) throw new Error(`office_create: ${path} is a directory`);
  if (existing && p.overwrite !== true) {
    throw new Error(
      `${path} already exists — office_create only writes a new file. ` +
        'Pass overwrite: true to replace it, or use office_edit to change the existing document.',
    );
  }

  if (ext === 'csv') {
    // GenOffice's CSV create path prefixes a UTF-8 BOM so Excel reopens the
    // file as UTF-8 instead of the local ANSI code page.
    const bytes = new TextEncoder().encode(`﻿${csv}`);
    const written = await writeOfficeBytes(path, bytes);
    await revealCreated(path);
    return {
      ...text(`created ${path} (CSV, ${bytes.length} bytes)`, {
        created: true,
        path,
        mtime: (written as { mtime?: number })?.mtime,
      }),
      ...reportDocWork(sessionId ?? null, path, ext, 'created', ops.length),
    };
  }

  if (ext === 'pdf') {
    // GenOffice's "New PDF": a blank A4, repeated to the requested page count.
    const rawPages = Number(p.pages);
    const pages = Math.min(Math.max(Number.isFinite(rawPages) ? Math.floor(rawPages) : 1, 1), 200);
    const rawPaper = typeof p.pageSize === 'string' ? p.pageSize : 'A4';
    const paper = rawPaper in PDF_PAPER ? (rawPaper as keyof typeof PDF_PAPER) : 'A4';
    let bytes = await blankPdf(pages, paper);
    let textLines = 0;
    if (textContent.trim()) {
      // GenOffice's text-insert layer: system font resolution (CJK included),
      // harfbuzz subsetting, real searchable text objects.
      const info = await pdfPageInfo(bytes, 0);
      const rawSize = Number(p.fontSize);
      const fontSize = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 18;
      const font = typeof p.font === 'string' && p.font.trim() ? p.font.trim() : undefined;
      const inserted = await insertPdfText(bytes, [
        {
          pageIndex: 0,
          origin: [72, info.height - 72],
          text: textContent,
          fontSize,
          color: [0, 0, 0],
          rotate: info.rotation,
          ...(font ? { font } : {}),
        },
      ]);
      if (inserted.skipped.length > 0) {
        throw new Error(
          `office_create: could not place the text — ${inserted.skipped[0].reason}. ` +
            'Try a different font, or pass fontSize; no file was written.',
        );
      }
      bytes = inserted.bytes;
      textLines = textContent.split('\n').length;
    }
    const written = await writeOfficeBytes(path, bytes);
    await revealCreated(path);
    return {
      ...text(
        `created ${path} (PDF, ${pages} page(s), ${paper}${textLines > 0 ? `, text: ${textLines} line(s)` : ''}, ${bytes.length} bytes)`,
        {
          created: true,
          path,
          pages,
          pageSize: paper,
          ...(textLines > 0 ? { textLines } : {}),
          mtime: (written as { mtime?: number })?.mtime,
        },
      ),
      ...reportDocWork(sessionId ?? null, path, ext, 'created', ops.length),
    };
  }

  if (ext === 'xlsx') {
    const sheetName =
      typeof p.sheetName === 'string' && p.sheetName.trim() ? p.sheetName.trim() : 'Sheet1';
    const fromCsv = csv.trim().length > 0;
    // GenOffice's own grid → workbook path (the one its AI create_document
    // uses): comma-fixed, numeric cells detected, quoted fields honoured.
    let bytes: Uint8Array = new Uint8Array(
      fromCsv ? await sheetCsvToXlsxBuffer(csv, sheetName) : await blankXlsxBuffer(sheetName),
    );
    // Applied in memory first: a bad cell op must not leave a half-created file.
    if (ops.length > 0) bytes = await applyXlsxEdits(bytes, ops as unknown as CellOp[]);
    const written = await writeOfficeBytes(path, bytes);
    await revealCreated(path);
    return {
      ...text(
        `created ${path} (sheet "${sheetName}"${fromCsv ? ', from CSV' : ''}, ` +
          `${ops.length} cell op(s), ${bytes.length} bytes)`,
        {
          created: true,
          path,
          mtime: (written as { mtime?: number })?.mtime,
        },
      ),
      ...reportDocWork(sessionId ?? null, path, ext, 'created', ops.length),
    };
  }

  if (ext === 'docx') {
    // The document must exist before its editor can open it, so the blank
    // lands first and content ops run second through the same bridge
    // office_edit uses.
    const written = await writeOfficeBytes(path, await buildBlankDocx());
    if (ops.length === 0) {
      await revealCreated(path);
      return {
        ...text(`created ${path} (blank document)`, {
          created: true,
          path,
          mtime: (written as { mtime?: number })?.mtime,
        }),
        ...reportDocWork(sessionId ?? null, path, ext, 'created', ops.length),
      };
    }
    const commands = planDocxCommands(ops as unknown as DocxOp[], false);
    const steps: unknown[] = [];
    const saved = await withMcpLock(async () => {
      for (const step of commands) {
        await ensureDocxActive(path, sessionId);
        steps.push(await mcpCommand(step.command, step.payload, undefined, tabForPath(path) ?? undefined));
      }
      return (await mcpCommand('save_document', { path, overwrite: true }, undefined, tabForPath(path) ?? undefined)) as
        | { ok?: boolean }
        | undefined;
    });
    if (saved?.ok !== true) {
      throw new Error(
        `office_create: ${path} was created but its content batch could not be saved — ` +
          'open it and use office_edit, or overwrite: true to retry the whole batch',
      );
    }
    const info = await stat(path).catch(() => null);
    return {
      ...text(`created ${path} and applied ${ops.length} op(s)`, {
        created: true,
        path,
        mtime: info?.mtimeMs,
        steps,
      }),
      ...reportDocWork(sessionId ?? null, path, ext, 'created', ops.length),
    };
  }

  // pptx
  const opened = await openPptx(await createBlankPptx());
  let records: unknown[] = [];
  if (ops.length > 0) {
    const result = runTxn(opened, { ops: ops as unknown as Op[] });
    if (result.failures && result.failures.length > 0) {
      const lines = result.failures.map((f) => `  [${f.index}] ${f.error}`);
      return text(
        `nothing created — ${result.failures.length} op(s) rejected:\n${lines.join('\n')}\n\n` +
          'Fix the listed op(s) and resend the whole batch. No file was written.',
        { created: false, failures: result.failures, opsAvailable: opNames().length },
      );
    }
    records = result.records ?? [];
  }
  const bytes = await savePptx(opened);
  const written = await writeOfficeBytes(path, bytes);
  await revealCreated(path);
  return {
    ...text(
      `created ${path} (${opened.deck.slides.length} slide(s), ${records.length} op(s), ${bytes.length} bytes)`,
      {
        created: true,
        path,
        slides: opened.deck.slides.length,
        records,
        mtime: (written as { mtime?: number })?.mtime,
      },
    ),
    ...reportDocWork(sessionId ?? null, path, ext, 'created', ops.length),
  };
}

/**
 * PDF page surgery, on GenOffice's own pdf-lib helpers.
 *
 * The source is only ever READ: the result goes to `outputPath`, and an
 * existing target is refused unless `overwrite` is set. An in-place edit
 * (`outputPath === path`) therefore needs both `overwrite: true` and passes
 * the source's mtime through the host's compare-and-swap write.
 */
async function toolPdfEdit(p: Record<string, unknown>, sessionId?: string | null): Promise<ToolResult> {
  const path = String(p.path ?? '');
  if (!path) throw new Error('pdf_edit: path is required');
  if (!isAbsolute(path)) throw new Error('pdf_edit: path must be absolute');
  const ops = Array.isArray(p.ops) ? (p.ops as PdfOp[]) : [];
  if (ops.length === 0) throw new Error('pdf_edit: ops is required and must be non-empty');
  const outputPath = String(p.outputPath ?? '').trim();
  if (!outputPath) {
    throw new Error(
      'pdf_edit: outputPath is required — it writes a NEW file. For an in-place edit, pass the ' +
        'same path plus overwrite: true.',
    );
  }
  if (!isAbsolute(outputPath)) throw new Error('pdf_edit: outputPath must be absolute');
  const overwrite = p.overwrite === true;
  const inputStat = await stat(path);
  const sourceBytes = new Uint8Array(await readFile(path));
  const sourcePages = await pdfPageCount(sourceBytes);
  const result = await applyPdfOps(sourceBytes, ops, async (src) => {
    if (!isAbsolute(src)) throw new Error(`pdf_edit: referenced PDF path must be absolute: ${src}`);
    return new Uint8Array(await readFile(src));
  });

  if (result.splitParts) {
    // `split` writes several files; outputPath is their DIRECTORY.
    const base = basename(path).replace(/\.pdf$/i, '');
    const files: string[] = [];
    for (let i = 0; i < result.splitParts.length; i++) {
      const out = join(outputPath, `${base}-${i + 1}.pdf`);
      const info = await stat(out).catch(() => null);
      if (info && !overwrite) {
        throw new Error(`${out} already exists — pass overwrite: true to replace the set`);
      }
      await writeOfficeBytes(out, result.splitParts[i]);
      files.push(out);
    }
    // Each split part is its own document in this run's completion card.
    if (sessionId) for (const out of files) recordDocWork(sessionId, out, 'pdf', 'created', 0);
    return text(
      `split ${path} (${sourcePages} page(s)) into ${files.length} file(s):\n  ${files.join('\n  ')}`,
      { applied: true, source: path, files, records: result.records },
    );
  }

  const inPlace = samePath(outputPath, path);
  const info = await stat(outputPath).catch(() => null);
  if (info?.isDirectory()) throw new Error(`pdf_edit: ${outputPath} is a directory`);
  if (info && !overwrite) {
    throw new Error(
      `${outputPath} already exists — pass overwrite: true to replace it, or choose a new outputPath`,
    );
  }
  const written = await writeOfficeBytes(outputPath, result.bytes, inPlace ? inputStat.mtimeMs : undefined);
  const outPages = await pdfPageCount(result.bytes);
  await revealCreated(outputPath);
  return {
    ...text(
      `wrote ${outputPath} (${outPages} page(s)):\n  ` +
        result.records.map((r) => `${r.op}${r.detail ? ` — ${r.detail}` : ''}`).join('\n  '),
      {
        applied: true,
        path: outputPath,
        source: path,
        sourcePages,
        pages: outPages,
        records: result.records,
        mtime: (written as { mtime?: number })?.mtime,
      },
    ),
    ...reportDocWork(sessionId ?? null, outputPath, 'pdf', 'updated', ops.length),
  };
}

/**
 * PDF → DOCX / PPTX / XLSX, on GenOffice's pure-local pdf2docx rebuild.
 *
 * Pages with no text layer (scans) come through as full-page images; the
 * result says so rather than pretending the text was recovered.
 */
async function toolPdfConvert(p: Record<string, unknown>, sessionId?: string | null): Promise<ToolResult> {
  const path = String(p.path ?? '');
  if (!path) throw new Error('pdf_convert: path is required');
  if (!isAbsolute(path)) throw new Error('pdf_convert: path must be absolute');
  const to = String(p.to ?? '').toLowerCase();
  if (to !== 'docx' && to !== 'pptx' && to !== 'xlsx') {
    throw new Error('pdf_convert: "to" must be "docx", "pptx" or "xlsx"');
  }
  const outputPath = String(p.outputPath ?? '').trim() || path.replace(/\.[^./\\]+$/, '') + `.${to}`;
  if (!isAbsolute(outputPath)) throw new Error('pdf_convert: outputPath must be absolute');
  if (!outputPath.toLowerCase().endsWith(`.${to}`)) {
    throw new Error(`pdf_convert: outputPath must end with .${to}`);
  }
  if (samePath(outputPath, path)) throw new Error('pdf_convert: outputPath must differ from the source PDF');
  const overwrite = p.overwrite === true;
  const info = await stat(outputPath).catch(() => null);
  if (info?.isDirectory()) throw new Error(`pdf_convert: ${outputPath} is a directory`);
  if (info && !overwrite) {
    throw new Error(`${outputPath} already exists — pass overwrite: true to replace it`);
  }

  const sourceBytes = new Uint8Array(await readFile(path));
  // An encrypted PDF cannot be counted without its password; the converter
  // takes the password, so a failed count is not a failed conversion.
  const sourcePages = await pdfPageCount(sourceBytes).catch(() => 0);
  const password = typeof p.password === 'string' && p.password ? p.password : undefined;
  const result = await convertPdfToOffice(sourceBytes, to, password);
  const written = await writeOfficeBytes(outputPath, result.bytes);
  await revealCreated(outputPath);
  const note = result.scannedDocument
    ? ' — this PDF has no usable text layer; scanned pages were exported as images'
    : '';
  const warnings = result.warnings.length > 0 ? `\nNotes:\n  ${result.warnings.join('\n  ')}` : '';
  return {
    ...text(
      `converted ${path} (${sourcePages} page(s)) → ${outputPath} [${to.toUpperCase()}] ` +
        `(${result.bytes.length} bytes)${note}${warnings}`,
      {
        converted: true,
        source: path,
        path: outputPath,
        pages: result.pages,
        warnings: result.warnings,
        scannedDocument: result.scannedDocument,
        mtime: (written as { mtime?: number })?.mtime,
      },
    ),
    ...reportDocWork(sessionId ?? null, outputPath, to, 'created', 0),
  };
}

/**
 * PDF pages → PNG, on GenOffice's pdfium page renderer + PNG encoder.
 *
 * Nothing here needs a canvas: pdfium rasterizes, the vendored encoder writes
 * the image, and the export naming is GenOffice's own (`<base>-p<n>.png`).
 * `pages` are 0-based source indexes; omitted renders every page.
 */
async function toolPdfRender(p: Record<string, unknown>): Promise<ToolResult> {
  const path = String(p.path ?? '');
  if (!path) throw new Error('pdf_render: path is required');
  if (!isAbsolute(path)) throw new Error('pdf_render: path must be absolute');
  const rawPages = Array.isArray(p.pages) ? p.pages : null;
  const pages = rawPages
    ? [
        ...new Set(
          rawPages.map((v) => {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0) {
              throw new Error(
                `pdf_render: pages contains "${String(v)}" — page indexes are 0-based integers`,
              );
            }
            return n;
          }),
        ),
      ]
    : null;
  const rawScale = Number(p.scale);
  const scale = Math.min(Math.max(Number.isFinite(rawScale) ? rawScale : 2, 0.5), 4);
  const base = basename(path).replace(/\.pdf$/i, '');
  const rawDir = String(p.outputDir ?? '').trim();
  const outputDir = rawDir || join(dirname(path), `${base}-pages`);
  if (!isAbsolute(outputDir)) throw new Error('pdf_render: outputDir must be absolute');
  const overwrite = p.overwrite === true;
  const password = typeof p.password === 'string' && p.password ? p.password : undefined;

  const rendered = await renderPdfPages(new Uint8Array(await readFile(path)), pages, scale, password);
  const { buildExportImagePaths } = await import(
    '../../vendor/genoffice/apps/pdf/src/main/export-images'
  );
  const files = buildExportImagePaths(outputDir, base, rendered.map((r) => r.index + 1), 'png');
  // Preflight every target: a half-written set is worse than a clean refusal.
  for (const out of files) {
    const info = await stat(out).catch(() => null);
    if (info && !overwrite) throw new Error(`${out} already exists — pass overwrite: true to replace the set`);
  }
  for (let i = 0; i < rendered.length; i++) await writeOfficeBytes(files[i], rendered[i].data);
  // Rendering is an INSPECTION step: the agent renders pages to look at them,
  // usually from a file the user just attached. Revealing the first page would
  // take the right column away from whatever the user was doing — the
  // "sending an attachment opens the viewer by itself" complaint. The PNG
  // paths are in the result, so the agent can still point at them; the user
  // opens them when they want to.
  return text(
    `rendered ${rendered.length} page(s) from ${path} to PNG @${scale}x:\n  ${files.join('\n  ')}`,
    {
      applied: true,
      source: path,
      files,
      pages: rendered.map((r) => ({
        page: r.index,
        width: r.pixelWidth,
        height: r.pixelHeight,
      })),
    },
  );
}

// ── Tool dispatch ────────────────────────────────────────────────────

/** One tool call. The SDK turns the return value into the tool result. */
async function runTool(name: string, p: Record<string, unknown>, call: { sessionId?: string } = {}): Promise<ToolResult> {
  const sessionId = call.sessionId ?? null;
  switch (name) {
    case 'files_search':
      return await toolSearch(p);
    case 'office_guide':
      return await toolGuide(p);
    case 'office_read':
      return await toolRead(p, sessionId);
    case 'office_edit':
      return await toolEdit(p, sessionId);
    case 'office_create':
      return await toolCreate(p, sessionId);
    case 'pdf_edit':
      return await toolPdfEdit(p, sessionId);
    case 'pdf_convert':
      return await toolPdfConvert(p, sessionId);
    case 'pdf_render':
      return await toolPdfRender(p);

    // ── opening files in the viewer ──
    //
    // `path` is optional: with none, this opens whatever the user already has on
    // screen, which is the case a docx edit starts from. `panelId` exists so a
    // hidden panel can be opened without a tool per panel.
    case 'files_open': {
      const panelId = typeof p.panelId === 'string' && p.panelId ? String(p.panelId) : 'viewer';
      if (panelId !== 'viewer') {
        await ctx.call('panel.open', { panelId, focus: true });
        return text(`已打开面板 ${panelId}`);
      }
      const target = typeof p.path === 'string' && p.path ? String(p.path) : activeFileOf(sessionId);
      if (!target) throw new Error('no file to open (pass path or click a file first)');
      await openInViewer(target);
      return text(`已在查看器中打开 ${target}`);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── UI requests ──────────────────────────────────────────────────────
//
// The panel's SDK can also send `{kind:'request', id, method, params}` and
// await a `{kind:'response', id, ...}`. The desktop shim uses this for the
// two things the panel cannot do itself: call a host capability (only the
// backend may), and run Node-side code (font metrics reads font files).
async function onUiRequest(
  method: string,
  params: Record<string, unknown> = {},
  panelId?: string | null,
  meta?: { tabId?: string; sessionId?: string; workspaceId?: string },
): Promise<unknown> {
  const tabId = meta?.tabId ?? panelId ?? PANEL;
  switch (method) {
    case 'chat.send': {
      const t = String(params.text ?? '').trim();
      if (!t) throw new Error('chat.send: text is required');
      return ctx.call('chat.send', { text: t });
    }
    case 'mcp.ready': {
      // The docs panel announces itself once its editor has a loaded document.
      // With the multi-doc viewer the announcement names WHICH document is
      // loaded — `ensureDocxActive` waits for its target to be announced, so a
      // tab switch cannot race a queued command onto the wrong editor.
      const path = String(params.path ?? '');
      if (path) announceMcpReady(path);
      mcpReady = true;
      return { ok: true };
    }
    case 'file.open': {
      // The empty viewer's own workspace tree chose a document. It loads in
      // THIS tab (not a new one), and the host tab's label/params follow.
      const path = String(params.path ?? '');
      if (!path) throw new Error('file.open: path is required');
      await openInTab(tabId, path);
      // The user picked the file in THIS pane, so it is the one they are now
      // working in — in a split, that also makes it the agent's current
      // document. The host re-fires panel.activated after focusing it.
      await ctx.call('panel.focusTab', { panelId: PANEL, tabId, focus: true }).catch(() => {});
      return { ok: true, path };
    }
    case 'file.listDir': {
      // Lazy directory listing for the empty state's workspace tree. The page
      // sends the directory it wants to expand; this backend has Node fs and
      // the plugin's filesystem permission, so no new host capability.
      const dir = String(params.path ?? '');
      if (!dir) throw new Error('file.listDir: path is required');
      const entries = await readdir(dir, { withFileTypes: true });
      return {
        path: dir,
        entries: entries
          .filter((e) => !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, path: join(dir, e.name), dir: e.isDirectory() }))
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
      };
    }
    case 'file.activateTab': {
      // Legacy strip request (the internal strip is gone). Kept as a same-tab
      // navigation so an old cached page cannot wedge.
      const path = String(params.path ?? '');
      if (!path) throw new Error('file.activateTab: path is required');
      await openInTab(tabId, path);
      return { ok: true };
    }
    case 'file.closeTab': {
      const path = String(params.path ?? '');
      if (!path) throw new Error('file.closeTab: path is required');
      if (tabFiles.get(tabId) && samePath(tabFiles.get(tabId)!, path)) {
        setTabFile(tabId, '');
        renderTabFile(tabId);
        await publishTab(tabId);
      }
      return { ok: true };
    }
    case 'file.reorderTab':
      return { ok: true };
    case 'file.splitRight':
      return { ok: false, reason: 'split removed' };
    case 'mcp.result': {
      const requestId = String(params.requestId ?? '');
      const entry = mcpPending.get(requestId);
      // A late or duplicate report is not an error: the command already
      // settled (usually by timing out) and nobody is waiting any more.
      if (!entry) return { ok: false, reason: 'no such pending command' };
      mcpPending.delete(requestId);
      clearTimeout(entry.timer);
      if (params.ok === false) {
        entry.reject(new Error(String(params.error ?? 'the viewer reported a failure')));
      } else {
        entry.resolve(params.result);
      }
      return { ok: true };
    }
    case 'file.scratchPath': {
      // A stable, writable file the panel can push content into and then
      // read back over `pi-plugin://…/ws-file`. The html viewer's preview
      // frame needs exactly that shape: its iframe src is
      // `${url}?v=${nonce}` (PreviewFrame.tsx), so the URL has to stay put
      // while its CONTENT changes between reloads. GenOffice serves that
      // from `html-preview://` in its own main process; here a temp file
      // behind ws-file gives the same behaviour without a new scheme.
      //
      // One file per backend process: there is one viewer panel, and a
      // stable name is the point.
      const dir = join(tmpdir(), 'pi-files-preview');
      await mkdir(dir, { recursive: true });
      // One preview file per HOST TAB: two html previews of different documents
      // must not overwrite each other's content between iframe reloads.
      const safeTab = tabId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-48);
      return { path: join(dir, `preview-${process.pid}-${safeTab}.html`) };
    }
    case 'file.pickOpenPath': {
      // The host owns the dialog; the panel shim has always asked for this
      // and used to get "unknown ui request" back, which is why "打开" and
      // "另存为" quietly did nothing.
      const opened = (await ctx.call('dialog.openFile', {
        ...(params.title ? { title: String(params.title) } : {}),
        ...(params.filters ? { filters: params.filters } : {}),
        ...(params.multi ? { multi: true } : {}),
      })) as { path?: string | null; paths?: string[] } | undefined;
      return { path: opened?.path ?? null, paths: opened?.paths ?? [] };
    }
    case 'file.pickSavePath': {
      const saved = (await ctx.call('dialog.saveFile', {
        ...(params.title ? { title: String(params.title) } : {}),
        ...(params.defaultName ? { defaultName: String(params.defaultName) } : {}),
        ...(params.filters ? { filters: params.filters } : {}),
      })) as { path?: string | null } | undefined;
      return { path: saved?.path ?? null };
    }
    case 'file.pickDirectory': {
      // Folder picker for exports: the host dialog answers it, same
      // "the user picked it, so it is authorized" contract as the file pickers.
      const picked = (await ctx.call('dialog.openFile', {
        ...(params.title ? { title: String(params.title) } : {}),
        directory: true,
      })) as { path?: string | null } | undefined;
      return { path: picked?.path ?? null };
    }
    case 'pdf.writeFromImages': {
      // Export → PDF: one rasterized page per PDF page. Upstream prints a hidden
      // window to PDF, which keeps text vector; a panel has no printToPDF, so the
      // renderer rasterizes at 2× and this assembles the pages.
      const path = String(params.path ?? '');
      const pages = Array.isArray(params.pages) ? (params.pages as string[]) : [];
      const widthPx = Number(params.widthPx) || 0;
      const heightPx = Number(params.heightPx) || 0;
      if (!path) throw new Error('pdf.writeFromImages: path is required');
      if (pages.length === 0 || !(widthPx > 0) || !(heightPx > 0)) {
        throw new Error('pdf.writeFromImages: pages and the page size are required');
      }
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.create();
      // CSS px → pt at 96 dpi, so the PDF page box keeps the slide's ratio.
      const w = (widthPx * 72) / 96;
      const h = (heightPx * 72) / 96;
      for (const png of pages) {
        const img = await doc.embedPng(Buffer.from(png, 'base64'));
        const page = doc.addPage([w, h]);
        page.drawImage(img, { x: 0, y: 0, width: w, height: h });
      }
      const bytes = await doc.save();
      await ctx.call('filesystem.write', {
        path,
        contentB64: Buffer.from(bytes).toString('base64'),
      });
      return { ok: true, path, pages: pages.length };
    }
    case 'file.write': {
      const path = String(params.path ?? '');
      if (!path) throw new Error('file.write: path is required');
      return ctx.call('filesystem.write', {
        path,
        contentB64: String(params.base64 ?? ''),
        expectedMtime: typeof params.expectedMtime === 'number' ? params.expectedMtime : undefined,
      });
    }
    case 'file.stat': {
      const path = String(params.path ?? '');
      const info = await stat(path);
      return { path, size: info.size, mtime: info.mtimeMs };
    }
    case 'file.extractText': {
      // Legacy Office (doc / ppt) has no renderer here, and writing one means
      // an OLE2 parser. GenOffice already ships the text extractors it uses for
      // its own chat attachments, so the viewer shows their output and says the
      // layout is not reproduced. See PLUGIN.md, 覆盖范围.
      const path = String(params.path ?? '');
      if (!path) throw new Error('file.extractText: path is required');
      const ext = extname(path).toLowerCase();
      const maxChars = typeof params.maxChars === 'number' ? params.maxChars : 200_000;
      const bytes = await readFile(path);
      const text =
        ext === '.doc'
          ? await (await import('../../vendor/genoffice/packages/file-parse/src/doc')).docToText(bytes)
          : ext === '.ppt'
            ? await (await import('../../vendor/genoffice/packages/file-parse/src/ppt')).pptToText(bytes)
            : null;
      if (text === null) throw new Error(`file.extractText: unsupported extension "${ext}"`);
      return text.length > maxChars
        ? { text: text.slice(0, maxChars), total: text.length, truncated: true }
        : { text, total: text.length, truncated: false };
    }
    case 'pdf.save': {
      // GenOffice's PDF surgery, run here rather than reimplemented.
      //
      // `applySaveRequest` is pure bytes-in/bytes-out (1,027 lines of
      // pdf-lib work in apps/pdf/src/main/save-pdf.ts) and imports no
      // Electron. The renderer has already staged every edit — markups,
      // drawings, text edits, page ops — into the request, so all this
      // side has to do is read, apply, write.
      const path = String(params.path ?? '');
      if (!path) throw new Error('pdf.save: path is required');
      const { applySaveRequest } = await import('../../vendor/genoffice/apps/pdf/src/main/save-pdf');
      const { bytes, ...skips } = await applySaveRequest(
        new Uint8Array(await readFile(path)),
        params as never,
      );
      const written = (await ctx.call('filesystem.write', {
        path,
        contentB64: Buffer.from(bytes).toString('base64'),
        expectedMtime: typeof params.expectedMtime === 'number' ? params.expectedMtime : undefined,
      })) as { mtime?: number } | undefined;
      return { ok: true, mtime: written?.mtime, skips };
    }
    case 'font.metrics': {
      const family = String(params.family ?? '');
      // Node-only package (reads sfnt tables off disk) — the reason this
      // call has to come through here rather than run in the panel.
      const { familyVerticalMetrics } = await import('@genoffice/font-metrics');
      return familyVerticalMetrics(family) ?? null;
    }
    case 'state.get': {
      // The boot pull — the same payload panel.mounted pushes, for THIS tab.
      // A page that reloads (format switch, renderer crash) gets its file back.
      const file = tabFiles.get(tabId) ?? '';
      return file ? { path: file, tabs: [file], activePath: file } : { tabs: [], activePath: '' };
    }
    default:
      throw new Error(`unknown ui request: ${method}`);
  }
}

// ── Panel events ─────────────────────────────────────────────────────

// Events are named for what happened (files.save / files.chat) rather than
// routed through the host's ui.event envelope: the SDK stamps the panel id, so
// a one-panel plugin never has to unwrap anything.
async function onEvent(
  _panelId: string,
  event: string,
  data: unknown,
  _ctx: unknown,
  meta?: { tabId?: string },
): Promise<void> {
  const d = (data ?? {}) as Record<string, unknown>;

  // The host tab was closed. Drop the document and the "current tab" mapping
  // so a tool with no `path` never resolves to a file nobody can see.
  if (event === 'panel.closed') {
    const tabId = String(d.tabId ?? meta?.tabId ?? '');
    if (tabId) {
      tabFiles.delete(tabId);
      tabSessions.delete(tabId);
      for (const [sessionId, active] of [...activeTabBySession]) {
        if (active === tabId) activeTabBySession.delete(sessionId);
      }
      if (mcpReadyPath && !isOpenInViewer(mcpReadyPath)) {
        mcpReadyPath = null;
        mcpReady = false;
      }
    }
    return;
  }

  if (event === 'files.chat') {
    // The viewer's own selection box → the conversation. `chat.send` is the
    // same path as the user typing in the composer, so the agent (and its
    // tools, including this plugin's) behaves identically.
    const t = String(d.text ?? '').trim();
    if (!t) return;
    try {
      await ctx.call('chat.send', { text: t });
    } catch (err) {
      ctx.log.error(`chat-send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  if (event !== 'files.save') {
    // Same as knowledge and mail: an event this plugin does not handle is a
    // mistake worth reporting, not something to drop quietly.
    ctx.log.warn(`ignoring unknown panel event "${event}"`);
    return;
  }
  // Viewer write-back: edits are saved with mtime conflict detection.
  const { path, contentB64, expectedMtime } = d as {
    path?: string;
    contentB64?: string;
    expectedMtime?: number;
  };
  if (!path || typeof contentB64 !== 'string') return;
  try {
    const result = (await ctx.call('filesystem.write', { path, contentB64, expectedMtime })) as { mtime?: number } | undefined;
    renderViewer({ saved: true, mtime: result?.mtime }, meta?.tabId);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    ctx.log.error(`file-save failed: ${m}`);
    renderViewer({ error: `保存失败: ${m}` }, meta?.tabId);
  }
}

// ── the plugin ──

/**
 * A card's "打开" button, from either a tool-result card or a plugin message.
 * The path rides in the clicked node's props, so an old card still opens its
 * own document. Fire-and-forget on purpose: the SDK does not await these, so
 * a rejection here would escape its try/catch — handle errors inline.
 */
function openViewerFromCard(eventId: string, kind: string, payload: unknown): void {
  if (kind !== 'click' || eventId !== 'open_viewer') return;
  const target = String((payload as { path?: string } | undefined)?.path ?? '') || activeFileOf();
  if (!target) return;
  void openInViewer(target).catch((err: unknown) => {
    ctx.log.error(`open_viewer failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

plugin({
  onInit(context) {
    ctx = context;
  },

  /**
   * The panel draws from here — onInit runs before anyone has opened it.
   * `meta.sessionId` names the conversation the panel now serves: it arrives on
   * first mount AND again on every session switch, so the panel's bucket
   * follows the conversation on screen.
   *
   * On a session BOUNDARY `params` cannot be trusted: the host's per-session
   * stash runs in a PARENT effect, so the re-mount fires first with the
   * OUTGOING conversation's `{ file }` still attached — applying it here would
   * open the previous conversation's document in the new one's bucket. So a
   * boundary renders the incoming bucket as-is; a genuine file click arrives
   * as a later mount within the settled session. A fresh backend
   * (panelSession null) has no previous conversation, so its first mount
   * applies params normally.
   */
  onPanelMounted(panelId, params, _ctx, meta) {
    const tabId = meta?.tabId ?? panelId ?? PANEL;
    const sessionId = meta?.sessionId ?? null;
    panelSession = sessionId ?? panelSession;
    tabSessions.set(tabId, sessionId);
    if (sessionId) activeTabBySession.set(sessionId, tabId);
    const file = String((params as { file?: string } | undefined)?.file ?? '');
    setTabFile(tabId, file);
    renderTabFile(tabId);
    void publishTab(tabId);
  },

  onPanelActivated(panelId, params, _ctx, meta) {
    const tabId = meta?.tabId ?? panelId ?? PANEL;
    const sessionId = meta?.sessionId ?? null;
    panelSession = sessionId ?? panelSession;
    tabSessions.set(tabId, sessionId);
    if (sessionId) activeTabBySession.set(sessionId, tabId);
    const file = String(
      (params as { file?: string } | undefined)?.file ?? tabFiles.get(tabId) ?? '',
    );
    if (file) setTabFile(tabId, file);
  },

  onTool: (name, params, _ctx, call) => runTool(name, params, call),

  /**
   * The host tells every backend when a conversation switches and when an
   * agent run settles. The settle is the moment a run's document work is
   * complete: one completion card for the whole run, not one per batch.
   */
  onHostEvent(event, data) {
    if (event === 'session.changed') {
      panelSession = (data as { sessionId?: string | null } | null)?.sessionId ?? null;
      return;
    }
    if (event === 'agent.turnEnd') {
      // Not awaited by the SDK's event pump; settleRun handles its own errors.
      void settleRun(data as AgentTurnEndEvent | null);
    }
  },

  onRequest(panelId, method, params, _ctx, meta) {
    return onUiRequest(method, params, panelId, meta);
  },

  /**
   * Card buttons from a persisted office_edit result card (messageRenderer).
   * New runs report through the one completion card instead; this keeps
   * conversations written before that change working.
   */
  onCardEvent(_toolName, eventId, kind, payload) {
    openViewerFromCard(eventId, kind, payload);
  },

  /** Card buttons on a message this plugin posted (`messages.post`). */
  onMessageAction(_messageId, eventId, kind, payload) {
    openViewerFromCard(eventId, kind, payload);
  },

  onEvent,
});

// Re-exported so tests can reach the engine without going through a tool call
// (the smoke test needs a real deck to edit, and building it with the same
// engine the backend ships keeps the two from disagreeing).
export { createBlankPptx, openPptx, savePptx, runTxn, opNames };
