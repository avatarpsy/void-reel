/**
 * THE FULL LOOP: markdown -> .docx -> blocks -> markdown.
 *
 * ── WHY IT IS TESTED AGAINST OUR OWN WRITER ─────────────────────────────────
 * Because that is the only way to know what the answer SHOULD be. A .docx from
 * Word is a fine test of "does it crash", and a useless test of "did it keep the
 * underline" — nobody can say what the file contained without opening Word.
 * Writing the file here means the expected result is the document we started
 * with, and every difference is a real loss with a name.
 *
 * The writer is a genuinely independent implementation (the `docx` package's
 * XML) from the reader (our own OOXML walk), so this is not a function being
 * tested against itself.
 *
 * What it does NOT prove is that a file from Word 2019, Google Docs or Pages
 * reads correctly — those use styles and structures we do not emit. That needs
 * real files, and the honest position until then is that `unsupported` names
 * what was skipped rather than the import pretending it saw everything.
 */
import { describe, it, expect } from 'vitest';

import { parseMarkdown } from './blocks';
import { renderDocument } from './index';
import { importDocx } from './docx-import';
import { toMarkdown } from './serialise';

const NL = String.fromCharCode(10);

async function roundTrip(markdown: string, spec: Record<string, unknown> = {}) {
  const out: any = await renderDocument(
    { markdown, title: 'Round Trip', ...spec } as any, 'docx');
  const imported = await importDocx(new Uint8Array(await out.blob.arrayBuffer()));
  return { ...imported, markdown: toMarkdown(imported.blocks) };
}

/** Every run in the document, flattened, for asserting on marks. */
const allRuns = (blocks: any[]): any[] => blocks.flatMap((b) => b.runs ?? []);
const textOf = (blocks: any[]): string => allRuns(blocks).map((r) => r.text).join(' ');

describe('a Word file comes back as the document it was', () => {
  it('keeps the words', async () => {
    const { blocks } = await roundTrip([
      '# Quarterly Review',
      '',
      'The positioning is that creators win.',
    ].join(NL));
    expect(textOf(blocks)).toContain('The positioning is that creators win.');
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
  }, 60_000);

  it('keeps bold, italic, underline and strike', async () => {
    const { blocks } = await roundTrip(
      'Plain, **bold**, *italic*, ++underlined++ and ~~struck~~.');
    const runs = allRuns(blocks);
    expect(runs.find((r) => r.bold)?.text).toBe('bold');
    expect(runs.find((r) => r.italic)?.text).toBe('italic');
    expect(runs.find((r) => r.underline)?.text).toBe('underlined');
    expect(runs.find((r) => r.strike)?.text).toBe('struck');
  }, 60_000);

  /** THE ONE MAMMOTH DROPS. A letterhead is made of these. */
  it('keeps colour and point size', async () => {
    const { blocks } = await roundTrip('[Nalamasa Dinesh]{color=#1a56db size=24}');
    const run = allRuns(blocks).find((r) => r.color);
    expect(run).toMatchObject({ text: 'Nalamasa Dinesh', color: '#1a56db', size: 24 });
  }, 60_000);

  it('keeps a highlight', async () => {
    const { blocks } = await roundTrip('A ==highlighted== phrase.');
    expect(allRuns(blocks).find((r) => r.highlight)?.text).toBe('highlighted');
  }, 60_000);

  it('keeps paragraph alignment', async () => {
    const { blocks } = await roundTrip([
      '<!-- align:center -->',
      'A centred line.',
      '',
      '<!-- align:right -->',
      '22 September 2026',
    ].join(NL));
    expect(blocks.find((b: any) => b.runs?.[0]?.text?.includes('centred'))).toMatchObject({
      align: 'center',
    });
    expect(blocks.find((b: any) => b.runs?.[0]?.text?.includes('September'))).toMatchObject({
      align: 'right',
    });
  }, 60_000);

  it('keeps headings at their levels', async () => {
    const { blocks } = await roundTrip(['# One', '', '## Two', '', '### Three'].join(NL));
    expect(blocks.filter((b: any) => b.kind === 'heading').map((b: any) => b.level))
      .toEqual([1, 2, 3]);
  }, 60_000);

  it('keeps lists, and knows an ordered one from a bulleted one', async () => {
    const { blocks } = await roundTrip(['- one', '- two', '', '1. first', '2. second'].join(NL));
    const lists = blocks.filter((b: any) => b.kind === 'list');
    expect(lists.length).toBeGreaterThanOrEqual(4);
    expect(lists.some((b: any) => b.ordered)).toBe(true);
    expect(lists.some((b: any) => !b.ordered)).toBe(true);
  }, 60_000);

  it('keeps a table, its header and its column proportions', async () => {
    const { blocks } = await roundTrip([
      '<!-- columns: 4,1,1 -->',
      '| Description | Qty | Amount |',
      '| :--- | :---: | ---: |',
      '| A line item | 2 | 1,200.00 |',
    ].join(NL));
    const table: any = blocks.find((b: any) => b.kind === 'table');
    expect(table).toBeTruthy();
    expect(table.header.map((c: any[]) => c.map((r) => r.text).join(''))).toEqual(
      ['Description', 'Qty', 'Amount']);
    expect(table.rows[0].map((c: any[]) => c.map((r) => r.text).join(''))).toEqual(
      ['A line item', '2', '1,200.00']);
    // Proportions, not absolute widths: the first column is much the widest.
    expect(table.widths[0]).toBeGreaterThan(table.widths[1]);
  }, 60_000);

  it('keeps a page break', async () => {
    const { blocks } = await roundTrip(['One.', '', '<!-- pagebreak -->', '', 'Two.'].join(NL));
    expect(blocks.some((b: any) => b.kind === 'pagebreak')).toBe(true);
  }, 60_000);

  it('keeps a hard break inside a paragraph', async () => {
    const { blocks } = await roundTrip([
      'Voidspace Technologies  ',
      'Secunderabad',
    ].join(NL));
    expect(textOf(blocks)).toContain(String.fromCharCode(10));
  }, 60_000);

  it('recovers the page setup and the running header and footer', async () => {
    const { spec } = await roundTrip('A wide table would go here.', {
      orientation: 'landscape',
      header: 'Voidspace',
      footer: 'Page {page} of {pages}',
    });
    expect(spec.orientation).toBe('landscape');
    expect(spec.header).toBe('Voidspace');
    // The fields come back as the placeholders they were written from.
    expect(spec.footer).toBe('Page {page} of {pages}');
  }, 60_000);

  it('recovers a narrow margin as a number of points', async () => {
    const { spec } = await roundTrip('Body.', { margin: 'narrow' });
    expect(spec.margin).toBeGreaterThan(20);
    expect(spec.margin).toBeLessThan(72);
  }, 60_000);
});

describe('the loop is stable', () => {
  /**
   * The point of the whole exercise: open a document, change nothing, save it,
   * and it is still the same document. If this drifts, every edit costs a
   * little formatting and the user watches their letterhead decay.
   */
  it('a second trip through Word changes nothing', async () => {
    const SOURCE = [
      '# Certificate of Internship',
      '',
      '<!-- align:center -->',
      'This is to certify that',
      '',
      '<!-- align:center -->',
      '[Nalamasa Dinesh]{color=#1a56db size=24}',
      '',
      'Completed an internship with **Voidspace AI** from ++17 June++ to ++29 August++.',
      '',
      '| Area | Contribution |',
      '| :--- | :--- |',
      '| Prompt engineering | Designing and documenting prompts |',
      '',
      '<!-- pagebreak -->',
      '',
      '## Annexure',
    ].join(NL);

    const first = await roundTrip(SOURCE);
    const second = await roundTrip(first.markdown);
    expect(parseMarkdown(second.markdown)).toEqual(parseMarkdown(first.markdown));
  }, 120_000);

  it('says what it could not represent rather than swallowing it', async () => {
    const { unsupported } = await roundTrip('Plain text.');
    expect(Array.isArray(unsupported)).toBe(true);
  }, 60_000);
});

describe('it refuses what it cannot read, in words', () => {
  it('rejects something that is not a zip at all', async () => {
    await expect(importDocx(new TextEncoder().encode('this is not a docx')))
      .rejects.toThrow(/not a zip/i);
  });

  /**
   * A VALID archive that is not a Word file. The first version of this test
   * corrupted the name in the LOCAL header only and the import succeeded —
   * correctly, because the reader uses the central directory, where the name
   * was still intact. Both copies have to change, which is also a decent
   * check that the reader really is reading the directory it claims to.
   */
  it('rejects a zip with no document part', async () => {
    const made: any = await renderDocument({ markdown: 'x', title: 'x' }, 'docx');
    const bytes = new Uint8Array(await made.blob.arrayBuffer());
    const NAME = 'word/document.xml';
    const decoder = new TextDecoder();
    let found = 0;
    for (let i = 0; i + NAME.length <= bytes.length; i++) {
      if (decoder.decode(bytes.subarray(i, i + NAME.length)) !== NAME) continue;
      bytes[i] = 'z'.charCodeAt(0); // same length, so every offset still holds
      found += 1;
    }
    expect(found).toBeGreaterThanOrEqual(2);
    await expect(importDocx(bytes)).rejects.toThrow(/document part/i);
  }, 60_000);
});
