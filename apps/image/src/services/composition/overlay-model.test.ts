/**
 * The rules these pin are not preferences.
 *
 * Two live frames of the same block share `window.__timelines[id]` and a
 * `[data-composition-id]` selector namespace and fight over both, so "at most
 * one" is correctness. A frame kept alive off-screen is a timeline animating for
 * nobody. And a frame rebuilt on pan restarts its animation, which is a slide
 * that flickers back to its first frame while you scroll past it.
 */
import { describe, it, expect } from 'vitest';
import {
  compositionLayers,
  isCompositionLayer,
  liveFrameIdentity,
  pickLiveComposition,
  type CompositionLayerRef,
} from './overlay-model';
import type { CompositionSource, Layer } from '../../types/project';
import type { Viewport } from './overlay-placement';

const ARTBOARD = { width: 1920, height: 1080 };

const vp = (over: Partial<Viewport> = {}): Viewport => ({
  canvasWidth: 1000,
  canvasHeight: 800,
  zoom: 1,
  panX: 0,
  panY: 0,
  ...over,
});

const source = (over: Partial<CompositionSource> = {}): CompositionSource => ({
  block: 'stat-punch',
  tier: 'starter',
  slots: { headline: 'Reach by month' },
  fillMode: 'render',
  poseTime: 'end',
  frameWidth: 1920,
  frameHeight: 1080,
  renderHash: '',
  ...over,
});

/** Only type, transform and `composition` are read here, so the rest of a
 *  layer's forty fields are noise the cast keeps out of the test. */
function layer(
  id: string,
  over: { composition?: CompositionSource; visible?: boolean; rect?: Partial<{ x: number; y: number; width: number; height: number }> } = {},
): Layer {
  return {
    id,
    name: id,
    type: 'image',
    visible: over.visible ?? true,
    transform: { x: 0, y: 0, width: 1920, height: 1080, rotation: 0, opacity: 1, ...over.rect },
    composition: over.composition,
  } as unknown as Layer;
}

const index = (layers: Layer[]): Record<string, Layer> =>
  Object.fromEntries(layers.map((l) => [l.id, l]));

describe('recognising a composition layer', () => {
  it('is an image layer that carries a source', () => {
    expect(isCompositionLayer(layer('a', { composition: source() }))).toBe(true);
  });

  it('is not an ordinary image layer', () => {
    // The distinction the whole design rests on: a composition IS an image
    // layer, so the type alone can never answer this.
    expect(isCompositionLayer(layer('a'))).toBe(false);
  });

  it('is not a missing layer', () => {
    expect(isCompositionLayer(undefined)).toBe(false);
    expect(isCompositionLayer(null)).toBe(false);
  });
});

describe('finding the compositions on a page', () => {
  it('keeps them in the stored order, which is top-most first', () => {
    const layers = index([
      layer('top', { composition: source() }),
      layer('plain'),
      layer('bottom', { composition: source({ block: 'flowchart' }) }),
    ]);
    const found = compositionLayers(['top', 'plain', 'bottom'], layers);
    expect(found.map((c) => c.layerId)).toEqual(['top', 'bottom']);
  });

  it('carries the layer box in artboard pixels', () => {
    const layers = index([layer('a', { composition: source(), rect: { x: 100, y: 50, width: 400, height: 300 } })]);
    expect(compositionLayers(['a'], layers)[0].rect).toEqual({ x: 100, y: 50, width: 400, height: 300 });
  });

  it('ignores an id with no layer behind it', () => {
    expect(compositionLayers(['ghost'], {})).toEqual([]);
  });
});

describe('choosing the one that runs live', () => {
  const opts = (over: Partial<Parameters<typeof pickLiveComposition>[1]> = {}) => ({
    viewport: vp(),
    artboard: ARTBOARD,
    selectedLayerIds: [] as string[],
    ...over,
  });

  const refs = (...ids: string[]): CompositionLayerRef[] =>
    ids.map((id) => ({ layerId: id, rect: { x: 0, y: 0, width: 1920, height: 1080 }, source: source() }));

  it('runs exactly one, however many the page holds', () => {
    // Not a performance choice. Three `stat-card` slides in one document share
    // one timeline object and one selector namespace and would fight.
    const picked = pickLiveComposition(refs('a', 'b', 'c'), opts());
    expect(picked?.layerId).toBe('a');
  });

  it('prefers the SELECTED layer over the top-most one', () => {
    // Clicking a slide to edit it and watching a different slide animate is the
    // failure this prevents.
    const picked = pickLiveComposition(refs('a', 'b', 'c'), opts({ selectedLayerIds: ['c'] }));
    expect(picked?.layerId).toBe('c');
  });

  it('falls back to the top-most when nothing is selected', () => {
    // The fallback exists only because a composition has no cached bitmap yet;
    // without it a deselected slide would leave a blank artboard.
    expect(pickLiveComposition(refs('a', 'b'), opts())?.layerId).toBe('a');
  });

  it('runs nothing when the page holds no composition', () => {
    expect(pickLiveComposition([], opts())).toBeNull();
  });

  it('skips a hidden layer, because a hidden layer draws nothing', () => {
    const picked = pickLiveComposition(refs('a', 'b'), opts({ hidden: (id) => id === 'a' }));
    expect(picked?.layerId).toBe('b');
  });

  it('will not run a hidden layer even when it is selected', () => {
    expect(pickLiveComposition(refs('a'), opts({ selectedLayerIds: ['a'], hidden: () => true }))).toBeNull();
  });

  it('stops running a frame panned off screen', () => {
    // A document animating outside the viewport is a GSAP timeline and a
    // compositor layer spent on something nobody can see.
    expect(pickLiveComposition(refs('a'), opts({ viewport: vp({ panX: -5000 }) }))).toBeNull();
  });

  it('refuses a zero-sized layer rather than scaling a frame by nothing', () => {
    const flat: CompositionLayerRef[] = [
      { layerId: 'flat', rect: { x: 0, y: 0, width: 0, height: 1080 }, source: source() },
    ];
    expect(pickLiveComposition(flat, opts())).toBeNull();
  });
});

describe('when a live frame has to be rebuilt', () => {
  const ref = (over: Partial<CompositionSource> = {}, layerId = 'a'): CompositionLayerRef => ({
    layerId,
    rect: { x: 0, y: 0, width: 1920, height: 1080 },
    source: source(over),
  });

  it('does not change when only the view does', () => {
    // Pan and zoom are a transform on an existing frame. If they changed this,
    // every scroll wheel click would restart the animation.
    expect(liveFrameIdentity(ref())).toBe(liveFrameIdentity(ref()));
  });

  it('changes when a slot is edited', () => {
    expect(liveFrameIdentity(ref({ slots: { headline: 'Different' } })))
      .not.toBe(liveFrameIdentity(ref()));
  });

  it('does not depend on the order slots were filled in', () => {
    const a = ref({ slots: { headline: 'H', subtitle: 'S' } });
    const b = ref({ slots: { subtitle: 'S', headline: 'H' } });
    expect(liveFrameIdentity(a)).toBe(liveFrameIdentity(b));
  });

  it('changes for the pose, the frame and the fill mode', () => {
    const base = liveFrameIdentity(ref());
    expect(liveFrameIdentity(ref({ poseTime: 0 }))).not.toBe(base);
    expect(liveFrameIdentity(ref({ frameWidth: 1080, frameHeight: 1920 }))).not.toBe(base);
    expect(liveFrameIdentity(ref({ fillMode: 'preview' }))).not.toBe(base);
  });

  it('changes when a different layer takes over the frame', () => {
    expect(liveFrameIdentity(ref({}, 'b'))).not.toBe(liveFrameIdentity(ref({}, 'a')));
  });

  it('is empty when nothing is running, so an effect can tear down on it', () => {
    expect(liveFrameIdentity(null)).toBe('');
  });

  it('stays short for a composition carrying a large authored document', () => {
    // This string is compared on every render; carrying a 100 KB document in it
    // would copy the document each time.
    const big = ref({ block: undefined, inlineHtml: 'x'.repeat(100_000) });
    expect(liveFrameIdentity(big).length).toBeLessThan(400);
  });
});
