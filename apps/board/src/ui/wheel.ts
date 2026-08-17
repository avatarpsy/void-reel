/**
 * ONE RULE FOR EVERY WHEEL GESTURE ON THE BOARD.
 *
 * ── THE BUG ──────────────────────────────────────────────────────────────────
 * Ctrl+wheel over empty canvas zoomed the board. Ctrl+wheel over a shot card
 * zoomed the whole BROWSER WINDOW — the page, the chrome, everything — which is
 * a jarring thing to do to somebody who was looking at a storyboard, and a
 * nuisance to undo.
 *
 * The cause is a chain of small, individually reasonable decisions. Several
 * boxes inside a card scroll: the card body, the reference lanes, the take
 * strip. Each claims the wheel with `stopPropagation()` so that scrolling a list
 * does not zoom the board out from under the reader — right, and the thing those
 * handlers were written for. But they claimed EVERY wheel, including the ones
 * with ctrl held. So the event never reached BlockSuite's root handler, which is
 * what zooms the canvas AND calls `preventDefault()`, and it never reached the
 * window-level fallback in `main.ts` either. Nothing cancelled the default, and
 * the browser's own ctrl+wheel page zoom is the default.
 *
 * Measured before the fix, ctrl+wheel at six points on a card: the canvas zoom
 * changed over empty canvas and over the card header, and did not move at all
 * over the body, a text field, a reference lane or the take strip.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * Ctrl (or ⌘) + wheel is a ZOOM. It is never a scroll, anywhere, on any inner
 * box — the modifier is what distinguishes the two gestures, and an inner
 * scroller has no business interpreting the zoom one. So nothing claims it, it
 * reaches the canvas, and the board zooms about the pointer exactly as it does
 * over empty space.
 *
 * That also means a card is not a hole in the canvas. Zooming toward the shot
 * you are reading is the most natural thing to do with a board, and it should
 * not matter that your pointer happened to be over a card when you did it.
 */

/**
 * Is this the zoom gesture rather than the scroll one?
 *
 * A trackpad pinch arrives as a wheel event with `ctrlKey` set — that is how the
 * platform reports it, and it is the same test BlockSuite's own root handler
 * uses (`isTouchPadPinchEvent`). `metaKey` is included because ⌘+wheel is the
 * page-zoom gesture on macOS, and it must not zoom the page here either.
 */
export function isZoomWheel(e: WheelEvent): boolean {
  return e.ctrlKey || e.metaKey;
}

/**
 * Claim a wheel for an inner scroller — but only when it is really a scroll and
 * the box really has somewhere to go.
 *
 * Returns true when the event was claimed, so a caller that wants to do its own
 * scrolling (the lanes translate vertical wheel into horizontal movement) knows
 * whether to proceed.
 *
 * The "somewhere to go" test matters as much as the modifier one: a lane with
 * two items in it has nothing to scroll, and swallowing the gesture there would
 * make a dead patch in the middle of the card where the board refuses to pan.
 */
export function claimScrollWheel(
  e: WheelEvent,
  el: HTMLElement,
  axis: 'x' | 'y' = 'y',
): boolean {
  if (isZoomWheel(e)) return false;
  const room = axis === 'y'
    ? el.scrollHeight > el.clientHeight
    : el.scrollWidth > el.clientWidth;
  if (!room) return false;
  e.stopPropagation();
  return true;
}

/**
 * For a box that must keep the wheel away from the canvas whatever its content
 * — a menu or a sheet floating over the card, where scrolling the board behind
 * it would be wrong even when the sheet itself has nothing to scroll.
 *
 * Still lets the zoom gesture through, for the reason at the top of this file.
 */
export function blockScrollWheel(e: WheelEvent): void {
  if (isZoomWheel(e)) return;
  e.stopPropagation();
}
