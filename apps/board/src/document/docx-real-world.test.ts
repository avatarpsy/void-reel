/**
 * What REAL Word files taught this importer.
 *
 * ── WHY THESE ARE SEPARATE FROM docx-import.test.ts ─────────────────────────
 * That file round-trips our own writer, which proves the reader understands
 * what we emit. It cannot catch what Word itself does differently, and Word
 * does several things differently in ways that are invisible until a real
 * document goes through:
 *
 *   - `w:sz` on nearly EVERY run, not only on the ones that override anything
 *   - `Voidspace AI` written as three runs: word, space, word
 *   - a line break as the last thing in a paragraph, used for spacing
 *   - `mc:Fallback`, which repeats content for older readers
 *
 * Each was found by importing a genuine offer letter and reading the markdown
 * that came out. Each is reproduced below as the minimal OOXML that causes it,
 * so the fix has a test that does not depend on a file nobody else has.
 */
import { describe, it, expect } from 'vitest';

import { importDocx } from './docx-import';
import { toMarkdown } from './serialise';

const NL = String.fromCharCode(10);

/* ── the smallest .docx that is still a .docx ──────────────────────────────── */

/** Deflate-free zip: stored entries, so the fixture is readable in the source. */
function makeZip(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();
  const crc32 = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    chunks.push(local);

    const entry = new Uint8Array(46 + nameBytes.length);
    const ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true);
    ev.setUint16(6, 20, true);
    ev.setUint16(10, 0, true);
    ev.setUint32(16, crc, true);
    ev.setUint32(20, data.length, true);
    ev.setUint32(24, data.length, true);
    ev.setUint16(28, nameBytes.length, true);
    ev.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);

    offset += local.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, central.length, true);
  endView.setUint16(10, central.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of all) { out.set(chunk, at); at += chunk.length; }
  return out;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function docx(body: string, extra: Record<string, string> = {}): Uint8Array {
  return makeZip({
    'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    ...extra,
  });
}

/** A styles part that says the document's body is 11pt (22 half-points). */
const STYLES_11PT = `<?xml version="1.0"?><w:styles ${W}>`
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>'
  + '</w:styles>';

const textOf = (blocks: any[]) =>
  blocks.flatMap((b) => b.runs ?? []).map((r: any) => r.text).join('');

describe('what Word actually writes', () => {
  /**
   * `w:sz` appears on nearly every run. Reading each as an override turned a
   * real document into `[A: The philosophy…]{size=12}` on every paragraph.
   */
  it('ignores a size that is the document own default', async () => {
    const { blocks } = await importDocx(docx(
      '<w:p><w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t>Ordinary body text.</w:t></w:r></w:p>',
      { 'word/styles.xml': STYLES_11PT },
    ));
    expect((blocks[0] as any).runs[0].size).toBeUndefined();
  });

  it('keeps a size that really does override it', async () => {
    const { blocks } = await importDocx(docx(
      '<w:p><w:r><w:rPr><w:sz w:val="48"/></w:rPr><w:t>A big name.</w:t></w:r></w:p>',
      { 'word/styles.xml': STYLES_11PT },
    ));
    expect((blocks[0] as any).runs[0].size).toBe(24);
  });

  /**
   * Word splits a phrase across runs at its spaces. Treating the space as its
   * own thing produced `[**Voidspace**]{size=14} [**AI**]{size=14}` — two spans
   * where the file has one phrase.
   */
  it('does not split a phrase in two at the space inside it', async () => {
    const { blocks } = await importDocx(docx(
      '<w:p>'
      + '<w:r><w:rPr><w:b/></w:rPr><w:t>Voidspace</w:t></w:r>'
      + '<w:r><w:t xml:space="preserve"> </w:t></w:r>'
      + '<w:r><w:rPr><w:b/></w:rPr><w:t>AI</w:t></w:r>'
      + '</w:p>',
    ));
    const runs = (blocks[0] as any).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ text: 'Voidspace AI', bold: true });
    expect(toMarkdown(blocks)).toContain('**Voidspace AI**');
  });

  /** A trailing break is Word spacing a paragraph, not a line break. */
  it('drops a line break at the end of a paragraph', async () => {
    const { blocks } = await importDocx(docx(
      '<w:p><w:r><w:t>21 October 2024.</w:t><w:br/></w:r></w:p>',
    ));
    expect(textOf(blocks)).toBe('21 October 2024.');
    expect(toMarkdown(blocks)).not.toMatch(/\\\s*$/m);
  });

  it('keeps a line break in the MIDDLE, which is an address block', async () => {
    const { blocks } = await importDocx(docx(
      '<w:p><w:r><w:t>Voidspace AI</w:t><w:br/><w:t>Secunderabad</w:t></w:r></w:p>',
    ));
    expect(textOf(blocks)).toBe('Voidspace AI' + NL + 'Secunderabad');
  });

  /**
   * `mc:Fallback` repeats its sibling's content for readers that cannot do the
   * modern markup. Counting both gave a real letterhead's footer its address
   * and email twice.
   */
  it('does not read an mc:Fallback as a second copy', async () => {
    const footer = `<?xml version="1.0"?><w:ftr ${W} `
      + 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
      + '<w:p><mc:AlternateContent>'
      + '<mc:Choice Requires="wps"><w:r><w:t>Secunderabad</w:t></w:r></mc:Choice>'
      + '<mc:Fallback><w:r><w:t>Secunderabad</w:t></w:r></mc:Fallback>'
      + '</mc:AlternateContent></w:p></w:ftr>';
    const { spec } = await importDocx(docx(
      '<w:p><w:r><w:t>Body.</w:t></w:r></w:p>',
      { 'word/footer1.xml': footer },
    ));
    expect(spec.footer).toBe('Secunderabad');
  });

  /** A toggle can be switched OFF, and reading presence alone bolds everything. */
  it('honours a property that is explicitly turned off', async () => {
    const { blocks } = await importDocx(docx(
      '<w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>Not bold.</w:t></w:r></w:p>',
    ));
    expect((blocks[0] as any).runs[0].bold).toBeUndefined();
  });

  it('reads a page break written as a run break', async () => {
    const { blocks } = await importDocx(docx(
      '<w:p><w:r><w:t>One.</w:t></w:r></w:p>'
      + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
      + '<w:p><w:r><w:t>Two.</w:t></w:r></w:p>',
    ));
    expect(blocks.map((b) => b.kind)).toEqual(['para', 'pagebreak', 'para']);
  });

  /** An empty paragraph is spacing; a RUN of them is a deliberate gap. */
  it('reads a run of empty paragraphs as measured space, and one as nothing', async () => {
    const one = await importDocx(docx(
      '<w:p><w:r><w:t>A.</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>B.</w:t></w:r></w:p>',
    ));
    expect(one.blocks.map((b) => b.kind)).toEqual(['para', 'para']);

    const many = await importDocx(docx(
      '<w:p><w:r><w:t>A.</w:t></w:r></w:p><w:p/><w:p/><w:p/><w:p><w:r><w:t>B.</w:t></w:r></w:p>',
    ));
    expect(many.blocks.map((b) => b.kind)).toEqual(['para', 'space', 'para']);
  });

  it('reads a heading from its style, however the style is spelled', async () => {
    for (const style of ['Heading1', 'heading 1', 'Title']) {
      const { blocks } = await importDocx(docx(
        `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>A title</w:t></w:r></w:p>`,
      ));
      expect(blocks[0], style).toMatchObject({ kind: 'heading', level: 1 });
    }
  });
});
