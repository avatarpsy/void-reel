import { describe, expect, it } from 'vitest';
import { frameTitleScale } from './frame-title-scale';

/**
 * ── THE BUG, AS THE USER DESCRIBED IT ───────────────────────────────────────
 * "frame title pills must zoom accordingly, its always shown at same size which
 * is appearing as if its colliding."
 *
 * BlockSuite positions a frame title in SCREEN space and pins its size. Fitting
 * a tall board puts the viewport near 0.35, where a 700-unit frame draws 245px
 * and the title still draws ~22px — three times its designed proportion, on top
 * of whatever is above it.
 *
 * Spacing cannot fix it: the overlap is a function of ZOOM and gaps are fixed in
 * model space, so at some zoom it always collides again.
 */
describe('a frame title scales with the board', () => {
  it('shrinks when the board is zoomed out', () => {
    expect(frameTitleScale(0.5)).toBeLessThan(frameTitleScale(1));
  });

  it('grows a little when zoomed in, but never into a banner', () => {
    expect(frameTitleScale(2)).toBeGreaterThan(1);
    expect(frameTitleScale(8)).toBeLessThanOrEqual(1.4);
  });

  /**
   * Pure scaling makes the title 7px at fit-zoom, which is the reason it was
   * pinned in the first place — a label nobody can read is worse than one that
   * is slightly too big. So it stops at a floor.
   */
  it('stops shrinking while it is still readable', () => {
    expect(frameTitleScale(0.05)).toBeGreaterThanOrEqual(0.45);
    // 14px base at fit-zoom still lands above 6px.
    expect(14 * frameTitleScale(0.35)).toBeGreaterThan(6);
  });

  it('is unchanged at 1:1, so nothing moves on a board nobody zoomed', () => {
    expect(frameTitleScale(1)).toBe(1);
  });

  it('survives a nonsense zoom rather than dividing by it', () => {
    for (const bad of [0, -1, NaN, Infinity]) expect(frameTitleScale(bad as number)).toBe(1);
  });
});
