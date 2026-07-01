/**
 * #320: the XLSX is hand-rolled (streaming, no exceljs), so validate the
 * output is a well-formed OOXML package by unzipping it and inspecting
 * the parts - the closest thing to "does Excel open it" we can assert in
 * a unit test.
 */
import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';

import { streamTimelineXlsx, type TimelineExportRow } from './timelineExport';

async function* toAsync(rows: TimelineExportRow[]): AsyncGenerator<TimelineExportRow> {
  for (const r of rows) yield r;
}

const REQUIRED_PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/styles.xml',
  'xl/worksheets/sheet1.xml',
];

describe('streamTimelineXlsx', () => {
  const sample: TimelineExportRow[] = [
    {
      whenUtc: '2026-07-01 00:05:00Z',
      whenLocal: '1 Jul 2026, 02:05',
      type: 'edit price',
      bid: 'B866123',
      fillable: 47000,
      priceBefore: 47100,
      priceAfter: 47200,
      deltaPrice: 100,
      speed: 3,
      reason: 'track fillable 47,100 -> 47,200 <& more>',
    },
    {
      whenUtc: '2026-07-01 00:00:00Z',
      whenLocal: '1 Jul 2026, 02:00',
      type: 'pool block',
      bid: null,
      fillable: null,
      priceBefore: null,
      priceAfter: null,
      deltaPrice: null,
      speed: null,
      reason: 'block 956000 · 314,000,000 sat',
    },
  ];

  it('produces a valid zip containing every required OOXML part', async () => {
    const blob = await streamTimelineXlsx(toAsync(sample));
    const buf = new Uint8Array(await blob.arrayBuffer());
    const files = unzipSync(buf);
    for (const part of REQUIRED_PARTS) expect(files[part], part).toBeDefined();
  });

  it('writes the header + one row per input, with the autofilter over the full range', async () => {
    const blob = await streamTimelineXlsx(toAsync(sample));
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<row r="1">'); // header
    expect(sheet).toContain('<row r="2">');
    expect(sheet).toContain('<row r="3">');
    expect(sheet).not.toContain('<row r="4">');
    // autofilter spans header..last data row (10 cols -> J)
    expect(sheet).toContain('autoFilter ref="A1:J3"');
    // frozen header pane
    expect(sheet).toContain('state="frozen"');
  });

  it('escapes XML-special characters and renders numeric cells as numbers', async () => {
    const blob = await streamTimelineXlsx(toAsync(sample));
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('&lt;&amp; more&gt;'); // '<& more>' escaped
    expect(sheet).not.toContain('<& more>');
    expect(sheet).toContain('t="n" s="2"><v>47200</v>'); // priceAfter as a rate number
    expect(sheet).toContain('t="n" s="3"><v>3</v>'); // speed as a hashrate number
  });

  it('injects the caller-supplied number formats into the stylesheet', async () => {
    const blob = await streamTimelineXlsx(toAsync(sample), {
      headers: Array.from({ length: 10 }, (_, i) => `H${i}`),
      sheetName: 'S',
      numberFormats: { rate: '#,##0.00000000', speed: '#,##0.00000' },
    });
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const styles = strFromU8(files['xl/styles.xml']!);
    expect(styles).toContain('numFmtId="164" formatCode="#,##0.00000000"'); // BTC rate
    expect(styles).toContain('numFmtId="165" formatCode="#,##0.00000"'); // EH speed
  });

  it('omits empty cells rather than emitting blank string cells', async () => {
    const blob = await streamTimelineXlsx(toAsync([sample[1]!]));
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    // row 2 is the block row: Bid (D), fillable (E), price cells (F/G/H)
    // and speed (I) are all empty -> omitted; When/Type/Reason remain.
    expect(sheet).not.toContain('r="D2"');
    expect(sheet).not.toContain('r="E2"');
    expect(sheet).not.toContain('r="F2"');
    expect(sheet).toContain('r="A2"'); // When (UTC) present
    expect(sheet).toContain('r="J2"'); // Reason present
  });
});
