/**
 * Where a composition's live frame sits on screen, over the canvas.
 *
 * The editor draws layers into a canvas; a composition cannot be drawn there —
 * it is a live document in an iframe, sitting above. For that to look like part
 * of the artboard rather than a panel floating over it, the frame has to land on
 * exactly the pixels the layer occupies, and stay there through pan and zoom.
 *
 * ── THIS MIRRORS THE CANVAS'S OWN MAPPING, AND MUST KEEP DOING SO ────────────
 * `Canvas.tsx` positions the artboard as:
 *
 *     centerX   = canvas.width / 2 + panX
 *     artboardX = centerX - (artboard.width * zoom) / 2
 *     ctx.translate(artboardX, artboardY); ctx.scale(zoom, zoom)
 *
 * so a layer at artboard (x, y) draws at `artboardX + x * zoom`. The same
 * arithmetic is reproduced here because an overlay computed any other way drifts
 * away from the thing it is supposed to be part of. If that mapping ever
 * changes, this changes with it — the test named after the formula is the
 * tripwire.
 *
 * ── CSS PIXELS, NOT DEVICE PIXELS ───────────────────────────────────────────
 * The canvas is sized `canvas.width = canvas.clientWidth`, with no
 * devicePixelRatio multiplier, so its backing store is 1:1 with CSS pixels and
 * these numbers can be used directly for positioning. On a canvas that DID scale
 * by dpr, every value here would be out by that factor on a HiDPI screen —
 * which is the sort of thing that looks like a rounding bug and is not.
 */

export interface Viewport {
  /** The canvas element's size in CSS pixels. */
  canvasWidth: number;
  canvasHeight: number;
  zoom: number;
  panX: number;
  panY: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export interface Placement {
  /** CSS pixels from the canvas's top-left. */
  left: number;
  top: number;
  /**
   * What to scale the frame by. The document is laid out at its FRAME size and
   * scaled to the space the layer occupies — never resized to it, because
   * relaying-out at a different width is a different design for a block whose
   * type is sized in pixels.
   */
  scale: number;
}

/** Top-left of the artboard on screen, in CSS pixels. */
export function artboardOrigin(vp: Viewport, artboard: Size): { x: number; y: number } {
  const centerX = vp.canvasWidth / 2 + vp.panX;
  const centerY = vp.canvasHeight / 2 + vp.panY;
  return {
    x: centerX - (artboard.width * vp.zoom) / 2,
    y: centerY - (artboard.height * vp.zoom) / 2,
  };
}

/**
 * Place a composition frame over the layer it belongs to.
 *
 * Two scales multiply here and it is worth being explicit about which is which:
 * `zoom` takes artboard pixels to screen pixels, and `layer/frame` takes the
 * document's own frame to the box the layer occupies on the artboard. A
 * composition placed full-bleed on a 1920-wide artboard from a 1920-wide frame
 * has a layer/frame ratio of 1 and scales purely by zoom; the same block placed
 * in a half-width column scales by half of that.
 */
export function compositionPlacement(
  vp: Viewport,
  artboard: Size,
  layer: Rect,
  frame: Size,
): Placement {
  const origin = artboardOrigin(vp, artboard);
  // A frame with no width cannot be scaled into anything; 1 keeps the overlay
  // visible and wrong rather than invisible and wrong, which is easier to spot.
  const ratio = frame.width > 0 ? (layer.width / frame.width) : 1;
  return {
    left: origin.x + layer.x * vp.zoom,
    top: origin.y + layer.y * vp.zoom,
    scale: ratio * vp.zoom,
  };
}

/**
 * Is any part of this layer on screen?
 *
 * A deck is one live frame at a time, but a page can hold several compositions,
 * and a frame scrolled out of view is a document still running its animation for
 * nobody. Callers use this to unmount what cannot be seen.
 */
export function isVisible(vp: Viewport, artboard: Size, layer: Rect): boolean {
  const origin = artboardOrigin(vp, artboard);
  const left = origin.x + layer.x * vp.zoom;
  const top = origin.y + layer.y * vp.zoom;
  const right = left + layer.width * vp.zoom;
  const bottom = top + layer.height * vp.zoom;
  return right > 0 && bottom > 0 && left < vp.canvasWidth && top < vp.canvasHeight;
}
