/**
 * The shelf.
 *
 * Every bug this file guards against was visible on the canvas and invisible to
 * the model: two documents at the same coordinates are both perfectly valid
 * notes, and a page a screen and a half from its neighbours is a page nobody
 * finds. These run against a real board, because the positions come from the
 * store and the geometry only means anything against real boxes.
 */
import { describe, it, expect } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { overlaps } from '../board/space';
import { DOC_GAP, arrangeDocuments, documentBoxes, nextDocumentSpot } from './layout';
import { placeMarkdownDocument } from './note-io';

const doc = (n: number) => `# Document ${n}\n\nA paragraph of body text for it.\n`;

/** Put a note exactly where the test wants it, bypassing placement. */
async function placeAt(board: any, n: number, x: number, y: number) {
  const { noteId } = await placeMarkdownDocument(board, doc(n), { x, y });
  return noteId;
}

describe('documentBoxes', () => {
  it('reads left to right, then down — not store order', async () => {
    const board = makeTestBoard();
    await placeAt(board, 1, 2000, 0);     // created first, sits third
    await placeAt(board, 2, 0, 0);
    await placeAt(board, 3, 0, 2000);     // a row below
    await placeAt(board, 4, 1000, 0);

    expect(documentBoxes(board as any).map((d) => d.title)).toEqual([
      'Document 2', 'Document 4', 'Document 1', 'Document 3',
    ]);
  });
});

describe('nextDocumentSpot', () => {
  it('has no opinion about the first document', async () => {
    const board = makeTestBoard();
    expect(nextDocumentSpot(board as any, { w: 800, h: 1120 })).toBeUndefined();
  });

  it('puts the next page beside the last one, on the same line', async () => {
    const board = makeTestBoard();
    await placeAt(board, 1, 0, 0);
    const [first] = documentBoxes(board as any);

    const spot = nextDocumentSpot(board as any, { w: 800, h: 1120 })!;
    expect(spot.x).toBe(first!.x + first!.w + DOC_GAP);
    expect(spot.y).toBe(first!.y);
  });

  it('wraps to a new row rather than running off forever', async () => {
    const board = makeTestBoard();
    for (let i = 0; i < 4; i++) await placeAt(board, i + 1, i * (800 + DOC_GAP), 0);

    const spot = nextDocumentSpot(board as any, { w: 800, h: 1120 })!;
    const row = documentBoxes(board as any);
    expect(spot.x).toBe(Math.min(...row.map((d) => d.x)));      // back to the left edge
    expect(spot.y).toBeGreaterThan(Math.max(...row.map((d) => d.y)));
  });

  it('drops below the TALLEST page of the row, not the last one', async () => {
    const board = makeTestBoard();
    for (let i = 0; i < 3; i++) await placeAt(board, i + 1, i * (800 + DOC_GAP), 0);
    // A deliberately tall page in the middle, then a short one at the end.
    const boxes = documentBoxes(board as any);
    const tall: any = board.store.getBlock(boxes[1]!.noteId)!.model;
    board.store.updateBlock(tall, { xywh: `[${boxes[1]!.x},0,800,3000]` });
    await placeAt(board, 4, 3 * (800 + DOC_GAP), 0);

    const spot = nextDocumentSpot(board as any, { w: 800, h: 1120 })!;
    // Under the tall one. Under the short last page would put the new row
    // straight through the middle of it.
    expect(spot.y).toBeGreaterThanOrEqual(3000 + DOC_GAP);
  });
});

describe('arrangeDocuments', () => {
  it('separates documents that were stacked on each other', async () => {
    const board = makeTestBoard();
    await placeAt(board, 1, 0, 0);
    await placeAt(board, 2, 0, 0);          // exactly on top
    await placeAt(board, 3, 40, 20);        // nearly on top

    const before = documentBoxes(board as any);
    expect(before.some((a, i) => before.slice(i + 1).some((b) => overlaps(a, b)))).toBe(true);

    expect(arrangeDocuments(board as any)).toBeGreaterThan(0);

    const after = documentBoxes(board as any);
    expect(after).toHaveLength(3);
    expect(after.some((a, i) => after.slice(i + 1).some((b) => overlaps(a, b)))).toBe(false);
  });

  it('keeps the shelf where the user left it', async () => {
    const board = makeTestBoard();
    await placeAt(board, 1, 5000, 3000);
    await placeAt(board, 2, 5000, 3000);

    arrangeDocuments(board as any);
    const after = documentBoxes(board as any);
    // Anchored at the old top-left: a tidy-up must not teleport the viewport's
    // contents somewhere the user then has to go looking for.
    expect(Math.min(...after.map((d) => d.x))).toBe(5000);
    expect(Math.min(...after.map((d) => d.y))).toBe(3000);
  });

  it('reports nothing to do on a board that is already tidy', async () => {
    const board = makeTestBoard();
    await placeAt(board, 1, 0, 0);
    await placeMarkdownDocument(board as any, doc(2));   // takes the shelf spot
    expect(arrangeDocuments(board as any)).toBe(0);
  });

  it('does nothing with fewer than two documents', async () => {
    const board = makeTestBoard();
    await placeAt(board, 1, 0, 0);
    expect(arrangeDocuments(board as any)).toBe(0);
  });
});

describe('placement through placeMarkdownDocument', () => {
  it('lands four documents in a row that does not overlap', async () => {
    const board = makeTestBoard();
    for (let i = 0; i < 4; i++) await placeMarkdownDocument(board as any, doc(i + 1));

    const boxes = documentBoxes(board as any);
    expect(boxes).toHaveLength(4);
    expect(boxes.some((a, i) => boxes.slice(i + 1).some((b) => overlaps(a, b)))).toBe(false);
    // All on one line: the whole point of a shelf.
    expect(new Set(boxes.map((b) => b.y)).size).toBe(1);
  });

  it('still honours a point the user aimed at', async () => {
    const board = makeTestBoard();
    await placeMarkdownDocument(board as any, doc(1));
    const { noteId } = await placeMarkdownDocument(board as any, doc(2), { x: -900, y: 400 });

    const dropped = documentBoxes(board as any).find((d) => d.noteId === noteId)!;
    expect(dropped.x).toBe(-900);
    expect(dropped.y).toBe(400);
  });
});
