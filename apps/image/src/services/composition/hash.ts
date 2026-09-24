/**
 * The cache key for a composition render.
 *
 * A render costs a Chrome launch and a few seconds on the user's machine, so
 * results are kept and reused. That reuse is only safe if the key covers every
 * input that can change a pixel — a key that misses one serves a stale frame
 * that looks like the editor ignoring an edit, which is far worse than a cache
 * miss.
 *
 * WHY NOT JSON.stringify
 * Object key order is insertion order, so `{a,b}` and `{b,a}` stringify
 * differently while describing the identical slide. The agent fills slots in
 * whatever order it decides them and a person edits them in whatever order they
 * click, so an order-sensitive key would miss the cache constantly and, worse,
 * make the cache look broken rather than absent. Keys are sorted.
 */
import type { CompositionSource } from '../../types/project';

/**
 * FNV-1a, 64-bit, as two 32-bit halves.
 *
 * Chosen over anything cryptographic because this identifies a cache entry, not
 * a security boundary: it must be fast, synchronous and dependency-free — this
 * runs on every slot keystroke to decide whether a re-render is needed.
 * `crypto.subtle` is async and would turn that check into a promise.
 */
function fnv1a64(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h2 ^= (c << 5) | (c >>> 27);
    // 32-bit FNV prime multiply, kept in range with Math.imul.
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Everything about a composition that can change a pixel, in a stable order. */
export type HashableComposition = Omit<CompositionSource, 'renderHash'>;

/**
 * How the pixels are MADE, not what they are of.
 *
 * A hash over the composition alone answers "is this still the same design",
 * which is the wrong question on the day the rendering changes: every existing
 * render matches its source perfectly and is still wrong.
 *
 * That happened. Stills were stored exactly as the renderer returns them — with
 * the composition's own background stripped, because a block is built to
 * composite over footage — so a dark deck was kept as transparent pixels and
 * drawn over a white artboard. Correcting the recipe left every slide already
 * rendered untouched, since nothing about the design had changed.
 *
 * Bump this whenever the pipeline produces materially different pixels from the
 * same inputs. The same idea as `descriptorVersion` on an embedding.
 *
 *   1 — the render as returned, background stripped
 *   2 — meant to flatten, and did not: the still is fetched from an endpoint
 *       that wants an Authorization header, which an `<img>` cannot send, so
 *       every one of them silently took the unflattened fallback
 *   3 — fetched with the token, flattened onto the composition's own background
 */
// 4: export the preview's resolved document, slot values and page dimensions.
const RENDER_RECIPE = 4;

/**
 * A stable string for one composition. Exported for tests and for anything that
 * needs to explain WHY two renders differed — a hash tells you they did, this
 * tells you where.
 */
export function compositionFingerprint(c: HashableComposition): string {
  const slotKeys = Object.keys(c.slots ?? {}).sort();
  const slots = slotKeys.map((k) => `${k}=${String(c.slots[k] ?? '')}`).join('\u0000');
  return [
    `recipe:${RENDER_RECIPE}`,
    `block:${c.block ?? ''}`,
    // The tier is part of identity: a user block can shadow a starter of the
    // same name, and the two are different designs under one label.
    `tier:${c.tier ?? ''}`,
    // Inline html is hashed rather than embedded — a 100 KB block would
    // otherwise make the fingerprint bigger than the thing it identifies.
    `html:${c.inlineHtml ? fnv1a64(c.inlineHtml) : ''}`,
    `fill:${c.fillMode}`,
    `pose:${c.poseTime}`,
    // The frame changes the LAYOUT, not just the resolution: text rewraps and
    // clamp() resolves differently at a different width.
    `size:${c.frameWidth}x${c.frameHeight}`,
    `slots:${slots}`,
  ].join('\u0001');
}

/** The cache key. Same composition in, same key out, whatever order it was built in. */
export function compositionHash(c: HashableComposition): string {
  return fnv1a64(compositionFingerprint(c));
}

/**
 * Does a rendered layer still match its source?
 *
 * The question a caller actually has is "do I need to re-render", and asking it
 * this way keeps the comparison in one place rather than leaving every call site
 * to remember which fields matter.
 */
export function needsRerender(c: CompositionSource): boolean {
  return c.renderHash !== compositionHash(c);
}

/** A source with its key brought up to date. */
export function withCurrentHash(c: HashableComposition): CompositionSource {
  return { ...c, renderHash: compositionHash(c) };
}
