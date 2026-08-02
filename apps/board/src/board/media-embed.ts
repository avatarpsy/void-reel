/**
 * How media LOOKS on the board: one card, the same for every type.
 *
 * THE DECISION, AND WHY
 * AFFiNE's attachment block plays media inline — a `<video>` for a clip, a
 * native `<audio>` transport bar for a track. On a storyboard that is wrong
 * three times over:
 *
 *  • INCONSISTENT. A picture is a rectangle, a clip is a black rectangle with
 *    chrome, and a track is a wide grey pill. A row of them does not read as a
 *    row of the same kind of thing, which is the whole job of a reference lane.
 *  • SLOW. Every inline player is a network client. Twenty clips in view is
 *    twenty media elements negotiating range requests before the user has asked
 *    to watch anything, and the canvas judders while they do.
 *  • WRONG PLACE. A 90px card is not where anyone watches a video. The controls
 *    are unusable at that size and they steal the clicks that should be
 *    selecting and dragging the card.
 *
 * So a card on the canvas is a POSTER TILE — a still, a badge saying what it is,
 * and its name. It costs one small image, or nothing at all for audio. Playback
 * happens in the inspector (`ui/media-inspector.ts`), full screen, where it belongs and
 * where streaming actually starts.
 *
 * "Load instantly, stream on play" falls straight out of that: the canvas never
 * opens a media stream, so a board of fifty clips costs fifty thumbnails.
 *
 * WHY A ViewExtensionProvider SUBCLASS AND NOT A PLAIN `{ setup }` OBJECT
 * The view spec list holds CLASSES and the loader instantiates each entry. A bare
 * `ExtensionType` object there throws `TypeError: i is not a constructor` during
 * `_build` and takes the whole editor down — blank canvas, stuck boot overlay.
 */
import type { AttachmentEmbedConfig } from '@blocksuite/affine/blocks/attachment';
import { AttachmentEmbedConfigIdentifier } from '@blocksuite/affine/blocks/attachment';
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from '@blocksuite/affine-ext-loader';
import { html } from 'lit';
import { styleMap } from 'lit/directives/style-map.js';

import { decodeMediaRef, isMediaRef } from './media-ref';
import { withToken } from './parent-auth';

/**
 * The size gate is about BLOB storage, so it does not apply to a reference.
 *
 * `check` decides whether an attachment renders as our card or as AFFiNE's
 * download chip, and the built-in version refuses anything over the workspace's
 * max file size. That limit exists to stop a huge file being embedded FROM THE
 * DOCUMENT — which a referenced clip never is. Without this a 900 MB master
 * silently became a download chip while a 40 MB one rendered.
 */
function playable(model: { props: { type: string; size: number; sourceId?: string } },
                  prefix: string, maxFileSize: number): boolean {
  if (!model.props.type.startsWith(prefix)) return false;
  return isMediaRef(model.props.sourceId ?? '') || model.props.size <= maxFileSize;
}

/** A play triangle, drawn rather than imported so the card has no dependency. */
const PLAY_BADGE = html`<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
  <circle cx="12" cy="12" r="11.2" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.85)" stroke-width="1.2" />
  <path d="M9.6 7.8 17 12l-7.4 4.2Z" fill="#fff" />
</svg>`;

const NOTE_BADGE = html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
  <circle cx="12" cy="12" r="11.2" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.85)" stroke-width="1.2" />
  <path d="M10 16.4a2 2 0 1 1-1.4-1.9V8.2l7-1.6v6.9a2 2 0 1 1-1.4-1.9V8.4l-4.2 1v7Z" fill="#fff" />
</svg>`;

/**
 * One card, whatever the medium.
 *
 * `data-vs-media` is what the viewer listens for: a double-click anywhere on a
 * card opens it. Marking the element rather than hit-testing coordinates means
 * the target is exactly what the user sees.
 */
function card(opts: { poster: string; name: string; badge: unknown; tint: string }) {
  return html`<div
    data-vs-media
    style=${styleMap({
      position: 'relative',
      width: '100%',
      height: '100%',
      display: 'flex',
      alignItems: 'flex-end',
      overflow: 'hidden',
      borderRadius: '6px',
      background: opts.poster
        ? `#0d1016 center/cover no-repeat url("${opts.poster}")`
        : opts.tint,
      // The card is a picture, not a control: it must never eat the pointer
      // events that select and drag the block it lives in.
      pointerEvents: 'none',
      cursor: 'pointer',
    })}
  >
    <div style=${styleMap({
      position: 'absolute', inset: '0', display: 'grid', placeItems: 'center',
    })}>${opts.badge}</div>
    <div style=${styleMap({
      position: 'relative', width: '100%', padding: '4px 6px',
      font: '500 10px/1.25 var(--affine-font-family, sans-serif)',
      color: '#fff', background: 'linear-gradient(transparent, rgba(0,0,0,0.72))',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    })}>${opts.name}</div>
  </div>`;
}

function refOf(model: { props: { sourceId?: string } }) {
  return model.props.sourceId ? decodeMediaRef(model.props.sourceId) : null;
}

const videoConfig: AttachmentEmbedConfig = {
  name: 'video',
  check: (model, maxFileSize) => playable(model, 'video/', maxFileSize),
  action: model => {
    // Only `embed: true` — the SIZE is the lane's business, and rewriting it
    // here would undo the arrangement that had just placed the card.
    model.store.updateBlock(model, { embed: true, style: 'video' });
  },
  render: model => {
    const ref = refOf(model);
    return card({
      poster: ref?.poster ? withToken(ref.poster) : '',
      name: model.props.name || 'Clip',
      badge: PLAY_BADGE,
      tint: '#141821',
    });
  },
};

const audioConfig: AttachmentEmbedConfig = {
  name: 'audio',
  check: (model, maxFileSize) => playable(model, 'audio/', maxFileSize),
  action: model => {
    model.store.updateBlock(model, { embed: true });
  },
  render: model => card({
    // Audio has no still, so the card is a tinted tile of the SAME shape as the
    // others. A native transport bar here was the "music looks weird" report:
    // a wide grey pill among rectangles, with controls too small to use.
    poster: '',
    name: model.props.name || 'Audio',
    badge: NOTE_BADGE,
    tint: 'linear-gradient(135deg,#2b2350,#1b2340)',
  }),
};

export class VoidspaceMediaViewExtension extends ViewExtensionProvider {
  override name = 'voidspace-media-embed';

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    // `override` (not `addImpl`): AttachmentViewExtension already registered
    // these two names, and the container throws on a duplicate identifier.
    context.register({
      setup: di => {
        di.override(AttachmentEmbedConfigIdentifier(videoConfig.name), () => videoConfig);
        di.override(AttachmentEmbedConfigIdentifier(audioConfig.name), () => audioConfig);
      },
    });
  }
}
