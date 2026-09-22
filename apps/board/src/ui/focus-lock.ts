/**
 * ══════════════════════════════════════════════════════════════════════════
 * WHILE A DOCUMENT IS IN FOCUS, THE CANVAS IS A PAGE — NOT A BOARD
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The screenplay's focus mode and the board-as-page view each render their own
 * DOM over the canvas, so nothing underneath can be reached. The document's
 * focus mode deliberately does not: a document IS real BlockSuite blocks, and
 * rebuilding that editor in an overlay would mean a worse editor and two copies
 * of the document to keep in step. It FRAMES the live canvas instead.
 *
 * The cost used to be paid by the user. Every board gesture still worked, so
 * from inside a document you could space-drag the page off screen, middle-drag
 * it away, wheel past the end into empty canvas, or zoom until the rest of the
 * board came back — and a mode that promised one document handed over the whole
 * board with no way back but Escape.
 *
 * ── ONE MECHANISM, NOT FOUR ───────────────────────────────────────────────
 * Every one of those ends in the same event: the viewport moved. So rather than
 * hunting each gesture — ours, BlockSuite's, and whatever a later version adds
 * — this watches the viewport and pulls it back onto the page. Scrolling within
 * the document still works and feels ordinary; anything that would leave it
 * stops at the edge, the way a page stops in every document reader.
 *
 * Gestures that exist only for ARRANGING a board are refused outright instead,
 * because clamping a gesture the user should not be making feels like a fight.
 * `isCanvasFramed()` is what they ask.
 *
 * ── WHY THE PAGE IS MEASURED AND NOT ASKED ────────────────────────────────
 * The obvious source for the page's extent is the note's `xywh`, and it is
 * wrong: an edgeless note grows to fit its content on screen while its model
 * height lags behind. Measured on a real document — model `[0,0,800,1120]`,
 * drawn `800x1308`. Clamping to the model stopped 188 units short, so the last
 * inch of the document could not be scrolled into view at all.
 *
 * So this works from the rendered rectangle, in screen pixels, and converts one
 * delta back through the zoom at the end. That also means it holds the page as
 * it is NOW: a document that grows while it is being typed into stays
 * scrollable to its new end, with nothing to keep in step.
 */

/**
 * Room left around the page, in screen pixels.
 *
 * The top is larger because the focus bar floats over the canvas there. These
 * are the numbers `focusOnBounds` pads with, so opening a document and then
 * scrolling it do not disagree about where the page sits.
 */
/** A note's own box on the board, in model units. */
export interface FramedBounds { x: number; y: number; w: number; h: number }

const PAD = { top: 72, side: 48, bottom: 48 };

/**
 * How small the page may be made.
 *
 * Zooming out is the one way the board could come back into view from inside a
 * document, so it needs a floor. Below this the page is no longer the thing on
 * screen, which is the single promise this mode makes.
 */
const MIN_PAGE_FRACTION = 0.45;
const MAX_ZOOM = 4;

let framed = 0;

/**
 * Is a focus mode open?
 *
 * Asked by the gestures that exist only for arranging a BOARD — space-pan is
 * ours — so that they are refused the same way in all three modes. The
 * screenplay and the board-as-page view cover the canvas with an opaque sheet
 * and do not need the clamp below, but a board gesture means no more inside
 * them than it does inside a document, and one answer for all three is the
 * only way they cannot drift apart.
 */
export function isCanvasFramed(): boolean {
  return framed > 0;
}

/**
 * Declare a focus mode open, without holding the viewport.
 *
 * For the modes that render their own DOM over the canvas: there is nothing
 * to clamp, because there is nothing reachable left to move.
 */
export function enterFocusMode(name: string): () => void {
  framed += 1;
  /**
   * ONE host for the attribute, because there were three. The screenplay and
   * the board-as-page view set it on `documentElement`, the document set it
   * on the chrome host, and `document-view.css` had a `body[data-focus-mode]`
   * rule that therefore matched nothing at all. Every selector reads it as a
   * plain ancestor, so the root is the one place all of them can see.
   */
  document.documentElement.dataset.focusMode = name;
  document.body.setAttribute('data-canvas-framed', '');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    framed = Math.max(0, framed - 1);
    if (!framed) {
      delete document.documentElement.dataset.focusMode;
      document.body.removeAttribute('data-canvas-framed');
    }
  };
}

interface Viewport {
  centerX: number; centerY: number; zoom: number;
  setCenter(x: number, y: number): void;
  setZoom?(zoom: number): void;
  viewportUpdated?: { subscribe(fn: () => void): { unsubscribe(): void } | void };
}

/** The same root `viewport.ts` reaches for, and for the same reason. */
function viewportOf(): Viewport | null {
  const root: any = document.querySelector('affine-edgeless-root');
  return root?.gfx?.viewport ?? null;
}

/**
 * How far one edge is outside its allowed range, in screen pixels.
 *
 * Positive means the page must move up or left by that much. When the page and
 * its margins fit inside the window it is centred and cannot wander; when it
 * does not fit, it may travel between the two ends, which is exactly scrolling.
 */
export function overflow(
  near: number, far: number, windowNear: number, windowFar: number,
  padNear: number, padFar: number,
): number {
  const size = far - near;
  const room = windowFar - windowNear;
  if (size + padNear + padFar <= room) {
    return near - (windowNear + (room - size) / 2);
  }
  if (near > windowNear + padNear) return near - (windowNear + padNear);
  if (far < windowFar - padFar) return far - (windowFar - padFar);
  return 0;
}

/**
 * Hold the viewport on `page()` until the returned function is called.
 *
 * `page` is read on every correction rather than captured, because the document
 * is being edited while this is holding it.
 *
 * `armAfterMs` exists because opening a document flies to it with a smooth
 * animation, and correcting mid-flight would fight that animation and land the
 * page somewhere neither of them chose.
 */
export function frameCanvasOn(
  page: () => Element | null,
  opts: {
    armAfterMs?: number;
    name?: string;
    /** The note's own box, for when it is not rendered. */
    bounds?: () => FramedBounds | null;
  } = {},
): () => void {
  const bounds = opts.bounds;
  const leave = enterFocusMode(opts.name ?? 'document');

  let armed = false;
  let correcting = false;
  /**
   * Has the reader taken the wheel yet?
   *
   * A document is still laying out when it opens — fonts arrive, images get
   * their size, a table finds its column widths — and the page grows as that
   * settles. Measured on one: 911px tall at +400ms and 1178px at +600ms,
   * which walked the first line 110px off the top of the window after the
   * flight had already framed it correctly.
   *
   * So until a real gesture arrives, the top of the page is held against the
   * top of the window however the page grows. The first wheel or pointer
   * hands control over, and from then on this only clamps.
   */
  let reading = false;

  const hold = (toTop = !reading): void => {
    if (!armed || correcting) return;
    const viewport = viewportOf();
    const host = document.querySelector('editor-host');
    if (!viewport || !host) return;
    const win = host.getBoundingClientRect();
    const zoom = viewport.zoom || 1;

    /**
     * ── THE PAGE IS NOT ALWAYS IN THE DOM ─────────────────────────────
     *
     * BlockSuite culls notes that are far from the viewport, so the further
     * the board strays the more certain it is that there is no element to
     * measure — and the first version of this gave up in exactly that case,
     * which is the one case the hold exists for. Found on a real board: the
     * viewport ended up at x=-2456 with no note rendered at all and nothing
     * pulling it back.
     *
     * So when the element is gone, the note's own `xywh` is projected
     * through the viewport instead. It is a worse measurement — a note's
     * model height lags its content — but it is good enough to bring the
     * page back on screen, and once it renders the measured path takes over.
     */
    const el = page();
    const model = el ? null : bounds?.();
    if (!el && !model) return;
    const box = el ? el.getBoundingClientRect() : null;
    const left = box ? box.left
      : (model!.x - viewport.centerX) * zoom + win.left + win.width / 2;
    const top = box ? box.top
      : (model!.y - viewport.centerY) * zoom + win.top + win.height / 2;
    const width = box ? box.width : model!.w * zoom;
    const height = box ? box.height : model!.h * zoom;
    const rect = { left, top, width, height, right: left + width, bottom: top + height };

    if (!rect.width || !win.width) return;

    correcting = true;
    try {
      /**
       * Zoom first: it changes the rectangle the position is judged against, so
       * correcting both in one pass would place the page by a stale measurement.
       */
      if (typeof viewport.setZoom === 'function') {
        const wanted = rect.width < win.width * MIN_PAGE_FRACTION
          ? (zoom * win.width * MIN_PAGE_FRACTION) / rect.width
          : Math.min(zoom, MAX_ZOOM);
        if (Math.abs(wanted - zoom) > 0.001) {
          viewport.setZoom(wanted);
          return; // The next update carries the new rectangle.
        }
      }

      const dx = overflow(rect.left, rect.right, win.left, win.right, PAD.side, PAD.side);
      /**
       * On the way in, the FIRST line — not wherever the flight happened to
       * stop. `focusOnBounds` frames the note's `xywh`, which is shorter than
       * the document actually is, so a long one opened 38px down: its top
       * margin cut off, for no reason a reader could see. Every document
       * reader opens at the top, and after that this is an ordinary clamp.
       */
      const dy = toTop && rect.height + PAD.top + PAD.bottom > win.height
        ? rect.top - (win.top + PAD.top)
        : overflow(rect.top, rect.bottom, win.top, win.bottom, PAD.top, PAD.bottom);
      // Half a pixel of slack: chasing sub-pixel drift would never settle.
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      viewport.setCenter(viewport.centerX + dx / zoom, viewport.centerY + dy / zoom);
    } finally {
      correcting = false;
    }
  };

  /**
   * `() => hold()`, never `hold`. The subject hands its subscriber an event
   * object, which as a first argument means `toTop` — so every viewport
   * update snapped the page back to its first line and a long document could
   * not be scrolled at all.
   */
  const sub: any = viewportOf()?.viewportUpdated?.subscribe(() => hold());

  /**
   * ONLY if the slot is missing. `viewportUpdated` is BlockSuite's, and a
   * version that renamed or stopped emitting it would silently give the board
   * back — so there is a fallback, but a per-frame loop running behind a
   * document nobody is dragging is work for nothing.
   */
  let raf = 0;
  if (!sub) {
    raf = requestAnimationFrame(function tick() {
      hold();
      raf = requestAnimationFrame(tick);
    });
  }

  /**
   * The page also moves when the WINDOW changes, and a resize emits no viewport
   * update of its own — collapsing the agent chat would otherwise leave the
   * document sitting off to one side until something else nudged it.
   */
  const onResize = () => hold();
  window.addEventListener('resize', onResize);

  /**
   * The page element is replaced as the note re-renders, so the observer
   * follows whatever `page()` returns rather than holding one node.
   */
  let watched: Element | null = null;
  const resize = new ResizeObserver(() => hold());
  const rewatch = () => {
    const el = page();
    if (el === watched) return;
    if (watched) resize.unobserve(watched);
    if (el) resize.observe(el);
    watched = el;
  };
  const watcher = window.setInterval(rewatch, 500);

  const takeControl = () => { reading = true; };
  const host = document.querySelector('editor-host');
  host?.addEventListener('wheel', takeControl, { passive: true, capture: true });
  host?.addEventListener('pointerdown', takeControl, true);

  const armTimer = window.setTimeout(() => { armed = true; rewatch(); hold(); }, opts.armAfterMs ?? 450);

  return () => {
    leave();
    window.clearTimeout(armTimer);
    window.clearInterval(watcher);
    resize.disconnect();
    host?.removeEventListener('wheel', takeControl, true);
    host?.removeEventListener('pointerdown', takeControl, true);
    window.removeEventListener('resize', onResize);
    if (raf) cancelAnimationFrame(raf);
    try { sub?.unsubscribe?.(); } catch { /* already gone */ }
  };
}
