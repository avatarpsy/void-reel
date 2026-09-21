/**
 * The tag on each box.
 *
 * What it must never do is label things that are not documents: every sticky
 * note on a busy board is an `affine:note` too, and a canvas covered in TEXT
 * chips is worse than no chips at all.
 */
import { describe, it, expect } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { placeMarkdownDocument } from './note-io';
import { tagFor } from './tags';

describe('tagFor', () => {
  it('names the format a document was imported from', async () => {
    const board = makeTestBoard();
    const pdf = await placeMarkdownDocument(board as any, '# Brief\n\nBody.', { kind: 'pdf' });
    const docx = await placeMarkdownDocument(board as any, '# Contract\n\nBody.', { kind: 'docx' });
    const md = await placeMarkdownDocument(board as any, '# Plan\n\nBody.');

    expect(tagFor(board as any, pdf.noteId, true)).toBe('PDF');
    expect(tagFor(board as any, docx.noteId, true)).toBe('DOCX');
    // No kind given is markdown somebody wrote, which IS text.
    expect(tagFor(board as any, md.noteId, true)).toBe('TEXT');
  });

  it('says nothing about a note that is not a document', async () => {
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(board as any, '# Brief\n\nBody.', { kind: 'pdf' });
    // The same block, asked about as a plain note: an empty sticky must not
    // come back tagged just because it is the same flavour.
    expect(tagFor(board as any, noteId, false)).toBe('');
  });

  it('names the screenplay, which is its own flavour and not a note', () => {
    const board = makeTestBoard();
    const surface: any = board.store.getBlocksByFlavour('affine:surface')[0]?.model;
    const id = board.store.addBlock('voidspace:screenplay', {
      xywh: '[0,0,816,1056]',
      text: 'FADE IN:',
    }, surface.id);
    // `isDocument` is false — it is not an `affine:note` and never appears in
    // `listDocuments`. The tag must not depend on that.
    expect(tagFor(board as any, id, false)).toBe('SCREENPLAY');
  });

  it('has no answer for a block that has gone', () => {
    const board = makeTestBoard();
    expect(tagFor(board as any, 'no-such-block', true)).toBe('');
  });
});
