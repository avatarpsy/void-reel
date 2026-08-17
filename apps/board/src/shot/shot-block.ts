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
  claimFieldClipboard,
  claimFormField,
  focusField,
  takeCaret,
} from '../ui/field-caret';
import {
  FIELD_SPECS, REF_KIND_LABEL, roleLabel, SHOT_KIND_HINT, SHOT_KIND_LABEL, SHOT_KINDS,
  chosenTake, formatTime, isTimed, rolesFor, takeAsMedia, takeThumb, trimWindow,
  type MediaRole, type ShotBlockModel, type ShotKind, type ShotMedia,
  type ShotTake,
} from './model';
import { allBlocks, findBlock, onBlockCatalogue, searchBlocks, type BlockInfo } from './blocks';
import { ASSET_DRAG_TYPE, type AssetDragEntity } from './drop';
import { chooseTake, removeTake, setShotFields, shotNumberOf } from './shots';
import { onTakeProgress, setTakeProgress, takeProgress } from './take-progress';
import { resolveSlots, slotFills } from './slots';
import { readParsed } from './screenplay-doc';
import { lazyBlockPreview, openBlockLightbox, type LazyPreview } from '../ui/block-preview';
import {
  allModels, capChips, checkShot, effectiveModel, estimateShotCredits, formatCredits,
  onModelCatalogue, referenceTag, slotSupport, snapDuration,
} from './models';

/** The form controls on this card, for the no-render-under-the-caret rule. See
 *  `typing` — an `<input>` reports `isContentEditable === false`. */
const FORM_FIELDS = /^(INPUT|TEXTAREA|SELECT)$/;

/**
 * WHAT INSIDE THE CARD ACTUALLY WANTS THE POINTER — see `bodyPointerDown`.
 *
 * Everything NOT on this list is empty space, and a press on empty space belongs
 * to the canvas: it selects the shot, and dragging from it moves the shot, which
 * is what a person expects of any object on any board.
 *
 * Deliberately a list of what CLAIMS the gesture rather than a list of what does
 * not. The card grows controls; it does not grow new kinds of nothing. A missing
 * entry here makes one control feel dead — visible, reportable, one line to fix.
 * The inverse list would make a whole card undraggable the moment anybody added
 * a `<div>`, and nobody would know why.
 */
const CLAIMS_POINTER = [
  'button', 'input', 'textarea', 'select', 'a[href]',
  '[contenteditable]',
  '.tile',            // a reference — click opens it, drag moves it
  '.take',            // a result — same
  '.field',           // the written boxes place their own caret
  '.shot__preview',   // a graphic's live composition
  '.shot__seq',       // the scene pill
].join(',');

/** The order a model receives references in — see the note in `screenplay.ts`.
 *  Kept identical to compile's, because the prompt tags are numbered from it. */
const ROLE_ORDER: MediaRole[] = [
  'firstFrame', 'lastFrame', 'motionRef',
  'background', 'figure', 'inset', 'logo', 'texture',
  'reference', 'sfx', 'bgm',
];

/** Lanes, in the order a shot is thought about: looks, moves, sounds. */
/**
 * THE LANES ARE REFERENCES, and the labels now say so.
 *
 * They read IMAGES / VIDEO / MUSIC & SFX, which named the MEDIUM and left the
 * job unsaid — so a lane looked like an attachment list, somewhere to keep files
 * that belong to this shot. It is not. Everything in these rows is an INPUT to
 * the generation: on a model that reads @-tags each one can be pointed at from
 * the prompt by name ("she turns, like @Video1"), and on a model that does not
 * they are still the reference set the picture is built from.
 *
 * Naming them REFS is the difference between "files I put here" and "what this
 * shot is made of".
 */
const LANES = [
  { id: 'image', label: 'IMAGE REFS', empty: 'Drop stills here' },
  { id: 'video', label: 'VIDEO REFS', empty: 'Drop clips here' },
  { id: 'audio', label: 'MUSIC & SFX REFS', empty: 'Drop audio here' },
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
    /* The sequence pill. Claims its own pointer events so it stays clickable
       inside a header whose whole job is to be a drag handle. */
    .shot__seq {
      font: 600 9px/1 var(--affine-font-family, sans-serif);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 3px 7px;
      border-radius: 999px;
      border: 1px solid var(--vs-border, rgba(127, 140, 170, 0.34));
      background: none;
      color: var(--vs-text, #1a1a2e);
      cursor: pointer;
      flex: none;
      white-space: nowrap;
    }
    .shot__seq:hover {
      background: var(--vs-hover, rgba(127, 140, 170, 0.14));
    }
    .shot__seq--none {
      color: var(--vs-muted, #94a3b8);
      border-style: dashed;
    }
    /* The shot's scene was renamed or removed. Amber, not red: nothing is
       broken and nothing is lost — it just needs re-pointing. */
    .shot__seq--lost {
      color: #b45309;
      border-color: rgba(180, 83, 9, 0.45);
      background: rgba(180, 83, 9, 0.08);
    }
    /* Bounded and scrollable — a menu that grows with the screenplay must never
       overflow a fixed-height card. */
    .seqmenu {
      position: absolute;
      z-index: 24;
      top: 40px;
      left: 12px;
      right: 12px;
      max-height: 240px;
      overflow-y: auto;
      background: var(--vs-shot-bg, #fff);
      border: 1px solid var(--vs-border, rgba(127, 140, 170, 0.28));
      border-radius: 10px;
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
      padding: 4px;
    }
    .seqmenu__item {
      display: block;
      width: 100%;
      text-align: left;
      border: none;
      background: none;
      border-radius: 6px;
      padding: 6px 8px;
      cursor: pointer;
      color: var(--vs-text, #1a1a2e);
    }
    .seqmenu__item:hover {
      background: var(--vs-hover, rgba(127, 140, 170, 0.12));
    }
    .seqmenu__item[aria-current='true'] {
      background: var(--vs-hover, rgba(127, 140, 170, 0.18));
    }
    .seqmenu__k {
      font: 600 10px/1.35 var(--affine-font-family, sans-serif);
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }
    .seqmenu__h {
      font: 400 10.5px/1.35 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #94a3b8);
    }
    .seqmenu__empty {
      font: 400 11px/1.45 var(--affine-font-family, sans-serif);
      color: var(--vs-muted, #94a3b8);
      padding: 8px;
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
    .shot__title:focus {
      user-select: text;
      cursor: text;
      /* SAY THAT IT IS NOW A TEXT FIELD. Without this, rename mode is
         indistinguishable from a title you happen to have clicked, and the
         first thing people did was click away to check. */
      background: var(--vs-shot-bg, #fff);
      box-shadow: 0 0 0 2px var(--vs-accent-a, #4a9bd9);
      border-radius: 6px;
      margin: -2px -4px;
      padding: 2px 4px;
    }
    .shot__title:empty::before {
      content: attr(data-placeholder);
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.42));
    }

    /* THE FRAME THE SHEETS ARE PINNED TO, and it does NOT scroll.

       The pickers used to be positioned against .shot__body. That was fine
       while the body was overflow:hidden, and became wrong the moment it
       scrolled: an absolutely-positioned child of a scroll container is placed
       against the CONTENT box, so a sheet anchored to the bottom would sit at
       the bottom of the full scroll height — off the card, invisible — and a
       sheet anchored to the top would slide away as the user scrolled.

       This layer is exactly the body's VISIBLE box and never moves, so a sheet
       stays where it was opened however far the content behind it scrolls. */
    .shot__main {
      position: relative;
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    /* THE BODY CLAIMS ITS EVENTS — see the file header. */
    .shot__body {
      flex: 1;
      min-height: 0;
      /* SCROLLS RATHER THAN SWALLOWS.
         This was overflow: hidden on a fixed-height canvas block, so any card
         whose lanes and fields added up to more than its height silently ATE
         the controls at the bottom — the model line and the duration box, which
         is what "the bottom row is clipped" was. Hidden is right for the
         horizontal axis (a lane does its own scrolling) and wrong for the
         vertical one: a control the user cannot reach is worse than a
         scrollbar. The footer has also moved out from under this rule
         entirely — see .shot__foot. */
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-width: thin;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px 14px 14px;
    }

    /* ── WHAT THE MODEL TAKES ─────────────────────────────────────────────────
       A row of facts, not a row of settings: nothing here is clickable, because
       every one of them is changed in exactly one place — the model picker. The
       off ones are drawn as plainly as the on ones. A list of only the yeses
       would leave the user inferring the noes from silence, and "no end frame"
       is as much a thing worth knowing as "end frame". */
    .caps { display: flex; flex-wrap: wrap; gap: 4px; flex: none; }
    .caps__chip {
      padding: 2px 6px;
      border-radius: 999px;
      border: 1px solid transparent;
      font: 500 8.5px/1.5 var(--affine-font-family, sans-serif);
      letter-spacing: 0.02em;
      cursor: help;
      white-space: nowrap;
    }
    .caps__chip.is-on {
      background: var(--vs-accent-a-soft, rgba(74, 155, 217, 0.14));
      border-color: var(--vs-accent-a-soft, rgba(74, 155, 217, 0.28));
      color: var(--vs-accent-a, #4a9bd9);
    }
    .caps__chip.is-off {
      background: transparent;
      border-color: var(--vs-border, rgba(127, 140, 170, 0.22));
      color: var(--vs-text-mute, rgba(127, 140, 170, 0.7));
      text-decoration: line-through;
      text-decoration-thickness: 1px;
    }

    /* A WELL THIS MODEL CANNOT READ. Still drawn, still the same size — the row
       must not reflow when the model changes, or the card jumps every time
       somebody browses the picker. Dimmed, dashed, and it refuses drops. */
    .slot.is-unsupported {
      opacity: 0.4;
      border-style: dashed;
      cursor: not-allowed;
    }
    .slot.is-unsupported .slot__label { text-decoration: line-through; }

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
    /* THE CAPTION IS A ROW, so the prompt name and the reference name can sit
       side by side instead of on top of each other. The tag was absolutely
       positioned bottom-right and printed straight over the filename. */
    .tile__name {
      position: absolute;
      inset: auto 0 0 0;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 5px;
      font: 500 9px/1.2 var(--affine-font-family, sans-serif);
      color: #fff;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.78));
    }
    /* The filename gives way first — the @-tag is the shorter and the more
       useful of the two, because it is what gets typed into the prompt. */
    .tile__label {
      min-width: 0;
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

    /* ── TAKES ────────────────────────────────────────────────────────────────
       Outputs, not inputs, so the row reads differently from the reference
       lanes above it: a rule, a warmer label, and the chosen one ringed. It is
       the only row on the card that answers "is this shot done?". */
    /* TAKES TAKE THE SLACK.
       It is the last row on the card and it was flex:none, so on a shot with
       few references the strip sat at its minimum with the rest of the card
       empty below it — a band of thumbnails too small to compare, floating
       above a hundred pixels of nothing. Growing into that space is the same
       answer to both: the previews get bigger exactly when there is room, and
       there is no leftover gap because the row has eaten it.
       flex 1 0 auto — grow, never shrink. When the references above DO fill the
       card the body scrolls, and a take strip that shrank to nothing there
       would be the old complaint in a new place.
       (No backticks in here: this is inside a css template literal.) */
    /* THE SHRINKING HALF of the box above — the controls never give, this does.
       A hairline rather than a full border: it is a division inside one box,
       not the edge between two. */
    .takes {
      display: flex;
      flex-direction: column;
      gap: 5px;
      flex: 0 1 auto;
      /* The floor is a thumbnail you can still tell two performances apart in.
         Below that the row is not worth the space it costs, and the card is
         better off giving the height to the body. */
      min-height: 104px;
      border-top: 1px solid var(--vs-border, rgba(15, 23, 42, 0.06));
      padding: 8px 14px 12px;
    }
    /* THE ROW SCROLLS SIDEWAYS AND NEVER GROWS DOWNWARD.
       A shot with nine takes is a normal amount of trying, and nine tiles must
       cost the card exactly what one does — a wrapping row would push the
       written fields down by a hundred pixels per generation. Same rule the
       reference lanes follow, and the wheel handler is the same one. */
    .takes__strip {
      display: flex;
      /* STRETCH, so a tile is as tall as the row and the row is as tall as the
         space. align-items flex-start is what left the thumbnails at their
         minimum with the strip grown around them. */
      align-items: stretch;
      gap: 8px;
      overflow-x: auto;
      overflow-y: hidden;
      overscroll-behavior: contain;
      scrollbar-width: thin;
      padding: 2px;
      /* A REAL BASIS, NOT max-height. flex: 1 against an auto basis made the
         row's height depend on the tiles, and the tiles stretch to the row —
         each waiting on the other, which is how the previews ended up at their
         minimum inside a strip that had grown around them. A stated height is
         the size the row wants; shrink takes it back down when the card is full.
         Capped at what it is, so one take does not become a contact sheet. */
      flex: 1 1 auto;
      height: 168px;
      min-height: 76px;
    }
    /* THE TAKE'S OWN SHAPE, NOT A SLOT'S.
       (No backticks anywhere in here: this is inside a css template literal.)
       Every tile was a fixed 16:9 box painting its poster with background-size
       cover, so a 9:16 take — most of what this product makes — was shown as a
       horizontal band cut out of the middle of itself: the head and the feet
       gone, and five takes that differed exactly where you could no longer see.
       Comparing takes is the entire purpose of the row, so cropping them is the
       one thing it must not do.
       Fixed HEIGHT and automatic width instead. The thumbnail is an img element
       rather than a background so the browser sizes the tile from the real
       picture: portrait takes come out narrow, landscape ones wide, all the
       same height, none of them cut. min-width covers the moment before it
       loads and a take whose poster is gone, so the row never collapses. */
    .take {
      position: relative;
      flex: none;
      /* HEIGHT COMES FROM THE ROW, which comes from the space the card has to
         give. A fixed height here is what capped the previews at a size you
         cannot judge a performance from. */
      align-self: stretch;
      /* Narrow enough that a 9:16 thumbnail does not get padded out with dead
         space on both sides. It is a floor for the moment before the picture
         loads and for a take whose poster has gone, not a shape. */
      min-width: 34px;
      /* 16:9 AT THE ROW'S FULL HEIGHT, which is what this number is: 168 tall
         wants 299 wide. It was 260, so every landscape take was pillarboxed by
         forty pixels — the one shape that should have fit exactly. Wider than
         this is a 2.39 anamorphic frame, and letterboxing that is the honest
         thing to do rather than letting one take eat the row. */
      max-width: 300px;
      border-radius: 7px;
      overflow: hidden;
      background: #12161f;
      cursor: pointer;
      border: 0;
      padding: 0;
      /* The ring is drawn OUTSIDE via box-shadow rather than as a border: a
         border would shrink the picture by two pixels, so ticking a take would
         nudge every tile in the row. */
      box-shadow: none;
      transition: box-shadow 0.12s ease;
    }
    /* CONTAIN, not cover, for the same reason the box is auto-width: a poster
       whose aspect disagrees with the tile must letterbox rather than lose its
       edges. With the width taken from the picture the two agree anyway, so
       this only bites while the tile is at its min or max. */
    .take__thumb {
      display: block;
      height: 100%;
      width: auto;
      max-width: 300px;
      object-fit: contain;
      background: #12161f;
      /* A shot with nine takes is nine pictures the browser must not fetch
         until the card is on screen. */
      pointer-events: none;
      user-select: none;
    }
    .take:hover { box-shadow: 0 0 0 2px var(--vs-border-strong, rgba(15, 23, 42, 0.3)); }
    /* THE CHOSEN ONE. This is the whole point of the row, so it is the loudest
       thing in it and it does not depend on hover to be visible. */
    .take.is-on { box-shadow: 0 0 0 2px var(--vs-accent-a, #4a9bd9); }
    /* THE CHOICE, as a control.
       Outlined and hover-revealed on the takes that are not chosen, exactly like
       the ✕ opposite it; filled and permanent on the one that is, because that
       is the row's whole answer and it must not depend on hover to be readable. */
    .take__tick {
      position: absolute;
      top: 3px; left: 3px;
      width: 16px; height: 16px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.62);
      color: #fff;
      font: 700 9px/1 var(--affine-font-family, sans-serif);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.12s ease, background 0.12s ease;
    }
    .take:hover .take__tick { opacity: 1; }
    .take__tick:hover { background: rgba(74, 155, 217, 0.85); }
    .take__tick.is-on {
      background: var(--vs-accent-a, #4a9bd9);
      opacity: 1;
      cursor: default;
    }
    .take__n {
      position: absolute;
      inset: auto 0 0 0;
      padding: 3px 5px;
      font: 500 9px/1.2 var(--affine-font-family, sans-serif);
      color: #fff;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.78));
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: left;
    }
    /* Running and failed are STATES OF A TAKE, not toasts. A generation outlives
       the tab it started in, so the card has to be able to say "still working"
       after a reload — a shot that quietly lost what it was making is
       indistinguishable from one that never started. */
    .take__state {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      font: 500 9px/1.3 var(--affine-font-family, sans-serif);
      color: #fff;
      text-align: center;
      padding: 4px;
      background: rgba(9, 12, 18, 0.72);
    }
    .take--failed .take__state { background: rgba(120, 22, 22, 0.76); }
    .take__x {
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
    .take:hover .take__x { opacity: 1; }
    /* ALWAYS VISIBLE, unlike the ✕ beside it. Discarding is a tidy-up you go
       looking for; stopping is what you want the instant you realise a render
       is going wrong, and a control you must hover to discover is one you do
       not find while watching a machine struggle. Sits left of the ✕ so the
       two never overlap on a card narrow enough to show both. */
    .take__stop {
      position: absolute;
      top: 3px; right: 22px;
      width: 16px; height: 16px;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.72);
      color: #fff;
      font-size: 8px;
      line-height: 1;
      cursor: pointer;
    }
    .take__stop:hover { background: rgba(150, 30, 30, 0.9); }

    /* flex:none, NOT flex:1. The graphic card's single REFERENCES lane
       also grows, and with a few clips in it the lane won and squeezed ACTION
       and VOICEOVER down to a couple of pixels each — they looked like broken
       dropdowns rather than like text fields. The lane is the only thing here
       allowed to take the slack. */
    .fields { display: flex; flex-direction: column; gap: 8px; flex: none; }
    /* THE WHOLE BOX IS THE TARGET, not the text node inside it.
       Only .field__text used to accept a click, so the label, the padding and
       the empty space under one short line were all dead — which on a card with
       an empty ACTION is most of the control. Clicking a box that looks like a
       text field and getting nothing is exactly the "I can't select the text
       box" report. The text cursor says so before the click. */
    .field {
      display: flex;
      flex-direction: column;
      gap: 3px;
      border: 1px solid var(--vs-border, rgba(15, 23, 42, 0.1));
      border-radius: 9px;
      padding: 7px 10px;
      background: var(--vs-shot-field, rgba(127, 140, 170, 0.06));
      /* 1 0 auto, AND THE THIRD VALUE IS THE WHOLE POINT.
         (No backticks in here: this is inside a css template literal.)
         Plain flex: 1 is shorthand for 1 1 0% — a base size of ZERO, so the box
         sized itself purely from the leftover space and ignored the text in it
         completely. Measured: 842 characters in a box 114px tall holding 165px
         of text, with 51px of it simply not shown. A basis of auto sizes the box
         from its content, which is what a paragraph needs; the grow keeps the
         old behaviour of taking up slack when the card has some. No shrink, so a
         long prompt pushes the card body into scrolling rather than being
         squeezed until it clips again. */
      flex: 1 0 auto;
      cursor: text;
      transition: border-color 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
    }
    .field:hover { border-color: var(--vs-border-strong, rgba(15, 23, 42, 0.22)); }
    /* THE FOCUS RING IS NOT DECORATION. A canvas has no window chrome and no tab
       order a person can see, so without it there is no way to tell which of
       three identical boxes is receiving what you type — and typing into the
       wrong one is silent. */
    .field:focus-within {
      border-color: var(--vs-accent-a, #4a9bd9);
      box-shadow: 0 0 0 2px rgba(74, 155, 217, 0.22);
      background: var(--vs-shot-bg, #fff);
    }
    .field__label {
      font: 500 9px/1 var(--affine-font-family, sans-serif);
      letter-spacing: 0.08em;
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.45));
      /* The label is part of the target — clicking it focuses the field (see
         focusFieldBox) — so it must not swallow the pointer itself. */
      pointer-events: none;
      user-select: none;
    }
    .field:focus-within .field__label { color: var(--vs-accent-b, #2f6fa3); }
    /* ROOM TO WRITE, AND THEN AS MUCH ROOM AS THE WRITING NEEDS.

       A flex:1 child inside a flex:none column resolves to the content height,
       so an empty SHOT was a one-line sliver you had to hit within about eleven
       pixels. Three lines minimum gives a real target and a place to see what
       you wrote.

       NO CEILING, AND NO SCROLLBAR OF ITS OWN. It used to stop at 8.5em and
       scroll inside itself, which put a THIRD scrollable box on the card — the
       canvas, the card body, and now the paragraph — nested inside each other.
       Text past the eighth line was invisible unless you found the right one to
       scroll, and a wheel over a shot could mean any of three things depending
       on the pixel it was over. A prompt is the thing the whole card is about;
       hiding two thirds of it to save eighty pixels is the wrong trade.

       The card body scrolls instead, which it already did and which is one
       obvious place for the overflow to go. */
    .field__text {
      font: 400 11.5px/1.45 var(--affine-font-family, sans-serif);
      outline: none;
      /* Content-based, for the same reason as .field above. */
      flex: 1 0 auto;
      min-height: 3.1em;
      /* Long words and pasted URLs must wrap rather than widen the box and put
         a horizontal scrollbar under the paragraph. */
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      /* Selection has to be VISIBLE to be trusted. The canvas suppresses text
         selection broadly to keep drags clean; a field is the one place that
         must opt back in. */
      user-select: text;
      -webkit-user-select: text;
    }
    .field__text::selection { background: rgba(74, 155, 217, 0.32); }
    .field__text:empty::before {
      content: attr(data-placeholder);
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.38));
    }

    /* THE TWO BOXES ARE NOT EQUALS, and the sizes should say so.
       SHOT is the description of the panel and now carries the framing too, so
       it is where most of the writing goes. VOICEOVER is one spoken line —
       given the same height it reads as a box somebody forgot to fill in, and
       it took room from the field that needed it. */
    .field[data-field='action'] .field__text { min-height: 4.4em; }
    .field[data-field='voiceover'] .field__text { min-height: 2.2em; }
    .field[data-field='camera'] .field__text { min-height: 2.2em; }
    /* The legacy CAMERA box is a leftover to empty out, not a control to fill
       in. Dimmed so it reads that way without hiding what it holds. */
    .field[data-field='camera'] { opacity: 0.72; }
    .field[data-field='camera']:focus-within { opacity: 1; }

    /* The prompt's own name for a reference — @Image2. Small and unobtrusive:
       it matters when you are wiring a prompt and is noise the rest of the
       time. */
    /* THE NAME THE PROMPT USES FOR THIS REFERENCE.
       Legible at rest and brighter on hover: it is the word the user types into
       SHOT to point at this picture, so it has to be readable without having to
       go looking for it. 8px in a corner was a smudge nobody could copy.
       In the caption row rather than floating over it — see .tile__name. */
    .tile__tagno {
      flex: none;
      padding: 1px 5px;
      border-radius: 4px;
      font: 700 9px/1.5 var(--affine-font-family, sans-serif);
      letter-spacing: 0.02em;
      background: var(--vs-accent-a, #4a9bd9);
      color: #fff;
      cursor: help;
      opacity: 0.85;
      transition: opacity 0.12s ease, box-shadow 0.12s ease;
    }
    .tile:hover .tile__tagno {
      opacity: 1;
      box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.25);
    }
    /* A NAMED reference reads as a name, not a filename. */
    .tile__label.is-tagged { font-weight: 600; letter-spacing: 0.01em; }

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

    /* A REAL FOOTER BAR, OUTSIDE THE SCROLLING BODY.

       It used to be the last child of .shot__body. On a fixed-height canvas
       block with overflow: hidden, that meant the moment the lanes and fields
       above it added up to more than the card — which for a clip shot they did,
       by roughly forty pixels — the model line and the duration box were cut
       off the bottom. Adding padding makes that worse, not better.

       As a SIBLING of the body it is structurally unclippable: the body is the
       only thing that can give, and the controls are always reachable. */
    /* THE BOTTOM OF THE CARD, AS ONE BOX.
       (No backticks in here: this is inside a css template literal.)

       The model line, the length, GENERATE and the takes, held together below
       the scrolling body. See the markup for why neither half can live inside
       the body.

       0 1 auto: no grow, so the free space on a nearly empty card goes to the
       body and this stays against the bottom edge rather than floating in the
       middle. Shrink, so a card the user has made short gives space back from
       the take row — but only down to the floor below, which is the height of
       the controls plus a thumbnail you can still judge. Past that the card is
       simply too short and the body, which is the part that scrolls, keeps
       giving instead. */
    .shot__base {
      display: flex;
      flex-direction: column;
      flex: 0 1 auto;
      min-height: 0;
      border-top: 1px solid var(--vs-border, rgba(15, 23, 42, 0.1));
      background: var(--vs-shot-bg, #fff);
    }
    /* The controls are the one thing on this card that never gives up a pixel:
       flex none, so however short the card gets, the model line and the button
       are still there. */
    .shot__foot {
      position: relative;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      flex: none;
      padding: 9px 14px;
      font: 500 9.5px/1 var(--affine-font-family, sans-serif);
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.45));
    }
    /* Length, typed. A number field rather than a slider: people think in
       whole seconds here ("make it four"), and a slider on a canvas card is a
       drag that fights the canvas for the same gesture.

       TWO THINGS MADE THIS FEEL BROKEN, and only one of them was visible.

       The invisible one: the input carried no data-range-sync-exclude, so
       BlockSuite's range binding treated it as stray content inside the editor
       host and called host.focus() a frame after every caret move — the caret
       left the field between keystrokes. The attribute is on the element now;
       the full account is in ui/field-caret.ts, which found and fixed exactly
       this for the contenteditables and never reached the inputs.

       The visible one: 30px is not a target. It fits "5" and clips the caret
       typing "10", it has no box to aim at, and it sat in a footer that was
       being cut off (see .shot__foot). A field you have to hunt for reads as
       one that refuses you. */
    .shot__durwrap { flex: none; display: inline-flex; align-items: center; gap: 2px; }
    .shot__durin {
      /* Wide enough for three digits and the caret after them. 44px fitted "5"
         and clipped the caret typing "120", which reads as the box refusing the
         keystroke rather than as a box that is too small. */
      width: 56px;
      appearance: none;
      -moz-appearance: textfield;
      border: 1px solid var(--vs-border, rgba(15, 23, 42, 0.14));
      border-radius: 5px;
      padding: 3px 5px;
      background: var(--vs-shot-field, rgba(127, 140, 170, 0.06));
      color: inherit;
      font: inherit;
      text-align: right;
      outline: none;
      cursor: text;
    }
    .shot__durin:hover { border-color: var(--vs-border-strong, rgba(15, 23, 42, 0.22)); }
    .shot__durin::-webkit-outer-spin-button,
    .shot__durin::-webkit-inner-spin-button { appearance: none; margin: 0; }
    .shot__durin:focus { border-color: var(--vs-accent-a, #4a9bd9); }
    .shot__cost { flex: none; cursor: help; }
    /* WHO SPEAKS. Shown only on models that CAN speak — on the rest it would be
       a switch with nothing behind it, and the card already warns when a
       narration is written against a model that cannot voice it. */
    /* THE VERB. The shot has carried every input to a generation since it was
       built and had no way to run one — the only route to a clip was compiling
       the whole board into a project. Small and quiet, because it sits on sixty
       cards at once, but it is the most important control here. */
    .shot__gen {
      flex: none;
      appearance: none;
      border: 1px solid var(--vs-accent-a, #4a9bd9);
      border-radius: 999px;
      padding: 3px 10px;
      background: transparent;
      color: var(--vs-accent-b, #2f6fa3);
      font: 600 9.5px/1 var(--affine-font-family, sans-serif);
      letter-spacing: 0.02em;
      cursor: pointer;
      white-space: nowrap;
    }
    .shot__gen:hover { background: var(--vs-accent-a, #4a9bd9); color: #fff; }
    .shot__gen[disabled] {
      opacity: 0.45;
      cursor: default;
      border-color: var(--vs-border, rgba(15, 23, 42, 0.18));
      color: var(--vs-text-mute, rgba(26, 26, 46, 0.45));
    }
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
      /* see .shot__pick--down */
      z-index: 3;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--vs-border-strong, rgba(15, 23, 42, 0.2));
      border-radius: 10px;
      background: var(--vs-shot-bg, #ffffff);
      box-shadow: 0 8px 26px rgba(15, 23, 42, 0.18);
    }
    /* A SHEET OPENS FROM THE THING THAT OPENED IT.
       The sheet is anchored to the top of the body, which is right for BLOCK
       and FILL — their buttons are in the kind row, a few pixels above. It is
       wrong for MODEL, whose button is in the FOOTER: the list flew to the
       opposite end of the card from the control that was just pressed, which
       reads as a different card's menu opening. Same sheet, anchored to the
       near edge. */
    .shot__pick--down {
      top: auto;
      bottom: 6px;
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
  /** True while the sequence menu is open on this card. */
  @state() private accessor _pickingSeq = false;
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

  /**
   * Planned length. Blank clears it back to "not decided".
   *
   * SNAPPED TO WHAT THE MODEL WILL ACTUALLY MAKE. A model with discrete lengths
   * does not round the number for you — it takes what it is given and returns
   * whatever it makes, so a card reading "7s" against a 5/10 model is a promise
   * nothing keeps, and the first place anyone finds out is the finished cut.
   * Snapping here means the number on the card is the number the film gets.
   *
   * A GRAPHIC IS NOT SNAPPED: it is rendered, not generated, so it holds for
   * exactly as long as it is told to and no model has an opinion.
   */
  private setDuration(raw: string): void {
    const asked = Math.max(0, Math.min(600, Math.round(Number(raw) || 0)));
    // The SAME `snapDuration` the cost estimate and the generation request use,
    // so the card cannot show a length the rest of the system disagrees with.
    // Zero is "not decided" rather than a length, and stays untouched.
    const caps = this.shotKind === 'hyperframes'
      ? null
      : effectiveModel(this.model.props.model ?? '');
    const n = caps && asked > 0 ? Math.round(snapDuration(caps, asked)) : asked;
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

  /** Take progress is not a block prop either — same reason as the catalogues. */
  private disposeTakeProgress: (() => void) | null = null;
  private disposeClipboard: (() => void) | null = null;

  /**
   * The sequence pill reads the SCREENPLAY block, not this one.
   *
   * So renaming a sequence, or reordering the structure, changes what this card
   * should say while nothing about this card has changed — and Lit would keep
   * painting the old label. Watching document updates is the cheap fix; the
   * handler only marks dirty, and Lit coalesces to one repaint per frame.
   */
  private disposeDoc: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // BOTH catalogues arrive after first paint, and the card reads both — the
    // model line and its warnings from one, the block name and its slot count
    // from the other. Neither is a block prop, so nothing else marks the card
    // dirty when they land.
    /**
     * COPY, CUT AND PASTE BELONG TO WHICHEVER FIELD IS FOCUSED.
     *
     * The edgeless clipboard controller cancels every paste that reaches the
     * host, so without this a shot card's fields could be copied FROM and never
     * pasted INTO — silently, with no error to go looking for. Bound on the
     * card, in capture, so it is ahead of BlockSuite's dispatcher; see
     * `claimFieldClipboard`.
     */
    this.disposeClipboard = claimFieldClipboard(this);

    this.disposeCatalogue = onModelCatalogue(() => this.requestUpdate());
    this.disposeBlocks = onBlockCatalogue(() => this.requestUpdate());
    this.disposeTakeProgress = onTakeProgress(() => this.requestUpdate());
    /**
     * COALESCED TO ONE FRAME, and that matters more than it looks.
     *
     * `blockUpdated` fires on every pointermove of a drag, and a drag across a
     * sixty-shot board therefore queued sixty `requestUpdate()` calls per move
     * event — several hundred per frame. Lit batches its own renders, so the
     * repaint count was already bounded, but the CALLS were not free and the
     * pattern hid the real cost: each of those renders recomputed the script and
     * the shot list from scratch (now memoised — see `board/doc-cache.ts`).
     *
     * One request per frame is the honest rate: nothing a person can see changes
     * faster than that.
     */
    let queued = false;
    const sub = this.store.slots.blockUpdated.subscribe(({ id }) => {
      // Only for OTHER blocks: this card's own props already trigger a render,
      // and re-requesting on them would double the work on every keystroke.
      if (id === this.model.id || queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (!this.isConnected) return;
        /**
         * ── AND ONLY IF SOMETHING THIS CARD SHOWS ACTUALLY CHANGED ───────────
         *
         * Coalescing to one frame bounded the rate; it did not bound the WORK.
         * Every card still re-rendered its whole template whenever any other
         * block changed anywhere on the board, and a shot card is the heaviest
         * template in the app.
         *
         * Measured on a 189-shot board: nudging ONE card by a single pixel
         * re-rendered all 189. One `set_scene` — which moves a whole row — cost
         * 280ms, against 9ms for the identical write without a relayout. An
         * agent filing a feature's worth of shots onto their scenes took 35
         * seconds, essentially all of it redrawing cards whose own content had
         * not moved.
         *
         * There are exactly two things a card draws from OTHER blocks: its SHOT
         * number, which comes from where its neighbours sit, and its scene pill,
         * which comes from the screenplay. Both are cheap to ask for — the order
         * is memoised per revision and the parse per script text — so asking
         * first and re-rendering only on a difference turns an O(n) repaint into
         * an O(n) comparison and, in the overwhelming majority of edits, no
         * repaint at all.
         */
        const sig = this.externalSignature();
        if (sig === this.lastExternal) return;
        this.lastExternal = sig;
        this.requestUpdate();
      });
    });
    this.disposeDoc = () => sub.unsubscribe();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disposeCatalogue?.();
    this.disposeBlocks?.();
    this.disposeDoc?.();
    this.disposeTakeProgress?.();
    this.disposeClipboard?.();
    this.disposeCatalogue = null;
    this.disposeBlocks = null;
    this.disposeDoc = null;
    this.disposeTakeProgress = null;
    this.disposeClipboard = null;
    for (const off of this.dragCleanups) off();
    this.dragCleanups = [];
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

  /**
   * MAKE THE TILES DRAGGABLE — out to the canvas, or onto another shot.
   *
   * Until now media could get INTO a shot two ways and out none: the only exit
   * was the ✕ that deletes. So the canvas, which the whole design calls the
   * scratch pad, could not actually be used as one — you could not pull three
   * takes out, lay them side by side, and throw two back.
   *
   * Registered here rather than in the template because `std.dnd.draggable`
   * binds to a live element and hands back a disposer. Lit replaces those
   * elements on re-render, so the bindings are torn down and rebuilt each pass —
   * cheap (a handful of tiles) and correct, where a stale binding would point at
   * a detached node and silently stop working.
   */
  private dragCleanups: Array<() => void> = [];

  private syncTileDrags(): void {
    for (const off of this.dragCleanups) off();
    this.dragCleanups = [];

    const dragId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    for (const el of this.querySelectorAll<HTMLElement>('[data-drag-media]')) {
      const mediaId = el.dataset.dragMedia!;
      const item = (this.model.props.media ?? []).find(m => m.id === mediaId);
      if (!item) continue;
      this.dragCleanups.push(this.std.dnd.draggable<AssetDragEntity>({
        element: el,
        setDragData: () => ({
          type: ASSET_DRAG_TYPE,
          dragId: dragId(),
          // The same description of the same asset the panel would send, so
          // whatever receives it cannot tell where the drag started — except by
          // `origin`, which is the one thing that must differ.
          media: {
            kind: item.kind, src: item.src, url: item.url, name: item.name,
            ...(item.poster ? { poster: item.poster } : {}),
            ...(item.mediaId ? { mediaId: item.mediaId } : {}),
            ...(item.scope ? { scope: item.scope } : {}),
          },
          origin: { shotId: this.model.id, mediaId: item.id },
        }),
      }));
    }

    for (const el of this.querySelectorAll<HTMLElement>('[data-drag-take]')) {
      const takeId = el.dataset.dragTake!;
      const t = (this.model.props.takes ?? []).find(x => x.id === takeId);
      // Only a finished take has anything to drag. A spinner is not a file.
      if (!t || t.status !== 'ready' || !(t.url || t.src)) continue;
      this.dragCleanups.push(this.std.dnd.draggable<AssetDragEntity>({
        element: el,
        setDragData: () => {
          // `id` and `role` belong to a shot's own list, and a drag is not in
          // one yet — `addMedia` mints both on arrival.
          const { id: _id, role: _role, ...media } = takeAsMedia(t);
          return {
            type: ASSET_DRAG_TYPE,
            dragId: dragId(),
            media,
            // `takeId` marks it a COPY — see `handleAssetDrop`. Dragging a take
            // out is auditioning it, never filing it away.
            origin: { shotId: this.model.id, takeId: t.id },
          };
        },
      }));
    }
  }

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

  /**
   * SHOT number, from position on the board. The filmstrip IS the order.
   *
   * Not a scene number, and the distinction is load-bearing: a scene is a place
   * and a moment in the screenplay, a shot is one set-up covering part of one,
   * and several shots routinely share a scene. The screenplay's number lives on
   * the pill (`renderSeqPill`) and comes from the script; this one comes from
   * where the card sits.
   *
   * Off the SHARED shot list rather than rescanning. This used to walk every
   * shot block, JSON.parse each `xywh` and sort — per card, per render — so
   * painting an n-shot strip cost O(n²) parses. `readShots` is memoised per
   * document revision, so the whole strip now shares one scan.
   */
  private get shotNumber(): number {
    return shotNumberOf(this.std, this.model.id);
  }

  /** The last value of `externalSignature`, so a change can be told from a tick. */
  private lastExternal = '';

  /**
   * EVERYTHING THIS CARD DRAWS FROM BLOCKS THAT ARE NOT IT.
   *
   * Two things, and that is the whole list:
   *
   *   • its SHOT number, which is its place among its neighbours;
   *   • its scene pill — the screenplay's number and heading for the scene it
   *     covers, or the fact that the key no longer resolves.
   *
   * `scenes.length` is in there for the scene MENU, which lists all of them
   * while it is open. Everything else on the card comes from its own props, and
   * Lit already re-renders for those.
   *
   * Both reads are memoised — the shot order per document revision, the parse
   * per script text — so this costs a map lookup and a find, not a scan.
   */
  private externalSignature(): string {
    const key = this.model.props.sceneKey ?? '';
    const script = readParsed(this.std);
    const scene = key ? script.scenes.find(c => c.key === key) : null;
    return [
      this.shotNumber,
      key,
      scene ? `${scene.n}·${scene.heading}` : '',
      script.scenes.length,
    ].join('|');
  }

  // ── Editing ───────────────────────────────────────────────────────────────

  /**
   * True while the caret is in one of this card's own fields.
   *
   * ── AND AN <input> IS A FIELD, which this did not know ───────────────────
   * It tested `isContentEditable` only, so the four real form controls on the
   * card — the LENGTH box above all — were not covered by the no-render-under-
   * the-caret rule below. Their value is a property binding
   * (`.value=${...durationSec}`), so ANY re-render wrote the stored number back
   * over whatever was half-typed: select the field, type "1" on the way to "12",
   * and a take-progress tick or the model catalogue arriving put "5" back and
   * moved the caret. Intermittent, invisible, and indistinguishable from the box
   * refusing to be edited.
   *
   * `isContentEditable` is false on an `<input>` — it is not a myth that it is
   * true, it is simply a different mechanism — which is why the original test
   * looked complete and was not.
   */
  private get typing(): boolean {
    const active = this.ownerDocument.activeElement as HTMLElement | null;
    if (!active || !this.contains(active)) return false;
    return active.isContentEditable || FORM_FIELDS.test(active.tagName);
  }

  /**
   * Paint whatever changed while the caret was busy.
   *
   * Every field that can hold focus has to call this when it loses it, or the
   * card stays frozen at whatever it looked like when typing began — the writes
   * were not lost, they were only not drawn.
   */
  private flushDeferred(): void {
    if (!this.deferredRender) return;
    this.deferredRender = false;
    this.requestUpdate();
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
    this.syncFieldText();
    this.syncPreview();
    this.syncTileDrags();
  }

  /**
   * THE EDITABLE TEXT IS WRITTEN BY HAND, NOT BY LIT — and it has to be.
   *
   * ── WHAT IT COST TO LET LIT OWN IT ──────────────────────────────────────────
   * The fields used to interpolate the model value as the element's CHILD. Lit
   * implements a child binding by planting two marker comment nodes and keeping
   * references to them, and a contenteditable is a box whose children the
   * BROWSER rewrites:
   * select-all-and-type replaces them, a paste replaces them, and a delete that
   * empties the box takes the markers with it. Lit's references then point at
   * nodes with no parent, and the next render throws:
   *
   *     Cannot read properties of null (reading 'insertBefore')   [lit ChildPart]
   *
   * Caught by the E2E suite's console check, three times in one step, right
   * after a paste — and a card whose render throws stops updating entirely,
   * which is what "I click and type and it loses focus" looks like from the
   * outside. No amount of guarding WHEN we render could fix it; the markers had
   * no business being inside an editable box in the first place.
   *
   * ── AND NEVER UNDER THE CARET ───────────────────────────────────────────────
   * A focused field is skipped outright. Writing `textContent` collapses the
   * selection and dumps the caret to the start, so the box the user is typing in
   * is the one box that must be left alone. `commit` on blur is what puts the
   * model and the DOM back in agreement, and `flushDeferred` renders once the
   * caret has gone.
   *
   * Compared before writing, because assigning `textContent` destroys and
   * rebuilds the text node even when the string has not changed — which would
   * throw away the browser's own undo stack on every unrelated render.
   */
  private syncFieldText(): void {
    const active = this.ownerDocument.activeElement;
    const props = this.model.props as unknown as Record<string, unknown>;
    for (const el of this.querySelectorAll<HTMLElement>('[data-textbind]')) {
      if (el === active) continue;
      const key = el.dataset.textbind;
      if (!key) continue;
      const want = String(props[key] ?? '');
      if (el.textContent !== want) el.textContent = want;
    }
  }

  /**
   * ONE RENDER, LET THROUGH ON PURPOSE.
   *
   * The rule below protects a focused field from renders it did not ask for.
   * Some renders ARE asked for by the focused field: the block search filters
   * its list on every keystroke, so blocking those would leave the user typing
   * into a box while the results underneath never moved. Lit dirty-checks the
   * value binding, so a render the field itself caused cannot clobber it — the
   * committed string is the one already in the box.
   */
  private allowOneRender = false;

  protected override shouldUpdate(changed: Map<PropertyKey, unknown>): boolean {
    if (this.allowOneRender) {
      this.allowOneRender = false;
      return super.shouldUpdate(changed);
    }
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
    this.flushDeferred();
  }

  /**
   * Keep the canvas out of the way while typing.
   *
   * The editor's dispatcher listens on the host for keys — Backspace deletes the
   * selected block, space starts panning. Without this, typing in a field would
   * delete the shot you are typing into.
   *
   * ESCAPE leaves the field. On a canvas that is the only unambiguous way out:
   * clicking away might be the start of a drag, and there is no OK button.
   *
   * TAB WALKS THE CARD, and is claimed rather than left to the browser. Every
   * contenteditable is focusable, so the native order runs off the card and into
   * whatever block Lit rendered next — which on a filmstrip is the shot beside
   * this one, and the user is then typing the wrong scene's voiceover. Title →
   * action → voiceover → camera → out is the order the card is read in.
   */
  private readonly stopKeys = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      (e.target as HTMLElement).blur();
      return;
    }
    if (e.key === 'Tab') {
      const fields = [...this.querySelectorAll<HTMLElement>('.shot__title, .field__text')];
      const at = fields.indexOf(e.target as HTMLElement);
      const next = fields[at + (e.shiftKey ? -1 : 1)];
      // Past either end, fall out of the card entirely rather than wrapping —
      // wrapping traps the keyboard inside one shot with no way off it.
      if (at < 0 || !next) { (e.target as HTMLElement).blur(); return; }
      e.preventDefault();
      focusField(this.std, next);
    }
  };

  /**
   * Wheel over the card BODY, now that the body scrolls.
   *
   * Same rule as the lanes and the written fields, for the same reason and by
   * the same test: claimed only when there is somewhere to scroll. A card whose
   * content fits still pans and zooms the board like the space around it, so
   * this cannot create a dead zone — and a card that overflows scrolls to its
   * own bottom instead of zooming the viewport out from under the reader.
   *
   * The lanes see the event first and stop it when THEY can scroll, so the
   * innermost thing that can move is the thing that moves. The written fields
   * no longer take part: they grow to their text rather than scrolling inside
   * themselves, so the body is where their overflow goes.
   */
  private readonly onBodyWheel = (e: WheelEvent) => {
    const el = e.currentTarget as HTMLElement;
    if (el.scrollHeight <= el.clientHeight) return;
    e.stopPropagation();
  };

  /** See `ui/field-caret.ts` — the reasoning lives with the code. */
  private takeCaret(el: HTMLElement, clientX: number, clientY: number): void {
    takeCaret(this.std, el, clientX, clientY);
  }

  /**
   * Put this shot on a scene of the screenplay, or take it off.
   *
   * Detaching is offered FIRST in the menu, deliberately: a shot on the WRONG
   * scene is worse than one on none, because the screenplay then claims coverage
   * it has not got — and the whole value of the margin marks is that "no shots
   * yet" can be trusted.
   */
  private setScene(sceneKey: string): void {
    this._pickingSeq = false;
    if ((this.model.props.sceneKey ?? '') === sceneKey) return;
    /**
     * THROUGH `setShotFields`, not straight to the store.
     *
     * A scene is a ROW on the board now, so changing it MOVES the card — and
     * that re-flow lives with the write, in one place, so the pill on the card
     * and the agent's `board_set_scene` cannot disagree about whether the board
     * gets re-laid out.
     */
    setShotFields(this.std, this.model.id, { sceneKey });
  }

  private renderSeqPill() {
    const script = readParsed(this.std);
    const key = this.model.props.sceneKey ?? '';
    const scene = script.scenes.find(c => c.key === key);

    if (!key) {
      return html`<button
        class="shot__seq shot__seq--none"
        title="Not on a scene yet"
        @pointerdown=${(e: Event) => e.stopPropagation()}
        @click=${(e: Event) => { e.stopPropagation(); this._pickingSeq = !this._pickingSeq; }}
      >+ scene</button>`;
    }

    /**
     * A KEY THAT NO LONGER RESOLVES, said plainly.
     *
     * This happens when the writer renames a slugline out from under a shot. It
     * is not corruption and nothing is lost — the shot still holds all its
     * references — but it must be VISIBLE, because a silent re-bind to the
     * wrong scene is the one failure that would quietly ruin a storyboard.
     */
    if (!scene) {
      return html`<button
        class="shot__seq shot__seq--lost"
        title="This shot's scene is no longer in the screenplay — pick its new one"
        @pointerdown=${(e: Event) => e.stopPropagation()}
        @click=${(e: Event) => { e.stopPropagation(); this._pickingSeq = !this._pickingSeq; }}
      >off-script</button>`;
    }

    return html`<button
      class="shot__seq"
      title=${`Scene ${scene.n} — ${scene.heading}`}
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @click=${(e: Event) => { e.stopPropagation(); this._pickingSeq = !this._pickingSeq; }}
    >sc ${scene.n}</button>`;
  }

  private renderSeqMenu() {
    const script = readParsed(this.std);
    const current = this.model.props.sceneKey ?? '';
    return html`<div
      class="seqmenu"
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @click=${(e: Event) => e.stopPropagation()}
      @wheel=${(e: WheelEvent) => e.stopPropagation()}
    >
      ${script.scenes.length
        ? html`
          <button
            class="seqmenu__item"
            aria-current=${current === '' ? 'true' : 'false'}
            @click=${() => this.setScene('')}
          >
            <div class="seqmenu__k">Off-script</div>
            <div class="seqmenu__h">A visual idea with no scene written for it yet.</div>
          </button>
          ${script.scenes.map(c => html`<button
            class="seqmenu__item"
            aria-current=${c.key === current ? 'true' : 'false'}
            @click=${() => this.setScene(c.key)}
          >
            <div class="seqmenu__k">${c.n}. ${c.heading}</div>
            ${c.synopsis.length
              ? html`<div class="seqmenu__h">${c.synopsis[0]}</div>`
              : nothing}
          </button>`)}`
        : html`<div class="seqmenu__empty">
            No screenplay yet. Write one first — tell the agent what you want to
            make, or type it into the screenplay page.
          </div>`}
    </div>`;
  }

  /**
   * A click that started on the field's own text.
   *
   * `stopPropagation` and NOT `preventDefault`: the canvas must not see this
   * gesture, but the BROWSER must — the native default for a pointerdown on a
   * contenteditable is caret placement and the start of a drag-selection, and
   * cancelling it is what makes a field look editable and behave like a picture.
   */
  private readonly claimCaret = (e: PointerEvent) => {
    e.stopPropagation();
    this.takeCaret(e.currentTarget as HTMLElement, e.clientX, e.clientY);
  };

  /**
   * The same, for a real form control — the LENGTH box, the block search, the
   * fill fields.
   *
   * `data-range-sync-exclude` alone does NOT hold these: it guards the
   * selectionchange steal, and there is a second one that fires off the
   * selection model and never checks it. A shot card is selected while you work
   * in it, so every click into an input was handed back to the editor host a
   * frame later. The full account, and the cure, are in `ui/field-caret.ts`.
   */
  /**
   * A PRESS IN THE CARD'S EMPTY SPACE BELONGS TO THE CANVAS.
   *
   * ── WHAT THIS REPLACED, AND WHY IT WAS TOO BLUNT ─────────────────────────
   * The body stopped EVERY pointerdown. The intent is right and is the rule the
   * whole file is built on — the canvas must not steal the gestures that select
   * a tile, place a caret or scroll a lane — but "the body" is not where the
   * user is working. It is where the controls are, plus a great deal of space
   * between them.
   *
   * The cost was that the card could not be selected or moved by anything except
   * its header. Click the gap under the lanes, click the padding beside a well,
   * click the empty half of the card: nothing. On a canvas where every other
   * object selects when you click it, a shot card that only responds along one
   * strip at the top reads as broken.
   *
   * ── THE RULE ─────────────────────────────────────────────────────────────
   * Claimed by the things that actually handle a press — a control, a field, a
   * tile — and by nothing else. Asked with `closest`, so a press on the SVG
   * inside a button is still the button's.
   *
   * `stopPropagation` and never `preventDefault`: the browser's own defaults
   * (focus, caret placement, drag-selection) are what make a field behave like a
   * field, and cancelling them is how a text box turns into a picture.
   */
  private readonly bodyPointerDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement | null)?.closest(CLAIMS_POINTER)) e.stopPropagation();
  };

  private readonly claimField = (e: PointerEvent) => {
    e.stopPropagation();
    claimFormField(this.std, e.currentTarget as HTMLElement);
  };

  /**
   * A click anywhere else in the field's BOX — the label, the padding, the empty
   * space under a short line.
   *
   * All of that used to be dead: only the inner text node had a handler, so on a
   * card with an empty ACTION the clickable region was about eleven pixels tall
   * inside a forty-pixel box that looked exactly like a text field. That is the
   * "struggling to select the text box" report, and it is a hit-target bug
   * rather than a caret bug.
   *
   * Forwards to the text and puts the caret at the END, because a click on the
   * chrome of a field is "let me write here", not "put the caret at this exact
   * pixel" — the pixel they clicked is not in the text.
   */
  private readonly focusFieldBox = (e: PointerEvent) => {
    const box = e.currentTarget as HTMLElement;
    const text = box.querySelector<HTMLElement>('.field__text');
    if (!text || text.contains(e.target as Node)) return;   // the text handles its own
    e.stopPropagation();
    e.preventDefault();   // nothing native to preserve — the target is not text
    focusField(this.std, text);
  };

  /**
   * Rename, on a deliberate double-click.
   *
   * SELECT-ALL, not a caret. Double-clicking a card's title means "rename this"
   * everywhere else on a canvas, and the first thing you type should replace the
   * name rather than land in the middle of it. An earlier build placed a caret
   * instead, on the grounds that a select-all "does not survive the browser's own
   * double-click handling" — true then, because the focus guard collapsed the
   * selection a frame later. It no longer does (see `field-caret.ts`), so the
   * behaviour people expect is available again.
   *
   * No `preventDefault`: there is nothing to cancel here, and cancelling it was
   * suppressing the browser's word-selection for anyone who wanted it.
   */
  private readonly editTitle = (e: MouseEvent) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    focusField(this.std, el);
    const sel = this.ownerDocument.defaultView?.getSelection();
    if (sel && el.textContent) {
      const all = this.ownerDocument.createRange();
      all.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(all);
    }
  };

  /**
   * The title's pointerdown, and it is deliberately conditional.
   *
   * The title is `flex: 1` and covers nearly the whole header, which is also the
   * only place to grab the card — so claiming every pointerdown here would make
   * a shot immovable. But once the title IS being edited, the canvas stealing
   * the gesture means you cannot click to move the caret inside the name you are
   * halfway through typing.
   *
   * So: while it has focus the field owns its pointer events; otherwise the
   * header does, and the card drags.
   */
  private readonly titlePointerDown = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    if (this.ownerDocument.activeElement !== el) return;   // let it drag
    e.stopPropagation();
    this.takeCaret(el, e.clientX, e.clientY);
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

  /**
   * Ask the chrome to open its viewer. A block cannot own a full-screen layer,
   * and an event keeps the two decoupled.
   *
   * `row` says which of the shot's two lists the item came out of, so the viewer
   * knows what it can page through and what it can be asked to do with it — a
   * reference is described, a take is chosen or thrown away.
   */
  private openMedia(item: ShotMedia, row: 'media' | 'takes' = 'media'): void {
    this.dispatchEvent(new CustomEvent('voidspace-open-media', {
      detail: { media: item, row }, bubbles: true, composed: true,
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
      data-drag-media=${item.id}
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
      <!--
        WHAT THE PROMPT CALLS THIS.

        Only on a model that reads tags — referenceTag returns nothing
        otherwise, which is the correct silence: writing "@Image1" into a prompt
        a model parses as prose is worse than not naming the reference at all.

        Always drawn rather than revealed on hover. It is the reference's NAME
        in the sentence the user is writing three rows above, and a name you have
        to hover to learn is a name you will not use. Hovering brightens it and
        explains what to do with it.
      -->
      <button class="tile__role" @click=${(e: Event) => { e.stopPropagation(); this.cycleRole(item); }}
              title="Change what this is for">${roleLabel(item.role)}</button>
      <button class="tile__x" @click=${(e: Event) => { e.stopPropagation(); this.removeMedia(item.id); }}
              title="Remove from this shot">✕</button>
      <span class="tile__name">
        ${promptTag
          ? html`<span
              class="tile__tagno"
              title=${`Write ${promptTag} in SHOT to point at this reference by name`}
            >${promptTag}</span>`
          : nothing}
        <span class="tile__label ${item.tag ? 'is-tagged' : ''}">${label}</span>
      </span>
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
    // What the model takes, said before the work rather than after it.
    const capabilities = isGraphic ? [] : capChips(caps);

    return html`<div class="shot">
      <div class="shot__head" data-drag-region>
        <!--
          A SHOT NUMBER, AND IT IS NOT A SCENE NUMBER.
          This badge is the card's position in the filmstrip, and it said
          "SCENE" — beside a pill that says which SCREENPLAY scene the shot
          covers, which is a different number with a different meaning. Two
          controls an inch apart both reading "scene" and disagreeing is how a
          board stops being trustworthy. A scene is a place and a moment in the
          script; a shot is one set-up that covers part of it, and several shots
          can share a scene. Only the pill speaks for the screenplay.
        -->
        <span class="shot__n" title="This shot's place in the film. The pill beside it is the screenplay scene it covers.">SHOT ${this.shotNumber}</span>
        <!--
          WHAT THIS SHOT IS FOR, on the card.

          A shot only knows what it SHOWS. The scene it covers is what says
          where and when it happens and what it is FOR. Put here rather than in
          a panel because "which scene is this?" is a question you ask while
          looking at the filmstrip, and an answer you have to go and open
          something to get is one nobody checks.

          Unattached reads "+ scene" — an invitation, not a warning. A visual
          idea sketched before its scene is written is normal work.
        -->
        ${this.renderSeqPill()}
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
          data-range-sync-exclude="true"
          data-placeholder="Name this shot…"
          title="Double-click to rename · drag to move"
          @pointerdown=${this.titlePointerDown}
          @dblclick=${this.editTitle}
          @keydown=${this.stopKeys}
          @blur=${(e: FocusEvent) => this.commit('title', e.target as HTMLElement)}
          data-textbind="title"
        ></div>
      </div>

      ${this._pickingSeq ? this.renderSeqMenu() : nothing}

      <div class="shot__main">
      <div
        class="shot__body"
        @pointerdown=${this.bodyPointerDown}
        @dblclick=${(e: Event) => e.stopPropagation()}
        @wheel=${this.onBodyWheel}
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
          THE WORDS COME FIRST, and that ordering is the card's whole argument.

          A shot starts as a sentence — "he says welcome my viewers, then a
          sci-fi title falls" — and everything below is in service of it: the
          frames that pin its ends, the references that steer its look, the
          model that renders it, the takes it produced. The card used to open
          with three empty drop wells and put that sentence below three lanes
          and a strip of results, so the first thing it asked for was a file and
          the last thing was the idea. That is backwards for the way anybody
          actually works, and it made a blank card look like a form rather than
          like somewhere to think.

          CAMERA IS HIDDEN unless it already holds text — see FIELD_SPECS.
          Framing now belongs in SHOT, in the sentence, which is how a shot list
          is actually written. A board made before that change still has
          direction in this field, so the box appears for those shots and for
          nobody else. Nothing is cleared and nothing is rewritten.

          It is hidden on a GRAPHIC either way: a composition is rendered, not
          filmed, and the field feeds motion_prompt — which a graphic never
          reads.
        -->
        <div class="fields">
          ${FIELD_SPECS
            .filter(spec => spec.key !== 'camera'
              || (!isGraphic && !!(this.model.props.camera ?? '').trim()))
            .map(spec => html`<div
              class="field"
              data-field=${spec.key}
              @pointerdown=${this.focusFieldBox}
              @dblclick=${(e: Event) => e.stopPropagation()}
            >
            <span class="field__label">${spec.label}</span>
            <div
              class="field__text"
              contenteditable="plaintext-only"
              data-range-sync-exclude="true"
              data-placeholder=${spec.placeholder}
              @pointerdown=${this.claimCaret}
              @keydown=${this.stopKeys}
              @blur=${(e: FocusEvent) => this.commit(spec.key, e.target as HTMLElement)}
              data-textbind=${spec.key}
            ></div>
          </div>`)}
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

        <!--
          WHAT THIS MODEL WILL TAKE, ON THE CARD.

          Models differ in ways that change what you DO — whether the shot can be
          made to land on an exact frame, whether the prompt can point at a
          reference by name, whether it speaks, whether it makes its own sound,
          and how long a clip may be. That was knowable and unsaid: the card drew
          the same three wells whatever the model was, and only told you after
          you had filled one in. See capChips in models.ts.
        -->
        ${!isGraphic && capabilities.length
          ? html`<div class="caps">
              ${capabilities.map(c => html`<span
                class="caps__chip ${c.on ? 'is-on' : 'is-off'}"
                title=${c.title}
              >${c.label}</span>`)}
            </div>`
          : nothing}

        <div class="shot__slots${isGraphic ? ' shot__slots--slim' : ''}">
          ${slots.map(slot => {
            const item = slotted.get(slot.role as MediaRole);
            /**
             * A WELL THE MODEL CANNOT READ SAYS SO, and keeps its shape.
             *
             * Never marked away while it HOLDS something: the reference really
             * is attached, it has to stay visible and draggable, and `checkShot`
             * is what explains that it will not survive generation. A card that
             * hid media because the model changed would be losing work quietly,
             * which is the one thing worse than wasting it.
             */
            const support = isGraphic || item
              ? { supported: true, why: '' }
              : slotSupport(caps, slot.role);
            return html`<div
              class="slot ${this._over === slot.role ? 'is-over' : ''} ${
                support.supported ? '' : 'is-unsupported'}"
              data-slot=${support.supported ? slot.role : ''}
              title=${support.why}
            >
              ${item
                ? this.tile(item, ordered)
                : html`<span class="slot__label">${slot.label}<br />${
                    support.supported ? slot.hint : `not on ${caps?.label ?? 'this model'}`}</span>`}
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

      </div>

        <!--
          THE BOTTOM OF THE CARD, AS ONE BOX, OUTSIDE THE SCROLLING BODY.

          Both halves used to be somewhere else and both were wrong for the same
          reason: the body is the one part of the card that can overflow, so
          anything left inside it can be pushed off the bottom edge.

            • The take row went first. On a shot with a written prompt and a few
              references, the fields above it added up to more than the card and
              the previews were cut in half — reachable only by scrolling a box
              nobody expects to scroll.
            • The model line and the GENERATE button went next, and that one is
              worse: shorten the card and the button a person is looking for
              simply is not there, with a strip of takes sitting where it should
              be. A control you cannot reach is not a layout problem, it is a
              card that cannot be used.

          Out here neither can be clipped. They are one box because they are one
          thought — what this shot will be made with, the button that makes it,
          and what came back — and one box means one border, one background and
          one thing that holds the bottom of the card no matter how short it is.
        -->
        <div class="shot__base">
          ${this.renderFoot(isGraphic, caps, credits, warnings)}
          ${this.renderTakes()}
        </div>

        <!--
        THE SHEETS ARE SIBLINGS OF THE BODY, NOT CHILDREN OF IT — they pin to
        .shot__main, which is the body's visible box and does not scroll. Inside
        the body they would scroll away from the control that opened them.
        -->

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
            data-range-sync-exclude="true"
            placeholder="stat, lower third, quote…"
            .value=${this._blockQuery}
            @pointerdown=${this.claimField}
            @blur=${() => this.flushDeferred()}
            @keydown=${this.stopKeys}
            @input=${(e: Event) => {
              // The list under this box filters from it, so this render is one
              // the focused field is asking for — see `allowOneRender`.
              this.allowOneRender = true;
              this._blockQuery = (e.target as HTMLInputElement).value;
            }}
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
                    data-range-sync-exclude="true"
                    .value=${r.value || r.slot.sample || '#000000'}
                    @keydown=${this.stopKeys}
                    @change=${(e: Event) => this.setSlotValue(r.slot.key, (e.target as HTMLInputElement).value)}
                  />`
                : html`<input
                    class="shot__fillinput"
                    type="text"
                    data-range-sync-exclude="true"
                    placeholder=${r.slot.sample ?? ''}
                    .value=${r.value ?? ''}
                    @pointerdown=${this.claimField}
                    @blur=${() => this.flushDeferred()}
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
        class="shot__pick shot__pick--down"
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
                title=${m.locked
                  ? `${m.label} — needs a Plus plan`
                  : m.local
                    // The LABEL already ends in the machine name ("MiniMax H3 ·
                    // Workhorse GPU"), so repeating it here read as "… · This
                    // computer runs on This computer". Only add what the label
                    // does not already say.
                    ? `${m.label}${m.local.ready ? '' : ' — not set up on that machine yet'}`
                    : m.label}
                @click=${(e: Event) => { e.stopPropagation(); this.chooseModel(m.id); }}
              >
                <span class="shot__modelname">${m.label}${m.locked ? ' · Plus' : ''}</span>
                <!--
                  A LOCAL MODEL SAYS SO HERE, because everything else about it
                  reads as the best row in the list: it is offered, it is
                  selectable, and it costs zero credits. The one thing it cannot
                  do is be generated from this button, and that was discovered
                  only by pressing it. Still selectable — the choice is
                  legitimate and the studio chat can run it — but no longer
                  silent about what it means.
                -->
                <span class="shot__modelcaps">${[
                  `${m.maxDurationSec}s`,
                  m.nativeDialogue ? 'speaks' : '',
                  m.supportsLastFrame ? 'end frame' : '',
                  m.usesReferenceTags ? '@tags' : '',
                  m.local ? 'not from the board yet' : '',
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

  /**
   * WHAT THIS SHOT WILL BE MADE WITH, AND WHAT IT WILL COST.
   *
   * A model is not a setting buried in a menu here — it decides which references
   * are legal and how long the clip can be, so a person editing the shot should
   * be able to see it without going looking. Unset reads "(default)", which is
   * an invitation rather than a silent choice: the agent's job is to ask, and a
   * shot that never got asked about is visible at a glance.
   *
   * ── WHERE IT SITS, AND WHY IT MOVED TWICE ────────────────────────────────
   * It began inside the body and was clipped: a fixed-height, overflow-hidden
   * body only shows a footer while everything above it happens to fit, and on a
   * clip card with three wells, three lanes and the written fields it did not.
   * The fix then was to pin it outside the body.
   *
   * That solved the clipping and put it in the wrong place. "Choose a model and
   * press Generate" is a DECISION, and it comes after the sentence, the frames
   * and the references — not stapled to the bottom of the card underneath the
   * results of the last one. So it is back inside the body, in the order the
   * work actually happens, and the clipping is solved the way it should have
   * been: the body SCROLLS (`overflow-y: auto`), so nothing below the fold is
   * lost, it is just below the fold.
   *
   * It still claims its own pointer events. They are redundant inside the body
   * now, and harmless — and they are what makes it safe to move this again.
   */
  private renderFoot(
    isGraphic: boolean,
    caps: ReturnType<typeof effectiveModel>,
    credits: number | null,
    warnings: ReturnType<typeof checkShot>,
  ) {
    return html`<div
      class="shot__foot"
      @dblclick=${(e: Event) => e.stopPropagation()}
    >
      <!--
        A DEFAULT IS NOT A DECISION, and the card must not present it as one.
        An unset shot still resolves to the project default — that IS what would
        be generated — but saying just "Grok Imagine" would read as a choice
        somebody made, and the whole point of per-shot models is that the choice
        gets made deliberately. So the fallback is labelled.

        A GRAPHIC HAS NO MODEL LINE at all: it is rendered, not generated, and a
        model picker on it would be a control with nothing behind it.
      -->
      ${isGraphic
        ? html`<span class="shot__model" title="A graphic is rendered from a block on your own computer — there is no model to choose and no generation cost.">Rendered, not generated</span>`
        : html`<button
            class="shot__model"
            title=${this.model.props.model
              ? 'The video model this shot will be generated with — click to change'
              : 'No model chosen for this shot — click to pick one'}
            @click=${(e: Event) => {
              e.stopPropagation();
              this._pickingBlock = false;
              this._filling = false;
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
        Duration is the single biggest lever on price — a 15s shot on the top
        tier is several times a 5s one — and nobody discovers that until after
        they have paid for twelve. Putting the estimate next to the control turns
        "how long should this be" into a decision with a visible consequence. The
        tilde is not decoration: the real charge happens at generation against
        the registry, with resolution and per-image surcharges this cannot know.
      -->
      <span class="shot__durwrap" title=${isGraphic
        ? 'How long this graphic holds on screen. Blank renders 5 seconds.'
        : 'Roughly how long this shot runs — the biggest lever on what it costs'}>
        <!--
          data-range-sync-exclude IS WHAT MAKES THIS TYPEABLE. See the note on
          .shot__durin in the styles above, and the full account in
          ui/field-caret.ts. Without it BlockSuite pulls focus back to the
          editor host between keystrokes and the box reads as broken.
        -->
        <input
          class="shot__durin"
          type="number" min="0" max="600" step="1"
          inputmode="numeric"
          data-range-sync-exclude="true"
          .value=${String(this.model.props.durationSec || '')}
          placeholder=${isGraphic ? '5' : '—'}
          @pointerdown=${this.claimField}
          @keydown=${this.stopKeys}
          @change=${(e: Event) => this.setDuration((e.target as HTMLInputElement).value)}
          @blur=${(e: FocusEvent) => {
            // `change` does not fire when the value was not altered, so the
            // deferred repaint has to hang off blur — otherwise leaving the box
            // untouched leaves the card frozen at whatever it showed when the
            // caret arrived.
            this.setDuration((e.target as HTMLInputElement).value);
            this.flushDeferred();
          }}
        />s
      </span>
      ${credits !== null
        ? html`<span class="shot__cost" title=${isGraphic
            ? 'A composition is rendered, not generated — no model credits'
            : 'Estimated generation cost. The exact charge is made when it runs.'}
          >${formatCredits(credits)}</span>`
        : nothing}

      <!--
        THERE WAS A SPEAKS / SILENT TOGGLE HERE. It is gone, and the reasoning
        is worth keeping because it will look like a missing feature.

        It asked "does this video speak?" — a question the card has already been
        answered twice over. SHOT describes the video, dialogue included;
        NARRATION is by definition a separate track laid over the top. Whether
        there is speech is therefore a property of what has been WRITTEN, and a
        third control claiming to decide it is a fourth way for the card to
        contradict itself.

        It also defaulted to SILENT, which is the answer that contradicts the
        prompt: somebody who wrote a line of dialogue into SHOT and pressed
        Generate got a silent clip, and nothing on the card said why.

        voiceMode still exists and is still sent — gen-clip-start reads it — but
        it is now DERIVED from the model rather than asked about. A model that
        can speak is allowed to; the prompt decides whether it does. See
        board-shot-gen-input in agent/rpc.ts.
        (No backticks in here: this is inside a template literal.)
      -->

      <!--
        RUN IT.

        A graphic has no button: it renders from its block on the user's own
        machine, exactly and for free, so a "generate" here would charge for a
        worse version of something already available.

        Disabled with a REASON in the tooltip rather than hidden. A control that
        vanishes when the shot is empty teaches nobody what to do next; one that
        says "write what happens first" does.
      -->
      ${isGraphic ? nothing : html`<button
        class="shot__gen"
        ?disabled=${!(this.model.props.action ?? '').trim()}
        title=${(this.model.props.action ?? '').trim()
          ? 'Generate a take of this shot — it is added beside the others, never over them'
          : 'Write what happens in this shot first — a model has to be told what to film'}
        @click=${(e: Event) => { e.stopPropagation(); this.requestGenerate(); }}
      >▶ Generate</button>`}
      ${warnings.length
        ? html`<span class="shot__warn" title=${warnings.map(w => w.message).join('\n\n')}>
            ⚠ ${warnings.length}
          </span>`
        : nothing}
    </div>`;
  }

  /**
   * WHAT THIS SHOT HAS ACTUALLY PRODUCED.
   *
   * Hidden entirely until there is something to show. An empty row labelled
   * TAKES on every card of a fresh board would be sixty pixels of furniture
   * answering a question nobody has asked yet — and the card has no sixty
   * pixels to spare.
   *
   * ── WHAT A CLICK DOES, AND WHY IT CHANGED ────────────────────────────────
   * It used to choose the take, and nothing on the card could show you one. So
   * the row asked "which of these five?" while offering no way to see any of
   * them at more than 104 pixels — you picked by squinting at a poster, and the
   * only way to actually WATCH a take was to drag it out onto the canvas.
   *
   * A click now OPENS it, which is exactly what a click on a reference tile does
   * three rows above. One rule for every picture on the card: click to look at
   * it, and the corner buttons do things to it. The tick moved into a corner
   * button of its own, beside the ✕ that was already there, and the viewer
   * offers the same choice again with the take full-size in front of you — which
   * is where the decision is actually made.
   *
   * A running or failed take has nothing to open, so its click still falls
   * through to `chooseTake`, which refuses it. A spinner is a no-op, as before.
   */
  private renderTakes() {
    const takes = this.model.props.takes ?? [];
    if (!takes.length) return nothing;

    const chosen = chosenTake(takes, this.model.props.chosenTakeId ?? '');
    const ready = takes.filter(t => t.status === 'ready').length;

    return html`<div class="takes">
      <div class="lane__head">
        <span class="lane__label">TAKES</span>
        <!--
          SAYS WHAT WILL HAPPEN, because the tick is easy to misread.

          EVERY ready take goes to the editor, stacked at the same moment on its
          own track. The tick only says which one PLAYS; the rest sit above it,
          muted, ready to cut to. Nothing is thrown away by not being ticked —
          discarding is the ✕, and it is a separate, deliberate act.
        -->
        <span
          class="lane__count"
          title=${ready
            ? `All ${ready} ready take${ready > 1 ? 's' : ''} go to the editor, lined up at `
              + 'this moment. The ticked one plays; the others stack above it to cut to.'
            : 'Nothing finished yet.'}
        >${ready ? `${ready} ready` : `${takes.length}`}</span>
      </div>
      <div class="takes__strip" @wheel=${this.onLaneWheel}>
        ${repeat(takes, t => t.id, (t, i) => {
          const on = chosen?.id === t.id;
          /**
           * THE POSTER, AND ONLY THE POSTER.
           *
           * This was `t.poster || t.src`, and `src` on a video take is the
           * CLIP. Every take without a still therefore handed an .mp4 to an
           * `<img>`: the browser downloaded the whole file, failed to decode it,
           * and drew nothing. Nine takes on a card was nine video downloads for
           * nine blank tiles, and a board of fifty shots was a stall with no
           * visible cause. `src` is a legitimate thumbnail only when the take IS
           * a picture, which is exactly what `kind` says.
           */
          const thumb = takeThumb(t);
          return html`<button
            class="take ${on ? 'is-on' : ''} ${t.status === 'failed' ? 'take--failed' : ''}"
            data-drag-take=${t.id}
            title=${t.status === 'failed'
              ? `Take ${i + 1} failed — ${t.error || 'no reason given'}`
              : t.status === 'running'
                /**
                 * SAY WHY THERE IS NO STOP BUTTON.
                 *
                 * Only a render on your own machine can be stopped: a cloud
                 * generation is already paid for and the provider has no
                 * cancel. A card that simply omits the control on some takes
                 * and not others reads as a bug, so the tooltip names the
                 * reason — and distinguishes "cannot" from "cannot any more",
                 * which is what a reloaded tab is really saying.
                 */
                ? takeProgress(t.id)?.cancellable
                  ? `Take ${i + 1} is generating on your machine — ■ stops it`
                  : t.runtime === 'local'
                    ? `Take ${i + 1} was rendering on your machine and this board no longer has a handle for it, so it cannot be stopped or finished. Discard it with ✕ and generate again; if it completed, the clip is in your Library.`
                    : `Take ${i + 1} is generating in the cloud. Cloud renders cannot be stopped — it will finish on its own and land in your Library.`
                : `Click to watch it full size.${on
                    ? ' This is the one that plays on the timeline; the others stack above it.'
                    : ' It goes to the editor either way — ✓ makes it the one that plays.'
                  }${t.model ? ` · ${t.model}` : ''}`}
            @pointerdown=${(e: Event) => e.stopPropagation()}
            @click=${(e: Event) => { e.stopPropagation(); this.openTake(t); }}
          >
            <!--
              A film is hundreds of shots and thousands of takes, so off screen
              must cost NOTHING: loading=lazy means the browser makes no request
              at all until the strip scrolls the tile into view, and
              decoding=async keeps the decode off the frame the canvas is
              painting. draggable=false because the tile's own drag is
              registered on the BUTTON (see syncTileDrags), and a nested native
              image drag would race it.
            -->
            ${thumb
              ? html`<img
                  class="take__thumb"
                  src=${withToken(thumb)}
                  alt=""
                  draggable="false"
                  loading="lazy"
                  decoding="async"
                />`
              : nothing}
            ${
              /**
               * THE TICK IS NOW A BUTTON, and it is drawn on every ready take
               * rather than only on the chosen one.
               *
               * Choosing used to be the tile's own click, so it needed no
               * control and the ✓ was pure indication. Now that a click opens
               * the take, the choice needs somewhere to live — and a control
               * that appears only once it has already been used cannot be the
               * way you use it. Filled and always visible on the chosen take
               * (this is the row's whole answer, and it must not depend on
               * hover); outlined and hover-revealed on the others, like the ✕.
               */
              t.status === 'ready'
                ? html`<span
                    class="take__tick ${on ? 'is-on' : ''}"
                    role="button"
                    title=${on
                      ? 'This take plays on the timeline.'
                      : 'Make this the take that plays. The others still go to the editor, stacked above it.'}
                    @pointerdown=${(e: Event) => e.stopPropagation()}
                    @click=${(e: Event) => { e.stopPropagation(); this.pickTake(t.id); }}
                  >✓</span>`
                : nothing
            }
            ${t.status === 'ready'
              ? nothing
              : html`<span class="take__state">${t.status === 'running'
                  ? (takeProgress(t.id)?.label || 'generating…')
                  : (t.error || 'failed')}</span>`}
            ${
              /**
               * STOP, WHERE THE TAKE WAS STARTED.
               *
               * Only for a take the page can actually stop — see
               * `take-progress.ts`. A reloaded tab has lost the job handle, so
               * the control correctly disappears rather than becoming a button
               * that reports failure every time it is pressed.
               *
               * `pointerdown` is stopped as well as `click`, like the ✕ beside
               * it: without that the press starts a take DRAG and the click
               * never lands, so the button looks dead while the card follows
               * the cursor.
               */
              t.status === 'running' && takeProgress(t.id)?.cancellable
                ? html`<span
                    class="take__stop"
                    role="button"
                    title="Stop this render. It frees the GPU straight away; nothing else queued is affected."
                    @pointerdown=${(e: Event) => e.stopPropagation()}
                    @click=${(e: Event) => { e.stopPropagation(); this.stopTake(t.id); }}
                  >■</span>`
                : nothing
            }
            <span class="take__n">${t.label || `Take ${i + 1}`}${
              t.durationSec ? ` · ${Math.round(t.durationSec)}s` : ''}</span>
            <span
              class="take__x"
              role="button"
              title="Discard this take — it stops going to the editor. The file stays in your Library."
              @pointerdown=${(e: Event) => e.stopPropagation()}
              @click=${(e: Event) => { e.stopPropagation(); this.dropTake(t.id); }}
            >✕</span>
          </button>`;
        })}
      </div>
    </div>`;
  }

  /**
   * Ask the HOST PAGE to generate this shot.
   *
   * The card raises intent; the page owns the network — the same split as
   * `draft-save`, and for the same reason: an iframe has no credentials, no
   * credit balance, and no `useStudioMediaGenerator`. The page reads the inputs
   * back through `board-shot-gen-input` and records the result as a take
   * through `board-add-take` / `board-update-take`.
   *
   * Nothing is written here, deliberately. A card that optimistically created
   * its own placeholder take would leave one stranded whenever the page refused
   * — no credits, no model, the tab closed mid-flight — and a take that never
   * resolves is indistinguishable from a broken generator.
   */
  private requestGenerate(): void {
    window.parent?.postMessage(
      { type: 'voidspace:shot-generate', shotId: this.model.id },
      '*',
    );
  }

  /**
   * Ask the host page to stop a running take.
   *
   * Same split as `requestGenerate`, and it has to be: the job lives on the
   * user's node, reached through a session this iframe does not have. Nothing is
   * written here either — the page's poll loop sees the node report `cancelled`
   * and marks the take through the ordinary `board-update-take` path, so there
   * stays exactly ONE writer for a take's status.
   *
   * The optimistic part is only the label, and only until the next poll.
   */
  private stopTake(takeId: string): void {
    setTakeProgress(takeId, { label: 'stopping…' });
    window.parent?.postMessage(
      { type: 'voidspace:take-cancel', shotId: this.model.id, takeId },
      '*',
    );
  }

  private pickTake(takeId: string): void {
    chooseTake(this.std, this.model.id, takeId);
  }

  /**
   * Watch a take, full size.
   *
   * Only a FINISHED one has anything to show — a running take is a poster that
   * does not exist yet and a failed one is a sentence. Both fall through to
   * `pickTake`, which refuses them, so the click is a no-op rather than an empty
   * dialog. Same rule `syncTileDrags` uses for what may be dragged.
   */
  private openTake(t: ShotTake): void {
    if (t.status !== 'ready' || !(t.src || t.url)) {
      this.pickTake(t.id);
      return;
    }
    this.openMedia(takeAsMedia(t), 'takes');
  }

  private dropTake(takeId: string): void {
    removeTake(this.std, this.model.id, takeId);
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
