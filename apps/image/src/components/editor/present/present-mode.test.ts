/**
 * The two decisions present mode makes before drawing anything.
 *
 * Both are the kind that look obviously right and are quietly wrong at the
 * edges: which pages may be run as a live document, and how big to draw one.
 */
import { describe, it, expect } from 'vitest';
import { soleComposition, presentScale } from './PresentMode';
import type { Project, Artboard, Layer } from '../../../types/project';

const PAGE: Artboard = {
  id: 'a1',
  name: 'Page 1',
  size: { width: 1920, height: 1080 },
  background: { type: 'color', color: '#000000' },
  layerIds: [],
  position: { x: 0, y: 0 },
} as Artboard;

function make(layers: Record<string, Layer>, order: string[], page = PAGE): Project {
  return {
    id: 'p', name: 'Deck', createdAt: 0, updatedAt: 0, version: 1,
    artboards: [{ ...page, layerIds: order }],
    layers, assets: {}, exportPresets: [], activeArtboardId: page.id,
  } as unknown as Project;
}

const blockLayer = (over: Record<string, unknown> = {}): Layer => ({
  id: 'B', type: 'image', name: 'Slide', visible: true,
  transform: { x: 0, y: 0, width: 1920, height: 1080, rotation: 0, opacity: 1 },
  composition: { block: 'deck-title', slots: {}, fillMode: 'render', poseTime: 'end',
                 frameWidth: 1920, frameHeight: 1080, renderHash: '' },
  ...over,
} as unknown as Layer);

const textLayer = (): Layer => ({
  id: 'T', type: 'text', name: 'Caption', visible: true,
  transform: { x: 10, y: 10, width: 400, height: 80, rotation: 0, opacity: 1 },
  content: 'hello', style: {},
} as unknown as Layer);

describe('soleComposition', () => {
  it('runs a page that is exactly one full-page block', () => {
    const p = make({ B: blockLayer() }, ['B']);
    expect(soleComposition(p, p.artboards[0])?.id).toBe('B');
  });

  it('refuses a page with anything else on top', () => {
    // A logo dropped over the slide means the block is no longer a document
    // that can be run on its own — running it would drop the logo silently.
    const p = make({ B: blockLayer(), T: textLayer() }, ['B', 'T']);
    expect(soleComposition(p, p.artboards[0])).toBeNull();
  });

  it('ignores hidden layers when deciding', () => {
    const hidden = { ...(textLayer() as any), visible: false } as Layer;
    const p = make({ B: blockLayer(), T: hidden }, ['B', 'T']);
    expect(soleComposition(p, p.artboards[0])?.id).toBe('B');
  });

  it('refuses a block that does not cover the page', () => {
    // Half a slide run as a full-bleed document would be drawn at the wrong
    // size, losing whatever the rest of the page was for.
    const p = make({ B: blockLayer({ transform: { x: 0, y: 0, width: 960, height: 540, rotation: 0, opacity: 1 } }) }, ['B']);
    expect(soleComposition(p, p.artboards[0])).toBeNull();
  });

  it('tolerates sub-pixel placement', () => {
    const p = make({ B: blockLayer({ transform: { x: 0.4, y: -0.3, width: 1919.6, height: 1080.2, rotation: 0, opacity: 1 } }) }, ['B']);
    expect(soleComposition(p, p.artboards[0])?.id).toBe('B');
  });

  it('refuses a page with no block at all', () => {
    const p = make({ T: textLayer() }, ['T']);
    expect(soleComposition(p, p.artboards[0])).toBeNull();
  });

  it('refuses an empty page', () => {
    const p = make({}, []);
    expect(soleComposition(p, p.artboards[0])).toBeNull();
  });
});

describe('presentScale', () => {
  const slide = { width: 1920, height: 1080 };

  it('fills a matching screen exactly', () => {
    expect(presentScale(slide, { width: 1920, height: 1080 })).toBe(1);
  });

  it('ENLARGES on a bigger display', () => {
    // The canvas overlay caps at 1 because an upscaled composition looks
    // low-resolution while editing. Presenting is the opposite case: a deck
    // that refused to fill the screen would letterbox itself for no reason.
    expect(presentScale(slide, { width: 3840, height: 2160 })).toBe(2);
  });

  it('letterboxes rather than cropping when the shapes differ', () => {
    // A 16:9 slide on a 4:3 screen is limited by width, leaving bars.
    expect(presentScale(slide, { width: 1600, height: 1200 })).toBeCloseTo(1600 / 1920, 5);
    // ...and pillarboxed on an ultrawide, limited by height.
    expect(presentScale(slide, { width: 5120, height: 1440 })).toBeCloseTo(1440 / 1080, 5);
  });

  it('never returns 0 or NaN for a degenerate input', () => {
    for (const bad of [{ width: 0, height: 0 }, { width: -5, height: 10 }]) {
      expect(presentScale(slide, bad)).toBe(1);
      expect(presentScale(bad, { width: 800, height: 600 })).toBe(1);
    }
  });
});
