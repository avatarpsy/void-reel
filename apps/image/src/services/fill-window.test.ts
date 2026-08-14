/**
 * The crop-and-stitch window.
 *
 * ── WHY THIS IS TESTED AND NOT JUST EYEballed ───────────────────────────────
 * This is the geometry that decides whether a fill comes back with correct
 * proportions. Sending the whole frame gave a 200px face about 3% of the latent
 * area, and the model rendered it at the wrong internal scale — anatomy that is
 * individually plausible and proportionally wrong. No prompt fixes that; the frame
 * was wrong.
 *
 * Every rule below is one a wrong answer would express as a subtly misplaced or
 * mis-scaled fill rather than as an error, so none of them can be left to
 * inspection.
 */
import { describe, expect, it } from 'vitest';

import { nativePixelsFrom, planFillWindow } from './apply-generative-fill';

const AREA = (w: number, h: number) => w * h;

describe('planFillWindow', () => {
  it('gives a small selection close to the model native budget', () => {
    // THE WHOLE POINT. A 200x200 face on a 1154x866 canvas used to be 3% of the
    // latent area; it must now fill most of a native-resolution frame.
    const win = planFillWindow({ x: 400, y: 300, width: 200, height: 200 }, 1154, 866);
    const ratio = AREA(win.tw, win.th) / (1024 * 1024);
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.2);
    expect(win.upscaled).toBe(true);
  });

  it('includes real context around the selection', () => {
    // Inpainting is conditioned on the surroundings. A tight crop makes the model
    // invent something unrelated to the picture.
    const sel = { x: 400, y: 300, width: 200, height: 200 };
    const win = planFillWindow(sel, 1154, 866);
    expect(win.sx).toBeLessThan(sel.x);
    expect(win.sy).toBeLessThan(sel.y);
    expect(win.sw).toBeGreaterThan(sel.width);
    expect(win.sh).toBeGreaterThan(sel.height);
  });

  it('never runs off the artboard', () => {
    // A window past the edge would be padded with nothing, and the model would
    // read that void as part of the image.
    for (const sel of [
      { x: 0, y: 0, width: 60, height: 60 },
      { x: 1100, y: 820, width: 54, height: 46 },
      { x: 0, y: 800, width: 40, height: 66 },
    ]) {
      const win = planFillWindow(sel, 1154, 866);
      expect(win.sx).toBeGreaterThanOrEqual(0);
      expect(win.sy).toBeGreaterThanOrEqual(0);
      expect(win.sx + win.sw).toBeLessThanOrEqual(1154);
      expect(win.sy + win.sh).toBeLessThanOrEqual(866);
    }
  });

  it('always contains the whole selection', () => {
    // If the window clipped the selection, part of what the user asked to change
    // would silently never be sent.
    const sel = { x: 900, y: 700, width: 240, height: 150 };
    const win = planFillWindow(sel, 1154, 866);
    expect(win.sx).toBeLessThanOrEqual(sel.x);
    expect(win.sy).toBeLessThanOrEqual(sel.y);
    expect(win.sx + win.sw).toBeGreaterThanOrEqual(sel.x + sel.width);
    expect(win.sy + win.sh).toBeGreaterThanOrEqual(sel.y + sel.height);
  });

  it('emits multiples of 8 so the latent is not silently rounded', () => {
    for (const sel of [
      { x: 10, y: 10, width: 37, height: 91 },
      { x: 400, y: 300, width: 201, height: 199 },
      { x: 0, y: 0, width: 1153, height: 865 },
    ]) {
      const win = planFillWindow(sel, 1154, 866);
      expect(win.tw % 8).toBe(0);
      expect(win.th % 8).toBe(0);
    }
  });

  it('keeps the window aspect ratio in the target, so nothing is stretched', () => {
    const sel = { x: 100, y: 100, width: 400, height: 150 };
    const win = planFillWindow(sel, 1600, 1200);
    const srcAspect = win.sw / win.sh;
    const dstAspect = win.tw / win.th;
    // Within one 8px block of rounding on each axis.
    expect(Math.abs(srcAspect - dstAspect)).toBeLessThan(0.06);
  });

  it('scales DOWN a selection larger than native rather than blowing up', () => {
    // Someone selecting most of a 4000x3000 canvas must not be sent 12 MP.
    const win = planFillWindow({ x: 0, y: 0, width: 3800, height: 2800 }, 4000, 3000);
    expect(AREA(win.tw, win.th)).toBeLessThan(1024 * 1024 * 1.2);
    expect(win.upscaled).toBe(false);
  });

  it('handles a selection that is the entire artboard', () => {
    const win = planFillWindow({ x: 0, y: 0, width: 1154, height: 866 }, 1154, 866);
    expect(win.sx).toBe(0);
    expect(win.sy).toBe(0);
    expect(win.sw).toBe(1154);
    expect(win.sh).toBe(866);
  });

  it('handles a one-pixel selection without producing a degenerate window', () => {
    const win = planFillWindow({ x: 500, y: 400, width: 1, height: 1 }, 1154, 866);
    expect(win.sw).toBeGreaterThan(0);
    expect(win.sh).toBeGreaterThan(0);
    expect(win.tw).toBeGreaterThanOrEqual(8);
    expect(win.th).toBeGreaterThanOrEqual(8);
  });

  it('handles an extreme aspect ratio selection', () => {
    // A thin horizontal strip — a "remove this wire" selection.
    const win = planFillWindow({ x: 100, y: 400, width: 900, height: 12 }, 1154, 866);
    expect(win.tw % 8).toBe(0);
    expect(win.th % 8).toBe(0);
    expect(win.sx + win.sw).toBeLessThanOrEqual(1154);
    expect(win.sy + win.sh).toBeLessThanOrEqual(866);
  });
});

/**
 * The model's native resolution, read from its recipe.
 *
 * ── WHY THIS IS NOT A CONSTANT ──────────────────────────────────────────────
 * Measured on a real photograph: the SAME selection, model and prompt, differing
 * only in the size the window was sent at. At 1024² — SDXL's native size, wrongly
 * applied to an SD 1.5 recipe — the subject's face came back as an incoherent
 * blue smear. At 512², its actual training resolution, the result was seamless.
 *
 * Running a latent model far outside its training resolution does not degrade
 * gracefully; it produces confident nonsense. So the budget belongs to the
 * recipe, and a hardcoded default that happens to suit one model family is a bug
 * that presents as "the model is bad".
 */
describe('nativePixelsFrom', () => {
  it('reads the recipe resolution', () => {
    expect(nativePixelsFrom(['512x512'])).toBe(512 * 512);
    expect(nativePixelsFrom(['1024x1024'])).toBe(1024 * 1024);
    expect(nativePixelsFrom(['768x1344'])).toBe(768 * 1344);
  });

  it('takes the FIRST entry — a recipe lists its preferred size first', () => {
    expect(nativePixelsFrom(['512x512', '1024x1024'])).toBe(512 * 512);
  });

  it('tolerates spacing and the unicode multiplication sign', () => {
    expect(nativePixelsFrom([' 512 x 512 '])).toBe(512 * 512);
    expect(nativePixelsFrom(['512×512'])).toBe(512 * 512);
  });

  it('returns null rather than a nonsense budget for free text', () => {
    // Callers fall back to the default. A garbage number would silently size
    // every window wrong, which is the failure this whole thing is about.
    for (const bad of [undefined, [], ['720p'], ['native'], ['axb'], ['']]) {
      expect(nativePixelsFrom(bad as any)).toBeNull();
    }
  });

  it('drives the window: the same selection sizes differently per model', () => {
    const sel = { x: 400, y: 300, width: 163, height: 163 };
    const sdxl = planFillWindow(sel, 1225, 816, nativePixelsFrom(['1024x1024'])!);
    const sd15 = planFillWindow(sel, 1225, 816, nativePixelsFrom(['512x512'])!);
    // Same window in artboard space...
    expect(sd15.sw).toBe(sdxl.sw);
    expect(sd15.sh).toBe(sdxl.sh);
    // ...sent at different sizes. This is the whole point.
    expect(sdxl.tw).toBeGreaterThan(sd15.tw);
    expect(sd15.tw * sd15.th).toBeLessThan(sdxl.tw * sdxl.th);
  });
});
