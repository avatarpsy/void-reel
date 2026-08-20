/**
 * An overlay that does not land exactly on its layer reads as a broken editor —
 * the composition appears to float free of the artboard, and drifts further with
 * every pan. These pin the arithmetic against the canvas's own, which is the
 * thing it has to agree with.
 */
import { describe, it, expect } from 'vitest';
import { artboardOrigin, compositionPlacement, isVisible, type Viewport } from './overlay-placement';

const ARTBOARD = { width: 1920, height: 1080 };
const FULL_BLEED = { x: 0, y: 0, width: 1920, height: 1080 };

const vp = (over: Partial<Viewport> = {}): Viewport => ({
  canvasWidth: 1000,
  canvasHeight: 800,
  zoom: 1,
  panX: 0,
  panY: 0,
  ...over,
});

describe('where the artboard sits', () => {
  it('centres it in the canvas', () => {
    // 1000 wide canvas, 1920 wide artboard at zoom 1 → hangs off both edges evenly.
    expect(artboardOrigin(vp(), ARTBOARD)).toEqual({ x: 500 - 960, y: 400 - 540 });
  });

  it('shrinks around the centre as zoom drops', () => {
    expect(artboardOrigin(vp({ zoom: 0.5 }), ARTBOARD)).toEqual({ x: 500 - 480, y: 400 - 270 });
  });

  it('moves one-for-one with pan, not scaled by zoom', () => {
    // Pan is applied to the CENTRE, before the artboard is offset, so panning
    // 100px moves the artboard 100px whatever the zoom is.
    const a = artboardOrigin(vp({ zoom: 0.5 }), ARTBOARD);
    const b = artboardOrigin(vp({ zoom: 0.5, panX: 100, panY: -40 }), ARTBOARD);
    expect(b.x - a.x).toBe(100);
    expect(b.y - a.y).toBe(-40);
  });

  it('reproduces the canvas formula exactly', () => {
    // The tripwire. Canvas.tsx computes:
    //   centerX = canvas.width / 2 + panX
    //   artboardX = centerX - (artboard.width * zoom) / 2
    // If that mapping changes, this fails and the overlay gets fixed with it
    // rather than drifting quietly.
    const v = vp({ canvasWidth: 1234, canvasHeight: 777, zoom: 0.37, panX: 21, panY: -13 });
    const expectedX = (1234 / 2 + 21) - (1920 * 0.37) / 2;
    const expectedY = (777 / 2 - 13) - (1080 * 0.37) / 2;
    expect(artboardOrigin(v, ARTBOARD)).toEqual({ x: expectedX, y: expectedY });
  });
});

describe('placing a composition on its layer', () => {
  it('puts a full-bleed frame exactly on the artboard', () => {
    const p = compositionPlacement(vp(), ARTBOARD, FULL_BLEED, ARTBOARD);
    expect(p.left).toBe(500 - 960);
    expect(p.top).toBe(400 - 540);
    expect(p.scale).toBe(1);
  });

  it('offsets by the layer position, in screen pixels', () => {
    const layer = { x: 100, y: 50, width: 400, height: 300 };
    const p = compositionPlacement(vp({ zoom: 0.5 }), ARTBOARD, layer, { width: 400, height: 300 });
    const origin = artboardOrigin(vp({ zoom: 0.5 }), ARTBOARD);
    expect(p.left).toBe(origin.x + 50);  // 100 * 0.5
    expect(p.top).toBe(origin.y + 25);   // 50 * 0.5
  });

  it('multiplies zoom by the layer-to-frame ratio', () => {
    // A 1920 frame shown in a 960-wide layer is half size before zoom, and a
    // quarter at 50% zoom.
    const layer = { x: 0, y: 0, width: 960, height: 540 };
    expect(compositionPlacement(vp(), ARTBOARD, layer, ARTBOARD).scale).toBe(0.5);
    expect(compositionPlacement(vp({ zoom: 0.5 }), ARTBOARD, layer, ARTBOARD).scale).toBe(0.25);
  });

  it('scales by frame, never by resizing to the layer', () => {
    // The distinction that matters: the document keeps its own width and is
    // scaled. Relaying it out at the layer's width would rewrap the type and
    // resolve clamp() differently — a different design, not a smaller one.
    const layer = { x: 0, y: 0, width: 640, height: 360 };
    const frame = { width: 1920, height: 1080 };
    expect(compositionPlacement(vp(), ARTBOARD, layer, frame).scale).toBeCloseTo(640 / 1920);
  });

  it('survives a frame with no width rather than producing NaN', () => {
    const p = compositionPlacement(vp(), ARTBOARD, FULL_BLEED, { width: 0, height: 0 });
    expect(Number.isFinite(p.scale)).toBe(true);
    expect(p.scale).toBe(1);
  });

  it('tracks pan so the frame stays on its layer', () => {
    const layer = { x: 200, y: 100, width: 400, height: 300 };
    const before = compositionPlacement(vp(), ARTBOARD, layer, ARTBOARD);
    const after = compositionPlacement(vp({ panX: 60, panY: 25 }), ARTBOARD, layer, ARTBOARD);
    expect(after.left - before.left).toBe(60);
    expect(after.top - before.top).toBe(25);
  });
});

describe('knowing when a frame is off screen', () => {
  // A live frame nobody can see is a document animating for no one, and a deck
  // has one of these per page.
  it('sees a centred artboard', () => {
    expect(isVisible(vp(), ARTBOARD, FULL_BLEED)).toBe(true);
  });

  it('does not see a layer panned far off', () => {
    expect(isVisible(vp({ panX: -5000 }), ARTBOARD, FULL_BLEED)).toBe(false);
    expect(isVisible(vp({ panY: 5000 }), ARTBOARD, FULL_BLEED)).toBe(false);
  });

  it('counts a partly visible layer as visible', () => {
    // Half off the left edge still needs to be running.
    const layer = { x: 0, y: 0, width: 200, height: 200 };
    const v = vp({ zoom: 1, panX: 960 - 100 });
    expect(isVisible(v, ARTBOARD, layer)).toBe(true);
  });
});
