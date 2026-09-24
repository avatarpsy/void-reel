/**
 * WHICH composition gets the live frame, and when it stops having one.
 *
 * `overlay-placement.ts` answers where a frame goes. This answers whether there
 * should be one at all — kept apart from the React component that mounts it,
 * because "which slide is running" is a rule with consequences, and a rule is
 * worth testing without a renderer.
 *
 * ── AT MOST ONE, AND THAT IS NOT A PERFORMANCE COMPROMISE ───────────────────
 * `window.__timelines` is a global keyed by composition id, and blocks scope
 * their CSS with `[data-composition-id="x"]`. Two instances of one block in a
 * page share a timeline object and a selector namespace and will fight over
 * both — a deck with three `stat-card` slides is exactly that case. Separate
 * frames give each its own window, so one-at-a-time is first a CORRECTNESS rule
 * and only second the thing that lets a laptop survive a twenty-slide deck.
 *
 * ── A FRAME NOBODY CAN SEE IS A DOCUMENT ANIMATING FOR NOBODY ───────────────
 * Off-screen is not "cheap": it is a GSAP timeline and a compositor layer for
 * something outside the viewport. Panning away therefore tears the frame down.
 */
import type { CompositionSource, ImageLayer, Layer } from '../../types/project';
import { compositionFingerprint } from './hash';
import { isVisible, type Rect, type Size, type Viewport } from './overlay-placement';

/** One composition layer, reduced to what deciding and placing needs. */
export interface CompositionLayerRef {
  layerId: string;
  /** The layer's box in ARTBOARD pixels, origin top-left. */
  rect: Rect;
  source: CompositionSource;
}

/**
 * Does this layer's picture come from a composition?
 *
 * A composition is a FIELD on an image layer, never a layer type — that is what
 * makes z-order, masks, blend modes and export work with no special cases — so
 * every surface that cares has to ask the same question the same way. One
 * predicate is what stops the canvas and the Inspector disagreeing about what a
 * composition layer even is.
 */
export function isCompositionLayer(layer: Layer | undefined | null): layer is ImageLayer {
  return !!layer && layer.type === 'image' && !!(layer as ImageLayer).composition;
}

/**
 * Composition layers on one page, TOP-MOST FIRST.
 *
 * `artboard.layerIds` is stored top-first (the canvas reverses it to paint
 * bottom-up), so this order is already the one a person would call "in front".
 */
export function compositionLayers(
  layerIds: readonly string[],
  layers: Record<string, Layer>,
): CompositionLayerRef[] {
  const out: CompositionLayerRef[] = [];
  for (const id of layerIds) {
    const layer = layers[id];
    if (!isCompositionLayer(layer)) continue;
    const t = layer.transform;
    out.push({
      layerId: layer.id,
      rect: { x: t.x, y: t.y, width: t.width, height: t.height },
      source: layer.composition as CompositionSource,
    });
  }
  return out;
}

export interface LiveChoice {
  viewport: Viewport;
  artboard: Size;
  /** What the user has selected. A selected composition always wins. */
  selectedLayerIds: readonly string[];
  /** Layer ids the user has hidden. A hidden layer draws nothing, so it runs
   *  nothing either. */
  hidden?: (id: string) => boolean;
}

/**
 * The one composition that runs live, or none.
 *
 * SELECTION WINS. The live frame is the motion preview, and the layer someone
 * has selected is the one they are working on — anything else would mean
 * clicking a slide to edit it and watching a different slide animate.
 *
 * ── THE FALLBACK, AND WHEN IT SHOULD GO ─────────────────────────────────────
 * With nothing selected this still runs the top-most composition on the page,
 * which is NOT where the design ends up: a deselected composition should fall
 * back to its cached bitmap and stop running. That bitmap does not exist yet —
 * rasterising moved server-side once `foreignObject` was measured to taint the
 * canvas, and that renderer is not built. Until it is, "no live frame" would
 * mean a blank artboard, so this fallback is the difference between an editor
 * that looks broken and one that works. Delete it the day a composition layer
 * has pixels of its own, and not before.
 */
export function pickLiveComposition(
  candidates: readonly CompositionLayerRef[],
  opts: LiveChoice,
): CompositionLayerRef | null {
  const runnable = candidates.filter((c) => {
    if (opts.hidden?.(c.layerId)) return false;
    // A zero-sized layer has no pixels to sit on, and would scale a frame by 0.
    if (!(c.rect.width > 0) || !(c.rect.height > 0)) return false;
    return isVisible(opts.viewport, opts.artboard, c.rect);
  });
  if (!runnable.length) return null;

  const selected = new Set(opts.selectedLayerIds);
  return runnable.find((c) => selected.has(c.layerId)) ?? runnable[0];
}

/**
 * The composition running live on this page right now, or null.
 *
 * ONE answer shared by every surface that stacks around the live frame: the
 * overlay mounts it, the canvas stops painting what sits above it, and the
 * top canvas paints those layers over it instead. Computed three ways it
 * would be three chances for the frame to cover the wrong thing.
 */
export function liveCompositionFor(
  project: { layers: Record<string, Layer> } | null | undefined,
  artboard: { layerIds: readonly string[]; size: Size } | null | undefined,
  viewport: Viewport,
  selectedLayerIds: readonly string[],
): CompositionLayerRef | null {
  if (!project || !artboard || !(viewport.canvasWidth > 0) || !(viewport.canvasHeight > 0)) return null;
  return pickLiveComposition(compositionLayers(artboard.layerIds, project.layers), {
    viewport,
    artboard: artboard.size,
    selectedLayerIds,
    hidden: (id) => project.layers[id]?.visible === false,
  });
}

/**
 * The layers stacked ABOVE `layerId`, in paint order (bottom first).
 *
 * The live frame is an iframe over the canvas, so anything the canvas paints
 * above a composition ends up UNDER its frame: text placed on a composition
 * background was hidden while the layer list said it was on top. These are the
 * layers that must be painted over the frame instead.
 */
export function layersAbove(layerIds: readonly string[], layerId: string): string[] {
  const at = layerIds.indexOf(layerId);
  return at <= 0 ? [] : layerIds.slice(0, at).reverse();
}

/**
 * Has the thing being shown changed, or only where it is on screen?
 *
 * Pan and zoom MOVE a frame; they must never rebuild one, because rebuilding
 * restarts the animation and re-runs the settle wait — a slide that flickers
 * back to its first frame every time you scroll. So a live frame's identity is
 * the layer plus everything about the composition that can change a pixel:
 * deliberately the same inputs as the render cache key, since a frame showing
 * something the current key would not describe is exactly the stale frame that
 * key exists to prevent.
 */
export function liveFrameIdentity(ref: CompositionLayerRef | null): string {
  if (!ref) return '';
  // `compositionFingerprint` already sorts slot keys, folds authored html in by
  // hash rather than carrying it, and separates fields with characters no slot
  // value can contain. A second version of that logic here would be one more
  // place to forget an input, and the two disagreeing would mean a live frame
  // showing a composition the cache calls a different one.
  return ref.layerId + '|' + compositionFingerprint(ref.source);
}
