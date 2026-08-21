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
import { shouldBake, backgroundFor } from './bake';
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

/**
 * The renderer strips a composition's own background — measured: a root carrying
 * `background: var(--bg,#0A0A12)` comes back rgba(0,0,0,0) while a plain child
 * with a literal colour comes back opaque. Correct for a lower third that has to
 * composite over footage; wrong for a slide, which is then drawn over whatever
 * the artboard happens to be. A dark deck came out as white thumbnails with a few
 * pale words, while the canvas looked right because the canvas shows the live
 * frame rather than the pixels.
 */
describe('restoring the background the renderer removed', () => {
  it('uses the themed bg slot when the deck has one', () => {
    expect(backgroundFor({ bg: '#07070E' }, 'irrelevant')).toBe('#07070E');
  });

  it('falls back to the colour the block itself declares', () => {
    // The designer's own answer to "what is behind this".
    const css = '#root{background:var(--bg, #0A0A12);color:var(--ink,#fff)}';
    expect(backgroundFor(undefined, css)).toBe('#0A0A12');
    expect(backgroundFor({ headline: 'hi' }, css)).toBe('#0A0A12');
  });

  it('prefers the slot over the declaration, because the deck was themed', () => {
    const css = '#root{background:var(--bg,#0A0A12)}';
    expect(backgroundFor({ bg: '#ffffff' }, css)).toBe('#ffffff');
  });

  it('says nothing rather than inventing a colour', () => {
    // A block with no declared background is one we cannot guess for: leaving the
    // render transparent is honest, and still better than no pixels at all.
    expect(backgroundFor(undefined, '#root{color:red}')).toBeNull();
    expect(backgroundFor({ bg: 'not-a-colour' }, '#root{color:red}')).toBeNull();
  });
});
