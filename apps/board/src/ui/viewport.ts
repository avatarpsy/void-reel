/**
 * Framing the board, in one place.
 *
 * WHY IT IS SHARED: three callers want "show me the whole storyboard" — the Fit
 * button, the agent after a structural edit, and the asset panel after a resize.
 * Each used to compute its own padding, and the RPC's copy kept a HARDCODED left
 * inset while the toolbar's measured the panel. The result was that the agent
 * laying out a storyboard put shot 1 underneath the media panel, where the user
 * could not see the thing that had just been made for them.
 *
 * The inset is MEASURED, never a constant: the panel collapses and is
 * user-resizable, so any fixed number is wrong most of the time — either a dead
 * gutter or a hidden shot.
 */

/** The editor root, or null before it mounts. */
function edgelessRoot():
  | (Element & { gfx?: { fitToScreen(o: unknown): void } })
  | null {
  return document.querySelector('affine-edgeless-root') as never;
}

/** How much of the canvas our own chrome is covering on the left. */
export function leftInset(): number {
  const panel = document.querySelector<HTMLElement>('.vs-assets');
  if (!panel) return 24;
  return panel.getBoundingClientRect().width + 24;
}

/** Frame everything on the board, clearing the chrome on every side. */
export function fitBoard(opts: { smooth?: boolean } = {}): void {
  edgelessRoot()?.gfx?.fitToScreen({
    smooth: opts.smooth ?? true,
    // top / right / bottom / left. The bottom clears AFFiNE's own toolbar and
    // the top clears ours; both sit over the canvas.
    padding: [110, 110, 110, leftInset()],
  });
}

/**
 * Frame the board ONLY if something is off-screen or under our chrome.
 *
 * Called after shots are created. Fitting unconditionally would yank the
 * viewport out from under someone who had deliberately zoomed into scene 4 and
 * asked for one more shot at the end; never fitting leaves the agent drafting a
 * storyboard the user cannot see — and, because the asset panel covers the left
 * of the canvas, the shot most likely to be hidden is scene 1.
 *
 * So: only when the new work is not already visible, which is the case a person
 * would describe as "it should have scrolled".
 */
export function ensureVisible(bounds: { x: number; y: number; w: number; h: number }): void {
  const gfx = edgelessRoot()?.gfx as
    | { viewport?: { viewportBounds?: { x: number; y: number; w: number; h: number }; zoom?: number } }
    | undefined;
  const vb = gfx?.viewport?.viewportBounds;
  if (!vb) { fitBoard(); return; }

  // The chrome sits OVER the canvas, so the genuinely visible region is inset
  // by the panel on the left. Converted to model units via the current zoom.
  const zoom = gfx?.viewport?.zoom || 1;
  const visible = {
    left: vb.x + leftInset() / zoom,
    right: vb.x + vb.w - 24 / zoom,
    top: vb.y + 70 / zoom,
    bottom: vb.y + vb.h - 90 / zoom,
  };

  const inside =
    bounds.x >= visible.left
    && bounds.x + bounds.w <= visible.right
    && bounds.y >= visible.top
    && bounds.y + bounds.h <= visible.bottom;
  if (!inside) fitBoard();
}
