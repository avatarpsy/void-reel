/**
 * Saving a piece of the canvas into the user's library.
 *
 * The pure decisions are tested here; the DOM half (render, crop, upload) is
 * exercised in the editor. Each of these was chosen because getting it wrong
 * costs the user something real — a blank PNG counted against their storage
 * quota, a restacked picture, or a file they can never find again.
 */
import { describe, it, expect } from 'vitest';
import { alphaBounds, libraryFileName, resolveRegion, layersToDraw } from './library-save';
import type { Artboard } from '../types/project';

const PAGE = {
  id: 'a1', name: 'Page 1', size: { width: 1000, height: 800 },
  background: { type: 'color', color: '#000' },
  layerIds: ['top', 'mid', 'bottom'], position: { x: 0, y: 0 },
} as unknown as Artboard;

/** RGBA buffer helper: paint a solid rect of alpha 255 into a transparent field. */
function field(w: number, h: number, rect?: { x: number; y: number; w: number; h: number }) {
  const data = new Uint8ClampedArray(w * h * 4);
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        data[(y * w + x) * 4 + 3] = 255;
      }
    }
  }
  return data;
}

describe('alphaBounds', () => {
  it('finds the inked rectangle inside a transparent field', () => {
    // The case the whole trim exists for: after a background removal the shape
    // sits inside a page-sized rectangle of nothing.
    const box = alphaBounds(field(100, 100, { x: 20, y: 30, w: 10, h: 5 }), 100, 100);
    expect(box).toEqual({ x: 20, y: 30, width: 10, height: 5 });
  });

  it('returns null for a fully transparent image', () => {
    // A real answer, and the one that stops an empty PNG being written to
    // somebody's library and charged against their storage.
    expect(alphaBounds(field(40, 40), 40, 40)).toBeNull();
  });

  it('returns the whole image when everything is opaque', () => {
    const box = alphaBounds(field(8, 6, { x: 0, y: 0, w: 8, h: 6 }), 8, 6);
    expect(box).toEqual({ x: 0, y: 0, width: 8, height: 6 });
  });

  it('ignores the faint halo a background removal leaves behind', () => {
    // Trimming at alpha > 0 would keep the halo and defeat the trim entirely.
    const data = field(50, 50, { x: 10, y: 10, w: 4, h: 4 });
    data[(0 * 50 + 0) * 4 + 3] = 5;   // a stray almost-transparent pixel
    expect(alphaBounds(data, 50, 50)).toEqual({ x: 10, y: 10, width: 4, height: 4 });
  });

  it('includes a faint pixel when asked to', () => {
    const data = field(50, 50, { x: 10, y: 10, w: 4, h: 4 });
    data[(0 * 50 + 0) * 4 + 3] = 5;
    expect(alphaBounds(data, 50, 50, 0)).toEqual({ x: 0, y: 0, width: 14, height: 14 });
  });

  it('handles a single inked pixel', () => {
    const box = alphaBounds(field(20, 20, { x: 7, y: 9, w: 1, h: 1 }), 20, 20);
    expect(box).toEqual({ x: 7, y: 9, width: 1, height: 1 });
  });
});

describe('libraryFileName', () => {
  it('slugs a human name and always ends .png', () => {
    expect(libraryFileName('Rocket — cut out!')).toBe('rocket-cut-out.png');
  });

  it('falls back rather than producing a nameless file', () => {
    // Library file names are visible in search and in a pack listing; an empty
    // one is the file nobody ever finds again.
    expect(libraryFileName('')).toBe('cutout.png');
    expect(libraryFileName('!!!')).toBe('cutout.png');
    expect(libraryFileName(undefined)).toBe('cutout.png');
  });

  it('caps the length', () => {
    expect(libraryFileName('x'.repeat(200)).length).toBeLessThanOrEqual(64);
  });
});

describe('resolveRegion', () => {
  it('defaults to the whole page', () => {
    expect(resolveRegion(PAGE)).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it('clamps a region that runs off the page', () => {
    // An agent asking for a crop past the edge should get the part that exists,
    // not a canvas with a transparent margin it did not ask for.
    expect(resolveRegion(PAGE, { x: 900, y: 700, width: 400, height: 400 }))
      .toEqual({ x: 900, y: 700, width: 100, height: 100 });
  });

  it('never produces a zero or negative size', () => {
    expect(resolveRegion(PAGE, { x: 10, y: 10, width: 0, height: -5 }))
      .toEqual({ x: 10, y: 10, width: 1, height: 1 });
  });

  it('pulls a negative origin back onto the page', () => {
    expect(resolveRegion(PAGE, { x: -50, y: -50, width: 100, height: 100 }))
      .toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
});

describe('layersToDraw', () => {
  it('draws every layer when none are named', () => {
    expect(layersToDraw(PAGE)).toEqual(['top', 'mid', 'bottom']);
  });

  it('keeps the page TOP-FIRST order whatever order the caller asked in', () => {
    // The renderer takes top-first and reverses to paint, so honouring the
    // caller's order would silently restack the picture.
    expect(layersToDraw(PAGE, ['bottom', 'top'])).toEqual(['top', 'bottom']);
  });

  it('ignores ids that are not on this page', () => {
    expect(layersToDraw(PAGE, ['mid', 'ghost'])).toEqual(['mid']);
  });

  it('returns nothing when the named layers are all strangers', () => {
    expect(layersToDraw(PAGE, ['ghost'])).toEqual([]);
  });
});
