export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt: string;
}

/**
 * Directory names never traversed and never shown: VCS metadata, dependency
 * trees, build output, caches.
 *
 * Shared by the server-side search walk and the client-side file tree so both
 * agree on what "exists" — otherwise search would surface files the tree
 * refuses to display, and a recursive walk would return tens of thousands of
 * node_modules hits.
 */
export const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.vite',
  'dist',
  '.next',
  '__pycache__',
  '.DS_Store',
]);

export interface FileContent {
  path: string;
  content: string;
  language?: string;
  size: number;
  encoding?: 'utf-8' | 'base64';
  mimeType?: string;
}

// --- Office document structured content ---

export interface DocxContent {
  type: 'docx';
  data: string; // base64-encoded raw DOCX file
}

export interface XlsxCellFont {
  name?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string; // hex ARGB, e.g. "FF0000" or "FFFF0000"
}

export interface XlsxCellFill {
  color?: string; // hex ARGB
}

export interface XlsxCellBorder {
  style?: 'thin' | 'medium' | 'thick' | 'dotted' | 'dashed' | 'double' | 'hair';
  color?: string;
}

export interface XlsxCellBorderSide {
  top?: XlsxCellBorder;
  bottom?: XlsxCellBorder;
  left?: XlsxCellBorder;
  right?: XlsxCellBorder;
}

export interface XlsxCellAlignment {
  horizontal?: 'left' | 'center' | 'right' | 'fill' | 'justify' | 'centerContinuous' | 'distributed';
  vertical?: 'top' | 'middle' | 'bottom' | 'distributed' | 'justify';
  wrapText?: boolean;
  textRotation?: number;
}

export interface XlsxCell {
  value: string;
  font?: XlsxCellFont;
  fill?: XlsxCellFill;
  border?: XlsxCellBorderSide;
  alignment?: XlsxCellAlignment;
  isHeader?: boolean;
}

export interface XlsxRow {
  height?: number;
  cells: XlsxCell[];
}

export interface XlsxMerge {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface XlsxSheet {
  name: string;
  columns: { width?: number }[];
  merges: XlsxMerge[];
  rows: XlsxRow[];
  freeze?: { xSplit: number; ySplit: number; topLeftCell: string };
  defaultFont?: { name?: string; size?: number };
}

export interface XlsxContent {
  type: 'xlsx';
  sheets: XlsxSheet[];
}

export interface PptxTextRun {
  text: string;
  fontSize?: number; // in points (already converted from OOXML hundredths)
  color?: string; // hex RRGGBB
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontFamily?: string;
}

export interface PptxParagraph {
  alignment?: 'left' | 'center' | 'right' | 'justify';
  runs: PptxTextRun[];
  level?: number;
  lineSpacing?: number; // multiple of single line (e.g., 1.5)
  spaceBefore?: number; // in points
  spaceAfter?: number; // in points
  bullet?: { type: 'char' | 'autoNum'; char?: string; numType?: string };
}

export interface PptxShapeFill {
  type: 'solid' | 'gradient';
  color?: string; // for solid
  stops?: { color: string; position: number }[]; // for gradient
  gradientAngle?: number; // in degrees, 0 = left-to-right
}

export interface PptxShapeOutline {
  color?: string;
  width?: number; // in EMU
  dashStyle?: 'solid' | 'dash' | 'dot' | 'dashDot' | 'none';
}

export interface PptxTableCell {
  text: string;
  colSpan?: number;
  rowSpan?: number;
  fill?: string;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  fontFamily?: string;
  align?: 'left' | 'center' | 'right';
}

export interface PptxTableRow {
  cells: PptxTableCell[];
  height?: number;
}

export interface PptxTable {
  columns: { width: number }[];
  rows: PptxTableRow[];
}

export interface PptxShape {
  type: 'text' | 'image' | 'group' | 'table';
  x: number;
  y: number;
  width: number;
  height: number;
  // Text shapes
  paragraphs?: PptxParagraph[];
  // Text body margins (EMU) from <a:bodyPr> lIns/tIns/rIns/bIns
  textMargin?: { left: number; top: number; right: number; bottom: number };
  // Image shapes
  image?: { data: string; mimeType: string };
  // Rotation in degrees
  rotation?: number;
  // Shape fill
  fill?: PptxShapeFill;
  // Shape outline
  outline?: PptxShapeOutline;
  // Shape geometry (preset)
  geometry?: 'rect' | 'roundRect' | 'ellipse' | 'triangle' | 'diamond' | 'rtTriangle' | 'chevron' | 'pentagon' | 'hexagon' | 'octagon' | 'star5' | 'custom';
  // Text body anchor (vertical alignment)
  textAnchor?: 'top' | 'middle' | 'bottom';
  // For group shapes
  children?: PptxShape[];
  // For table shapes
  table?: PptxTable;
}

export interface PptxSlide {
  index: number;
  background?: { type: 'solid'; color: string } | { type: 'gradient'; stops: { color: string; position: number }[]; gradientAngle?: number };
  shapes: PptxShape[];
  notes: string;
}

export interface PptxContent {
  type: 'pptx';
  slideWidth: number; // EMU
  slideHeight: number; // EMU
  slides: PptxSlide[];
}

export type OfficeDocContent = DocxContent | XlsxContent | PptxContent;

export interface OfficeContent {
  path: string;
  size: number;
  doc: OfficeDocContent;
}

export interface FileSearchOptions {
  /** Maximum number of matches returned. Defaults to 200. */
  limit?: number;
  /** Maximum number of directories visited. Defaults to 2000. */
  maxDirs?: number;
  /**
   * Caller-chosen id used to cancel an in-flight walk via `cancelSearch`.
   * Omit for a search that always runs to completion.
   */
  searchId?: string;
}

/**
 * Search outcome. Deliberately a payload rather than an error: "no matches",
 * "hit the cap" and "some subtrees were unreadable" are three different states
 * the UI must be able to tell apart, and the transport collapses every error to
 * a bare message.
 */
export interface FileSearchResult {
  entries: FileEntry[];
  /** True when a cap (limit/maxDirs) stopped the walk early. */
  truncated: boolean;
  /** Directories actually visited — lets the UI explain a truncated result. */
  scanned: number;
  /** Per-directory failures (EACCES etc). Partial results are still returned. */
  errors?: { path: string; message: string }[];
}

export interface FileService {
  list(workspaceId: string, directory?: string): Promise<FileEntry[]>;
  read(workspaceId: string, filePath: string): Promise<FileContent>;
  write(workspaceId: string, filePath: string, content: string): Promise<void>;
  delete(workspaceId: string, filePath: string): Promise<void>;
  readOffice(workspaceId: string, filePath: string): Promise<OfficeContent>;
  /** Recursive filename search within a workspace. */
  search(
    workspaceId: string,
    query: string,
    options?: FileSearchOptions,
  ): Promise<FileSearchResult>;
  /** Ask an in-flight search to stop at the next directory boundary. */
  cancelSearch(searchId: string): Promise<void>;
}
