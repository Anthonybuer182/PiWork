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
import { plugin, type PluginContext, type ToolResult } from '@pi/plugin-sdk';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve as resolvePath } from 'node:path';
import { createBlankPptx, openPptx, savePptx } from '@genoffice/pptx-engine';
import { applyXlsxEdits, planXlsxEdits, readXlsxStructure, type CellOp } from './xlsx';
import { DOCX_OP_GROUPS, docxGuide, planDocxCommands, type DocxOp } from './docx';
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

/** Save engine output back to disk through the host, keeping the conflict check. */
async function writeOfficeBytes(path: string, bytes: Uint8Array, expectedMtime?: number): Promise<unknown> {
  return ctx.call('filesystem.write', {
    path,
    contentB64: Buffer.from(bytes).toString('base64'),
    expectedMtime: typeof expectedMtime === 'number' ? expectedMtime : undefined,
  });
}

// ── Tools ────────────────────────────────────────────────────────────

const text = (t: string, details?: unknown): ToolResult => ({
  content: [{ type: 'text', text: t }],
  details,
});

/**
 * Declarative card for office_edit (messageRenderer): what changed, plus a
 * one-click open in the viewer. The file path rides in the Button's props —
 * the click event loops it back as the payload — so each card opens ITS
 * document even when several edits are stacked in one conversation. Cards
 * render only what the host can draw from data; the plugin ships no UI code.
 */
const docCard = (filePath: string, opCount: number, ext: string): unknown => ({
  component: 'Card',
  props: { title: '文档已更新' },
  children: [
    {
      component: 'Row',
      props: { gap: 2 },
      children: [
        { component: 'Text', props: { text: basename(filePath), weight: 'bold' } },
        { component: 'Badge', props: { text: ext.toUpperCase() } },
      ],
    },
    { component: 'Text', props: { text: `已应用 ${opCount} 个操作并保存`, variant: 'muted' } },
    {
      component: 'Button',
      props: { label: '在查看器中打开', path: filePath },
      events: { onClick: 'open_viewer' },
    },
  ],
});

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
  if (domain !== 'pptx') {
    return text(`domain "${domain}" is not wired yet — pptx, xlsx and docx are. Do not retry with another argument; tell the user this format has no structural editing yet.`);
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
      card: docCard(path, cellOps.length, ext),
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
      card: docCard(path, ops.length, ext),
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
    card: docCard(path, result.records?.length ?? ops.length, ext),
  };
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

  /** The conversation on screen changed. The host swaps the session-scoped
   *  tabs itself; this only keeps the unscoped-tool fallback pointed right. */
  onHostEvent(event, data) {
    if (event !== 'session.changed') return;
    panelSession = (data as { sessionId?: string | null } | null)?.sessionId ?? null;
  },

  onRequest(panelId, method, params, _ctx, meta) {
    return onUiRequest(method, params, panelId, meta);
  },

  /**
   * Card buttons from the office_edit result card (messageRenderer). The path
   * comes back in the clicked node's props, so an old card still opens its
   * own document. The card was clicked from the conversation ON SCREEN, so it
   * opens into the panel's bucket. Not async: the SDK calls this fire-and-
   * forget without awaiting, so a rejection here would escape the SDK's
   * try/catch — handle errors inline instead.
   */
  onCardEvent(_toolName, eventId, kind, payload) {
    if (kind !== 'click' || eventId !== 'open_viewer') return;
    const target = String((payload as { path?: string } | undefined)?.path ?? '') || activeFileOf();
    if (!target) return;
    void openInViewer(target).catch((err: unknown) => {
      ctx.log.error(`open_viewer failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  },

  onEvent,
});

// Re-exported so tests can reach the engine without going through a tool call
// (the smoke test needs a real deck to edit, and building it with the same
// engine the backend ships keeps the two from disagreeing).
export { createBlankPptx, openPptx, savePptx, runTxn, opNames };
