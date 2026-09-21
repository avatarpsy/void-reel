/**
 * A document arriving on the canvas, and leaving again.
 *
 * These run against a REAL BlockStdScope (`makeTestBoard`), because the whole
 * risk here is in BlockSuite's own conversion: a matcher registered on the
 * wrong provider produces an empty note and says nothing, which is the failure
 * this file exists to catch.
 */
import { describe, it, expect } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { placeMarkdownDocument, noteToMarkdown, documentTitle, droppedConstructs } from './note-io';

const MD = [
  '# Quarterly Review',
  '',
  'A paragraph with **bold**, *italic* and a [link](https://x.test).',
  '',
  '## Findings',
  '',
  '- one',
  '- two',
  '  - nested',
  '',
  '1. first',
  '2. second',
  '',
  '> a quote',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '---',
].join('\n');

describe('placeMarkdownDocument', () => {
  it('lands a note of real, editable blocks on the page', async () => {
    const board = makeTestBoard();
    const { noteId, dropped } = await placeMarkdownDocument(board as any, MD);

    const model: any = board.store.getBlock(noteId)!.model;
    expect(model.flavour).toBe('affine:note');
    expect(dropped).toEqual([]);

    const flavours = model.children.map((c: any) => c.flavour);
    expect(flavours).toContain('affine:paragraph');
    expect(flavours).toContain('affine:list');
    expect(flavours).toContain('affine:table');
    expect(flavours).toContain('affine:divider');
  }, 60_000);

  /**
   * The adapter hands back an 800x95 sticky note. A document that lands looking
   * like a one-line note is one the user has to resize before it reads as a
   * document at all.
   */
  it('sizes it like a page, not like a sticky note', async () => {
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(board as any, MD, { x: 40, y: 80 });
    const xywh = String((board.store.getBlock(noteId)!.model as any).xywh);
    const [x, y, w, h] = JSON.parse(xywh);
    expect([x, y]).toEqual([40, 80]);
    expect(w).toBe(800);
    expect(h).toBeGreaterThan(500);
  }, 60_000);

  it('refuses an empty document rather than adding a blank note', async () => {
    const board = makeTestBoard();
    await expect(placeMarkdownDocument(board as any, '   ')).rejects.toThrow(/nothing to put/i);
  });
});

describe('noteToMarkdown', () => {
  it('round-trips the structure a document is made of', async () => {
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(board as any, MD);
    const back = await noteToMarkdown(board as any, noteId);

    expect(back).toContain('# Quarterly Review');
    expect(back).toContain('## Findings');
    expect(back).toContain('**bold**');
    expect(back).toContain('[link](https://x.test)');
    expect(back).toContain('> a quote');
    expect(back).toMatch(/\|\s*A\s*\|/);        // the table survived
    expect(back).toMatch(/^\s*1\.\s+first/m);   // ordered list kept its numbers
    expect(back).toMatch(/nested/);             // and the nesting
  }, 60_000);

  it('is empty for a note that is gone, rather than throwing at an export button', async () => {
    const board = makeTestBoard();
    expect(await noteToMarkdown(board as any, 'no-such-block')).toBe('');
  }, 60_000);
});

describe('documentTitle', () => {
  it('is the first heading, which is what names the file', async () => {
    const board = makeTestBoard();
    const { noteId } = await placeMarkdownDocument(board as any, MD);
    expect(documentTitle(board as any, noteId)).toBe('Quarterly Review');
  }, 60_000);

  it('is empty rather than "undefined" for a note with nothing in it', () => {
    const board = makeTestBoard();
    expect(documentTitle(board as any, 'nope')).toBe('');
  });
});

describe('droppedConstructs', () => {
  /**
   * The board has no code block on purpose — rendering one costs a megabyte of
   * Shiki. Dropping a fence silently would be the wrong kind of quiet.
   */
  it('names fenced code, so the user is told instead of finding the hole', () => {
    expect(droppedConstructs('text\n\n```\nconst x = 1;\n```\n')).toEqual(['code blocks']);
    expect(droppedConstructs('~~~\nx\n~~~')).toEqual(['code blocks']);
  });

  it('says nothing for a document that loses nothing', () => {
    expect(droppedConstructs(MD)).toEqual([]);
    expect(droppedConstructs('a `codespan` is not a code block')).toEqual([]);
  });
});
