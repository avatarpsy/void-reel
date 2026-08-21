/**
 * The two decisions present mode makes before drawing anything.
 *
 * Both are the kind that look obviously right and are quietly wrong at the
 * edges: which pages may be run as a live document, and how big to draw one.
 */
import { describe, it, expect } from 'vitest';
import { presentPieces, presentScale } from './PresentMode';
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

const imageLayer = (id: string): Layer => ({
  id, type: 'image', name: 'Photo', visible: true,
  transform: { x: 0, y: 0, width: 600, height: 400, rotation: 0, opacity: 1 },
  sourceId: 'asset1',
} as unknown as Layer);

describe('presentPieces', () => {
  it('runs a slide that is one block', () => {
    const p = make({ B: blockLayer() }, ['B']);
    expect(presentPieces(p, p.artboards[0])).toEqual([{ kind: 'live', layerId: 'B' }]);
  });

  it('STILL runs the block when a graphic is dropped on the slide', () => {
    // The reported bug: adding a second layer to a slide silently stopped it
    // animating, because the old rule ran a frame only for a lone full-page
    // composition. A still of a posed block looks much like the finished frame
    // of an animated one, so nothing on screen said why.
    const p = make({ B: blockLayer(), T: textLayer() }, ['B', 'T']);
    expect(presentPieces(p, p.artboards[0])).toEqual([
      { kind: 'live', layerId: 'B' },
      { kind: 'raster', layerIds: ['T'] },
    ]);
  });

  it('runs BOTH blocks when a slide has two', () => {
    const p = make({ B: blockLayer({ id: 'B' }), C: blockLayer({ id: 'C' }) }, ['B', 'C']);
    expect(presentPieces(p, p.artboards[0])).toEqual([
      { kind: 'live', layerId: 'B' },
      { kind: 'live', layerId: 'C' },
    ]);
  });

  it('groups consecutive ordinary layers into ONE image, preserving z-order', () => {
    // Runs rather than one image per layer: a graphic above the first block and
    // below the second has to stay between them.
    const p = make(
      { A: imageLayer('A'), T: textLayer(), B: blockLayer(), Z: imageLayer('Z') },
      ['A', 'T', 'B', 'Z'],
    );
    expect(presentPieces(p, p.artboards[0])).toEqual([
      { kind: 'raster', layerIds: ['A', 'T'] },
      { kind: 'live', layerId: 'B' },
      { kind: 'raster', layerIds: ['Z'] },
    ]);
  });

  it('leaves hidden layers out of the slide entirely', () => {
    const hidden = { ...(textLayer() as any), visible: false } as Layer;
    const p = make({ B: blockLayer(), T: hidden }, ['B', 'T']);
    expect(presentPieces(p, p.artboards[0])).toEqual([{ kind: 'live', layerId: 'B' }]);
  });

  it('draws a slide with no blocks at all as one image', () => {
    const p = make({ A: imageLayer('A'), T: textLayer() }, ['A', 'T']);
    expect(presentPieces(p, p.artboards[0])).toEqual([{ kind: 'raster', layerIds: ['A', 'T'] }]);
  });

  it('returns nothing for an empty page rather than a blank raster', () => {
    const p = make({}, []);
    expect(presentPieces(p, p.artboards[0])).toEqual([]);
  });

  it('keeps the project TOP-FIRST order, which is what the canvas paints', () => {
    /**
     * `artboard.layerIds` holds the top layer at index 0 — the canvas and
     * exportArtboard both reverse before drawing, and every add inserts at 0
     * so new work lands on top. Reading it as bottom-to-top puts a graphic
     * placed onto a slide BEHIND the slide, which is how a freshly placed
     * block came to be invisible and silent at the same time.
     *
     * So piece 0 is the frontmost, and the renderer gives it the highest
     * z-index.
     */
    const p = make({ Top: imageLayer('Top'), B: blockLayer() }, ['Top', 'B']);
    expect(presentPieces(p, p.artboards[0])).toEqual([
      { kind: 'raster', layerIds: ['Top'] },   // index 0 → drawn in front
      { kind: 'live', layerId: 'B' },
    ]);
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
