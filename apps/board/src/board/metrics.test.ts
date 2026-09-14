/**
 * HOW BIG A CARD IS — the regression guard for the reported bug.
 *
 * "The agent adds media 3–4× the size of a shot card." It did: every image
 * reached the canvas through `addImages(…, { maxWidth: 960 })`, which caps width
 * and lets height follow the aspect UNCAPPED, and every library image arrives as
 * a `w=1024` proxy variant — so a 9:16 still landed at 960 × 1707 beside a
 * 640 × 1020 shot card.
 *
 * The numbers below are the ones that were wrong. They are asserted against the
 * shot card rather than against constants, because the property that matters is
 * the RELATIONSHIP — a reference is a thing a shot points at, and it should never
 * be drawn larger than the shot.
 */
import { describe, expect, it } from 'vitest';

import { SHOT_H, SHOT_W } from '../shot/model';
import {
  HERO_W, REF_MAX_H, REF_W, audioBox, cardBox, fit, isOversize,
} from './metrics';

/** The three shapes this product actually makes. */
const LANDSCAPE = { w: 1920, h: 1080 };
const SQUARE = { w: 1024, h: 1024 };
const PORTRAIT = { w: 1080, h: 1920 };

describe('a reference never outgrows the shot card it points at', () => {
  it('fits every orientation inside the card, in BOTH dimensions', () => {
    for (const natural of [LANDSCAPE, SQUARE, PORTRAIT]) {
      const box = fit(natural);
      expect(box.w).toBeLessThanOrEqual(SHOT_W);
      expect(box.h).toBeLessThanOrEqual(SHOT_H);
      expect(isOversize(box, SHOT_W, SHOT_H)).toBe(false);
    }
  });

  it('caps the PORTRAIT still that was 960 × 1707', () => {
    // The exact case in the report. 9:16 at the old 960 width is 1707 tall —
    // 1.67× the height of a shot card and 2.5× its area.
    const box = fit(PORTRAIT);
    expect(box.h).toBe(REF_MAX_H);
    expect(box.w).toBe(236);
    // And it is still 9:16, because a box that does not match its contents is
    // the "why is my video squashed" report from the other direction.
    expect(Math.abs(box.w / box.h - 1080 / 1920)).toBeLessThan(0.01);
  });

  it('keeps a landscape still at the box width', () => {
    expect(fit(LANDSCAPE)).toEqual({ w: REF_W, h: 203 });
  });

  it('never stretches or squashes — aspect survives every fit', () => {
    for (const natural of [LANDSCAPE, SQUARE, PORTRAIT, { w: 300, h: 400 }, { w: 2100, h: 900 }]) {
      const box = fit(natural);
      // Rounding only: the box is integral, so an exact ratio is not always
      // reachable — but it is always within a pixel of one.
      expect(Math.abs(box.w / box.h - natural.w / natural.h)).toBeLessThan(0.02);
    }
  });
});

describe('one row of mixed media is one row', () => {
  /**
   * THE OTHER HALF OF "IT DOES NOT ORGANISE THE BOARD".
   *
   * A still and a clip placed by the SAME call used to differ by 10.8× in area
   * (960 × 1707 against 360 × 202), and two stills from different sources
   * differed from each other because `min(natural, 960)` let a small thumbnail
   * land small. Uniform width is what makes a row read as a row.
   */
  /**
   * THE SHARED THING IS THE BOX, NOT THE WIDTH. Aspect has to survive, so a
   * portrait card is height-capped and therefore narrower (236) than a landscape
   * one (360). What makes a row read as a row is that every card fits the same
   * REF_W × REF_MAX_H envelope — not that they are all the same shape.
   */
  it('fits every still and clip in the same envelope', () => {
    for (const box of [
      cardBox('image', PORTRAIT), cardBox('image', LANDSCAPE), cardBox('image', SQUARE),
      cardBox('video', null), cardBox('video', PORTRAIT), cardBox('audio'),
    ]) {
      expect(box.w).toBeLessThanOrEqual(REF_W);
      expect(box.h).toBeLessThanOrEqual(REF_MAX_H);
    }
  });

  it('gives a still and a clip of the SAME orientation the same box', () => {
    // The 10.8× area difference in the report was a portrait still (960 × 1707)
    // against a landscape clip (360 × 202) placed by the same call.
    expect(cardBox('image', LANDSCAPE)).toEqual(cardBox('video', LANDSCAPE));
    expect(cardBox('image', PORTRAIT)).toEqual(cardBox('video', PORTRAIT));
  });

  it('does not let a SMALL source land small', () => {
    // A 320-wide thumbnail and a 2048-wide master are the same card.
    expect(fit({ w: 320, h: 180 }).w).toBe(fit({ w: 2048, h: 1152 }).w);
  });

  it('gives a track the landscape box, with no aspect to honour', () => {
    expect(audioBox()).toEqual({ w: REF_W, h: 203 });
    expect(cardBox('audio', PORTRAIT)).toEqual(audioBox());
  });
});

describe('unknown dimensions', () => {
  it('assumes 16:9 rather than guessing portrait', () => {
    // The clip probe is up to six seconds behind the drop, and for those six
    // seconds the card is this. Guessing portrait and being wrong leaves a slab.
    expect(fit(null)).toEqual({ w: REF_W, h: 203 });
    expect(fit({ w: 0, h: 0 })).toEqual(fit(null));
  });
});

describe('a hero — one result, being judged', () => {
  it('is exactly one shot card wide and never taller than one', () => {
    expect(HERO_W).toBe(SHOT_W);
    for (const natural of [LANDSCAPE, SQUARE, PORTRAIT]) {
      const box = fit(natural, 'hero');
      expect(box.w).toBeLessThanOrEqual(SHOT_W);
      expect(box.h).toBeLessThanOrEqual(SHOT_H);
    }
  });

  it('is bigger than a reference, which is the whole point of asking for one', () => {
    expect(fit(SQUARE, 'hero').w).toBeGreaterThan(fit(SQUARE).w);
  });
});
