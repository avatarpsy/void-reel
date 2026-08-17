// image-generation.ts
// -----------------------------------------------------------------------------
// Text-to-image generation for the editor, reusing the Voidspace Studio's
// proven `/api/studio/gen-frame` endpoint (prompt + reference image URLs +
// aspect ratio + model; auth + credit-billed) and the `/api/studio/models`
// catalog. This is the same generation stack the video editor's image-gen
// popup uses — the editor just presents it as "Generate Image" and drops the
// result on a new layer or a new page (carousel slide).
//
// Reference images (context images) must be PUBLIC URLs the gen-frame server
// can fetch. Project assets are base64 dataURLs and Library items are
// auth-gated `/api/studio/local-asset` URLs, so we upload them to a public
// temp URL first (exactly like Generative Fill does) before sending.
// -----------------------------------------------------------------------------

import { getVoidspaceIdToken, NotSignedInError, withMediaToken, type VoidspaceLibraryItem } from './voidspace-storage';
import { uploadReferenceImage } from './generative-fill';
import type { CanvasSize } from '../types/project';

/** Generation failure classified by HTTP status ONLY (never surface server
 *  text). 402 = user out of credits, 403 = premium/locked model, 503/429 =
 *  provider busy, else = generic. Mirrors GenFillError. */
export class ImageGenError extends Error {
  code: number;
  available?: number;
  required?: number;
  /** For 403 (locked model) — the model that needs a plan. */
  upgrade?: boolean;
  constructor(code: number, info: { available?: number; required?: number; upgrade?: boolean } = {}) {
    super(`image-gen ${code}`);
    this.name = 'ImageGenError';
    this.code = code;
    this.available = info.available;
    this.required = info.required;
    this.upgrade = info.upgrade;
  }
}

// ─────────────────────────── Model catalog ───────────────────────────

export interface ImageModel {
  id: string;
  label: string;
  description?: string;
  aspectRatios?: string[];
  resolutions?: string[];
  /** Credits for a default (1K) call — from registry publicView. */
  defaultCallCredits?: number;
  priceLabel?: string;
  /** Billed surcharge per EXTRA input image (first free). 0 for most models;
   *  Seedream 5 Pro charges a small amount per additional context image. */
  perRefImageCredits?: number;
  /** Max reference images this model accepts. */
  maxRefs: number;
  /** Premium model the current (unsubscribed) user can't use. */
  locked?: boolean;
  requiresPlan?: string | null;
}

export interface ImageModelCatalog {
  models: ImageModel[];
  /** DEFAULT_MODELS.image — the free-tier-safe default to preselect. */
  defaultModelId: string;
  subscribed: boolean;
}

/** Fetch the image model catalog (same source the Studio Settings popup uses).
 *  Best-effort: falls back to a minimal built-in list so the popup still works
 *  when signed out or the endpoint is unavailable. */
export async function fetchImageModels(): Promise<ImageModelCatalog> {
  const fallback: ImageModelCatalog = {
    models: [{ id: 'gpt-image-2-text-to-image', label: 'OpenAI GPT Image 2', maxRefs: 4, defaultCallCredits: 6, aspectRatios: ['1:1', '9:16', '16:9', '4:3', '3:4'] }],
    defaultModelId: 'gpt-image-2-text-to-image',
    subscribed: false,
  };
  try {
    const token = await getVoidspaceIdToken();
    const res = await fetch('/api/studio/models?category=image', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return fallback;
    const j = await res.json();
    const models: ImageModel[] = (Array.isArray(j.models) ? j.models : []).map((m: any) => ({
      id: m.id,
      label: m.label ?? m.id,
      description: m.description,
      aspectRatios: Array.isArray(m.aspectRatios) ? m.aspectRatios : undefined,
      resolutions: Array.isArray(m.resolutions) ? m.resolutions : undefined,
      defaultCallCredits: typeof m.defaultCallCredits === 'number' ? m.defaultCallCredits : undefined,
      priceLabel: m.priceLabel,
      perRefImageCredits: typeof m.perRefImageCredits === 'number' ? m.perRefImageCredits : 0,
      maxRefs: m?.capabilities?.refImages?.max ?? 0,
      locked: m.locked === true,
      requiresPlan: m.requiresPlan ?? null,
    }));
    if (!models.length) return fallback;
    return {
      models,
      defaultModelId: j?.defaults?.image || 'gpt-image-2-text-to-image',
      subscribed: j?.subscribed === true,
    };
  } catch {
    return fallback;
  }
}

// ─────────────────────────── Generation ───────────────────────────

export interface GenerateImageOpts {
  prompt: string;
  aspectRatio: string;
  model: string;
  /** Public URLs of already-uploaded context/reference images. */
  referenceUrls?: string[];
  resolution?: string;
}

async function throwImageGenError(res: Response): Promise<never> {
  let available: number | undefined;
  let required: number | undefined;
  let upgrade = false;
  try {
    const j = await res.json();
    available = j?.data?.available ?? j?.available;
    required = j?.data?.required ?? j?.required;
    upgrade = j?.data?.upgrade === true;
  } catch { /* ignore */ }
  throw new ImageGenError(res.status, { available, required, upgrade });
}

async function fetchAsDataUrl(url: string): Promise<string> {
  const imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error(`fetch result failed (${imgRes.status})`);
  const blob = await imgRes.blob();
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Generate one image via gen-frame. Returns the result as a data URL. */
export async function generateStudioImage(opts: GenerateImageOpts): Promise<string> {
  const token = await getVoidspaceIdToken();
  if (!token) throw new NotSignedInError();

  const res = await fetch('/api/studio/gen-frame', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: opts.prompt,
      aspectRatio: opts.aspectRatio,
      model: opts.model,
      resolution: opts.resolution,
      referenceImages: opts.referenceUrls && opts.referenceUrls.length ? opts.referenceUrls : undefined,
    }),
  });
  if (!res.ok) await throwImageGenError(res);
  const j = await res.json();
  const resultUrl: string = j.url;
  if (!resultUrl) throw new Error('Image generation returned no image');
  return fetchAsDataUrl(resultUrl);
}

/**
 * Seedream 5 Pro layer separation: send a composite image (public URL) and get
 * back N image URLs, one per separated layer. Classify failures like
 * generation (402 credits / 403 locked / 503 busy). Returns the raw result URLs
 * (the caller fetches each via the media-proxy and imports it as a layer).
 */
export async function separateLayers(opts: { imageUrl: string; prompt?: string; resolution?: string; aspectRatio?: string }): Promise<string[]> {
  const token = await getVoidspaceIdToken();
  if (!token) throw new NotSignedInError();
  const res = await fetch('/api/studio/seedream-layers', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl: opts.imageUrl, prompt: opts.prompt, resolution: opts.resolution, aspectRatio: opts.aspectRatio }),
  });
  if (!res.ok) await throwImageGenError(res);
  const j = await res.json();
  const urls: string[] = Array.isArray(j.urls) ? j.urls.filter((u: any) => typeof u === 'string' && u) : [];
  if (!urls.length) throw new Error('Layer separation returned no images');
  return urls;
}

/** Credit situation for the out-of-credits popup (subscribed → top up). */
export async function fetchCreditSituation(): Promise<{ isSubscribed: boolean }> {
  try {
    const token = await getVoidspaceIdToken();
    if (!token) return { isSubscribed: false };
    const res = await fetch('/api/me/subscription-status', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { isSubscribed: false };
    const j = await res.json();
    return { isSubscribed: j?.isSubscribed === true };
  } catch {
    return { isSubscribed: false };
  }
}

// ─────────────────────────── Avatar context ───────────────────────────

export interface AvatarContext {
  id: string;
  name: string;
  imageUrl: string;
  images: { url: string; name?: string; description?: string }[];
}

/** List the user's avatars with their curated context images (for the
 *  "Avatars" source in the context-image picker). Best-effort → []. */
export async function fetchAvatarContext(): Promise<AvatarContext[]> {
  try {
    const token = await getVoidspaceIdToken();
    if (!token) return [];
    const res = await fetch('/api/studio/avatar-context', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const j = await res.json();
    if (!Array.isArray(j.avatars)) return [];
    // The route also lists avatars that have only a voice sample, because the
    // web Add-media picker offers voice as well. This is an IMAGE reference
    // picker: such an avatar would draw its name over an empty grid.
    return (j.avatars as AvatarContext[]).filter((a) => Array.isArray(a.images) && a.images.length > 0);
  } catch {
    return [];
  }
}

// ─────────────────── Context-image → public URL resolvers ───────────────────

function dataUrlToFile(dataUrl: string, name: string): File {
  const [head, b64] = dataUrl.split(',');
  const mime = /data:([^;]+)/.exec(head)?.[1] || 'image/png';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name || 'reference.png', { type: mime });
}

/** Upload a base64 dataURL (a project asset) → public URL for gen-frame. */
export async function uploadReferenceFromDataUrl(dataUrl: string, name: string): Promise<string> {
  return uploadReferenceImage(dataUrlToFile(dataUrl, name));
}

/** Fetch a Library image's bytes (auth-gated) → upload → public URL. */
export async function uploadReferenceFromLibraryItem(item: VoidspaceLibraryItem, token: string | null): Promise<string> {
  const res = await fetch(withMediaToken(item.url, token));
  if (!res.ok) throw new Error(`fetch library image (${res.status})`);
  const blob = await res.blob();
  const file = new File([blob], (item.label || 'reference') + '.png', { type: blob.type || 'image/png' });
  return uploadReferenceImage(file);
}

// ─────────────────────────── Aspect helpers ───────────────────────────

/** Canonical pixel sizes for each named aspect ratio (long edge ~1080-1920). */
const ASPECT_SIZES: Record<string, CanvasSize> = {
  '1:1': { width: 1080, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  '5:4': { width: 1350, height: 1080 },
  '4:3': { width: 1440, height: 1080 },
  '3:4': { width: 1080, height: 1440 },
  '3:2': { width: 1620, height: 1080 },
  '2:3': { width: 1080, height: 1620 },
  '21:9': { width: 1920, height: 823 },
};

/** Convert an aspect-ratio string to a concrete canvas size (for new pages). */
export function aspectRatioToSize(aspect: string): CanvasSize {
  const preset = ASPECT_SIZES[aspect];
  if (preset) return preset;
  // Parse "w:h" and fit within a 1536 long edge.
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect);
  if (m) {
    const w = parseFloat(m[1]);
    const h = parseFloat(m[2]);
    if (w > 0 && h > 0) {
      const long = 1536;
      return w >= h
        ? { width: long, height: Math.round((long * h) / w) }
        : { width: Math.round((long * w) / h), height: long };
    }
  }
  return { width: 1080, height: 1080 };
}

/** Pick the supported aspect-ratio string closest to a width×height, so the
 *  Generate popup defaults to the current artboard's shape. */
export function sizeToAspectRatio(width: number, height: number, supported: string[]): string {
  const target = width / height;
  const candidates = (supported && supported.length ? supported : Object.keys(ASPECT_SIZES))
    .filter((a) => /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(a));
  let best = candidates[0] || '1:1';
  let bestDiff = Infinity;
  for (const a of candidates) {
    const [w, h] = a.split(':').map(Number);
    const ratio = w / h;
    const diff = Math.abs(ratio - target);
    if (diff < bestDiff) { bestDiff = diff; best = a; }
  }
  return best;
}

/** Friendly labels for the aspect chips shown in the popup. */
export const ASPECT_LABELS: Record<string, string> = {
  '1:1': 'Post',
  '9:16': 'Story',
  '16:9': 'Thumbnail',
  '4:5': 'Portrait',
  '4:3': 'Landscape',
  '3:4': 'Tall',
};
