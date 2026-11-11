/**
 * OOXML style / layout reader for the spreadsheet panel.
 *
 * SheetJS parses values and formulas well, but its community build does not
 * expose the workbook's fonts, borders or number formats — the filled preview
 * then looks nothing like the file in Excel/GenOffice (default narrow columns,
 * 15pt rows, no fills, no fonts). GenOffice's real reader is the Rust sidecar;
 * this module is the pure-TS stand-in that reads just the parts the renderer
 * can display:
 *
 *   xl/styles.xml            numFmts / fonts / fills / borders / cellXfs
 *   xl/worksheets/sheetN.xml cell `s=` indices, <cols>, <row ht=>, sheetFormatPr
 *   xl/theme/theme1.xml      theme palette used by theme+ tint colours
 *
 * Everything is best-effort: any failure returns null and the caller falls back
 * to value-only data, never to a broken preview.
 *
 * Charts, images, pivots, conditional formatting and data validation remain
 * unavailable — those live in other parts and in `visuals`/`dxfStyles`.
 */
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import type { WorkbookCellStyle } from '../../../vendor/genoffice/apps/sheets/src/shared/desktop-api';

/** One `<col>` span, in Excel character units (same unit as the sidecar). */
export interface ColumnWidth {
  startColumn: number;
  endColumn: number;
  width?: number;
  hidden: boolean;
}

export interface RowMeta {
  height?: number;
  hidden: boolean;
  customHeight?: boolean;
}

export interface SheetLayout {
  columnWidths: ColumnWidth[];
  /** row (0-based) → height in points */
  rowHeights: Map<number, RowMeta>;
  defaultRowHeight: number | null;
  defaultRowHeightFixed: boolean;
  defaultColumnWidth: number | null;
  baseColumnWidth: number | null;
}

export interface ParsedSheetStyles {
  styles: WorkbookCellStyle[];
  /** sheet name → `${row}:${col}` → cellXfs index */
  cellStyles: Map<string, Map<string, number>>;
  /** sheet name → layout */
  layouts: Map<string, SheetLayout>;
}

/** Skip the XML pass entirely on very large files: the preview must stay usable. */
const MAX_BYTES = 60 * 1024 * 1024;
const MAX_SHEET_XML = 40 * 1024 * 1024;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
  // Every repeated element must come back as an array — the whole point here is
  // iterating them without single-element hair-splitting.
  isArray: (name) =>
    [
      'font',
      'fill',
      'border',
      'numFmt',
      'xf',
      'col',
      'row',
      'sheet',
      'Relationship',
      'c',
      'si',
    ].includes(name),
});

// ── Excel's built-in number formats 0–49 ────────────────────────────────
const BUILTIN_NUMFMT: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'mm-dd-yy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
};

// ── helpers ─────────────────────────────────────────────────────────────
function attr(node: unknown, name: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const v = (node as Record<string, unknown>)[`@_${name}`];
  return v === undefined || v === null ? undefined : String(v);
}

function num(node: unknown, name: string): number | undefined {
  const raw = attr(node, name);
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** OOXML booleans: `<b/>` means true, `<b val="0"/>` means false. */
function flag(node: unknown): boolean {
  if (node === undefined || node === null || node === false) return false;
  return attr(node, 'val') !== '0' && attr(node, 'val') !== 'false';
}

function normalizeHex(rgb: string): string | null {
  const hex = rgb.trim().replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{8}$/.test(hex)) return `#${hex.slice(2)}`; // AARRGGBB
  if (/^[0-9A-F]{6}$/.test(hex)) return `#${hex}`;
  return null;
}

/** Excel tint: positive lightens toward white, negative darkens toward black. */
function applyTint(hex: string, tint: number): string {
  const value = parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) =>
    Math.round(tint < 0 ? c * (1 + tint) : c + (255 - c) * tint),
  );
  return `#${channels.map((c) => Math.min(255, Math.max(0, c)).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** Theme palette in the order `theme=` attributes use. */
function readThemePalette(themeXml: unknown): string[] {
  const scheme = (themeXml as Record<string, unknown> | undefined)?.['a:theme'] as
    Record<string, unknown> | undefined;
  const clr = scheme?.['a:themeElements']?.['a:clrScheme'] as Record<string, unknown> | undefined;
  const pick = (key: string): string => {
    const entry = clr?.[key] as Record<string, unknown> | undefined;
    const srgb = attr(entry?.['a:srgbClr'], 'val');
    const sys = attr(entry?.['a:sysClr'], 'lastClr');
    return normalizeHex(srgb ?? sys ?? '000000') ?? '#000000';
  };
  return [
    pick('a:lt1'),
    pick('a:dk1'),
    pick('a:lt2'),
    pick('a:dk2'),
    pick('a:accent1'),
    pick('a:accent2'),
    pick('a:accent3'),
    pick('a:accent4'),
    pick('a:accent5'),
    pick('a:accent6'),
    pick('a:hlink'),
    pick('a:folHlink'),
  ];
}

/** `<color rgb="FF..." theme="4" tint="-0.25"/>` → '#RRGGBB'. */
function resolveColor(node: unknown, palette: string[]): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const rgb = attr(node, 'rgb');
  if (rgb) {
    const hex = normalizeHex(rgb);
    if (hex) return hex;
  }
  const theme = num(node, 'theme');
  if (theme !== undefined && palette[theme]) {
    return applyTint(palette[theme], num(node, 'tint') ?? 0);
  }
  // indexed colours are almost always the auto/default entries; leaving them
  // unset is what Excel's "automatic" means.
  return undefined;
}

function numberFormat(
  xf: Record<string, unknown>,
  custom: Map<number, string>,
): string | undefined {
  const id = num(xf, 'numFmtId');
  if (id === undefined || id === 0) return undefined;
  const code = custom.get(id) ?? BUILTIN_NUMFMT[id];
  if (!code || code === 'General') return undefined;
  return code;
}

function borderEdge(
  node: unknown,
  palette: string[],
): { style: string; color?: string } | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const style = attr(node, 'style');
  if (!style) return undefined;
  const color = resolveColor((node as Record<string, unknown>).color, palette);
  return color ? { style, color } : { style };
}

// ── styles.xml ──────────────────────────────────────────────────────────
function buildStyles(stylesXml: unknown, palette: string[]): WorkbookCellStyle[] {
  const root = (stylesXml as Record<string, unknown> | undefined)?.['styleSheet'] as
    Record<string, unknown> | undefined;
  if (!root) return [];

  const customFormats = new Map<number, string>();
  for (const entry of ((root.numFmts as Record<string, unknown> | undefined)?.numFmt as
    Array<Record<string, unknown>> | undefined) ?? []) {
    const id = num(entry, 'numFmtId');
    const code = attr(entry, 'formatCode');
    if (id !== undefined && code) customFormats.set(id, code);
  }

  const fonts =
    ((root.fonts as Record<string, unknown> | undefined)?.font as
      Array<Record<string, unknown>> | undefined) ?? [];
  const fills =
    ((root.fills as Record<string, unknown> | undefined)?.fill as
      Array<Record<string, unknown>> | undefined) ?? [];
  const borders =
    ((root.borders as Record<string, unknown> | undefined)?.border as
      Array<Record<string, unknown>> | undefined) ?? [];
  const xfs =
    ((root.cellXfs as Record<string, unknown> | undefined)?.xf as
      Array<Record<string, unknown>> | undefined) ?? [];

  return xfs.map((xf) => {
    const font = fonts[num(xf, 'fontId') ?? 0] ?? {};
    const fill = fills[num(xf, 'fillId') ?? 0] ?? {};
    const border = borders[num(xf, 'borderId') ?? 0] ?? {};
    const pattern = attr(fill.patternFill as Record<string, unknown>, 'patternType');
    const fgColor = resolveColor((fill.patternFill as Record<string, unknown>)?.fgColor, palette);
    const alignment = xf.alignment as Record<string, unknown> | undefined;
    const vertical = attr(alignment, 'vertical');
    const rotation = num(alignment, 'textRotation');
    const indent = num(alignment, 'indent');

    const style: WorkbookCellStyle = {
      bold: flag(font.b),
      italic: flag(font.i),
      underline: flag(font.u),
      strikethrough: flag(font.strike),
      wrapText: attr(alignment, 'wrapText') === '1' || attr(alignment, 'wrapText') === 'true',
      diagonalUp: attr(border, 'diagonalUp') === '1',
      diagonalDown: attr(border, 'diagonalDown') === '1',
    };

    const fontFamily = attr(font.name, 'val');
    if (fontFamily) style.fontFamily = fontFamily;
    const fontSize = num(font.sz, 'val');
    if (fontSize && fontSize > 0) style.fontSize = fontSize;
    const fontColor = resolveColor(font.color, palette);
    if (fontColor) style.fontColor = fontColor;
    // Fill: only pattern fills carry a colour; `none` is the default.
    if (pattern && pattern !== 'none' && fgColor) style.fillColor = fgColor;

    const fmt = numberFormat(xf, customFormats);
    if (fmt) style.numberFormat = fmt;

    const horizontal = attr(alignment, 'horizontal');
    if (horizontal) style.horizontalAlignment = horizontal;
    if (vertical) style.verticalAlignment = vertical;
    if (indent !== undefined && indent > 0) style.indent = indent;
    if (rotation !== undefined && rotation > 0 && rotation <= 255) style.textRotation = rotation;

    const verticalAlign = attr(font.vertAlign, 'val');
    if (verticalAlign === 'superscript' || verticalAlign === 'subscript') {
      style.vertAlign = verticalAlign;
    }

    const edges = {
      borderTop: borderEdge(border.top, palette),
      borderBottom: borderEdge(border.bottom, palette),
      borderLeft: borderEdge(border.left, palette),
      borderRight: borderEdge(border.right, palette),
      borderDiagonal: borderEdge(border.diagonal, palette),
    };
    for (const [key, edge] of Object.entries(edges)) {
      if (edge) (style as unknown as Record<string, unknown>)[key] = edge;
    }

    return style;
  });
}

// ── workbook.xml + rels ─────────────────────────────────────────────────
function sheetTargets(files: Record<string, Uint8Array>): Map<string, string> {
  const result = new Map<string, string>();
  const workbookRaw = files['xl/workbook.xml'];
  const relsRaw = files['xl/_rels/workbook.xml.rels'];
  if (!workbookRaw || !relsRaw) return result;

  const workbook = parser.parse(strFromU8(workbookRaw)) as Record<string, unknown>;
  const rels = parser.parse(strFromU8(relsRaw)) as Record<string, unknown>;
  const relById = new Map<string, string>();
  for (const rel of ((rels.Relationships as Record<string, unknown> | undefined)?.Relationship as
    Array<Record<string, unknown>> | undefined) ?? []) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (!id || !target) continue;
    const clean = target.replace(/^\/?xl\//, '').replace(/^\.\//, '');
    relById.set(id, `xl/${clean}`);
  }

  for (const sheet of ((
    (workbook.workbook as Record<string, unknown> | undefined)?.sheets as
      Record<string, unknown> | undefined
  )?.sheet as Array<Record<string, unknown>> | undefined) ?? []) {
    const name = attr(sheet, 'name');
    const rid = attr(sheet, 'r:id');
    if (!name || !rid) continue;
    const target = relById.get(rid);
    if (target) result.set(name, target);
  }
  return result;
}

// ── worksheet.xml ───────────────────────────────────────────────────────
function readSheet(
  xml: string,
  palette: string[],
): { cellStyles: Map<string, number>; layout: SheetLayout } {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const worksheet = doc.worksheet as Record<string, unknown> | undefined;

  const cellStyles = new Map<string, number>();
  const rows =
    ((worksheet?.sheetData as Record<string, unknown> | undefined)?.row as
      Array<Record<string, unknown>> | undefined) ?? [];
  const rowHeights = new Map<number, RowMeta>();
  for (const row of rows) {
    const rowIndex = num(row, 'r');
    if (rowIndex === undefined) continue;
    const height = num(row, 'ht');
    const hidden = attr(row, 'hidden') === '1';
    if (height !== undefined || hidden) {
      rowHeights.set(rowIndex - 1, {
        ...(height !== undefined ? { height } : {}),
        hidden,
        ...(attr(row, 'customHeight') === '1' ? { customHeight: true } : {}),
      });
    }
    for (const cell of (row.c as Array<Record<string, unknown>> | undefined) ?? []) {
      const ref = attr(cell, 'r');
      const style = num(cell, 's');
      if (!ref || style === undefined) continue;
      const pos = refToPos(ref);
      if (pos) cellStyles.set(`${pos.row}:${pos.column}`, style);
    }
  }

  const columnWidths: ColumnWidth[] = [];
  for (const col of ((worksheet?.cols as Record<string, unknown> | undefined)?.col as
    Array<Record<string, unknown>> | undefined) ?? []) {
    const min = num(col, 'min');
    const max = num(col, 'max');
    if (min === undefined || max === undefined) continue;
    const width = num(col, 'width');
    columnWidths.push({
      startColumn: min - 1,
      endColumn: max - 1,
      ...(width !== undefined ? { width } : {}),
      hidden: attr(col, 'hidden') === '1',
    });
  }

  const format = worksheet?.sheetFormatPr as Record<string, unknown> | undefined;
  return {
    cellStyles,
    layout: {
      columnWidths,
      rowHeights,
      defaultRowHeight: num(format, 'defaultRowHeight') ?? null,
      defaultRowHeightFixed: attr(format, 'customHeight') === '1',
      defaultColumnWidth: num(format, 'defaultColWidth') ?? null,
      baseColumnWidth: num(format, 'baseColWidth') ?? null,
    },
  };
}

/** "A1" → {row:0,column:0}; "AA10" → {row:9,column:26}. */
function refToPos(ref: string): { row: number; column: number } | null {
  const match = /^([A-Z]+)(\d+)$/i.exec(ref.replace(/\$/g, ''));
  if (!match) return null;
  let column = 0;
  for (const ch of match[1].toUpperCase()) column = column * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(match[2]) - 1, column: column - 1 };
}

// ── entry point ─────────────────────────────────────────────────────────
export function parseSheetStyles(data: ArrayBuffer): ParsedSheetStyles | null {
  if (data.byteLength > MAX_BYTES) return null;
  try {
    const files = unzipSync(new Uint8Array(data), {
      // Only the metadata parts are needed; skipping the media keeps large
      // workbooks from being inflated just to read fonts.
      filter: (file) =>
        file.name === 'xl/styles.xml' ||
        file.name === 'xl/workbook.xml' ||
        file.name === 'xl/_rels/workbook.xml.rels' ||
        file.name.startsWith('xl/theme/') ||
        /^xl\/worksheets\/[^/]+\.xml$/.test(file.name),
    });

    const stylesRaw = files['xl/styles.xml'];
    if (!stylesRaw) return null;

    const themeRaw = files['xl/theme/theme1.xml'];
    const palette = themeRaw
      ? readThemePalette(parser.parse(strFromU8(themeRaw)))
      : [
          '#FFFFFF',
          '#000000',
          '#E7E6E6',
          '#44546A',
          '#4472C4',
          '#ED7D31',
          '#A5A5A5',
          '#FFC000',
          '#5B9BD5',
          '#70AD47',
          '#0563C1',
          '#954F72',
        ];

    const styles = buildStyles(parser.parse(strFromU8(stylesRaw)), palette);
    const targets = sheetTargets(files);
    const cellStyles = new Map<string, Map<string, number>>();
    const layouts = new Map<string, SheetLayout>();

    for (const [name, target] of targets) {
      const raw = files[target];
      if (!raw || raw.length > MAX_SHEET_XML) continue;
      const parsed = readSheet(strFromU8(raw), palette);
      cellStyles.set(name, parsed.cellStyles);
      layouts.set(name, parsed.layout);
    }

    return { styles, cellStyles, layouts };
  } catch {
    // A preview must never fail because styling could not be read.
    return null;
  }
}
