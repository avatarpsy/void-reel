/**
 * Turning a placed composition into pixels.
 *
 * ── WHY A COMPOSITION LAYER IS EMPTY UNTIL THIS RUNS ────────────────────────
 * `img-place-composition` creates an image layer that carries NO asset: a block
 * is an HTML document, and rasterising one in the browser was measured to taint
 * the canvas outright (a `foreignObject` does, even holding one plain div with
 * no external reference). So the pixels have to come from a real browser
 * elsewhere — the user's own machine, through `render-hyperframes` → the desktop
 * app's `render_composition`.
 *
 * Until they arrive the live frame over the canvas is all there is, and a live
 * frame can only ever show ONE composition: the selected one, on the open page.
 * Measured on a five-slide deck with nothing baked — every other slide blank
 * white, all five page thumbnails byte-identical blank JPEGs, `img_view`
 * returning an empty render, and an export that would have been empty too. The
 * deck could be built and not presented.
 *
 * ── WHY IT IS KEYED ON A HASH AND NOT A FLAG ────────────────────────────────
 * A slot edit changes the picture, so "has pixels" is not the question — "has
 * pixels OF THIS" is. `compositionHash` folds in every input that can change a
 * pixel (block, slots, fill mode, frame, pose, authored html by hash), and the
 * hash of what was rendered is stored on the layer. Re-baking is therefore
 * automatic when the words change and free when they have not.
 */
import { useProjectStore } from '../../stores/project-store';
import { getVoidspaceIdToken, libraryImageToAsset } from '../voidspace-storage';
import { compositionHash, needsRerender } from './hash';
import { resolveComposition } from './block-source';
import type { ImageLayer } from '../../types/project';

/** One bake per layer at a time. The agent places, reads and re-reads in quick
 *  succession, and a second render of the same thing is a minute of the user's
 *  own machine spent to produce a duplicate. */
const inflight = new Map<string, Promise<BakeResult>>();

/**
 * Bakes that already failed, keyed by WHAT was being rendered.
 *
 * A render is tens of seconds of the user's own machine. Without this, a failure
 * that is going to repeat — a desktop app too old to render a still, a block that
 * no longer resolves — is retried on every place and every project load, so a
 * five-slide deck spends five minutes of somebody's laptop producing nothing,
 * over and over. Keyed by the composition hash rather than the layer, so editing
 * the words is a genuinely new attempt and gets one.
 *
 * Session-scoped on purpose: a reload is a reasonable moment to try again, and
 * whatever was wrong (the app was shut) may well have been fixed since.
 */
const failedKeys = new Set<string>();

/** A still is an IMAGE. Anything else came back from a renderer that did not
 *  understand the request. */
const IMAGE_URL = /\.(png|jpe?g|webp)(\?|$)/i;

/**
 * THE RENDERER STRIPS THE COMPOSITION'S OWN BACKGROUND, SO WE PUT IT BACK.
 *
 * Measured against the real renderer: a block whose root carries
 * `background: var(--bg, #0A0A12)` comes back with that area at rgba(0,0,0,0),
 * while a plain child with a literal colour comes back opaque. It is deliberate
 * — a composition is built to composite OVER footage, so its root background is
 * removed and the frame is written RGBA.
 *
 * That is right for a lower third and wrong for a slide. Left transparent, the
 * still is drawn over whatever the artboard happens to be — white, by default —
 * so a dark deck came out as white thumbnails with a few pale words on them,
 * while the canvas looked correct because the canvas shows the LIVE frame.
 *
 * The colour to restore is the block's own: the `bg` slot when the deck was
 * themed, otherwise the fallback the block's own CSS declares.
 */
export function backgroundFor(slots: Record<string, string> | undefined, html: string): string | null {
  const fromSlot = String(slots?.bg ?? '').trim();
  if (/^#[0-9a-f]{3,8}$/i.test(fromSlot)) return fromSlot;
  // `var(--bg, #0A0A12)` — the designer's own answer to "what is behind this".
  const declared = /var\(\s*--bg\s*,\s*(#[0-9a-f]{3,8})\s*\)/i.exec(html);
  return declared ? declared[1] : null;
}

/**
 * Draw the render onto an opaque ground and hand back a data URL.
 *
 * The bytes are FETCHED rather than handed to `new Image(src)`. The render lives
 * behind `/api/studio/local-asset`, which wants an Authorization header — and an
 * `<img>` cannot send one. Worse, `crossOrigin = 'anonymous'` also suppresses
 * cookies, so the load simply failed and every still quietly took the unflattened
 * fallback path instead. A fetch carries the token and a blob URL is same-origin,
 * so the canvas stays untainted.
 */
async function flatten(url: string, background: string, token: string | null): Promise<{ dataUrl: string; width: number; height: number } | null> {
  let blobUrl = '';
  try {
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return null;
    blobUrl = URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
  try {
    return await drawOnto(blobUrl, background);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function drawOnto(src: string, background: string): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = src;
  });
  if (!img || !img.naturalWidth) return null;
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

export interface BakeResult {
  ok: boolean;
  layerId: string;
  assetId?: string;
  /** Plain enough to show a user: they are the ones who can start the app. */
  reason?: 'no_composition' | 'up_to_date' | 'already_failed' | 'device_unavailable' | 'render_failed';
  message?: string;
}

/**
 * Does this layer's picture still need making?
 *
 * Exported for the sweep below and for tests: "when do we spend a render" is the
 * decision worth pinning, not the fetch around it.
 */
export function shouldBake(layer: ImageLayer | undefined): boolean {
  if (!layer || layer.type !== 'image' || !layer.composition) return false;
  // No pixels at all — the case this whole module exists for.
  if (!layer.sourceId) return true;
  // Pixels, but of an older version of the words.
  return needsRerender(layer.composition);
}

export async function bakeComposition(layerId: string): Promise<BakeResult> {
  const existing = inflight.get(layerId);
  if (existing) return existing;

  const run = (async (): Promise<BakeResult> => {
    const project = useProjectStore.getState().project;
    const layer = project?.layers[layerId] as ImageLayer | undefined;
    const source = layer?.composition;
    if (!layer || layer.type !== 'image' || !source) {
      return { ok: false, layerId, reason: 'no_composition' };
    }
    if (!shouldBake(layer)) return { ok: true, layerId, reason: 'up_to_date' };

    const key = compositionHash(source);
    if (failedKeys.has(key)) {
      return { ok: false, layerId, reason: 'already_failed' };
    }
    const failed = (message: string, reason: BakeResult['reason'] = 'render_failed'): BakeResult => {
      failedKeys.add(key);
      return { ok: false, layerId, reason, message };
    };

    const width = Math.round(source.frameWidth || layer.transform.width || 1920);
    const height = Math.round(source.frameHeight || layer.transform.height || 1080);

    let res: Response;
    try {
      const token = await getVoidspaceIdToken().catch(() => null);
      res = await fetch('/api/studio/render-hyperframes', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          ...(source.block ? { block: source.block } : {}),
          ...(source.inlineHtml ? { html: source.inlineHtml } : {}),
          slots: source.slots ?? {},
          format: 'png',
          width,
          height,
          name: layer.name,
        }),
      });
    } catch (e: any) {
      return failed(String(e?.message ?? e));
    }

    if (!res.ok) return failed(`the renderer returned ${res.status}`);
    const json: any = await res.json().catch(() => null);

    /**
     * NO DESKTOP APP IS NOT A FAILURE, it is a state with an obvious remedy, and
     * it must NOT be remembered: the user starts the app and the very next
     * attempt should work. The live frame still shows the design meanwhile, so
     * the editor stays usable — what they cannot do yet is export.
     */
    if (json?.deviceUnavailable) {
      return {
        ok: false,
        layerId,
        reason: 'device_unavailable',
        message: 'Open the Voidspace desktop app to render this slide — it renders on your own machine.',
      };
    }

    const url = typeof json?.url === 'string' ? json.url : '';
    if (!url) return failed('the render produced no file');
    /**
     * A desktop app older than the `png` format renders an MP4 instead and
     * returns it perfectly happily. Loading that as a picture fails a minute
     * later with nothing to show for the fans spinning up, so name the real
     * problem and stop asking.
     */
    if (!IMAGE_URL.test(url)) {
      return failed('This version of the Voidspace desktop app cannot render a slide to an image yet — update it.');
    }

    let asset: any = null;
    try {
      // Put the background back before this becomes pixels anybody looks at.
      const token = await getVoidspaceIdToken().catch(() => null);
      const resolved = await resolveComposition(source).catch(() => null);
      const background = backgroundFor(source.slots, resolved?.html ?? '');
      const flat = background ? await flatten(url, background, token) : null;
      if (flat) {
        asset = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: layer.name || 'Composition',
          type: 'image' as const,
          mimeType: 'image/png',
          size: flat.dataUrl.length,
          width: flat.width,
          height: flat.height,
          thumbnailUrl: flat.dataUrl,
          dataUrl: flat.dataUrl,
        };
      } else {
        // No colour to restore, or the flatten failed: the transparent render is
        // still better than no pixels at all.
        asset = await libraryImageToAsset({ url, name: layer.name } as any, token);
      }
    } catch (e: any) {
      return failed(`could not load the render: ${e?.message ?? e}`);
    }
    if (!asset) return failed('could not load the render');

    const store = useProjectStore.getState();
    // The layer may have been deleted, or its words edited, while the render ran.
    const still = store.project?.layers[layerId] as ImageLayer | undefined;
    if (!still || !still.composition) return { ok: false, layerId, reason: 'no_composition' };

    if (!store.project!.assets[asset.id]) store.addAsset(asset as any);
    store.updateLayer<ImageLayer>(layerId, {
      sourceId: asset.id,
      // Stamp what was RENDERED, not what is current: if the slots changed while
      // this was in flight, the next sweep must see that and render again.
      composition: { ...still.composition, renderHash: key },
    });
    return { ok: true, layerId, assetId: asset.id };
  })();

  inflight.set(layerId, run);
  void run.catch(() => undefined).then(() => inflight.delete(layerId));
  return run;
}

/**
 * Bake everything on the project that is missing or stale.
 *
 * Serial on purpose. Each render is a browser starting on the user's machine, and
 * five at once is five Chromes — the thing that makes a laptop audibly unhappy
 * and finishes no sooner.
 */
export async function bakePendingCompositions(): Promise<BakeResult[]> {
  const project = useProjectStore.getState().project;
  if (!project) return [];
  const pending = Object.values(project.layers)
    .filter((l): l is ImageLayer => shouldBake(l as ImageLayer))
    .map((l) => l.id);

  const out: BakeResult[] = [];
  for (const id of pending) {
    const r = await bakeComposition(id);
    out.push(r);
    /**
     * One shut desktop app means every remaining render fails the same way.
     * Report it once rather than five times, and stop — the alternative is five
     * timeouts before the user is told the one thing they can act on.
     */
    if (r.reason === 'device_unavailable') break;
  }
  return out;
}

/**
 * WAIT FOR EVERY PICTURE, INCLUDING THE ONES ALREADY BEING MADE.
 *
 * `bakePendingCompositions` asks `shouldBake`, which answers "does this layer
 * NEED a render" — and a layer whose render is already running does not. So a
 * sweep run moments after a placement skipped the very layer that was still
 * being drawn, returned immediately, and the export went ahead without it.
 *
 * That is the whole of the dropped-slide bug, and it survived a first fix that
 * awaited the sweep alone: measured after deploying that, an export five
 * seconds after placing still came back `dropped: ["deck-close"]`, while the
 * same export a minute later was clean. The sweep was running and correctly
 * finding nothing to do.
 *
 * So both halves are awaited here: the bakes nobody has started, and the bakes
 * already in flight. The loop matters — finishing one can leave another queued
 * behind it — and it is bounded so a render that never settles cannot hold an
 * export open for ever.
 */
export async function settleCompositions(): Promise<void> {
  for (let pass = 0; pass < 4; pass++) {
    await bakePendingCompositions().catch(() => []);
    if (!inflight.size) return;
    await Promise.allSettled([...inflight.values()]);
  }
}

/** Test seam: forget which bakes failed, as a reload would. */
export function resetBakeFailures(): void {
  failedKeys.clear();
}
