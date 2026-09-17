// image-handoff.ts
// -----------------------------------------------------------------------------
// "Edit this image" convenience: a surface (studio chat / video / music) opens
// the image editor in a new tab with `?src=<imageUrl>&from=<label>` and we load
// that image as a fresh project — so the user doesn't have to re-upload it.
//
// Saving has two shapes, and which one the user gets depends entirely on
// whether the source is OURS TO WRITE (see `parseEditSource`):
//
//  - "Update original" — the bytes at the same url are replaced, so the picture
//    changes everywhere it is already referenced (chat card, project cover,
//    ledger row, the phone) without anything being re-pointed. The surface that
//    opened us is told over `voidspace-image-edit` so it can drop its cached
//    copy; this is the default when it is available, because it is what a
//    person means by "edit this".
//  - "New copy" — the fallback for a provider URL we cannot write to. It lands
//    in the shared Library, and if the caller asked for the round trip
//    (`editReturn=`) it is also handed back to that card as a new variation.
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
   * on the handoff URL). It is the fallback path: when the source CANNOT be
   * overwritten in place (a provider URL that is not ours to write), the user
   * saves a copy and this is the only way that copy reaches the card they
   * started from instead of sitting in the Library.
   */
  editReturn?: string;
}

/**
 * An image file we can overwrite IN PLACE, so the edit shows up at the SAME
 * url everywhere it is already referenced.
 *
 * Two origins, because the studio stores images in two places and both are
 * worth editing:
 *  - `local` — a `/api/studio/local-asset` URL: a file on the machine running
 *    the studio, rewritten through `save-render`'s stable-filename path.
 *  - `cloud` — an object in our own storage bucket (a mirrored generation, a
 *    project cover, a chat image), rewritten through `/api/studio/overwrite-image`.
 *
 * `cloud` is the one that made "Edit" useful on a generated cover. Before it,
 * the only option for anything not on local disk was to save a COPY, which
 * left the ledger row, the music project, the song entry and the phone all
 * pointing at the picture the user had just replaced.
 */
export interface EditSource {
  origin: 'local' | 'cloud';
  projectId: string;  // save-render project; '' for a cloud object
  kind: string;       // save-render KIND_DIRS key; 'image' for frames and covers
  filename: string;   // on-disk / object name incl. extension
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
 * Hand a saved COPY back to the card that asked for it.
 *
 * Same BroadcastChannel the in-place overwrite uses, because this is the same
 * conversation: "an image you are showing has changed". The studio appends it
 * as a new variation on that card and selects it, so the original stays one
 * arrow away rather than being replaced.
 *
 * NOT called for an overwrite. There the url is unchanged, so a variation would
 * be the same picture listed twice; `image-updated` is the message for that.
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
 * file). Returns null for any other URL.
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
    return { origin: 'local', projectId, kind, filename, ext, url: src };
  } catch {
    return null;
  }
}

/** Formats we can write back. An overwrite reuses the object's own extension,
 *  so a format we cannot encode is a source we must not offer to replace. */
const CLOUD_EDIT_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);

/**
 * If `src` is an image in OUR storage bucket, describe it as an overwrite
 * target.
 *
 * Loose on purpose: this only decides whether to OFFER "Update original".
 * `/api/studio/overwrite-image` re-derives the object path and checks that it
 * belongs to the caller, so a url that looks right here but isn't theirs is
 * refused there, with the editor falling back to saving a copy. Duplicating
 * the ownership rule in the browser would add a second place for it to drift
 * and buy nothing — the browser's copy could never be the one enforcing it.
 *
 * Excludes provider hosts (Suno, Kie tempfiles, an imported web image) for the
 * plain reason that we cannot write to them; those still get the copy path.
 */
export function parseCloudEditSource(src: string): EditSource | null {
  try {
    const u = new URL(src, window.location.origin);
    if (u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    const ours = host === 'storage.googleapis.com'
      || host === 'firebasestorage.googleapis.com'
      || host.endsWith('.storage.googleapis.com');
    if (!ours) return null;

    // The object name, wherever this url shape keeps it. Firebase download
    // urls percent-encode the whole path into one segment after `/o/`.
    const fb = /\/v0\/b\/[^/]+\/o\/([^?]+)/.exec(u.pathname);
    const objectPath = decodeURIComponent(fb ? fb[1] : u.pathname.replace(/^\/+/, ''));
    const filename = objectPath.split('/').filter(Boolean).pop() || '';
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (!filename || !CLOUD_EDIT_EXTS.has(ext)) return null;

    return { origin: 'cloud', projectId: '', kind: 'image', filename, ext, url: src };
  } catch {
    return null;
  }
}

/**
 * The overwrite target for a handoff source, whichever kind it is, or null when
 * the only honest option is to save a copy.
 *
 * ONE reader, so "can this be updated in place?" is answered the same way by
 * the export dialog, the agent's save tool and anything added later.
 */
export function parseEditSource(src: string): EditSource | null {
  return parseLocalAssetSource(src) || parseCloudEditSource(src);
}

/** Strip the handoff params so a refresh doesn't reload the source image. */
export function clearHandoffUrl(): void {
  const url = new URL(window.location.href);
  ['src', 'from', 'editReturn'].forEach((k) => url.searchParams.delete(k));
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
