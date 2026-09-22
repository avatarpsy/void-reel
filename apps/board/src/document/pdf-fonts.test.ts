/**
 * THE TEST THAT WAS MISSING, AND THE BUG IT WOULD HAVE CAUGHT.
 *
 * ── WHY EVERY OTHER TEST PASSED WHILE EXPORTS WERE BLANK ────────────────────
 * The suite has no network, so `loadDocumentFonts` never fetched anything, fell
 * back to the base-14 faces and produced a perfectly good PDF. The path that
 * actually runs in a browser — fetch a web font, embed it, subset it — was
 * therefore NEVER executed by a test. In production every exported document
 * came out with its text positioned correctly, extractable by a parser, and
 * INVISIBLE on the page.
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────
 * The faces were imported as `.woff2`. WOFF2 does not merely compress an sfnt:
 * it TRANSFORMS the `glyf` and `loca` tables into a different representation.
 * `@pdf-lib/fontkit` reads the metrics tables fine — which is why every advance
 * width was right and the text sat in exactly the correct place — and does not
 * reverse that transform, so the outlines it handed to the subsetter were
 * nonsense. For the string "Hello world" it produced a 21,874-byte glyf table
 * (the whole untransformed blob) where the same face as `.woff` produced 864
 * bytes of real subset.
 *
 * ── WHAT IS ASSERTED, AND WHY IT IS NOT "THE FILE IS BIG ENOUGH" ────────────
 * A blank page and a correct page differ by whether the glyph outlines are
 * real, and the sharpest available statement of that is INTERNAL CONSISTENCY:
 * in a valid TrueType the final `loca` offset is exactly the length of `glyf`.
 * The woff2 subsets failed that by a factor of twenty. Checking it needs no
 * rasteriser and cannot pass by accident.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

import { renderDocument } from './index';

const NL = String.fromCharCode(10);
const ROOT = 'G:/Projects/Voidspace-Root/openreel-video/node_modules/.pnpm';
const realFetch = globalThis.fetch;

const FONT_DIRS = [
  `${ROOT}/@fontsource+noto-serif@5.3.0/node_modules/@fontsource/noto-serif/files`,
  `${ROOT}/@fontsource+noto-sans@5.3.0/node_modules/@fontsource/noto-sans/files`,
];

const served: string[] = [];

/**
 * `?url` imports resolve to a path in vitest, so this maps whatever the loader
 * asks for onto the matching file in node_modules. A file that is not there
 * answers 404 and the loader falls back exactly as it does offline, which keeps
 * the test honest instead of silently vacuous — `servedRealFonts` below is the
 * guard that it did not.
 */
function serveFontsFromDisk(): void {
  globalThis.fetch = (async (input: any) => {
    const name = String(input?.url ?? input).split(/[\\/]/).pop() ?? '';
    for (const dir of FONT_DIRS) {
      const path = `${dir}/${name}`;
      if (existsSync(path)) {
        served.push(name);
        return new Response(readFileSync(path), { status: 200 });
      }
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

const SOURCE = [
  '# Certificate of Internship',
  '',
  'This is to certify that **Nalamasa Dinesh** completed an internship with',
  '**Voidspace AI** from **17 June 2026** to **29 August 2026**.',
  '',
  'A second paragraph of ordinary prose, long enough that the document uses its',
  'faces properly rather than drawing three words and stopping.',
].join(NL);

let pdf: Buffer;

beforeAll(async () => {
  serveFontsFromDisk();
  const out: any = await renderDocument({ markdown: SOURCE, title: 'Certificate' }, 'pdf');
  pdf = Buffer.from(await out.blob.arrayBuffer());
}, 180_000);

afterAll(() => { globalThis.fetch = realFetch; });

/* ── reading the embedded font programs back out ───────────────────────────── */

/** Every font program in the file, decompressed. */
function embeddedPrograms(file: Buffer): Buffer[] {
  const text = file.toString('latin1');
  const out: Buffer[] = [];
  let i = 0;
  while (true) {
    const s = text.indexOf('stream', i);
    if (s < 0) break;
    let start = s + 6;
    if (file[start] === 13) start++;
    if (file[start] === 10) start++;
    const e = text.indexOf('endstream', start);
    if (e < 0) break;
    let body = file.subarray(start, e);
    try { body = inflateSync(body); } catch { /* not deflated */ }
    // An sfnt begins with 0x00010000 or the tag `true`/`OTTO`.
    const magic = body.subarray(0, 4).toString('latin1');
    if (magic === 'true' || magic === 'OTTO' || body.readUInt32BE(0) === 0x00010000) {
      out.push(body);
    }
    i = e + 9;
  }
  return out;
}

/** The sfnt table directory: tag → { offset, length }. */
function tablesOf(program: Buffer): Record<string, { at: number; length: number }> {
  const tables: Record<string, { at: number; length: number }> = {};
  const count = program.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    if (at + 16 > program.length) break;
    const tag = program.subarray(at, at + 4).toString('latin1');
    tables[tag] = { at: program.readUInt32BE(at + 8), length: program.readUInt32BE(at + 12) };
  }
  return tables;
}

describe('the fonts a real export embeds', () => {
  it('really loaded them, rather than falling back to the base-14', () => {
    // Without this the whole file could pass while testing nothing.
    expect(served.length, 'the stub should have served font files').toBeGreaterThan(0);
    expect(embeddedPrograms(pdf).length, 'an embedded program').toBeGreaterThan(0);
  });

  /**
   * THE ASSERTION THAT CATCHES A BLANK PAGE.
   *
   * In a valid TrueType the last `loca` entry is the length of `glyf`. A woff2
   * whose transform was never reversed fails this by a factor of twenty — the
   * glyf table is the whole original blob and loca describes a handful of
   * glyphs — and that mismatch is exactly why nothing draws.
   */
  it('embeds glyph outlines that agree with their offsets', () => {
    const programs = embeddedPrograms(pdf);
    for (const program of programs) {
      const tables = tablesOf(program);
      const glyf = tables.glyf;
      const loca = tables.loca;
      const head = tables.head;
      if (!glyf || !loca || !head) continue; // a CFF face has neither

      // `indexToLocFormat` lives at offset 50 of head: 0 short, 1 long.
      const longFormat = program.readInt16BE(head.at + 50) === 1;
      const last = longFormat
        ? program.readUInt32BE(loca.at + loca.length - 4)
        : program.readUInt16BE(loca.at + loca.length - 2) * 2;

      expect(last, 'the last loca offset must be the length of glyf').toBe(glyf.length);
    }
  });

  /**
   * And the size, which is the symptom anybody would notice first: a real
   * subset of a few dozen glyphs is small. The broken path produced a 30KB file
   * for three lines of text, all of it an untransformed font blob.
   */
  it('produces a small file for a small document', () => {
    expect(pdf.length).toBeLessThan(20_000);
  });

  it('draws with the embedded faces, not with Times', () => {
    /**
     * The font names live inside OBJECT STREAMS, which are compressed, so the
     * raw file does not contain them as text — an earlier version of this
     * assertion looked at the bytes and failed on a perfectly good document.
     */
    const names = new Set<string>();
    const text = pdf.toString('latin1');
    let i = 0;
    while (true) {
      const s = text.indexOf('stream', i);
      if (s < 0) break;
      let start = s + 6;
      if (pdf[start] === 13) start++;
      if (pdf[start] === 10) start++;
      const e = text.indexOf('endstream', start);
      if (e < 0) break;
      try {
        const body = inflateSync(pdf.subarray(start, e)).toString('latin1');
        for (const m of body.matchAll(/\/([A-Za-z]+)-[A-Za-z]+-\d+/g)) names.add(m[1]!);
      } catch { /* not a deflated stream */ }
      i = e + 9;
    }
    expect([...names].join(','), 'the faces actually used').toMatch(/Noto/);
  });
});

describe('the source files', () => {
  /**
   * WOFF2 must not come back. It is the obvious thing to reach for — smaller,
   * and the format every web page uses — and it silently produces a document
   * whose text cannot be seen.
   */
  it('imports no .woff2, because pdf-lib cannot use it', () => {
    const source = readFileSync(`${__dirname}/fonts.ts`, 'utf8');
    expect(source).not.toMatch(/\.woff2/);
    expect(source).toMatch(/\.woff\?url/);
  });
});
