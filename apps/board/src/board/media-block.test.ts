/**
 * The media card's BOX — the thing that made every clip on the canvas look
 * stretched.
 *
 * These are structural tests rather than rendering ones: the component needs a
 * live gfx controller and a mounted editor to render at all, and what actually
 * broke was never the markup. It was the arithmetic AFFiNE applies to it
 * (`scale(bound.w / 752, bound.h / 544)` — two independent factors) and the fact
 * that a view mapping is a static tag name that has to agree with a
 * `customElements.define` written somewhere else.
 */
import { BlockViewIdentifier } from '@blocksuite/std';
import { describe, expect, it } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import {
  IMAGE_BLOCK_TAG, IMAGE_BLOCK_VIEW, MEDIA_BLOCK_TAG, MEDIA_BLOCK_VIEW,
  VoidspaceEdgelessAttachment, VoidspaceEdgelessImage, defineMediaBlock,
} from './media-block';

/** Lit hides a static value's text behind a branded field. Reading it here is
 *  the only way to assert the two spellings match. */
function textOf(literal: unknown): string {
  return (literal as { _$litStatic$: string })._$litStatic$;
}

describe('the media block view', () => {
  it('maps the flavour at the same name the element is defined under', () => {
    /**
     * THE FAILURE THIS CATCHES IS SILENT AND TOTAL.
     *
     * `literal` refuses an interpolated string on purpose, so the tag name is
     * necessarily written twice. If the two drift, the view resolves to an
     * element nobody defined: the browser creates an inert `HTMLUnknownElement`,
     * every clip and track on the board renders as an empty rectangle, and
     * nothing throws.
     */
    expect(textOf(MEDIA_BLOCK_VIEW)).toBe(MEDIA_BLOCK_TAG);
  });

  it('registers the element, and registering twice is not an error', () => {
    // `effect()` can run again across a hot reload, and a second `define` throws
    // — which takes the whole editor down to a blank canvas rather than to a
    // styling bug.
    defineMediaBlock();
    defineMediaBlock();
    expect(customElements.get(MEDIA_BLOCK_TAG)).toBe(VoidspaceEdgelessAttachment);
  });

  it('fills the block box for our media, and only for our media', () => {
    /**
     * THE BUG, PINNED.
     *
     * A clip's box is the CLIP'S own aspect — `placeAsset` probes the real
     * dimensions and writes the height from them — so a 16:9 card was being
     * drawn at 752×544 (1.382:1) and squeezed into 1.778:1. Every pixel of it
     * 22% short: the poster, the 44px play badge (which became a ten-pixel
     * ellipse nobody could hit) and the inline transport alike.
     *
     * Driven through `renderGfxBlock` with a stand-in for the parts of the
     * component it touches, because the real one needs a mounted editor. What is
     * asserted is the only thing that was ever wrong: which style map it picks.
     */
    const render = VoidspaceEdgelessAttachment.prototype.renderGfxBlock;

    const host = (type: string, embed: boolean) => {
      const el = {
        containerStyleMap: null as unknown,
        model: {
          props: {
            type$: { value: type },
            embed$: { value: embed },
            style$: { value: 'cubeThick' },
          },
          elementBound: { w: 360, h: 203 },
        },
        // What `GfxBlockComponent.renderBlock` just used to size the host.
        getRenderingRect: () => ({ x: 0, y: 0, w: 360, h: 203, zIndex: '1' }),
        renderPageContent: () => null,
      };
      render.call(el as never);
      // `styleMap` is a directive result; its declared values are the payload.
      return (el.containerStyleMap as { values: [Record<string, string>] }).values[0];
    };

    /**
     * EXPLICIT PIXELS, matching the block — not `100%`.
     *
     * `100%` was the first attempt and it collapsed the card to a forty-pixel
     * strip along the top of an empty rectangle: the parent
     * (`.affine-block-component`) has no declared height, so a percentage
     * resolves against `auto`. Asserting the pixel values is what stops that
     * being reintroduced as a tidy-looking simplification.
     */
    const clip = host('video/mp4', true);
    expect(clip.width).toBe('360px');
    expect(clip.height).toBe('203px');
    expect(clip.transform).toBeUndefined();

    expect(host('audio/mpeg', true).height).toBe('203px');

    // A file that is NOT one of our embeds keeps AFFiNE's fixed-design-then-
    // scale behaviour: those cards are a layout that should look the same at any
    // size, which is exactly what the scale is for.
    const chip = host('application/zip', false);
    expect(chip.width).toBe('170px');
    expect(chip.transform).toContain('scale(');
  });
});

/**
 * The other half of the fix: the editor has to actually ASK for this element.
 *
 * `AttachmentViewExtension` already claimed `BlockViewIdentifier` for the
 * flavour, so ours has to `override` it — and if that override does not take,
 * nothing anywhere throws. The board simply keeps drawing the squashed card and
 * every test above passes while the bug is still on screen.
 *
 * Resolved out of the SAME container the editor resolves it from, and called
 * with the same argument, rather than mounting: `makeTestBoard`'s host is
 * detached on purpose (that is what keeps these tests in milliseconds), and a
 * gfx block that renders needs a viewport with a real box.
 */
describe('what the editor asks for', () => {
  it('resolves a surface attachment to our element, and a note one to AFFiNE’s', () => {
    const board = makeTestBoard();
    const view = board.std.provider.get(BlockViewIdentifier('affine:attachment')) as
      (model: { parent?: { flavour?: string } | null }) => unknown;

    expect(textOf(view({ parent: { flavour: 'affine:surface' } }))).toBe(MEDIA_BLOCK_TAG);
    // A file inside a note is a document chip, and AFFiNE's own element is
    // right for it — the fixed-design-then-scale behaviour is what that card
    // wants.
    expect(textOf(view({ parent: { flavour: 'affine:note' } }))).toBe('affine-attachment');
  });
});

/**
 * A STILL IS A MEDIA CARD TOO — the view mapping half of that.
 *
 * The board draws one kind of media tile (name strip, corner button to open it
 * full size) and images were the one kind that did not get it: a bare rectangle
 * whose only way in was an unadvertised double-click, sitting beside clips and
 * tracks that said what they were. Three references reading as three different
 * kinds of object is what the card design exists to prevent.
 */
describe('what the editor asks for — images', () => {
  it('resolves a surface image to our element, and one in a note to AFFiNE’s', () => {
    const board = makeTestBoard();
    const view = board.std.provider.get(BlockViewIdentifier('affine:image')) as
      (model: { id: string; store: { getParent: (id: string) => { flavour?: string } | null } }) => unknown;

    const on = (flavour: string) => view({ id: 'i1', store: { getParent: () => ({ flavour }) } });
    expect(textOf(on('affine:surface'))).toBe(IMAGE_BLOCK_TAG);
    // A picture inside a note is a document image; AFFiNE's element is right for
    // it, and canvas chrome would be drawn over a page it is not on.
    expect(textOf(on('affine:note'))).toBe('affine-image');
  });

  it('defines the element under the name the mapping asks for', () => {
    defineMediaBlock();
    expect(textOf(IMAGE_BLOCK_VIEW)).toBe(IMAGE_BLOCK_TAG);
    expect(customElements.get(IMAGE_BLOCK_TAG)).toBe(VoidspaceEdgelessImage);
  });
});
