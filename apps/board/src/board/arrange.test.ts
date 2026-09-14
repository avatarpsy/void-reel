/**
 * TIDYING UP, and the two things it must never do.
 *
 * `board_arrange` is the verb the prompt already described and the agent did not
 * have: "get it out fast and messy, THEN give it shape". The danger in a tool that
 * moves things the user did not name is precisely that it moves things the user
 * did not name — so most of this file is about what it leaves alone.
 */
import { describe, expect, it } from 'vitest';

import { makeTestBoard, placeTestImage } from '../blocksuite/test-board';
import { SHOT_W } from '../shot/model';
import { boardPlan, createShots, readShots } from '../shot/shots';
import { writeScript } from '../shot/screenplay-doc';
import { writeBlockMeta } from './board-meta';
import { arrangeCanvas, planArrangement } from './arrange';
import { canvasDigest, drawOnCanvas, readCanvas } from './canvas';
import { THINKING_EDGE, overlaps } from './space';

const ref = { w: 360, h: 203 };

function boxOf(board: ReturnType<typeof makeTestBoard>, id: string) {
  return readCanvas(board.std).find(i => i.id === id)!;
}

describe('the shapes it can make', () => {
  it('a ROW is one line, left to right', () => {
    const out = planArrangement([ref, ref, ref], 'row');
    expect(out.map(b => b.y)).toEqual([0, 0, 0]);
    expect(out[2].x).toBeGreaterThan(out[1].x);
  });

  it('a COLUMN is one card per line', () => {
    const out = planArrangement([ref, ref, ref], 'column');
    expect(out.map(b => b.x)).toEqual([0, 0, 0]);
    expect(out[1].y).toBeGreaterThan(out[0].y);
    expect(out[2].y).toBeGreaterThan(out[1].y);
  });

  it('a GRID wraps into a block rather than a line across the board', () => {
    const out = planArrangement(Array.from({ length: 12 }, () => ref), 'grid');
    expect(new Set(out.map(b => b.y)).size).toBeGreaterThan(1);
  });
});

describe('what it refuses to touch', () => {
  /**
   * THE EXPENSIVE ONE. Filmstrip order IS compile order (`readShots` sorts by x),
   * so a tidy that moved shot cards would silently renumber the film.
   */
  it('never moves a shot, even when asked for one by id', () => {
    const board = makeTestBoard();
    const shotIds = createShots(board.std, board.surfaceId, ['A', 'B', 'C']);
    const before = readShots(board.std).map(s => s.id);

    const result = arrangeCanvas(board.std, { ids: shotIds, as: 'row' });

    expect(result.moved).toBe(0);
    expect(result.problems.join(' ')).toContain('board_reorder_shots');
    expect(readShots(board.std).map(s => s.id)).toEqual(before);
  });

  it('leaves the storyboard alone when tidying the WHOLE board', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['A', 'B']);
    const shotsBefore = readCanvas(board.std)
      .filter(i => i.kind === 'shot')
      .map(i => ({ id: i.id, x: i.x, y: i.y }));

    placeTestImage(board, '[4000,4000,360,203]');
    placeTestImage(board, '[4100,4050,360,203]');
    arrangeCanvas(board.std, { as: 'tidy' });

    const shotsAfter = readCanvas(board.std)
      .filter(i => i.kind === 'shot')
      .map(i => ({ id: i.id, x: i.x, y: i.y }));
    expect(shotsAfter).toEqual(shotsBefore);
  });

  it('does not resize anything — arranging is about position', () => {
    const board = makeTestBoard();
    const id = placeTestImage(board, '[4000,4000,360,203]');
    placeTestImage(board, '[4100,4050,360,203]');

    arrangeCanvas(board.std, { as: 'row' });
    const after = boxOf(board, id);
    expect({ w: after.w, h: after.h }).toEqual({ w: 360, h: 203 });
  });
});

describe('what it fixes', () => {
  it('separates a pile', () => {
    const board = makeTestBoard();
    // Four cards stacked almost exactly on each other — the state the fixed
    // origin used to produce on every unanchored placement.
    const ids = [
      placeTestImage(board, '[0,2000,360,203]'),
      placeTestImage(board, '[4,2004,360,203]'),
      placeTestImage(board, '[8,2008,360,203]'),
      placeTestImage(board, '[12,2012,360,203]'),
    ];

    expect(canvasDigest(board.std).tidy.collisions).toBeGreaterThan(0);
    const result = arrangeCanvas(board.std, { as: 'grid' });
    expect(result.moved).toBeGreaterThan(0);

    const boxes = ids.map(id => boxOf(board, id));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i], boxes[j])).toBe(false);
      }
    }
    expect(canvasDigest(board.std).tidy.collisions).toBe(0);
  });

  it('keeps a cluster where the user is looking at it when asked', () => {
    const board = makeTestBoard();
    placeTestImage(board, '[5000,5000,360,203]');
    placeTestImage(board, '[5004,5004,360,203]');

    arrangeCanvas(board.std, { as: 'row', inPlace: true });
    // Still out at 5000, not relocated to the thinking region.
    for (const item of readCanvas(board.std)) {
      expect(item.x).toBeGreaterThan(4000);
    }
  });

  it('moves an untidied board into the thinking region by default', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['A']);
    placeTestImage(board, '[5000,5000,360,203]');
    placeTestImage(board, '[5004,5004,360,203]');

    arrangeCanvas(board.std, { as: 'row' });
    for (const item of readCanvas(board.std).filter(i => !i.owned)) {
      expect(item.x + item.w).toBeLessThanOrEqual(THINKING_EDGE);
    }
  });

  it('is ONE undo, however much it moved', () => {
    const board = makeTestBoard();
    const ids = [
      placeTestImage(board, '[0,2000,360,203]'),
      placeTestImage(board, '[4,2004,360,203]'),
      placeTestImage(board, '[8,2008,360,203]'),
    ];
    const before = ids.map(id => boxOf(board, id));

    arrangeCanvas(board.std, { as: 'grid' });
    board.store.undo();

    expect(ids.map(id => boxOf(board, id))).toEqual(before);
  });
});

describe('framing a result', () => {
  it('wraps the arrangement in a titled frame that CONTAINS it', () => {
    const board = makeTestBoard();
    const ids = [
      placeTestImage(board, '[0,2000,360,203]'),
      placeTestImage(board, '[400,2000,360,203]'),
    ];

    const result = arrangeCanvas(board.std, { as: 'row', frame: 'Kitchen look' });
    expect(result.frameId).toBeTruthy();
    expect(result.problems).toEqual([]);

    const frame = board.store.getBlock(result.frameId!)!.model as unknown as {
      props: { title: unknown; childElementIds?: Record<string, boolean> };
    };
    expect(String(frame.props.title)).toBe('Kitchen look');
    // MEMBERSHIP, not mere geometry: this is what makes dragging the frame take
    // its contents along. Every frame the agent drew used to be decorative.
    for (const id of ids) {
      expect(frame.props.childElementIds?.[id]).toBe(true);
    }
  });

  it('encloses what it frames', () => {
    const board = makeTestBoard();
    placeTestImage(board, '[0,2000,360,203]');
    placeTestImage(board, '[400,2000,360,203]');

    const result = arrangeCanvas(board.std, { as: 'row', frame: 'Options' });
    const frame = boxOf(board, result.frameId!);
    for (const item of readCanvas(board.std).filter(i => i.kind === 'image')) {
      expect(item.x).toBeGreaterThanOrEqual(frame.x);
      expect(item.y).toBeGreaterThanOrEqual(frame.y);
      expect(item.x + item.w).toBeLessThanOrEqual(frame.x + frame.w);
      expect(item.y + item.h).toBeLessThanOrEqual(frame.y + frame.h);
    }
  });
});

describe('board_draw frames own their contents too', () => {
  it('registers members named by ref, even when declared later', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      // The frame comes FIRST and names things that do not exist yet, which is
      // the case the deferred adoption pass exists for.
      { kind: 'frame', title: 'Risks', contains: [{ ref: 'a' }, { ref: 'b' }], x: 0, y: 0, w: 900, h: 600 },
      { ref: 'a', kind: 'note', text: 'one', x: 40, y: 80 },
      { ref: 'b', kind: 'note', text: 'two', x: 40, y: 300 },
    ]);

    const frame = board.store.getBlock(r.ids[0]!)!.model as unknown as {
      props: { childElementIds?: Record<string, boolean> };
    };
    expect(frame.props.childElementIds?.[r.ids[1]!]).toBe(true);
    expect(frame.props.childElementIds?.[r.ids[2]!]).toBe(true);
  });

  it('says so when a member could not be resolved', () => {
    const board = makeTestBoard();
    const r = drawOnCanvas(board.std, [
      { kind: 'frame', title: 'Risks', contains: [{ ref: 'nope' }], x: 0, y: 0 },
    ]);
    expect(r.problems.join(' ')).toContain('could not be resolved');
  });
});

describe('the digest tells the agent when the board is a mess', () => {
  it('counts nothing on a clean board', () => {
    const board = makeTestBoard();
    placeTestImage(board, '[0,2000,360,203]');
    placeTestImage(board, '[400,2000,360,203]');
    expect(canvasDigest(board.std).tidy).toEqual({ collisions: 0, oversize: 0 });
  });

  it('reports a card bigger than a shot card', () => {
    // The reported bug, as the agent would now see it: a 960 × 1707 still.
    const board = makeTestBoard();
    placeTestImage(board, '[0,2000,960,1707]', { width: 960, height: 1707 });
    expect(canvasDigest(board.std).tidy.oversize).toBe(1);
  });

  it('does not count a FRAME as oversize — a container is meant to be large', () => {
    const board = makeTestBoard();
    drawOnCanvas(board.std, [
      { kind: 'frame', title: 'Section', x: 0, y: 0, w: SHOT_W * 3, h: 2000 },
    ]);
    expect(canvasDigest(board.std).tidy.oversize).toBe(0);
  });
});

/**
 * A SCENE'S OWN REFERENCES — the third home for a reference.
 *
 * A reference used to be either INSIDE a shot (compiled, owned, generated from) or
 * LOOSE on the canvas (owned by nobody). The thing people actually say — "this is
 * the look of the kitchen scene" — had nowhere to live, and it is most of what a
 * mood board is.
 */
describe('references scoped to a scene', () => {
  const SCRIPT = [
    'INT. KITCHEN — DAY',
    'She fills the kettle.',
    '',
    'EXT. GARDEN — DAY',
    'Rain on the window.',
  ].join('\n');

  function sceneKeys(board: ReturnType<typeof makeTestBoard>): string[] {
    return boardPlan(board.std).rows.map(r => r.sceneKey).filter(Boolean);
  }

  it('gathers only the ones that say they are about that scene', () => {
    const board = makeTestBoard();
    writeScript(board.std, board.surfaceId, SCRIPT);
    const [kitchen, garden] = sceneKeys(board);

    const mine = [
      placeTestImage(board, '[3000,3000,360,203]'),
      placeTestImage(board, '[3400,3000,360,203]'),
    ];
    const theirs = placeTestImage(board, '[3800,3000,360,203]');
    const loose = placeTestImage(board, '[4200,3000,360,203]');

    for (const id of mine) writeBlockMeta(board.doc, id, { sceneKey: kitchen });
    writeBlockMeta(board.doc, theirs, { sceneKey: garden });

    const before = boxOf(board, theirs);
    const looseBefore = boxOf(board, loose);

    const result = arrangeCanvas(board.std, { sceneKey: kitchen, as: 'row' });
    expect(result.moved).toBe(2);

    // The other scene's reference and the unscoped one are untouched.
    expect(boxOf(board, theirs)).toEqual(before);
    expect(boxOf(board, loose)).toEqual(looseBefore);
  });

  it('lines them up beside that scene’s own row', () => {
    const board = makeTestBoard();
    writeScript(board.std, board.surfaceId, SCRIPT);
    const [, garden] = sceneKeys(board);
    const rowY = boardPlan(board.std).rows.find(r => r.sceneKey === garden)!.y;

    const ids = [
      placeTestImage(board, '[3000,9000,360,203]'),
      placeTestImage(board, '[3400,9000,360,203]'),
    ];
    for (const id of ids) writeBlockMeta(board.doc, id, { sceneKey: garden });

    arrangeCanvas(board.std, { sceneKey: garden, as: 'row' });

    for (const id of ids) {
      const box = boxOf(board, id);
      // At the row's y, and left of the script where the grid can never reach.
      expect(box.y).toBe(rowY);
      expect(box.x + box.w).toBeLessThanOrEqual(THINKING_EDGE);
    }
  });

  it('says so when no reference claims that scene, rather than tidying the board', () => {
    const board = makeTestBoard();
    writeScript(board.std, board.surfaceId, SCRIPT);
    const [kitchen] = sceneKeys(board);
    const id = placeTestImage(board, '[3000,3000,360,203]');
    const before = boxOf(board, id);

    const result = arrangeCanvas(board.std, { sceneKey: kitchen });
    expect(result.moved).toBe(0);
    expect(result.problems.join(' ')).toContain('says it is about');
    // The unscoped picture was NOT swept up as a consolation prize.
    expect(boxOf(board, id)).toEqual(before);
  });

  it('reports the scene on a canvas read, so the agent need not remember', () => {
    const board = makeTestBoard();
    writeScript(board.std, board.surfaceId, SCRIPT);
    const [kitchen] = sceneKeys(board);
    const id = placeTestImage(board, '[3000,3000,360,203]');
    writeBlockMeta(board.doc, id, { sceneKey: kitchen });

    expect(readCanvas(board.std).find(i => i.id === id)?.sceneKey).toBe(kitchen);
  });

  it('named ids beat a scope, so "these ones" still means these ones', () => {
    const board = makeTestBoard();
    writeScript(board.std, board.surfaceId, SCRIPT);
    const [kitchen] = sceneKeys(board);
    const a = placeTestImage(board, '[3000,3000,360,203]');
    const b = placeTestImage(board, '[3004,3004,360,203]');
    writeBlockMeta(board.doc, a, { sceneKey: kitchen });
    writeBlockMeta(board.doc, b, { sceneKey: kitchen });

    const bBefore = boxOf(board, b);
    arrangeCanvas(board.std, { sceneKey: kitchen, ids: [a], as: 'row', inPlace: true });
    expect(boxOf(board, b)).toEqual(bBefore);
  });
});

/**
 * THE UNTIDY SIGNAL MUST BE TRUE, or nobody reads it.
 *
 * `collisionCount` cannot use `occupancy`: that grows owned blocks by
 * SPINE_MARGIN so a batch clears the brackets, and shot cards sit 56px apart —
 * so every adjacent pair intersected once padded, and a perfectly tidy
 * three-shot board reported two collisions. Measured, before this test existed.
 */
describe('the untidy signal does not cry wolf', () => {
  it('reports nothing on a clean storyboard', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['A', 'B', 'C']);
    expect(canvasDigest(board.std).tidy).toEqual({ collisions: 0, oversize: 0 });
  });

  it('still reports a loose card sitting ON a shot', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['A']);
    const shot = readCanvas(board.std).find(i => i.kind === 'shot')!;
    placeTestImage(board, `[${shot.x + 40},${shot.y + 40},360,203]`);

    expect(canvasDigest(board.std).tidy.collisions).toBe(1);
  });

  it('counts TEXT, which is the one kind relaxOverlaps will not move', () => {
    // An edgeless-text grows to fit its content, so it can end up over something
    // nobody put it on. Counting it is what lets the agent see it and offer
    // board_arrange — which can move it even though relaxOverlaps will not.
    const board = makeTestBoard();
    drawOnCanvas(board.std, [
      { kind: 'text', text: 'A label', x: 5000, y: 5000 },
      { kind: 'text', text: 'Another label', x: 5010, y: 5010 },
    ]);
    expect(canvasDigest(board.std).tidy.collisions).toBeGreaterThan(0);
  });
});
