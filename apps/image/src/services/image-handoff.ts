// image-handoff.ts
// -----------------------------------------------------------------------------
// Cross-surface "edit this image, then come back" handoff.
//
// A source surface (AI chat, video editor, music editor) opens the image editor
// in a NEW TAB with `?src=<imageUrl>&ctx=<contextRef>&from=<label>`. We load the
// image as a fresh project. When the user hits "Save & return", we save the
// edit to the shared Library (durable URL) and announce it on a same-origin
// BroadcastChannel keyed by `ctx`; the source tab is listening and applies it.
// The Library save is also a durable fallback if the source tab is gone.
//
// Protocol (shared with every surface):
//   • open:   window.open(`/image/?src=…&ctx=…&from=…`, '_blank')
//   • result: BroadcastChannel('voidspace-image-edit').postMessage({ ctx, url })
// -----------------------------------------------------------------------------

import { useProjectStore } from '../stores/project-store';
import { exportArtboard } from './export-service';
import { getVoidspaceIdToken, saveImageToVoidspaceLibrary } from './voidspace-storage';

export const EDIT_CHANNEL = 'voidspace-image-edit';

export interface HandoffParams {
  src: string;
  ctx: string;
  from: string;
}

/** Read + validate the handoff params from the current URL (null if not a handoff). */
export function readHandoffParams(): HandoffParams | null {
  const q = new URLSearchParams(window.location.search);
  const src = q.get('src');
  if (!src) return null;
  return { src, ctx: q.get('ctx') || '', from: q.get('from') || 'editor' };
}

/** Strip the handoff params so a refresh doesn't reload the source image. */
export function clearHandoffUrl(): void {
  const url = new URL(window.location.href);
  ['src', 'ctx', 'from'].forEach((k) => url.searchParams.delete(k));
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

/** Save the current edit to the Library and announce the result to the source. */
export async function saveAndReturn(ctx: string): Promise<string> {
  const { project, selectedArtboardId } = useProjectStore.getState();
  const artboard = project?.artboards.find((a) => a.id === selectedArtboardId);
  if (!project || !artboard) throw new Error('nothing to save');
  const blob = await exportArtboard(project, artboard, {
    format: 'png', quality: 'high', scale: 1, background: 'include',
  });
  const { url } = await saveImageToVoidspaceLibrary(blob, project.name || 'Edited image', 'png');
  try {
    const ch = new BroadcastChannel(EDIT_CHANNEL);
    ch.postMessage({ ctx, url });
    ch.close();
  } catch { /* BroadcastChannel unsupported → the Library save is the fallback */ }
  return url;
}
