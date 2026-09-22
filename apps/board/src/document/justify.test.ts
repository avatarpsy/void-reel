/**
 * Justified text — both edges flush.
 *
 * The most visible thing separating a document that looks SET from one that
 * looks typed, and the one Word has had since it existed. Word gets it free
 * from `AlignmentType.JUSTIFIED`; the PDF has no layout engine under it, so
 * `drawLines` grows the spaces itself and these measure that it worked.
 */
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';
import { MARK, commentsFromMarks, marksFromComments, readMark } from './align-marks';
import { parseMarkdown } from './blocks';
import { renderPdf } from './pdf';
import { renderDocx } from './docx';
import { toMarkdown } from './serialise';

/** The same prose, asked to be justified. Built rather than written inline so
 *  no test has to escape a newline inside a template literal. */
const justified = (body: string) => ['<!-- align:justify -->', body].join(String.fromCharCode(10));

const PROSE = [
  'This paragraph has to run to several lines before justification means',
  'anything at all, because the whole point is the slack left at the end of a',
  'line and there is none on a line that never wrapped. So it keeps going for',
  'a while, saying very little, until the measure has been filled more than',
  'once and the setting can be judged.',
].join(' ');

describe('the alignment survives the trip', () => {
  it('reads and writes the comment', () => {
    const [block] = parseMarkdown(`<!-- align:justify -->\n${PROSE}`);
    expect(block).toMatchObject({ kind: 'para', align: 'justify' });
    expect(toMarkdown([block!])).toContain('<!-- align:justify -->');
  });

  it('accepts "justified" as well, because people write both', () => {
    expect(parseMarkdown('<!-- align:justified -->\nHello')[0]).toMatchObject({ align: 'justify' });
  });

  it('carries it across the canvas as its own mark', () => {
    const marked = marksFromComments(`<!-- align:justify -->\n${PROSE}`);
    expect(marked).toContain(MARK.justify);
    expect(commentsFromMarks(marked)).toContain('<!-- align:justify -->');
  });

  /**
   * THE ORDER OF THE MARKS IS THE WHOLE CORRECTNESS ARGUMENT.
   *
   * Every mark is a run of the same character, so each begins with every
   * shorter one. Read in the wrong order a justified paragraph is a page
   * break, a page break is a gap, and a gap is a centred line.
   */
  it('never confuses one mark for a shorter one it starts with', () => {
    expect(readMark(MARK.justify)).toMatchObject({ align: 'justify' });
    expect(readMark(MARK.pagebreak)).toMatchObject({ pagebreak: true });
    expect(readMark(MARK.space)).toMatchObject({ space: true });
    expect(readMark(MARK.right)).toMatchObject({ align: 'right' });
    expect(readMark(MARK.center)).toMatchObject({ align: 'center' });
    // And each one consumes ONLY itself.
    expect(readMark(`${MARK.justify}text`).text).toBe('text');
    expect(readMark(`${MARK.right}text`).text).toBe('text');
  });
});

describe('what Word is told', () => {
  it('asks for justified, which Word has always known how to set', async () => {
    const blob = await renderDocx({ markdown: `<!-- align:justify -->
${PROSE}` });
    const xml = (await unzip(new Uint8Array(await blob.arrayBuffer())))['word/document.xml'] ?? '';
    expect(xml).toContain('w:val="both"');
  });

  it('does not justify a heading', async () => {
    const blob = await renderDocx({ markdown: `<!-- align:justify -->
# A heading` });
    const xml = (await unzip(new Uint8Array(await blob.arrayBuffer())))['word/document.xml'] ?? '';
    expect(xml).not.toContain('w:val="both"');
  });
});

describe('what the PDF actually draws', () => {
  /**
   * Where every word was placed. pdf-lib positions each one with its own
   * text matrix, so the x values ARE the setting — which is what makes this
   * a measurement of the output rather than of the intent.
   */
  async function xs(markdown: string): Promise<number[]> {
    const { blob } = await renderPdf({ markdown });
    const paint = paintOf(new Uint8Array(await blob.arrayBuffer()));
    return [...paint.matchAll(/1 0 0 1 ([\d.]+) [\d.]+ Tm/g)].map((m) => Number(m[1]));
  }

  /**
   * Grouped into lines: a new one begins wherever a word is placed back at the
   * left margin. The LAST x on each line is that line's right edge, which is
   * the thing justification moves — it takes the slack at the end of a line
   * and puts it between the words instead.
   */
  const rightEdges = (positions: number[]): number[] => {
    const left = Math.min(...positions);
    const edges: number[] = [];
    positions.forEach((x, i) => {
      const startsLine = x <= left + 0.5;
      if (startsLine && i > 0) edges.push(positions[i - 1]!);
    });
    edges.push(positions[positions.length - 1]!);
    return edges;
  };

  it('takes up the slack on a line that has some', async () => {
    const flush = rightEdges(await xs(justified(PROSE)));
    const ragged = rightEdges(await xs(PROSE));
    expect(flush.length).toBe(ragged.length);
    expect(flush.length).toBeGreaterThan(2); // it really did wrap

    const moved = flush.slice(0, -1).map((x, i) => x - ragged[i]!);
    /**
     * NOT every line: a line that already filled its measure has no slack to
     * take up and correctly stays where it was. Measured on this paragraph,
     * one line was already full at 494.3 and the next moved 481.6 → 495.
     */
    expect(Math.max(...moved)).toBeGreaterThan(10);
    // And nothing is ever pulled LEFT, which would be a bug rather than a
    // setting: justification only ever takes up slack.
    expect(moved.every((d) => d >= -0.01)).toBe(true);
  });

  it('leaves a single-line paragraph exactly where it was', async () => {
    // The last line of a paragraph is never justified, and a one-line
    // paragraph is nothing but its last line.
    const short = 'Three words here.';
    expect(await xs(justified(short))).toEqual(await xs(short));
  });

  it('does not stretch the final line of a long paragraph', async () => {
    const flush = await xs(justified(PROSE));
    const ragged = await xs(PROSE);
    // The very last word of the block sits where ragged setting put it.
    expect(flush[flush.length - 1]).toBeCloseTo(ragged[ragged.length - 1]!, 1);
  });
});

/** Every decompressed content stream that paints text. Same reader as
 *  `export-is-theme-free.test.ts`, for the same reason: a PDF's operators are
 *  behind a Flate stream and reading the raw bytes finds nothing. */
function paintOf(file: Uint8Array): string {
  const buf = Buffer.from(file);
  const text = buf.toString('latin1');
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const s = text.indexOf('stream', i);
    if (s < 0) break;
    let start = s + 6;
    if (buf[start] === 13) start++;
    if (buf[start] === 10) start++;
    const e = text.indexOf('endstream', start);
    if (e < 0) break;
    try {
      const body = inflateSync(buf.subarray(start, e)).toString('latin1');
      if (/Tj|TJ/.test(body)) out.push(body);
    } catch { /* not a deflated stream */ }
    i = e + 9;
  }
  return out.join('|');
}

/** The .docx entries, by name. Same reader as `docx-fidelity.test.ts`. */
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
    const at = i + 30 + nameLen + extraLen;
    const body = buf.subarray(at, at + compressed);
    if (name.endsWith('.xml')) out[name] = (method === 8 ? inflateRawSync(body) : body).toString('utf8');
    i = at + compressed;
  }
  return out;
}
