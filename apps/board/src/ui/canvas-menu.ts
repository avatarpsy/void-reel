/**
 * Right-click on the canvas: make something from what is selected.
 *
 * ── WHY THIS IS THE MISSING PIECE, AND ONLY THIS ─────────────────────────────
 * The whole generation chain already exists and is reused verbatim: the parent
 * page owns `useStudioMediaGenerator` (model choice, credits, idempotency,
 * `mirrorToLibrary`), `voidspace:board-selection` resolves canvas ids to
 * full-quality urls without those urls ever reaching a model, and
 * `voidspace:board-insert-media` puts the result back on the canvas with its
 * prompt and references recorded. All of it was reachable ONLY by asking the
 * agent in words.
 *
 * So this file adds no generation. It adds the sentence "these four, make me an
 * image" as a gesture — select, right-click, choose — and hands it to the page
 * that already knows how to answer it.
 *
 * ── WHY THE MENU LIVES IN THE IFRAME ─────────────────────────────────────────
 * The gesture happens on the canvas, and the canvas is in here. A menu drawn by
 * the parent would have to be positioned from a coordinate posted across the
 * frame boundary, would be clipped by the iframe's own box, and would lag the
 * click by a round trip. What crosses the boundary is the DECISION, once.
 *
 * ── WHY IT IS PLAIN DOM ──────────────────────────────────────────────────────
 * Same reason as `board-ui.ts`: chrome that sits over the editor, owns no
 * document state, and must not join BlockSuite's render cycle.
 */
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';

import { readCanvas } from '../board/canvas';
import type { MountedBoard } from '../blocksuite/editor';

/** What the user can ask for, and what to call it. */
const KINDS = [
  { kind: 'image', label: 'Image', hint: 'a still — a frame, a character, a look' },
  { kind: 'video', label: 'Video', hint: 'a clip, from these as reference' },
  { kind: 'audio', label: 'Music or voice', hint: 'a track, a bed, a narration' },
] as const;

const ICONS: Record<string, string> = {
  image: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6"/><circle cx="5.6" cy="6.4" r="1.1"/><path d="M2.4 11.6 6 8.4l2.6 2.2L11 8.6l2.6 2.6"/></svg>',
  video: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.8" y="3.4" width="9" height="9.2" rx="1.6"/><path d="m11.4 8 2.9-2.1v6.2L11.4 10z"/></svg>',
  audio: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6 12.2V4.4l7-1.5v7.6"/><circle cx="4.3" cy="12.4" r="1.7"/><circle cx="11.3" cy="10.9" r="1.7"/></svg>',
};

/**
 * Which of the selected blocks can actually be a reference.
 *
 * Images and clips only. A note, a shape or an arrow cannot be handed to an
 * image model, and counting them would tell the user "4 references" and then
 * generate from two.
 */
function selectedImages(board: MountedBoard): string[] {
  return readCanvas(board.std, true)
    // IMAGES ONLY. `media` is an attachment — a clip or a track — and every
    // generator that takes references takes pictures. Counting a video would
    // promise three references and send two.
    .filter(i => i.kind === 'image')
    .map(i => i.id);
}

/**
 * WHICH SET THE USER MEANT.
 *
 * ── WHY THIS DOES NOT READ THE LIVE SELECTION ────────────────────────────────
 * BlockSuite treats the press that opens a context menu as an ordinary
 * selecting press, so by the time anything can respond the selection has
 * collapsed to the single card under the cursor. Two previous attempts tried to
 * win that race — read it earlier, snapshot it on pointer-down — and both lost,
 * silently, in the same way: "Generate from 1 reference" over a selection of
 * four.
 *
 * So this does not race it. A multi-selection is REMEMBERED at the moment the
 * user builds it — shift-clicking, or finishing a marquee — which is long
 * before any right-click, and nothing that happens afterwards can un-remember
 * it except the user deliberately selecting something else.
 *
 * @param remembered the last selection of two or more, or []
 * @param clicked    the block under the cursor, or '' for empty canvas
 * @param live       the selection right now, after any collapse
 */
export function chooseReferences(remembered: string[], clicked: string, live: string[]): string[] {
  // Right-clicking inside what you selected acts on all of it; right-clicking
  // outside it acts on the one thing — the rule every file manager uses. Empty
  // canvas keeps it too: a marquee then a click in the gap between the images
  // is still "these".
  if (remembered.length > 1 && (!clicked || remembered.includes(clicked))) return [...remembered];
  return [...live];
}

export function installCanvasMenu(board: MountedBoard, container: HTMLElement): () => void {
  const menu = document.createElement('div');
  menu.className = 'vs-canvas-menu';
  menu.hidden = true;
  container.append(menu);

  let refIds: string[] = [];

  /**
   * THE LAST SELECTION OF TWO OR MORE, remembered when the user built it.
   *
   * Not read at right-click time and not snapshotted on the press — see
   * `chooseReferences` for why both of those lose. It is recorded by the
   * subscription below the moment a multi-selection exists, which is while the
   * user is shift-clicking or finishing a marquee, and it survives the collapse
   * that the right-click causes because that collapse never writes to it.
   */
  let remembered: string[] = [];

  const close = () => {
    if (menu.hidden) return;
    menu.hidden = true;
    refIds = [];
  };

  /**
   * A LEFT press is how you change your mind; a RIGHT press never is.
   *
   * This is the only thing that forgets a remembered selection, and it has to
   * exist: without it, multi-selecting once would keep those four references
   * alive under every later right-click, including on something else entirely.
   * Clearing here rather than on any selection change is what keeps the
   * right-click's own collapse from erasing the answer.
   */
  const onPointerDown = (e: PointerEvent) => {
    if (e.button === 0) remembered = [];
  };

  /**
   * Draw the menu for what is under the cursor.
   *
   * Two states, and the difference is the whole affordance: with media selected
   * it says what it will use, and without it offers the same three plus the
   * library — because right-clicking empty canvas to add a picture is the other
   * half of the same intention.
   */
  function render(count: number): string {
    const head = count
      ? `<div class="vs-canvas-menu__head">Generate from ${count} image${count === 1 ? '' : 's'}</div>`
      : '<div class="vs-canvas-menu__head">Add media to the board</div>';
    const rows = KINDS.map(k => `
      <button type="button" class="vs-canvas-menu__item" data-kind="${k.kind}">
        <span class="vs-canvas-menu__icon">${ICONS[k.kind]}</span>
        <span class="vs-canvas-menu__label">${k.label}</span>
        <span class="vs-canvas-menu__hint">${k.hint}</span>
      </button>`).join('');
    // Audio takes no visual reference, and saying so beats letting someone
    // select four stills and wonder why the track ignored them.
    const note = count
      ? '<div class="vs-canvas-menu__note">Images only — music and voice ignore them.</div>'
      : '<div class="vs-canvas-menu__note">Opens your library, web search and upload too.</div>';
    return head + rows + note;
  }

  const onContextMenu = (e: MouseEvent) => {
    // Our own chrome — the asset panel, the toolbar, the inspector — keeps the
    // browser's menu. This is the CANVAS gesture only.
    const target = e.target as HTMLElement | null;
    if (target?.closest('.vs-assets, .vs-board-bar, .vs-media-inspector, .vs-canvas-menu')) return;
    // Inside a note or a card title the user is editing text, and a right-click
    // there wants spellcheck and paste, not a generation menu.
    if (target?.isContentEditable || target?.closest('input, textarea, [contenteditable="true"]')) return;

    e.preventDefault();

    /**
     * WHICH SET THE USER MEANT — the same rule a file manager uses.
     *
     * Right-click something that is part of the current selection and the whole
     * selection is what you acted on; right-click outside it and the selection
     * becomes that one thing. Anything else surprises: the first case is how
     * "these four" is expressed, and the second is how you change your mind.
     *
     * `preClick` is the selection as it was a moment ago (see above). The block
     * under the cursor decides which of the two readings applies — and a
     * right-click on empty canvas keeps the selection too, because a marquee
     * followed by a right-click in the gap between the images is still "these".
     */
    const clickedId = target?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId ?? '';
    refIds = chooseReferences(remembered, clickedId, selectedImages(board));
    menu.innerHTML = render(refIds.length);

    // Positioned against the viewport and nudged back inside it, so a
    // right-click near the bottom-right corner does not open a menu that is
    // half off screen — which on an infinite canvas is most of the edges.
    menu.hidden = false;
    const box = menu.getBoundingClientRect();
    const x = Math.min(e.clientX, window.innerWidth - box.width - 8);
    const y = Math.min(e.clientY, window.innerHeight - box.height - 8);
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
  };

  const onMenuClick = (e: MouseEvent) => {
    const kind = (e.target as HTMLElement).closest<HTMLElement>('[data-kind]')?.dataset.kind;
    if (!kind) return;
    /**
     * The decision crosses the boundary; nothing else does.
     *
     * Ids, not urls — resolving them is `voidspace:board-selection`'s job on the
     * page side, and it exists precisely so a signed Library url never travels
     * further than it must. Audio carries none: it takes no visual reference.
     */
    window.parent?.postMessage({
      type: 'voidspace:board-generate-request',
      kind,
      ids: kind === 'audio' ? [] : refIds,
    }, '*');
    close();
  };

  // Any click, scroll, pan or Escape dismisses it. A canvas menu that outlives
  // the gesture ends up floating over a board the user has since moved.
  const onDocDown = (e: MouseEvent) => {
    if (!(e.target as HTMLElement)?.closest('.vs-canvas-menu')) close();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };

  // CAPTURE phase, and before the contextmenu listener below: this has to see
  // the selection while it is still the user's, not after BlockSuite has
  // collapsed it to whatever is under the cursor.
  container.addEventListener('pointerdown', onPointerDown, true);
  container.addEventListener('contextmenu', onContextMenu);
  menu.addEventListener('click', onMenuClick);
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('keydown', onKey);
  window.addEventListener('blur', close);
  container.addEventListener('wheel', close, { passive: true });

  /**
   * Remember a multi-selection, never a smaller one.
   *
   * The `> 1` guard is the whole fix. An earlier version of this subscription
   * wrote the selection unconditionally, so the right-click's own collapse to a
   * single card overwrote the very answer it was meant to preserve — the
   * snapshot taken a moment earlier was correct and this erased it.
   */
  const gfx = board.std.get(GfxControllerIdentifier);
  const sub = gfx.selection.slots.updated.subscribe(() => {
    const ids = selectedImages(board);
    if (ids.length > 1) remembered = ids;
  });

  return () => {
    container.removeEventListener('pointerdown', onPointerDown, true);
    container.removeEventListener('contextmenu', onContextMenu);
    menu.removeEventListener('click', onMenuClick);
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', close);
    container.removeEventListener('wheel', close);
    sub.unsubscribe?.();
    menu.remove();
  };
}
