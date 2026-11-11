/**
 * xlsx style/layout reader: the parts of an OOXML workbook the preview needs
 * to look like the file instead of Excel's default grid.
 *
 * Pins:
 *   - column widths and row heights come through with their units intact
 *   - theme + tint colours resolve exactly like Excel resolves them
 *   - per-cell xf indices land on the matching entry in the styles array
 *   - number formats, fonts and borders survive the mapping
 *   - a non-xlsx / broken payload returns null instead of throwing
 *
 * The fixture is written longhand, not with a spreadsheet library: it must not
 * share code with the reader under test.
 */
import JSZip from 'jszip';
import { parseSheetStyles } from '../src/ui/sheets/xlsx-style';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

async function fixture(): Promise<Uint8Array> {
  const zip = new JSZip();

  zip.file(
    'xl/workbook.xml',
    XML +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets>' +
      '</workbook>',
  );

  zip.file(
    'xl/_rels/workbook.xml.rels',
    XML +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>',
  );

  zip.file(
    'xl/theme/theme1.xml',
    XML +
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:themeElements><a:clrScheme name="Office">' +
      '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
      '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
      '<a:dk2><a:srgbClr val="44546A"/></a:dk2>' +
      '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
      '<a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
      '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
      // theme index 6 is accent3 — the colour the report's title fill uses.
      '<a:accent3><a:srgbClr val="9BBB59"/></a:accent3>' +
      '<a:accent4><a:srgbClr val="8064A2"/></a:accent4>' +
      '<a:accent5><a:srgbClr val="4BACC6"/></a:accent5>' +
      '<a:accent6><a:srgbClr val="F79646"/></a:accent6>' +
      '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
      '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
      '</a:clrScheme></a:themeElements></a:theme>',
  );

  zip.file(
    'xl/styles.xml',
    XML +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00%"/></numFmts>' +
      '<fonts count="2">' +
      '<font><sz val="11"/><name val="宋体"/></font>' +
      '<font><b/><sz val="14"/><color rgb="FFAA0000"/><name val="Arial"/></font>' +
      '</fonts>' +
      '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor theme="6" tint="0.599993896298105"/>' +
      '<bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left style="thin"><color rgb="FF000000"/></left><right style="thin"/>' +
      '<top style="thin"/><bottom style="thin"/><diagonal/></border>' +
      '</borders>' +
      '<cellXfs count="3">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
      '<xf numFmtId="164" fontId="1" fillId="2" borderId="1" applyNumberFormat="1">' +
      '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
      '</cellXfs>' +
      '</styleSheet>',
  );

  zip.file(
    'xl/worksheets/sheet1.xml',
    XML +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetFormatPr defaultRowHeight="16.8" defaultColWidth="9"/>' +
      '<cols>' +
      '<col min="1" max="1" width="30.875" customWidth="1"/>' +
      '<col min="2" max="2" width="32" customWidth="1"/>' +
      '</cols>' +
      '<sheetData>' +
      '<row r="1" ht="24.95" customHeight="1"><c r="A1" s="1"><v>42</v></c></row>' +
      '<row r="2"><c r="B2" s="2"><v>86</v></c></row>' +
      '</sheetData>' +
      '</worksheet>',
  );

  return zip.generateAsync({ type: 'uint8array' });
}

async function main(): Promise<void> {
  const bytes = await fixture();
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const parsed = parseSheetStyles(data as ArrayBuffer);

  check('the workbook parses', parsed !== null);
  if (!parsed) return;

  const layout = parsed.layouts.get('S1');
  check('the sheet layout is found', layout !== undefined);
  if (!layout) return;

  check(
    'column widths keep their character units',
    layout.columnWidths.length === 2 &&
      layout.columnWidths[0].width === 30.875 &&
      layout.columnWidths[1].width === 32,
    JSON.stringify(layout.columnWidths),
  );
  check(
    'column spans are translated to 0-based indices',
    layout.columnWidths[0].startColumn === 0 && layout.columnWidths[1].endColumn === 1,
  );
  check(
    'row heights keep their point units',
    layout.rowHeights.get(0)?.height === 24.95 && layout.rowHeights.get(0)?.customHeight === true,
    JSON.stringify(layout.rowHeights.get(0)),
  );
  check(
    'sheetFormatPr defaults come through',
    layout.defaultRowHeight === 16.8 && layout.defaultColumnWidth === 9,
    `${layout.defaultRowHeight} / ${layout.defaultColumnWidth}`,
  );

  const cellStyles = parsed.cellStyles.get('S1');
  check('A1 points at xf 1', cellStyles?.get('0:0') === 1, String(cellStyles?.get('0:0')));
  check('B2 points at xf 2', cellStyles?.get('1:1') === 2, String(cellStyles?.get('1:1')));

  const style = parsed.styles[1];
  check('the styles array is indexed by xf id', parsed.styles.length === 3);
  check('bold survives', style?.bold === true);
  check('font family and size survive', style?.fontFamily === 'Arial' && style?.fontSize === 14);
  check('font colour survives', style?.fontColor === '#AA0000', String(style?.fontColor));
  check(
    'theme + tint resolves exactly like Excel (#D7E4BD)',
    style?.fillColor === '#D7E4BD',
    String(style?.fillColor),
  );
  check(
    'custom number format survives',
    style?.numberFormat === '0.00%',
    String(style?.numberFormat),
  );
  check(
    'alignment survives',
    style?.horizontalAlignment === 'center' && style?.verticalAlignment === 'center',
  );
  check('wrapText survives', style?.wrapText === true);
  check('border edge survives', style?.borderTop?.style === 'thin');
  check(
    'border colour survives where the file sets one',
    style?.borderLeft?.color === '#000000',
    String(style?.borderLeft?.color),
  );

  check(
    'a non-xlsx payload returns null',
    parseSheetStyles(new Uint8Array([1, 2, 3]).buffer) === null,
  );
}

main()
  .catch((err) => {
    failures++;
    console.error(err);
  })
  .finally(() => {
    console.log(failures === 0 ? '\nall assertions passed' : `\n${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
  });
