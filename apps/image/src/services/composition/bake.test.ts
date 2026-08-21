/**
 * When a composition is worth spending a render on.
 *
 * A block render is a browser starting on the user's own machine — tens of
 * seconds of their laptop. Deciding to do it twice for the same picture is
 * expensive; deciding not to do it when the words have changed ships a slide
 * showing the previous draft. Both mistakes are silent, so the decision is a
 * pure function with tests rather than a condition inside a fetch.
 */
import { describe, it, expect } from 'vitest';
import { shouldBake } from './bake';
import { compositionHash } from './hash';
import type { CompositionSource, ImageLayer } from '../../types/project';

const source = (over: Partial<CompositionSource> = {}): CompositionSource => ({
  block: 'deck-title',
  slots: { headline: 'Hello' },
  fillMode: 'render',
  poseTime: 'end',
  frameWidth: 1920,
  frameHeight: 1080,
  renderHash: '',
  ...over,
});

const layer = (over: Partial<ImageLayer> = {}): ImageLayer => ({
  id: 'l1',
  type: 'image',
  name: 'Slide 1',
  visible: true,
  locked: false,
  opacity: 1,
  blendMode: 'normal',
  parentId: null,
  transform: { x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1 },
  sourceId: '',
  cropRect: null,
  ...over,
} as unknown as ImageLayer);

describe('deciding to render a composition', () => {
  it('renders one that has no pixels at all', () => {
    // The case the whole module exists for: a placed block is an empty image
    // layer until something draws it.
    expect(shouldBake(layer({ composition: source() }))).toBe(true);
  });

  it('does not re-render a picture that is already current', () => {
    const c = source();
    expect(shouldBake(layer({
      sourceId: 'asset-1',
      composition: { ...c, renderHash: compositionHash(c) },
    }))).toBe(false);
  });

  it('re-renders when the words changed under the pixels', () => {
    // "Has pixels" is not the question — "has pixels OF THIS" is. Edit a slot
    // and the existing render is a picture of the previous draft.
    const rendered = source({ slots: { headline: 'Hello' } });
    const edited = { ...source({ slots: { headline: 'Hello there' } }), renderHash: compositionHash(rendered) };
    expect(shouldBake(layer({ sourceId: 'asset-1', composition: edited }))).toBe(true);
  });

  it('re-renders when pixels exist but nothing recorded what they were of', () => {
    // Pixels, but no record of what they were of — unknown is not current.
    expect(shouldBake(layer({ sourceId: 'asset-1', composition: source() }))).toBe(true);
  });

  it('leaves ordinary pictures alone', () => {
    expect(shouldBake(layer({ sourceId: 'photo-1' }))).toBe(false);
    expect(shouldBake(undefined)).toBe(false);
  });
});
