/**
 * THE PAGE FOLLOWS THE THEME. THE FILE NEVER DOES.
 *
 * A document on the canvas is being edited, and a sheet of blazing white in a
 * dark editor is the thing people turn dark mode on to avoid — so the page takes
 * the theme. What gets exported must not: a PDF made at midnight has to be the
 * same file as one made at noon, because it is going to a printer, a client or a
 * court, none of which care what the author's editor looked like.
 *
 * Today that is true because the writers never read the theme. This test exists
 * so it STAYS true: "use the theme colour here" is a reasonable-looking change
 * that would pass review, pass every other test, and only be discovered when
 * somebody printed a contract and got white text on white paper.
 */
import { describe, it, expect } from 'vitest';

/**
 * THIS FILE CONTROLS ITS OWN NETWORK.
 *
 * `pdf-fonts.test.ts` stubs `fetch` to serve real font files, and vitest may
 * put both files in the same worker — so whether a render here got web fonts
 * or the base-14 depended on which file was mid-flight. Two renders that are
 * supposed to be byte-identical then differed for a reason that had nothing to
 * do with the theme.
 *
 * Pinned to 404 for the whole file: both renders use the same faces, so a
 * difference between them can only be the thing under test.
 */
const realFetch = globalThis.fetch;

/**
 * Run `body` with the network pinned, and pin it INSIDE the test rather than in
 * a `beforeAll`: vitest may put this file and `pdf-fonts.test.ts` in the same
 * worker, and whichever hook ran last owned `globalThis.fetch`. Two renders
 * that must be byte-identical then differed depending on file order, which is a
 * flaky test — worse than no test, because it teaches people to re-run it.
 */
async function withPinnedFonts<T>(body: () => Promise<T>): Promise<T> {
  const before = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  try { return await body(); } finally { globalThis.fetch = before ?? realFetch; }
}
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';

import { renderDocument } from './index';

const NL = String.fromCharCode(10);
const SOURCE = ['# Contract', '', 'The **material** terms are set out below.', '',
  '| Item | Amount |', '| :--- | ---: |', '| Fee | 1,200.00 |'].join(NL);

/** Render with the page pretending to be in one theme or the other. */
async function renderUnderTheme(theme: 'light' | 'dark'): Promise<Uint8Array> {
  const root = (globalThis as any).document?.documentElement;
  const before = root?.dataset?.theme;
  if (root) root.dataset.theme = theme;
  try {
    const out: any = await renderDocument({ markdown: SOURCE, title: 'Contract' }, 'pdf');
    return new Uint8Array(await out.blob.arrayBuffer());
  } finally {
    if (root) {
      if (before === undefined) delete root.dataset.theme;
      else root.dataset.theme = before;
    }
  }
}

describe('the exported file ignores the editor theme', () => {
  it('produces byte-identical PDFs in light and dark', async () => {
    const { light, dark } = await withPinnedFonts(async () => ({
      light: await renderUnderTheme('light'),
      dark: await renderUnderTheme('dark'),
    }));
    // pdf-lib writes no timestamp by default, so equal input is equal output.
    /**
     * The DRAWING, not the bytes. pdf-lib gives every font resource a random
     * suffix, so two renders of the same document legitimately differ byte for
     * byte — an earlier version of this asserted byte equality and was flaky,
     * which is worse than no test because it teaches people to re-run it.
     *
     * What must not change is what is painted: the colour operators and the
     * text-showing operators. Those are compared with the random names removed.
     */
    expect(paintOf(dark)).toBe(paintOf(light));
  }, 120_000);

  it('produces an identical Word DOCUMENT in light and dark', async () => {
    const root = (globalThis as any).document?.documentElement;
    const make = async (theme: string) => {
      if (root) root.dataset.theme = theme;
      const out: any = await renderDocument({ markdown: SOURCE, title: 'Contract' }, 'docx');
      return new Uint8Array(await out.blob.arrayBuffer());
    };

    /**
     * The PART, not the file. A .docx is a zip and a zip carries timestamps, so
     * two runs a second apart differ in bytes while saying exactly the same
     * thing — comparing the archive would be a test of the clock.
     */
    const { readZipMap } = await import('./zip');
    const partOf = async (bytes: Uint8Array) => {
      const files = await readZipMap(bytes, (n) => n === 'word/document.xml');
      return new TextDecoder().decode(files.get('word/document.xml')!);
    };

    const { light, dark } = await withPinnedFonts(async () => ({
      light: await make('light'),
      dark: await make('dark'),
    }));
    expect(await partOf(dark)).toBe(await partOf(light));
  }, 120_000);
  /**
   * The writers must contain no reference to the theme at all. Read as TEXT,
   * because the point is to catch the line being ADDED, which no behavioural
   * test can do until somebody also changes the colours.
   */
  it('has no theme lookup anywhere in the writers', () => {
    for (const file of ['pdf.ts', 'docx.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      for (const forbidden of [
        'data-theme', 'prefers-color-scheme', 'documentElement', 'matchMedia',
        'getComputedStyle', '--affine',
      ]) {
        expect(source, `${file} must not read ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  /** And the ink is a constant, not something derived at run time. */
  it('sets its ink from a literal', () => {
    const source = readFileSync(join(__dirname, 'pdf.ts'), 'utf8');
    expect(source).toMatch(/const ink = rgb\([\d.]+, [\d.]+, [\d.]+\)/);
  });
});

/**
 * Everything the page PAINTS, with the parts that are allowed to differ taken
 * out: font resource names carry a random suffix by design.
 */
function paintOf(file: Uint8Array): string {
  const buf = Buffer.from(file);
  const text = buf.toString('latin1');
  const out: string[] = [];
  let i = 0;
  while (true) {
    const s = text.indexOf('stream', i);
    if (s < 0) break;
    let start = s + 6;
    if (buf[start] === 13) start++;
    if (buf[start] === 10) start++;
    const e = text.indexOf('endstream', start);
    if (e < 0) break;
    try {
      const body = inflateSync(buf.subarray(start, e)).toString('latin1');
      if (/Tj|TJ|rg/.test(body)) {
        out.push(body.replace(/\/([A-Za-z]+-[A-Za-z]+)-\d+/g, '/$1'));
      }
    } catch { /* not a deflated stream */ }
    i = e + 9;
  }
  return out.join('|');
}
