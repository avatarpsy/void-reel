// voidspace-storage.ts
// -----------------------------------------------------------------------------
// Save images produced in the editor into the SAME storage that video
// generations use, so they show up in the shared Studio Library and can be
// reused in other flows (e.g. as references in video generation).
//
// The image editor is served same-origin with the Voidspace site (/image/),
// so it shares the site's persisted Firebase auth session. Rather than bundle
// the whole Firebase SDK, we read the already-persisted ID token out of the
// origin's `firebaseLocalStorageDb` IndexedDB and refresh it via the public
// secure-token endpoint when stale. Then we hit the same two server routes the
// video/agent image flow uses:
//
//   1. POST /api/studio/upload-temp   (multipart) -> public URL
//   2. POST /api/studio/mirror-asset  (kind:'image', skipCloud) -> Library
//
// Both are auth-gated (Bearer <idToken>) and same-origin. mirror-asset writes
// the file under the project's `frames/` dir + manifest, so it appears in
// GET /api/studio/library (type=image) exactly like a generated video frame.
// -----------------------------------------------------------------------------

// Public Firebase web config (identifies the voidspace-v1 project; not a secret
// — already shipped in the site + video editor bundles).
const FIREBASE_API_KEY = 'AIzaSyAeSTgdUZEEabdJttus2sn8NNh5gAX8yqA';
const FB_DB = 'firebaseLocalStorageDb';
const FB_STORE = 'firebaseLocalStorage';
const FB_KEY = `firebase:authUser:${FIREBASE_API_KEY}:[DEFAULT]`;

// Pseudo-project that groups standalone images in the Library, matching the
// agent image flow's convention (server/utils/agent-tools/create-tools.ts).
const LIBRARY_PROJECT_ID = 'chat-images';

export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in to Voidspace');
    this.name = 'NotSignedInError';
  }
}

interface StsTokenManager {
  accessToken?: string;
  refreshToken?: string;
  expirationTime?: number;
}

function readPersistedUser(): Promise<{ sts: StsTokenManager } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { sts: StsTokenManager } | null) => { if (!settled) { settled = true; resolve(v); } };
    try {
      // Open without a version so we never trigger an upgrade on Firebase's DB.
      const req = indexedDB.open(FB_DB);
      req.onerror = () => done(null);
      req.onsuccess = () => {
        const db = req.result;
        try {
          if (!db.objectStoreNames.contains(FB_STORE)) { done(null); return; }
          const tx = db.transaction(FB_STORE, 'readonly');
          const getReq = tx.objectStore(FB_STORE).get(FB_KEY);
          getReq.onerror = () => done(null);
          getReq.onsuccess = () => {
            // Firebase stores records as { fbase_key, value: <user> }.
            const rec = getReq.result as { value?: { stsTokenManager?: StsTokenManager } } | undefined;
            const sts = rec?.value?.stsTokenManager;
            done(sts ? { sts } : null);
          };
        } catch {
          done(null);
        }
      };
    } catch {
      done(null);
    }
  });
}

async function refreshIdToken(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
      },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.access_token ?? json.id_token ?? null;
  } catch {
    return null;
  }
}

/** Current Firebase ID token for the signed-in Voidspace user, or null. */
export async function getVoidspaceIdToken(): Promise<string | null> {
  const persisted = await readPersistedUser();
  if (!persisted) return null;
  const { accessToken, refreshToken, expirationTime } = persisted.sts;
  const fresh = typeof expirationTime === 'number' && expirationTime - Date.now() > 5 * 60 * 1000;
  if (accessToken && fresh) return accessToken;
  if (refreshToken) {
    const refreshed = await refreshIdToken(refreshToken);
    if (refreshed) return refreshed;
  }
  return accessToken ?? null; // stale but better than nothing; server re-validates
}

export async function isSignedInToVoidspace(): Promise<boolean> {
  return (await getVoidspaceIdToken()) !== null;
}

// ─────────────────────── Reading the shared Library ───────────────────────
// The same store video generations land in. GET /api/studio/library scans the
// per-project disk manifests (zero Firebase) and returns every asset the user
// has made. We filter type=image so the image editor's Assets panel shows the
// same images the video editor's Library tab does.

export interface VoidspaceLibraryItem {
  id: string;
  type: string;        // 'image' | 'video' | ...
  kind: string;
  label: string;
  url: string;         // /api/studio/local-asset?... (auth-gated)
  thumbnailUrl?: string;
  bytes: number;
  createdAt: string;
  projectId: string;
}

export interface LibraryResult {
  items: VoidspaceLibraryItem[];
  total: number;
  /** Token to stamp on <img src> (local-asset is auth-gated; element src
   *  can't send an Authorization header). null when signed out. */
  token: string | null;
}

export async function fetchVoidspaceLibrary(
  opts: { type?: string; q?: string; limit?: number } = {},
): Promise<LibraryResult> {
  const token = await getVoidspaceIdToken();
  if (!token) return { items: [], total: 0, token: null };
  const qs = new URLSearchParams({
    type: opts.type ?? 'image',
    q: opts.q ?? '',
    limit: String(opts.limit ?? 120),
  });
  const res = await fetch(`/api/studio/library?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`library ${res.status}`);
  const j = await res.json();
  return {
    items: Array.isArray(j.items) ? j.items : [],
    total: typeof j.total === 'number' ? j.total : 0,
    token,
  };
}

/** Append the auth token to a local-asset URL so an <img>/<canvas> can load it. */
export function withMediaToken(url: string, token: string | null): string {
  if (!token || /[?&]t=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
}

/**
 * Fetch a Library image's bytes and turn it into an image-editor MediaAsset
 * (base64 dataUrl + dimensions), ready for addAsset()/addImageLayer().
 */
export async function libraryImageToAsset(
  item: VoidspaceLibraryItem,
  token: string | null,
): Promise<{
  id: string; name: string; type: 'image'; mimeType: string; size: number;
  width: number; height: number; thumbnailUrl: string; dataUrl: string;
}> {
  const res = await fetch(withMediaToken(item.url, token));
  if (!res.ok) throw new Error(`fetch image ${res.status}`);
  const blob = await res.blob();
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
  const { width, height } = await new Promise<{ width: number; height: number }>((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
  return {
    id: `lib-${item.id}-${Math.floor(performance.now())}`,
    name: item.label || 'Library image',
    type: 'image',
    mimeType: blob.type || 'image/png',
    size: blob.size,
    width,
    height,
    thumbnailUrl: dataUrl,
    dataUrl,
  };
}

export interface SavedLibraryImage {
  /** Auth-gated URL that serves the stored image (same as Library items). */
  url: string;
  /** The durable public URL the file was uploaded to. */
  permanentUrl: string;
}

/**
 * Flatten-and-save a PNG/JPEG blob into the shared Studio Library. Throws
 * NotSignedInError if there's no Voidspace session on this origin.
 */
export async function saveImageToVoidspaceLibrary(
  blob: Blob,
  name: string,
  format: 'png' | 'jpg' | 'webp' = 'png',
): Promise<SavedLibraryImage> {
  const token = await getVoidspaceIdToken();
  if (!token) throw new NotSignedInError();
  const auth = { Authorization: `Bearer ${token}` };

  // 1) Upload the bytes to get a fetchable public URL (mirror-asset can't take
  //    a raw blob — it downloads a url).
  const ext = format === 'jpg' ? 'jpg' : format;
  const safeName = (name || 'image').replace(/[^\w.-]+/g, '-').slice(0, 60);
  const file = new File([blob], `${safeName}.${ext}`, { type: blob.type || `image/${ext}` });
  const form = new FormData();
  form.append('file', file);

  const upRes = await fetch('/api/studio/upload-temp', { method: 'POST', headers: auth, body: form });
  if (!upRes.ok) throw new Error(`upload-temp failed (${upRes.status})`);
  const up = await upRes.json();
  const url: string = up.url || up.fileUrl;
  if (!url) throw new Error('upload-temp returned no url');

  // 2) Mirror into the Library (disk frames/ + manifest), same as a video frame.
  const assetId = `imgedit-${safeName}-${blob.size}-${(globalThis.crypto?.randomUUID?.() ?? String(Math.floor(performance.now())))}`;
  const mirrorRes = await fetch('/api/studio/mirror-asset', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: LIBRARY_PROJECT_ID,
      kind: 'image',
      url,
      role: 'image_export',
      assetId,
      label: name || 'Image export',
      skipCloud: true,
    }),
  });
  if (!mirrorRes.ok) throw new Error(`mirror-asset failed (${mirrorRes.status})`);
  const mirror = await mirrorRes.json();

  return {
    url: mirror.localServeUrl || mirror.permanentUrl || url,
    permanentUrl: mirror.permanentUrl || url,
  };
}
