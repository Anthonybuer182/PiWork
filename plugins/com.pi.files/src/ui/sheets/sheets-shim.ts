/**
 * `window.desktopApi` — the preload API GenOffice's sheets renderer is written against.
 *
 * ## Why this one is different from the other three
 *
 * GenOffice's spreadsheet reads go through a **Rust sidecar** (`xlsx-sidecar`,
 * built from apps/sheets/native/xlsx-engine). The whole read model is built on
 * its session concept: `selectWorkbook()` opens through it and hands back a
 * `WorkbookFile` carrying a `sessionId`, and every later read is
 * `readWorkbookRange({ sessionId, sheetId, range })` answered by that process.
 *
 * The plugin cannot spawn it — there is no cargo toolchain here and shipping a
 * prebuilt binary would mean shipping something we cannot rebuild, which is the
 * situation officecli was just removed for. So this file implements the SAME
 * PROTOCOL over SheetJS, in the renderer:
 *
 *   selectWorkbook()      → parse with SheetJS, mint a sessionId
 *   readWorkbookRange()   → slice the parsed grid
 *
 * ## What that costs, stated plainly
 *
 * The renderer gets cell values, formulas and sheet dimensions, plus — through
 * `xlsx-style.ts` — what the layout actually looks like: column widths, row
 * heights, fonts, fills, borders and number formats, with per-cell style
 * indices from the worksheet XML. Without that second pass every sheet renders
 * as Excel's default grid and looks nothing like the file.
 *
 * Still missing: charts, images, pivot tables, conditional formatting and data
 * validation — those live in `visuals`/`dxfStyles`, which this returns empty.
 * And formulas are not recalculated: the value shown is the one cached in the
 * file, which is what Excel itself displays until a formula changes.
 *
 * `xlsx-gateway` (pure TS, already vendored) is the eventual answer for the
 * write path; it is a patcher, not a reader, so it does not help here.
 */

import * as XLSX from 'xlsx';
import type { WorkbookCellStyle } from '../../../vendor/genoffice/apps/sheets/src/shared/desktop-api';
import {
  baseName,
  backend,
  commonApi,
  installThemeBridge,
  readDocument,
  readPersistedPath,
  reloadForOtherFormat,
} from '../shims/common';
import { sheetsApiStubs } from './stubs';
import { parseSheetStyles, type SheetLayout } from './xlsx-style';

/** Extensions the sheets renderer is loaded for. No `ods` — see the note in
 *  src/ui/panel/main.ts; the engine speaks OOXML, not OpenDocument. */
const SHEET_EXTS = ['xlsx', 'xls', 'xlsm', 'csv'];

interface CellScalar {
  value: string | number | boolean | null;
  formula?: string;
  /** Index into `Session.styles`; absent for the default style. */
  styleIndex?: number;
}

interface SheetModel {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  /** Sparse: `${row}:${col}` → cell. */
  cells: Map<string, CellScalar>;
  merges: Array<{ startRow: number; startColumn: number; endRow: number; endColumn: number }>;
  layout: SheetLayout;
}

interface Session {
  id: string;
  path: string;
  name: string;
  sheets: SheetModel[];
  styles: WorkbookCellStyle[];
}

const EMPTY_LAYOUT: SheetLayout = {
  columnWidths: [],
  rowHeights: new Map(),
  defaultRowHeight: null,
  defaultRowHeightFixed: false,
  defaultColumnWidth: null,
  baseColumnWidth: null,
};

let session: Session | null = null;
let pendingPath: string | null = null;
let appBooted = false;
let currentPath: string | null = null;

installThemeBridge();

// ── parsing ─────────────────────────────────────────────────────────────
function extensionOf(path: string): string {
  return path.toLowerCase().split('.').pop() ?? '';
}

/**
 * Layout from SheetJS itself, for formats the OOXML reader does not cover
 * (`xls`, `csv`) or when styles.xml could not be read. SheetJS still exposes
 * `!cols`/`!rows`, so the preview keeps its column widths and row heights.
 */
function sheetJsLayout(ws: XLSX.WorkSheet | undefined): SheetLayout {
  const columnWidths: SheetLayout['columnWidths'] = [];
  ((ws?.['!cols'] as XLSX.ColInfo[] | undefined) ?? []).forEach((col, index) => {
    if (!col) return;
    const width = col.width ?? col.wch;
    if (width === undefined && !col.hidden) return;
    columnWidths.push({
      startColumn: index,
      endColumn: index,
      ...(width !== undefined ? { width } : {}),
      hidden: Boolean(col.hidden),
    });
  });

  const rowHeights: SheetLayout['rowHeights'] = new Map();
  ((ws?.['!rows'] as XLSX.RowInfo[] | undefined) ?? []).forEach((row, index) => {
    if (!row) return;
    const height = row.hpt ?? (row.hpx !== undefined ? (row.hpx * 72) / 96 : undefined);
    if (height === undefined && !row.hidden) return;
    rowHeights.set(index, {
      ...(height !== undefined ? { height, customHeight: true } : {}),
      hidden: Boolean(row.hidden),
    });
  });

  return { ...EMPTY_LAYOUT, columnWidths, rowHeights };
}

function buildSession(path: string, data: ArrayBuffer, sha: string): Session {
  // `cellDates: false` keeps dates as their serial numbers — the same thing the
  // file stores, and the renderer applies the number format. Converting here
  // would bake in a timezone the workbook never had. `cellNF`/`cellStyles` are
  // on so number formats and fills come through even for formats the OOXML
  // reader below does not handle.
  const wb = XLSX.read(data, {
    type: 'array',
    cellFormula: true,
    cellDates: false,
    cellNF: true,
    cellStyles: true,
  });

  // Fonts, fills, borders, number formats and per-cell style ids only exist in
  // the OOXML package — an .xls or .csv has no styles.xml.
  const ext = extensionOf(path);
  const styled = ext === 'xlsx' || ext === 'xlsm' ? parseSheetStyles(data) : null;

  const sheets: SheetModel[] = wb.SheetNames.map((name, i) => {
    const ws = wb.Sheets[name];
    const ref = ws?.['!ref'];
    const range = ref ? XLSX.utils.decode_range(ref) : null;
    const styleMap = styled?.cellStyles.get(name);
    const cells = new Map<string, CellScalar>();
    for (const [addr, cell] of Object.entries(ws ?? {})) {
      if (addr.startsWith('!')) continue;
      const c = cell as XLSX.CellObject;
      if (c.t === undefined && c.v === undefined) continue;
      const pos = XLSX.utils.decode_cell(addr);
      const value =
        c.v === undefined || c.v === null ? null : (c.v as string | number | boolean);
      const styleIndex = styleMap?.get(`${pos.r}:${pos.c}`);
      cells.set(`${pos.r}:${pos.c}`, {
        value,
        ...(typeof c.f === 'string' && c.f ? { formula: `=${c.f}` } : {}),
        ...(styleIndex !== undefined ? { styleIndex } : {}),
      });
    }
    const merges = ((ws?.['!merges'] as XLSX.Range[] | undefined) ?? []).map((m) => ({
      startRow: m.s.r,
      startColumn: m.s.c,
      endRow: m.e.r,
      endColumn: m.e.c,
    }));
    return {
      id: `sheet-${i}`,
      name,
      // A sheet with nothing in it still needs positive counts: the declared
      // schema requires them, and a zero would divide the renderer's viewport
      // maths by zero.
      rowCount: Math.max(1, (range?.e.r ?? 0) + 1),
      columnCount: Math.max(1, (range?.e.c ?? 0) + 1),
      cells,
      merges,
      layout: styled?.layouts.get(name) ?? sheetJsLayout(ws),
    };
  });

  if (sheets.length === 0) {
    sheets.push({
      id: 'sheet-0',
      name: 'Sheet1',
      rowCount: 1,
      columnCount: 1,
      cells: new Map(),
      merges: [],
      layout: EMPTY_LAYOUT,
    });
  }

  return {
    id: crypto.randomUUID(),
    path,
    name: baseName(path),
    sheets,
    styles: styled?.styles ?? [],
  };
}

function workbookFile(s: Session, sha: string, bytes: number) {
  return {
    sessionId: s.id,
    name: s.name,
    path: s.path,
    fileBytes: bytes,
    entryCount: s.sheets.length,
    // Column widths and row heights come from the worksheet XML (or SheetJS's
    // `!cols`/`!rows` for formats without a styles.xml). Empty arrays here mean
    // "the file declares none", not "we could not read them".
    //
    // Every field the worksheet metadata declares gets a value: the renderer
    // reads some of them directly (`sheetMeta.pivotTables.length`), so an
    // omitted array is an instant "not iterable" rather than a graceful
    // degradation. Empty is the honest value — we know of no pivots,
    // sparklines, tables or print areas.
    sheets: s.sheets.map((sh) => ({
      id: sh.id,
      name: sh.name,
      rowCount: sh.rowCount,
      columnCount: sh.columnCount,
      columnWidths: sh.layout.columnWidths,
      defaultRowHeight: sh.layout.defaultRowHeight ?? 15,
      defaultRowHeightFixed: sh.layout.defaultRowHeightFixed,
      defaultColumnWidth: sh.layout.defaultColumnWidth ?? 8.43,
      baseColumnWidth: sh.layout.baseColumnWidth ?? 8,
      // No pane split: `<pane>` is not read yet, and `{row, column}` was not
      // the shape the renderer expects (`frozenRows`/`frozenColumns`).
      freeze: null,
      hidden: false,
      tabColor: null,
      showGridLines: true,
      showFormulas: false,
      showRowColHeaders: true,
      rightToLeft: false,
      zoomScale: 100,
      tables: [],
      comments: [],
      pivotRanges: [],
      pivotTables: [],
      sparklines: [],
      hasScopedDefinedNames: false,
      cellImages: [],
    })),
    activeTab: 0,
    styles: s.styles,
    dxfStyles: [],
    visuals: [],
    definedNames: [],
    readOnly: false,
    ...(sha ? { sha256: sha } : {}),
  };
}

// ── pending file ────────────────────────────────────────────────────────
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
  if (reloadForOtherFormat(path, SHEET_EXTS) === 'reloading') return;
  currentPath = path;
  // The renderer has no mount-time hook for a newly-arrived file, so the next
  // `hasQueuedWorkbook` poll picks it up.
  pendingPath = path;
});

function takePendingPath(): string | null {
  // Mirrors the other three shims: until the renderer has taken its initial
  // file, a `ui.render` that arrives is only queued. Without this the flag
  // stayed false forever, so the render loop below always took the queue-and-
  // return branch and a panel showing a sheet never switched to another file.
  appBooted = true;
  const p = pendingPath ?? (readPersistedPath() || null);
  pendingPath = null;
  if (p) currentPath = p;
  return p;
}

const api: Record<string, unknown> = {
  ...sheetsApiStubs,
  ...commonApi(),

  /** The renderer polls this on mount; a queued path is how a file arrives. */
  hasQueuedWorkbook: async () => !!(pendingPath || readPersistedPath()),

  /*
   * Reported as CONFIGURED, and that is the whole point — not a claim that this
   * plugin has a model.
   *
   * `handleSend` (vendored) picks between two ways of answering locally:
   *
   *     if (agentConfigured) { runAgent(...); return }
   *     const outcome = runDeterministicPlan(instruction)   // local regex DSL
   *
   * and `isAgentConfigured()` is `providers[provider]?.model && apiKey`. Answer
   * `null` — which is what a plugin with no provider "should" say — and every
   * submission takes the second branch, where `runDeterministicPlan` matches
   * only a fixed English micro-DSL ("set A1 to 42"). Anything else comes back as
   * `UnsupportedPromptError` written straight into the status bar
   * (`onError: (error) => setMessage(error)`), telling the user to rephrase in a
   * DSL this product does not have. And an instruction that DOES match would be
   * applied to the workbook locally — a second writer, racing the host agent
   * that the same submission was forwarded to.
   *
   * Claiming a provider sends it down the `runAgent` branch instead. That is
   * safe here because the loop it drives is built on the inert transport
   * (shims/ai-transport.ts): it reports a run, the transport refuses, and
   * `onError` clears `aiBusy` and puts the transport's own sentence in the
   * status bar. Nothing else reads these settings in a way that matters —
   * `imageGenerationAvailable` is this plugin's own stub and returns false
   * regardless.
   *
   * The values are deliberately not a real provider id, so nothing can mistake
   * them for one.
   */
  getAiSettings: async () => ({
    provider: 'host',
    providers: { host: { apiKey: 'host', model: 'host-agent' } },
  }),

  /** GenOffice opens through a dialog; here the host already chose the file. */
  selectWorkbook: async () => {
    const path = takePendingPath();
    if (!path) return null;
    const doc = await readDocument(path);
    session = buildSession(path, doc.data, doc.hash);
    return workbookFile(session, doc.hash, doc.data.byteLength);
  },

  readWorkbookRange: async (request: Record<string, unknown>) => {
    const sessionId = String(request?.sessionId ?? '');
    const sheetId = String(request?.sheetId ?? '');
    const range = (request?.range ?? {}) as {
      startRow?: number;
      endRow?: number;
      startColumn?: number;
      endColumn?: number;
    };
    if (!session || session.id !== sessionId) throw new Error('workbook session not found');
    const sheet = session.sheets.find((s) => s.id === sheetId);
    if (!sheet) throw new Error(`unknown sheet: ${sheetId}`);

    const startRow = Math.max(0, Number(range.startRow ?? 0));
    const endRow = Math.min(sheet.rowCount - 1, Number(range.endRow ?? 0));
    const startColumn = Math.max(0, Number(range.startColumn ?? 0));
    const endColumn = Math.min(sheet.columnCount - 1, Number(range.endColumn ?? 0));

    const cells: Array<Record<string, unknown>> = [];
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startColumn; c <= endColumn; c++) {
        const cell = sheet.cells.get(`${r}:${c}`);
        if (!cell) continue;
        cells.push({
          row: r,
          column: c,
          value: cell.value,
          ...(cell.formula ? { formula: cell.formula } : {}),
          ...(cell.styleIndex !== undefined ? { styleIndex: cell.styleIndex } : {}),
        });
      }
    }

    // Only rows that deviate from the sheet default: the renderer keeps its
    // own default height for the rest.
    const rows: Array<Record<string, unknown>> = [];
    for (let r = startRow; r <= endRow; r++) {
      const meta = sheet.layout.rowHeights.get(r);
      if (!meta) continue;
      rows.push({
        row: r,
        hidden: meta.hidden,
        ...(meta.height !== undefined ? { height: meta.height } : {}),
        ...(meta.customHeight ? { customHeight: true } : {}),
      });
    }

    // Every field the range schema declares. The names matter — the renderer
    // reads `conditionalRules` and `autoFilter`, not `conditionalFormats` and
    // `filters`, and an absent array is a "reading 'length' of undefined"
    // rather than an empty one.
    return {
      cells,
      rows,
      merges: sheet.merges.filter(
        (m) => m.startRow <= endRow && m.endRow >= startRow && m.startColumn <= endColumn && m.endColumn >= startColumn,
      ),
      hyperlinks: [],
      // Everything below needs the sidecar's parse; empty means "none", which
      // is what the renderer already handles for a workbook without them.
      conditionalRules: [],
      autoFilter: null,
      autoFilterColumns: [],
      dataValidations: [],
      sheetProtection: null,
      rowBreaks: [],
      colBreaks: [],
      pageSetup: undefined,
      protectedRanges: [],
      // The sidecar streams rows in; we have the whole sheet in memory, so the
      // requested range is indexed the moment it is asked for.
      indexedThroughRow: endRow,
      indexingComplete: true,
    };
  },

  readWorkbookFormulas: async () => ({ cells: [] }),
  readWorkbookMedia: async () => null,
  readPivotDefinition: async () => null,

  // ── save: needs the write path ported, reported honestly until then ──
  saveWorkbookEdits: async () => ({ ok: false, error: '保存尚未接入（xlsx 写路径待移植 xlsx-gateway）' }),
  beginSaveEditsTransfer: async () => ({ ok: false }),
  sendSaveEditsChunk: async () => ({ ok: false }),
  abortSaveEditsTransfer: async () => ({ ok: true }),
  writeWorkbookRecovery: async () => ({ ok: false }),
  closeWorkbook: async () => {
    session = null;
    return { ok: true };
  },

  // ── export / print: the host owns dialogs ───────────────────────────
  exportPdf: async () => ({ ok: false, error: 'PDF 导出尚未接入宿主' }),
  exportCsv: async () => ({ ok: false, error: 'CSV 导出尚未接入宿主' }),
  printWorkbook: async () => ({ ok: false, error: '打印尚未接入宿主' }),
  confirmCsvSave: async () => false,
  captureScreenSources: async () => [],
  captureScreenSource: async () => null,
  pickAttachments: async () => null,
  addAttachmentPaths: async () => ({ ok: false }),
  addPastedImage: async () => ({ ok: false }),
  readAttachment: async () => ({ ok: false }),
  readAttachmentImage: async () => ({ ok: false }),
  getPathForFile: () => '',
  openExternal: async () => undefined,
  autoRenameWorkbook: async (path: string) => ({ renamed: false, path }),
  onRecoveryPrompt: () => () => undefined,
  replyRecoveryPrompt: () => undefined,
  onCloseSaveRequest: () => () => undefined,
  reportCloseSaveResult: () => undefined,
  notifyPendingEdits: () => undefined,
  onWorkbookRenamed: () => () => undefined,
  onMenuAction: () => () => undefined,
  onMcpCommand: () => () => undefined,
  reportMcpResult: () => undefined,
  signalMcpReady: () => undefined,
  consumeHeadlessExport: async () => null,
  headlessExportDone: () => undefined,
};

// Assigned through a cast rather than a `declare global` of our own, matching
// the other shims: the app declares its own `window.desktopApi`, and a second
// declaration that disagrees on the modifier or the type is a hard error
// (TS2687 / TS2717).
(window as unknown as { desktopApi: Record<string, unknown> }).desktopApi = api;
void backend;
