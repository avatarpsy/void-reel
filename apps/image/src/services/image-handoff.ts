// image-handoff.ts
// -----------------------------------------------------------------------------
// "Edit this image" convenience: a surface (studio chat / video / music) opens
// the image editor in a new tab with `?src=<imageUrl>&from=<label>` and we load
// that image as a fresh project — so the user doesn't have to re-upload it.
//
// Saving is deliberately plain: the user uses Export → "Save to Voidspace"
// (overwrite the same Library entry, or save a copy). The result lands in the
// shared Library (the studio's assets browser), where they swap it onto a scene
// or cover. No auto-apply / cross-tab magic — overwrite shows on refresh, a copy
// is picked from the assets browser.
// -----------------------------------------------------------------------------

import { useProjectStore } from '../stores/project-store';
import { getVoidspaceIdToken } from './voidspace-storage';

export interface HandoffParams {
  src: string;
  from: string;
}

/** Read the handoff params from the current URL (null if not a handoff). */
export function readHandoffParams(): HandoffParams | null {
  const q = new URLSearchParams(window.location.search);
  const src = q.get('src');
  if (!src) return null;
  return { src, from: q.get('from') || 'image' };
}

/** Strip the handoff params so a refresh doesn't reload the source image. */
export function clearHandoffUrl(): void {
  const url = new URL(window.location.href);
  ['src', 'from'].forEach((k) => url.searchParams.delete(k));
  window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function imageDims(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 1024, height: img.naturalHeight || 1024 });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/** Fetch the source image and open it as a brand-new editor project. */
export async function loadSrcAsProject(src: string, label: string): Promise<void> {
  const token = await getVoidspaceIdToken();
  // Same-origin /api assets are auth-gated; everything else fetches plainly.
  const sameOriginApi = /^\/api\//.test(src) || src.startsWith(`${window.location.origin}/api/`);
  const res = await fetch(src, sameOriginApi && token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  if (!res.ok) throw new Error(`could not load image (${res.status})`);
  const blob = await res.blob();
  const dataUrl = await blobToDataUrl(blob);
  const { width, height } = await imageDims(dataUrl);
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));

  const P = useProjectStore.getState();
  P.createProject(label || 'Edit image', { width: w, height: h });
  const assetId = `edit-src-${Date.now()}`;
  P.addAsset({
    id: assetId, name: label || 'Image', type: 'image', mimeType: blob.type || 'image/png',
    size: dataUrl.length, width: w, height: h, thumbnailUrl: dataUrl, dataUrl,
  });
  P.addImageLayer(assetId, { x: 0, y: 0, width: w, height: h });
}
