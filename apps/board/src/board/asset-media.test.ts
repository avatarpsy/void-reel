/**
 * Placing a clip on the open canvas — specifically, HOW BIG.
 *
 * `addAttachments` has one size for everything it makes: `cubeThick`, 170×132.
 * That is the file-chip size, and it is right for a chip. For a clip it is a
 * thumbnail with a play button too small to hit and a caption too small to read,
 * which is the whole of "I drag a video out and I can't expand it or play it".
 */
import { describe, expect, it } from 'vitest';

import { makeTestBoard, placeTestImage } from '../blocksuite/test-board';
import { SHOT_W } from '../shot/model';
import { normaliseMediaCard, placeAsset, probedClipBox } from './asset-media';

function boxOf(board: ReturnType<typeof makeTestBoard>, blockId: string): number[] {
  const props = board.store.getBlock(blockId)!.model.props as { xywh: string };
  return JSON.parse(props.xywh) as number[];
}

describe('placing a clip on the canvas', () => {
  it('lands at a size somebody can press play on, and at 16:9', async () => {
    // The probe runs on the network AFTER the card exists, so the shape it lands
    // in is the shape it has for as long as that takes — a stalled or dead
    // source leaves it there for good.
    const board = makeTestBoard();
    const result = await placeAsset(board.std, {
      displayUrl: 'https://example.test/clip.mp4',
      kind: 'video',
      name: 'clip.mp4',
      clientPoint: [400, 300],
    });

    expect(result.ok).toBe(true);
    const [, , w, h] = boxOf(board, (result as { blockId: string }).blockId);
    expect(w).toBe(360);
    // 16:9 to within the rounding, NOT the 170×132 chip it used to be.
    expect(Math.abs(w / h - 16 / 9)).toBeLessThan(0.02);
  });

  it('grows about its centre, so it stays where it was dropped', async () => {
    // `addAttachments` centres the block on the drop point. Resizing from the
    // top-left afterwards would slide the card off the spot the user aimed at —
    // by nearly two hundred pixels, on the way from 170 wide to 360.
    const board = makeTestBoard();
    const result = await placeAsset(board.std, {
      displayUrl: 'https://example.test/clip.mp4',
      kind: 'video',
      name: 'clip.mp4',
      clientPoint: [400, 300],
    });

    const [x, y, w, h] = boxOf(board, (result as { blockId: string }).blockId);
    // The centre `addAttachments` chose, recovered from the box it made. Within
    // a pixel, because the box is integral and an odd height cannot be halved.
    expect(Math.abs(x + w / 2 - 400)).toBeLessThanOrEqual(1);
    expect(Math.abs(y + h / 2 - 300)).toBeLessThanOrEqual(1);
  });
});

describe('the box a clip takes once its real shape is known', () => {
  const box = (s: string | null) => (s ? JSON.parse(s) as number[] : null);

  it('takes the clip’s own aspect', () => {
    // A card that keeps the 16:9 it was placed at while holding something else
    // crops it to a letterbox slot — the same "why is my video squashed" report
    // from the other side. 4:3 rather than 9:16 so the cap plays no part.
    const [, , w, h] = box(probedClipBox([0, 0, 360, 203], { w: 1024, h: 768 }))!;
    expect(w).toBe(360);
    expect(h).toBe(270);
  });

  it('caps a portrait clip so it does not become a wall', () => {
    // 9:16 at 360 wide is 640 tall — three times the height of the storyboard
    // panels beside it, and taller than the viewport at a useful zoom.
    const [, , w, h] = box(probedClipBox([0, 0, 360, 203], { w: 1080, h: 1920 }))!;
    expect(h).toBe(420);
    expect(w).toBe(236);
    expect(Math.abs(w / h - 1080 / 1920)).toBeLessThan(0.01);
  });

  it('leaves a card the user has already resized alone', () => {
    // The probe can be six seconds behind the drop. Narrowing a card somebody
    // has since sized by hand, to obey a default they never chose, is worse
    // than a tall card — so only the aspect is corrected, never the width.
    const [, , w, h] = box(probedClipBox([0, 0, 800, 450], { w: 1080, h: 1920 }))!;
    expect(w).toBe(800);
    expect(h).toBe(1422);
  });

  it('writes nothing when the box is already right', () => {
    // A no-op write is an undo step that does nothing, and a document
    // revision — which invalidates every per-revision cache on the board.
    expect(probedClipBox([0, 0, 360, 203], { w: 1600, h: 902 })).toBeNull();
  });

  it('grows about its centre', () => {
    const [x, y, w, h] = box(probedClipBox([100, 100, 360, 203], { w: 1080, h: 1920 }))!;
    expect(x + w / 2).toBe(100 + 360 / 2);
    expect(Math.abs(y + h / 2 - (100 + 203 / 2))).toBeLessThanOrEqual(1);
  });
});

/**
 * THE IMAGE PATH, tested where it can be.
 *
 * `addImages` needs a real image decoder to resolve and happy-dom has none, so an
 * integration test of image placement HANGS rather than failing — which is why
 * every test above is about a clip. `normaliseMediaCard` is the arithmetic that
 * was actually wrong, exported for exactly this reason (the same trade
 * `probedClipBox` makes).
 */
describe('normalising a placed image card', () => {
  const boxProps = (w: number, h: number) => ({ width: w, height: h });

  it('caps the 960 × 1707 still from the bug report', () => {
    const board = makeTestBoard();
    // What `addImages(…, { maxWidth: 960 })` left behind for a 1080×1920 source.
    const id = placeTestImage(board, '[0,0,960,1707]', boxProps(960, 1707));

    const box = normaliseMediaCard(board.std, id, 'image');
    expect(box).toEqual({ w: 236, h: 420 });

    const [, , w, h] = boxOf(board, id);
    expect([w, h]).toEqual([236, 420]);
  });

  it('writes width/height as well as the box, so the pair cannot disagree', () => {
    const board = makeTestBoard();
    const id = placeTestImage(board, '[0,0,960,1707]', boxProps(960, 1707));
    normaliseMediaCard(board.std, id, 'image');

    const props = board.store.getBlock(id)!.model.props as { width: number; height: number };
    expect([props.width, props.height]).toEqual([236, 420]);
  });

  it('brings a SMALL source UP to the box, so a mixed row is one row', () => {
    const board = makeTestBoard();
    const id = placeTestImage(board, '[0,0,320,180]', boxProps(320, 180));
    expect(normaliseMediaCard(board.std, id, 'image')).toEqual({ w: 360, h: 203 });
  });

  it('keeps the aspect of a landscape still', () => {
    const board = makeTestBoard();
    const id = placeTestImage(board, '[0,0,960,540]', boxProps(960, 540));
    const box = normaliseMediaCard(board.std, id, 'image')!;
    expect(Math.abs(box.w / box.h - 16 / 9)).toBeLessThan(0.02);
  });

  it('gives a lone generated result the bigger HERO box', () => {
    const board = makeTestBoard();
    const id = placeTestImage(board, '[0,0,1024,1024]', boxProps(1024, 1024));
    const ref = normaliseMediaCard(board.std, id, 'image', 'ref')!;

    const board2 = makeTestBoard();
    const id2 = placeTestImage(board2, '[0,0,1024,1024]', boxProps(1024, 1024));
    const hero = normaliseMediaCard(board2.std, id2, 'image', 'hero')!;

    expect(hero.w).toBeGreaterThan(ref.w);
    expect(hero.w).toBe(SHOT_W);
  });

  it('writes NOTHING when the card is already right', () => {
    // A no-op write is an undo step that does nothing and a revision that
    // invalidates every per-revision cache on the board.
    const board = makeTestBoard();
    const id = placeTestImage(board, '[0,0,360,203]', boxProps(360, 203));
    expect(normaliseMediaCard(board.std, id, 'image')).toBeNull();
  });
});
