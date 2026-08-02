/**
 * Where a dropped asset lands.
 *
 * THE BUG THIS SUITE EXISTS FOR: "drag an image on the canvas, drop it, then
 * drag it again and you find a duplicate." Every drop used to create a canvas
 * block that other code then repositioned, so there were always two systems with
 * an opinion about one object. A drop onto a shot now creates NOTHING — it
 * appends to a list — so the class of bug has no surface left to appear on.
 *
 * The tests drive `handleAssetDrop` directly rather than a synthetic drag: the
 * panel's drag is a NATIVE HTML5 drag, which cannot be driven from a test
 * runner. What is testable is the decision it makes, and that is the part that
 * was wrong.
 */
import { describe, expect, it, vi } from 'vitest';
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';

import { makeTestBoard, type TestBoard } from '../blocksuite/test-board';
import {
  ASSET_DRAG_TYPE, BLOCK_DRAG_TYPE, handleAssetDrop, handleBlockDrop,
  type AssetDragEntity, type BlockDragEntity,
} from './drop';
import { SHOT_GAP, SHOT_W } from './model';
import { addMedia, createShots, readShot, readShots, setShotFields } from './shots';
import { setBlockCatalogue } from './blocks';

function entity(over: Partial<AssetDragEntity['media']> = {}, dragId = 'd1'): AssetDragEntity {
  return {
    type: ASSET_DRAG_TYPE,
    dragId,
    media: {
      kind: 'image',
      src: 'https://example.test/thumb.png',
      url: 'https://example.test/master.png',
      name: 'still.png',
      ...over,
    },
  };
}

/** Screen coordinates for a model point, so a test aims where a user would. */
function screenAt(board: TestBoard, x: number, y: number) {
  const [clientX, clientY] = board.std.get(GfxControllerIdentifier).viewport.toViewCoord(x, y);
  return { clientX, clientY };
}

describe('handleAssetDrop', () => {
  it('appends to the shot under the pointer and creates nothing on the canvas', async () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Kitchen']);
    const before = board.store.getBlock(board.surfaceId)!.model.children.length;
    const placeOnCanvas = vi.fn().mockResolvedValue(undefined);

    const out = await handleAssetDrop(board.std, entity(), screenAt(board, 40, 40), placeOnCanvas);

    expect(out).toMatchObject({ target: 'shot', shotId });
    expect(readShot(board.std, shotId)!.media).toHaveLength(1);
    // THE POINT: no block was created, so there is nothing to duplicate, strand
    // or drag back out.
    expect(board.store.getBlock(board.surfaceId)!.model.children).toHaveLength(before);
    expect(placeOnCanvas).not.toHaveBeenCalled();
  });

  it('places on the open canvas when the drop misses every shot', async () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['Kitchen']);
    const placeOnCanvas = vi.fn().mockResolvedValue(undefined);

    const at = screenAt(board, SHOT_W + SHOT_GAP / 2, 40);
    const out = await handleAssetDrop(board.std, entity(), at, placeOnCanvas);

    expect(out.target).toBe('canvas');
    expect(placeOnCanvas).toHaveBeenCalledOnce();
    expect(readShots(board.std)[0].media).toHaveLength(0);
  });

  it('routes to the shot the pointer is over, not the nearest one', async () => {
    const board = makeTestBoard();
    const [, second] = createShots(board.std, board.surfaceId, ['A', 'B']);
    const at = screenAt(board, SHOT_W + SHOT_GAP + 20, 40);

    const out = await handleAssetDrop(board.std, entity(), at, vi.fn());
    expect(out.shotId).toBe(second);
  });

  /** Audio must never become a first frame, however it was dropped. */
  it('defaults a role by kind', async () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Kitchen']);
    const at = screenAt(board, 40, 40);

    await handleAssetDrop(board.std, entity({ kind: 'audio', name: 'hit.wav' }, 'd1'), at, vi.fn());
    await handleAssetDrop(board.std, entity({ kind: 'video', name: 'clip.mp4' }, 'd2'), at, vi.fn());

    const roles = Object.fromEntries(
      readShot(board.std, shotId)!.media.map(m => [m.name, m.role]),
    );
    expect(roles).toEqual({ 'hit.wav': 'sfx', 'clip.mp4': 'reference' });
  });

  /**
   * TWO DROPS OF THE SAME ASSET ARE TWO REFERENCES.
   *
   * The idempotency guard belongs to the GESTURE (`dragId`, enforced by the drop
   * target), not to the asset — a user who deliberately drops the same still on
   * two shots, or twice on one, means it.
   */
  it('treats a second deliberate drop as a second reference', async () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Kitchen']);
    const at = screenAt(board, 40, 40);

    await handleAssetDrop(board.std, entity({}, 'd1'), at, vi.fn());
    await handleAssetDrop(board.std, entity({}, 'd2'), at, vi.fn());

    const ids = readShot(board.std, shotId)!.media.map(m => m.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

/**
 * DROPPING ON A SLOT IS A STATEMENT, and honouring it saves a second action.
 *
 * `dropZoneAt` asks the card which zone a screen point is over, and the card
 * answers with `elementFromPoint` — which needs a laid-out document the test
 * host deliberately does not have (see the note at the top of this file). So
 * the zone is stubbed here and the DECISION is what gets tested, which is the
 * part that has been wrong: a still dropped squarely on FIRST FRAME arriving as
 * a generic reference is invisible until the wrong video comes back.
 */
describe('dropping onto a slot', () => {
  /**
   * Answer `zoneAt` with a fixed zone, the way a real card would.
   *
   * Stubbed on the VIEW LOOKUP rather than on the component: the host here is
   * detached, so BlockSuite never instantiates the Lit element and
   * `view.getBlock` returns null. `dropZoneAt` asks the view for the card and
   * then asks the card for the zone, so intercepting the lookup exercises the
   * same code path with a card that exists.
   */
  function stubZone(board: TestBoard, shotId: string, zone: string | null) {
    const view = board.std.view as unknown as { getBlock(id: string): unknown };
    const real = view.getBlock.bind(view);
    view.getBlock = (id: string) =>
      (id === shotId ? { zoneAt: () => zone } : real(id));
  }

  it('takes the role from the slot it was dropped on', async () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Kitchen']);
    stubZone(board, shotId, 'firstFrame');

    await handleAssetDrop(board.std, entity(), screenAt(board, 40, 40), vi.fn());
    expect(readShot(board.std, shotId)!.media[0].role).toBe('firstFrame');
  });

  it('fills a graphic’s generic composition well the same way', async () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Stat']);
    setShotFields(board.std, shotId, { kind: 'hyperframes' });
    stubZone(board, shotId, 'background');

    await handleAssetDrop(board.std, entity(), screenAt(board, 40, 40), vi.fn());
    expect(readShot(board.std, shotId)!.media[0].role).toBe('background');
  });

  /**
   * THE REGRESSION THIS PINS. A graphic's wells are its BLOCK'S OWN slots —
   * `screenshot`, `portrait`, whatever the author named them. The check used to
   * be a fixed list, which answered false for every one of them, so the drop
   * fell through to a plain reference: the picture landed on the card and the
   * well it was dropped on stayed empty.
   */
  it('fills a well the BLOCK named, not just the built-in vocabulary', async () => {
    setBlockCatalogue([{
      name: 'browser-mockup', tier: 'starter', fill: 'slots',
      slots: { screenshot: { kind: 'image', sel: '.win img' } },
    }]);
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Launch']);
    setShotFields(board.std, shotId, { kind: 'hyperframes', composition: 'browser-mockup' });
    stubZone(board, shotId, 'screenshot');

    await handleAssetDrop(board.std, entity(), screenAt(board, 40, 40), vi.fn());
    expect(readShot(board.std, shotId)!.media[0].role).toBe('screenshot');
  });

  /** A well that belongs to a DIFFERENT block is not a legal target here. */
  it('ignores a well the chosen block does not declare', async () => {
    setBlockCatalogue([{
      name: 'browser-mockup', tier: 'starter', fill: 'slots',
      slots: { screenshot: { kind: 'image' } },
    }]);
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Launch']);
    setShotFields(board.std, shotId, { kind: 'hyperframes', composition: 'browser-mockup' });
    stubZone(board, shotId, 'portrait');

    await handleAssetDrop(board.std, entity(), screenAt(board, 40, 40), vi.fn());
    expect(readShot(board.std, shotId)!.media[0].role).toBe('reference');
  });

  /** A sound effect cannot be a first frame. The slot is ignored, not obeyed. */
  it('ignores a slot that makes no sense for the media', async () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Kitchen']);
    stubZone(board, shotId, 'firstFrame');

    await handleAssetDrop(
      board.std, entity({ kind: 'audio', name: 'hit.wav' }), screenAt(board, 40, 40), vi.fn(),
    );
    expect(readShot(board.std, shotId)!.media[0].role).toBe('sfx');
  });

  /** Dropped on the card but not on a slot: the default by kind still applies. */
  it('falls back to the default role when the drop misses every slot', async () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Kitchen']);
    stubZone(board, shotId, null);

    await handleAssetDrop(board.std, entity(), screenAt(board, 40, 40), vi.fn());
    expect(readShot(board.std, shotId)!.media[0].role).toBe('reference');
  });
});

/**
 * DROPPING A BLOCK IS NOT DROPPING MEDIA.
 *
 * A block has no url and no bytes; it says what the shot IS. So it takes its
 * own path — the media list is untouched, and two props change instead.
 */
describe('handleBlockDrop', () => {
  const block = (name: string, dragId = 'b1'): BlockDragEntity => ({
    type: BLOCK_DRAG_TYPE, dragId, name, label: name,
  });

  it('turns the shot under the pointer into a graphic built from that block', () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['The stat']);

    const out = handleBlockDrop(board.std, block('stat-card'), screenAt(board, 40, 40));

    expect(out).toMatchObject({ target: 'shot', shotId, title: 'The stat' });
    const shot = readShot(board.std, shotId)!;
    expect(shot.kind).toBe('hyperframes');
    expect(shot.composition).toBe('stat-card');
  });

  /**
   * THE SHOT'S WORK SURVIVES. Someone who wrote a voiceover and gathered three
   * references, then decided the beat is a title card, has not thrown any of
   * that away — the references are what will fill the block's slots.
   */
  it('keeps the shot’s text, media and length', () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['The stat']);
    setShotFields(board.std, shotId, {
      voiceover: 'Ninety-two percent.', action: 'the number lands', durationSec: 4,
    });
    addMedia(board.std, shotId, { ...entity().media, role: 'reference' as const });

    handleBlockDrop(board.std, block('stat-card'), screenAt(board, 40, 40));

    const shot = readShot(board.std, shotId)!;
    expect(shot.voiceover).toBe('Ninety-two percent.');
    expect(shot.action).toBe('the number lands');
    expect(shot.durationSec).toBe(4);
    expect(shot.media).toHaveLength(1);
  });

  /**
   * THE ONE DELIBERATE LOSS. Slot values belong to the block that declared
   * them, so carrying `stat: "92%"` into a quote card would put a number where
   * the quote goes.
   */
  it('clears the previous block’s slot values, and only when the block changed', () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['The stat']);
    setShotFields(board.std, shotId, {
      kind: 'hyperframes', composition: 'stat-card', compositionVars: { stat: '92%' },
    });

    // Re-dropping the SAME block is a no-op on the values someone typed.
    handleBlockDrop(board.std, block('stat-card'), screenAt(board, 40, 40));
    expect(readShot(board.std, shotId)!.compositionVars).toEqual({ stat: '92%' });

    handleBlockDrop(board.std, block('quote-card', 'b2'), screenAt(board, 40, 40));
    const shot = readShot(board.std, shotId)!;
    expect(shot.composition).toBe('quote-card');
    expect(shot.compositionVars).toEqual({});
  });

  /**
   * "Nothing happened" is the worst answer to a reasonable gesture. A block on
   * open canvas has nothing to compose, so the drop is refused OUT LOUD.
   */
  it('refuses the open canvas with a sentence, not silence', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['A']);

    const out = handleBlockDrop(
      board.std, block('stat-card'), screenAt(board, 4000, 4000),
    );
    expect(out.target).toBe('refused');
    expect((out as { reason: string }).reason).toMatch(/onto a shot/i);
  });

  it('creates nothing on the canvas', () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['A']);
    const before = board.store.getBlock(board.surfaceId)!.model.children.length;

    handleBlockDrop(board.std, block('stat-card'), screenAt(board, 40, 40));

    expect(board.store.getBlock(board.surfaceId)!.model.children).toHaveLength(before);
    expect(readShot(board.std, shotId)!.media).toHaveLength(0);
  });
});
