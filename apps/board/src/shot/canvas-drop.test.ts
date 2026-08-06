/**
 * Dragging canvas media into a shot.
 *
 * The gesture itself is BlockSuite's (a gfx drag, driven by real pointer
 * events), so what is testable — and what actually breaks — is the PAYLOAD: what
 * a shot ends up holding when a canvas block lands on it. Every bug in this area
 * has been a url mix-up, and both directions are silent:
 *
 *   • the master in `src`  → a 104px tile pulls a 4K file, and the board that
 *     was fast becomes slow for reasons nobody can see;
 *   • the proxy in `url`   → the finished video is rendered from a thumbnail,
 *     and nobody finds out until it is published.
 */
import { describe, expect, it } from 'vitest';

import { makeTestBoard, placeTestImage } from '../blocksuite/test-board';
import { writeBlockMeta } from '../board/board-meta';
import { encodeMediaRef } from '../board/media-ref';
import { boardViewExtensions } from '../blocksuite/extensions.view';
import { CanvasMediaToShotExtension, canvasMediaFor } from './canvas-drop';

const MASTER = 'https://cdn.test/master-4k.png';
const PROXY = 'https://cdn.test/thumb-960.png';

function canvasImage(board: ReturnType<typeof makeTestBoard>) {
  const id = placeTestImage(board, '[0,1200,320,180]', {
    sourceId: encodeMediaRef({ src: PROXY, kind: 'image', mime: 'image/png', id: 'lib-1' }),
  });
  writeBlockMeta(board.doc, id, {
    mediaId: 'lib-1',
    scope: 'mine',
    kind: 'image',
    originalUrl: MASTER,
    name: 'the kitchen',
    createdBy: 'user',
  });
  return id;
}

describe('canvas media, as a shot would hold it', () => {
  it('keeps the display variant and the master apart', () => {
    const board = makeTestBoard();
    const media = canvasMediaFor(board.std, canvasImage(board))!;

    expect(media.kind).toBe('image');
    // The tile draws this.
    expect(media.src).toBe(PROXY);
    // Compile reads this.
    expect(media.url).toBe(MASTER);
    expect(media.name).toBe('the kitchen');
  });

  /** Library identity has to survive the move, or the compiled project cannot
   *  find the asset it was built from. */
  it('carries the Library id and scope across', () => {
    const board = makeTestBoard();
    const media = canvasMediaFor(board.std, canvasImage(board))!;
    expect(media.mediaId).toBe('lib-1');
    expect(media.scope).toBe('mine');
  });

  it('refuses a block that is not media', () => {
    const board = makeTestBoard();
    const noteId = board.store.addBlock('affine:note', {}, board.pageId);
    expect(canvasMediaFor(board.std, noteId)).toBeNull();
    expect(canvasMediaFor(board.std, 'nonexistent')).toBeNull();
  });

  /**
   * Registered as a real extension, not merely written. The board's view list is
   * built by a manager that only takes providers; this one is appended
   * separately, which is exactly the kind of wiring that gets dropped in a
   * refactor and fails silently — the drag would just go back to being a move.
   */
  it('is registered in the board’s view extensions', () => {
    expect(boardViewExtensions()).toContain(CanvasMediaToShotExtension);
  });
});
