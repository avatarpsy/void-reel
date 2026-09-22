/**
 * What is actually INSIDE the .docx.
 *
 * ── WHY THIS UNZIPS THE FILE ────────────────────────────────────────────────
 * Every other assertion about the Word writer is that it produced some bytes,
 * which it does just as happily when it has dropped half the formatting. The
 * hard break was missing for as long as this feature has existed and nothing
 * said so: the block model had it, the PDF set it, and Word silently ignored
 * the newline because a run cannot contain one. It was found by unzipping a
 * file and looking for `<w:br/>`.
 *
 * So these read the XML. They are deliberately about the PRESENCE of the
 * markup, not its exact spelling — `docx` is free to reorder attributes, and a
 * test that pins the whole string would fail on every upgrade while catching
 * nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { renderDocument } from './index';

const NL = String.fromCharCode(10);

const SOURCE = [
  '# Fidelity',
  '',
  'Voidspace Technologies  ',
  '9/3/448 Rezimental Bazaar  ',
  'Secunderabad',
  '',
  'Plain, **bold**, *italic*, ++underlined++, ==highlighted==, ~~struck~~ and',
  '[a 20pt line in blue]{color=#1a56db size=20}.',
  '',
  '<!-- align:center -->',
  'A centred line.',
  '',
  '<!-- columns: 4,1 -->',
  '| Description | Amount |',
  '| :--- | ---: |',
  '| A line item | 1,200.00 |',
  '',
  '<!-- space: 72 -->',
  '',
  '<!-- pagebreak -->',
  '',
  'Page two.',
].join(NL);

/**
 * A .docx is a zip, and this reads one without a dependency.
 *
 * Adding jszip to the board's bundle so that a TEST can look inside a file
 * would be the wrong trade — every user would download it. The local file
 * header is enough: name, method, sizes, then the bytes.
 */
async function unzip(bytes: Uint8Array): Promise<Record<string, string>> {
  const { inflateRawSync } = await import('node:zlib');
  const buf = Buffer.from(bytes);
  const out: Record<string, string> = {};
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const compressed = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    const body = buf.subarray(start, start + compressed);
    if (name.endsWith('.xml')) {
      out[name] = (method === 8 ? inflateRawSync(body) : body).toString('utf8');
    }
    i = start + compressed;
  }
  return out;
}

let parts: Record<string, string> = {};

beforeAll(async () => {
  const out: any = await renderDocument({
    markdown: SOURCE,
    title: 'Fidelity',
    header: 'Voidspace',
    footer: 'Page {page} of {pages}',
    orientation: 'landscape',
  }, 'docx');
  parts = await unzip(new Uint8Array(await out.blob.arrayBuffer()));
}, 120_000);

const body = () => parts['word/document.xml'] ?? '';

describe('the runs', () => {
  it('carries bold, italic, strike and underline', () => {
    for (const tag of ['<w:b', '<w:i', '<w:strike', '<w:u ']) expect(body()).toContain(tag);
  });

  it('carries a colour, without the hash Word rejects', () => {
    expect(body()).toContain('<w:color w:val="1A56DB"');
    expect(body()).not.toContain('#1A56DB');
  });

  /** HALF-POINTS: a 20pt run is 40, and passing 20 would silently set 10pt. */
  it('carries a size in half-points', () => {
    expect(body()).toContain('<w:sz w:val="40"');
  });

  it('carries a highlight as cell shading', () => {
    expect(body()).toContain('<w:shd');
  });

  /** THE ONE THAT WAS MISSING. An address block was welded into one line. */
  it('carries a hard break', () => {
    expect(body()).toContain('<w:br/>');
  });
});

describe('the page', () => {
  it('carries a page break', () => {
    expect(body()).toContain('w:type="page"');
  });

  it('carries the deliberate space, in twentieths of a point', () => {
    expect(body()).toContain('w:after="1440"'); // 72pt
  });

  it('is landscape', () => {
    expect(body()).toMatch(/w:orient="landscape"/);
  });

  it('has a real header and footer part, not text in the body', () => {
    expect(parts['word/header1.xml']).toBeTruthy();
    expect(parts['word/footer1.xml']).toBeTruthy();
    expect(body()).toContain('headerReference');
    expect(body()).toContain('footerReference');
  });

  /**
   * The page number has to be a FIELD. Written as text it would say "Page 1 of
   * 2" on both pages, which is worse than not having it.
   */
  it('numbers pages with fields Word evaluates', () => {
    const footer = parts['word/footer1.xml'] ?? '';
    expect(footer).toContain('PAGE');
    expect(footer).toContain('NUMPAGES');
  });
});

describe('the table', () => {
  it('sets column widths as percentages under a fixed layout', () => {
    expect(body()).toContain('w:type="pct"');
    expect(body()).toContain('<w:tblLayout');
  });

  it('repeats the header row when the table spans a page', () => {
    expect(body()).toContain('<w:tblHeader');
  });

  it('right-aligns the column the markdown right-aligned', () => {
    expect(body()).toContain('w:val="right"');
  });
});
