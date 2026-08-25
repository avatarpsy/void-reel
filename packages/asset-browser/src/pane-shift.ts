/**
 * pane-shift — hold the canvas still when the pane's LEFT EDGE moves.
 *
 * ## Why the editors cannot work this out for themselves
 *
 * Collapsing the studio's agent chat widens the editor pane by ~216px, and it
 * widens it LEFTWARDS: the panel is on the left and the pane's right edge is
 * pinned. Content anchored to the pane therefore slides across the screen.
 *
 * Every editor already tried to cancel that from the inside — the board's
 * `installViewportAnchor`, `useCenterShift` in @openreel/ui — and none of them
 * can, because the information is not available inside the frame:
 *
 *   • Inside the frame the left edge is always 0 and only the width changes, so
 *     the container's centre appears to move RIGHT (+108) at the exact moment
 *     it moves LEFT (-108) on screen. Measured, correcting from the inside
 *     applied the shift with the wrong sign and DOUBLED the drift: 108 → 216px.
 *   • `window.screenX` inside an iframe reads 0 and never changes, so the frame
 *     cannot recover its on-screen position that way either.
 *
 * Those in-editor hooks are still right for what they were built for: a panel
 * collapsing INSIDE the editor genuinely moves the canvas container within the
 * frame, and there the inner measurement is the true one. This is the other
 * case — the frame itself moving — and only the parent can see it.
 *
 * ## The contract
 *
 * The studio shell posts `{ type: 'voidspace:pane-shift', dx }`, meaning "your
 * left edge moved dx CSS pixels on screen" (negative = moved left = you gained
 * width on that side). To hold a point under the same pixel, pan the viewport
 * by dx in the OPPOSITE direction — see `onPaneShift` callers.
 *
 * Here rather than in each app for the same reason `panel-chrome` and
 * `editor-nav` are: this package is the only one all three depend on, and the
 * board needs it without React.
 */

export interface PaneShiftMessage {
  type: 'voidspace:pane-shift';
  /** CSS pixels the pane's left edge moved on screen. Negative = leftwards. */
  dx: number;
}

function isPaneShift(data: unknown): data is PaneShiftMessage {
  if (!data || typeof data !== 'object') return false;
  const m = data as Partial<PaneShiftMessage>;
  return m.type === 'voidspace:pane-shift' && typeof m.dx === 'number' && Number.isFinite(m.dx);
}

/**
 * Listen for the parent's pane-shift notices.
 *
 * @param apply called with the on-screen delta of the left edge.
 * @returns a disposer.
 */
export function onPaneShift(apply: (dx: number) => void): () => void {
  const onMessage = (e: MessageEvent) => {
    // Only the embedding parent may move our pane. Anything else posting this
    // shape is not describing our geometry and must not move the canvas.
    if (e.source !== window.parent || e.source === window) return;
    if (!isPaneShift(e.data)) return;
    try {
      apply(e.data.dx);
    } catch {
      /* a canvas that is mid-teardown must not break the message pump */
    }
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
