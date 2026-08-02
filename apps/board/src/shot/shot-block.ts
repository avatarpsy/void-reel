/**
 * The shot panel, rendered.
 *
 * WHY THE INTERACTION RULES BELOW ARE THE WHOLE FILE
 * A block on an infinite canvas is fighting for the same pointer and keyboard
 * events the canvas wants: dragging moves the block, wheel zooms the viewport,
 * typing goes to the editor's own dispatcher. A panel you can actually WORK in
 * has to claim those events back — but only in the places where the user is
 * working, or the shot stops being movable and the board feels stuck.
 *
 * So the split is explicit and it is the design:
 *
 *   HEADER   — the drag handle. Events pass THROUGH to the canvas, so the shot
 *              moves exactly like any other object.
 *   BODY     — claimed. Clicks select tiles, wheel scrolls a lane instead of
 *              zooming, keys type into a field instead of reaching the canvas.
 *
 * That one rule is what makes the panel usable without breaking the canvas.
 */
import { GfxBlockComponent } from '@blocksuite/std';
import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import { withToken } from '../board/parent-auth';
import {
  FIELD_SPECS, REF_KIND_LABEL, roleLabel, SHOT_KIND_HINT, SHOT_KIND_LABEL, SHOT_KINDS,
  formatTime, isTimed, rolesFor, trimWindow,
  type MediaRole, type ShotBlockModel, type ShotKind, type ShotMedia,
} from './model';
import { allBlocks, findBlock, onBlockCatalogue, searchBlocks, type BlockInfo } from './blocks';
import { resolveSlots, slotFills } from './slots';
import { lazyBlockPreview, openBlockLightbox, type LazyPreview } from '../ui/block-preview';
import {
  allModels, checkShot, effectiveModel, estimateShotCredits, formatCredits,
  onModelCatalogue, referenceTag,
} from './models';

/** The order a model receives references in — see the note in `screenplay.ts`.
 *  Kept identical to compile's, because the prompt tags are numbered from it. */
const ROLE_ORDER: MediaRole[] = [
  'firstFrame', 'lastFrame', 'motionRef',
  'background', 'figure', 'inset', 'logo', 'texture',
  'reference', 'sfx', 'bgm',
];

/** Lanes, in the order a shot is thought about: looks, moves, sounds. */
const LANES = [
  { id: 'image', label: 'IMAGES', empty: 'Drop stills here' },
  { id: 'video', label: 'VIDEO', empty: 'Drop clips here' },
  { id: 'audio', label: 'MUSIC & SFX', empty: 'Drop audio here' },
] as const;

/**
 * A GRAPHIC GETS ONE LANE, NOT THREE.
 *
 * Two reasons, and they agree. The card is a fixed-size canvas object, and a
 * graphic spends 190px of it showing the composition — three lanes plus that
 * does not fit, and what "does not fit" looked like was the IMAGES label
 * printing on top of the BACKGROUND well.
 *
 * And it is the right split anyway: on a composition the media that MATTER are
 * the ones filling its slots, which are shown above in their own wells. What is
 * left over is a reference the user parked on the scene — a mood board still, a
 * track they are considering — and that is one list, not three empty rows.
 *
 * `kind: null` means "everything not in a slot", which is exactly the filter.
 */
const GRAPHIC_LANES = [
  { id: 'other', label: 'REFERENCES', empty: 'Drop anything else here' },
] as const;

/**
 * THE NAMED SLOTS, AND THEY DEPEND ON WHAT THE SHOT IS.
 *
 * A generated clip has a frame it opens on, a frame it ends on, and a move to
 * copy. A composition has none of those — it has a layout, with a background
 * and a place for a figure and a logo. Showing a graphic three video-model
 * slots is showing three controls that do nothing, and showing a clip a "logo"
 * slot is the same mistake pointed the other way.
 */
const CLIP_SLOTS = [
  { role: 'firstFrame', label: 'FIRST FRAME', hint: 'The frame it opens on' },
  { role: 'lastFrame', label: 'LAST FRAME', hint: 'The frame it ends on' },
  { role: 'motionRef', label: 'MOTION REF', hint: 'Copy this camera move' },
] as const;

const GRAPHIC_SLOTS = [
  { role: 'background', label: 'BACKGROUND', hint: 'Full-bleed, behind the type' },
  { role: 'figure', label: 'FIGURE', hint: 'The picture in the layout' },
  { role: 'logo', label: 'LOGO', hint: 'Mark or wordmark' },
] as const;

export class ShotBlockComponent extends GfxBlockComponent<ShotBlockModel> {
  static override styles = css`
    voidspace-shot {
      display: block;
      width: 100%;
      height: 100%;
    }
    .shot {
      position: relative;
      display: flex;
      flex-direction: column;
      height: 100%;
      box-sizing: border-box;
      border: 1px solid var(--vs-border, rgba(255, 255, 255, 0.12));
      border-radius: 14px;
      background: var(--vs-shot-bg, #ffffff);
      box-shadow: 0 6px 24px rgba(15, 23, 42, 0.08);
      overflow: hidden;
      font-family: var(--affine-font-family, Inter, sans-serif);
      color: var(--vs-text, #1a1a2e);
    }

    /* THE DRAG HANDLE. Deliberately does NOT claim pointer events: the shot has
       to move like any other object on the canvas, and the header is where a
       person naturally grabs a card. */
    .shot__head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--vs-border, rgba(255, 255, 255, 0.1));
      background: var(--vs-shot-head, rgba(127, 140, 170, 0.08));
      cursor: grab;
      flex: none;
    }
    .shot__n {
      font: 600 11px/1 var(--affine-font-family, sans-serif);
      letter-spacing: 0.08em;
      padding: 5px 8px;
      border-radius: 6px;
      background: var(--vs-accent-b, #2f6fa3);
      color: #fff;
      flex: none;
    }
    .shot__title {
      flex: 1;
      font: 500 14px/1.3 var(--affine-font-family, sans-serif);
      outline: none;
      min-width: 0;
      /* Not selectable until it is being edited: a drag across the header is a
         request to move the card, and a trail of highlighted text is what that
         looked like instead. */
      user-select: none;
      cursor: grab;
    }
    .shot__title:focus { user-select: text; cursor: text; }
    .shot__title:empty::before {
      content: attr(data-placeholder);
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.42));
    }

    /* THE BODY CLAIMS ITS EVENTS — see the file header. */
    .shot__body {
      position: relative; /* the picker sheet's frame — see .shot__pick */
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px 14px 14px;
    }

    /* EQUAL THIRDS. An earlier draft gave the first frame 2fr on the theory that
       it matters most — which is true, and it still looked broken: three boxes
       of three different sizes holding three tiles of the same size reads as a
       layout bug, not as emphasis. Emphasis is the LABEL's job. */
    .shot__slots { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; flex: none; }
    /* A graphic already shows the composition above; the wells below it are for
       filling its holes, so they shrink to a strip rather than competing with
       the thing they fill.

       THE HEIGHT HAS TO BE SET ON THE SLOT, not on the grid track. .slot
       carries aspect-ratio 16/9, which WINS over grid-auto-rows — so the
       container measured 56px while its children painted 112px, straight
       through the lane underneath. The label of the lane below printed across
       the wells, which is what the collision looked like on screen and what a
       parent-only measurement completely misses. */
    .shot__slots--slim .slot { aspect-ratio: auto; height: 56px; }
    .shot__slots--slim .slot__label { font-size: 8px; line-height: 1.25; }

    /* THE LIVE COMPOSITION. Sized to the card and letterboxed on the block's
       own aspect — a 9:16 title card in a 16:9 well must not be stretched to
       fit, because the thing being judged IS the proportion. */
    .shot__previewwrap { position: relative; flex: none; }
    .shot__preview {
      position: relative;
      height: 190px;
      border-radius: 10px;
      overflow: hidden;
      background: #05070b;
      border: 1px solid var(--vs-border, rgba(15, 23, 42, 0.12));
      display: grid;
      place-items: center;
      cursor: zoom-in;
    }
    /* THE IFRAME IS INERT, THE WELL IS NOT.
       A live composition that took pointer events would swallow the click meant
       for the card, and some blocks bind their own handlers. Blocking events on
       the frame while leaving them on the well is what makes double-click-to-
       expand possible without giving the block any say in it. */
    .shot__preview .vs-blockprev__frame { pointer-events: none; }

    .shot__expand {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
      appearance: none;
      border: 0;
      border-radius: 7px;
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      font: 400 12px/1 var(--affine-font-family, sans-serif);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.12s ease, background 0.12s ease;
    }
    /* A double-click with no affordance is a feature nobody finds. Shown on
       hover so it does not sit on top of the composition the rest of the time. */
    .shot__previewwrap:hover .shot__expand { opacity: 1; }
    .shot__expand:hover { background: rgba(0, 0, 0, 0.78); }
    .shot__preview__empty {
      padding: 0 18px;
      text-align: center;
      font: 400 10.5px/1.5 var(--affine-font-family, sans-serif);
      color: rgba(255, 255, 255, 0.55);
    }
    .slot {
      position: relative;
      border: 1px dashed var(--vs-border-strong, rgba(15, 23, 42, 0.25));
      border-radius: 10px;
      aspect-ratio: 16 / 9;
      display: grid;
      place-items: stretch;
      overflow: hidden;
      background: var(--vs-shot-well, rgba(127, 140, 170, 0.06));
      transition: border-color 0.12s ease, background 0.12s ease;
    }
    /* A filled slot IS its media — the tile fills the box rather than floating
       in the middle of it, which is the other half of what made these read as
       mis-sized. */
    .slot .tile { width: 100%; height: 100%; aspect-ratio: auto; border-radius: 9px; }
    .slot__label { align-self: center; }
    .slot.is-over {
      border-color: var(--vs-accent-a, #4a9bd9);
      background: rgba(74, 155, 217, 0.12);
    }
    .slot__label {
      font: 500 9.5px/1.3 var(--affine-font-family, sans-serif);
      letter-spacing: 0.07em;
      text-align: center;
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.45));
      padding: 4px;
      pointer-events: none;
    }

    .lane { flex: none; }
    /* The single graphic lane takes the room the other two would have. Without
       this the card ends with a dead band under it. */
    .lane--other { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
    .lane--other .lane__strip { flex: 1 1 auto; min-height: 64px; }
    .lane__head {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
    }
    .lane__label {
      font: 500 9.5px/1 var(--affine-font-family, sans-serif);
      letter-spacing: 0.08em;
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.45));
      flex: 1;
    }
    .lane__count { font: 400 9.5px/1 var(--affine-font-family, sans-serif); color: var(--vs-text-mute, rgba(26,26,46,0.45)); }
    .lane__nav {
      appearance: none;
      width: 18px; height: 18px; padding: 0;
      border: 1px solid var(--vs-border, rgba(15, 23, 42, 0.14));
      border-radius: 5px;
      background: transparent;
      color: var(--vs-text-dim, rgba(26, 26, 46, 0.6));
      font-size: 11px;
      cursor: pointer;
      flex: none;
    }
    .lane__nav:hover { background: var(--vs-accent-b, #2f6fa3); border-color: transparent; color: #fff; }

    /* REAL SCROLLING. This is why a shot is a block and not a frame full of
       loose pictures: a DOM row scrolls, a canvas region cannot. */
    .lane__strip {
      display: flex;
      /* NOT stretch, which is flex's default and what a row of tiles does NOT
         want. A lane with enough items has a horizontal scrollbar and one
         without does not, so the rows end up a few pixels different in height —
         and under stretch that difference lands on the TILES, which then
         disagree about their aspect ratio from row to row. Five pixels is
         enough to read as sloppiness. Anchoring to the top makes every tile
         exactly 16:9, everywhere, whatever the row is doing. */
      align-items: flex-start;
      gap: 8px;
      overflow-x: auto;
      overflow-y: hidden;
      scroll-behavior: smooth;
      scrollbar-width: thin;
      padding-bottom: 2px;
      min-height: 62px;
      border: 1px dashed transparent;
      border-radius: 8px;
      transition: border-color 0.12s ease, background 0.12s ease;
    }
    .lane__strip.is-over {
      border-color: var(--vs-accent-a, #4a9bd9);
      background: rgba(74, 155, 217, 0.1);
    }
    .lane__empty {
      display: grid;
      place-items: center;
      width: 100%;
      min-height: 58px;
      font: 400 10.5px/1 var(--affine-font-family, sans-serif);
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.4));
      border: 1px dashed var(--vs-border, rgba(15, 23, 42, 0.16));
      border-radius: 8px;
    }

    /* ONE TILE, EVERY MEDIUM. A row only reads as a row when its tiles match. */
    .tile {
      position: relative;
      flex: none;
      width: 104px;
      aspect-ratio: 16 / 9;
      border-radius: 7px;
      overflow: hidden;
      background: #12161f center/cover no-repeat;
      cursor: pointer;
    }
    .tile--audio { background: linear-gradient(135deg, #2b2350, #1b2340); }
    .tile__name {
      position: absolute;
      inset: auto 0 0 0;
      padding: 3px 5px;
      font: 500 9px/1.2 var(--affine-font-family, sans-serif);
      color: #fff;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.78));
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tile__badge {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: #fff;
      font-size: 15px;
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
      pointer-events: none;
    }
    .tile__x {
      position: absolute;
      top: 3px; right: 3px;
      width: 16px; height: 16px;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.62);
      color: #fff;
      font-size: 10px;
      line-height: 1;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.12s ease;
    }
    .tile:hover .tile__x { opacity: 1; }
    .tile__role {
      position: absolute;
      top: 3px; left: 3px;
      border: 0;
      border-radius: 4px;
      padding: 2px 4px;
      font: 500 8px/1 var(--affine-font-family, sans-serif);
      background: rgba(0, 0, 0, 0.62);
      color: #fff;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.12s ease;
    }
    .tile:hover .tile__role { opacity: 1; }

    /* flex:none, NOT flex:1. The graphic card's single REFERENCES lane
       also grows, and with a few clips in it the lane won and squeezed ACTION
       and VOICEOVER down to a couple of pixels each — they looked like broken
       dropdowns rather than like text fields. The lane is the only thing here
       allowed to take the slack. */
    .fields { display: flex; flex-direction: column; gap: 8px; flex: none; }
    .field {
      display: flex;
      flex-direction: column;
      gap: 2px;
      border: 1px solid var(--vs-border, rgba(15, 23, 42, 0.1));
      border-radius: 9px;
      padding: 7px 10px;
      background: var(--vs-shot-field, rgba(127, 140, 170, 0.06));
      flex: 1;
      min-height: 0;
    }
    .field__label {
      font: 500 9px/1 var(--affine-font-family, sans-serif);
      letter-spacing: 0.08em;
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.45));
    }
    .field__text {
      font: 400 11.5px/1.45 var(--affine-font-family, sans-serif);
      outline: none;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
    }
    .field__text:empty::before {
      content: attr(data-placeholder);
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.38));
    }

    /* The prompt's own name for a reference — @Image2. Small and unobtrusive:
       it matters when you are wiring a prompt and is noise the rest of the
       time. */
    .tile__tagno {
      position: absolute;
      bottom: 3px; right: 3px;
      padding: 1px 4px;
      border-radius: 4px;
      font: 600 8px/1.4 var(--affine-font-family, sans-serif);
      background: rgba(0, 0, 0, 0.66);
      color: #fff;
      pointer-events: none;
    }
    /* A NAMED reference reads as a name, not a filename. */
    .tile__name.is-tagged { font-weight: 600; letter-spacing: 0.01em; }

    /* Trim window and usage note. Always visible, unlike the hover controls:
       both change what the shot MEANS, so neither may be discoverable-only. */
    .tile__trim,
    .tile__note {
      position: absolute;
      top: 3px;
      padding: 1px 4px;
      border-radius: 4px;
      font: 600 8px/1.4 var(--affine-font-family, sans-serif);
      background: rgba(74, 155, 217, 0.9);
      color: #fff;
      pointer-events: none;
    }
    .tile__trim { right: 3px; }
    .tile__note {
      left: 3px;
      background: rgba(0, 0, 0, 0.62);
      pointer-events: auto;
      cursor: help;
    }
    /* The hover controls take the corners back when the pointer is on the tile —
       removing something is a deliberate act and needs the bigger target. */
    .tile:hover .tile__trim,
    .tile:hover .tile__note { opacity: 0; }

    /* WHAT THIS SHOT IS. First thing under the header, because it changes the
       slots, the roles, the model line and the cost below it. */
    .shot__kind {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: none;
    }
    .shot__kindopt {
      appearance: none;
      border: 1px solid var(--vs-border, rgba(15, 23, 42, 0.14));
      border-radius: 999px;
      padding: 3px 10px;
      background: transparent;
      color: var(--vs-text-dim, rgba(26, 26, 46, 0.6));
      font: 500 9.5px/1.4 var(--affine-font-family, sans-serif);
      cursor: pointer;
    }
    .shot__kindopt:hover { color: var(--vs-text, #1a1a2e); }
    .shot__kindopt.is-on {
      border-color: transparent;
      background: var(--vs-accent-b, #2f6fa3);
      color: #fff;
    }
    .shot__comp {
      flex: 1;
      min-width: 0;
      appearance: none;
      border: 1px dashed var(--vs-border-strong, rgba(15, 23, 42, 0.25));
      border-radius: 999px;
      padding: 3px 10px;
      background: transparent;
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.45));
      font: 500 9.5px/1.4 var(--affine-font-family, sans-serif);
      text-align: left;
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .shot__comp.is-set {
      border-style: solid;
      color: var(--vs-text, #1a1a2e);
    }
    .shot__comp:hover { border-color: var(--vs-accent-a, #4a9bd9); }

    .shot__foot {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: none;
      padding-top: 2px;
      font: 500 9.5px/1 var(--affine-font-family, sans-serif);
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.45));
    }
    /* Length, typed. A number field rather than a slider: people think in
       whole seconds here ("make it four"), and a slider on a canvas card is a
       drag that fights the canvas for the same gesture. */
    .shot__durwrap { flex: none; display: inline-flex; align-items: center; gap: 1px; }
    .shot__durin {
      width: 30px;
      appearance: none;
      -moz-appearance: textfield;
      border: 1px solid var(--vs-border, rgba(15, 23, 42, 0.14));
      border-radius: 5px;
      padding: 2px 3px;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: right;
      outline: none;
    }
    .shot__durin::-webkit-outer-spin-button,
    .shot__durin::-webkit-inner-spin-button { appearance: none; margin: 0; }
    .shot__durin:focus { border-color: var(--vs-accent-a, #4a9bd9); }
    .shot__cost { flex: none; cursor: help; }
    .shot__model {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      appearance: none;
      border: 0;
      padding: 2px 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .shot__model:hover { color: var(--vs-text, #1a1a2e); }
    .shot__caret { flex: none; opacity: 0.7; }
    .shot__dur { flex: none; }
    .shot__warn { flex: none; color: var(--vs-warn, #c98a12); cursor: help; }

    /* THE PICKER, AS A SHEET OVER THE CARD.
       It used to be appended to the bottom of the column, which is why a card
       with the list open drew its own footer, then the list, straight through
       the bottom edge and over the shot beside it — the card is a fixed-size
       canvas object and cannot grow to fit a 128-block library. As a sheet it
       is bounded by the card whatever the list length, and it covers the fields
       it would otherwise obscure rather than fighting them. */
    .shot__pick {
      position: absolute;
      /* Covers the body and nothing else: the card header keeps showing WHICH
         scene this is, which is the one thing you need while choosing.

         HUGS ITS CONTENT, capped at the body. Stretched to the full height a
         five-model list sat in a panel four times its size, which reads as a
         list that failed to load rather than a short list. */
      top: 6px; left: 8px; right: 8px; bottom: auto;
      max-height: calc(100% - 14px);
      z-index: 3;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--vs-border-strong, rgba(15, 23, 42, 0.2));
      border-radius: 10px;
      background: var(--vs-shot-bg, #ffffff);
      box-shadow: 0 8px 26px rgba(15, 23, 42, 0.18);
    }
    .shot__pickhead {
      flex: none;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 9px 10px;
      border-bottom: 1px solid var(--vs-border, rgba(15, 23, 42, 0.1));
    }
    .shot__picktitle {
      flex: none;
      font: 600 9.5px/1 var(--affine-font-family, sans-serif);
      letter-spacing: 0.07em;
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.45));
    }
    /* 128 starter blocks ship as standard. Scrolling to find one is not a
       browse, it is a search — so the field is here rather than a nicety. */
    .shot__pickq {
      flex: 1;
      min-width: 0;
      appearance: none;
      border: 1px solid var(--vs-border, rgba(15, 23, 42, 0.14));
      border-radius: 7px;
      padding: 4px 7px;
      background: transparent;
      color: var(--vs-text, #1a1a2e);
      font: 400 10.5px/1.2 var(--affine-font-family, sans-serif);
      outline: none;
    }
    .shot__pickq:focus { border-color: var(--vs-accent-a, #4a9bd9); }
    .shot__pickx {
      flex: none;
      appearance: none;
      width: 22px; height: 22px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.45));
      font: 400 12px/1 var(--affine-font-family, sans-serif);
      cursor: pointer;
    }
    .shot__pickx:hover { background: var(--vs-shot-well, rgba(127, 140, 170, 0.1)); }
    .shot__pickhint {
      flex: 1;
      min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font: 400 10px/1.2 var(--affine-font-family, sans-serif);
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.45));
    }
    /* The fill progress pill. A count, not a label: "2/7" is a job to finish,
       where a button reading "Fill" is a mystery you must open to evaluate. */
    .shot__fillbtn {
      flex: none;
      appearance: none;
      border: 1px dashed var(--vs-border-strong, rgba(15, 23, 42, 0.28));
      border-radius: 999px;
      padding: 3px 9px;
      background: transparent;
      color: var(--vs-text-dim, rgba(26, 26, 46, 0.66));
      font: 500 9.5px/1 var(--affine-font-family, sans-serif);
      cursor: pointer;
      font-variant-numeric: tabular-nums;
    }
    .shot__fillbtn:hover { border-color: var(--vs-accent-a, #4a9bd9); }
    .shot__fillbtn.is-done { border-style: solid; color: var(--vs-text, #1a1a2e); }

    .shot__fills {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 7px;
      padding: 8px;
    }
    .shot__fill { display: flex; align-items: center; gap: 8px; }
    .shot__fillkey {
      flex: 0 0 34%;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font: 500 10px/1.3 var(--affine-font-family, sans-serif);
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.45));
    }
    .shot__fillinput {
      flex: 1;
      min-width: 0;
      appearance: none;
      border: 1px solid var(--vs-border, rgba(15, 23, 42, 0.14));
      border-radius: 7px;
      padding: 5px 8px;
      background: transparent;
      color: var(--vs-text, #1a1a2e);
      font: 400 11px/1.3 var(--affine-font-family, sans-serif);
      outline: none;
    }
    .shot__fillinput:focus { border-color: var(--vs-accent-a, #4a9bd9); }
    .shot__fillcolor {
      flex: none;
      width: 40px; height: 26px;
      padding: 0;
      border: 1px solid var(--vs-border, rgba(15, 23, 42, 0.14));
      border-radius: 7px;
      background: transparent;
      cursor: pointer;
    }

    .shot__pickempty {
      padding: 14px 10px;
      font: 400 10.5px/1.5 var(--affine-font-family, sans-serif);
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.45));
    }

    .shot__models {
      flex: 0 1 auto;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px;
    }
    .shot__modelopt {
      display: flex;
      flex-direction: column;
      gap: 1px;
      appearance: none;
      border: 0;
      border-radius: 6px;
      padding: 5px 7px;
      background: transparent;
      color: var(--vs-text, #1a1a2e);
      text-align: left;
      cursor: pointer;
    }
    .shot__modelopt:hover { background: var(--vs-accent-b, #2f6fa3); color: #fff; }
    .shot__modelopt.is-on { background: rgba(74, 155, 217, 0.22); }
    .shot__modelname {
      font: 500 11px/1.3 var(--affine-font-family, sans-serif);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .shot__modelcaps {
      font: 400 9px/1.3 var(--affine-font-family, sans-serif);
      opacity: 0.7;
    }
  `;

  /** Lane currently under a drag, so the drop target is obvious before release. */
  @state() private accessor _over: string | null = null;

  /** The model list, open. Inline rather than a floating layer: a popover on an
   *  infinite canvas has to track pan and zoom, and this one does not need to. */
  @state() private accessor _pickingModel = false;
  /** The block list, open. Same reasoning. */
  @state() private accessor _pickingBlock = false;
  /** The block's text and colour slots, open for filling. */
  @state() private accessor _filling = false;
  /** What has been typed into the block filter. Deliberately NOT stored on the
   *  shot: it is how you find one block among 128, not a property of the scene. */
  @state() private accessor _blockQuery = '';

  /**
   * The blocks worth showing right now.
   *
   * Matches name, description, category and tags, because people look for a
   * block by what it DOES — "stat", "lower third", "transition" — far more
   * often than by whatever name its author gave it.
   */
  private visibleBlocks(): BlockInfo[] {
    return searchBlocks(this._blockQuery, allBlocks());
  }

  /**
   * Switch what this shot IS.
   *
   * The media stay put deliberately. Their roles may no longer be legal — a
   * first frame means nothing on a graphic — and `checkShot` says so rather
   * than this silently rewriting them: the references are the user's work, and
   * quietly re-labelling someone's work while they change a dropdown is how a
   * tool loses trust. Changing back restores exactly what was there.
   */
  private setKind(kind: ShotKind): void {
    if (kind === this.shotKind) return;
    this._pickingModel = false;
    this._pickingBlock = false;
    this._filling = false;
    this.store.captureSync();
    this.store.updateBlock(this.model, { kind });
  }

  /**
   * Set one of the block's declared values.
   *
   * Committed on `change` (blur or Enter) rather than per keystroke: every
   * write is an undo step and re-renders the card, and a preview that remounts
   * on every letter is unusable to type next to.
   */
  private setSlotValue(key: string, raw: string): void {
    const vars = { ...(this.model.props.compositionVars ?? {}) };
    const value = raw.trim();
    if (value) vars[key] = value;
    else delete vars[key];
    if (JSON.stringify(vars) === JSON.stringify(this.model.props.compositionVars ?? {})) return;
    this.store.captureSync();
    this.store.updateBlock(this.model, { compositionVars: vars });
  }

  private chooseBlock(name: string): void {
    this._pickingBlock = false;
    // The filter is a way of finding one block, not a state to come back to.
    this._blockQuery = '';
    if (name === this.model.props.composition) return;
    this.store.captureSync();
    // The values belong to the OLD block's slots — a `stat` from a stat-card
    // means nothing in a bullet list, and carrying them over would put stale
    // words in a new layout.
    this.store.updateBlock(this.model, { composition: name, compositionVars: {} });
  }

  /** Planned length. Blank clears it back to "not decided". */
  private setDuration(raw: string): void {
    const n = Math.max(0, Math.min(600, Math.round(Number(raw) || 0)));
    if (n === (this.model.props.durationSec ?? 0)) return;
    this.store.captureSync();
    this.store.updateBlock(this.model, { durationSec: n });
  }

  /**
   * Repaint when the model catalogue arrives.
   *
   * It lands after mount (see `onModelCatalogue`), and the card's footer, its
   * warnings and every reference's @-tag are all derived from it — none of which
   * are block props, so Lit has no other reason to re-render.
   */
  private disposeCatalogue: (() => void) | null = null;

  private disposeBlocks: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // BOTH catalogues arrive after first paint, and the card reads both — the
    // model line and its warnings from one, the block name and its slot count
    // from the other. Neither is a block prop, so nothing else marks the card
    // dirty when they land.
    this.disposeCatalogue = onModelCatalogue(() => this.requestUpdate());
    this.disposeBlocks = onBlockCatalogue(() => this.requestUpdate());
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disposeCatalogue?.();
    this.disposeBlocks?.();
    this.disposeCatalogue = null;
    this.disposeBlocks = null;
    this.preview?.destroy();
    this.preview = null;
    this.previewHost = null;
  }

  /**
   * The live composition render, when this shot is a graphic with a block.
   *
   * Owned by `lazyBlockPreview`, which handles being on and off screen and the
   * board-wide budget. This class deliberately does NOT track whether a preview
   * is mounted: the bespoke version that did got it wrong — its observer only
   * mounted when nothing was mounted, so changing the block left the previous
   * composition on screen under the new block's name and the drag looked like a
   * no-op. One place decides now.
   */
  private preview: LazyPreview | null = null;
  /** The element the preview is bound to, so a re-render that replaces it is
   *  noticed rather than leaving the handle pointing at a detached node. */
  private previewHost: HTMLElement | null = null;

  /** Keep the card's preview matching the shot. */
  private syncPreview(): void {
    const host = this.querySelector<HTMLElement>('[data-preview]');
    if (host !== this.previewHost) {
      this.preview?.destroy();
      // A card outranks a panel tile for the frame budget — see LazyOptions.
      this.preview = host ? lazyBlockPreview(host, { priority: 'card' }) : null;
      this.previewHost = host;
    }
    const graphic = this.shotKind === 'hyperframes';
    this.preview?.set(
      graphic ? (this.model.props.composition ?? '') : '',
      (this.model.props.compositionVars ?? {}) as Record<string, string>,
      // WHAT THIS SHOT PUTS IN THE BLOCK — the dropped media and the typed
      // words, resolved against the block's own slots. Without this the 102
      // slot-driven blocks preview the designer's placeholder content no
      // matter what the user has done.
      graphic ? slotFills({
        composition: this.model.props.composition,
        compositionVars: this.model.props.compositionVars,
        media: this.model.props.media,
      }) : [],
    );
  }

  /**
   * Open this shot's composition full-size.
   *
   * The card's own preview is inert by necessity — a live document that took
   * pointer events would swallow the gestures the canvas needs — so this is how
   * you get a proper look at it, and where Replay lives.
   */
  private expandPreview(e: Event): void {
    e.stopPropagation();
    const name = (this.model.props.composition ?? '').trim();
    if (!name) return;
    openBlockLightbox(name, (this.model.props.compositionVars ?? {}) as Record<string, string>, {
      subtitle: this.model.props.title || '',
      // THIS SHOT'S CONTENT, not the block's samples — the expanded view is
      // where you check your own work.
      slots: slotFills({
        composition: this.model.props.composition,
        compositionVars: this.model.props.compositionVars,
        media: this.model.props.media,
      }),
    });
  }

  private get media(): ShotMedia[] {
    return this.model.props.media ?? [];
  }

  private setMedia(next: ShotMedia[]): void {
    this.store.updateBlock(this.model, { media: next });
  }

  /** Scene number, from position on the board. The filmstrip IS the order. */
  private get sceneNumber(): number {
    const shots = this.store
      .getBlocksByFlavour('voidspace:shot')
      .map(b => ({ id: b.id, x: JSON.parse((b.model.props as { xywh: string }).xywh)[0] as number }))
      .sort((a, b) => a.x - b.x);
    return shots.findIndex(s => s.id === this.model.id) + 1;
  }

  // ── Editing ───────────────────────────────────────────────────────────────

  /** True while the caret is in one of this card's own fields. */
  private get typing(): boolean {
    const active = this.ownerDocument.activeElement as HTMLElement | null;
    return !!active && this.contains(active) && active.isContentEditable;
  }

  /** A render was skipped while the user was typing; run it when they finish. */
  private deferredRender = false;

  /**
   * NEVER RE-RENDER UNDER THE CARET.
   *
   * Lit writes the field's value straight into the contenteditable, so any
   * re-render — the agent touching another shot, a neighbour being dragged,
   * anything at all that ticks the store — replaces the text node the caret
   * lives in and dumps the caret back to the start of the field. Mid-sentence
   * that scatters what the user is typing, and it is unreproducible enough to
   * look like the keyboard is broken rather than the canvas.
   *
   * Position and z-index are NOT affected: `updateTransform` writes those to
   * `style` directly rather than through Lit, so the card still moves and pans
   * normally while a field is focused.
   */
  protected override updated(changed: Map<PropertyKey, unknown>): void {
    super.updated(changed);
    this.syncPreview();
  }

  protected override shouldUpdate(changed: Map<PropertyKey, unknown>): boolean {
    if (this.typing) {
      this.deferredRender = true;
      return false;
    }
    return super.shouldUpdate(changed);
  }

  /**
   * Commit on blur, not on every keystroke.
   *
   * A store write per character would flood undo history and re-render the block
   * under the caret. Blur is also when the user has finished a thought, which is
   * the right granularity for an undo step.
   */
  private commit(key: 'title' | 'action' | 'voiceover' | 'camera', el: HTMLElement): void {
    const value = (el.textContent ?? '').trim();
    if (value !== this.model.props[key]) {
      this.store.captureSync();
      this.store.updateBlock(this.model, { [key]: value });
    }
    // Paint whatever changed while the caret was busy.
    if (this.deferredRender) {
      this.deferredRender = false;
      this.requestUpdate();
    }
  }

  /**
   * Keep the canvas out of the way while typing.
   *
   * The editor's dispatcher listens on the host for keys — Backspace deletes the
   * selected block, space starts panning. Without this, typing in a field would
   * delete the shot you are typing into.
   */
  private readonly stopKeys = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') (e.target as HTMLElement).blur();
  };

  /**
   * TAKE THE CARET, AND KEEP IT. Clicking a field is not enough on its own.
   *
   * Two separate things were stopping a click from putting a caret in a field,
   * and both had to be handled or the card looked editable and silently
   * swallowed every keystroke — the whole of "it is so hard to click on things
   * in the shot box".
   *
   *  1. The edgeless root `preventDefault()`s pointerdown to run its own
   *     selection, which also cancels the browser's default for a click on a
   *     contenteditable: focus it, and put the caret where you clicked.
   *
   *  2. Worse, the same gesture SELECTS the shot as a canvas object, and
   *     `range-binding.ts:293` responds to any non-text selection by calling
   *     `host.focus()` — explicitly to stop a stray top-level contenteditable
   *     holding focus. That is correct for a document and exactly wrong for a
   *     block with its own fields, and it fires a frame later, so simply
   *     focusing during pointerdown is undone before the user can type.
   *
   * So the field takes focus, places the caret from the pointer, and removes the
   * canvas selection so there is nothing left for that guard to react to.
   *
   * `std.selection.clear()` AND NOT `gfx.selection.clear()`. They sound like the
   * same thing and are opposites here: the gfx one calls
   * `set({ elements: [] })`, which leaves an EMPTY `SurfaceSelection` in place —
   * still a non-text selection, still `recoverable: false`, so it satisfies the
   * guard's `selections.length > 0` and re-triggers the steal on every tick.
   * Measured: eighteen steal/refocus cycles from one click, focus bouncing back
   * to the host each time. The std-level clear removes the selections outright,
   * `selections.length` is 0, and the caret stays put.
   */
  private takeCaret(el: HTMLElement, clientX: number, clientY: number): void {
    const doc = this.ownerDocument;

    /**
     * Caret at the click, not at the start — landing at position 0 of text the
     * user clicked the END of is its own small betrayal.
     *
     * RE-RESOLVED FROM THE POINT each time, never cloned from a Range captured
     * earlier. A Lit re-render replaces the text node inside this field, so a
     * Range held across one points at a node that is no longer in the document:
     * the selection then anchors outside the field and the first characters
     * typed land in the wrong place. The POINT stays valid; the nodes do not.
     */
    const put = () => {
      this.std.selection.clear();
      if (doc.activeElement !== el) el.focus({ preventScroll: true });

      const sel = doc.defaultView?.getSelection();
      if (!sel) return;
      const legacy = doc as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      const range = legacy.caretRangeFromPoint?.(clientX, clientY);
      // Only if it actually landed in this field — a point that resolves into a
      // sibling would move the caret somewhere the user did not click.
      if (!range || !el.contains(range.startContainer)) {
        // Fall back to the end of the text, which is where someone who clicked
        // a filled field almost always wants to be.
        const end = doc.createRange();
        end.selectNodeContents(el);
        end.collapse(false);
        sel.removeAllRanges();
        sel.addRange(end);
        return;
      }
      sel.removeAllRanges();
      sel.addRange(range);
    };

    put();
    // Once more after the gesture settles: the edgeless tool sets its selection
    // on pointerup, after this handler has run, and the browser's own
    // double-click word-selection lands in between.
    requestAnimationFrame(() => { if (el.isConnected) put(); });
  }

  private readonly claimCaret = (e: PointerEvent) => {
    e.stopPropagation();
    this.takeCaret(e.currentTarget as HTMLElement, e.clientX, e.clientY);
  };

  /**
   * Rename, on a deliberate double-click. See the note in the header markup.
   *
   * Caret at the click rather than select-all: a select-all does not survive
   * the browser's own double-click handling — it collapses, and the rename then
   * appends to the old title instead of replacing it, which is worse than
   * either. Ctrl+A still selects the line for anyone who wants to replace it.
   */
  private readonly editTitle = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    this.takeCaret(e.currentTarget as HTMLElement, e.clientX, e.clientY);
  };

  // ── Media ─────────────────────────────────────────────────────────────────

  private removeMedia(id: string): void {
    this.store.captureSync();
    this.setMedia(this.media.filter(m => m.id !== id));
  }

  private cycleRole(item: ShotMedia): void {
    // A short cycle beats a menu here: the tile is ~100px and a popup on a
    // canvas has to track the viewport. One click, one step — through the roles
    // this media can LEGALLY hold, which is why the list is not hardcoded: a
    // still has no motion to copy and a clip is not a single frame.
    const usable = rolesFor(this.shotKind, item.kind);
    const at = usable.indexOf(item.role);
    const next = usable[(at + 1) % usable.length];
    this.store.captureSync();
    this.setMedia(this.media.map(m => (m.id === item.id ? { ...m, role: next } : m)));
  }

  private get shotKind(): ShotKind {
    return (this.model.props.kind as ShotKind) ?? 'clip';
  }

  /** Ask the chrome to open its viewer. A block cannot own a full-screen layer,
   *  and an event keeps the two decoupled. */
  private openMedia(item: ShotMedia): void {
    this.dispatchEvent(new CustomEvent('voidspace-open-media', {
      detail: item, bubbles: true, composed: true,
    }));
  }

  /**
   * One tile.
   *
   * The caption is the TAG when the reference has one, and the filename only
   * when it does not. That is deliberate: once a reference is named "sarah",
   * "sarah" is what the prompt says and what the user and the agent call it, so
   * showing `IMG_4471.jpg` instead would mean the card and the conversation
   * disagree about what the thing is called.
   */
  private tile(item: ShotMedia, ordered: ShotMedia[]) {
    const poster = item.kind === 'image' ? item.src : item.poster;
    const caps = effectiveModel(this.model.props.model ?? '');
    const promptTag = referenceTag(caps, ordered, item.id);
    const label = item.tag || item.name;
    const title = [
      item.name,
      roleLabel(item.role),
      item.refKind ? REF_KIND_LABEL[item.refKind] : '',
      promptTag,
    ].filter(Boolean).join(' — ');

    // A TRIMMED CLIP MUST LOOK TRIMMED. The window is the difference between
    // "this take" and "these four seconds of it", and a tile that hides it lets
    // someone believe the whole recording is going into the shot.
    const win = isTimed(item.kind) ? trimWindow(item) : null;

    return html`<div
      class="tile ${item.kind === 'audio' ? 'tile--audio' : ''}"
      style=${poster ? `background-image:url("${withToken(poster)}")` : ''}
      title=${win?.trimmed
        ? `${title} — ${formatTime(win.start)}→${formatTime(win.end)}`
        : title}
      @click=${() => this.openMedia(item)}
    >
      ${item.kind === 'image' ? nothing : html`<span class="tile__badge">${item.kind === 'video' ? '▶' : '♪'}</span>`}
      ${win?.trimmed
        ? html`<span class="tile__trim">${(win.end - win.start).toFixed(1)}s</span>`
        : nothing}
      ${item.note ? html`<span class="tile__note" title=${item.note}>note</span>` : nothing}
      ${promptTag ? html`<span class="tile__tagno" title="What the prompt calls this">${promptTag}</span>` : nothing}
      <button class="tile__role" @click=${(e: Event) => { e.stopPropagation(); this.cycleRole(item); }}
              title="Change what this is for">${roleLabel(item.role)}</button>
      <button class="tile__x" @click=${(e: Event) => { e.stopPropagation(); this.removeMedia(item.id); }}
              title="Remove from this shot">✕</button>
      <span class="tile__name ${item.tag ? 'is-tagged' : ''}">${label}</span>
    </div>`;
  }

  private scrollLane(laneId: string, dir: number): void {
    const strip = this.querySelector<HTMLElement>(`[data-strip="${laneId}"]`);
    strip?.scrollBy({ left: dir * 240, behavior: 'smooth' });
  }

  override renderGfxBlock() {
    const media = this.media;
    const isGraphic = this.shotKind === 'hyperframes';
    /**
     * THE BLOCK SAYS WHAT IT NEEDS.
     *
     * `browser-mockup` wants a `screenshot`, `photo-quote-split` wants a
     * `portrait`. Showing every graphic the same background/figure/logo trio
     * meant showing most of them three controls that do nothing while hiding
     * the one that matters. A block with no declared media slots — the 26
     * baked-in designs — falls back to the generic trio, which is what those
     * genuinely use.
     */
    const slotView = isGraphic ? resolveSlots({
      composition: this.model.props.composition,
      compositionVars: this.model.props.compositionVars,
      media: this.model.props.media,
    }) : null;
    const declaredMedia = slotView?.media ?? [];
    const slots = isGraphic
      ? (declaredMedia.length
        ? declaredMedia.map(r => ({
            role: r.slot.key,
            label: r.slot.key.replace(/[-_]/g, ' ').toUpperCase(),
            hint: r.slot.sample ? `e.g. ${r.slot.sample}` : `The ${r.slot.kind} it shows`,
          }))
        : GRAPHIC_SLOTS)
      : CLIP_SLOTS;
    const slotted = new Map(
      slots.map(s => [s.role as MediaRole, media.find(m => m.role === s.role)] as const),
    );
    /**
     * The order a MODEL would receive these in, which is the order the prompt
     * tags are numbered from. Computed once and passed down, so every tile on
     * the card agrees — and so it agrees with what compile emits, which sorts
     * the same way.
     */
    const ordered = [...media].sort(
      (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
    );
    const caps = effectiveModel(this.model.props.model ?? '');
    const block = findBlock(this.model.props.composition ?? '');
    // Computed once per render rather than twice in the template — the filter
    // walks the whole library, and the list is drawn on every keystroke.
    const blocksShown = this._pickingBlock ? this.visibleBlocks() : [];
    const shotForChecks = {
      kind: this.shotKind,
      model: this.model.props.model ?? '',
      durationSec: this.model.props.durationSec ?? 0,
      voiceover: this.model.props.voiceover ?? '',
      composition: this.model.props.composition ?? '',
      compositionVars: this.model.props.compositionVars ?? {},
      media,
    };
    const warnings = checkShot(shotForChecks);
    const credits = estimateShotCredits(shotForChecks);

    return html`<div class="shot">
      <div class="shot__head" data-drag-region>
        <span class="shot__n">SCENE ${this.sceneNumber}</span>
        <!--
          SINGLE CLICK MOVES THE CARD, DOUBLE CLICK RENAMES IT.

          The title is flex:1, so it covers nearly the whole header — which
          is also the only place to grab a card. Claiming the caret on a single
          pointerdown therefore made the shot immovable: every attempt to drag
          it by the header put a caret in the title instead. Deferring to
          double-click is what every canvas tool does with a card title, and it
          gives the header back as a drag handle.
        -->
        <div
          class="shot__title"
          contenteditable="plaintext-only"
          data-placeholder="Name this shot…"
          title="Double-click to rename · drag to move"
          @dblclick=${this.editTitle}
          @keydown=${this.stopKeys}
          @blur=${(e: FocusEvent) => this.commit('title', e.target as HTMLElement)}
        >${this.model.props.title}</div>
      </div>

      <div
        class="shot__body"
        @pointerdown=${(e: PointerEvent) => e.stopPropagation()}
        @dblclick=${(e: Event) => e.stopPropagation()}
      >
        <!--
          WHAT THIS SHOT IS. A two-way switch rather than a setting buried
          somewhere: it changes the slots, the roles, the model line and the
          cost, so it has to be the first thing on the card and obviously
          changeable.
        -->
        <div class="shot__kind">
          ${SHOT_KINDS.map(k => html`<button
            class="shot__kindopt ${this.shotKind === k ? 'is-on' : ''}"
            title=${SHOT_KIND_HINT[k]}
            @click=${(e: Event) => { e.stopPropagation(); this.setKind(k); }}
          >${SHOT_KIND_LABEL[k]}</button>`)}
          ${isGraphic ? html`<button
            class="shot__comp ${this.model.props.composition ? 'is-set' : ''}"
            title=${block
              ? `${block.name}${block.description ? ` — ${block.description}` : ''}`
              : 'Choose a HyperFrames block for this graphic'}
            @click=${(e: Event) => {
              e.stopPropagation();
              this._pickingModel = false;
              this._filling = false;
              this._pickingBlock = !this._pickingBlock;
            }}
          >${this.model.props.composition || 'choose a block'} <span class="shot__caret">▾</span></button>` : nothing}
          <!--
            HOW MUCH OF THE BLOCK IS FILLED, and the way in.

            Media slots are wells you drop onto, right below. Words and colours
            are TYPED, and there can be nine of them — so they live behind this
            rather than turning a shot card into a form. The count is the point:
            "2/7" is a job to finish, where a button labelled "Fill" is a
            mystery you have to open to evaluate.
          -->
          ${isGraphic && slotView?.values.length
            ? html`<button
                class="shot__fillbtn ${slotView.values.every(v => !v.empty) ? 'is-done' : ''}"
                title="Fill in this block’s words and colours"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  this._pickingBlock = false;
                  this._pickingModel = false;
                  this._filling = !this._filling;
                }}
              >${slotView.values.filter(v => !v.empty).length}/${slotView.values.length} filled</button>`
            : nothing}
        </div>

        <!--
          WHAT THIS GRAPHIC ACTUALLY LOOKS LIKE.

          A block is layout, typography AND motion, so a name and a slot count
          do not tell anyone whether it is the right one — and there are no
          preview images on disk to fall back to. The composition is a
          self-contained document that renders in milliseconds, so the card runs
          it, with this shot's own slot values in it. That makes the card show
          the scene rather than a description of it.

          Sandboxed and mounted lazily — see syncPreview below.
        -->
        ${isGraphic
          ? html`<div class="shot__previewwrap">
              <div
                class="shot__preview"
                data-preview
                title="Double-click to see it full size"
                @dblclick=${(e: Event) => this.expandPreview(e)}
                @pointerenter=${() => this.preview?.setLoop(true)}
                @pointerleave=${() => this.preview?.setLoop(false)}
              >
                ${this.model.props.composition
                  ? nothing
                  : html`<span class="shot__preview__empty">
                      Drag a block here from Blocks in the media panel
                    </span>`}
              </div>
              ${this.model.props.composition
                ? html`<button
                    class="shot__expand"
                    title="See it full size — or double-click the preview"
                    @pointerdown=${(e: Event) => e.stopPropagation()}
                    @click=${(e: Event) => this.expandPreview(e)}
                  >⤢</button>`
                : nothing}
            </div>`
          : nothing}

        <div class="shot__slots${isGraphic ? ' shot__slots--slim' : ''}">
          ${slots.map(slot => {
            const item = slotted.get(slot.role as MediaRole);
            return html`<div
              class="slot ${this._over === slot.role ? 'is-over' : ''}"
              data-slot=${slot.role}
            >
              ${item
                ? this.tile(item, ordered)
                : html`<span class="slot__label">${slot.label}<br />${slot.hint}</span>`}
            </div>`;
          })}
        </div>

        ${(isGraphic ? GRAPHIC_LANES : LANES).map(lane => {
          const items = media.filter(m =>
            (lane.id === 'other' ? true : m.kind === lane.id) && !slotted.get(m.role as never));
          return html`<div class="lane ${lane.id === 'other' ? 'lane--other' : ''}">
            <div class="lane__head">
              <span class="lane__label">${lane.label}</span>
              ${items.length > 3 ? html`
                <span class="lane__count">${items.length}</span>
                <button class="lane__nav" @click=${() => this.scrollLane(lane.id, -1)} aria-label="Scroll left">‹</button>
                <button class="lane__nav" @click=${() => this.scrollLane(lane.id, 1)} aria-label="Scroll right">›</button>
              ` : items.length ? html`<span class="lane__count">${items.length}</span>` : nothing}
            </div>
            <div
              class="lane__strip ${this._over === lane.id ? 'is-over' : ''}"
              data-strip=${lane.id}
              data-lane=${lane.id}
              @wheel=${this.onLaneWheel}
            >
              ${items.length
                ? repeat(items, m => m.id, m => this.tile(m, ordered))
                : html`<span class="lane__empty">${lane.empty}</span>`}
            </div>
          </div>`;
        })}

        <div class="fields">
          <!--
            CAMERA IS HIDDEN ON A GRAPHIC. There is no camera: a composition is
            rendered, not filmed, and the field feeds motion_prompt on the
            scene — which a graphic never reads. It is hidden rather than
            cleared, so switching back to a clip restores what was written.
          -->
          ${FIELD_SPECS.filter(spec => !(isGraphic && spec.key === 'camera'))
            .map(spec => html`<div class="field">
            <span class="field__label">${spec.label}</span>
            <div
              class="field__text"
              contenteditable="plaintext-only"
              data-placeholder=${spec.placeholder}
              @pointerdown=${this.claimCaret}
              @keydown=${this.stopKeys}
              @wheel=${(e: WheelEvent) => e.stopPropagation()}
              @blur=${(e: FocusEvent) => this.commit(spec.key, e.target as HTMLElement)}
            >${this.model.props[spec.key]}</div>
          </div>`)}
        </div>

        <!--
          WHAT THIS SHOT WILL BE MADE WITH, said on the card.

          A model is not a setting buried in a menu here — it decides which
          references are legal and how long the clip can be, so a person editing
          the shot should be able to see it without going looking. Unset reads
          "Model: ask me", which is an invitation rather than a silent default:
          the agent's job is to ask, and a shot that never got asked about is
          visible at a glance.
        -->
        <div class="shot__foot">
          <!--
            A DEFAULT IS NOT A DECISION, and the card must not present it as one.
            An unset shot still resolves to the project default — that IS what
            would be generated — but saying just "Grok Imagine" would read as a
            choice somebody made, and the whole point of per-shot models is that
            the choice gets made deliberately. So the fallback is labelled.

            A GRAPHIC HAS NO MODEL LINE at all: it is rendered, not generated,
            and a model picker on it would be a control with nothing behind it.
          -->
          ${isGraphic
            // Says WHY there is no model here, in the slot where a clip shows
            // one. "Composition" named the thing without explaining it; this
            // answers the question a user actually has when the model line they
            // just used on scene 1 is missing from scene 2.
            ? html`<span class="shot__model" title="A graphic is rendered from a block on your own computer — there is no model to choose and no generation cost.">Rendered, not generated</span>`
            : html`<button
                class="shot__model"
                title=${this.model.props.model
                  ? 'The video model this shot will be generated with — click to change'
                  : 'No model chosen for this shot — click to pick one'}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  this._pickingBlock = false;
                  this._pickingModel = !this._pickingModel;
                }}
              >
                ${caps
                  ? (this.model.props.model ? caps.label : `${caps.label} (default)`)
                  : 'Model — not chosen'}
                <span class="shot__caret">▾</span>
              </button>`}

          <!--
            LENGTH, AND WHAT IT COSTS, side by side.
            Duration is the single biggest lever on price — a 15s shot on the
            top tier is several times a 5s one — and nobody discovers that until
            after they have paid for twelve. Putting the estimate next to the
            control turns "how long should this be" into a decision with a
            visible consequence. The tilde is not decoration: the real charge
            happens at generation against the registry, with resolution and
            per-image surcharges this cannot know.
          -->
          <span class="shot__durwrap" title=${isGraphic
            ? 'How long this graphic holds on screen. Blank renders 5 seconds.'
            : 'Roughly how long this shot runs — the biggest lever on what it costs'}>
            <input
              class="shot__durin"
              type="number" min="0" max="60" step="1"
              .value=${String(this.model.props.durationSec || '')}
              placeholder=${isGraphic ? '5' : '—'}
              @pointerdown=${(e: Event) => e.stopPropagation()}
              @keydown=${this.stopKeys}
              @change=${(e: Event) => this.setDuration((e.target as HTMLInputElement).value)}
            />s
          </span>
          ${credits !== null
            ? html`<span class="shot__cost" title=${isGraphic
                ? 'A composition is rendered, not generated — no model credits'
                : 'Estimated generation cost. The exact charge is made when it runs.'}
              >${formatCredits(credits)}</span>`
            : nothing}
          ${warnings.length
            ? html`<span class="shot__warn" title=${warnings.map(w => w.message).join('\n\n')}>
                ⚠ ${warnings.length}
              </span>`
            : nothing}
        </div>

        <!--
        THE BLOCK LIBRARY, AS A SHEET OVER THE CARD.

        It used to be appended to the bottom of the column, and a shot card is a
        fixed-size canvas object: with 128 starter blocks in the list, the card
        drew its footer, then the list, straight through its own bottom edge and
        over the shot beside it. As a sheet it is bounded by the card whatever
        the library holds.

        User blocks first — a user's own block SHADOWS a starter of the same
        name, which is the rule the server already applies when it reads one, so
        showing the starter first would offer a block that is not the one they
        would get. An "adapt" block is called out on its row rather than hidden:
        one that bakes its content in is a starting DESIGN, not a template, and
        using it as-is renders the designer's copy in your video.
        -->
        ${isGraphic && this._pickingBlock ? html`<div
        class="shot__pick"
        @pointerdown=${(e: PointerEvent) => e.stopPropagation()}
        @dblclick=${(e: Event) => e.stopPropagation()}
        >
        <div class="shot__pickhead">
          <span class="shot__picktitle">BLOCK</span>
          <input
            class="shot__pickq"
            type="text"
            placeholder="stat, lower third, quote…"
            .value=${this._blockQuery}
            @keydown=${this.stopKeys}
            @input=${(e: Event) => { this._blockQuery = (e.target as HTMLInputElement).value; }}
          />
          <button class="shot__pickx" title="Close"
            @click=${(e: Event) => {
              e.stopPropagation();
              this._pickingBlock = false;
              this._blockQuery = '';
            }}>✕</button>
        </div>
        <div class="shot__models">
          ${blocksShown.length
            ? blocksShown.map(b => html`<button
                class="shot__modelopt ${b.name === this.model.props.composition ? 'is-on' : ''}"
                title=${b.description ?? b.name}
                @click=${(e: Event) => { e.stopPropagation(); this.chooseBlock(b.name); }}
              >
                <span class="shot__modelname">${b.name}${b.tier === 'user' ? ' · yours' : ''}</span>
                <span class="shot__modelcaps">${[
                  b.category,
                  b.slots.length ? `${b.slots.length} slot${b.slots.length === 1 ? '' : 's'}` : '',
                  b.fill === 'adapt' ? 'needs adapting' : '',
                  b.overlay ? 'overlay' : '',
                ].filter(Boolean).join(' · ')}</span>
              </button>`)
            : html`<span class="shot__pickempty">${allBlocks().length
                ? 'Nothing matches that.'
                : 'No blocks yet. They live on your machine — open the desktop app and they appear here.'}
              </span>`}
        </div>
        </div>` : nothing}

          <!--
          THE BLOCK'S OWN WORDS AND COLOURS.

          Generated from what the block DECLARES, so it is right for all 128 of
          them and stays right for one the user saves tomorrow. The sample is
          the placeholder because it is the designer's own — it shows both the
          shape and the tone the slot expects, which no generic hint can.

          Committed on change, not per keystroke: every write is an undo step
          and repaints the preview.
        -->
        ${isGraphic && this._filling ? html`<div
          class="shot__pick"
          @pointerdown=${(e: PointerEvent) => e.stopPropagation()}
          @dblclick=${(e: Event) => e.stopPropagation()}
        >
          <div class="shot__pickhead">
            <span class="shot__picktitle">FILL</span>
            <span class="shot__pickhint">${this.model.props.composition}</span>
            <button class="shot__pickx" title="Close"
              @click=${(e: Event) => { e.stopPropagation(); this._filling = false; }}>✕</button>
          </div>
          <div class="shot__fills">
            ${(slotView?.values ?? []).map(r => html`<label class="shot__fill">
              <span class="shot__fillkey">${r.slot.key}</span>
              ${r.slot.kind === 'color'
                ? html`<input
                    class="shot__fillcolor"
                    type="color"
                    .value=${r.value || r.slot.sample || '#000000'}
                    @keydown=${this.stopKeys}
                    @change=${(e: Event) => this.setSlotValue(r.slot.key, (e.target as HTMLInputElement).value)}
                  />`
                : html`<input
                    class="shot__fillinput"
                    type="text"
                    placeholder=${r.slot.sample ?? ''}
                    .value=${r.value ?? ''}
                    @keydown=${this.stopKeys}
                    @change=${(e: Event) => this.setSlotValue(r.slot.key, (e.target as HTMLInputElement).value)}
                  />`}
            </label>`)}
          </div>
        </div>` : nothing}

      <!--
        THE MODEL LIST, with the facts that decide the choice on each row.
        A bare list of names would make this a lottery: the whole reason a shot
        carries its own model is that the shot's needs — a spoken line, an exact
        end frame, a long take — pick it. So each row says what it can do and
        what it costs, in the same words the warnings use.
        -->
        ${this._pickingModel ? html`<div
        class="shot__pick"
        @pointerdown=${(e: PointerEvent) => e.stopPropagation()}
        @dblclick=${(e: Event) => e.stopPropagation()}
        >
        <div class="shot__pickhead">
          <span class="shot__picktitle">MODEL</span>
          <span class="shot__pickhint">what generates this shot</span>
          <button class="shot__pickx" title="Close"
            @click=${(e: Event) => { e.stopPropagation(); this._pickingModel = false; }}>✕</button>
        </div>
        <div class="shot__models">
          ${allModels().length
            ? allModels().map(m => html`<button
                class="shot__modelopt ${m.id === this.model.props.model ? 'is-on' : ''}"
                title=${m.locked ? `${m.label} — needs a Plus plan` : m.label}
                @click=${(e: Event) => { e.stopPropagation(); this.chooseModel(m.id); }}
              >
                <span class="shot__modelname">${m.label}${m.locked ? ' · Plus' : ''}</span>
                <span class="shot__modelcaps">${[
                  `${m.maxDurationSec}s`,
                  m.nativeDialogue ? 'speaks' : '',
                  m.supportsLastFrame ? 'end frame' : '',
                  m.usesReferenceTags ? '@tags' : '',
                ].filter(Boolean).join(' · ')}</span>
              </button>`)
            : html`<span class="shot__pickempty">
                Still loading the model list…
              </span>`}
        </div>
        </div>` : nothing}
      </div>
    </div>`;
  }

  /** Pick a model for this shot, and close the list. */
  private chooseModel(id: string): void {
    this._pickingModel = false;
    if (id === this.model.props.model) return;
    this.store.captureSync();
    this.store.updateBlock(this.model, { model: id });
  }

  /**
   * Wheel scrolls the LANE, not the canvas.
   *
   * BlockSuite's root handler zooms and pans on wheel, so without this a scroll
   * gesture over a reference row would zoom the whole board — the single most
   * jarring thing a canvas can do while you are reading a list. Only claimed
   * when the lane actually has somewhere to scroll, so an empty row still pans
   * the board like the space around it.
   */
  private readonly onLaneWheel = (e: WheelEvent) => {
    const strip = e.currentTarget as HTMLElement;
    if (strip.scrollWidth <= strip.clientWidth) return;
    e.stopPropagation();
    e.preventDefault();
    strip.scrollBy({ left: e.deltaY + e.deltaX, behavior: 'auto' });
  };

  /** Highlight a drop zone. Called by the board's drop controller. */
  setDropTarget(id: string | null): void {
    this._over = id;
  }

  /** Where a point lands: a slot role, a lane id, or null. Used by the drop
   *  controller so one implementation decides both the highlight and the drop. */
  zoneAt(clientX: number, clientY: number): string | null {
    const el = this.ownerDocument
      .elementFromPoint(clientX, clientY) as HTMLElement | null;
    const slot = el?.closest<HTMLElement>('[data-slot]')?.dataset.slot;
    if (slot) return slot;
    return el?.closest<HTMLElement>('[data-lane]')?.dataset.lane ?? null;
  }
}
