/**
 * Footnotes.
 *
 * The one feature in this exporter that reads BACKWARDS: the mark is in the
 * middle of a page and its text belongs at the foot of that SAME page, so the
 * room has to be taken before the line carrying the mark is set. Word does
 * this itself and is four lines of code; the PDF is where it can go wrong, so
 * that is where the measurements are.
 *
 * What is asserted, and why each one earns its place:
 *
 *   THE NOTE IS AT THE FOOT. Not "a note block exists" — its words are drawn
 *   near the bottom margin, which is the only thing that makes it a footnote
 *   rather than a trailing paragraph.
 *
 *   THE NOTE IS ON THE MARK'S PAGE. The classic break: the body is set, the
 *   page fills, and the note lands overleaf pointing back at a mark the
 *   reader has already passed.
 *
 *   THE BODY GAVE UP THE ROOM. A page carrying a note holds less text than
 *   the same page without one. If that is not true the note was drawn OVER
 *   the last lines of the body, which looks like a rendering fault rather
 *   than a layout one.
 */
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';
import { makeTestBoard } from '../blocksuite/test-board';
import { noteToMarkdown, placeMarkdownDocument } from './note-io';
import { parseMarkdown } from './blocks';
import { renderPdf } from './pdf';
import { renderDocx } from './docx';
import { toMarkdown } from './serialise';

const NL = String.fromCharCode(10);
const lines = (...l: string[]) => l.join(NL);

const CONTRACT = lines(
  'The rate is fixed for the term.[^rate]',
  '',
  'Either party may terminate on notice.[^notice]',
  '',
  '[^rate]: Clause 4.2 of the **master** agreement.',
  '[^notice]: Ninety days, in writing.',
);

describe('what the markdown means', () => {
  it('reads a reference and its definition as one thing', () => {
    const blocks = parseMarkdown(CONTRACT);
    // Two paragraphs — the definitions are NOT body text.
    expect(blocks.filter((b) => b.kind === 'para')).toHaveLength(2);
    const marks = blocks.flatMap((b) => ('runs' in b ? b.runs : [])).filter((r) => r.footnote);
    expect(marks).toHaveLength(2);
    expect(marks[0]!.footnote!.map((r) => r.text).join('')).toBe('Clause 4.2 of the master agreement.');
  });

  it('numbers them in reading order, whatever the author labelled them', () => {
    // `[^rate]` and `[^notice]` are names, not numbers. The reader sees 1, 2.
    const marks = parseMarkdown(CONTRACT)
      .flatMap((b) => ('runs' in b ? b.runs : [])).filter((r) => r.footnote);
    expect(marks.map((r) => r.text)).toEqual(['1', '2']);
  });

  it('numbers by where the mark is, not by where the definition is', () => {
    const backwards = lines(
      'Second mark.[^b] ',
      '',
      'Wait — first mark was above.[^a]',
      '',
      '[^a]: defined first',
      '[^b]: defined second',
    );
    const marks = parseMarkdown(backwards)
      .flatMap((b) => ('runs' in b ? b.runs : [])).filter((r) => r.footnote);
    expect(marks.map((r) => r.footnote!.map((x) => x.text).join(''))).toEqual([
      'defined second', 'defined first',
    ]);
  });

  it('keeps the note\'s own formatting', () => {
    const [, bold] = parseMarkdown(CONTRACT)
      .flatMap((b) => ('runs' in b ? b.runs : []))
      .find((r) => r.footnote)!.footnote!;
    expect(bold).toMatchObject({ text: 'master', bold: true });
  });

  /**
   * THE CONSERVATIVE READING, BOTH WAYS. A bracket is not a promise: a
   * reference nothing defines, and a definition nothing references, are both
   * left on the page as the characters the author typed. The alternative —
   * guessing — either prints a number pointing at nothing or silently deletes
   * a line of somebody's document.
   */
  it('leaves a reference with no definition as plain text', () => {
    const blocks = parseMarkdown('Text[^9] here.');
    expect(blocks[0]).toMatchObject({ kind: 'para' });
    expect((blocks[0] as any).runs[0].text).toBe('Text[^9] here.');
  });

  it('leaves a definition nobody references in the body', () => {
    const blocks = parseMarkdown(lines('Body.', '', '[^x]: nobody cites this'));
    expect(blocks).toHaveLength(2);
    expect((blocks[1] as any).runs[0].text).toContain('[^x]: nobody cites this');
  });

  it('costs nothing to parse a document with no footnotes in it', () => {
    // The whole lifting pass is skipped on the `[^` test — most documents.
    expect(parseMarkdown(lines('# Title', '', 'Body.'))).toHaveLength(2);
  });
});

describe('the round trip', () => {
  /**
   * The document is also an editable page on the board, and it goes
   * markdown -> BlockSuite -> markdown whenever anyone touches it. The
   * references and the definitions are ordinary characters, so they survive
   * that trip as themselves — which is also why they are visible and
   * editable rather than hidden behind a carrier mark like alignment.
   */
  it('writes the reference where the mark was, and the notes at the foot', () => {
    const md = toMarkdown(parseMarkdown(CONTRACT));
    expect(md).toContain('The rate is fixed for the term.[^1]');
    expect(md).toContain('[^1]: Clause 4.2 of the **master** agreement.');
    expect(md).toContain('[^2]: Ninety days, in writing.');
    // The note's words appear ONCE — at its definition, not at the reference.
    expect(md.match(/Ninety days/g)).toHaveLength(1);
  });

  it('survives being read back and written again unchanged', () => {
    const once = toMarkdown(parseMarkdown(CONTRACT));
    expect(toMarkdown(parseMarkdown(once))).toBe(once);
  });
});

describe('onto the canvas and back', () => {
  /**
   * ── THE TRIP THAT NEARLY LOST THEM ────────────────────────────────────────
   *
   * BlockSuite's markdown adapter knows the footnote syntax and has its own
   * plans for it. Handed the contract above, a real note gave back:
   *
   *     The rate is fixed for the term.
   *
   *     ###### Sources
   *     Clause 4.2 of the master agreement.
   *
   * The marks gone, the notes rewritten as a heading nobody asked for, and
   * no error anywhere — the document simply stopped having footnotes the
   * first time it was opened on the board. This runs against a real
   * BlockStdScope, because that is the only place the fault was visible.
   */
  it('comes back with every mark and every note intact', async () => {
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(board as any, toMarkdown(parseMarkdown(CONTRACT)));
    const back = await noteToMarkdown(board as any, noteId);

    expect(back).toContain('The rate is fixed for the term.[^1]');
    expect(back).toContain('[^1]: Clause 4.2 of the **master** agreement.');
    expect(back).toContain('[^2]: Ninety days, in writing.');
    // Not the adapter's idea of what a footnote is for.
    expect(back).not.toContain('Sources');
    // And no carrier character is left in what the user downloads.
    expect(back).not.toContain(String.fromCharCode(0x2060));
    // The bracket is not escaped, which would stop it parsing as a footnote.
    expect(back).not.toContain('\\[^');

    // It still MEANS the same thing, which is the point of keeping the text.
    const marks = parseMarkdown(back)
      .flatMap((b) => ('runs' in b ? b.runs : [])).filter((r) => r.footnote);
    expect(marks.map((r) => r.footnote!.map((x) => x.text).join(''))).toEqual([
      'Clause 4.2 of the master agreement.', 'Ninety days, in writing.',
    ]);
  });

  it('gives each note its own block, however the file was written', async () => {
    /**
     * SEEN ON THE BOARD, not deduced. A file whose definitions sit on
     * adjacent lines — which markdown allows and most people write — arrived
     * as ONE paragraph holding both notes: two things the user could not
     * move, reorder or delete separately, and which came back with a stray
     * hard break where the second label began.
     *
     * The markdown goes to the canvas AS WRITTEN, definitions and all,
     * because that is what keeps a note editable. So the splitting has to
     * happen on the way in.
     */
    const board = makeTestBoard();
    // Adjacent, the way the file was written — NOT via `toMarkdown`.
    const { noteId } = await placeMarkdownDocument(board as any, CONTRACT);
    const note: any = (board as any).store.getBlock(noteId)?.model;
    const holding = note.children
      .map((c: any) => String(c.text?.toString?.() ?? ''))
      .filter((t: string) => t.includes('^rate') || t.includes('^notice'));
    // Each definition is its own paragraph, and no paragraph holds two.
    expect(holding.length).toBeGreaterThanOrEqual(2);
    expect(holding.some((t: string) => t.includes('^rate') && t.includes('^notice'))).toBe(false);

    const back = await noteToMarkdown(board as any, noteId);
    // And no stray hard break ends up inside a note's words.
    const marks = parseMarkdown(back)
      .flatMap((b) => ('runs' in b ? b.runs : [])).filter((r) => r.footnote);
    expect(marks.map((r) => r.footnote!.map((x) => x.text).join(''))).toEqual([
      'Clause 4.2 of the master agreement.', 'Ninety days, in writing.',
    ]);
  });

  it('lets a person ADD a footnote by typing it on the canvas', async () => {
    /**
     * The shield is added on the way IN, so a footnote the user types has
     * never been through it — and the adapter escapes the bracket on the way
     * out regardless, which left `\[^3]`. The parser read that as a literal
     * bracket, so a footnote somebody had just written was not one. Receiving
     * a document with footnotes and being unable to add a seventh is exactly
     * the kind of half-feature that makes an editor feel like a viewer.
     */
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(board as any, 'Existing body.');
    // What typing does: characters straight into the paragraph's own text,
    // never through the markdown adapter and so never through the shield.
    const note: any = (board as any).store.getBlock(noteId)?.model;
    const type = (at: any, text: string) => at.text.insert(text, at.text.length);
    type(note.children[0], ' A point worth a note.[^a]');
    type(note.children[note.children.length - 1], NL + '[^a]: Typed by hand on the board.');

    const back = await noteToMarkdown(board as any, noteId);
    expect(back).not.toContain('\\[^');
    const marks = parseMarkdown(back)
      .flatMap((b) => ('runs' in b ? b.runs : [])).filter((r) => r.footnote);
    expect(marks.map((r) => r.footnote!.map((x) => x.text).join(''))).toEqual([
      'Typed by hand on the board.',
    ]);
  });

  it('keeps each note its own paragraph', async () => {
    /**
     * Written adjacent, two definitions are ONE markdown paragraph with a
     * line break in it — and they came back welded, the second label buried
     * mid-paragraph where nothing would read it as a definition again.
     */
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(board as any, toMarkdown(parseMarkdown(CONTRACT)));
    const back = await noteToMarkdown(board as any, noteId);
    // Each definition alone on its line, which is what makes it a definition.
    const defs = back.split(NL).filter((l) => l.startsWith('[^'));
    expect(defs).toHaveLength(2);
    expect(defs.every((l) => l.match(/\[\^/g)!.length === 1)).toBe(true);
    // A second pass changes nothing — the welding showed up on the SECOND trip.
    const again = toMarkdown(parseMarkdown(back));
    expect(toMarkdown(parseMarkdown(again))).toBe(again);
  });
});

describe('where the PDF puts them', () => {
  /**
   * Every text placement on every page, in page order. pdf-lib subsets the
   * fonts, so the bytes are glyph indices and the words cannot be read back —
   * but WHERE each one was placed is plain in the text matrix, and for a
   * footnote the position IS the feature.
   */
  async function placed(markdown: string): Promise<{ pages: Array<number[]>; count: number }> {
    const { blob } = await renderPdf({ markdown });
    const buf = Buffer.from(new Uint8Array(await blob.arrayBuffer()));
    const raw = buf.toString('latin1');
    const pages: Array<number[]> = [];
    let i = 0;
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
        /**
         * BELOW THE BOTTOM MARGIN IS NOT THE PAGE — it is the running footer
         * and the page number, which are drawn on every page of a document
         * longer than one. Left in, they ARE the lowest placement on every
         * page, and every measurement below would read the same number
         * whether a footnote was set or not.
         */
        const ys = [...body.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/g)]
          .map((m) => Number(m[1])).filter((v) => v > 80);
        if (ys.length) pages.push(ys);
      } catch { /* not a deflated stream */ }
      i = e + 9;
    }
    return { pages, count: pages.reduce((n, p) => n + p.length, 0) };
  }

  /** The bottom margin plus the footer band — where the page's text stops. */
  const FLOOR = 72 + 36;

  it('sets the note at the FOOT of the page, not after the paragraph', async () => {
    const withNote = await placed(CONTRACT);
    const without = await placed('The rate is fixed for the term.');
    // A two-line document's body sits at the top of the page.
    expect(Math.min(...without.pages[0]!)).toBeGreaterThan(600);
    // With the notes, something is set right down at the bottom margin.
    expect(Math.min(...withNote.pages[0]!)).toBeLessThan(FLOOR + 40);
    expect(Math.min(...withNote.pages[0]!)).toBeGreaterThan(FLOOR - 12);
  });

  it('puts the note on the page its MARK is on', async () => {
    /**
     * The mark is pushed to page two by an explicit break. If the note is
     * gathered at the end of the document — the easy, wrong implementation —
     * it still lands on page two here, so the first page is checked as well:
     * nothing may be set at the foot of a page that has no mark on it.
     */
    const md = lines(
      'A first page with nothing to note.',
      '',
      '<!-- pagebreak -->',
      '',
      'The rate is fixed.[^1]',
      '',
      '[^1]: Clause 4.2.',
    );
    const { pages } = await placed(md);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...pages[0]!)).toBeGreaterThan(FLOOR + 80);
    expect(Math.min(...pages[1]!)).toBeLessThan(FLOOR + 40);
  });

  it('takes the room out of the BODY, so the note is never drawn over it', async () => {
    /**
     * A page's worth of prose, then the same prose with a note on its first
     * line. The note occupies the foot, so fewer lines of body fit and the
     * document runs longer — if the page count did NOT move, the note was
     * painted on top of text that was already there.
     */
    const filler = Array.from({ length: 46 }, (_, i) => `Paragraph ${i + 1} of the body.`);
    const plain = await placed(filler.join(NL + NL));
    const noted = await placed(lines(
      `${filler[0]}[^1]`, '', ...filler.slice(1).flatMap((p) => [p, '']),
      '[^1]: A note long enough to take several lines of its own, so that the '
      + 'space it claims at the foot of the page is large enough to push real '
      + 'body text over onto the page that follows it.',
    ));
    expect(plain.pages.length).toBeGreaterThan(1);
    // Same words, one note: the body is pushed down, never overprinted.
    expect(noted.count).toBeGreaterThan(plain.count);
    expect(Math.min(...noted.pages[0]!)).toBeLessThan(Math.min(...plain.pages[0]!));
  });

  it('sets a note whose mark is inside a TABLE CELL', async () => {
    /**
     * FOUND BY READING A RENDERED CONTRACT, not by reasoning about the code.
     * The table is the one block that draws its own text rather than going
     * through `drawLines`, so it was the one block that never asked the page
     * for room: the mark appeared in the cell, correctly numbered, and its
     * note was simply not at the foot of the page. Nothing errored, and the
     * numbering of every OTHER note still looked right — which is what made
     * it invisible until somebody counted them.
     */
    const md = lines(
      '| Item | Rate |',
      '| :--- | ---: |',
      '| Out-of-hours support[^ooh] | 48,000 |',
      '',
      '[^ooh]: Outside 09:00-18:00 IST on a working day.',
    );
    const { pages } = await placed(md);
    expect(Math.min(...pages[0]!)).toBeLessThan(FLOOR + 40);
  });

  it('does not lose a note that falls on the last page', async () => {
    // There is no page turn after the last page, so the final flush is the
    // only thing that sets these — and a short document is entirely last page.
    const { pages } = await placed(lines('Only line.[^1]', '', '[^1]: The only note.'));
    expect(Math.min(...pages[0]!)).toBeLessThan(FLOOR + 40);
  });

  it('is deterministic', async () => {
    expect(await placed(CONTRACT)).toEqual(await placed(CONTRACT));
  });

  it('raises the mark above the line it sits in', async () => {
    /**
     * A superscript, which is what distinguishes a footnote mark from the
     * digit 1 typed after a full stop. Measured as a placement whose baseline
     * is ABOVE the line it belongs to, on a page whose body is a single line.
     */
    const { blob } = await renderPdf({ markdown: lines('Rate.[^1]', '', '[^1]: Note.') });
    const buf = Buffer.from(new Uint8Array(await blob.arrayBuffer()));
    const raw = buf.toString('latin1');
    let ys: number[] = [];
    let i = 0;
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
        const found = [...body.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/g)].map((m) => Number(m[1]));
        if (found.length) { ys = found; break; }
      } catch { /* not a deflated stream */ }
      i = e + 9;
    }
    // The body line and the mark are the two things near the top of the page.
    const top = ys.filter((v) => v > 600).sort((a, b) => a - b);
    expect(top.length).toBe(2);
    // The mark sits a few points higher than the words it follows.
    expect(top[1]! - top[0]!).toBeGreaterThan(1);
    expect(top[1]! - top[0]!).toBeLessThan(6);
  });
});

describe('what Word is told', () => {
  it('uses Word\'s own footnotes, which it numbers and places itself', async () => {
    const xml = await docxXml(CONTRACT);
    expect(xml).toContain('w:footnoteReference');
    // The note's words are in the footnotes part, not in the body.
    expect(xml).toContain('Ninety days, in writing.');
  });

  it('writes no footnote part into a document that has none', async () => {
    expect(await docxXml(lines('# Title', '', 'Plain body.'))).not.toContain('w:footnoteReference');
  });

  it('keeps the marks in step with the notes', async () => {
    const xml = await docxXml(CONTRACT);
    const refs = xml.match(/w:footnoteReference/g) ?? [];
    expect(refs.length).toBe(2);
  });
});

/** Every XML part of a .docx, concatenated. Same reader as `contents.test.ts`. */
async function docxXml(markdown: string): Promise<string> {
  const blob = await renderDocx({ markdown } as never);
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
