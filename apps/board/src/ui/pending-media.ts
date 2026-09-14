/**
 * "Something is being made, and it will land HERE."
 *
 * ── WHY A PLACEHOLDER AND NOT JUST A TOAST ───────────────────────────────────
 * A generation takes a minute or two. The user is looking at the canvas, not at
 * the chat, and the toast that already existed says only that something is
 * happening — not where. So they waited in front of an unchanged board, and
 * when the picture finally appeared they had to find it. A card in the spot the
 * result will occupy answers both questions at once, and it answers them for
 * the whole minute rather than at the end of it.
 *
 * ── IT IS NOT A BLOCK, DELIBERATELY ──────────────────────────────────────────
 * The obvious implementation is to insert a real block and swap its contents
 * when the file arrives. That is the wrong shape and the reason is recorded in
 * the music placeholder work: a spinner that never ends is an UNOWNED
 * placeholder. A block would sync to the user's other devices, take a slot in
 * undo history, and — if this tab closes mid-generation — survive as a
 * permanent grey card that nothing is coming to replace.
 *
 * So it is chrome, like the toast and the context menu: DOM over the canvas,
 * owned by this module, gone when the tab is. Nothing about a generation in
 * flight belongs in the document, because a generation in flight is not
 * content. What lands in the document is the result, once, through the normal
 * path.
 *
 * ── PINNED TO THE CANVAS, NOT TO THE SCREEN ──────────────────────────────────
 * It is positioned in MODEL coordinates and re-projected on every viewport
 * change, so it pans and zooms with the board. A placeholder that stayed put
 * while the canvas moved under it would be pointing at the wrong place — which
 * is worse than not pointing at all.
 */
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';

import { anchorFor } from '../board/canvas';
import { type Size, cardBox } from '../board/metrics';
import { SHOT_H } from '../shot/model';
import type { MountedBoard } from '../blocksuite/editor';

/**
 * WHAT A PLACEHOLDER OCCUPIES — the box the result will occupy, and nothing else.
 *
 * It used to be a fixed 300 × 400 (120 for audio) while an image landed at up to
 * 960 × 1707, so the card the user watched for a minute was replaced by one
 * THIRTEEN TIMES its area. The swap read as the board breaking rather than as
 * the picture arriving.
 *
 * So the size comes from `metrics.ts` — the same call the placement makes, with
 * the same arguments — and the aspect the generation ASKED FOR is passed in, so
 * a 9:16 job shows a 9:16 spinner. A placeholder that is not the shape of its
 * result is pointing at the wrong rectangle, which is the same failure as
 * pointing at the wrong place.
 */
function pendingBox(kind: 'image' | 'video' | 'audio', aspect?: string): Size {
  return cardBox(kind, parseAspect(aspect), 'hero');
}

/**
 * "16:9" → natural dimensions to fit. Null for anything unparseable, which
 * `cardBox` reads as "nothing has measured this yet" and answers with 16:9.
 */
function parseAspect(aspect?: string): Size | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$/.exec(aspect ?? '');
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : null;
}

interface Pending {
  id: string;
  kind: 'image' | 'video' | 'audio';
  x: number;
  y: number;
  w: number;
  h: number;
  el: HTMLElement;
  failed?: boolean;
}

const LABEL: Record<string, string> = {
  image: 'Making an image',
  video: 'Making a clip',
  audio: 'Making audio',
};

export interface PendingMediaApi {
  /** Draw one. `referenceIds` decides where — the same anchor the finished
   *  media will use, so the picture replaces the spinner in place — and `aspect`
   *  decides its shape, so the swap is not a visible resize either. */
  show(
    id: string,
    kind: 'image' | 'video' | 'audio',
    referenceIds: string[],
    aspect?: string,
  ): void;
  /** Take one away. Called on success AND on failure — see `fail`. */
  hide(id: string): void;
  /** Leave it on screen saying what went wrong, dismissable by click.
   *  A failure that simply removes the card looks like nothing happened. */
  fail(id: string, message: string): void;
  dispose(): void;
}

export function installPendingMedia(board: MountedBoard, container: HTMLElement): PendingMediaApi {
  const layer = document.createElement('div');
  layer.className = 'vs-pending-layer';
  container.append(layer);

  const items = new Map<string, Pending>();
  const gfx = board.std.get(GfxControllerIdentifier);

  /** Model → screen, for every card. Cheap: there are never many of these. */
  function project(): void {
    if (!items.size) return;
    const vp = gfx.viewport;
    for (const p of items.values()) {
      const [sx, sy] = vp.toViewCoord(p.x, p.y);
      p.el.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px)`;
      p.el.style.width = `${Math.round(p.w * vp.zoom)}px`;
      p.el.style.height = `${Math.round(p.h * vp.zoom)}px`;
    }
  }

  const sub = gfx.viewport.viewportUpdated.subscribe(() => project());

  function show(
    id: string,
    kind: 'image' | 'video' | 'audio',
    referenceIds: string[],
    aspect?: string,
  ): void {
    if (items.has(id)) return;
    /**
     * Beside the references when there are any, and otherwise in the same clear
     * space below the filmstrip that `board-insert-media` falls back to — so
     * the two agree about where a result with no references goes.
     */
    const at = anchorFor(board.std, referenceIds) ?? { x: 0, y: SHOT_H + 240 };
    const box = pendingBox(kind, aspect);

    const el = document.createElement('div');
    el.className = `vs-pending vs-pending--${kind}`;
    el.innerHTML = `
      <span class="vs-pending__spinner" aria-hidden="true"></span>
      <span class="vs-pending__label">${LABEL[kind] ?? 'Working'}…</span>`;
    // Not interactive while it is working: a click here should reach the canvas
    // underneath, not the sign that something is on its way.
    layer.append(el);

    items.set(id, { id, kind, x: at.x, y: at.y, w: box.w, h: box.h, el });
    project();
  }

  function hide(id: string): void {
    const p = items.get(id);
    if (!p) return;
    p.el.remove();
    items.delete(id);
  }

  function fail(id: string, message: string): void {
    const p = items.get(id);
    if (!p) return;
    p.failed = true;
    p.el.classList.add('is-failed');
    // The message is the point. "Generation failed" tells the user nothing they
    // could not see; the reason is what decides whether they retry or change
    // something first.
    p.el.innerHTML = `
      <span class="vs-pending__label">${message || 'That generation did not finish.'}</span>
      <span class="vs-pending__dismiss">Click to dismiss</span>`;
    p.el.style.pointerEvents = 'auto';
    p.el.addEventListener('click', () => hide(id), { once: true });
  }

  return {
    show,
    hide,
    fail,
    dispose() {
      sub.unsubscribe?.();
      items.clear();
      layer.remove();
    },
  };
}
