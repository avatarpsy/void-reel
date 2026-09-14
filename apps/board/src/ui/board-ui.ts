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
 * specific to a BOARD and has no native equivalent — framing the work, reading
 * it as a document, and sending a storyboard on to the editor.
 *
 * THE EMPTY STATE IS THE MOST IMPORTANT PART. A blank infinite canvas tells a
 * first-time user nothing — not what it is for, not that the agent can fill it,
 * not that a storyboard is one of the things it can become. It is the difference
 * between "this is broken" and "oh, I talk to it". It also holds the only
 * hand-operated way to a first shot, now that the toolbar has none.
 */
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';

import { estimateShotCredits, onModelCatalogue, plannedSeconds } from '../shot/models';
import { createShots, readShots } from '../shot/shots';
import { installBoardFullscreen, installChromeAutohide } from './chrome-autohide';
import { fitBoard } from './viewport';
import type { MountedBoard } from '../blocksuite/editor';

const ICONS = {
  plus: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>',
  fit: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"/></svg>',
  expand: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2H14v4.5M6.5 14H2V9.5M14 2l-5 5M2 14l5-5"/></svg>',
  collapse: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 6.5H9V2M2.5 9.5H7V14M9 6.5l5-5M7 9.5l-5 5"/></svg>',
  undo: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h7a3 3 0 0 1 0 6H7"/><path d="M6 5 3 8l3 3"/></svg>',
  redo: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8H6a3 3 0 0 0 0 6h3"/><path d="M10 5l3 3-3 3"/></svg>',
  // An arrow INTO a frame: the storyboard going somewhere, not a file being
  // exported. Deliberately not a download glyph — nothing leaves the machine.
  send: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8h8"/><path d="M7 5l3 3-3 3"/><path d="M11.5 2.5H14v11h-2.5"/></svg>',
  // A page with lines on it. This is the export for everything that is not a
  // film, so it must not look like the storyboard's arrow.
  doc: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h5L12.5 5v9.5h-8.5z"/><path d="M9 1.5V5h3.5"/><path d="M6 8.5h4M6 11h3"/></svg>',
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
  // Keep the empty state to one decision: start thinking here, or start a film.
  // The toolbar and contextual controls teach themselves once there is work on
  // the canvas; duplicating their entire manual here buried the invitation.
  empty.innerHTML = `
    <div class="vs-board-empty__card">
      <h2>Start thinking out loud</h2>
      <p>
        Tell the agent what is on your mind. It will turn the conversation into notes,
        diagrams and references you can move around and make sense of.
      </p>

      <div class="vs-board-guide">
        <p class="vs-board-guide__lead">
          Use the toolbar to add your own. Making a video? Start a storyboard.
        </p>
        <p class="vs-board-guide__lead">
          <button type="button" class="vs-board-btn" data-act="first-shot">
            ${ICONS.plus}<span>Start a storyboard</span>
          </button>
        </p>
      </div>
    </div>`;

  // ── Toolbar ───────────────────────────────────────────────────────────────
  // TOP-CENTRE, and deliberately small. AFFiNE's native toolbar owns the drawing
  // tools (bottom-centre) and its zoom control owns zoom (bottom-left); this bar
  // carries only what is specific to a STORYBOARD and has no native equivalent.
  const bar = el<HTMLDivElement>('div', 'vs-board-bar');
  bar.innerHTML = `
    <!--
      NO "ADD SHOT" HERE.

      A shot is not the board's default act. Most boards are thinking — notes,
      diagrams, research — and a primary button minting scene cards put the one
      thing SOME boards want at the front of every board, before the user has
      said they are making a film.

      There are still two ways to a first shot, and both are in context: the
      empty state's "Start a storyboard" (data-act="first-shot", the same
      handler), and asking the agent. Once a filmstrip exists the row itself is
      where a shot gets added, which is where the hand already is.
    -->
    <button type="button" class="vs-board-btn vs-board-icon" data-act="undo" title="Undo (Ctrl+Z)">${ICONS.undo}</button>
    <button type="button" class="vs-board-btn vs-board-icon" data-act="redo" title="Redo (Ctrl+Shift+Z)">${ICONS.redo}</button>
    <span class="vs-board-sep"></span>
    <button type="button" class="vs-board-btn" data-act="fit" title="Frame the whole storyboard">
      ${ICONS.fit}<span>Fit</span>
    </button>
    <button type="button" class="vs-board-btn vs-board-icon" data-act="focus" title="Focus mode — fill the screen (Esc to leave)">${ICONS.expand}</button>
    <!--
      THE WAY OUT FOR WORK THAT IS NOT A FILM.

      "Send to editor" is the exit for a storyboard and it appears only when
      shots exist — so for everything else the board had NO exit at all, and an
      afternoon of planning or research ended as pixels the user had to retype
      somewhere else. This one is always here, because thinking is what the
      board is always doing.

      It opens the page rather than downloading anything: the order comes from
      where things sit on an infinite canvas, so the first thing anybody wants
      is to check it read their board the way they meant it.
    -->
    <button type="button" class="vs-board-btn" data-act="document" title="Read the board as a document — export PDF or .md">
      ${ICONS.doc}<span>Document</span>
    </button>
    <span class="vs-board-sep"></span>
    <div class="vs-board-total" data-total hidden></div>
    <!--
      THE WAY OUT OF THE BOARD, and until now there was not one.

      Compile has been reachable ONLY by asking the agent for it — a feature with
      no control, on the surface whose entire purpose is to become a video. The
      cost line to the left of this is introduced in code as answering "the
      question people actually ask before they hit compile", and there was
      nothing to hit.

      CALLED "SEND TO EDITOR", NOT "COMPILE". Compile is what it does; sending is
      what it means. The distinction matters because the operation is ADDITIVE —
      it creates the project the first time and afterwards adds new shots, new
      takes and changed text without reordering or removing anything. A button
      labelled "Compile" reads like a one-way, final act, which is exactly the
      belief that stops people pressing it early and often.
    -->
    <button type="button" class="vs-board-btn vs-board-btn--send" data-act="send" hidden>
      ${ICONS.send}<span data-send-label>Send to editor</span>
    </button>
    <!--
      WHAT THE SELECTION IS FOR.

      Selecting a few references and asking the agent to generate from them is
      the board's central loop — and it was completely invisible. A selection
      looks the same whether or not anything can be done with it, so the feature
      existed and nobody would ever have found it.

      A line in the bar that is already there, rather than a floating toolbar
      over the canvas: it appears in one place the eye already goes, it cannot
      cover the thing being selected, and it costs no new layer. Shown only when
      the selection actually CONTAINS media, because that is the only case where
      the sentence is true.
    -->
    <div class="vs-board-sel" data-sel hidden></div>`;

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

  /**
   * THE SEND BUTTON'S STATE, and each of the four says something the user needs.
   *
   * Hidden with no shots — a board being thought on has nothing to send, and a
   * disabled button on an empty canvas is a question with no answer.
   *
   * Once a project exists the label carries its NAME, because a board can be
   * sent more than once and "where did my shots go" is otherwise a real
   * question the banner alone does not answer at the moment of pressing.
   *
   * Busy is set by the PAGE, not here: the render-and-compile happens over
   * there, and a button that reset itself on a timer would go back to "Send to
   * editor" halfway through a render and invite a second press.
   */
  const sendBtn = bar.querySelector<HTMLButtonElement>('[data-act="send"]')!;
  const sendLabel = sendBtn.querySelector<HTMLElement>('[data-send-label]')!;
  let sentProject = '';

  function syncSend() {
    const n = shotCount();
    sendBtn.hidden = n === 0;
    if (sendBtn.hasAttribute('data-busy')) return;
    sendLabel.textContent = sentProject ? 'Send changes' : 'Send to editor';
    sendBtn.title = sentProject
      ? 'Send what has changed to the project this board already made. It ADDS new shots, '
        + 'takes and text — it never reorders or removes anything you have cut.'
      : 'Build a video project from this storyboard and open it in the editor. '
        + 'The board stays yours to keep editing.';
  }

  /**
   * The page tells the board what it is doing, and the board draws it.
   *
   * One-way on purpose. The board cannot know whether a render is running, how
   * many graphics are left, or which project it landed in — all of that lives
   * where the network is.
   */
  const onParentMessage = (e: MessageEvent) => {
    const data = e.data as { type?: string; busy?: boolean; label?: string; projectId?: string };
    if (data?.type !== 'voidspace:board-send-state') return;
    if (data.busy) {
      sendBtn.setAttribute('data-busy', '1');
      sendLabel.textContent = data.label || 'Sending…';
      sendBtn.title = 'Working — this renders your graphics on this computer first.';
    } else {
      sendBtn.removeAttribute('data-busy');
      if (typeof data.projectId === 'string' && data.projectId) sentProject = data.projectId;
      syncSend();
    }
  };
  window.addEventListener('message', onParentMessage);

  function addShot() {
    /**
     * NAMED FOR WHAT IT IS — a shot, not a scene.
     *
     * It read `SCENE 4 — untitled`, which was wrong twice. A scene belongs to
     * the SCREENPLAY and several shots share one, so minting a scene per card
     * asserted a structure nobody had written; and the card's own badge said
     * "SCENE 4" beside a pill saying which scene it actually covered, giving two
     * different numbers the same name.
     *
     * `— untitled` is gone with it. It was there to signal "rename me" and does
     * the opposite: it fills the field, so the placeholder ("Name this shot…")
     * never shows and the words have to be deleted before they can be replaced.
     * The number alone is a name a person is happy to keep or happy to type
     * over.
     */
    createShots(board.std, board.surfaceId, [`Shot ${shotCount() + 1}`]);
    requestAnimationFrame(() => fitBoard());
  }

  // ── Chrome that gets out of the way ───────────────────────────────────────
  // Both bars fade until the pointer reaches for them; see `chrome-autohide.ts`
  // for why proximity is measured rather than done with a CSS hover strip.
  const chrome = installChromeAutohide(container);
  const fullscreen = installBoardFullscreen();

  const focusBtn = bar.querySelector<HTMLElement>('[data-act="focus"]')!;
  const stopFullscreenWatch = fullscreen.onChange((on) => {
    focusBtn.innerHTML = on ? ICONS.collapse : ICONS.expand;
    focusBtn.title = on
      ? 'Leave focus mode (Esc)'
      : 'Focus mode — fill the screen (Esc to leave)';
    // Entering fullscreen is a deliberate "show me the work" gesture, so the
    // chrome should not be the first thing on screen. Leaving it is a return to
    // the page, where the bar is where the user last saw it.
    chrome.reveal();
  });

  const onClick = (e: MouseEvent) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    switch (act) {
      // Only the empty state raises this now — the toolbar button is gone.
      case 'first-shot': addShot(); break;
      case 'undo': board.store.undo(); break;
      case 'redo': board.store.redo(); break;
      case 'fit': fitBoard(); break;
      case 'focus': void fullscreen.toggle(); break;
      // The overlay owns itself; the bar only raises the intent — same
      // arrangement the screenplay card's Focus button uses.
      case 'document':
        container.dispatchEvent(new CustomEvent('voidspace-open-document', { bubbles: true }));
        break;
      /**
       * The card raises intent; the PAGE owns the network.
       *
       * Same split as Generate on a shot card, and it has to be: an iframe has
       * no credentials and no credit balance, and compiling renders the
       * graphics and writes a project. The board's only job is to say that the
       * user asked.
       */
      case 'send':
        if (sendBtn.hasAttribute('data-busy')) return;
        window.parent?.postMessage({ type: 'voidspace:board-send' }, '*');
        break;
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
    /**
     * DRAWING IS CONTENT TOO — and it is not a child.
     *
     * `children` holds BLOCKS parented to the surface. Everything drawn on the
     * canvas — brush strokes, shapes, connectors, canvas text, mind maps — is a
     * canvas ELEMENT, kept in the surface's `elements` map instead, so a board
     * someone had been drawing on for ten minutes still read as empty. The card
     * takes pointer events, so it sat in the middle of the canvas swallowing
     * every click and stroke that landed on it: the same failure the note above
     * describes for dropped images, in the one place a pen user starts.
     */
    if (((surface as { elementModels?: unknown[] } | undefined)?.elementModels?.length ?? 0) > 0) return true;
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
    // An empty board has nothing to look at, so there is nothing for the
    // chrome to be in the way OF — and hiding the toolbar behind a hover is
    // how a first-time user concludes the board cannot do anything.
    chrome.setPinned(!has);
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
    requestAnimationFrame(() => { totalQueued = false; syncTotal(); syncSend(); });
  }

  /**
   * Tell the user what a selection of references is good for.
   *
   * Counts only MEDIA, because "3 selected" is not the point — "you can ask for
   * a new one made from these" is, and that is only true of pictures and clips.
   * A note and a shape selected together get no hint, correctly.
   */
  const selEl = bar.querySelector<HTMLElement>('[data-sel]')!;
  const gfx = board.std.get(GfxControllerIdentifier);
  const selectionSub = gfx.selection.slots.updated.subscribe(() => {
    const media = gfx.selection.selectedIds.filter(id => {
      const flavour = board.store.getBlock(id)?.flavour;
      return flavour === 'affine:image' || flavour === 'affine:attachment';
    });
    if (media.length < 1) { selEl.hidden = true; return; }
    selEl.textContent = media.length === 1
      ? '1 reference selected — ask the agent to generate from it'
      : `${media.length} references selected — ask the agent to generate from them`;
    selEl.hidden = false;
  });

  const sub = board.store.slots.blockUpdated.subscribe(e => {
    // Re-arm on a delete: the board can become empty again.
    if ((e as { type?: string })?.type === 'delete') hidden = false;
    sync();
    queueTotal();
  });
  sync();
  syncTotal();
  // AND THE SEND BUTTON, at mount, not only when something changes.
  //
  // It ships `hidden` in the markup — a board being thought on has nothing to
  // send — and `syncSend` is what reveals it once there are shots. Reached only
  // through `queueTotal` it would stay invisible on a board that OPENS with
  // shots and is then left alone, which is every board somebody comes back to:
  // the way out of the surface would appear only after an unrelated edit.
  syncSend();
  // The catalogue arrives after paint, and no model means no price — so the
  // first total would read "no gen cost" for a board full of clips until
  // something else happened to change.
  const stopModels = onModelCatalogue(() => queueTotal());

  return () => {
    sub.unsubscribe?.();
    selectionSub.unsubscribe?.();
    stopModels();
    stopFullscreenWatch();
    window.removeEventListener('message', onParentMessage);
    fullscreen.destroy();
    chrome.destroy();
    empty.remove();
    bar.remove();
  };
}
