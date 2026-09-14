/**
 * Keep the canvas keyboard-live after the pen leaves the tablet.
 *
 * ── THE GESTURE THAT BROKE EVERY SHORTCUT ────────────────────────────────────
 * BlockSuite's `UIEventDispatcher` opens `run()` with `if (!this.active) return`,
 * and it drops `active` on `pointerleave` over the editor host unless something
 * inside the host holds focus:
 *
 *     addFromEvent(this.host, 'pointerleave', () => {
 *       if ((document.activeElement && this.host.contains(document.activeElement))
 *           || _dragging) return;
 *       this._setActive(false);
 *     });
 *
 * The canvas is a `<canvas>`. It takes no focus, so after drawing, the active
 * element is `<body>` — outside the host — and the guard does not hold.
 *
 * With a MOUSE this is nearly invisible: the cursor stays parked over the board
 * while you reach for the keyboard, so `pointerleave` never fires. With a PEN it
 * fires every single time, because lifting the pen away from the tablet takes
 * the pointer out of hover range and the browser reports it as leaving. So the
 * exact user who lives on Ctrl+Z — draw, judge, undo, draw again — is the one
 * for whom undo, redo, Delete, Escape and every arrow-key nudge silently stopped
 * working the moment they lifted the pen to press them.
 *
 * Measured, before and after, with the pen away and one stroke on the canvas:
 *
 *     no focus   → dispatcher active: false → Ctrl+Z leaves 1 element
 *     host focus → dispatcher active: true  → Ctrl+Z leaves 0
 *
 * ── WHY FOCUS, AND NOT A PILE OF OUR OWN HOTKEYS ─────────────────────────────
 * Re-implementing the shortcuts would fix the two we thought of and leave the
 * rest — every binding any BlockSuite widget registers, now and later — still
 * dead. Giving the host focus satisfies the guard the dispatcher already has, so
 * the whole keymap comes back at once and stays back.
 *
 * ── WHEN IT CLAIMS FOCUS, AND WHEN IT REFUSES ────────────────────────────────
 * Only after a pointer interaction that ENDED with nothing else focused. If the
 * user clicked into a text block, the caret is theirs and this must not touch it
 * — checked on the next frame, after the browser has moved focus for the click.
 * If they clicked our chrome (a toolbar button, the asset panel's search field),
 * focus is outside the host and stays there; the dispatcher reactivates on its
 * own via `pointerenter` when they bring the pen back to the canvas.
 *
 * It also never focuses on mount. The board is an iframe inside the site, and
 * grabbing focus at load would pull the caret out of the chat composer the user
 * may be typing in.
 */
import type { MountedBoard } from '../blocksuite/editor';

/** Nothing owns focus — the state the canvas leaves behind after a stroke. */
function focusIsUnclaimed(): boolean {
  const el = document.activeElement;
  return !el || el === document.body || el === document.documentElement;
}

export function installCanvasFocus(board: MountedBoard): () => void {
  const host = board.host;

  // No tabindex of our own: `EditorHost.connectedCallback` already sets
  // `tabIndex = 0`, so the host is focusable and deliberately IN the tab order.
  // Overriding that to -1 would quietly drop the canvas out of it.
  // A focus ring around the entire canvas is not a useful affordance, and it is
  // drawn on every stroke.
  host.style.outline = 'none';

  let frame = 0;

  const claim = (): void => {
    frame = 0;
    // Somebody took focus for real — a caret in a text block, a field in our
    // chrome. Either way it is not ours to take.
    if (!focusIsUnclaimed()) return;
    host.focus({ preventScroll: true });
  };

  /**
   * NEXT FRAME, not now. A click into a text block focuses its contenteditable
   * as part of the browser's own click handling; reading `activeElement` in the
   * same tick can catch the moment before that, and we would steal a caret the
   * user just placed.
   */
  const onPointerUp = (e: PointerEvent): void => {
    if (!host.contains(e.target as Node)) return;
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(claim);
  };

  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerUp);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    host.removeEventListener('pointerup', onPointerUp);
    host.removeEventListener('pointercancel', onPointerUp);
  };
}
