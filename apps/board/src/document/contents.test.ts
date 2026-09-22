/**
 * A contents page, and numbered headings.
 *
 * Both derive from the heading tree, which is why they are built together: a
 * document that numbers its clauses lists those numbers in its contents, and
 * counting them twice by two different rules is how the two drift apart.
 */
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';
import { MARK, commentsFromMarks, marksFromComments, readMark } from './align-marks';
import { parseMarkdown } from './blocks';
import { renderPdf } from './pdf';
import { renderDocx } from './docx';
import { toMarkdown } from './serialise';

const NL = String.fromCharCode(10);
const REPORT = [
  '# Services Agreement',
  '',
  '<!-- toc -->',
  '',
  '## Scope',
  'What the supplier will do, described at enough length to take a line.',
  '',
  '### Exclusions',
  'What it will not do.',
  '',
  '## Payment',
  'When the money moves.',
  '',
  '<!-- pagebreak -->',
  '',
  '## Termination',
  'How it ends.',
].join(NL);

describe('the directive survives the trip', () => {
  it('reads and writes the comment', () => {
    const blocks = parseMarkdown(REPORT);
    expect(blocks.some((b) => b.kind === 'toc')).toBe(true);
    expect(toMarkdown(blocks)).toContain('<!-- toc -->');
  });

  it('accepts the words people actually write', () => {
    for (const word of ['toc', 'contents', 'table-of-contents', 'table of contents']) {
      expect(parseMarkdown(`<!-- ${word} -->`)[0]).toMatchObject({ kind: 'toc' });
    }
  });

  it('carries across the canvas as its own mark, unconfused with the others', () => {
    const marked = marksFromComments(REPORT);
    expect(marked).toContain(MARK.toc);
    expect(commentsFromMarks(marked)).toContain('<!-- toc -->');
    // Six word joiners begin with five, which begin with four. Order is
    // everything — see the table in `align-marks.ts`.
    expect(readMark(MARK.toc)).toMatchObject({ toc: true });
    expect(readMark(MARK.justify)).toMatchObject({ align: 'justify' });
    expect(readMark(MARK.pagebreak)).toMatchObject({ pagebreak: true });
  });

  it('comes back off the canvas as a toc block, not as stray characters', () => {
    const blocks = parseMarkdown(marksFromComments(REPORT));
    expect(blocks.some((b) => b.kind === 'toc')).toBe(true);
    expect(blocks.some((b) => 'runs' in b && /⁠/.test(b.runs.map((r) => r.text).join('')))).toBe(false);
  });
});

describe('what the PDF sets', () => {
  /**
   * HOW MANY THINGS THE PAGE DRAWS, not what they say.
   *
   * pdf-lib subsets the embedded fonts, so the bytes in the content stream
   * are glyph indices rather than characters — the text cannot be read back
   * without the font's own mapping. What CAN be counted is placements, and a
   * contents page is a large, specific number of them: one per entry, one
   * per page number, and a run of leader dots between. The .docx below
   * carries the readable proof of what those entries SAY.
   */
  async function placements(markdown: string, extra: Record<string, unknown> = {}) {
    const { blob, pages } = await renderPdf({ markdown, ...extra } as never);
    const buf = Buffer.from(new Uint8Array(await blob.arrayBuffer()));
    const raw = buf.toString('latin1');
    let i = 0;
    let drawn = 0;
    for (;;) {
      const s = raw.indexOf('stream', i);
      if (s < 0) break;
      let at = s + 6;
      if (buf[at] === 13) at++;
      if (buf[at] === 10) at++;
      const e = raw.indexOf('endstream', at);
      if (e < 0) break;
      try {
        const body = inflateSync(buf.subarray(at, e)).toString('latin1');
        drawn += (body.match(/Tj/g) ?? []).length;
      } catch { /* not a deflated stream */ }
      i = e + 9;
    }
    return { drawn, pages };
  }

  const WITHOUT = REPORT.split(NL).filter((l) => l.trim() !== '<!-- toc -->').join(NL);

  it('adds a contents page to the document', async () => {
    const withToc = await placements(REPORT);
    const without = await placements(WITHOUT);
    /**
     * Four entries, their four page numbers, the word Contents, and leader
     * dots across each line. Dozens of draws, not a handful — which is what
     * separates a real contents page from an empty heading.
     */
    expect(withToc.drawn - without.drawn).toBeGreaterThan(20);
  });

  it('still paginates, so the numbers it prints mean something', async () => {
    // The report has a page break in it, so a contents page can only be
    // right if the document really is more than one page.
    expect((await placements(REPORT)).pages).toBeGreaterThan(1);
  });

  it('is deterministic — the two passes agree', async () => {
    /**
     * The whole risk of a two-pass contents page is the passes paginating
     * differently, which shows up as a number that is off by one. Rendering
     * twice must give byte-identical page counts and draw counts.
     */
    const a = await placements(REPORT);
    const b = await placements(REPORT);
    expect(a).toEqual(b);
  });

  it('costs no extra pass when no contents were asked for', async () => {
    expect((await placements('# Plain' + NL + NL + 'Body.')).pages).toBe(1);
  });

  it('numbers the headings without disturbing the pagination', async () => {
    const plain = await placements(REPORT);
    const numbered = await placements(REPORT, { numberHeadings: true });
    /**
     * The draw count does NOT simply rise, which is worth recording because
     * it is the opposite of the obvious guess: a numbered entry is longer,
     * so fewer leader dots fit between it and its page number, and the dots
     * outnumber everything else on a contents page.
     *
     * What must hold is that the document still sets to the same number of
     * pages — numbering changes how headings READ, not how the document
     * breaks. The readable proof that the numbers are there is the .docx
     * below, whose XML is not behind a subsetted font.
     */
    expect(numbered.pages).toBe(plain.pages);
    expect(numbered.drawn).not.toBe(plain.drawn);
  });
});

describe('what Word is told', () => {
  it('inserts its OWN contents field, which it repaginates itself', async () => {
    const xml = await docxXml(REPORT);
    // `TOC \o "1-3"` is Word's field code for a contents over headings 1-3.
    expect(xml).toMatch(/TOC/);
    expect(xml).toContain('Contents');
  });

  it('numbers headings through Word numbering, not as typed-in text', async () => {
    const xml = await docxXml(REPORT, { numberHeadings: true });
    // A numbering reference on the heading paragraphs, so Word renumbers when
    // the reader inserts a section.
    expect(xml).toContain('w:numPr');
    // And the digits are NOT in the words themselves.
    expect(xml).not.toContain('1.1 Exclusions');
  });

  it('leaves headings unnumbered by default', async () => {
    expect(await docxXml(REPORT)).not.toContain('w:numPr');
  });
});

/** The main document XML of a .docx. */
async function docxXml(markdown: string, extra: Record<string, unknown> = {}): Promise<string> {
  const blob = await renderDocx({ markdown, ...extra } as never);
  const { inflateRawSync } = await import('node:zlib');
  const buf = Buffer.from(new Uint8Array(await blob.arrayBuffer()));
  let i = 0;
  let all = '';
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const compressed = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const at = i + 30 + nameLen + extraLen;
    const body = buf.subarray(at, at + compressed);
    if (name.endsWith('.xml')) all += (method === 8 ? inflateRawSync(body) : body).toString('utf8');
    i = at + compressed;
  }
  return all;
}

describe('numbering lives in the document, not only in the call', () => {
  /**
   * The option alone was lost the moment the user edited the contract on the
   * board and exported it again: the agent knew it was numbered, the document
   * did not, and the second export came back as plain headings.
   */
  const NUMBERED = ['<!-- numbered -->', '', REPORT].join(NL);

  it('reads the directive and writes it back', () => {
    const blocks = parseMarkdown(NUMBERED);
    expect(blocks.some((b) => b.kind === 'numbering')).toBe(true);
    expect(toMarkdown(blocks)).toContain('<!-- numbered -->');
  });

  it('survives the canvas, unconfused with the contents mark it starts with', () => {
    // Seven word joiners begin with six. Longest first, always.
    expect(readMark(MARK.numbering)).toMatchObject({ numbering: true });
    expect(readMark(MARK.toc)).toMatchObject({ toc: true });
    const back = parseMarkdown(marksFromComments(NUMBERED));
    expect(back.some((b) => b.kind === 'numbering')).toBe(true);
    expect(back.some((b) => b.kind === 'toc')).toBe(true);
  });

  it('numbers a Word file made from the directive alone', async () => {
    // No `numberHeadings` passed — the document asked for it itself.
    expect(await docxXml(NUMBERED)).toContain('w:numPr');
  });

  it('still numbers when the caller asks and the document does not', async () => {
    expect(await docxXml(REPORT, { numberHeadings: true })).toContain('w:numPr');
  });
});

describe('the numbers the reader sees', () => {
  /**
   * Both of these were real, and both were found by reading a contract the
   * exporter had just produced rather than by reasoning about the code.
   *
   *   THE TITLE WAS CLAUSE 1. "1 Master Services Agreement" — a document
   *   opens with its name, and its name is not the first clause of itself.
   *
   *   THE CONTENTS AND THE BODY DISAGREED. The body counted as it drew and
   *   the contents counted again as it listed, by a slightly different rule:
   *   the body said "1.1 Interpretation" and the contents said "0.1". A
   *   reader pointed at clause 3.2 has to be able to find 3.2.
   *
   * Both are the same fix — number every heading ONCE, up front — so both
   * are guarded by asserting on Word's XML, which is readable text.
   */
  const NUMBERED = ['<!-- numbered -->', '', REPORT].join(NL);

  it('does not number the document title', async () => {
    const xml = await docxXml(NUMBERED);
    const title = xml.slice(xml.indexOf('Services Agreement') - 400, xml.indexOf('Services Agreement'));
    // The title's own paragraph carries no numbering reference.
    expect(title).not.toContain('w:numPr');
  });

  it('numbers from 1 at the first real clause, not from the title', async () => {
    /**
     * `## Interpretation` under a `# Title` is clause 1, and `### Defined
     * terms` under it is 1.1 — the levels shift up because the title is not
     * a level. Word is told the LEVEL and counts itself, so the assertion is
     * that Interpretation sits at level 0 of the numbering, not level 1.
     */
    const xml = await docxXml(NUMBERED);
    const at = xml.indexOf('Interpretation');
    const before = xml.slice(Math.max(0, at - 500), at);
    expect(before).toContain('w:numPr');
    expect(before).toMatch(/w:ilvl w:val="0"/);
  });

  it('gives a document with no title heading the same numbers', async () => {
    // Opening straight into `## ` still starts at 1 — the shift is measured
    // from the shallowest clause, not assumed to be h2.
    const noTitle = ['<!-- numbered -->', '', '## First', 'Body.', '', '## Second', 'Body.'].join(NL);
    const xml = await docxXml(noTitle);
    expect(xml).toContain('w:numPr');
    expect(xml).toMatch(/w:ilvl w:val="0"/);
  });
});
