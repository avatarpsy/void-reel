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
function selectedMedia(board: MountedBoard): Array<{ id: string; kind: string }> {
  return readCanvas(board.std, true)
    .filter(i => i.kind === 'image' || i.kind === 'media')
    .map(i => ({ id: i.id, kind: i.kind }));
}

export function installCanvasMenu(board: MountedBoard, container: HTMLElement): () => void {
  const menu = document.createElement('div');
  menu.className = 'vs-canvas-menu';
  menu.hidden = true;
  container.append(menu);

  let refIds: string[] = [];

  const close = () => {
    if (menu.hidden) return;
    menu.hidden = true;
    refIds = [];
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
      ? `<div class="vs-canvas-menu__head">Generate from ${count} reference${count === 1 ? '' : 's'}</div>`
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
      ? '<div class="vs-canvas-menu__note">Music and voice ignore image references.</div>'
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
    const media = selectedMedia(board);
    refIds = media.map(m => m.id);
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

  container.addEventListener('contextmenu', onContextMenu);
  menu.addEventListener('click', onMenuClick);
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('keydown', onKey);
  window.addEventListener('blur', close);
  container.addEventListener('wheel', close, { passive: true });

  // A selection that changes under an open menu makes its "from 3 references"
  // a lie, so the menu goes rather than the count.
  const gfx = board.std.get(GfxControllerIdentifier);
  const sub = gfx.selection.slots.updated.subscribe(() => close());

  return () => {
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
