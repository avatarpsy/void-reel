/**
 * The board as a film — Acts ▸ Sequences ▸ Scenes ▸ Shots.
 *
 * The planner is pure, so these drive it directly with a parsed script rather
 * than through a mounted board. What is asserted is the STRUCTURE and the
 * reading order, never the pixel constants: the gaps are a design choice that
 * will be tuned, and a test that pins them would fail on every tuning without
 * anything being wrong.
 */
import { describe, expect, it } from 'vitest';

import { parseFountain } from './fountain';
import { EMPTY_ROW_H, GUTTER, nearestSlotOrder, planBoard } from './layout';
import { SHOT_GAP, SHOT_W } from './model';

const SCRIPT = `# ACT ONE

## The arrival

INT. KITCHEN — DAY

She turns to the window.

EXT. STREET — DAY

He waits.

## The chase

INT. CAR — NIGHT

Tyres.

# ACT TWO

## Aftermath

INT. HOSPITAL — DAY

Quiet.
`;

/** Shots, in the order they were dropped on the board. */
function shots(...rows: Array<[id: string, sceneKey: string]>) {
  return rows.map(([id, sceneKey], i) => ({ id, sceneKey, x: i * 100 }));
}

const script = parseFountain(SCRIPT);
const keys = script.scenes.map(s => s.key);

describe('planBoard', () => {
  it('gives every scene a row, in the script’s own order', () => {
    const plan = planBoard(script, []);
    expect(plan.flat).toBe(false);
    expect(plan.rows.map(r => r.heading)).toEqual([
      'INT. KITCHEN — DAY', 'EXT. STREET — DAY', 'INT. CAR — NIGHT', 'INT. HOSPITAL — DAY',
    ]);
  });

  it('puts a scene’s shots in its row, left to right', () => {
    const plan = planBoard(script, shots(['a', keys[0]!], ['b', keys[0]!], ['c', keys[1]!]));
    expect(plan.rows[0]!.shotIds).toEqual(['a', 'b']);
    expect(plan.rows[1]!.shotIds).toEqual(['c']);
    // The pitch is the one thing that must hold: cards abut on a fixed grid.
    expect(plan.place.get('b')!.x - plan.place.get('a')!.x).toBe(SHOT_W + SHOT_GAP);
    expect(plan.place.get('a')!.x).toBe(GUTTER);
  });

  it('reads top-to-bottom, left-to-right as act ▸ sequence ▸ scene ▸ shot', () => {
    /**
     * THE PROPERTY THE COMPILE ORDER RESTS ON. `shotOrder` sorts by row then
     * column, so the film cuts in the order you read the board. If the planner
     * ever placed a later scene above an earlier one this would be silently
     * wrong — a film in the wrong order, with nothing on screen to show it.
     */
    const plan = planBoard(script, shots(
      ['hosp', keys[3]!], ['car', keys[2]!], ['kitchen', keys[0]!], ['street', keys[1]!],
    ));
    const ys = ['kitchen', 'street', 'car', 'hosp'].map(id => plan.place.get(id)!.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(new Set(ys).size).toBe(4);
  });

  it('brackets each act and sequence over the rows it actually covers', () => {
    const plan = planBoard(script, []);
    expect(plan.acts.map(a => a.title)).toEqual(['ACT ONE', 'ACT TWO']);
    expect(plan.acts[0]).toMatchObject({ from: 0, to: 2 });
    expect(plan.acts[1]).toMatchObject({ from: 3, to: 3 });
    expect(plan.sequences.map(s => s.title)).toEqual(['The arrival', 'The chase', 'Aftermath']);
    expect(plan.sequences[0]).toMatchObject({ from: 0, to: 1 });
  });

  it('spans the bracket across the full height of its rows', () => {
    const plan = planBoard(script, shots(['a', keys[0]!], ['b', keys[2]!]));
    const act = plan.acts[0]!;
    const first = plan.rows[act.from]!;
    const last = plan.rows[act.to]!;
    expect(act.y).toBe(first.y);
    expect(act.y + act.height).toBe(last.y + last.height);
  });

  it('keeps a scene with no coverage as a short row, so the gap is visible', () => {
    // The whole reason to draw every scene rather than only the covered ones:
    // "which scenes have nothing yet" is the question a board should answer at a
    // glance, and an absent row answers it by omission, which nobody reads.
    const plan = planBoard(script, shots(['a', keys[0]!]));
    expect(plan.rows[1]!.shotIds).toEqual([]);
    expect(plan.rows[1]!.height).toBe(EMPTY_ROW_H);
  });

  it('parks shots that are not on the script in their own row, last and unbracketed', () => {
    /**
     * A visual idea sketched before its scene is written is ordinary work, and
     * so is a shot orphaned by a renamed slugline. Filing either under the
     * nearest act would assert a place in the film nobody chose.
     */
    const plan = planBoard(script, shots(['loose', ''], ['gone', 'no-such-scene'], ['a', keys[0]!]));
    const last = plan.rows[plan.rows.length - 1]!;
    expect(last.sceneKey).toBe('');
    expect(last.shotIds.sort()).toEqual(['gone', 'loose']);
    // No bracket reaches it — it is not part of the structure.
    expect(plan.acts.every(a => a.to < plan.rows.length - 1)).toBe(true);
    expect(plan.sequences.every(s => s.to < plan.rows.length - 1)).toBe(true);
  });

  it('draws nothing structural for a piece that has no structure', () => {
    // A thirty-second ad with no screenplay is the common case, not a degenerate
    // film. It gets one plain row and no brackets — the old filmstrip exactly.
    const plan = planBoard(parseFountain(''), shots(['a', ''], ['b', '']));
    expect(plan.flat).toBe(true);
    expect(plan.rows).toHaveLength(1);
    expect(plan.acts).toEqual([]);
    expect(plan.sequences).toEqual([]);
    expect(plan.place.get('b')!.y).toBe(plan.place.get('a')!.y);
  });

  it('treats a single scene as no structure either', () => {
    const plan = planBoard(parseFountain('INT. KITCHEN — DAY\n\nShe waits.\n'), shots(['a', '']));
    expect(plan.flat).toBe(true);
  });

  it('breaks a bracket that is not contiguous, because that is what it looks like', () => {
    // A sequence interrupted by a scene from another sequence is two blocks on
    // the board, and one brace spanning the interruption would enclose a row
    // that is not in it.
    const split = parseFountain(
      '## A\n\nINT. ONE — DAY\n\nx\n\n## B\n\nINT. TWO — DAY\n\nx\n\n## A\n\nINT. THREE — DAY\n\nx\n',
    );
    const plan = planBoard(split, []);
    expect(plan.sequences.map(s => [s.title, s.from, s.to]))
      .toEqual([['A', 0, 0], ['B', 1, 1], ['A', 2, 2]]);
  });
});

/**
 * DRAGGING A CARD TO A NEW PLACE IN THE ROW.
 *
 * Slots on a 696px pitch: 360, 1056, 1752 (left edges), so centres at 680,
 * 1376, 2072. The threshold is half of that, 348, which is the point at which
 * the dragged card visibly overlaps its neighbour more than its own slot.
 */
describe('nearestSlotOrder', () => {
  const ROW = ['a', 'b', 'c'];
  const centreOf = (slot: number) => GUTTER + SHOT_W / 2 + slot * (SHOT_W + SHOT_GAP);

  it('takes the slot it is nearest, at just over half a pitch', () => {
    // 'c' sits in slot 2. Dragged 0.6 of a pitch left it is nearest slot 1.
    const c = centreOf(2) - (SHOT_W + SHOT_GAP) * 0.6;
    expect(nearestSlotOrder(ROW, 'c', c)).toEqual(['a', 'c', 'b']);
  });

  it('stays put for a nudge under half a pitch — that is not a re-cut', () => {
    const c = centreOf(2) - (SHOT_W + SHOT_GAP) * 0.4;
    expect(nearestSlotOrder(ROW, 'c', c)).toEqual(['a', 'b', 'c']);
  });

  it('crosses two slots when it is dragged two slots', () => {
    expect(nearestSlotOrder(ROW, 'c', centreOf(0))).toEqual(['c', 'a', 'b']);
  });

  it('clamps a card dragged off the end of the row to the end of it', () => {
    expect(nearestSlotOrder(ROW, 'a', centreOf(9))).toEqual(['b', 'c', 'a']);
    expect(nearestSlotOrder(ROW, 'c', centreOf(-4))).toEqual(['c', 'a', 'b']);
  });

  it('leaves a row of one alone, and a card that is not in the row', () => {
    expect(nearestSlotOrder(['a'], 'a', 99999)).toEqual(['a']);
    expect(nearestSlotOrder(ROW, 'zz', centreOf(0))).toEqual(ROW);
  });
});
