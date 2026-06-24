// generative-fill.ts
// -----------------------------------------------------------------------------
// Photoshop-style Generative Fill (inpainting). The caller renders the current
// composite + a MASK (black = the region to regenerate, white = keep — Kie's
// 4o-image convention) at matching dimensions; we upload both, run the masked
// edit server-side (/api/studio/gen-fill, authed + billed), and return the
// filled image as a data URL ready for addImageLayer().
//
// The editor then drops the result on a NEW layer masked to the selection, so
// the original is never touched (fully non-destructive).
// -----------------------------------------------------------------------------

import { getVoidspaceIdToken, NotSignedInError } from './voidspace-storage';

/** Image models the user can pick for the fill. The masked edit runs on Kie's
 *  4o-image engine; the model id is used for pricing/gating server-side. Ids
 *  match the studio registry. */
export const FILL_MODELS = [
  { id: 'gpt-image-2-text-to-image', label: 'GPT Image 2' },
  { id: 'nano-banana-2', label: 'Nano Banana 2' },
] as const;

export type FillModelId = typeof FILL_MODELS[number]['id'];

/** Upload a blob to the temp store and return its public URL. */
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
  imageBlob: Blob;            // current composite (PNG/JPEG)
  maskBlob: Blob;            // same dimensions; black = fill region, white = keep
  prompt: string;
  model?: FillModelId;
  /** Kie size token — '1:1' | '3:2' | '2:3'. */
  size?: '1:1' | '3:2' | '2:3';
}

/**
 * Run generative fill. Returns the result image as a data URL. Throws
 * NotSignedInError when there's no Voidspace session.
 */
export async function runGenerativeFill(opts: GenerativeFillOpts): Promise<string> {
  const token = await getVoidspaceIdToken();
  if (!token) throw new NotSignedInError();

  // Upload source + mask (same dimensions so Kie's mask aligns to the image).
  const [imageUrl, maskUrl] = await Promise.all([
    uploadTemp(opts.imageBlob, 'fill-source.png', token),
    uploadTemp(opts.maskBlob, 'fill-mask.png', token),
  ]);

  const res = await fetch('/api/studio/gen-fill', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageUrl,
      maskUrl,
      prompt: opts.prompt,
      model: opts.model,
      size: opts.size ?? '1:1',
    }),
  });
  if (!res.ok) {
    let msg = `Generative fill failed (${res.status})`;
    try { const j = await res.json(); if (j?.statusMessage || j?.message) msg = j.statusMessage || j.message; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const j = await res.json();
  const resultUrl: string = j.url;
  if (!resultUrl) throw new Error('Generative fill returned no image');

  // Fetch the result bytes → data URL (avoids CORS/expiry issues when the layer
  // later re-renders, and matches how library images become layer assets).
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
