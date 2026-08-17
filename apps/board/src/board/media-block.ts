/**
 * The BOX a media card is drawn in — and the reason clips looked squashed.
 *
 * ── THE BUG, EXACTLY ─────────────────────────────────────────────────────────
 * AFFiNE draws an edgeless attachment at a FIXED nominal size and then scales
 * that rendering onto the block's box
 * (`affine-block-attachment/src/attachment-edgeless-block.ts`):
 *
 *   const width  = EMBED_CARD_WIDTH[style];    // 'video' → 752
 *   const height = EMBED_CARD_HEIGHT[style];   // 'video' → 544
 *   transform: `scale(bound.w / width, bound.h / height)`
 *
 * Two INDEPENDENT scale factors. That is right for a link card, whose layout is
 * a fixed design that should look the same at any size. It is wrong for ours,
 * because the box a clip lives in is the CLIP'S OWN ASPECT — `placeAsset` probes
 * the real dimensions and sets the height from them — and 16:9 is not 752:544.
 * The card was therefore drawn at 1.382:1 and squeezed into 1.778:1: every pixel
 * of it 22% shorter than it should be. That is the "the thumbnail is stretched"
 * report, and it is also:
 *
 *   • the play badge — a 44px circle rendered nominally, then scaled by
 *     170/752 ≈ 0.23, i.e. a TEN PIXEL ellipse. "I can't press play" was
 *     literally true.
 *   • the name strip — 10px type at 0.23 is two pixels tall.
 *   • the inline `<video>` — its native transport squashed to a few pixels of
 *     unusable chrome, which is what "the player is glitchy" looks like.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────────
 * A media card has no fixed design to preserve: it is a poster, a badge and a
 * caption, and all three want to be laid out in the box they are actually in. So
 * for OUR embeds the container is simply the block's box — no nominal size, no
 * transform, nothing to be non-uniform. `background: cover` then crops to a box
 * that already matches the clip, which means it crops nothing.
 *
 * Anything else — a plain file chip, a PDF — keeps AFFiNE's behaviour untouched.
 * Those genuinely are fixed designs, and the scale is what keeps their text
 * proportional.
 *
 * ── WHY A NEW ELEMENT AND NOT A PATCH ────────────────────────────────────────
 * `containerStyleMap` is assigned inside `renderGfxBlock`, so there is no seam
 * to hook. Redefining `affine-edgeless-attachment` is impossible — a custom
 * element name can only be defined once — so this registers a second element and
 * `media-embed.ts` points the flavour's view at it with `di.override`, which is
 * the same mechanism the embed configs already use.
 */
import { AttachmentBlockComponent } from '@blocksuite/affine/blocks/attachment';
import { ImageEdgelessBlockComponent } from '@blocksuite/affine/blocks/image';
import { AttachmentBlockStyles } from '@blocksuite/affine/model';
import { EMBED_CARD_HEIGHT, EMBED_CARD_WIDTH } from '@blocksuite/affine/shared/consts';
import { toGfxBlockComponent } from '@blocksuite/std';
import { css, html } from 'lit';
import { styleMap } from 'lit/directives/style-map.js';
import { literal } from 'lit/static-html.js';

import { readBlockMeta } from './board-meta';

/** The tag `media-embed.ts` points `affine:attachment` at on the surface. */
export const MEDIA_BLOCK_TAG = 'voidspace-edgeless-attachment';

/** And the one it points `affine:image` at — see `VoidspaceEdgelessImage`. */
export const IMAGE_BLOCK_TAG = 'voidspace-edgeless-image';

/**
 * The same name as a lit STATIC value, which is the only thing a view mapping
 * accepts. `literal` refuses an interpolated string — it exists precisely to
 * make a tag name unforgeable — so the name is written twice on purpose and the
 * two must be kept in step. `media-block.test.ts` asserts that they are.
 */
export const MEDIA_BLOCK_VIEW = literal`voidspace-edgeless-attachment`;
export const IMAGE_BLOCK_VIEW = literal`voidspace-edgeless-image`;

/** Is this block one of the cards `media-embed.ts` draws? */
function isVoidspaceMedia(type: string, embed: boolean): boolean {
  return embed && (type.startsWith('video/') || type.startsWith('audio/'));
}

export class VoidspaceEdgelessAttachment
  extends toGfxBlockComponent(AttachmentBlockComponent) {
  /** As AFFiNE's own edgeless attachment: the gfx layer moves the block, so the
   *  drag-handle must not offer a second, competing way to do it. */
  override blockDraggable = false;

  /** Selection on a canvas is the gfx layer's business. The page-mode handler
   *  creates a BLOCK selection in the 'note' group, which on a surface means
   *  nothing and swallows the click that should have selected the card. */
  override onClick(_: MouseEvent): void {
    return;
  }

  /**
   * A MEDIA BLOCK ON THE CANVAS IS ALWAYS THE EMBED. There is no card view.
   *
   * `embed: false` makes `renderEmbedView` return null and the block falls back
   * to AFFiNE's download chip — a grey file row where a video was. The toolbar
   * button that did that is gone (see `media-embed.ts`), and this closes the
   * door from the other side: boards that already went through it, an agent
   * writing the prop, a paste from somewhere else.
   *
   * `withoutTransact` because it is a repair, not an edit: it must not become an
   * undo step the user did not make, and it must not mark the board dirty on
   * open for a change nobody asked for. Exactly the arrangement
   * `AttachmentBlockComponent.connectedCallback` already uses to default the
   * card style.
   */
  override connectedCallback(): void {
    super.connectedCallback();
    const props = this.model.props;
    if (this.store.readonly) return;
    if (!isVoidspaceMedia(props.type, true) || props.embed) return;
    this.store.withoutTransact(() => {
      this.store.updateBlock(this.model, { embed: true });
    });
  }

  override renderGfxBlock() {
    const { style$, embed$, type$ } = this.model.props;

    if (isVoidspaceMedia(type$.value, embed$.value ?? false)) {
      /**
       * THE BLOCK'S OWN BOX, IN PIXELS — and the pixels are not a style choice.
       *
       * `100%` was tried and collapses the card to a forty-pixel strip along the
       * top of an empty rectangle. A percentage height needs a DEFINITE height
       * on the parent, and the parent is `.affine-block-component`
       * (`CaptionedBlockComponent._renderWithWidget`), which declares
       * `position: relative` and nothing else — so `height: 100%` resolves
       * against `auto`, falls back to content height, and every child that also
       * asked for `100%` collapses with it.
       *
       * That is why AFFiNE writes explicit pixels here. What was wrong was never
       * the pixels; it was the `scale(w/752, h/544)` that followed them, which
       * squeezed a card designed at 1.382:1 onto a box that is the CLIP'S aspect.
       * So: the same explicit box, sized to the block instead of to a constant,
       * and no transform at all.
       *
       * From `getRenderingRect` rather than `elementBound`, because that is
       * literally the function that just sized the host element — reading the
       * same numbers means the two can never disagree by a pixel.
       */
      const { w, h } = this.getRenderingRect();
      this.containerStyleMap = styleMap({
        position: 'relative',
        width: `${w}px`,
        height: `${h}px`,
        overflow: 'hidden',
      });
      return this.renderPageContent();
    }

    // Everything else keeps AFFiNE's fixed-design-then-scale behaviour.
    const cardStyle = style$.value ?? AttachmentBlockStyles[1];
    const width = EMBED_CARD_WIDTH[cardStyle];
    const height = EMBED_CARD_HEIGHT[cardStyle];
    const bound = this.model.elementBound;
    this.containerStyleMap = styleMap({
      width: `${width}px`,
      height: `${height}px`,
      transform: `scale(${bound.w / width}, ${bound.h / height})`,
      transformOrigin: '0 0',
      overflow: 'hidden',
    });
    return this.renderPageContent();
  }
}

/**
 * A PICTURE IS A MEDIA CARD TOO.
 *
 * ── THE INCONSISTENCY, AND WHY IT MATTERED ───────────────────────────────────
 * The board has one idea of what media on the canvas looks like — a tile with
 * its NAME along the bottom and a corner button that opens it full size — and
 * images were the one kind that did not get it. A clip and a track said what
 * they were and how to open them; a still was a bare rectangle whose only way
 * in was a double-click nothing advertised, and whose name existed only in the
 * asset panel. Three references side by side read as three different kinds of
 * object, which is exactly the complaint the card design was written to fix.
 *
 * ── WHY THIS SUBCLASSES RATHER THAN REPLACES ─────────────────────────────────
 * Unlike the attachment, AFFiNE's image block is RIGHT: it already draws a
 * lazily-loaded `<img>` at the block's own size with no transform, and it owns
 * loading, error and upload states worth keeping. So nothing is overridden —
 * the chrome is appended after it, and the picture underneath is untouched.
 *
 * The strip is drawn by `media-embed.ts` so a still, a clip and a track are
 * literally the same markup and cannot drift apart.
 */
export class VoidspaceEdgelessImage extends ImageEdgelessBlockComponent {
  /**
   * THE PARENT'S STYLES ARE SCOPED TO ITS TAG NAME, so none of them reach us.
   *
   * `ImageEdgelessBlockComponent.styles` is written as
   * `affine-edgeless-image .resizable-img img { width: 100%; height: 100% }` —
   * every selector begins with the element's own tag. Lit inherits `static
   * styles` down the class chain, so the rules were present and matched nothing,
   * because this element is `voidspace-edgeless-image`.
   *
   * The visible result is the resize bug: the `<img>` fell back to its NATURAL
   * size while the block's box stayed whatever the user had dragged it to, so
   * the selection rectangle and the picture were two different rectangles. Drag
   * a handle and the outline moved while the image did not.
   *
   * `position: relative` matters for the same silent reason — it is the
   * containing block the loading spinner, the error status and our own chrome
   * are positioned against, and without it they resolve against whatever
   * ancestor happens to be positioned.
   *
   * Re-stated rather than rewritten: same declarations, our selector. The
   * attachment subclass needs none of this because the attachment block styles
   * itself by CLASS.
   */
  static override styles = css`
    voidspace-edgeless-image {
      position: relative;
    }

    voidspace-edgeless-image .resizable-img,
    voidspace-edgeless-image .resizable-img img {
      width: 100%;
      height: 100%;
    }

    voidspace-edgeless-image .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      position: absolute;
      top: 4px;
      right: 4px;
      width: 36px;
      height: 36px;
      padding: 5px;
      border-radius: 8px;
      background: rgba(146, 146, 146, 0.22);
    }
    voidspace-edgeless-image .loading > svg { font-size: 25.71px; }

    voidspace-edgeless-image .affine-image-status {
      position: absolute;
      left: 18px;
      bottom: 18px;
    }
  `;

  /**
   * Set by `media-embed.ts`, which owns what a card looks like. A function
   * rather than an import because the two modules would otherwise be a cycle:
   * the card needs the tag names this file defines.
   */
  static chrome: ((blockId: string, name: string) => unknown) | null = null;

  override renderGfxBlock() {
    const picture = super.renderGfxBlock();
    const chrome = VoidspaceEdgelessImage.chrome;
    if (!chrome) return picture;
    /**
     * THE LIBRARY'S NAME FOR IT, not AFFiNE's caption.
     *
     * `caption` is the block's own field and is empty on everything the board
     * places — it is what a user types under a picture in a document. What a
     * still is CALLED lives in board meta, written by `placeAsset` from the
     * Library, and it is the same string the clip and track cards show. Caption
     * is kept as the fallback so a picture somebody has captioned by hand still
     * says something.
     */
    const meta = readBlockMeta(this.store.doc.spaceDoc, this.model.id);
    const name = meta?.name || this.model.props.caption || '';
    return html`${picture}${chrome(this.model.id, name)}`;
  }
}

/**
 * Define the elements, once.
 *
 * Guarded because a custom element name is global and `effect()` can run again
 * across a hot reload — a second `define` throws and takes the editor down with
 * it, which is a blank canvas rather than a styling bug.
 */
export function defineMediaBlock(): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(MEDIA_BLOCK_TAG)) {
    customElements.define(MEDIA_BLOCK_TAG, VoidspaceEdgelessAttachment);
  }
  if (!customElements.get(IMAGE_BLOCK_TAG)) {
    customElements.define(IMAGE_BLOCK_TAG, VoidspaceEdgelessImage);
  }
}
