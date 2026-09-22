/**
 * The page itself: how big it is, how many there are, and that everything the
 * block model can carry actually reaches a file.
 *
 * ── WHY THESE ASSERT ON A RE-OPENED PDF ─────────────────────────────────────
 * `renderPdf` returning a Blob proves nothing — it returns one for a document
 * whose every glyph was dropped. Loading the bytes back with pdf-lib and reading
 * the page count and dimensions is the cheapest assertion that is actually about
 * the document: landscape is only landscape if the page is wider than it is
 * tall, and a page break only worked if there are two pages.
 *
 * Fidelity of the MARKS (colour, underline, size) cannot be read back this way —
 * a PDF's content stream is compressed and pdf-lib does not parse it. What is
 * asserted here is that they reach the writer at all and that nothing throws;
 * the visual check belongs to a human looking at one rendered page, which is
 * what `EYEBALL` below is written for.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';

import { renderDocument } from './index';
import type { DocSpec } from './blocks';

async function pdfOf(spec: DocSpec) {
  const { blob } = await renderDocument(spec, 'pdf') as any;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const doc = await PDFDocument.load(bytes);
  const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
  return { pages: doc.getPageCount(), w, h, bytes: bytes.length };
}

const PARA = 'A paragraph of the length a real document contains, long enough to wrap. ';

describe('the page', () => {
  it('is A4 portrait by default', async () => {
    const { w, h, pages } = await pdfOf({ markdown: '# Title\n\nHello.' });
    expect(Math.round(w)).toBe(595);
    expect(Math.round(h)).toBe(842);
    expect(pages).toBe(1);
  }, 60_000);

  it('turns landscape when asked, rather than rotating the text', async () => {
    const { w, h } = await pdfOf({ markdown: '# Wide\n\nHello.', orientation: 'landscape' });
    expect(w).toBeGreaterThan(h);
    expect(Math.round(w)).toBe(842);
  }, 60_000);

  it('is Letter when asked', async () => {
    const { w, h } = await pdfOf({ markdown: 'Hello.', pageSize: 'letter' });
    expect([Math.round(w), Math.round(h)]).toEqual([612, 792]);
  }, 60_000);

  /** The point of a page break: the thing after it is on its own page. */
  it('breaks the page where the document says to', async () => {
    const one = await pdfOf({ markdown: 'First page.\n\nSecond paragraph.' });
    const two = await pdfOf({ markdown: 'First page.\n\n<!-- pagebreak -->\n\nSecond page.' });
    expect(one.pages).toBe(1);
    expect(two.pages).toBe(2);
  }, 60_000);

  it('does not open with a blank page when the document STARTS with a break', async () => {
    expect((await pdfOf({ markdown: '<!-- pagebreak -->\n\nContent.' })).pages).toBe(1);
  }, 60_000);

  /**
   * Narrow margins fit more lines on a page, which is the only externally
   * visible proof that the margin was applied rather than accepted and ignored.
   */
  it('fits more on the page with narrow margins than with wide', async () => {
    const md = ['# Report', '', PARA.repeat(40)].join('\n');
    const narrow = await pdfOf({ markdown: md, margin: 'narrow' });
    const wide = await pdfOf({ markdown: md, margin: 'wide' });
    expect(narrow.pages).toBeLessThan(wide.pages);
  }, 90_000);

  it('accepts an exact margin in points', async () => {
    expect((await pdfOf({ markdown: 'Hello.', margin: 24 })).pages).toBe(1);
  }, 60_000);
});

describe('everything the model carries reaches a file', () => {
  const KITCHEN_SINK = [
    '# Kitchen Sink',
    '',
    'Plain, **bold**, *italic*, ++underlined++, ==highlighted==, ~~struck~~, `code`,',
    '[a link](https://voidspace.ai) and [big red](https://x.test){color=red size=18}.',
    '',
    '[A 20pt line in the company blue]{color=#1a56db size=20}',
    '',
    '<!-- align:center -->',
    'A centred line.',
    '',
    '<!-- align:right -->',
    '22 September 2026',
    '',
    '## A table with columns of its own',
    '',
    '<!-- columns: 4,1,1 -->',
    '| Description | Qty | Amount |',
    '| :--- | :-: | ---: |',
    '| A line item with a long description that has to wrap | 2 | 1,200.00 |',
    '| Another | 10 | 95.00 |',
    '',
    '- a bullet',
    '  - nested',
    '1. ordered',
    '',
    '> a quote',
    '',
    '---',
    '',
    '<!-- pagebreak -->',
    '',
    '## Page two',
    '',
    PARA.repeat(6),
  ].join('\n');

  for (const format of ['pdf', 'docx', 'md'] as const) {
    it(`renders it as ${format}`, async () => {
      const out: any = await renderDocument({
        markdown: KITCHEN_SINK, title: 'Kitchen Sink',
        header: 'Voidspace — Kitchen Sink', footer: 'Page {page} of {pages}',
      }, format);
      expect(out.blob.size).toBeGreaterThan(format === 'md' ? 200 : 3_000);
      if (format === 'pdf') {
        expect(out.pages).toBe(2);
        expect(out.droppedGlyphs).toBe(0);
      }
    }, 120_000);
  }

  /**
   * EYEBALL. Writes the rendered file where a human can open it — the only
   * check that catches text overprinting the line above it, which no assertion
   * on page count ever will. Off unless asked for, because a test suite that
   * writes files into a repo is a test suite people stop trusting.
   */
  it('writes a file to look at when VS_DOC_OUT is set', async () => {
    const dir = process.env.VS_DOC_OUT;
    if (!dir) return;
    const fs = await import('node:fs/promises');
    for (const format of ['pdf', 'docx'] as const) {
      const out: any = await renderDocument({
        markdown: KITCHEN_SINK, title: 'Kitchen Sink',
        header: 'Voidspace — Kitchen Sink', footer: 'Page {page} of {pages}',
      }, format);
      const buf = Buffer.from(await out.blob.arrayBuffer());
      await fs.writeFile(`${dir}/kitchen-sink.${format}`, buf);
      console.log(`wrote ${dir}/kitchen-sink.${format} (${buf.length} bytes)`);
    }
  }, 120_000);
});

/**
 * ── WHAT AN OFFLINE RENDER LOSES, EXACTLY ───────────────────────────────────
 *
 * These tests have no network, so no web font is fetched and every glyph falls
 * to the base-14 floor described in `fonts.ts`. That makes this the one place
 * the floor can be measured: ₹ (U+20B9) is not in WinAnsi, so offline it is
 * counted as dropped and reported to the user rather than silently omitted.
 *
 * In a browser the Noto face IS fetched and the same document sets ₹ properly.
 * That is verified by looking at a rendered page, not here — what is pinned
 * here is that the count is HONEST and that the rest of the document survives
 * a total font failure, which is the behaviour that matters when it happens.
 */
describe('the offline floor', () => {
  const MD = 'Total: ₹1,200 and ₹95.';

  it('reports exactly the glyphs WinAnsi cannot encode, and no others', async () => {
    const withRupee: any = await renderDocument({ markdown: MD }, 'pdf');
    const without: any = await renderDocument(
      { markdown: MD.replace(/₹/g, 'Rs ') }, 'pdf');
    expect(without.droppedGlyphs).toBe(0);
    expect(withRupee.droppedGlyphs).toBe(2);
  }, 60_000);

  it('still sets the rest of the sentence', async () => {
    // A dropped glyph must cost one character, not the paragraph around it.
    // Compared against the SAME document with nothing in it, because the
    // absolute size of a one-line PDF is a number about pdf-lib, not about us.
    const withText: any = await renderDocument({ markdown: MD }, 'pdf');
    const empty: any = await renderDocument({ markdown: '.' }, 'pdf');
    expect(withText.blob.size).toBeGreaterThan(empty.blob.size + 40);
  }, 60_000);
});

describe('line spacing', () => {
  const md = ['# Report', '', 'A paragraph of the length a real document contains. '.repeat(90)]
    .join(String.fromCharCode(10));

  /**
   * Double-spaced is a REQUIREMENT on submitted work, so the only assertion
   * worth making is the one a marker would make: it takes more pages.
   */
  it('double-spaced takes more pages than single', async () => {
    const single = await pdfOf({ markdown: md, lineSpacing: 1 });
    const double = await pdfOf({ markdown: md, lineSpacing: 2 });
    expect(double.pages).toBeGreaterThan(single.pages);
  }, 90_000);

  it('ignores a value that is not a spacing', async () => {
    const plain = await pdfOf({ markdown: md });
    const nonsense = await pdfOf({ markdown: md, lineSpacing: -4 as any });
    expect(nonsense.pages).toBe(plain.pages);
  }, 90_000);
});
