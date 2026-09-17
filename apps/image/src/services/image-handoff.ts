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
  /**
   * The card that opened us and wants the result back.
   *
   * Set only when a surface explicitly asks for the round trip (`editReturn=`
   * on the handoff URL). A cloud-hosted image has no overwrite-in-place target
   * — `parseLocalAssetSource` returns null for anything but a local-asset URL
   * — so without this, editing a generated cover was a one-way trip: the user
   * saved a copy and the card they started from still showed the old picture.
   */
  editReturn?: string;
}

/** A studio image file we can overwrite IN PLACE (a local-asset URL). */
export interface EditSource {
  projectId: string;
  kind: string;       // save-render KIND_DIRS key; 'image' for frames
  filename: string;   // on-disk name incl. extension
  ext: string;        // png | jpg | webp …
  url: string;        // the original src URL (unchanged after overwrite)
}

/** Read the handoff params from the current URL (null if not a handoff). */
export function readHandoffParams(): HandoffParams | null {
  const q = new URLSearchParams(window.location.search);
  const src = q.get('src');
  if (!src) return null;
  return {
    src,
    from: q.get('from') || 'image',
    editReturn: (q.get('editReturn') || '').trim() || undefined,
  };
}

/**
 * Who asked for the edited image back, for as long as this tab is open.
 *
 * Module-level rather than a store field because it is not UI state: nothing
 * renders from it, it never changes after the handoff is consumed, and the
 * export path is the only reader. Cleared with the URL for the same reason the
 * handoff itself is — a refresh must not re-send an old edit somewhere.
 */
let editReturnId: string | null = null;
export function setEditReturnId(id: string | null): void { editReturnId = id || null; }
export function getEditReturnId(): string | null { return editReturnId; }

/**
 * Hand a saved image back to the card that asked for it.
 *
 * Same BroadcastChannel `overwriteLocalAsset` already uses, because this is the
 * same conversation: "an image you are showing has changed". The studio appends
 * it as a new variation on that card and selects it, so the original stays one
 * arrow away rather than being replaced.
 */
export function announceEditedImage(url: string): void {
  const returnTo = editReturnId;
  if (!returnTo || !url) return;
  try {
    new BroadcastChannel('voidspace-image-edit')
      .postMessage({ type: 'image-edited', returnTo, url });
  } catch { /* no BroadcastChannel — the copy is still saved in the library */ }
}

/**
 * If `src` is a studio `local-asset` URL, return the file it points at so the
 * editor can overwrite it in place (the studio's read path and save-render's
 * write path both resolve safeSlug(projectId)/frames/safeSlug(name) — same
 * file). Returns null for any other URL (Kie/GCS temp links), where the only
 * option is to save a copy.
 */
export function parseLocalAssetSource(src: string): EditSource | null {
  try {
    const u = new URL(src, window.location.origin);
    if (!u.pathname.replace(/\/+$/, '').endsWith('/api/studio/local-asset')) return null;
    const projectId = (u.searchParams.get('projectId') || '').trim();
    const filename = (u.searchParams.get('filename') || '').trim();
    const kind = (u.searchParams.get('kind') || 'image').trim() || 'image';
    if (!projectId || !filename) return null;
    const ext = (filename.split('.').pop() || 'png').toLowerCase();
    return { projectId, kind, filename, ext, url: src };
  } catch {
    return null;
  }
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

/** Same-origin `/api/...` asset — auth-gated, so the Bearer header applies.
 *  Resolved through `URL` rather than string-matched: the src arrives absolute
 *  (the studio builds it with `new URL(u, origin)`), and a host spelled with an
 *  explicit `:443`, a trailing dot, or a tunnel name used to miss the prefix
 *  test and get fetched anonymously — a 401 that reads as "no image". */
function isSameOriginApi(src: string): boolean {
  try {
    const u = new URL(src, window.location.origin);
    return u.origin === window.location.origin && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/**
 * A cross-origin http(s) source re-pointed at our own CORS-fronting proxy.
 *
 * THIS IS THE FIX for "Edit opened an empty editor". A freshly generated image
 * lives on the provider's host (Kie tempfile / aiquickdraw / an un-CORSed
 * bucket), which serves no `Access-Control-Allow-Origin`. An `<img>` shows it
 * happily — which is why the chat card and the lightbox looked fine — but
 * `fetch()` cannot read the bytes, so the editor booted with nothing on the
 * canvas. It started working "after a while" only because the picture had by
 * then been mirrored to a host that does send the header.
 *
 * Every other import path in this app already routes through the proxy
 * (library, carousel, layer separation, generate panel); the handoff was the
 * one that didn't.
 */
function proxiedUrl(src: string): string | null {
  try {
    const u = new URL(src, window.location.origin);
    if (u.origin === window.location.origin) return null;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `/api/studio/media-proxy?url=${encodeURIComponent(u.toString())}`;
  } catch {
    return null;
  }
}

/** Read the source image's bytes, whatever it takes: authed direct fetch first,
 *  then the same-origin proxy for anything cross-origin. Throws with a reason
 *  the user can act on — never resolves empty. */
async function fetchSourceBytes(src: string): Promise<Blob> {
  const token = isSameOriginApi(src) ? await getVoidspaceIdToken() : null;
  let directStatus = 0;
  try {
    const res = await fetch(src, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
    if (res.ok) return await res.blob();
    directStatus = res.status;
  } catch {
    // CORS rejection or a dropped connection — both land here with no status.
  }

  const viaProxy = proxiedUrl(src);
  if (viaProxy) {
    const res = await fetch(viaProxy);
    if (res.ok) return await res.blob();
    throw new Error(
      `could not load image (${res.status}${directStatus ? ` direct ${directStatus}` : ''})`,
    );
  }
  throw new Error(
    directStatus
      ? `could not load image (${directStatus})`
      : 'could not reach that image — it may have expired',
  );
}

/** Fetch the source image and open it as a brand-new editor project. */
export async function loadSrcAsProject(src: string, label: string): Promise<void> {
  const blob = await fetchSourceBytes(src);
  if (!blob.size) throw new Error('the source image was empty');
  const dataUrl = await blobToDataUrl(blob);
  const { width, height } = await imageDims(dataUrl);
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));

  const P = useProjectStore.getState();
  P.createProject(label || 'Edit image', { width: w, height: h });
  const assetId = `edit-src-${Date.now()}`;
  // One transaction: register-asset + add-layer is a single "place the image"
  // step. Split, the freshly-booted document's first Ctrl+Z removed the layer
  // and left the orphan asset behind — the exact case runTransaction exists for.
  useProjectStore.getState().runTransaction('Open image', () => {
    P.addAsset({
      id: assetId, name: label || 'Image', type: 'image', mimeType: blob.type || 'image/png',
      size: dataUrl.length, width: w, height: h, thumbnailUrl: dataUrl, dataUrl,
    });
    P.addImageLayer(assetId, { x: 0, y: 0, width: w, height: h });
  });
}
