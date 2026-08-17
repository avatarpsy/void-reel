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
 * and its name. It costs one small image, or nothing at all for audio.
 *
 * ── WHERE THAT WAS TOO STRICT, AND THE SHARPER RULE ──────────────────────────
 * All three reasons are about players that exist WITHOUT BEING ASKED FOR. None
 * of them is a reason that pressing play should have to open a modal — and for a
 * while it did: the badge was a picture of a play button that did nothing, and
 * the only way to hear a track was a full-screen dialog.
 *
 * The rule is therefore:
 *
 *   NOTHING STREAMS UNTIL SOMEBODY PRESSES PLAY, and at most one thing streams
 *   at a time (`board/inline-player.ts`).
 *
 * A board of fifty clips still costs fifty thumbnails and opens as fast as an
 * empty one — the property that mattered is untouched. Pressing play builds
 * exactly one element, pointed at the 720p proxy, and it is torn down when
 * something else plays or when its card leaves the screen.
 *
 * The inspector is still where a reference is JUDGED: it loads the MASTER for
 * stills and it owns the trim bar. This is for the question asked far more
 * often — "what is this clip, again?"
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
import { ToolbarModuleIdentifier } from '@blocksuite/affine/shared/services';
import { BlockFlavourIdentifier, BlockViewIdentifier } from '@blocksuite/std';
import { html, nothing } from 'lit';
import { styleMap } from 'lit/directives/style-map.js';
import { literal } from 'lit/static-html.js';

import { isPlayingIn, playInline, stopInlinePlayback } from './inline-player';
import {
  defineMediaBlock, IMAGE_BLOCK_VIEW, MEDIA_BLOCK_TAG, MEDIA_BLOCK_VIEW,
  VoidspaceEdgelessImage,
} from './media-block';
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

/**
 * PLAY AND PAUSE, BOTH DRAWN, and the card shows whichever applies.
 *
 * ── WHY A TRACK GETS THE SAME CONTROL AS A CLIP ──────────────────────────────
 * An audio card used to draw a MUSICAL NOTE where a clip draws a triangle. It
 * was a real button — pressing it played the track — but it did not look like
 * one, so the report was simply "music cards don't have play buttons", and it
 * was a fair reading: a note is an icon that says what a thing IS, and every
 * other affordance on the board says what pressing it DOES. The card already
 * says what it is, twice over: a track has no poster and its own tint, and its
 * name is along the bottom. So the control is a transport on both, and the note
 * moved to a corner chip where an identifier belongs.
 *
 * ── AND WHY BOTH GLYPHS ARE ALWAYS IN THE DOM ────────────────────────────────
 * The card's template is behind AFFiNE's `guard([refreshKey])`, so a Lit
 * re-render does NOT repaint it — that is deliberate and load-bearing (it is
 * what stops a re-render destroying the running `<video>`). A badge that
 * swapped its markup on play would therefore never swap back. Both are drawn
 * once and CSS shows one, keyed off a class on the card, so the transport is
 * toggled by `classList` — nothing to re-render, and nothing to get out of step.
 */
const PLAY_GLYPH = html`<svg class="vs-ic vs-ic--play" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
  <circle cx="12" cy="12" r="11.2" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.85)" stroke-width="1.2" />
  <path d="M9.6 7.8 17 12l-7.4 4.2Z" fill="#fff" />
</svg>`;

const PAUSE_GLYPH = html`<svg class="vs-ic vs-ic--pause" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
  <circle cx="12" cy="12" r="11.2" fill="rgba(0,0,0,0.62)" stroke="rgba(255,255,255,0.9)" stroke-width="1.2" />
  <path d="M9.4 7.6h2.1v8.8H9.4Zm3.1 0h2.1v8.8h-2.1Z" fill="#fff" />
</svg>`;

const TRANSPORT = html`${PLAY_GLYPH}${PAUSE_GLYPH}`;

/** What a track IS, said in the corner — the job the note badge used to do from
 *  the middle, where the transport belongs. */
const NOTE_CHIP = html`<span class="vs-kind" aria-hidden="true">
  <svg viewBox="0 0 24 24" width="11" height="11">
    <path d="M10 16.4a2 2 0 1 1-1.4-1.9V8.2l7-1.6v6.9a2 2 0 1 1-1.4-1.9V8.4l-4.2 1v7Z" fill="currentColor" />
  </svg>
</span>`;

/**
 * PLAY, WHERE THE CARD IS.
 *
 * The badge used to be decoration — a triangle saying "this is a clip" that did
 * nothing when you pressed it, which is the most disappointing kind of button
 * there is. It now starts playback in place: one `<video>` streaming the proxy,
 * torn down when something else plays or when the card leaves the screen.
 *
 * The card stays pointer-transparent (the canvas must be able to drag the block
 * it lives in) and this ONE element opts back in — which is why it is a real
 * button rather than a click handler on the card.
 *
 * `stopPropagation` on pointerdown as well as click: without it the press starts
 * a canvas drag and the card moves out from under the finger before the click
 * lands.
 *
 * ── THE BUTTON IS THE BADGE, NOT THE CARD ────────────────────────────────────
 * This was `inset: 0`, so the button covered the whole tile. Two consequences,
 * and they were the same bug wearing two faces:
 *
 *   • EVERY click played. Clicking a clip to SELECT it — the most common thing
 *     anyone does to a card on a canvas — started a stream instead.
 *   • The card could not be selected or dragged by its picture AT ALL. The
 *     pointerdown was swallowed here and never reached the gfx layer, so the
 *     only draggable part of a clip card was the name strip along its bottom.
 *
 * The second one contradicts the rule the rest of the board is built on, stated
 * in `ui/media-inspector.ts`: "on the canvas a single click selects, which is
 * how every canvas works and what dragging depends on."
 *
 * So the hit area is the badge and nothing more. Everything outside it falls
 * through to the canvas, which is what restores select, drag, and
 * double-click-to-open on clips and tracks.
 */
const PLAY_HIT = 44;

/**
 * THE BADGE FADES; IT DOES NOT SHOUT.
 *
 * A board of fifty clips was fifty play buttons at full strength — a wall of
 * chrome over the pictures the user is actually trying to compare. Dimmed at
 * rest and full on hover, the board reads as images again, and the control is
 * exactly where it always was the moment a pointer goes near it.
 *
 * A REAL STYLESHEET, injected once, because these cards are rendered with
 * `styleMap` — inline styles, which cannot express `:hover` at all. Injected
 * once per document rather than a `<style>` inside the card template: the
 * template renders per card and per update, and fifty identical style elements
 * is fifty things for the browser to parse and reconcile.
 */
let playStylesInjected = false;
function ensurePlayStyles(): void {
  if (playStylesInjected || typeof document === 'undefined') return;
  playStylesInjected = true;
  const el = document.createElement('style');
  /**
   * OPACITY ONLY, and the two things it cannot do are worth stating.
   *
   * No `transform` on hover: the button's centring transform is an INLINE style
   * (`styleMap`), and inline beats a stylesheet rule, so a scale here would
   * silently never apply — or worse, land without the translate and throw the
   * badge into the corner.
   *
   * No `[data-vs-media]:hover` either: the card is deliberately
   * `pointer-events: none` so the canvas can drag the block it lives in, and an
   * element that takes no pointer events never matches `:hover`. The rule would
   * read as "brightens when you hover the card" and do nothing.
   */
  el.textContent = `
    .vs-playbtn { opacity: 0.55; transition: opacity 0.12s ease; }
    .vs-playbtn:hover { opacity: 1; }
    /* SAY THAT THE CARD OPENS. Double-click was the only way to see a clip at a
       size worth judging, and a gesture with nothing drawn on screen is a
       feature only its author knows about. Hidden at rest so a board of clips
       still reads as pictures.
       HUNG OFF THE BLOCK ELEMENT, not off the card — see the note above on why
       a hover rule on [data-vs-media] can never match. The gfx host does take
       pointer events, so it is what knows the pointer is over this clip.
       (No backticks in here: this is inside a template literal.) */
    .vs-expandbtn { opacity: 0; transition: opacity 0.12s ease; }
    ${MEDIA_BLOCK_TAG}:hover .vs-expandbtn { opacity: 0.75; }
    .vs-expandbtn:hover { opacity: 1; }
    /* ONE TRANSPORT, TWO GLYPHS. Both are in the DOM; which one shows is a
       class on the card, because the card's template is behind a Lit guard
       directive and will not re-render to swap markup.
       (No backticks in here: this is inside a template literal.) */
    .vs-ic--pause { display: none; }
    [data-vs-media].is-playing .vs-ic--play { display: none; }
    [data-vs-media].is-playing .vs-ic--pause { display: block; }
    /* A running clip should be watched, not covered: the transport fades back
       until the pointer is on it, and the card is a picture again. */
    [data-vs-media].is-playing .vs-playbtn { opacity: 0.22; }
    [data-vs-media].is-playing .vs-playbtn:hover { opacity: 1; }
    /* What a track IS, in the corner — see NOTE_CHIP. */
    .vs-kind {
      position: absolute;
      top: 6px; left: 6px;
      display: grid;
      place-items: center;
      width: 20px; height: 20px;
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.5);
      color: rgba(255, 255, 255, 0.85);
      pointer-events: none;
      z-index: 4;
    }
  `;
  document.head.append(el);
}

/**
 * A PRESS THAT MOVED IS A DRAG, AND THE CANVAS MUST HAVE IT.
 *
 * ── WHAT THIS REPLACED, AND WHY IT WAS WRONG ─────────────────────────────────
 * Both controls on a card used to `stopPropagation` on POINTERDOWN, to stop the
 * press starting a canvas drag before the click could land. That works for a
 * click and is exactly wrong for a drag: the gfx layer never saw the press, so
 * it never selected the block, and `dragStart` moves
 * `selection.selectedElements` — an empty set. Pressing the middle of a clip
 * card and dragging did NOTHING, measurably: the card sat still for the whole
 * gesture. And the middle of the card is where anyone reaches for it.
 *
 * Reported exactly as it behaves: "I click and drag, but it's showing drag when
 * I leave the button."
 *
 * ── THE RULE INSTEAD ─────────────────────────────────────────────────────────
 * The press is let through, so the canvas can always select and drag. The
 * decision moves to the CLICK, where the distance travelled is known:
 *
 *   moved more than a few pixels  →  that was a drag; the card has already
 *                                    followed the pointer, so do nothing.
 *   moved less                    →  that was a click; play, or open.
 *
 * A stationary press cannot start a drag on its own — BlockSuite raises
 * `dragstart` only once the pointer has moved while down — so nothing shifts
 * under the finger while somebody is simply pressing play.
 *
 * MODULE-LEVEL, not per button: a board has one pointer, and a per-render
 * closure would lose the press anyway. The card re-renders while it is being
 * dragged (its `xywh` changes on every move), which rebinds every listener in
 * the template between the pointerdown and the click.
 */
const DRAG_SLOP = 4;
let pressedAt: { x: number; y: number } | null = null;

/**
 * A PRESS LASTS EXACTLY ONE GESTURE, and nothing here worked until it did.
 *
 * `draggedNotClicked` clears the press — but only when a click actually reaches
 * the button, and the interesting case is precisely when one does not: press the
 * badge, drag the card away, release. The click then fires on an ancestor, the
 * press is never consumed, and it sits there describing a gesture that ended.
 * The NEXT click on any card control is measured against it, from wherever the
 * pointer happens to be now, and is thrown away as "that was a drag".
 *
 * Measured: after dragging a clip card by its badge, pressing ⤢ on it did
 * nothing at all — the viewer never opened, with no error and no clue.
 *
 * It also breaks the keyboard. Tab to the play button and press Enter and the
 * browser dispatches a `click` with no pointer event before it; with a stale
 * press on file, that click is judged a drag and discarded. A control reachable
 * by keyboard that silently ignores the keyboard is worse than one that is not
 * reachable at all.
 *
 * Releasing on a timeout rather than on `pointerup` itself: the click a release
 * produces is dispatched WITH that release, so clearing during it would leave
 * every genuine click looking like a keyboard activation. A timeout runs after
 * both, which is exactly the seam between one gesture and the next.
 */
const armPress = (e: PointerEvent) => {
  pressedAt = { x: e.clientX, y: e.clientY };

  const release = () => {
    window.removeEventListener('pointerup', release, true);
    window.removeEventListener('pointercancel', release, true);
    setTimeout(() => { pressedAt = null; }, 0);
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
};

/**
 * True when the gesture that ended in this click travelled far enough to have
 * been a drag. Consumes the press either way.
 *
 * NO PRESS ON FILE MEANS THIS IS A CLICK. That is the keyboard — Enter or Space
 * on a focused button — and an assistive technology synthesising one. Both are
 * people asking for the thing the button does.
 */
function draggedNotClicked(e: MouseEvent): boolean {
  const from = pressedAt;
  pressedAt = null;
  if (!from) return false;
  return Math.hypot(e.clientX - from.x, e.clientY - from.y) > DRAG_SLOP;
}

/**
 * PRESSING IT AGAIN STOPS IT.
 *
 * A transport that only ever starts is half a control: the only ways to stop a
 * clip were to play a different one or to scroll the card off the screen, and
 * neither is something a person would think to do. The card carries the state
 * as a class so the glyph and the behaviour cannot disagree — `isPlayingIn` is
 * the truth, and the class is set from it on the way in and on the way out.
 */
function markPlaying(host: HTMLElement, playing: boolean): void {
  host.classList.toggle('is-playing', playing);
}

function playButton(start: (host: HTMLElement) => void, badge: unknown) {
  const onPlay = (e: MouseEvent) => {
    if (draggedNotClicked(e)) return;
    e.stopPropagation();
    e.preventDefault();
    const host = (e.currentTarget as HTMLElement).closest<HTMLElement>('[data-vs-media]');
    if (!host) return;
    // Already this card's clip that is running: the button is a PAUSE, and
    // `stopInlinePlayback` reports back through `onStop`, which clears the class.
    if (isPlayingIn(host)) { stopInlinePlayback(); return; }
    start(host);
  };
  ensurePlayStyles();
  return html`<button
    type="button"
    class="vs-playbtn"
    title="Play here, press again to stop — or open it full size"
    style=${styleMap({
      position: 'absolute',
      // Centred by transform rather than by a full-bleed grid: the button has to
      // be exactly badge-sized, and a grid that centres its child still takes
      // every pixel of the pointer surface for itself.
      top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)',
      width: `${PLAY_HIT}px`, height: `${PLAY_HIT}px`,
      display: 'grid', placeItems: 'center',
      appearance: 'none', border: '0', background: 'transparent', padding: '0',
      borderRadius: '50%',
      cursor: 'pointer', pointerEvents: 'auto',
      /**
       * ABOVE THE PLAYER, and that is what makes it a PAUSE.
       *
       * It was below (z-index 1 against the media element's 2), so the moment a
       * clip started the `<video>` covered the badge: the glyph said pause,
       * pressing it hit the video instead, and the only way to stop was to play
       * something else. A track was unaffected — its element is a bar along the
       * bottom edge — so the control worked on music and not on video, which is
       * the most confusing shape a bug can have.
       *
       * It covers 44px in the MIDDLE of the picture, which is not where a native
       * transport lives; the scrub bar along the bottom stays reachable, and
       * clicking the middle of a playing clip means "stop" either way.
       */
      zIndex: '5',
    })}
    @pointerdown=${armPress}
    @click=${onPlay}
  >${badge}</button>`;
}

/** The corner drawn by the expand button — two arrows, out of a box. */
const EXPAND_GLYPH = html`<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
  <path d="M4 10V4h6M20 14v6h-6M4 4l6.5 6.5M20 20l-6.5-6.5"
        fill="none" stroke="#fff" stroke-width="2.1"
        stroke-linecap="round" stroke-linejoin="round" />
</svg>`;

/**
 * OPEN IT PROPERLY — the button that says double-click exists.
 *
 * A card is where you recognise a clip; the inspector is where you watch it,
 * scrub it and read what it was made from. That has always been a double-click
 * on the card, and a double-click with nothing drawn on screen to suggest it is
 * a feature only the person who wrote it knows about.
 *
 * Raises an event rather than calling the viewer: a block cannot own a
 * full-screen layer, and `ui/media-inspector.ts` is the one thing that does.
 * Same arrangement `voidspace-open-media` uses from the shot card.
 */
function expandButton(blockId: string) {
  const open = (e: MouseEvent) => {
    // Same rule as the play badge: a press that travelled was the user moving
    // the card, not asking to open it.
    if (draggedNotClicked(e)) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).dispatchEvent(
      new CustomEvent('voidspace-open-block', {
        detail: { blockId }, bubbles: true, composed: true,
      }),
    );
  };
  return html`<button
    type="button"
    class="vs-expandbtn"
    title="Open this at full size"
    style=${styleMap({
      position: 'absolute',
      top: '6px', right: '6px',
      width: '24px', height: '24px',
      display: 'grid', placeItems: 'center',
      appearance: 'none', border: '0', padding: '0',
      borderRadius: '7px',
      background: 'rgba(0,0,0,0.55)',
      cursor: 'pointer', pointerEvents: 'auto', zIndex: '4',
    })}
    @pointerdown=${armPress}
    @click=${open}
  >${EXPAND_GLYPH}</button>`;
}

/**
 * One card, whatever the medium.
 *
 * `data-vs-media` is what the viewer listens for: a double-click anywhere on a
 * card opens it. Marking the element rather than hit-testing coordinates means
 * the target is exactly what the user sees. It is also what the play button
 * mounts its player into.
 */
function card(opts: {
  poster: string;
  name: string;
  /** Drawn over the picture: the transport for anything with a duration, a
   *  still marker for a picture. */
  badge: unknown;
  tint: string;
  /** A corner marker saying what the card holds, where the medium is not
   *  obvious from the picture. Only a track needs one. */
  chip?: unknown;
  /** Given for video and audio; a still has nothing to play. */
  play?: (host: HTMLElement) => void;
  /** The block this card draws, so the corner button can name what to open. */
  blockId: string;
}) {
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
      // events that select and drag the block it lives in. The play button
      // above opts back in for its own 40px.
      pointerEvents: 'none',
      cursor: 'pointer',
    })}
  >
    ${opts.play
      ? playButton(opts.play, opts.badge)
      : html`<div style=${styleMap({
          position: 'absolute', inset: '0', display: 'grid', placeItems: 'center',
        })}>${opts.badge}</div>`}
    ${opts.chip ?? nothing}
    ${expandButton(opts.blockId)}
    <div style=${styleMap({
      position: 'relative', width: '100%', padding: '4px 6px',
      font: '500 10px/1.25 var(--affine-font-family, sans-serif)',
      color: '#fff', background: 'linear-gradient(transparent, rgba(0,0,0,0.72))',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      // Under the player, so a running clip is not captioned across its middle.
      zIndex: '3',
      pointerEvents: 'none',
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
      blockId: model.id,
      poster: ref?.poster ? withToken(ref.poster) : '',
      name: model.props.name || 'Clip',
      badge: TRANSPORT,
      tint: '#141821',
      // STREAMS THE PROXY, not the master — `ref.src` is the display variant the
      // panel chose. Nothing is fetched until this runs.
      play: host => {
        if (!ref?.src) return;
        markPlaying(host, true);
        playInline(host, {
          src: ref.src,
          kind: 'video',
          // Every way playback can end comes back through here — including
          // somebody pressing play on a different card. See `inline-player.ts`.
          onStop: () => markPlaying(host, false),
        });
      },
    });
  },
};

const audioConfig: AttachmentEmbedConfig = {
  name: 'audio',
  check: (model, maxFileSize) => playable(model, 'audio/', maxFileSize),
  action: model => {
    model.store.updateBlock(model, { embed: true });
  },
  render: model => {
    const ref = refOf(model);
    return card({
      blockId: model.id,
      // Audio has no still, so the card is a tinted tile of the SAME shape as the
      // others. A native transport bar here was the "music looks weird" report:
      // a wide grey pill among rectangles, with controls too small to use. The
      // scrub bar now appears only while it is playing, along the bottom edge,
      // and leaves when it stops.
      poster: '',
      name: model.props.name || 'Audio',
      // THE SAME TRANSPORT A CLIP GETS. This was a musical note — a real button
      // that did not look like one, which is why music cards read as having no
      // play control at all. What the card holds is said by the chip below and
      // by having no picture; what the button does is said by the button.
      badge: TRANSPORT,
      chip: NOTE_CHIP,
      tint: 'linear-gradient(135deg,#2b2350,#1b2340)',
      play: host => {
        if (!ref?.src) return;
        markPlaying(host, true);
        playInline(host, {
          src: ref.src,
          kind: 'audio',
          onStop: () => markPlaying(host, false),
        });
      },
    });
  },
};

/**
 * A STILL GETS THE SAME NAME STRIP AND THE SAME WAY IN.
 *
 * Overlaid on AFFiNE's image block rather than replacing it — that block is
 * already right (a lazily-loaded `<img>` at the block's own size, with loading
 * and error states worth keeping), so only the chrome is missing. Drawn from
 * here, not from `media-block.ts`, so a still, a clip and a track are literally
 * the same markup and cannot drift apart.
 *
 * NO PLAY BUTTON, because there is nothing to play; the middle of the card is
 * left alone, which is also what keeps a mood board readable.
 */
function imageChrome(blockId: string, name: string) {
  ensurePlayStyles();
  return html`<div
    data-vs-media
    style=${styleMap({
      position: 'absolute',
      inset: '0',
      display: 'flex',
      alignItems: 'flex-end',
      borderRadius: '6px',
      overflow: 'hidden',
      // The picture below must stay selectable and draggable: this layer is a
      // caption and a button, not a lid.
      pointerEvents: 'none',
      zIndex: '2',
    })}
  >
    ${expandButton(blockId)}
    ${name
      ? html`<div style=${styleMap({
          position: 'relative', width: '100%', padding: '4px 6px',
          font: '500 10px/1.25 var(--affine-font-family, sans-serif)',
          color: '#fff', background: 'linear-gradient(transparent, rgba(0,0,0,0.72))',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          pointerEvents: 'none',
        })}>${name}</div>`
      : nothing}
  </div>`;
}

export class VoidspaceMediaViewExtension extends ViewExtensionProvider {
  override name = 'voidspace-media-embed';

  /** Runs once, before setup. Defining the element here rather than at import
   *  time keeps it in the same lifecycle hook AFFiNE uses for its own. */
  override effect() {
    super.effect();
    // Handed over rather than imported, because the image block needs the card
    // design and the card design needs the block's tag names — see the note on
    // `VoidspaceEdgelessImage.chrome`.
    VoidspaceEdgelessImage.chrome = imageChrome;
    defineMediaBlock();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    // `override` (not `addImpl`): AttachmentViewExtension already registered
    // these three names, and the container throws on a duplicate identifier.
    context.register({
      setup: di => {
        di.override(AttachmentEmbedConfigIdentifier(videoConfig.name), () => videoConfig);
        di.override(AttachmentEmbedConfigIdentifier(audioConfig.name), () => audioConfig);
        /**
         * THE BOX, not just the contents — see `media-block.ts`.
         *
         * AFFiNE's edgeless attachment renders at a fixed nominal size and
         * scales it onto the block's box with two INDEPENDENT factors, which
         * squashed every clip card (and its play button, and its transport)
         * because a clip's box is the clip's own aspect and 752:544 is not it.
         *
         * Only the SURFACE branch changes. An attachment inside a note is a
         * document chip and AFFiNE's own element is right for it.
         */
        di.override(BlockViewIdentifier('affine:attachment'), () => (model: {
          parent?: { flavour?: string } | null;
        }) => (model.parent?.flavour === 'affine:surface'
          ? MEDIA_BLOCK_VIEW
          : literal`affine-attachment`));

        /**
         * AND THE SAME FOR A STILL, so all three media read as one kind of
         * object. Only the chrome differs from AFFiNE's — see `imageChrome`.
         *
         * `getParent` rather than `model.parent`: the image spec resolves its
         * view that way, and a picture inside a note must keep the document
         * element, which has no canvas chrome to draw.
         */
        di.override(BlockViewIdentifier('affine:image'), () => (model: {
          id: string;
          store: { getParent: (id: string) => { flavour?: string } | null };
        }) => (model.store.getParent(model.id)?.flavour === 'affine:surface'
          ? IMAGE_BLOCK_VIEW
          : literal`affine-image`));

        /**
         * NO ATTACHMENT TOOLBAR ON THE CANVAS — every action on it is wrong here.
         *
         *   CARD VIEW / EMBED VIEW  turns a clip into AFFiNE's download chip by
         *     writing `embed: false`. There is no such thing as a board media
         *     card in card view: the card IS the embed. Pressing it produced a
         *     grey file row where a video had been, which is the glitch this
         *     removes. (`ensureEmbedded` below closes the door from the other
         *     side, for boards that already went through it.)
         *
         *   HORIZONTAL / VERTICAL STYLE  resizes the block to
         *     `EMBED_CARD_WIDTH/HEIGHT` — 752×544 or 170×132 — throwing away the
         *     clip's own aspect, which `placeAsset` measured and the card is
         *     drawn from. It is the same "why is my video squashed" bug wearing a
         *     button.
         *
         *   REPLACE  uploads a file into the DOCUMENT. The board never owns the
         *     bytes (`board/media-ref.ts`); every media block is a reference to
         *     the Library, and this is the one action that would break that.
         *
         *   DOWNLOAD / CAPTION  are redundant against the Library and against the
         *     card's own name strip, which shows what the Library calls it.
         *
         * What the card actually needs it already has: play/pause and ⤢ on the
         * card, everything else in the inspector, and delete from the canvas.
         *
         * `when: () => false` rather than an empty action list, so the module
         * contributes nothing at all and the generic surface toolbar — lock,
         * z-order, delete — is what shows. Overriding the identifier the
         * attachment package registered is the supported seam; there is no way
         * to remove one action from a config that is not exported.
         */
        di.override(
          ToolbarModuleIdentifier('affine:surface:attachment'),
          () => ({
            id: BlockFlavourIdentifier('affine:surface:attachment'),
            config: { actions: [], when: () => false },
          }),
        );
      },
    });
  }
}
