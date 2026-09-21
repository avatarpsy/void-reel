/**
 * Where documents SIT — as a shelf, not as a scatter.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * "FREE SPACE" IS NOT THE SAME AS "ORGANISED"
 * ══════════════════════════════════════════════════════════════════════════
 * `reserveFlow` answers one question — where is there room — and it answers it
 * correctly. It is the right tool for a batch of shot cards the agent just made,
 * which have no relationship to anything already on the board.
 *
 * Documents DO have a relationship: to each other. Three of them belong side by
 * side in reading order, like pages laid out on a desk, and asking only for room
 * put the fourth a screen and a half to the left of the third because that was
 * the nearest gap. Nothing overlapped and nothing was findable.
 *
 * So placement here is two decisions, in this order:
 *   1. WHERE IT BELONGS — after the last document, on the same top line.
 *   2. IS THAT FREE — `reserveFlow` with that as its origin, which pushes the
 *      page down if a shot or an image is already standing there.
 *
 * Belonging first, room second. Reversing them is how the shelf became a pile.
 */
import { flow, type Box, boundsOf, reserveFlow } from '../board/space';
import { listDocuments } from './sections';

import type { MountedBoard } from '../blocksuite/editor';

/** The gutter between two pages. Wide enough to read as a gap, not a join. */
export const DOC_GAP = 96;
/**
 * How wide a shelf gets before it wraps.
 *
 * Four pages at 800 plus their gutters. Past that a row is longer than any
 * zoom-to-fit can show usefully, and a second row is easier to scan than a
 * horizontal scroll with no end in sight.
 */
export const SHELF_MAX_W = 4 * 800 + 3 * DOC_GAP;

export interface DocumentBox extends Box {
  noteId: string;
  title: string;
  words: number;
}

/**
 * Every document on the board WITH ITS BOX, in reading order.
 *
 * Reading order is left-to-right then top-to-bottom, not store order: the store
 * remembers when a note was created, and a person reads what they see. A page
 * dragged to the front of the shelf should be first, and after `arrange` the two
 * orders agree anyway.
 */
export function documentBoxes(board: MountedBoard): DocumentBox[] {
  const out: DocumentBox[] = [];
  for (const doc of listDocuments(board)) {
    const model = board.store.getBlock(doc.noteId)?.model;
    const box = model ? boundsOf(model) : null;
    if (!box) continue;
    out.push({ ...box, noteId: doc.noteId, title: doc.title, words: doc.words });
  }
  // Rows first, then position along the row. The band is half a page tall so
  // two pages that are roughly level count as the same row even when one has
  // been nudged by a drag.
  return out.sort((a, b) => (
    Math.abs(a.y - b.y) > 400 ? a.y - b.y : a.x - b.x
  ));
}

/**
 * Where the NEXT document goes.
 *
 * Returns undefined when there are no documents yet — the caller then lets
 * `reserveFlow` choose, which is the right answer for the first page: it has
 * nothing to line up with, and the thinking region is where the board puts
 * things that are nobody's neighbour.
 */
export function nextDocumentSpot(
  board: MountedBoard,
  size: { w: number; h: number },
): { x: number; y: number } | undefined {
  const docs = documentBoxes(board);
  if (!docs.length) return undefined;

  // The shelf's own geometry: where it starts, and where its last row ends.
  const left = Math.min(...docs.map((d) => d.x));
  const lastRowY = Math.max(...docs.map((d) => d.y));
  const row = docs.filter((d) => Math.abs(d.y - lastRowY) <= 400);
  const rowRight = Math.max(...row.map((d) => d.x + d.w));
  const rowTop = Math.min(...row.map((d) => d.y));

  // Wrap when this page would push the row past the shelf's width, dropping to
  // a new line under the TALLEST page of the row — never under the last one,
  // which may be a half-page note the next row would then sit inside.
  const wouldEnd = rowRight + DOC_GAP + size.w;
  if (wouldEnd - left > SHELF_MAX_W) {
    const rowBottom = Math.max(...row.map((d) => d.y + d.h));
    return { x: left, y: rowBottom + DOC_GAP };
  }
  return { x: rowRight + DOC_GAP, y: rowTop };
}

/**
 * Lay every document out as one shelf, and say how many actually moved.
 *
 * This is a USER ACTION, never automatic. Moving someone's canvas under them is
 * the kind of help nobody asked for — a page parked deliberately beside a shot
 * is parked there for a reason. It exists because a board can already contain
 * documents placed before any of this was thought about, sitting on top of one
 * another with no way to tell from the canvas that there are two.
 *
 * The count is what the toast says. "Arranged 4 documents" over a board where
 * nothing needed arranging is a button that appears to do nothing; "Already
 * tidy" is an answer.
 */
export function arrangeDocuments(board: MountedBoard): number {
  const docs = documentBoxes(board);
  if (docs.length < 2) return 0;

  /**
   * Anchored at the shelf's own top-left, so a tidy-up does not TELEPORT the
   * board. The pages move relative to each other; the shelf stays where the
   * user last saw it, and the viewport still shows what it showed.
   */
  const at = { x: Math.min(...docs.map((d) => d.x)), y: Math.min(...docs.map((d) => d.y)) };
  const laid = flow(docs.map((d) => ({ w: d.w, h: d.h })), at, {
    gap: DOC_GAP,
    maxRowW: SHELF_MAX_W,
  });

  let moved = 0;
  board.store.transact(() => {
    docs.forEach((doc, i) => {
      const box = laid[i];
      if (!box) return;
      // Rounded before comparing: a note's xywh carries fractions after a drag,
      // and "moved by 0.4px" is not a move worth reporting or writing.
      const x = Math.round(box.x);
      const y = Math.round(box.y);
      if (Math.round(doc.x) === x && Math.round(doc.y) === y) return;
      const model: any = board.store.getBlock(doc.noteId)?.model;
      if (!model) return;
      board.store.updateBlock(model, {
        xywh: `[${x},${y},${Math.round(doc.w)},${Math.round(doc.h)}]`,
      });
      moved += 1;
    });
  });
  return moved;
}

/**
 * The spot a new document should take, already checked for room.
 *
 * One call, so every placement path gets both halves and none of them can
 * remember the shelf and forget the collision check.
 */
export function placementFor(
  board: MountedBoard,
  size: { w: number; h: number },
): { x: number; y: number } {
  const at = nextDocumentSpot(board, size);
  const [box] = reserveFlow(board.std, [size], { at, gap: DOC_GAP });
  return { x: box?.x ?? at?.x ?? 0, y: box?.y ?? at?.y ?? 0 };
}
