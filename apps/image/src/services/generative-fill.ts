// generative-fill.ts
// -----------------------------------------------------------------------------
// Photoshop-style Generative Fill = TRUE masked inpainting. The caller renders
// the FULL composite + a mask (WHITE = the selected region to regenerate, BLACK
// = keep — FLUX Fill convention) at matching dimensions; we upload both and run
// fal.ai FLUX.1 [dev] Inpainting via /api/studio/gen-fill (authed + billed).
// Only the masked pixels are regenerated, conditioned on the whole image, so it
// blends seamlessly. The editor drops the result on a new layer masked to the
// selection (non-destructive).
// -----------------------------------------------------------------------------

import { getVoidspaceIdToken, NotSignedInError } from './voidspace-storage';

/** Generative-fill failure, classified by HTTP status — NO server/provider text
 *  is carried, so the UI can show clean copy (402 = user out of credits;
 *  503 = our provider is temporarily unavailable; else = generic failure). */
export class GenFillError extends Error {
  code: number;
  available?: number;
  required?: number;
  constructor(code: number, info: { available?: number; required?: number } = {}) {
    super(`gen-fill ${code}`);
    this.name = 'GenFillError';
    this.code = code;
    this.available = info.available;
    this.required = info.required;
  }
}

/** The user's billing situation, used to tailor the out-of-credits popup
 *  (subscribed → top up; not → subscribe). Best-effort; defaults to not-subscribed. */
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

/** Fill models the user can pick, with their credit cost (per ~1MP fill).
 *  engine 'fal' = true masked inpainting (FLUX Fill), pixel-locked by the model.
 *  engine 'kie' = mask-free editor (nano-banana / gpt-image-2): regenerates the
 *                 whole frame, so we outline the selection + composite only its
 *                 region back (outside stays untouched).
 *  refMode 'none' | 'optional' | 'required' drives the reference-image UI. */
export const FILL_MODELS = [
  { id: 'flux-dev-inpaint', label: 'FLUX.1 Fill (dev)', credits: 4, engine: 'fal', refMode: 'none' },
  { id: 'flux-pro-fill', label: 'FLUX.1 Fill (pro)', credits: 6, engine: 'fal', refMode: 'none' },
  { id: 'flux-kontext-ref', label: 'FLUX Kontext (reference)', credits: 4, engine: 'fal', refMode: 'required' },
  { id: 'nano-banana-2', label: 'Nano Banana (reference edit)', credits: 5, engine: 'kie', refMode: 'optional' },
  { id: 'gpt-image-2', label: 'GPT Image 2 (edit)', credits: 4, engine: 'kie', refMode: 'optional' },
] as const;

export type FillModelId = typeof FILL_MODELS[number]['id'];

/** The engine backing a model id (defaults to 'fal'). */
export function fillEngine(id: FillModelId): 'fal' | 'kie' {
  return (FILL_MODELS.find((m) => m.id === id)?.engine ?? 'fal') as 'fal' | 'kie';
}

async function uploadTemp(blob: Blob, name: string, token: string): Promise<string> {
  const file = new File([blob], name, { type: blob.type || 'image/png' });
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/studio/upload-temp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  const j = await res.json();
  const url = j.url || j.fileUrl;
  if (!url) throw new Error('upload returned no url');
  return url;
}

/** Upload a user-picked reference image to Kie temp; returns its public URL
 *  (passed to reference-guided inpaint models as reference_image_url). */
export async function uploadReferenceImage(file: File): Promise<string> {
  const token = await getVoidspaceIdToken();
  if (!token) throw new NotSignedInError();
  return uploadTemp(file, file.name || 'reference.png', token);
}

export interface GenerativeFillOpts {
  imageBlob: Blob;   // full composite (PNG/JPEG)
  maskBlob: Blob;    // same dimensions; WHITE = inpaint, BLACK = keep
  prompt: string;
  model?: FillModelId;
  /** Public URL of an already-uploaded reference image (for ref models). */
  referenceUrl?: string;
}

/** Classify a failed /gen-fill response by status ONLY (never surface server
 *  text) and throw the matching GenFillError. */
async function throwGenFillError(res: Response): Promise<never> {
  let available: number | undefined;
  let required: number | undefined;
  try {
    const j = await res.json();
    available = j?.data?.available ?? j?.available;
    required = j?.data?.required ?? j?.required;
  } catch { /* ignore */ }
  throw new GenFillError(res.status, { available, required });
}

/** Fetch a result image URL and return it as a data URL. */
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

/** Run masked inpainting (fal FLUX Fill). Returns the result as a data URL. */
export async function runGenerativeFill(opts: GenerativeFillOpts): Promise<string> {
  const token = await getVoidspaceIdToken();
  if (!token) throw new NotSignedInError();

  const [imageUrl, maskUrl] = await Promise.all([
    uploadTemp(opts.imageBlob, 'fill-source.png', token),
    uploadTemp(opts.maskBlob, 'fill-mask.png', token),
  ]);

  const res = await fetch('/api/studio/gen-fill', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl, maskUrl, prompt: opts.prompt, model: opts.model, referenceUrl: opts.referenceUrl }),
  });
  if (!res.ok) await throwGenFillError(res);
  const j = await res.json();
  const resultUrl: string = j.url;
  if (!resultUrl) throw new Error('Generative fill returned no image');
  return fetchAsDataUrl(resultUrl);
}

/** Run a mask-free Kie edit (nano-banana / gpt-image-2). Uploads the outlined
 *  composite + sends any reference URLs; returns the FULL result as a data URL
 *  (the caller composites only the selection region back). */
export async function runKieEditFill(opts: {
  markedBlob: Blob;
  referenceUrls: string[];
  prompt: string;
  model: FillModelId;
  aspectRatio?: string;
  inverted?: boolean;
}): Promise<string> {
  const token = await getVoidspaceIdToken();
  if (!token) throw new NotSignedInError();

  const imageUrl = await uploadTemp(opts.markedBlob, 'fill-marked.png', token);

  const res = await fetch('/api/studio/gen-fill', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      engine: 'kie', model: opts.model, imageUrl,
      referenceUrls: opts.referenceUrls, prompt: opts.prompt,
      aspectRatio: opts.aspectRatio, inverted: opts.inverted === true,
    }),
  });
  if (!res.ok) await throwGenFillError(res);
  const j = await res.json();
  const resultUrl: string = j.url;
  if (!resultUrl) throw new Error('Generative fill returned no image');
  return fetchAsDataUrl(resultUrl);
}
