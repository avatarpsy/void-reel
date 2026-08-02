/**
 * The board's own chrome: an empty state and the storyboard actions.
 *
 * DELIBERATELY SMALL. An earlier draft of this file hand-built a whole toolbar
 * and turned AFFiNE's off, on the theory that a general whiteboard toolbar would
 * teach the wrong model of a storyboard surface. That was wrong in practice: it
 * left an artist with a canvas they could not draw, type, sketch or drop an
 * image onto — a viewer, not a board.
 *
 * AFFiNE's native toolbar is now registered (`extensions.view.ts`) and owns the
 * creative tools; its zoom control owns zoom. What survives here is only what is
 * specific to a STORYBOARD and has no native equivalent — adding a shot to the
 * filmstrip, and framing the whole strip.
 *
 * THE EMPTY STATE IS THE MOST IMPORTANT PART. A blank infinite canvas tells a
 * first-time user nothing — not what it is for, not that the agent can fill it,
 * not that they can add a shot themselves. It is the difference between "this is
 * broken" and "oh, I talk to it".
 */
import { estimateShotCredits, onModelCatalogue, plannedSeconds } from '../shot/models';
import { createShots, readShots } from '../shot/shots';
import { fitBoard } from './viewport';
import type { MountedBoard } from '../blocksuite/editor';

const ICONS = {
  plus: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>',
  fit: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"/></svg>',
  minus: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 8h9"/></svg>',
  undo: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h7a3 3 0 0 1 0 6H7"/><path d="M6 5 3 8l3 3"/></svg>',
  redo: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8H6a3 3 0 0 0 0 6h3"/><path d="M10 5l3 3-3 3"/></svg>',
};

function el<T extends HTMLElement>(tag: string, cls?: string, html?: string): T {
  const node = document.createElement(tag) as T;
  if (cls) node.className = cls;
  if (html !== undefined) node.innerHTML = html;
  return node;
}


/**
 * Mount the chrome. Returns a disposer.
 *
 * Plain DOM rather than Lit: this is chrome that sits OVER the editor, owns no
 * document state, and must not participate in BlockSuite's render cycle — the
 * simplest thing that cannot interfere with the canvas is the right thing.
 */
export function installBoardUi(board: MountedBoard, container: HTMLElement): () => void {
  const shotCount = () => readShots(board.std).length;

  // ── Empty state ───────────────────────────────────────────────────────────
  const empty = el<HTMLDivElement>('div', 'vs-board-empty');
  // The card doubles as the tutorial. A first-time user's question is not "what
  // is an infinite canvas" — it is "what am I supposed to DO here, and which of
  // these little icons does what". So it answers both, in place, once.
  empty.innerHTML = `
    <div class="vs-board-empty__card">
      <h2>Your board is empty</h2>
      <p>
        Describe the video you’re imagining in the chat — I’ll lay the shots out here
        as a filmstrip you can drag, rename and reorder. Or start one yourself.
      </p>
      <button type="button" class="vs-board-btn vs-board-btn--primary" data-act="first-shot">
        ${ICONS.plus}<span>Add your first shot</span>
      </button>

      <div class="vs-board-guide">
        <p class="vs-board-guide__lead">
          A <strong>shot</strong> is one scene. Drop media <strong>onto</strong> a shot and it joins
          that scene — stills, clips and audio each land in their own row, and you say what each one
          is for. Anything on the <strong>open canvas</strong> is yours to think with, and is never
          used in the video.
        </p>
        <p class="vs-board-guide__lead">
          A shot is either a <strong>video clip</strong> a model generates, or a
          <strong>graphic</strong> built from one of your HyperFrames blocks — a title card, a
          stat, a lower third. Graphics render on your own computer, cost nothing, and put the
          words on screen exactly as you wrote them.
        </p>
        <ul class="vs-board-guide__keys">
          <li><b>Drop on a shot</b><span>adds it to that scene · drop on a slot to set its role</span></li>
          <li><b>Toolbar below</b><span>sticky notes, pen, shapes, text, images, connectors</span></li>
          <li><b>Scroll</b><span>pan · over a row it scrolls the row · ⌘/Ctrl + scroll to zoom</span></li>
          <li><b>Ctrl + Z</b><span>undo — including anything the agent did</span></li>
        </ul>
      </div>
    </div>`;

  // ── Toolbar ───────────────────────────────────────────────────────────────
  // TOP-CENTRE, and deliberately small. AFFiNE's native toolbar owns the drawing
  // tools (bottom-centre) and its zoom control owns zoom (bottom-left); this bar
  // carries only what is specific to a STORYBOARD and has no native equivalent.
  const bar = el<HTMLDivElement>('div', 'vs-board-bar');
  bar.innerHTML = `
    <button type="button" class="vs-board-btn vs-board-btn--primary" data-act="add" title="Add a shot to the end of the filmstrip">
      ${ICONS.plus}<span>Add shot</span>
    </button>
    <span class="vs-board-sep"></span>
    <button type="button" class="vs-board-btn vs-board-icon" data-act="undo" title="Undo (Ctrl+Z)">${ICONS.undo}</button>
    <button type="button" class="vs-board-btn vs-board-icon" data-act="redo" title="Redo (Ctrl+Shift+Z)">${ICONS.redo}</button>
    <span class="vs-board-sep"></span>
    <button type="button" class="vs-board-btn" data-act="fit" title="Frame the whole storyboard">
      ${ICONS.fit}<span>Fit</span>
    </button>
    <span class="vs-board-sep"></span>
    <div class="vs-board-total" data-total hidden></div>`;

  container.append(empty, bar);

  /**
   * WHAT THIS BOARD WILL COST, before a single credit is spent.
   *
   * Per-shot estimates live on the cards, which answers "is this shot
   * expensive". This answers the question people actually ask before they hit
   * compile — "what am I about to spend on the whole thing" — and it is the one
   * number that is awkward to work out by hand once there are nine shots.
   *
   * APPROXIMATE, and it says so. Real cost depends on the length each model
   * snaps to and on retries, and a figure presented as exact would be a promise
   * we cannot keep. Shots whose model is not chosen yet are counted as unknown
   * and reported separately rather than as zero — "12 shots, ~180 cr" when four
   * of them have no model is a number that will move, and hiding that is worse
   * than admitting it.
   */
  const totalEl = bar.querySelector<HTMLElement>('[data-total]')!;
  function syncTotal() {
    const shots = readShots(board.std);
    if (!shots.length) { totalEl.hidden = true; return; }
    let credits = 0;
    let unknown = 0;
    let seconds = 0;
    for (const s of shots) {
      // The SAME rule the cost uses — see `plannedSeconds`.
      seconds += plannedSeconds(s);
      const c = estimateShotCredits(s);
      if (c === null) unknown++;
      else credits += c;
    }
    const runtime = seconds > 0
      ? (seconds >= 60
        ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
        : `${Math.round(seconds)}s`)
      : '';
    const bits = [`${shots.length} shot${shots.length === 1 ? '' : 's'}`];
    if (runtime) bits.push(runtime);
    bits.push(credits > 0 ? `~${Math.round(credits)} cr` : 'no gen cost');
    totalEl.textContent = bits.join(' · ');
    totalEl.title = unknown
      ? `${unknown} shot${unknown === 1 ? ' has' : 's have'} no model chosen yet, so ${unknown === 1 ? 'it is' : 'they are'} not in this figure. Approximate — the final cost depends on the length each model snaps to.`
      : 'Approximate — the final cost depends on the length each model snaps to.';
    totalEl.classList.toggle('is-partial', unknown > 0);
    totalEl.hidden = false;
  }

  function addShot() {
    // Titled by position so a new card is never a nameless box the user has to
    // guess at; they rename it in place, or ask the agent to.
    createShots(board.std, board.surfaceId, [`SCENE ${shotCount() + 1} — untitled`]);
    requestAnimationFrame(() => fitBoard());
  }

  const onClick = (e: MouseEvent) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    switch (act) {
      case 'add':
      case 'first-shot': addShot(); break;
      case 'undo': board.store.undo(); break;
      case 'redo': board.store.redo(); break;
      case 'fit': fitBoard(); break;
    }
  };
  empty.addEventListener('click', onClick);
  bar.addEventListener('click', onClick);

  /**
   * Keep the chrome honest.
   *
   * Driven by `blockUpdated` rather than a timer so it reacts to the AGENT's
   * edits too — the empty state must disappear the moment the agent drafts a
   * storyboard, not a second later.
   */
  /**
   * Hide the empty state as soon as there is ANY content, not just shots.
   *
   * It was gated on `shotCount > 0`, so a user who dropped reference images
   * before creating a shot — which is step 2 of the real flow (§24) — kept a
   * card sitting in the middle of the canvas. Its inner card takes pointer
   * events, so it silently swallowed clicks on anything beneath it: the
   * "selection doesn't work / no feedback" report.
   */
  function hasAnyContent(): boolean {
    if (shotCount() > 0) return true;
    const surface = board.store.getBlock(board.surfaceId)?.model;
    if ((surface?.children.length ?? 0) > 0) return true;
    // Root-level blocks are notes/images/text placed on the canvas.
    return (board.store.root?.children.length ?? 0) > 1;
  }

  /**
   * Once there is content the empty state is gone for good, so stop looking.
   *
   * `blockUpdated` fires on every pointermove of a drag; `hasAnyContent` walks
   * the surface's children each time. Cheap individually, wasteful thousands of
   * times a gesture, and it can only ever return true again after a delete —
   * which re-arms it below.
   */
  let hidden = false;
  function sync() {
    const has = hasAnyContent();
    if (has && hidden) return;
    hidden = has;
    empty.classList.toggle('is-hidden', has);
  }
  /**
   * The total is derived from every shot, so recomputing it on every
   * `blockUpdated` would walk the whole board on each pointermove of a drag.
   * Coalesced to one frame — the number is glanced at, not watched.
   */
  let totalQueued = false;
  function queueTotal() {
    if (totalQueued) return;
    totalQueued = true;
    requestAnimationFrame(() => { totalQueued = false; syncTotal(); });
  }

  const sub = board.store.slots.blockUpdated.subscribe(e => {
    // Re-arm on a delete: the board can become empty again.
    if ((e as { type?: string })?.type === 'delete') hidden = false;
    sync();
    queueTotal();
  });
  sync();
  syncTotal();
  // The catalogue arrives after paint, and no model means no price — so the
  // first total would read "no gen cost" for a board full of clips until
  // something else happened to change.
  const stopModels = onModelCatalogue(() => queueTotal());

  return () => {
    sub.unsubscribe?.();
    stopModels();
    empty.remove();
    bar.remove();
  };
}
