/**
 * Keep a piece of the canvas — in the user's own media library.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The whole point of generating a graphic, cutting the background off it and
 * slicing it into parts is that the PARTS are worth keeping: reused in the next
 * deck, dropped into a video, eventually bundled and sold. Everything
 * downstream of that was already built — one library read by every editor and
 * every agent, sha256 dedupe, ownership, and a marketplace pack flow that
 * curates your own assets — and nothing produced assets for it. There was no
 * path, by hand or by asking, that turned part of a canvas into a library item.
 *
 * ── WHY IT GOES THROUGH THE SHARED UPLOADER ──────────────────────────────────
 * `uploadToLibrary` is the same call the Assets panel, the video editor's Add
 * and the board all make, and it lands on `POST /api/media-library/upload`,
 * which already does every part that is easy to get wrong:
 *
 *   • hashes the bytes and DEDUPES — saving the same crop twice is one asset;
 *   • writes the library's real layout and appends to BOTH the catalog and the
 *     per-kind index, so the file is findable and not merely stored;
 *   • claims ownership as PRIVATE to the uploader, licence `user-upload` with
 *     redistributable UNKNOWN — the resale claim stays the user's to make;
 *   • meters the bytes against their storage quota, and refuses over it.
 *
 * Re-implementing any of that here would produce a second library with
 * different rules, which is the failure the shared uploader exists to prevent.
 * A saved crop is therefore an ordinary library asset from the moment it lands,
 * indistinguishable from one the user uploaded themselves.
 */
import { renderLayersToDataURL } from './export-service';
import type { Artboard, Project } from '../types/project';

export interface SaveRegion { x: number; y: number; width: number; height: number }

export interface SaveToLibraryOptions {
  /** Which layers to draw, topmost first. Omit for every visible layer. */
  layerIds?: string[];
  /** Artboard-space rectangle to cut out. Omit for the whole page. */
  region?: SaveRegion;
  /**
   * Shrink to the pixels that are actually inked.
   *
   * This is what makes "cut the background off, then keep the pieces" work
   * without measuring anything: after a background removal the interesting
   * shape sits inside a page-sized rectangle of transparency, and saving that
   * rectangle keeps mostly nothing.
   */
  trim?: boolean;
  /** File name stem. Slugged; the extension is always .png. */
  name?: string;
  /** Pixel multiplier. 1 keeps artboard resolution. */
  scale?: number;
}

/** What the caller gets back — enough to say something true to the user. */
export interface SaveToLibraryResult {
  ok: boolean;
  /** The file name as uploaded, so a reply can name what was saved. */
  fileName: string;
  /** Pixel size actually saved, AFTER any trim. */
  width: number;
  height: number;
  bytes: number;
  /** Set when nothing was saved, and why. */
  reason?: 'empty' | 'no_layers' | 'render_failed' | 'upload_failed';
}

/**
 * A file name that survives a file system and still means something later.
 *
 * Library file names are visible — in the catalog, in search results, in a pack
 * listing — so "layer 3" is a name that costs the user something every time
 * they look for it. Falls back to a stable stem rather than an empty string,
 * because an unnamed file is the one nobody ever finds again.
 */
export function libraryFileName(name: string | undefined, fallback = 'cutout'): string {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || fallback}.png`;
}

/**
 * The smallest rectangle containing every pixel that is not fully transparent.
 *
 * Returns null when the image is entirely transparent — a real answer, and the
 * one that stops an empty PNG being written to somebody's library and counted
 * against their storage.
 *
 * `alphaOver` exists because background removal leaves a faint halo rather than
 * a clean zero. Trimming at alpha > 0 keeps that halo and defeats the trim; a
 * small floor cuts to the shape a person would draw.
 */
export function alphaBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaOver = 8,
): SaveRegion | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= alphaOver) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** The rectangle to render, clamped to the page. */
export function resolveRegion(artboard: Artboard, region?: SaveRegion): SaveRegion {
  const W = artboard.size.width;
  const H = artboard.size.height;
  if (!region) return { x: 0, y: 0, width: W, height: H };
  const x = Math.max(0, Math.min(W - 1, Math.round(region.x)));
  const y = Math.max(0, Math.min(H - 1, Math.round(region.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(W - x, Math.round(region.width))),
    height: Math.max(1, Math.min(H - y, Math.round(region.height))),
  };
}

/**
 * Which layers to draw, in the project's own TOP-FIRST order.
 *
 * Order matters: `renderLayersToDataURL` takes top-first and reverses to paint,
 * so handing it an arbitrary order silently restacks the picture. Filtering the
 * artboard's own list preserves it without the caller having to know.
 */
export function layersToDraw(artboard: Artboard, layerIds?: string[]): string[] {
  if (!layerIds?.length) return [...artboard.layerIds];
  const wanted = new Set(layerIds);
  return artboard.layerIds.filter((id) => wanted.has(id));
}

// ── The DOM half ────────────────────────────────────────────────────────────

/** Draw a data URL into a canvas so its pixels can be measured and cut. */
async function toCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('render did not decode'));
    el.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d')!.drawImage(img, 0, 0);
  return canvas;
}

function crop(source: HTMLCanvasElement, box: SaveRegion): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = box.width;
  out.height = box.height;
  out.getContext('2d')!.drawImage(
    source, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height,
  );
  return out;
}

/**
 * Render part of a page to a PNG canvas.
 *
 * The renderer draws in ARTBOARD coordinates, so cutting a region means moving
 * the layers rather than the camera — the same shift the PowerPoint exporter
 * uses to rasterise one layer, and for the same reason: one renderer, not two.
 */
export async function renderRegionToCanvas(
  project: Project,
  artboard: Artboard,
  opts: SaveToLibraryOptions = {},
): Promise<{ canvas: HTMLCanvasElement; trimmed: boolean } | null> {
  const ids = layersToDraw(artboard, opts.layerIds);
  if (!ids.length) return null;

  const region = resolveRegion(artboard, opts.region);
  const scale = Math.max(0.1, Math.min(4, opts.scale ?? 1));

  const shifted: Project = {
    ...project,
    layers: Object.fromEntries(
      Object.entries(project.layers).map(([id, layer]) => [
        id,
        ids.includes(id)
          ? { ...layer, transform: { ...layer.transform, x: layer.transform.x - region.x, y: layer.transform.y - region.y } }
          : layer,
      ]),
    ) as Project['layers'],
  };

  const dataUrl = await renderLayersToDataURL(
    shifted, ids, Math.round(region.width * scale), Math.round(region.height * scale),
  );
  if (!dataUrl) return null;

  let canvas = await toCanvas(dataUrl);
  let trimmed = false;

  if (opts.trim) {
    const ctx = canvas.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const box = alphaBounds(data, canvas.width, canvas.height);
    // Entirely transparent: the caller reports "nothing to save" rather than
    // writing an empty PNG and charging the user's quota for it.
    if (!box) return null;
    if (box.width !== canvas.width || box.height !== canvas.height) {
      canvas = crop(canvas, box);
      trimmed = true;
    }
  }

  return { canvas, trimmed };
}

/** Minimal shape the shared uploader needs. Matches the Assets panel's. */
export interface LibraryHost { getIdToken: () => Promise<string | null> }

/**
 * Render a region and put it in the user's library.
 *
 * Everything about ownership, dedupe, indexing and storage metering happens on
 * the server, in the one endpoint every other editor already uses.
 */
export async function saveRegionToLibrary(
  project: Project,
  artboard: Artboard,
  opts: SaveToLibraryOptions,
  host: LibraryHost,
  upload: (
    host: LibraryHost, files: File[],
  ) => Promise<{ ok: number; failed: string[] }>,
): Promise<SaveToLibraryResult> {
  const fileName = libraryFileName(opts.name);
  const fail = (reason: SaveToLibraryResult['reason']): SaveToLibraryResult =>
    ({ ok: false, fileName, width: 0, height: 0, bytes: 0, reason });

  if (!layersToDraw(artboard, opts.layerIds).length) return fail('no_layers');

  let rendered: Awaited<ReturnType<typeof renderRegionToCanvas>>;
  try {
    rendered = await renderRegionToCanvas(project, artboard, opts);
  } catch {
    return fail('render_failed');
  }
  // `null` from a trim means every pixel was transparent — see renderRegion.
  if (!rendered) return fail(opts.trim ? 'empty' : 'render_failed');

  const blob = await new Promise<Blob | null>((resolve) => {
    rendered!.canvas.toBlob(resolve, 'image/png');
  });
  if (!blob) return fail('render_failed');

  const file = new File([blob], fileName, { type: 'image/png' });
  const { ok } = await upload(host, [file]).catch(() => ({ ok: 0, failed: [fileName] }));
  if (!ok) return fail('upload_failed');

  return {
    ok: true,
    fileName,
    width: rendered.canvas.width,
    height: rendered.canvas.height,
    bytes: blob.size,
  };
}
