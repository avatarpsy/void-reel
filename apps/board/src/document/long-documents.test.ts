/**
 * How big a document can this actually make?
 *
 * The answer matters because the whole feature rests on a claim — that
 * typesetting belongs on the user's device — and that claim is only worth
 * anything if a REAL report finishes quickly there. Measured rather than
 * asserted: 200 sections is ~21,000 words and 61 printed pages.
 *
 * Timings are logged, never asserted. A machine under load would fail a
 * threshold and teach nobody anything; the numbers in the log are what a human
 * reads when they wonder whether this still scales.
 */
import { describe, it, expect } from 'vitest';
import { renderDocument } from './index';
import { parseMarkdown } from './blocks';

function longDoc(sections: number): string {
  const para = 'This is a paragraph of the sort a real report contains, long enough to wrap '
    + 'several times at a sensible measure and to exercise the line breaker properly. ';
  const out: string[] = ['# A Genuinely Long Report', ''];
  for (let i = 1; i <= sections; i++) {
    out.push(`## Section ${i}`, '', para.repeat(3), '',
      `1. First point in section ${i}.`, `2. Second point in section ${i}.`, '',
      `> A pulled quote for section ${i}.`, '');
  }
  return out.join('\n');
}

describe('long documents', () => {
  for (const sections of [50, 200]) {
    it(`handles ${sections} sections`, async () => {
      const md = longDoc(sections);
      const words = md.split(/\s+/).length;

      let t = Date.now();
      const blocks = parseMarkdown(md, 'A Genuinely Long Report');
      const parseMs = Date.now() - t;

      t = Date.now();
      const pdf = await renderDocument({ markdown: md, title: 'Long' }, 'pdf');
      const pdfMs = Date.now() - t;

      t = Date.now();
      const docx = await renderDocument({ markdown: md, title: 'Long' }, 'docx');
      const docxMs = Date.now() - t;

      console.log(`[${sections} sections] ${words} words, ${blocks.length} blocks | `
        + `parse ${parseMs}ms | pdf ${pdfMs}ms ${pdf.pages}pp ${Math.round(pdf.bytes / 1024)}KB | `
        + `docx ${docxMs}ms ${Math.round(docx.bytes / 1024)}KB`);

      expect(pdf.pages).toBeGreaterThan(sections / 8);
      expect(docx.bytes).toBeGreaterThan(1000);
    }, 300_000);
  }
});
