/**
 * Where a composition's document comes from.
 *
 * A `CompositionSource` on a layer records WHICH block it is, not the block
 * itself — `block` plus `tier`, or `inlineHtml` for work no block covers. Before
 * anything can render, that reference has to become an actual document, and this
 * is the one place that turns one into the other.
 *
 * ── THE MANIFEST IS NEVER STORED ON THE LAYER ───────────────────────────────
 * `source.slots` is the VALUES a user or the agent filled in. What holes exist,
 * and of what kind, belongs to the BLOCK, and it comes back from here with the
 * html every time. Copying the manifest onto the layer would be a second copy of
 * something the block owns: edit the block, and every slide placed before the
 * edit would keep offering the old holes and filling nothing.
 *
 * ── WHY THE PROMISE IS CACHED, NOT THE RESULT ───────────────────────────────
 * The Inspector re-renders on every keystroke and the overlay remounts whenever
 * the selection changes, so a deck of nine slides on the same block would
 * otherwise fetch it nine times over. Caching the promise (as the board's
 * preview loader already does) means simultaneous callers share ONE request
 * rather than racing several.
 *
 * A FAILED fetch is deliberately not remembered. The library is served through
 * the user's own machine, so "not right now" is a normal answer — the desktop
 * app may simply be starting up — and remembering it as "this block is broken"
 * would keep it broken for the life of the page.
 */
import { loadBlock as sharedLoadBlock, forgetBlockDoc } from '@openreel/asset-browser';
import type { SlotSpec } from './document';
import type { CompositionSource } from '../../types/project';

/** A block's document and the holes it declares. */
export interface BlockDocument {
  name: string;
  /** Which tier this NAME actually resolved to, which is not always the tier a
   *  layer was placed from — a user block can start shadowing a starter. */
  tier: 'user' | 'shared' | 'starter';
  html: string;
  /** The block's own slot manifest, keyed by slot name. */
  slots: Record<string, SlotSpec>;
  /** The frame the block was designed at, from its composition root. */
  nativeWidth: number;
  nativeHeight: number;
}

/** A document ready to be prepared, and where its holes were declared. */
export interface ResolvedComposition {
  html: string;
  manifest: Record<string, SlotSpec>;
  /** The tier the block resolved to now. Absent for authored html. */
  tier?: 'user' | 'shared' | 'starter';
  /** Non-fatal things the caller should be able to say out loud. */
  warnings: string[];
}

const cache = new Map<string, Promise<BlockDocument | null>>();

/** `data-width="1080"` on the composition root. A hand-written block declares
 *  neither, and 1920x1080 is the frame this editor's pages are. */
function sizeOf(html: string): { width: number; height: number } {
  const w = /data-width\s*=\s*["'](\d+)["']/.exec(html);
  const h = /data-height\s*=\s*["'](\d+)["']/.exec(html);
  return {
    width: w ? Number(w[1]) : 1920,
    height: h ? Number(h[1]) : 1080,
  };
}

/**
 * Keep only what a slot manifest is allowed to be.
 *
 * This crosses a trust boundary — a shared block is another user's work — and
 * the fields are handed straight to `querySelector` and `style.setProperty`. A
 * slot with a `kind` nothing understands is dropped rather than guessed at,
 * because guessing turns an image url into an element's text content.
 */
function readManifest(raw: unknown): Record<string, SlotSpec> {
  const out: Record<string, SlotSpec> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const kind = String(v.kind ?? 'text');
    if (kind !== 'text' && kind !== 'image' && kind !== 'video' && kind !== 'color') continue;
    const spec: SlotSpec = { kind };
    if (typeof v.sel === 'string' && v.sel) spec.sel = v.sel;
    if (typeof v.var === 'string' && v.var) spec.var = v.var;
    if (typeof v.sample === 'string') spec.sample = v.sample;
    // A slot with a fixed set of answers is drawn as a menu rather than a text
    // box — see `SlotSpec.values`. Strings only, and blanks dropped, because an
    // empty option already exists and means "leave it alone".
    if (Array.isArray(v.values)) {
      const values = v.values.filter((x): x is string => typeof x === 'string' && !!x.trim());
      if (values.length) spec.values = values;
    }
    out[key] = spec;
  }
  return out;
}

/**
 * Fetch one block by name.
 *
 * THE FETCH ITSELF IS SHARED — `@openreel/asset-browser`.
 *
 * There were three copies of "read a block from `POST /api/studio/blocks`" in
 * this repo: the board's live preview, the video editor's, and this one. They
 * agreed today and would not have agreed for long; the manifest half in
 * particular is easy to get subtly wrong, and a block that renders its
 * designer's sample content instead of the user's words looks like it works.
 *
 * So the network call, its cache and its retry rule live in one place. What
 * stays HERE is the part only this editor needs: the manifest shaped into
 * `SlotSpec`s and the native size named the way the canvas names it.
 */
export async function loadBlock(name: string): Promise<BlockDocument | null> {
  const key = String(name ?? '').trim();
  if (!key) return null;
  const hit = cache.get(key);
  if (hit) return hit;

  const req = (async (): Promise<BlockDocument | null> => {
    const doc = await sharedLoadBlock(key);
    if (!doc) return null;
    /**
     * THE SIZE IS RE-DERIVED HERE, and that is not redundancy.
     *
     * A block that declares `data-width`/`data-height` gets the same answer
     * either way. One that declares NEITHER — a hand-written composition — is a
     * host decision: this editor's pages are landscape frames, so it assumes
     * 1920x1080, while the board (which the shared loader defaults for) is
     * making 1080x1920 video. Taking the shared default would silently turn
     * every hand-written slide portrait.
     */
    const size = sizeOf(doc.html);
    return {
      name: doc.name,
      tier: doc.tier,
      html: doc.html,
      slots: readManifest(doc.slots),
      nativeWidth: size.width,
      nativeHeight: size.height,
    };
  })();

  cache.set(key, req);
  void req.then((doc) => { if (!doc) cache.delete(key); });
  return req;
}

/**
 * Forget a cached block, so a re-save is picked up without a reload.
 *
 * BOTH caches. The fetch is shared now (`@openreel/asset-browser`), so clearing
 * only this map would leave the shared one serving the old document — which
 * reads as the save having failed.
 */
export function forgetBlock(name: string): void {
  const key = String(name ?? '').trim();
  cache.delete(key);
  forgetBlockDoc(key);
}

/**
 * Turn a layer's stored source into a document plus its manifest.
 *
 * Returns null when there is nothing to render at all. A block that has since
 * moved tier is NOT an error — the design still exists and still renders — but
 * it is worth saying, because a user block that starts shadowing a starter is a
 * slide that quietly becomes a different design.
 */
export async function resolveComposition(
  source: CompositionSource,
): Promise<ResolvedComposition | null> {
  /**
   * Authored html wins over a block name.
   *
   * A composition that carries its own document has been edited away from
   * whatever block it started as; re-fetching the block would silently throw
   * that editing away. Authored html declares no manifest, so the Inspector
   * falls back to the keys already filled.
   */
  if (typeof source.inlineHtml === 'string' && source.inlineHtml.trim()) {
    return { html: source.inlineHtml, manifest: {}, warnings: [] };
  }

  const name = String(source.block ?? '').trim();
  if (!name) return null;

  const doc = await loadBlock(name);
  if (!doc) return null;

  const warnings: string[] = [];
  if (source.tier && source.tier !== doc.tier) {
    warnings.push(
      `"${name}" was placed from the ${source.tier} library and now resolves to the ${doc.tier} one, `
      + 'so this may be a different design under the same name.',
    );
  }
  return { html: doc.html, manifest: doc.slots, tier: doc.tier, warnings };
}
