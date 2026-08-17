/**
 * The board must SAY it is a canvas, not merely be built like one.
 *
 * This is a one-line answer with a long tail, so the test is about the answer
 * rather than about any one consequence of it. What it prevents, concretely:
 * the stock `DocModeService` returns `null` from `getEditorMode()`, which is
 * neither `'page'` nor `'edgeless'` — a third value that no `mode === 'edgeless'`
 * guard in BlockSuite tests for, so every one of them silently took the page
 * branch.
 *
 * The measured cost was that clip and track cards could not be dragged on the
 * canvas AT ALL. The drag-handle widget's `_makeDropTarget` skips gfx blocks
 * only when the mode is exactly `'edgeless'`; with `null` it fell through and
 * made every attachment an HTML5 drag source, which swallows the pointerdown
 * the gfx layer needs to select and move the block — and then threw on release,
 * asking for the parent of a surface-parented block in page-drop code.
 *
 * Images were unaffected throughout, which is what made it look like a
 * rendering bug rather than a configuration one.
 */
import { DocModeProvider } from '@blocksuite/affine/shared/services';
import { describe, expect, it } from 'vitest';

import { makeTestBoard } from './test-board';

describe('the board’s doc mode', () => {
  it('reports edgeless — never null, which is what every guard misreads', () => {
    const board = makeTestBoard();
    const mode = board.std.get(DocModeProvider);

    expect(mode.getEditorMode()).toBe('edgeless');
    expect(mode.getPrimaryMode(board.pageId)).toBe('edgeless');
  });

  it('cannot be switched away from it', () => {
    // The board has no mode switch and is not getting one: one surface, one
    // meaning, because a board dragged into page shape is something the
    // compiler has no meaning for. So the setters are inert rather than a lie
    // that stores a value nothing reads.
    const board = makeTestBoard();
    const mode = board.std.get(DocModeProvider);

    mode.setEditorMode('page');
    mode.setPrimaryMode('page', board.pageId);
    expect(mode.togglePrimaryMode(board.pageId)).toBe('edgeless');
    expect(mode.getEditorMode()).toBe('edgeless');
  });

  it('hands back a real subscription, so a listener cannot leak', () => {
    const board = makeTestBoard();
    const sub = board.std.get(DocModeProvider).onPrimaryModeChange(() => {}, board.pageId);
    expect(typeof sub.unsubscribe).toBe('function');
    sub.unsubscribe();
  });
});
