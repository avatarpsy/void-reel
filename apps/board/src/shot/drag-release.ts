/**
 * FINISHING A DRAG THAT ENDS SOMEWHERE ELSE.
 *
 * ── THE BUG, AND IT IS THE ONE PEOPLE REPORT AS "IT SNAPS BACK" ──────────────
 * BlockSuite moves a block by STASHING `xywh`: while the pointer is down the
 * writes are local and never reach the document. The commit happens in the
 * interactivity manager's own `pointerup` handler
 * (`gfx/interactivity/manager.ts`), which is bound like this:
 *
 *     host.addEventListener('pointerup', onDragEnd, false)
 *
 * — on the EDITOR HOST, with no pointer capture. So a release anywhere else
 * never reaches it: the drag simply never ends. `pop('xywh')` is not called, the
 * position stays a local value nobody wrote down, and the next render puts the
 * card back where the document still says it is.
 *
 * That is not an edge case on this board. Our own chrome floats OVER the canvas
 * and is a SIBLING of the editor host, not a descendant — the asset panel down
 * the left, the toolbar across the top. Dragging a shot leftwards, which is how
 * you move it earlier in the film, ends over the panel. So does dragging one out
 * of the window. Measured: releasing at a point outside the host left the card's
 * position uncommitted and every extension's `onDragEnd` unfired.
 *
 * ── WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────
 * It does not reimplement the drag, take over the commit, or touch the document.
 * It delivers the event BlockSuite is already waiting for: when the real release
 * lands outside the host, one synthetic `pointerup` is dispatched ON the host,
 * carrying the real coordinates. The manager's own handler then runs exactly as
 * it would have, in the right order, and everything downstream — the pop, the
 * extension handlers, the reflow — happens once and normally.
 *
 * A release INSIDE the host is left completely alone: the manager will get it
 * itself, and dispatching a second one would end the drag twice.
 */
import type { BlockStdScope } from '@blocksuite/std';

/**
 * Arm the bridge for ONE drag. Returns a disposer, which the caller must run
 * from its `clear` handler — the manager calls that at the end of every drag,
 * cancelled or completed, which is exactly the lifetime this needs.
 */
export function relayOffHostRelease(std: BlockStdScope): () => void {
  const host = std.host as HTMLElement | null;
  if (!host || typeof window === 'undefined') return () => {};

  let done = false;
  const off = () => {
    if (done) return;
    done = true;
    window.removeEventListener('pointerup', onRelease, true);
    window.removeEventListener('pointercancel', onRelease, true);
  };

  function onRelease(e: PointerEvent): void {
    off();
    // Inside the host: the manager's own listener is about to fire. Adding to
    // it would run the whole end-of-drag sequence twice.
    if (host!.contains(e.target as Node | null)) return;

    /**
     * The coordinates are the REAL ones, not the host's edge. The manager
     * converts `event.x/y` into a model point to compute the drag delta, so
     * clamping them to the host would drop the card short of where the user let
     * go — a subtler version of the same complaint.
     *
     * `pointercancel` is relayed as a pointerup too: a cancelled drag still has
     * to be concluded, and concluding it where the pointer was is better than
     * leaving the block stashed forever.
     */
    host!.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: e.clientX,
      clientY: e.clientY,
      pointerId: e.pointerId,
      pointerType: e.pointerType || 'mouse',
      isPrimary: true,
    }));
  }

  // CAPTURE, so the release is seen before anything on the way down can stop
  // it — our own chrome stops plenty of events, and this must not depend on
  // which panel happens to be under the pointer.
  window.addEventListener('pointerup', onRelease, true);
  window.addEventListener('pointercancel', onRelease, true);
  return off;
}
