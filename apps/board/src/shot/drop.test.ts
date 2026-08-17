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

/**
 * Screen coordinates INSIDE a given shot's own box.
 *
 * These tests used to aim at fixed model points — (40, 40) was inside the first
 * card because the board was one strip starting at the origin. The board is a
 * grid now (`shot/layout.ts`) and rows start past a gutter wide enough for the
 * act and sequence brackets, so a fixed point aims at empty canvas. Asking the
 * card where it is expresses what the test always meant, and survives any
 * future change to the layout.
 */
function inShot(board: TestBoard, shotId: string) {
  const props = board.store.getBlock(shotId)!.model.props as { xywh: string };
  const [x, y, w, h] = JSON.parse(props.xywh) as number[];
  return screenAt(board, x + w / 2, y + h / 2);
}

/** Somewhere no shot is, whatever the layout does. */
function offBoard(board: TestBoard) {
  return screenAt(board, -8000, -8000);
}

describe('handleAssetDrop', () => {
  it('appends to the shot under the pointer and creates nothing on the canvas', async () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Kitchen']);
    const before = board.store.getBlock(board.surfaceId)!.model.children.length;
    const placeOnCanvas = vi.fn().mockResolvedValue(undefined);

    const out = await handleAssetDrop(board.std, entity(), inShot(board, shotId), placeOnCanvas);

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

    const at = offBoard(board);
    const out = await handleAssetDrop(board.std, entity(), at, placeOnCanvas);

    expect(out.target).toBe('canvas');
    expect(placeOnCanvas).toHaveBeenCalledOnce();
    expect(readShots(board.std)[0].media).toHaveLength(0);
  });

  it('routes to the shot the pointer is over, not the nearest one', async () => {
    const board = makeTestBoard();
    const [, second] = createShots(board.std, board.surfaceId, ['A', 'B']);
    const at = inShot(board, second);

    const out = await handleAssetDrop(board.std, entity(), at, vi.fn());
    expect(out.shotId).toBe(second);
  });

  /** Audio must never become a first frame, however it was dropped. */
  it('defaults a role by kind', async () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Kitchen']);
    const at = inShot(board, shotId);

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
    const at = inShot(board, shotId);

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

    await handleAssetDrop(board.std, entity(), inShot(board, shotId), vi.fn());
    expect(readShot(board.std, shotId)!.media[0].role).toBe('firstFrame');
  });

  it('fills a graphic’s generic composition well the same way', async () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Stat']);
    setShotFields(board.std, shotId, { kind: 'hyperframes' });
    stubZone(board, shotId, 'background');

    await handleAssetDrop(board.std, entity(), inShot(board, shotId), vi.fn());
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

    await handleAssetDrop(board.std, entity(), inShot(board, shotId), vi.fn());
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

    await handleAssetDrop(board.std, entity(), inShot(board, shotId), vi.fn());
    expect(readShot(board.std, shotId)!.media[0].role).toBe('reference');
  });

  /** A sound effect cannot be a first frame. The slot is ignored, not obeyed. */
  it('ignores a slot that makes no sense for the media', async () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Kitchen']);
    stubZone(board, shotId, 'firstFrame');

    await handleAssetDrop(
      board.std, entity({ kind: 'audio', name: 'hit.wav' }), inShot(board, shotId), vi.fn(),
    );
    expect(readShot(board.std, shotId)!.media[0].role).toBe('sfx');
  });

  /** Dropped on the card but not on a slot: the default by kind still applies. */
  it('falls back to the default role when the drop misses every slot', async () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Kitchen']);
    stubZone(board, shotId, null);

    await handleAssetDrop(board.std, entity(), inShot(board, shotId), vi.fn());
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

    const out = handleBlockDrop(board.std, block('stat-card'), inShot(board, shotId));

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

    handleBlockDrop(board.std, block('stat-card'), inShot(board, shotId));

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
    handleBlockDrop(board.std, block('stat-card'), inShot(board, shotId));
    expect(readShot(board.std, shotId)!.compositionVars).toEqual({ stat: '92%' });

    handleBlockDrop(board.std, block('quote-card', 'b2'), inShot(board, shotId));
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
      board.std, block('stat-card'), offBoard(board),
    );
    expect(out.target).toBe('refused');
    expect((out as { reason: string }).reason).toMatch(/onto a shot/i);
  });

  it('creates nothing on the canvas', () => {
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['A']);
    const before = board.store.getBlock(board.surfaceId)!.model.children.length;

    handleBlockDrop(board.std, block('stat-card'), inShot(board, shotId));

    expect(board.store.getBlock(board.surfaceId)!.model.children).toHaveLength(before);
    expect(readShot(board.std, shotId)!.media).toHaveLength(0);
  });
});

/**
 * DRAGGING BACK OFF A SHOT — the exit that did not exist.
 *
 * Media could get into a shot two ways and out none: the only way off a card was
 * the ✕ that deletes. So the canvas, which this design calls the scratch pad,
 * could not be used as one.
 *
 * The rules here decide whether that gesture rearranges the user's work or
 * quietly destroys some of it.
 */
describe('handleAssetDrop · dragging off a shot', () => {
  function withOrigin(
    e: AssetDragEntity,
    origin: NonNullable<AssetDragEntity['origin']>,
  ): AssetDragEntity {
    return { ...e, origin };
  }

  it('MOVES a reference to the canvas — it does not leave a copy behind', async () => {
    // A reference is an INPUT. Leaving a duplicate would mean the shot still
    // generates from something the user just pulled off it.
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Kitchen']);
    const mediaId = addMedia(board.std, shotId, {
      kind: 'image', role: 'reference',
      src: 's', url: 'u', name: 'still.png',
    })!;
    const placeOnCanvas = vi.fn().mockResolvedValue(undefined);

    const at = offBoard(board);
    const out = await handleAssetDrop(
      board.std, withOrigin(entity(), { shotId, mediaId }), at, placeOnCanvas,
    );

    expect(out.target).toBe('canvas');
    expect(placeOnCanvas).toHaveBeenCalledOnce();
    expect(readShot(board.std, shotId)!.media).toHaveLength(0);
  });

  it('COPIES a take to the canvas — the shot keeps its record of what it made', async () => {
    // A take is an OUTPUT, and the shot's own ledger of what it produced, what
    // it cost and what seed made it. Auditioning one at size must never be a
    // way of silently deleting it — discarding is the ✕, deliberately.
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Kitchen']);
    const mediaId = addMedia(board.std, shotId, {
      kind: 'image', role: 'reference',
      src: 's', url: 'u', name: 'still.png',
    })!;
    const placeOnCanvas = vi.fn().mockResolvedValue(undefined);

    const at = offBoard(board);
    await handleAssetDrop(
      board.std,
      // A take drag carries `takeId`, never `mediaId`.
      withOrigin(entity(), { shotId, takeId: 'take-1' }),
      at,
      placeOnCanvas,
    );

    expect(placeOnCanvas).toHaveBeenCalledOnce();
    // The reference list is untouched — a take drag must not reach into it.
    expect(readShot(board.std, shotId)!.media.map(m => m.id)).toEqual([mediaId]);
  });

  it('moves a reference from one shot to another, leaving none behind', async () => {
    const board = makeTestBoard();
    const [a, b] = createShots(board.std, board.surfaceId, ['One', 'Two']);
    const mediaId = addMedia(board.std, a, {
      kind: 'image', role: 'reference',
      src: 's', url: 'u', name: 'still.png',
    })!;
    const placeOnCanvas = vi.fn().mockResolvedValue(undefined);

    const at = inShot(board, b);
    const out = await handleAssetDrop(
      board.std, withOrigin(entity(), { shotId: a, mediaId }), at, placeOnCanvas,
    );

    expect(out).toMatchObject({ target: 'shot', shotId: b });
    expect(readShot(board.std, a)!.media).toHaveLength(0);
    expect(readShot(board.std, b)!.media).toHaveLength(1);
  });

  it('does NOTHING when a reference is dropped back on its own shot', async () => {
    // The most destructive possible reading of the least meaningful gesture: a
    // remove-and-re-add loses the role, the tag, the trim and the note, and
    // sends the tile to the end of its lane. Nudging a tile must be free.
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Kitchen']);
    const mediaId = addMedia(board.std, shotId, {
      kind: 'image', role: 'firstFrame',
      src: 's', url: 'u', name: 'still.png', tag: 'sarah',
    })!;
    const placeOnCanvas = vi.fn().mockResolvedValue(undefined);

    await handleAssetDrop(
      board.std, withOrigin(entity(), { shotId, mediaId }), inShot(board, shotId), placeOnCanvas,
    );

    const media = readShot(board.std, shotId)!.media;
    expect(media).toHaveLength(1);
    expect(media[0]!.id).toBe(mediaId);
    expect(media[0]!.role).toBe('firstFrame');
    expect(media[0]!.tag).toBe('sarah');
  });

  it('still COPIES from the panel, where there is no origin', async () => {
    // The library drag is unchanged: no origin means nothing to move from.
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ['Kitchen']);
    const placeOnCanvas = vi.fn().mockResolvedValue(undefined);

    await handleAssetDrop(board.std, entity(), inShot(board, shotId), placeOnCanvas);
    expect(readShot(board.std, shotId)!.media).toHaveLength(1);
  });
});

/**
 * REORDERING WITHIN A LANE.
 *
 * Order is not cosmetic here: a model receives references positionally —
 * `@Image1`, `@Image2` — and the prompt refers back to them by number, so moving
 * a tile changes what gets generated. `moveMedia` has existed since the
 * beginning and was reachable only by the agent.
 *
 * `insertionIndexAt` needs real laid-out DOM, which a headless test does not
 * have, so what is asserted here is the part that decides correctness: dropping
 * a tile back on its own shot must never destroy it.
 */
describe("handleAssetDrop · reordering in place", () => {
  it("keeps everything about a reference dropped back on its own shot", async () => {
    // No layout, so `insertionIndexAt` finds no strip and returns null — the
    // order is left alone. The tile must still come through untouched: role,
    // tag, trim and note are the things a remove-and-re-add would silently drop.
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ["Kitchen"]);
    const mediaId = addMedia(board.std, shotId, {
      kind: "image", role: "firstFrame",
      src: "s", url: "u", name: "still.png", tag: "sarah", note: "hold on her eyes",
    })!;
    const placeOnCanvas = vi.fn().mockResolvedValue(undefined);

    const out = await handleAssetDrop(
      board.std,
      { ...entity(), origin: { shotId, mediaId } },
      inShot(board, shotId),
      placeOnCanvas,
    );

    expect(out).toMatchObject({ target: "shot", shotId });
    const media = board.std && readShot(board.std, shotId)!.media;
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      id: mediaId, role: "firstFrame", tag: "sarah", note: "hold on her eyes",
    });
    // Never placed on the canvas — it did not leave the shot.
    expect(placeOnCanvas).not.toHaveBeenCalled();
  });

  it("leaves a take alone when it is dropped back on its own card", async () => {
    // Takes are ordered by when they were made. There is nothing to rearrange,
    // and the reference list must not be touched by a take gesture.
    const board = makeTestBoard();
    const [shotId] = createShots(board.std, board.surfaceId, ["Kitchen"]);
    const mediaId = addMedia(board.std, shotId, {
      kind: "image", role: "reference", src: "s", url: "u", name: "still.png",
    })!;
    const placeOnCanvas = vi.fn().mockResolvedValue(undefined);

    await handleAssetDrop(
      board.std,
      { ...entity(), origin: { shotId, takeId: "take-1" } },
      inShot(board, shotId),
      placeOnCanvas,
    );

    expect(readShot(board.std, shotId)!.media.map((m) => m.id)).toEqual([mediaId]);
    expect(placeOnCanvas).not.toHaveBeenCalled();
  });
});
