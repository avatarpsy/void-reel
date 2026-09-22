/**
 * HOW BIG THE PICTURE IS.
 *
 * A letterhead's logo is 64 points wide. Without a width a picture fills the
 * text column, which is right for a chart and turns a logo into most of a page
 * — which is exactly what shipped: a certificate whose first page was nothing
 * but the company mark, with the text pushed onto page two.
 *
 * The fetcher is stubbed with a real PNG off disk, because the thing under test
 * is the arithmetic, not the network. The assertion is the one a reader would
 * make: with the logo sized, the letter fits on one page; without, it does not.
 */
import { describe, it, expect, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';

vi.mock('../board/media-fetch', () => ({
  fetchMediaBlob: async () => new Blob([
    readFileSync('G:/Projects/Voidspace-Root/Voidspace-Website/main/public/images/logo/logo.png'),
  ], { type: 'image/png' }),
}));

import { renderDocument } from './index';

const NL = String.fromCharCode(10);
const BODY = 'A paragraph of the length a real letter contains, long enough to wrap. '.repeat(18);

async function pagesOf(imageMarkdown: string): Promise<number> {
  const out: any = await renderDocument(
    { markdown: [imageMarkdown, '', BODY].join(NL), title: 'Letter' }, 'pdf');
  const doc = await PDFDocument.load(new Uint8Array(await out.blob.arrayBuffer()));
  return doc.getPageCount();
}

describe('a logo is a logo, not a page', () => {
  it('fits the letter on one page when the width is given', async () => {
    expect(await pagesOf('![logo](https://x.test/logo.png#w=64&align=left)')).toBe(1);
  }, 60_000);

  it('fills the column when no width is given — which is right for a chart', async () => {
    expect(await pagesOf('![chart](https://x.test/logo.png)')).toBeGreaterThan(1);
  }, 60_000);

  it('reads `width` as well as `w`, and caps an absurd one', async () => {
    expect(await pagesOf('![logo](https://x.test/logo.png#width=64)')).toBe(1);
    // 9000pt is a typo, not a design. Capped, so it still renders.
    expect(await pagesOf('![logo](https://x.test/logo.png#w=9000)')).toBeGreaterThan(0);
  }, 90_000);

  /**
   * A document that OPENS with a picture has composed its own masthead, so the
   * injected title must not be printed above it. Observed on a real certificate:
   * a big black heading, then the company mark, then the real title.
   */
  it('does not print the file name above a masthead', async () => {
    const out: any = await renderDocument({
      markdown: ['![logo](https://x.test/logo.png#w=64)', '', '# Certificate', '', BODY].join(NL),
      title: 'Internship Certificate',
    }, 'md');
    const text = await out.blob.text();
    expect(text.indexOf('![logo]')).toBeLessThan(text.indexOf('# Certificate'));
    expect(text).not.toContain('# Internship Certificate');
  }, 60_000);
});
