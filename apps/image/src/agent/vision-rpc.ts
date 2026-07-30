/**
 * The agent's EYES on the canvas — render and measure.
 *
 * A timeline describes itself; a picture does not. So the image agent gets two
 * distinct ways to look, and the split is a cost decision as much as a design one:
 *
 *   • `img-measure` — LOCAL pixel math. Free, exact, instant. Contrast ratios,
 *     dominant colours, how much of a region is transparent. This answers most
 *     design questions ("will white text read on that photo?") without spending
 *     a credit, which is why it exists at all.
 *
 *   • `img-render` — composites the page (or a region, or one isolated layer) and
 *     uploads it, returning a URL. Free by itself. Only when the agent then calls
 *     the shared `inspect_media` on that URL does a vision model — and a charge —
 *     get involved.
 *
 * Keeping these apart is what stops the agent burning a vision call to count
 * layers, and stops it claiming the artwork looks right when all it ever read was
 * a layer list.
 */

import { useProjectStore } from '../stores/project-store';
import { exportArtboard } from '../services/export-service';
import { uploadReferenceImage } from '../services/generative-fill';
import { NotSignedInError } from '../services/voidspace-storage';
import { registerImageRpc } from './rpc';
import type { Artboard, Project } from '../types/project';

/** Longest side we ever render for the agent. A vision model gains nothing from
 *  4K and everything upstream (upload, provider fetch, token cost) suffers. */
const MAX_VIEW_PX = 1536;

function resolvePage(project: Project, pageId?: string): Artboard | null {
  if (pageId) return project.artboards.find((a) => a.id === pageId) ?? null;
  const activeId = useProjectStore.getState().selectedArtboardId;
  return project.artboards.find((a) => a.id === activeId) ?? project.artboards[0] ?? null;
}

/** Composite one page to a canvas at a sane review size. */
async function renderPageCanvas(
  project: Project,
  page: Artboard,
  opts: { maxPx?: number; hideLayerIds?: string[] } = {},
): Promise<HTMLCanvasElement> {
  const maxPx = Math.min(opts.maxPx ?? MAX_VIEW_PX, MAX_VIEW_PX);
  const longest = Math.max(page.size.width, page.size.height) || 1;
  const scale = Math.min(1, maxPx / longest);

  const blob = await exportArtboard(project, page, {
    format: 'png',
    quality: 'high',
    scale,
    background: 'include',
  });

  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return canvas;
}

function cropCanvas(
  src: HTMLCanvasElement,
  region: { x: number; y: number; width: number; height: number },
  pageSize: { width: number; height: number },
): HTMLCanvasElement {
  // The agent speaks in ARTBOARD pixels; the render may be scaled down. Map once,
  // here, so no caller has to think about it.
  const sx = src.width / pageSize.width;
  const sy = src.height / pageSize.height;
  const x = Math.max(0, Math.round(region.x * sx));
  const y = Math.max(0, Math.round(region.y * sy));
  const w = Math.max(1, Math.min(src.width - x, Math.round(region.width * sx)));
  const h = Math.max(1, Math.min(src.height - y, Math.round(region.height * sy)));

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d')!.drawImage(src, x, y, w, h, 0, 0, w, h);
  return out;
}

function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas encode failed'))), type, 0.92);
  });
}

// ── Colour maths ────────────────────────────────────────────────────────────
//
// sRGB relative luminance + WCAG contrast. Used so "is this legible?" has a real
// answer instead of the agent's impression of a thumbnail.

function relativeLuminance(r: number, g: number, b: number): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(...a);
  const lb = relativeLuminance(...b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

interface RegionStats {
  meanColor: string;
  meanRgb: [number, number, number];
  /** 0-1. High values mean a busy region — text over it needs a scrim. */
  contrastVariance: number;
  /** Fraction of fully/partly transparent pixels. */
  transparency: number;
  /** Most common colours, coarsely bucketed, most frequent first. */
  palette: Array<{ hex: string; share: number }>;
}

function analyseRegion(canvas: HTMLCanvasElement): RegionStats {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;

  // Sample rather than read every pixel: a 1536² region is 2.4M pixels and the
  // answer does not change. Stride keeps this ~O(10k) samples at any size.
  const totalPx = width * height;
  const stride = Math.max(1, Math.floor(Math.sqrt(totalPx / 10_000)));

  let rs = 0, gs = 0, bs = 0, n = 0, transparent = 0;
  const buckets = new Map<string, number>();
  const lums: number[] = [];

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      n++;
      if (a < 250) transparent++;
      if (a === 0) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      rs += r; gs += g; bs += b;
      lums.push(relativeLuminance(r, g, b));
      // 32-level buckets: enough to name a colour, coarse enough that a photo
      // doesn't produce 10k unique "colours".
      const key = `${r >> 5}-${g >> 5}-${b >> 5}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
  }

  const opaque = Math.max(1, n - transparent);
  const mean: [number, number, number] = [rs / opaque, gs / opaque, bs / opaque];

  const meanLum = lums.reduce((s, v) => s + v, 0) / Math.max(1, lums.length);
  const variance = lums.reduce((s, v) => s + (v - meanLum) ** 2, 0) / Math.max(1, lums.length);

  const palette = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => {
      const [r, g, b] = key.split('-').map((v) => Number(v) * 32 + 16);
      return { hex: toHex(r, g, b), share: Math.round((count / opaque) * 100) / 100 };
    });

  return {
    meanColor: toHex(...mean),
    meanRgb: [Math.round(mean[0]), Math.round(mean[1]), Math.round(mean[2])],
    contrastVariance: Math.round(variance * 1000) / 1000,
    transparency: Math.round((transparent / Math.max(1, n)) * 100) / 100,
    palette,
  };
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// ── RPCs ────────────────────────────────────────────────────────────────────

registerImageRpc('voidspace:img-render', async (msg: any) => {
  const project = useProjectStore.getState().project;
  if (!project) return { ok: false, reason: 'no_project', message: 'No image project is open.' };

  const page = resolvePage(project, msg?.pageId);
  if (!page) return { ok: false, reason: 'page_not_found', message: `No page with id ${msg?.pageId}` };

  try {
    let canvas = await renderPageCanvas(project, page, { maxPx: msg?.maxPx });
    if (msg?.region) {
      canvas = cropCanvas(canvas, msg.region, page.size);
    }
    const blob = await canvasToBlob(canvas);
    const file = new File([blob], `view-${page.id}.png`, { type: 'image/png' });
    // Upload rather than returning a data URL: a 1536² PNG is megabytes of
    // base64, which would blow the tool-result budget AND the saved transcript.
    // A URL also lets the vision provider fetch it directly.
    const url = await uploadReferenceImage(file);
    return {
      ok: true,
      url,
      pageId: page.id,
      width: canvas.width,
      height: canvas.height,
      pageWidth: page.size.width,
      pageHeight: page.size.height,
      note: 'Pass this url to inspect_media to actually look at it. Rendering is free; inspecting costs credits.',
    };
  } catch (err) {
    if (err instanceof NotSignedInError) {
      return { ok: false, reason: 'not_signed_in', message: 'Sign in to Voidspace to let the assistant view the canvas.' };
    }
    throw err;
  }
});

registerImageRpc('voidspace:img-measure', async (msg: any) => {
  const project = useProjectStore.getState().project;
  if (!project) return { ok: false, reason: 'no_project', message: 'No image project is open.' };

  const page = resolvePage(project, msg?.pageId);
  if (!page) return { ok: false, reason: 'page_not_found', message: `No page with id ${msg?.pageId}` };

  const canvas = await renderPageCanvas(project, page, { maxPx: msg?.maxPx ?? 1024 });

  // A named layer's own box is the usual question ("is my headline readable?"),
  // so accept a layerId as shorthand for its bounds.
  let region = msg?.region;
  if (!region && msg?.layerId) {
    const layer = project.layers[msg.layerId];
    if (!layer) return { ok: false, reason: 'layer_not_found', message: `No layer with id ${msg.layerId}` };
    region = {
      x: layer.transform.x, y: layer.transform.y,
      width: layer.transform.width, height: layer.transform.height,
    };
  }

  const target = region ? cropCanvas(canvas, region, page.size) : canvas;
  const stats = analyseRegion(target);

  // Optional legibility verdict against a specific ink colour.
  let legibility: Record<string, unknown> | undefined;
  const ink = msg?.againstColor ? parseHex(msg.againstColor) : null;
  if (ink) {
    const ratio = contrastRatio(ink, stats.meanRgb);
    legibility = {
      againstColor: toHex(...ink),
      contrastRatio: ratio,
      // WCAG thresholds — the standard everyone already agrees on, rather than
      // an opinion the agent makes up per image.
      passesBodyText: ratio >= 4.5,
      passesLargeText: ratio >= 3,
      // A high-variance (busy) background defeats a good average ratio: the mean
      // can look fine while the text crosses both a bright and a dark area.
      busyBackground: stats.contrastVariance > 0.05,
      advice: ratio < 3
        ? 'Too low — change the text colour, or put a scrim/solid shape behind it.'
        : stats.contrastVariance > 0.05
          ? 'Average contrast is acceptable but the background is busy; add a scrim behind the text.'
          : 'Contrast is fine.',
    };
  }

  return {
    ok: true,
    pageId: page.id,
    region: region ?? { x: 0, y: 0, width: page.size.width, height: page.size.height },
    ...stats,
    ...(legibility ? { legibility } : {}),
  };
});

export {};
