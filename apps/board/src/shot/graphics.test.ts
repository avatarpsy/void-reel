/**
 * Graphic layers: a shot's picture and the graphics that run over it.
 *
 * The rules here decide whether a graphic stays on the right picture after the
 * user does the thing they always do — generate another take, pick a different
 * one, and re-cut in the editor. Each test names the failure it prevents.
 */
import { describe, expect, it } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import {
  checkGraphic, defaultGraphicMode, isBaked, readyGraphics, type ShotGraphic,
} from './model';
import {
  addGraphic, createShots, readShot, removeGraphic, reorderGraphic, updateGraphic,
} from './shots';

function newShot() {
  const board = makeTestBoard();
  const [id] = createShots(board.std, board.surfaceId, ['Wide']);
  return { board, id };
}

describe('graphic layers on a shot', () => {
  it('starts empty, so nothing changes for a shot that has none', () => {
    const { board, id } = newShot();
    expect(readShot(board.std, id)!.graphics).toEqual([]);
  });

  it('adds a layer with no block yet — an unconfigured layer is a legal state', () => {
    // The card shows a picker for this. Refusing to create a layer without a
    // block would mean the only way to add one is to choose blindly first.
    const { board, id } = newShot();

    const gid = addGraphic(board.std, id);

    const gs = readShot(board.std, id)!.graphics;
    expect(gs).toHaveLength(1);
    expect(gs[0].id).toBe(gid);
    expect(gs[0].block).toBe('');
    expect(gs[0].anchor).toBe('start');
    // 0 = to the end of the shot, which is what a lower third usually wants.
    expect(gs[0].durationSec).toBe(0);
  });

  it('CREATES the graphics key on a shot that predates it', () => {
    // THE migration trap, and it is silent. A BlockSuite schema default applies
    // only to blocks created afterwards, so `graphics` is undefined on every
    // board already on disk. A helper that bailed on a missing list would make
    // "add a graphic" do nothing at all, with no error, on exactly the boards
    // holding real work.
    const { board, id } = newShot();
    const block = board.std.store.getBlock(id)!;
    board.std.store.updateBlock(block.model, () => {
      delete (block.model.props as Record<string, unknown>).graphics;
    });
    expect((block.model.props as Record<string, unknown>).graphics).toBeUndefined();

    const gid = addGraphic(board.std, id, { block: 'lt-clean-bar' });

    expect(gid).toBeTruthy();
    expect(readShot(board.std, id)!.graphics.map(g => g.block)).toEqual(['lt-clean-bar']);
  });

  it('hands out a COPY of slots, so a read cannot write through to the document', () => {
    // `slots` is a nested Yjs-backed map. Passing the live proxy through would
    // both let a reader mutate the board and kill the whole postMessage the
    // moment a digest carried it.
    const { board, id } = newShot();
    addGraphic(board.std, id, { block: 'stat-card', slots: { stat: '92%' } });

    const first = readShot(board.std, id)!.graphics[0];
    first.slots.stat = 'tampered';

    expect(readShot(board.std, id)!.graphics[0].slots.stat).toBe('92%');
  });

  it('clears the render when what is rendered changes', () => {
    // Otherwise the next compile compares against a stale hash, decides nothing
    // changed, and ships the previous graphic with the previous words on it.
    const { board, id } = newShot();
    const gid = addGraphic(board.std, id, { block: 'stat-card', slots: { stat: '92%' } })!;
    updateGraphic(board.std, id, gid, {
      renderedUrl: 'https://example.test/a.webm',
      renderHash: 'hash-a',
      renderedDurationSec: 3,
    });

    updateGraphic(board.std, id, gid, { slots: { stat: '48%' } });

    const g = readShot(board.std, id)!.graphics[0];
    expect(g.renderedUrl).toBe('');
    expect(g.renderHash).toBe('');
  });

  it('keeps the render when compile is the one writing it back', () => {
    // The inverse of the rule above: if recording a result also cleared it,
    // compile could never store anything it made.
    const { board, id } = newShot();
    const gid = addGraphic(board.std, id, { block: 'stat-card' })!;

    updateGraphic(board.std, id, gid, {
      renderedUrl: 'https://example.test/a.webm',
      renderHash: 'hash-a',
    });

    const g = readShot(board.std, id)!.graphics[0];
    expect(g.renderedUrl).toBe('https://example.test/a.webm');
    expect(g.renderHash).toBe('hash-a');
  });

  it('moving a layer does not disturb the others', () => {
    const { board, id } = newShot();
    addGraphic(board.std, id, { block: 'a' });
    const b = addGraphic(board.std, id, { block: 'b' })!;
    addGraphic(board.std, id, { block: 'c' });

    reorderGraphic(board.std, id, b, 0);

    expect(readShot(board.std, id)!.graphics.map(g => g.block)).toEqual(['b', 'a', 'c']);
  });

  it('removes one layer and leaves the rest', () => {
    const { board, id } = newShot();
    const a = addGraphic(board.std, id, { block: 'a' })!;
    addGraphic(board.std, id, { block: 'b' });

    expect(removeGraphic(board.std, id, a)).toBe(true);
    expect(readShot(board.std, id)!.graphics.map(g => g.block)).toEqual(['b']);
  });

  it('only counts a layer as ready when it has BOTH a block and a file', () => {
    const gs = [
      { id: '1', block: 'a', slots: {}, offsetSec: 0, durationSec: 0, anchor: 'start' },
      { id: '2', block: '', slots: {}, offsetSec: 0, durationSec: 0, anchor: 'start', renderedUrl: 'x.webm' },
      { id: '3', block: 'c', slots: {}, offsetSec: 0, durationSec: 0, anchor: 'start', renderedUrl: 'y.webm' },
    ] as ShotGraphic[];

    expect(readyGraphics(gs).map(g => g.id)).toEqual(['3']);
  });
});

describe('over the picture, or baked into it', () => {
  it('defaults to OVERLAY, the one that can be undone', () => {
    // A bake is bound to a take, is not retimable, and re-renders from scratch
    // at a cost that scales with the footage. Defaulting to it would make the
    // cheap, reversible choice the one you have to know to ask for.
    const { board, id } = newShot();
    const gid = addGraphic(board.std, id, { block: 'lt-clean-bar' })!;
    expect(readShot(board.std, id)!.graphics[0].mode).toBe('overlay');
    expect(isBaked(readShot(board.std, id)!.graphics.find(g => g.id === gid)!)).toBe(false);
  });

  it('NEVER starts as a bake, whatever the block claims about itself', () => {
    // An earlier draft derived this from the block's `overlay` flag and was
    // wrong twice: a block with no manifest opinion normalises to false, so
    // "the designer says full-frame" and "nobody said anything" were the same
    // value — and a bake needs a take that a storyboard shot usually has not
    // got yet, so it would refuse to render until the user went elsewhere first.
    expect(defaultGraphicMode()).toBe('overlay');
  });

  it('warns when an OVERLAY is built from a block that fills the frame', () => {
    // The flag earns its keep here instead: this is the case it actually
    // predicts, and the failure it prevents is a graphic that renders perfectly
    // and hides the shot.
    const g = { block: 'stat-card', mode: 'overlay' as const };
    expect(checkGraphic(g, { overlay: false }, true).join(' '))
      .toContain('will cover the picture');
    expect(checkGraphic(g, { overlay: true }, true)).toEqual([]);
    // Nothing to say about a layer with no block yet.
    expect(checkGraphic({ block: '', mode: 'overlay' }, { overlay: false }, true)).toEqual([]);
  });

  it('warns when a BAKE has nothing to bake onto', () => {
    const g = { block: 'stat-card', mode: 'bake' as const };
    const slotted = { overlay: false, slots: [{ kind: 'video' }] };
    expect(checkGraphic(g, slotted, false).join(' ')).toContain('needs a picture');
    expect(checkGraphic(g, slotted, true)).toEqual([]);
  });

  it('warns when a BAKE would hide the shot behind an opaque block', () => {
    // A bake puts the picture in the block's VIDEO SLOT when it declares one.
    // With no such slot it goes behind the composition — and 13 of the installed
    // starters fill #root with an opaque colour, which covers it completely. The
    // render succeeds and the footage is simply not in it.
    const g = { block: 'stat-card', mode: 'bake' as const };

    expect(checkGraphic(g, { overlay: false, slots: [{ kind: 'text' }] }, true).join(' '))
      .toContain('would hide the shot');

    // A block that HOLDS footage has somewhere to put it, so no warning.
    expect(checkGraphic(g, { overlay: false, slots: [{ kind: 'video' }] }, true)).toEqual([]);
    // A transparent block has nothing to hide it with.
    expect(checkGraphic(g, { overlay: true, slots: [] }, true)).toEqual([]);
  });

  it('switching mode DISCARDS the render', () => {
    // A transparent graphic and a graphic with the footage baked into it are
    // different files. Keeping the old one would ship an overlay where a bake
    // was asked for, which on the timeline is a graphic floating on black.
    const { board, id } = newShot();
    const gid = addGraphic(board.std, id, { block: 'stat-card' })!;
    updateGraphic(board.std, id, gid, {
      renderedUrl: 'https://example.test/a.webm', renderHash: 'h1', renderedDurationSec: 3,
    });

    updateGraphic(board.std, id, gid, { mode: 'bake' });

    const g = readShot(board.std, id)!.graphics[0];
    expect(g.mode).toBe('bake');
    expect(g.renderedUrl).toBe('');
    expect(g.renderHash).toBe('');
  });

  it('moving a layer does NOT discard its render', () => {
    // The inverse, and the reason the two lists are separate: where a layer sits
    // is not what it looks like. Re-rendering on a nudge would make retiming
    // cost money.
    const { board, id } = newShot();
    const gid = addGraphic(board.std, id, { block: 'stat-card' })!;
    updateGraphic(board.std, id, gid, { renderedUrl: 'https://example.test/a.webm' });

    updateGraphic(board.std, id, gid, { offsetSec: 2, anchor: 'end' });

    expect(readShot(board.std, id)!.graphics[0].renderedUrl)
      .toBe('https://example.test/a.webm');
  });
});
