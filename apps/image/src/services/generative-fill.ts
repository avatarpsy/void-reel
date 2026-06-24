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

/** Single engine (fal FLUX.1 [dev] Inpainting) — shown for transparency. */
export const FILL_MODELS = [
  { id: 'flux-dev-inpaint', label: 'FLUX.1 Fill (dev)' },
] as const;

export type FillModelId = typeof FILL_MODELS[number]['id'];

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

export interface GenerativeFillOpts {
  imageBlob: Blob;   // full composite (PNG/JPEG)
  maskBlob: Blob;    // same dimensions; WHITE = inpaint, BLACK = keep
  prompt: string;
  model?: FillModelId;
}

/** Run masked inpainting. Returns the result image as a data URL. */
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
    body: JSON.stringify({ imageUrl, maskUrl, prompt: opts.prompt }),
  });
  if (!res.ok) {
    let msg = `Generative fill failed (${res.status})`;
    try { const j = await res.json(); if (j?.statusMessage || j?.message) msg = j.statusMessage || j.message; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const j = await res.json();
  const resultUrl: string = j.url;
  if (!resultUrl) throw new Error('Generative fill returned no image');

  const imgRes = await fetch(resultUrl);
  if (!imgRes.ok) throw new Error(`fetch result failed (${imgRes.status})`);
  const blob = await imgRes.blob();
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
