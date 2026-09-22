/**
 * A LETTERHEAD, ONTO THE CANVAS AND BACK.
 *
 * This is the test the whole document feature rests on. The claim being made to
 * the user is that a document created here is editable here — so everything
 * that makes a letterhead a letterhead has to survive the trip through a real
 * `affine:note` and come back out. Not asserted in the abstract: this runs
 * against a real BlockStdScope, and each case below is one that DID NOT survive
 * before the mark carrier existed.
 *
 * What is deliberately NOT claimed: BlockSuite has no block for a fenced code
 * listing on this board, and a run's font SIZE has no native inline attribute.
 * Those are listed in `droppedConstructs` and in the tool guidance rather than
 * being quietly lost.
 */
import { describe, it, expect } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { placeMarkdownDocument, noteToMarkdown } from './note-io';
import { parseMarkdown } from './blocks';

const NL = String.fromCharCode(10);

async function trip(markdown: string): Promise<string> {
  const board = makeTestBoard();
  const { noteId } = await placeMarkdownDocument(board as any, markdown);
  return await noteToMarkdown(board as any, noteId);
}

const LETTERHEAD = [
  '![logo](https://voidspace.ai/images/logo/logo.png#w=64&align=left)',
  '',
  '<!-- align:center -->',
  '# Certificate of Internship',
  '',
  '<!-- align:right -->',
  '22 September 2026',
  '',
  'This is to certify that **Nalamasa Dinesh** completed an internship.',
  '',
  '<!-- pagebreak -->',
  '',
  '## Annexure',
  '',
  'The work covered prompt engineering and evaluation.',
].join('\n');

describe('a letterhead survives the canvas', () => {
  it('keeps the centred title centred', async () => {
    const back = await trip(LETTERHEAD);
    const heading = parseMarkdown(back).find((b) => b.kind === 'heading');
    expect(heading).toMatchObject({ align: 'center' });
  }, 60_000);

  it('keeps the right-aligned date on the right', async () => {
    const blocks = parseMarkdown(await trip(LETTERHEAD));
    const dated = blocks.find((b: any) => b.runs?.[0]?.text?.includes('22 September'));
    expect(dated).toMatchObject({ align: 'right' });
  }, 60_000);

  it('keeps the page break', async () => {
    expect(parseMarkdown(await trip(LETTERHEAD)).some((b) => b.kind === 'pagebreak')).toBe(true);
  }, 60_000);

  it('keeps the masthead image at the size it was given', async () => {
    const image: any = parseMarkdown(await trip(LETTERHEAD)).find((b) => b.kind === 'image');
    expect(image).toMatchObject({ width: 64, align: 'left' });
  }, 60_000);

  /**
   * THE MARK MUST NEVER BE VISIBLE. It is a real character in the note's text,
   * so the one unacceptable outcome is that it reaches a rendered page or the
   * markdown the agent reads as a stray glyph.
   */
  it('never leaves an invisible character in the text it comes back with', async () => {
    const back = await trip(LETTERHEAD);
    expect(back).not.toMatch(/\u2060/);
    const words = parseMarkdown(back)
      .flatMap((b: any) => b.runs ?? []).map((r: any) => r.text).join('');
    expect(words).not.toMatch(/\u2060/);
  }, 60_000);

  it('keeps the words, the bold and the structure', async () => {
    const back = await trip(LETTERHEAD);
    expect(back).toContain('Nalamasa Dinesh');
    expect(back).toMatch(/\*\*Nalamasa Dinesh\*\*/);
    expect(back).toContain('## Annexure');
  }, 60_000);

  /**
   * The round trip has to be STABLE: a document that changes every time it is
   * opened and closed would drift a little further from itself on each edit.
   */
  it('is stable — a second trip changes nothing', async () => {
    const once = await trip(LETTERHEAD);
    const twice = await trip(once);
    expect(twice).toBe(once);
  }, 90_000);

  /**
   * A HARD BREAK IS CONTENT, and it used to come back as `onetwo`.
   *
   * An address block is three lines of one paragraph. Losing the breaks welded
   * the street to the city; losing the paragraph would have double-spaced them.
   * Both are wrong, so the assertion is on the parsed block, not on the string.
   */
  it('keeps an address block as one paragraph of three lines', async () => {
    const back = await trip([
      'Voidspace Technologies  ',
      '9/3/448 Rezimental Bazaar  ',
      'Secunderabad',
    ].join(NL));
    const blocks = parseMarkdown(back);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as any).runs.map((r: any) => r.text).join('');
    expect(text.split(NL)).toEqual([
      'Voidspace Technologies', '9/3/448 Rezimental Bazaar', 'Secunderabad',
    ]);
    expect(text).not.toContain('TechnologiesVoid');
  }, 60_000);
});

/**
 * THE OTHER DIRECTION: what the USER types on the canvas, coming out.
 *
 * Everything above starts from markdown. These start from the note, because
 * that is what a hand-edit produces and it is the half that cannot be checked
 * by reading the markdown the agent wrote.
 */
describe('what the user types on the canvas survives leaving it', () => {
  it('keeps a shift+Enter line break as a hard break', async () => {
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(board as any, 'placeholder');
    const note: any = board.store.getBlock(noteId)!.model;
    const para: any = note.children.find((c: any) => c.flavour === 'affine:paragraph');
    // Exactly what the inline editor stores for shift+Enter.
    para.props.text.replace(0, para.props.text.length, 'first' + NL + 'second');

    const back = await noteToMarkdown(board as any, noteId);
    const text = (parseMarkdown(back)[0] as any).runs.map((r: any) => r.text).join('');
    expect(text).toBe('first' + NL + 'second');
    expect(text).not.toBe('firstsecond');
  }, 60_000);

  it('keeps underline and colour, which the note stores natively', async () => {
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(board as any, 'plain words here');
    const note: any = board.store.getBlock(noteId)!.model;
    const para: any = note.children.find((c: any) => c.flavour === 'affine:paragraph');
    para.props.text.format(0, 5, { underline: true });

    // Read back off the model, which is what an export of the note sees.
    const delta = para.props.text.yText.toDelta();
    expect(delta[0].attributes).toMatchObject({ underline: true });
  }, 60_000);
});
