/**
 * THE JOURNEY THE USER ACTUALLY TAKES.
 *
 *     they upload a .docx
 *  -> it opens on the board as a document, with its formatting
 *  -> the agent changes one section of it
 *  -> it is saved back out as a .docx that still looks like their document
 *
 * Every step of that has its own tests. This one exists because a chain of four
 * correct steps is not the same as a working feature: the formatting has to
 * survive all four, not each in isolation, and the only place that is visible
 * is end to end.
 *
 * The board is real (`makeTestBoard`), so the note in the middle is a real
 * BlockSuite document with the same constraints the product has.
 */
import { describe, it, expect } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { parseMarkdown } from './blocks';
import { renderDocument } from './index';
import { importDocx } from './docx-import';
import { toMarkdown } from './serialise';
import { placeMarkdownDocument, noteToMarkdown } from './note-io';
import { outline, editSection } from './sections';

const NL = String.fromCharCode(10);

/** A letterhead: the document type this whole feature exists for. */
const LETTERHEAD = [
  '# Certificate of Internship',
  '',
  '<!-- align:center -->',
  'This is to certify that',
  '',
  '<!-- align:center -->',
  '[Nalamasa Dinesh]{color=#1a56db size=24}',
  '',
  'completed an internship with **Voidspace AI** from ++17 June 2026++ to',
  '++29 August 2026++.',
  '',
  '## Areas of work',
  '',
  '| Area | Contribution |',
  '| :--- | :--- |',
  '| Prompt engineering | Designing and documenting prompts |',
  '| Model evaluation | Testing output for quality |',
  '',
  '## Annexure',
  '',
  'Signed at Secunderabad.',
].join(NL);

/** What the user uploaded: a real .docx, as bytes. */
async function asDocx(markdown: string): Promise<Uint8Array> {
  const out: any = await renderDocument({ markdown, title: 'Certificate' }, 'docx');
  return new Uint8Array(await out.blob.arrayBuffer());
}

const runsOf = (blocks: any[]) => blocks.flatMap((b) => b.runs ?? []);

describe('upload, open, edit, save', () => {
  it('carries a letterhead all the way round and back into Word', async () => {
    /* ── 1. they upload it ────────────────────────────────────────────────── */
    const uploaded = await asDocx(LETTERHEAD);

    /* ── 2. it opens on the board ─────────────────────────────────────────── */
    const imported = await importDocx(uploaded);
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(
      board as any, toMarkdown(imported.blocks), { kind: 'docx' });

    // On the canvas, and still the same document.
    const onBoard = parseMarkdown(await noteToMarkdown(board as any, noteId));
    expect(runsOf(onBoard).find((r) => r.color)).toMatchObject({
      text: 'Nalamasa Dinesh', color: '#1a56db',
    });
    expect(onBoard.find((b: any) => b.runs?.[0]?.text === 'This is to certify that'))
      .toMatchObject({ align: 'center' });
    expect(onBoard.some((b: any) => b.kind === 'table')).toBe(true);

    /* ── 3. the agent changes one section ─────────────────────────────────── */
    const sections = outline(board as any, noteId);
    const annexure = sections.find((s: any) => /Annexure/i.test(s.heading));
    expect(annexure, 'the outline should find the Annexure').toBeTruthy();

    await editSection(board as any, noteId, 'replace', {
      sectionId: annexure!.id,
      markdown: ['## Annexure', '', 'Signed at Hyderabad on 22 September 2026.'].join(NL),
    });

    /* ── 4. it is saved back out ──────────────────────────────────────────── */
    const edited = await noteToMarkdown(board as any, noteId);
    const saved = await asDocx(edited);
    const final = await importDocx(saved);
    const blocks = final.blocks as any[];

    // The edit is in.
    const text = runsOf(blocks).map((r) => r.text).join(' ');
    expect(text).toContain('Signed at Hyderabad on 22 September 2026.');
    expect(text).not.toContain('Signed at Secunderabad');

    // AND NOTHING ELSE MOVED. This is the assertion the whole chain is for.
    expect(runsOf(blocks).find((r) => r.color)).toMatchObject({
      text: 'Nalamasa Dinesh', color: '#1a56db',
    });
    /**
     * THE ONE THING THAT DOES NOT SURVIVE, asserted so it cannot change
     * quietly in either direction.
     *
     * BlockSuite has no inline font size — underline, colour and highlight
     * are real attributes it stores, and size is not one of them. So a 24pt
     * name reaches the PDF and the Word file, and is lost the moment the
     * document passes through the canvas. The tool guidance says this, and
     * this is the test that keeps the guidance true.
     */
    expect(runsOf(blocks).find((r) => r.color)?.size).toBeUndefined();
    expect(runsOf(blocks).some((r) => r.underline && r.text.includes('17 June'))).toBe(true);
    expect(runsOf(blocks).some((r) => r.bold && r.text === 'Voidspace AI')).toBe(true);
    expect(blocks.find((b) => b.runs?.[0]?.text === 'This is to certify that'))
      .toMatchObject({ align: 'center' });

    const table = blocks.find((b) => b.kind === 'table');
    expect(table.rows).toHaveLength(2);
    expect(table.header[0].map((r: any) => r.text).join('')).toBe('Area');

    expect(blocks.filter((b) => b.kind === 'heading').map((b) => b.level)).toEqual([1, 2, 2]);
  }, 180_000);

  /**
   * SAVING A COPY leaves the original alone. The default when a user hands over
   * a document that matters, and the thing they will be angriest about if it is
   * wrong.
   */
  it('saving under a new name does not touch the document on the board', async () => {
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(board as any, LETTERHEAD, { kind: 'docx' });

    const before = await noteToMarkdown(board as any, noteId);
    const copy: any = await renderDocument({ markdown: before, title: 'A Copy' }, 'docx');
    expect(copy.fileName).toBe('A Copy.docx');

    const after = await noteToMarkdown(board as any, noteId);
    expect(after).toBe(before);
  }, 120_000);

  /** A PDF says it was rebuilt; a Word file does not, because it was not. */
  it('a Word import claims nothing it did not read', async () => {
    const { unsupported } = await importDocx(await asDocx('Plain prose.'));
    expect(unsupported).not.toContain('headings from type size');
  }, 60_000);
});
