/**
 * #320: streaming XLSX export of the Timeline.
 *
 * Why streaming: the earlier exceljs implementation held every cell in
 * memory while building the workbook, which forced a row cap and could
 * OOM the tab on the light hardware Hashrate Autopilot targets. This
 * writes the worksheet XML row-by-row straight into a streaming deflate
 * (fflate), with inline strings (no shared-strings table to accumulate),
 * so peak memory is a single page of rows + the compressed output - flat
 * regardless of row count. No cap.
 *
 * The rows arrive as an async iterable so the caller can page the
 * bid-event endpoint and merge the (already-loaded, bounded) extra rows
 * without ever materializing the whole set. exceljs is gone; fflate is
 * ~8 kB and lazy-loaded so it stays out of the initial bundle.
 */
import { api, type BidHistoryFilters, type BidHistoryFlatEvent } from './api';

/** One flat spreadsheet row. Bid-event columns are null for other kinds. */
export interface TimelineExportRow {
  whenUtc: string;
  whenLocal: string;
  type: string;
  bid: string | null;
  fillable: number | null;
  priceBefore: number | null;
  priceAfter: number | null;
  deltaPrice: number | null;
  speed: number | null;
  reason: string;
}

// Cell style buckets. 'text' = inline string (s=0). 'rate' = a
// sat/BTC/USD-per-unit-per-day number (s=2, formatted with the caller's
// rate number-format). 'speed' = a hashrate number (s=3, formatted with
// the caller's speed number-format). The two numeric buckets exist so a
// single style each can carry the denomination-dependent decimal count.
type CellStyle = 'text' | 'rate' | 'speed';
const STYLE_INDEX: Record<CellStyle, number> = { text: 0, rate: 2, speed: 3 };

const COLUMNS: Array<{ key: keyof TimelineExportRow; header: string; width: number; style: CellStyle }> = [
  { key: 'whenUtc', header: 'When (UTC)', width: 21, style: 'text' },
  { key: 'whenLocal', header: 'When (local)', width: 21, style: 'text' },
  { key: 'type', header: 'Type', width: 16, style: 'text' },
  { key: 'bid', header: 'Bid', width: 22, style: 'text' },
  { key: 'fillable', header: 'Fillable (sat/PH/day)', width: 18, style: 'rate' },
  { key: 'priceBefore', header: 'Price before', width: 14, style: 'rate' },
  { key: 'priceAfter', header: 'Price after', width: 14, style: 'rate' },
  { key: 'deltaPrice', header: 'Δ price', width: 12, style: 'rate' },
  { key: 'speed', header: 'Speed (PH/s)', width: 12, style: 'speed' },
  { key: 'reason', header: 'Reason', width: 70, style: 'text' },
];
const COL_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const LAST_COL = COL_LETTERS[COLUMNS.length - 1]!;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Endpoint's max page size; larger pages = far fewer round-trips. */
const EXPORT_PAGE_SIZE = 500;

/**
 * Page `/api/bid-history-events` to completion under the active filters,
 * yielding events newest-first. No cap - the streaming writer keeps
 * memory flat, so the only bound is a runaway-loop backstop.
 */
export async function* pageBidEvents(
  filters: BidHistoryFilters,
): AsyncGenerator<BidHistoryFlatEvent> {
  let cursor: number | undefined = undefined;
  // Backstop: 1M rows is Excel's own ceiling; a real pull is far below.
  for (let i = 0; i < Math.ceil(1_048_576 / EXPORT_PAGE_SIZE) + 1; i += 1) {
    const page = await api.bidHistoryFlatEvents(filters, cursor, EXPORT_PAGE_SIZE);
    for (const e of page.events) yield e;
    if (page.next_cursor_id === null) break;
    cursor = page.next_cursor_id;
  }
}

function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

// XML text escaping + stripping of characters XLSX/XML forbids (control
// chars other than tab/newline/CR corrupt the file in Excel).
const INVALID_XML = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
function xmlEscape(s: string): string {
  return s
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cellXml(letter: string, r: number, value: string | number | null, style: CellStyle): string {
  if (value === null || value === '') return '';
  const ref = `${letter}${r}`;
  if (style !== 'text') return `<c r="${ref}" t="n" s="${STYLE_INDEX[style]}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr" s="0"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
}

/**
 * Excel number-format codes (numFmt formatCode) for the two numeric
 * buckets, chosen by the caller from the active denomination so the
 * exported decimals match what the dashboard shows (e.g. sat = integer,
 * BTC = 8 decimals, USD = 2; PH speed = 2 decimals, EH speed = 5).
 */
export interface ExportNumberFormats {
  /** Format for the four rate columns (fillable / prices / delta). */
  rate: string;
  /** Format for the speed column. */
  speed: string;
}

const DEFAULT_NUMBER_FORMATS: ExportNumberFormats = { rate: '#,##0', speed: '#,##0.00' };

/** Translated labels the caller injects so the sheet matches the UI language. */
export interface ExportLabels {
  /** Column headers, in COLUMNS order. */
  headers: readonly string[];
  /** Worksheet + workbook tab name. */
  sheetName: string;
  /** Denomination-dependent number formats for the numeric columns. */
  numberFormats?: ExportNumberFormats;
}

/** Default (English) labels, e.g. for tests. */
export const DEFAULT_EXPORT_LABELS: ExportLabels = {
  headers: COLUMNS.map((c) => c.header),
  sheetName: 'Timeline',
  numberFormats: DEFAULT_NUMBER_FORMATS,
};

function headerRowXml(headers: readonly string[]): string {
  let s = '<row r="1">';
  COLUMNS.forEach((c, i) => {
    s += `<c r="${COL_LETTERS[i]}1" t="inlineStr" s="1"><is><t xml:space="preserve">${xmlEscape(headers[i] ?? c.header)}</t></is></c>`;
  });
  return s + '</row>';
}

function dataRowXml(row: TimelineExportRow, r: number): string {
  let s = `<row r="${r}">`;
  COLUMNS.forEach((c, i) => {
    s += cellXml(COL_LETTERS[i]!, r, row[c.key] as string | number | null, c.style);
  });
  return s + '</row>';
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

function workbookXml(sheetName: string): string {
  // Sheet names cap at 31 chars and can't contain []:*?/\ - sanitize.
  const safe = xmlEscape(sheetName.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31)) || 'Timeline';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${safe}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>'
  );
}

const WB_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

// s=0 default text; s=1 bold header on a yellow fill; s=2 rate number
// (numFmtId 164); s=3 speed/hashrate number (numFmtId 165). The two
// numeric formats are injected so exported decimals follow the active
// denomination (sat/BTC/USD and TH/PH/EH).
function stylesXml(fmts: ExportNumberFormats): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="2">' +
    `<numFmt numFmtId="164" formatCode="${xmlEscape(fmts.rate)}"/>` +
    `<numFmt numFmtId="165" formatCode="${xmlEscape(fmts.speed)}"/>` +
    '</numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFACC15"/></patternFill></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

function sheetHead(headers: readonly string[]): string {
  // Fixed column widths - no `bestFit`. `bestFit` makes Excel rescan
  // every cell in the column to auto-size it when the file opens, which
  // is measurably slow on large exports (20k+ rows). The widths here are
  // stable enough that a fixed value looks right; we still widen the base
  // to fit a longer translated/unit-bearing header so it isn't clipped.
  const cols = COLUMNS.map((c, i) => {
    const w = Math.max(c.width, (headers[i] ?? c.header).length + 3);
    return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
  }).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols><sheetData>`
  );
}

/**
 * Stream the rows into a formatted .xlsx Blob. Memory stays flat: the
 * worksheet XML is deflated in chunks as it's produced and only the
 * (small) compressed output is retained.
 */
export async function streamTimelineXlsx(
  rows: AsyncIterable<TimelineExportRow>,
  labels: ExportLabels = DEFAULT_EXPORT_LABELS,
): Promise<Blob> {
  const { Zip, ZipDeflate, strToU8 } = await import('fflate');
  const parts: Uint8Array[] = [];
  let resolveDone!: () => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      rejectDone(err);
      return;
    }
    if (chunk) parts.push(chunk);
    if (final) resolveDone();
  });
  const addFull = (name: string, xml: string) => {
    const f = new ZipDeflate(name, { level: 6 });
    zip.add(f);
    f.push(strToU8(xml), true);
  };
  addFull('[Content_Types].xml', CONTENT_TYPES);
  addFull('_rels/.rels', ROOT_RELS);
  addFull('xl/workbook.xml', workbookXml(labels.sheetName));
  addFull('xl/_rels/workbook.xml.rels', WB_RELS);
  addFull('xl/styles.xml', stylesXml(labels.numberFormats ?? DEFAULT_NUMBER_FORMATS));

  const sheet = new ZipDeflate('xl/worksheets/sheet1.xml', { level: 6 });
  zip.add(sheet);
  sheet.push(strToU8(sheetHead(labels.headers) + headerRowXml(labels.headers)), false);
  let count = 1;
  let buf = '';
  for await (const row of rows) {
    count += 1;
    buf += dataRowXml(row, count);
    if (buf.length > 65_536) {
      sheet.push(strToU8(buf), false);
      buf = '';
    }
  }
  if (buf) sheet.push(strToU8(buf), false);
  sheet.push(strToU8(`</sheetData><autoFilter ref="A1:${LAST_COL}${count}"/></worksheet>`), true);
  zip.end();
  await done;
  return new Blob(parts as BlobPart[], { type: XLSX_MIME });
}

/** Trigger a browser download of a Blob under `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export { isoUtc };
