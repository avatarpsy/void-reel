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

import { onPaneShift } from '@openreel/asset-browser';

interface BoardViewport {
  centerX: number;
  centerY: number;
  zoom: number;
  width: number;
  setCenter(centerX: number, centerY: number, forceUpdate?: boolean): void;
  onResize(): void;
  /**
   * `setRect(left, top, width, height)` — the public way to make the viewport's
   * box current AND emit `sizeUpdated` in the same call. Optional so a
   * BlockSuite upgrade that removes it falls back to `onResize` rather than
   * breaking the build; measured against 0.22.4, where it exists.
   */
  setRect?(left: number, top: number, width: number, height: number): void;
  /**
   * Frame ONE bound. `fitToScreen` frames everything, which is the wrong verb
   * for opening a single document. Optional in the same spirit as `setRect`:
   * present in 0.22.4, and `focusOnBounds` falls back to centring if a later
   * version renames it, which is worse but never broken.
   */
  setViewportByBound?(
    bound: { x: number; y: number; w: number; h: number },
    padding?: [number, number, number, number],
    smooth?: boolean,
  ): void;
  /**
   * BlockSuite CACHES the container's box, and clears the cache in exactly one
   * place: the first line of its own ResizeObserver callback
   * (`Viewport.setShellElement`). Ours can be delivered first — it is, on this
   * board, because the editor's shell is registered during an async lit render
   * that happens after `installViewportAnchor` runs — and then every size the
   * viewport reports is one resize out of date.
   *
   * That is the whole of the 200ms glitch: the correction below was computed
   * and applied against a stale width, so the board was drawn 210px off until
   * BlockSuite's debounce caught up and redrew it. Clearing the cache first is
   * not a workaround for the cache; it is doing the same thing BlockSuite does,
   * in the callback that got there first.
   *
   * Declared optional so a BlockSuite upgrade that renames or removes these
   * cannot break the build — `refreshBox` below falls back to the old
   * (correct-but-late) behaviour if the reset does not take.
   */
  _cachedBoundingClientRect?: DOMRect | null;
  _cachedOffsetWidth?: number | null;
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
 * video and image editors use for their own surfaces.
 *
 * AND IT HAS TO LAND ON THE SAME FRAME, which is the harder half.
 *
 * Correcting the centre alone left the board visibly jumping ~210px and
 * snapping back a fifth of a second later — worse than the drift it fixed,
 * because a glitch reads as broken where a slow drift only reads as odd.
 * Frame-by-frame, the CENTRE was already right on frame 0 and the picture only
 * moved on frame 13: BlockSuite debounces its resize pipeline by 200ms
 * (`Viewport._setupResizeObserver`), and the renderer repositions on
 * `sizeUpdated`, which only `_completeResize` emits at the END of that debounce.
 * So for thirteen frames the board was drawn with a corrected centre and a
 * stale width.
 *
 * `setRect` is the public way to say "this is the size now" and emits
 * `sizeUpdated` itself, so the renderer acts while we are still inside the
 * ResizeObserver callback — before the browser paints. The 200ms debounce then
 * completes against a viewport that is already correct and changes nothing.
 *
 * Returns a disposer.
 */
/**
 * THE OUTER FRAME MOVING — which this file's own anchor cannot see.
 *
 * `installViewportAnchor` below corrects for the container's centre moving
 * WITHIN this document, and that is right when the board's own chrome resizes
 * it. It is wrong for the studio shell collapsing the agent chat, because from
 * in here that reads as the centre moving RIGHT (+108) at the moment it moves
 * LEFT (-108) on screen — measured, it doubled the drift to 216px instead of
 * cancelling it. Only the parent knows which edge moved, so the parent says so
 * and this applies it.
 *
 * ── THE ARITHMETIC, AND WHY IT ADDS `dx` ────────────────────────────────────
 * A point at model x sits at `(x - centerX) * zoom + containerCentreOnPage`,
 * and `containerCentreOnPage = frameLeft + width / 2`. Holding it still means
 * moving centerX by the container centre's movement ON PAGE, over zoom.
 *
 * That movement has two parts, and the two mechanisms split them exactly:
 *   • the WIDTH growing moves the centre `+Δwidth / 2` — `installViewportAnchor`
 *     already measures that from inside and applies it;
 *   • the LEFT EDGE moving contributes `dx`, which is invisible from inside.
 * So this adds `dx` on top, and the pair land on the true total.
 *
 * Measured on a 216px drawer: the anchor contributes +108, this contributes
 * -216, total -108 — exactly the on-page centre movement, and the board holds
 * still. Subtracting here instead (the obvious-looking sign) put centerX at
 * +324 and moved the board 432px, twice as far as doing nothing at all.
 */
export function installPaneShift(): () => void {
  return onPaneShift((dx) => {
    const vp = edgelessRoot()?.gfx?.viewport;
    if (!vp || !vp.zoom) return;
    vp.setCenter(vp.centerX + dx / vp.zoom, vp.centerY, true);
  });
}

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
    // Read the pre-correction centre BEFORE anything below mutates it.
    const cx0 = vp.centerX;
    const cy0 = vp.centerY;
    const zoom = vp.zoom;

    // 1. Make the viewport's idea of its own size current — see the interface.
    vp._cachedBoundingClientRect = null;
    vp._cachedOffsetWidth = null;
    // 2. TELL the viewport its new box rather than asking it to go and look.
    //
    //    This used to call `vp.onResize()`, which is what BlockSuite's own
    //    observer calls — and measured, it left the viewport exactly ONE resize
    //    behind: with the container at 1442px the viewport still reported 1226,
    //    so the correction in step 3 was computed against a stale width and the
    //    board drifted by the full panel width (216px) every time the agent
    //    chat was collapsed. Clearing the caches above is not enough on its own
    //    because `onResize` routes through the same debounced pipeline
    //    (`_setupResizeObserver` → `_completeResize`) that runs 200ms later.
    //
    //    `setRect` is the public "this is the size now": it writes the box and
    //    emits `sizeUpdated` synchronously, so the renderer repositions while we
    //    are still inside the ResizeObserver callback, before the browser
    //    paints. It is idempotent, so BlockSuite's own debounced handler
    //    arriving afterwards finds nothing left to change.
    //
    //    (The file's own comment already described using `setRect` for exactly
    //    this reason; the code called `onResize` instead. They now agree.)
    if (typeof vp.setRect === 'function') {
      vp.setRect(r.left, r.top, r.width, r.height);
    } else {
      vp.onResize();
    }
    // 3. Anchor: cancel the container centre's movement, so the point the user
    //    was looking at is under the same pixel it was a frame ago.
    vp.setCenter(cx0 + dx / zoom, cy0 + dy / zoom, true);
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

/**
 * Frame ONE thing, filling the pane — how a document is opened.
 *
 * `fitBoard` frames the whole canvas, which is the right verb for "show me my
 * work" and the wrong one for "open this document": the document would end up
 * one object among many, at whatever zoom the rest of the board dictates.
 *
 * The padding is asymmetric on purpose. The focus bar floats over the top of
 * the canvas, so the top inset clears it; the left inset is zero because focus
 * mode hides the asset panel, which is what `leftInset` exists to clear.
 */
export function focusOnBounds(
  bounds: { x: number; y: number; w: number; h: number },
  opts: { smooth?: boolean } = {},
): void {
  const viewport = edgelessRoot()?.gfx?.viewport;
  if (!viewport) return;
  if (typeof viewport.setViewportByBound === 'function') {
    viewport.setViewportByBound(bounds, [72, 48, 48, 48], opts.smooth ?? true);
    return;
  }
  // Fallback: centre on it and leave the zoom alone. Not the same thing, but a
  // document the user can see beats a build that does not compile.
  viewport.setCenter(bounds.x + bounds.w / 2, bounds.y + bounds.h / 2);
}
