/**
 * Headless PDF creation, page surgery and PDF → Office conversion, on
 * GenOffice's own PDF layer.
 *
 * GenOffice's PDF app is unusual among its apps: most of its page operations
 * are pure bytes-in/bytes-out helpers (`apps/pdf/src/main/save-pdf.ts`) over
 * pdf-lib — merge, insert, extract, split, resize, crop, N-up. Its "New PDF"
 * path is likewise a headless blank A4 (`blank-pdf.ts`). None of that needs a
 * BrowserWindow, so the plugin backend can expose it to the agent; the panel's
 * own save path already runs the same module.
 *
 * `pdf2docx` goes one step further: the PDF → DOCX/PPTX/XLSX rebuild is pure
 * and local, given an initialized pdfium wasm module. `build-backend.mjs`
 * copies that wasm next to dist/main.mjs, and `loadPdfium` initializes it the
 * same way GenOffice's own main process does.
 *
 * Everything here is lazy: a plugin that only views docx never pays for
 * pdfium or pdf-lib's heavier paths.
 */
import type { TextInsertFailure, TextInsertInput } from '../../vendor/genoffice/apps/pdf/src/shared/ipc';

/** A4 portrait in PDF points — the size GenOffice's blank PDF uses. */
const A4: [number, number] = [595.28, 841.89];
const LETTER: [number, number] = [612, 792];
const LEGAL: [number, number] = [612, 1008];
const A3: [number, number] = [841.89, 1190.55];
export const PDF_PAPER: Record<string, [number, number]> = { A4, Letter: LETTER, Legal: LEGAL, A3 };

/** One op as the agent writes it. Fields are per-op; see `pdfGuide`. */
export interface PdfOp {
  op: string;
  [key: string]: unknown;
}

export interface PdfOpRecord {
  op: string;
  detail?: string;
}

export interface PdfOpResult {
  bytes: Uint8Array;
  records: PdfOpRecord[];
  /** `split` produces several documents; every other op produces one. */
  splitParts?: Uint8Array[];
}

type SavePdf = typeof import('../../vendor/genoffice/apps/pdf/src/main/save-pdf');

let savePdfPromise: Promise<SavePdf> | null = null;
const loadSavePdf = (): Promise<SavePdf> =>
  (savePdfPromise ??= import('../../vendor/genoffice/apps/pdf/src/main/save-pdf'));

const num = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
};

const reqNum = (value: unknown, what: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`pdf_edit: ${what} must be a number`);
  return Math.floor(n);
};

const str = (value: unknown, what: string): string => {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new Error(`pdf_edit: ${what} must be a non-empty string`);
  return s;
};

/** Original (0-based) page indexes; de-duplicated, order preserved by the caller's helper. */
const pageList = (value: unknown, what: string): number[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`pdf_edit: ${what} must be a non-empty array of 0-based page indexes`);
  }
  return value.map((v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`pdf_edit: ${what} contains "${String(v)}" — page indexes are 0-based integers`);
    }
    return n;
  });
};

/** Page count without pulling the whole save-pdf module (pdf-lib is enough). */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPageCount();
}

/** Page size + displayed rotation, for default text origins. */
export async function pdfPageInfo(
  bytes: Uint8Array,
  pageIndex: number,
): Promise<{ width: number; height: number; rotation: number }> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  if (pageIndex < 0 || pageIndex >= doc.getPageCount()) {
    throw new Error(`pdf: page ${pageIndex} is out of range (${doc.getPageCount()} page(s))`);
  }
  const page = doc.getPage(pageIndex);
  const { width, height } = page.getSize();
  return { width, height, rotation: page.getRotation().angle };
}

/** One new text object on a PDF page, in GenOffice's own insert shape. */
export interface PdfTextInsert {
  pageIndex: number;
  /** First-line baseline origin in PDF user space (y from the BOTTOM). */
  origin: [number, number];
  text: string;
  fontSize: number;
  /** 0..1 RGB. */
  color: [number, number, number];
  font?: string;
  bold?: boolean;
  italic?: boolean;
  lineLeading?: number;
  lineXOffsets?: number[];
  align?: 'left' | 'center' | 'right';
  /** Final displayed page rotation; text is counter-rotated into screen space. */
  rotate?: number;
}

export interface PdfTextResult {
  bytes: Uint8Array;
  skipped: TextInsertFailure[];
}

/**
 * Insert searchable text into a PDF, on GenOffice's text-insert layer.
 *
 * That layer resolves a system font that covers the text (so CJK works),
 * subsets it with harfbuzz, and writes real text objects — the same path the
 * PDF app uses when you place text on a page. `skipped` is not a crash: the
 * layer reports a page/font it could not handle and keeps the rest.
 */
export async function insertPdfText(
  bytes: Uint8Array,
  inserts: readonly PdfTextInsert[],
): Promise<PdfTextResult> {
  const textEdit = await loadTextEdit();
  const r = await textEdit.applyTextInserts(bytes, inserts as unknown as TextInsertInput[]);
  return { bytes: r.bytes, skipped: r.skipped };
}

/** A brand-new PDF: GenOffice's blank A4, repeated to `pages` and resized if asked. */
export async function blankPdf(pages = 1, paper: keyof typeof PDF_PAPER = 'A4'): Promise<Uint8Array> {
  const count = Math.min(Math.max(Math.floor(pages), 1), 200);
  const { blankPdfBuffer } = await import('../../vendor/genoffice/apps/pdf/src/main/blank-pdf');
  let bytes: Uint8Array = new Uint8Array(await blankPdfBuffer());
  if (count > 1) {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const first = doc.getPage(0);
    const { width, height } = first.getSize();
    for (let i = 1; i < count; i++) doc.addPage([width, height]);
    bytes = new Uint8Array(await doc.save({ useObjectStreams: false }));
  }
  const target = PDF_PAPER[paper] ?? A4;
  if (target[0] !== A4[0] || target[1] !== A4[1]) {
    const savePdf = await loadSavePdf();
    bytes = await savePdf.setPageSizeBytes(bytes, target[0], target[1]);
  }
  return bytes;
}

/**
 * Apply a PDF op batch, in order. Reads referenced PDFs through `readSource`
 * so this module never touches paths itself.
 */
export async function applyPdfOps(
  source: Uint8Array,
  ops: readonly PdfOp[],
  readSource: (path: string) => Promise<Uint8Array>,
): Promise<PdfOpResult> {
  const savePdf = await loadSavePdf();
  const records: PdfOpRecord[] = [];
  let bytes = source;
  let splitParts: Uint8Array[] | undefined;

  for (const op of ops) {
    const name = String(op?.op ?? '');
    switch (name) {
      case 'insertBlankPage': {
        const after = num(op.afterPageIndex, -1);
        bytes = await savePdf.insertBlankPageBytes(bytes, after);
        records.push({ op: name, detail: `after page ${after}` });
        break;
      }
      case 'insertPdf': {
        const other = await readSource(str(op.source, 'insertPdf.source'));
        const after = num(op.afterPageIndex, -1);
        const r = await savePdf.insertPdfBytes(bytes, other, after);
        bytes = r.merged;
        records.push({ op: name, detail: `${r.count} page(s) from ${String(op.source)}` });
        break;
      }
      case 'merge': {
        if (!Array.isArray(op.sources) || op.sources.length === 0) {
          throw new Error('pdf_edit: merge.sources must be a non-empty array of PDF paths');
        }
        const others: Uint8Array[] = [];
        for (const src of op.sources) others.push(await readSource(str(src, 'merge.sources[]')));
        const r = await savePdf.mergePdfBytes(bytes, others);
        bytes = r.merged;
        records.push({ op: name, detail: `${r.appended} page(s) appended` });
        break;
      }
      case 'replacePages': {
        const other = await readSource(str(op.source, 'replacePages.source'));
        const pages = pageList(op.pages, 'replacePages.pages');
        const r = await savePdf.replacePagesBytes(bytes, other, pages);
        bytes = r.merged;
        records.push({ op: name, detail: `${r.removed} removed, ${r.inserted} inserted` });
        break;
      }
      case 'extractPages': {
        const pages = pageList(op.pages, 'extractPages.pages');
        bytes = await savePdf.extractPagesBytes(bytes, pages);
        records.push({ op: name, detail: `${pages.length} page(s)` });
        break;
      }
      case 'deletePages': {
        const pages = pageList(op.pages, 'deletePages.pages');
        const total = await pdfPageCount(bytes);
        const drop = new Set(pages);
        const keep = Array.from({ length: total }, (_, i) => i).filter((i) => !drop.has(i));
        if (keep.length === 0) throw new Error('pdf_edit: deletePages would remove every page');
        bytes = await savePdf.extractPagesBytes(bytes, keep);
        records.push({ op: name, detail: `${total - keep.length} page(s)` });
        break;
      }
      case 'setPageSize': {
        let target: [number, number] | undefined;
        if (typeof op.preset === 'string') {
          target = PDF_PAPER[op.preset];
          if (!target) {
            throw new Error(
              `pdf_edit: unknown preset "${op.preset}" — use A4, Letter, Legal or A3, or widthPt/heightPt`,
            );
          }
        } else {
          target = [reqNum(op.widthPt, 'setPageSize.widthPt'), reqNum(op.heightPt, 'setPageSize.heightPt')];
          if (target[0] <= 0 || target[1] <= 0) throw new Error('pdf_edit: page size must be positive');
        }
        bytes = await savePdf.setPageSizeBytes(bytes, target[0], target[1]);
        records.push({ op: name, detail: `${target[0]}x${target[1]}pt` });
        break;
      }
      case 'cropPages': {
        const pages = pageList(op.pages, 'cropPages.pages');
        const rect = (op.rect ?? {}) as Record<string, unknown>;
        const fractions = {
          l: Number(rect.l ?? 0),
          t: Number(rect.t ?? 0),
          r: Number(rect.r ?? 1),
          b: Number(rect.b ?? 1),
        };
        if (Object.values(fractions).some((v) => !Number.isFinite(v))) {
          throw new Error('pdf_edit: cropPages.rect needs finite l/t/r/b fractions (0..1)');
        }
        bytes = await savePdf.cropPagesBytes(bytes, pages, fractions);
        records.push({ op: name, detail: `${pages.length} page(s)` });
        break;
      }
      case 'insertText': {
        const text = str(op.text, 'insertText.text');
        const pageIndex = num(op.pageIndex, 0);
        const info = await pdfPageInfo(bytes, pageIndex);
        const fontSize = Number.isFinite(Number(op.fontSize)) ? Number(op.fontSize) : 12;
        if (fontSize <= 0) throw new Error('pdf_edit: insertText.fontSize must be positive');
        let origin: [number, number];
        if (Array.isArray(op.origin) && op.origin.length === 2) {
          origin = [Number(op.origin[0]), Number(op.origin[1])];
        } else {
          origin = [
            Number.isFinite(Number(op.x)) ? Number(op.x) : 72,
            Number.isFinite(Number(op.y)) ? Number(op.y) : info.height - 72,
          ];
        }
        if (!origin.every((v) => Number.isFinite(v))) {
          throw new Error('pdf_edit: insertText origin/x/y must be finite numbers');
        }
        const rawColor = Array.isArray(op.color) && op.color.length === 3 ? op.color : [0, 0, 0];
        const color = rawColor.map(Number) as [number, number, number];
        if (color.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) {
          throw new Error('pdf_edit: insertText.color must be three 0..1 RGB components');
        }
        const input: PdfTextInsert = {
          pageIndex,
          origin,
          text,
          fontSize,
          color,
          rotate: info.rotation,
          ...(typeof op.font === 'string' && op.font.trim() ? { font: op.font.trim() } : {}),
          ...(op.bold === true ? { bold: true } : {}),
          ...(op.italic === true ? { italic: true } : {}),
          ...(Number.isFinite(Number(op.lineLeading))
            ? { lineLeading: Number(op.lineLeading) }
            : {}),
          ...(op.align === 'center' || op.align === 'right' ? { align: op.align } : {}),
        };
        const r = await insertPdfText(bytes, [input]);
        const skipped = r.skipped[0];
        if (skipped) {
          throw new Error(`pdf_edit: insertText was skipped — ${skipped.reason}`);
        }
        bytes = r.bytes;
        records.push({
          op: name,
          detail: `${text.split('\n').length} line(s) on page ${pageIndex}`,
        });
        break;
      }
      case 'mergePages': {
        const perSheet = Math.min(Math.max(num(op.perSheet, 2), 2), 16);
        const direction = op.direction === 'vertical' ? 'vertical' : 'horizontal';
        bytes = await savePdf.mergePagesBytes(bytes, {
          perSheet,
          direction,
          separator: op.separator === true,
        });
        records.push({ op: name, detail: `${perSheet}-up, ${direction}` });
        break;
      }
      case 'splitPages': {
        const perPage = Number(op.perPage);
        if (perPage !== 2 && perPage !== 4 && perPage !== 9) {
          throw new Error('pdf_edit: splitPages.perPage must be 2, 4 or 9');
        }
        bytes = await savePdf.splitPagesBytes(bytes, perPage);
        records.push({ op: name, detail: `every page cut into ${perPage}` });
        break;
      }
      case 'split': {
        if (ops.length !== 1) {
          throw new Error('pdf_edit: split must be the only op — it produces several files, not one document');
        }
        const every = Math.max(num(op.everyPages, 1), 1);
        splitParts = await savePdf.splitPdfBytes(bytes, every);
        records.push({ op: name, detail: `${splitParts.length} file(s), every ${every} page(s)` });
        break;
      }
      default:
        throw new Error(
          `pdf_edit: unknown op "${name}" — see office_guide({ domain: "pdf" }) for the vocabulary`,
        );
    }
  }

  return { bytes, records, splitParts };
}

/** The `office_guide` text for `domain: "pdf"`. */
export function pdfGuide(): string {
  return [
    'PDF ops are pure page surgery on GenOffice\'s own pdf-lib layer. They run in the',
    'backend (no viewer needed), and write a NEW file: pass `outputPath`.',
    '',
    '  { op: "<name>", <the op\'s fields> }',
    '',
    'Page indexes are 0-based, in the ORIGINAL document. Read the page count first if',
    'you are unsure (the result of every call includes `pages`).',
    '',
    'Ops:',
    '  insertBlankPage  { afterPageIndex? }                     insert one blank page (-1 = front)',
    '  insertPdf        { source, afterPageIndex? }             insert all pages of another PDF',
    '  merge            { sources: [path, ...] }                append PDFs in order',
    '  replacePages     { source, pages: [i, ...] }             replace pages with another PDF',
    '  extractPages     { pages: [i, ...] }                     keep only these pages',
    '  deletePages      { pages: [i, ...] }                     drop these pages',
    '  setPageSize      { preset: "A4"|"Letter"|"Legal"|"A3" } or { widthPt, heightPt }',
    '  cropPages        { pages: [i, ...], rect: { l, t, r, b } }   fractions of the displayed page (0..1)',
    '  insertText       { text, pageIndex?, x?, y?, fontSize?, color?, font?, bold?, italic?, align? }',
    '                   new searchable text; x/y are PDF user space (y from the BOTTOM).',
    '                   Omit x/y for a 1-inch top-left margin. \\n stacks lines. The layer',
    '                   picks a system font covering the text (CJK included) and subsets it.',
    '  mergePages       { perSheet: 2..16, direction?: "horizontal"|"vertical", separator?: bool }',
    '  splitPages       { perPage: 2|4|9 }                      cut every page into a grid',
    '  split            { everyPages }                          several files; must be the only op',
    '',
    '`split` writes <outputPath>/<source>-1.pdf, -2, ... — outputPath is a DIRECTORY.',
    'Every other op writes one PDF to outputPath; an existing target is refused unless',
    'overwrite is true. `outputPath` equal to `path` is an in-place edit (pass overwrite).',
    '',
    'PDF → Office conversion is a separate tool: `pdf_convert({ path, to })`.',
  ].join('\n');
}

/**
 * GenOffice's PDF main-process layer, shared with text insertion.
 *
 * `text-edit.ts` owns the pdfium loader (and the font/harfbuzz machinery), so
 * every PDF feature here — render, convert, insert text — uses the SAME wasm
 * instance instead of paying for a second one. The wasm paths are swapped at
 * build time to the plugin's dist folder (see pdf-wasm-path.ts).
 */
type TextEdit = typeof import('../../vendor/genoffice/apps/pdf/src/main/text-edit');
let textEditPromise: Promise<TextEdit> | null = null;
const loadTextEdit = (): Promise<TextEdit> =>
  (textEditPromise ??= import('../../vendor/genoffice/apps/pdf/src/main/text-edit'));

async function loadPdfium(): Promise<unknown> {
  return (await loadTextEdit()).loadPdfium();
}

export interface PdfConversionResult {
  bytes: Uint8Array;
  pages: number;
  warnings: string[];
  scannedDocument: boolean;
}

export interface RenderedPage {
  /** 0-based source page index */
  index: number;
  data: Uint8Array;
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * PDF pages → PNG, on GenOffice's pdfium page renderer and its dependency-free
 * PNG encoder (pdf2docx/extract). No Electron, no canvas, no nativeImage.
 *
 * `pages: null` renders every page. `scale` is pixels per PDF point (2 ≈ the
 * app's 144-dpi page exports).
 */
export async function renderPdfPages(
  bytes: Uint8Array,
  pages: readonly number[] | null,
  scale: number,
  password?: string,
): Promise<RenderedPage[]> {
  const pdfium = (await loadPdfium()) as import('@genoffice/pdf2docx').PdfiumModule;
  const { extract } = await import('@genoffice/pdf2docx');
  return extract.withPdfDocument(
    pdfium,
    bytes,
    (doc) => {
      const total = pdfium._FPDF_GetPageCount(doc);
      const indexes = pages ?? Array.from({ length: total }, (_, i) => i);
      const out: RenderedPage[] = [];
      for (const index of indexes) {
        if (index < 0 || index >= total) {
          throw new Error(`pdf_render: page ${index} is out of range (${total} page(s))`);
        }
        const rendered = extract.renderPageByIndexPng(pdfium, doc, index, scale);
        if (!rendered) throw new Error(`pdf_render: page ${index + 1} could not be rendered`);
        out.push({
          index,
          data: rendered.data,
          pixelWidth: rendered.pixelWidth,
          pixelHeight: rendered.pixelHeight,
        });
      }
      return out;
    },
    password,
  );
}

/**
 * PDF → Office, on GenOffice's pure-local rebuild.
 *
 * DOCX keeps flowing text; PPTX places every block at its measured position;
 * XLSX emits cell data instead of a page facsimile. Scanned pages have no text
 * layer and come through as full-page images (the result says so).
 */
export async function convertPdfToOffice(
  bytes: Uint8Array,
  to: 'docx' | 'pptx' | 'xlsx',
  password?: string,
): Promise<PdfConversionResult> {
  const pdfium = await loadPdfium();
  const pdf2docx = await import('@genoffice/pdf2docx');
  const opts = { pdfium: pdfium as never, ...(password ? { password } : {}) };
  if (to === 'docx') {
    const r = await pdf2docx.convertPdfToDocx(bytes, opts);
    return { bytes: r.docx, pages: r.pages, warnings: r.warnings, scannedDocument: r.scannedDocument };
  }
  if (to === 'pptx') {
    const r = await pdf2docx.convertPdfToPptx(bytes, opts);
    return { bytes: r.pptx, pages: r.pages, warnings: r.warnings, scannedDocument: r.scannedDocument };
  }
  const r = await pdf2docx.convertPdfToXlsx(bytes, opts);
  return { bytes: r.xlsx, pages: r.pages, warnings: r.warnings, scannedDocument: r.scannedDocument };
}
