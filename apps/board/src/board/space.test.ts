/**
 * WHERE THERE IS ROOM — the regression guard for the overlap report.
 *
 * "It's overlapping things on the board." It was, and the cause was not layout
 * arithmetic but a FIXED POINT: the media paths placed at `{ x: 0, y: SHOT_H +
 * 240 }` = (0, 1260), which is inside scene row 2 of the storyboard grid
 * (y 1076–2096) and inside the gutter the spine draws its brackets into
 * (x 0–360). Being fixed, it also landed on its own previous result every time.
 *
 * `clearOfOwned` and `relaxOverlaps` existed and would have caught it, but they
 * were reachable only from `board_draw` — so the tests here are as much about
 * the media paths being able to CALL this as about the maths.
 */
import { describe, expect, it } from 'vitest';

import { makeTestBoard, placeTestImage } from '../blocksuite/test-board';
import { readCanvas } from './canvas';
import { SHOT_H, SHOT_W } from '../shot/model';
import { createShots } from '../shot/shots';
import { writeScript } from '../shot/screenplay-doc';
import { REF_W } from './metrics';
import {
  type Box, THINKING_EDGE, bboxOf, clearanceBelow, flow, occupancy, overlaps, ownedBand,
  reserveFlow, thinkingOrigin,
} from './space';

const ref = { w: REF_W, h: 203 };

describe('flow — reading order survives the layout', () => {
  it('runs left to right on one row while it fits', () => {
    const out = flow([ref, ref, ref], { x: 0, y: 0 }, { gap: 40, maxRowW: 2000 });
    expect(out.map(b => b.y)).toEqual([0, 0, 0]);
    expect(out.map(b => b.x)).toEqual([0, 400, 800]);
  });

  it('wraps BEFORE placing, so a card never starts beyond the row', () => {
    // 800 fits exactly two 360-wide cards with a 40 gap (0..360, 400..760).
    const out = flow([ref, ref, ref], { x: 0, y: 0 }, { gap: 40, maxRowW: 800 });
    expect(out[0]).toMatchObject({ x: 0, y: 0 });
    expect(out[1]).toMatchObject({ x: 400, y: 0 });
    // The third would end at 1160 > 800, so it starts the next row at the left.
    expect(out[2]).toMatchObject({ x: 0 });
    expect(out[2].y).toBeGreaterThan(0);
  });

  it('makes each row as tall as its TALLEST card', () => {
    const tall = { w: 236, h: 420 };
    const out = flow([tall, ref, ref], { x: 0, y: 0 }, { gap: 40, maxRowW: 700 });
    // 236 + 40 + 360 = 636 fits; the third card would reach 1036 and wraps.
    // Row 2 clears the 420-tall card, not the 203-tall one beside it.
    expect(out[2].y).toBe(420 + 40);
  });

  it('never overlaps within its own batch, at any mix of sizes', () => {
    const sizes = [
      { w: 360, h: 203 }, { w: 236, h: 420 }, { w: 360, h: 360 },
      { w: 360, h: 203 }, { w: 236, h: 420 }, { w: 360, h: 203 },
      { w: 360, h: 203 },
    ];
    const out = flow(sizes, { x: 0, y: 0 });
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(overlaps(out[i], out[j])).toBe(false);
      }
    }
  });
});

describe('clearanceBelow — down, never sideways, never up', () => {
  const box: Box = { x: 0, y: 0, w: 100, h: 100 };

  it('is zero when nothing is in the way', () => {
    expect(clearanceBelow(box, [{ x: 500, y: 500, w: 100, h: 100 }])).toBe(0);
  });

  it('is zero for something merely CLOSE, not overlapping', () => {
    // The padded-overlap bug: testing with the separation distance turned a
    // deliberate nine-month row into a staircase, which looks like a decision.
    expect(clearanceBelow(box, [{ x: 0, y: 101, w: 100, h: 100 }])).toBe(0);
    expect(clearanceBelow(box, [{ x: 101, y: 0, w: 100, h: 100 }])).toBe(0);
  });

  it('clears a single obstacle', () => {
    const dy = clearanceBelow(box, [{ x: 0, y: 50, w: 100, h: 100 }]);
    expect(dy).toBeGreaterThan(0);
    expect(overlaps({ ...box, y: box.y + dy }, { x: 0, y: 50, w: 100, h: 100 })).toBe(false);
  });

  it('re-checks from the top, because clearing one can land on another', () => {
    const obstacles = [
      { x: 0, y: 50, w: 100, h: 100 },
      { x: 0, y: 200, w: 100, h: 100 },
    ];
    const dy = clearanceBelow(box, obstacles);
    for (const o of obstacles) {
      expect(overlaps({ ...box, y: box.y + dy }, o)).toBe(false);
    }
  });
});

describe('reserveFlow on a real board', () => {
  /** The one thing the fixed origin got wrong, asserted directly. */
  it('NEVER lands a batch on the storyboard', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['one', 'two', 'three']);

    const slots = reserveFlow(board.std, [ref, ref, ref, ref, ref, ref]);

    const band = ownedBand(board.std)!;
    expect(band).toBeTruthy();
    for (const slot of slots) {
      expect(overlaps(slot, band)).toBe(false);
    }
  });

  it('moves off the old fixed point when something is standing there', () => {
    /**
     * (0, SHOT_H + 240) = (0, 1260), asked for explicitly — so this is about the
     * allocator refusing a bad origin rather than about nobody passing one.
     *
     * AND IT IS ONLY BAD ON A BOARD WITH WORK ON IT, which is what made the
     * original bug survive: with a single scene row, 1260 is genuinely clear.
     * It collides once the grid has a second row (row 2 is y 1076–2096) or once
     * a previous placement has already used the spot — and because the point was
     * fixed, the second condition was met by its own last result every time.
     */
    const board = makeTestBoard();
    placeTestImage(board, `[0,${SHOT_H + 240},360,203]`);

    const [slot] = reserveFlow(board.std, [ref], { at: { x: 0, y: SHOT_H + 240 } });
    // Pushed DOWN, and the x it was given is untouched — horizontal position
    // carries the meaning.
    expect(slot.x).toBe(0);
    expect(slot.y).toBeGreaterThan(SHOT_H + 240);
  });

  it('does not land a second batch on the first', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['one']);

    const first = reserveFlow(board.std, [ref, ref]);
    // Committed, the way the RPC commits them — the next call has to see them.
    for (const slot of first) {
      placeTestImage(board, `[${slot.x},${slot.y},${slot.w},${slot.h}]`);
    }

    const second = reserveFlow(board.std, [ref, ref]);
    for (const a of first) {
      for (const b of second) expect(overlaps(a, b)).toBe(false);
    }
  });

  it('excludes the batch’s own blocks, or it walks off the board', () => {
    // By the time media is arranged its blocks already exist — they had to, to
    // be sized from the real files. Without `exclude` each card is an obstacle
    // to itself and the whole batch marches downward for ever.
    const board = makeTestBoard();
    const ids = [
      placeTestImage(board, '[0,3000,360,203]'),
      placeTestImage(board, '[400,3000,360,203]'),
    ];

    const kept = reserveFlow(board.std, [ref, ref], {
      at: { x: 0, y: 3000 },
      exclude: ids,
    });
    expect(kept.map(s => s.y)).toEqual([3000, 3000]);

    const shoved = reserveFlow(board.std, [ref, ref], { at: { x: 0, y: 3000 } });
    expect(shoved[0].y).toBeGreaterThan(3000);
  });

  it('keeps the batch’s internal geometry — it moves as ONE', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['one', 'two']);

    const at = { x: 0, y: 0 };
    const free = flow([ref, ref, ref], at);
    const reserved = reserveFlow(board.std, [ref, ref, ref], { at });

    // Every member shifted by the same dy, so the row is still a row.
    const dys = reserved.map((b, i) => b.y - free[i].y);
    expect(new Set(dys).size).toBe(1);
    expect(reserved.map(b => b.x)).toEqual(free.map(b => b.x));
  });
});

describe('occupancy and the owned band', () => {
  it('grows the storyboard by the spine margin, because the spine is not ON the canvas', () => {
    // Acts, sequences and scene brackets are an SVG overlay drawn in model space
    // (`ui/spine.ts`), so they appear in no read and no layout pass can see them.
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['one']);

    const shot = readCanvas(board.std).find(i => i.kind === 'shot')!;
    const band = ownedBand(board.std)!;
    // A margin on every side of the card — the strip's real footprint is wider
    // than its cards, because the brackets and scene labels sit beside it.
    expect(band.x).toBeLessThan(shot.x);
    expect(band.y).toBeLessThan(shot.y);
    expect(band.w).toBeGreaterThan(SHOT_W);
    expect(band.h).toBeGreaterThan(SHOT_H);
  });

  /**
   * THE THINKING REGION, which is the structural half of the fix.
   *
   * The storyboard grows DOWN (a row per scene) and RIGHT (a column per shot), so
   * anything below or beside it is in the path of ordinary work. x < 0 is the only
   * half-plane neither can reach.
   */
  /**
   * THE BOUNDARY IS DERIVED, NOT GUESSED.
   *
   * x < 0 is not empty: the SCREENPLAY panel lives at `-(SCREENPLAY_W + gutter)`
   * because it reads before shot 1. A boundary of `-CARD_GAP` put thinking on top
   * of the script, and the allocator then pushed every batch below the whole
   * screenplay — not broken, but it lost the row alignment a scene's references
   * depend on. This pins the two together.
   */
  it('clears the SCREENPLAY, which also lives left of the origin', () => {
    const board = makeTestBoard();
    writeScript(board.std, board.surfaceId, [
      'INT. KITCHEN — DAY',
      'She fills the kettle.',
    ].join('\n'));

    const script = readCanvas(board.std).find(i => i.kind === 'screenplay')!;
    expect(THINKING_EDGE).toBeLessThanOrEqual(script.x);

    // And a batch aimed at the top of the region really does sit beside it.
    const [slot] = reserveFlow(board.std, [ref]);
    expect(overlaps(slot, script)).toBe(false);
    expect(slot.y).toBeLessThan(script.y + script.h);
  });

  it('puts a batch with no origin LEFT of the board, never below it', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['one', 'two']);

    const slots = reserveFlow(board.std, [ref, ref]);
    for (const slot of slots) {
      expect(slot.x + slot.w).toBeLessThanOrEqual(THINKING_EDGE);
    }
  });

  it('hugs the edge, so one note does not land two thousand pixels away', () => {
    const board = makeTestBoard();
    const wide = thinkingOrigin(board.std, 2000);
    const narrow = thinkingOrigin(board.std, 360);
    // Right-aligned: both end at the boundary, so the narrow one starts closer.
    expect(wide.x + 2000).toBe(THINKING_EDGE);
    expect(narrow.x + 360).toBe(THINKING_EDGE);
    expect(narrow.x).toBeGreaterThan(wide.x);
  });

  it('counts down from the REGION, not from the bottom of the board', () => {
    // Otherwise adding a scene would march the region downward, which is the
    // behaviour the region exists to stop.
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['one', 'two', 'three']);
    const before = thinkingOrigin(board.std, 360);

    // More storyboard, reaching further down and further right.
    createShots(board.std, board.surfaceId, ['four', 'five']);
    expect(thinkingOrigin(board.std, 360)).toEqual(before);
  });

  it('stacks the next batch below the last one IN the region', () => {
    const board = makeTestBoard();
    const first = reserveFlow(board.std, [ref, ref]);
    for (const slot of first) {
      placeTestImage(board, `[${slot.x},${slot.y},${slot.w},${slot.h}]`);
    }

    const next = thinkingOrigin(board.std, 360);
    expect(next.y).toBeGreaterThanOrEqual(Math.max(...first.map(s => s.y + s.h)));
  });

  it('reports nothing for an empty board rather than a phantom box', () => {
    const board = makeTestBoard();
    expect(occupancy(board.std)).toEqual([]);
    expect(ownedBand(board.std)).toBeNull();
    expect(bboxOf([])).toBeNull();
  });
});
