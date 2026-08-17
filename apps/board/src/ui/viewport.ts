/**
 * Framing the board, in one place.
 *
 * WHY IT IS SHARED: the callers that want "show me the whole storyboard" — the
 * Fit button and the agent after a structural edit — each used to compute their
 * own padding, and the RPC's copy kept a HARDCODED left inset while the
 * toolbar's measured the panel. The result was that the agent laying out a
 * storyboard put shot 1 underneath the media panel, where the user could not
 * see the thing that had just been made for them.
 *
 * The inset is MEASURED, never a constant: the panel collapses and is
 * user-resizable, so any fixed number is wrong most of the time — either a dead
 * gutter or a hidden shot.
 *
 * EVERY CALLER HERE IS DRIVEN BY CONTENT, NEVER BY CHROME. The asset panel used
 * to fit the board when it was collapsed or dragged; it no longer does anything
 * to the viewport at all. Moving someone's framing because they put a panel away
 * is the fastest way to make a canvas feel unreliable — see `setCollapsed` in
 * `asset-panel.ts`. Do not add a chrome-driven caller back.
 */

interface BoardViewport {
  centerX: number;
  centerY: number;
  zoom: number;
  setCenter(centerX: number, centerY: number): void;
}

/** The editor root, or null before it mounts. */
function edgelessRoot():
  | (Element & { gfx?: { fitToScreen(o: unknown): void; viewport?: BoardViewport } })
  | null {
  return document.querySelector('affine-edgeless-root') as never;
}

/**
 * THE BOARD DOES NOT MOVE WHEN THE WINDOW AROUND IT CHANGES SIZE.
 *
 * The board's own chrome floats over the canvas, so collapsing the asset panel
 * cannot move anything. But this app is an IFRAME inside the studio shell, and
 * collapsing the agent chat hands that iframe ~380 more pixels — a real
 * container resize. BlockSuite's viewport keeps its CENTRE across one, so the
 * container grows on the right and the whole storyboard slides right by half
 * the growth. From the user's side that is indistinguishable from the board
 * having jumped: they closed a chat panel and their shots moved.
 *
 * So cancel it. When the container's centre moves `dx` on screen, move the
 * viewport centre by `dx / zoom` in model units and the two exactly annul:
 * a point at model x sits at `(x - centerX) * zoom + containerCentre`, so
 * holding that expression constant is the whole trick. The board gains the
 * space on the side it appeared, and nothing the user was looking at moves.
 *
 * Same rule, same derivation as `useCenterShift` in `@openreel/ui`, which the
 * video and image editors use for their own surfaces. Returns a disposer.
 */
export function installViewportAnchor(el: HTMLElement): () => void {
  let prev: { cx: number; cy: number } | null = null;

  const measure = () => {
    const r = el.getBoundingClientRect();
    // A hidden container measures 0×0 at the origin; treating that as a move
    // would fire a huge bogus correction and another one on the way back.
    if (r.width === 0 && r.height === 0) return;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const before = prev;
    prev = { cx, cy };
    // The first measurement only establishes the baseline — the board is free
    // to frame itself however it likes on open.
    if (!before) return;
    const dx = cx - before.cx;
    const dy = cy - before.cy;
    if (dx === 0 && dy === 0) return;
    const vp = edgelessRoot()?.gfx?.viewport;
    if (!vp || !vp.zoom) return;
    vp.setCenter(vp.centerX + dx / vp.zoom, vp.centerY + dy / vp.zoom);
  };

  measure();
  const ro = new ResizeObserver(measure);
  ro.observe(el);
  // A ResizeObserver fires when the element's own box changes, not when it
  // merely moves; the window listener covers the rest.
  window.addEventListener('resize', measure);
  return () => {
    ro.disconnect();
    window.removeEventListener('resize', measure);
  };
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
