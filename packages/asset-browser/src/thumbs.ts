/**
 * Authenticated thumbnails, ported from LibraryPanel's `fetchThumbWithCache`.
 *
 * WHY A BARE `<img src>` IS WRONG HERE, and why the board's tiles were blank:
 * library URLs are authenticated. An `<img>` tag cannot send an Authorization
 * header, and a signed URL goes stale after about an hour — so every tile 401s
 * and renders as an empty box. The fetch has to be explicit.
 *
 * THE CACHE IS WHAT STOPS IMAGES "GETTING LOST": once a thumb has rendered on
 * this device it keeps rendering even if the source URL later dies. That is a
 * real property of the video editor's panel and users notice when it is missing.
 */
import { defaultApiBase } from './sources';
import type { AssetBrowserHost } from './types';

/** PRODUCTION's key. Changing it would orphan every thumb the video editor
 *  has already cached on the user's device. */
const THUMB_CACHE = 'voidspace-library-thumbs-v1';

/** Thumbnails the server has already said it does not have. See `fetchThumb`. */
const missing = new Set<string>();

/**
 * A COMPRESSED variant of an asset, for grid tiles.
 *
 * Tiles were fetching full-size originals — multi-megabyte stills for a 96px
 * thumbnail. `/api/studio/media-proxy?w=` returns a resized copy AND keeps a
 * disk cache keyed by url hash, so the second viewer pays nothing. This is the
 * same `w=` convention LibraryPanel uses ("compressed (`w=`) variant for grids").
 *
 * `width` is the RENDERED tile width times a small factor for retina — asking
 * for exactly 96px gives a soft tile on a 2x display.
 */
export function thumbUrl(host: AssetBrowserHost, url: string, width = 240): string {
  // Already a server-side thumbnail: leave it alone.
  if (url.includes('media-proxy') || url.includes('w=')) return url;
  // RELATIVE urls are already served by Voidspace off local disk. Pushing one
  // through the remote-image proxy makes the server fetch its own file over
  // HTTP to hand back bytes it could have streamed — slower, and it fails
  // outright when the proxy declines non-remote input.
  if (!/^https?:/i.test(url)) return resolveUrl(host, url);
  const base = host.apiBase?.() ?? '';
  return `${base}/api/studio/media-proxy?url=${encodeURIComponent(url)}&w=${width}`;
}

/**
 * Absolutise a Voidspace-relative URL.
 *
 * These SPAs run in an iframe, so a relative `/api/...` resolves against the
 * IFRAME's origin (the board's own dev server) and 404s. Absolute cloud, blob
 * and data URLs are already complete and must be left untouched.
 */
export function resolveUrl(host: AssetBrowserHost, url: string): string {
  return absoluteUrl(url, host.apiBase?.());
}

/**
 * The host-free form, for code that has a URL but no `AssetBrowserHost` —
 * notably the canvas placement path, which fetches bytes directly.
 *
 * Defaults to the PARENT frame's origin, because these SPAs are iframed and a
 * relative fetch would otherwise hit the SPA's own dev server and 404.
 */
export function absoluteUrl(url: string, base?: string): string {
  if (/^(https?:|blob:|data:)/i.test(url)) return url;
  return `${base ?? defaultApiBase()}${url}`;
}

/**
 * A src for a MEDIA ELEMENT — `<video>`, `<audio>`.
 *
 * Ported from LibraryPanel's `srcWithToken`. An element `src` cannot carry an
 * Authorization header, so authenticated media takes the token as `?t=`. This is
 * why the board's audio and video previews were dead: they were handed a bare
 * relative URL with no origin and no token, which can only 404.
 *
 * Images do NOT come through here — they use the authenticated fetch + Cache API
 * path below, which also survives the source URL expiring.
 */
export async function mediaSrc(host: AssetBrowserHost, url: string): Promise<string> {
  if (/^(https?:|blob:|data:)/i.test(url)) return url;
  const full = resolveUrl(host, url);
  if (/[?&]t=/.test(full)) return full;
  const token = await host.getIdToken().catch(() => null);
  if (!token) return full;
  return `${full}${full.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
}

/**
 * The best PREVIEW source for a video: the 720p proxy when the server has one,
 * the master otherwise.
 *
 * Preferring the proxy is what makes preview fast — a browsing user should never
 * pull a 4K master to glance at a clip. `usePlayableVideo` in the video editor
 * goes the other way (master first, proxy on decode failure) because there the
 * user is inspecting the real asset; here they are skimming a library.
 */
export function videoPreviewSrc(item: { url: string; proxyUrl?: string | null }): string {
  return item.proxyUrl || item.url;
}

/**
 * The right image source for a TILE, given an item.
 *
 * Order matters: a server-generated thumbnail is already sized and disk-cached,
 * so it beats resizing the master every time. Returns '' when the item has no
 * raster preview at all (audio, fonts, 3D) so the host renders its kind icon.
 */
export function tileSrc(
  host: AssetBrowserHost,
  item: { url: string; kind: string; thumbnailUrl?: string; hasRasterPreview?: boolean },
  width = 240,
): string {
  if (item.thumbnailUrl) return resolveUrl(host, item.thumbnailUrl);
  if (item.hasRasterPreview === false) return '';
  if (item.kind !== 'image') return '';
  return thumbUrl(host, item.url, width);
}

/**
 * Is this one of ours, i.e. somewhere an Authorization header belongs?
 *
 * TWO REASONS IT MATTERS, and they point the same way:
 *
 *  • CORS. Sending `Authorization` makes the request non-simple, so the browser
 *    preflights it — and a third-party origin that never listed that header in
 *    `Access-Control-Allow-Headers` fails the preflight. The fetch then rejects
 *    outright, with `TypeError: Failed to fetch` and no status to inspect. The
 *    file is public and loads perfectly WITHOUT the header. Measured on a
 *    web-imported reference sitting in the user's own library: 200 plain,
 *    blocked with auth, and the UI reported "the asset link may have expired"
 *    about a link that was fine.
 *  • It is a credential. A bearer token has no business being sent to a host
 *    that did not ask for one — see `withToken` in the board, same rule.
 */
function isOurOrigin(url: string): boolean {
  try {
    const { host } = new URL(url, typeof location !== 'undefined' ? location.href : undefined);
    if (typeof location !== 'undefined' && host === location.host) return true;
    return /(^|\.)voidspace\.(ai|app|work)$/i.test(host);
  } catch {
    // A relative url resolves against our own origin; anything unparseable is
    // not something to hand a token to.
    return !/^[a-z][a-z0-9+.-]*:/i.test(url);
  }
}

/**
 * Fetch a thumbnail with auth, reading the on-device cache FIRST.
 *
 * ── THIS WAS THE "IT LOADS EVERY TIME" ───────────────────────────────────────
 * The cache was consulted only when the network FAILED. So it was an offline
 * fallback wearing the word "cache": every thumbnail was re-downloaded on every
 * render, and the stored copy was read approximately never.
 *
 * Measured on a real library: ONE scope switch issued ~120 thumbnail requests,
 * and switching away and back issued ~120 more — for images that had just been
 * on screen and cannot have changed. That is the stall, not the list fetch.
 *
 * ── WHY CACHE-FIRST IS SAFE HERE, WHEN IT USUALLY IS NOT ─────────────────────
 * These URLs are effectively immutable. A library thumbnail is addressed by the
 * asset's id or content hash, so a DIFFERENT image is a DIFFERENT url — the
 * usual reason to revalidate (the bytes behind this name may have changed) does
 * not apply. Re-editing an asset produces a new id, and the cache name carries a
 * version for the case where the thumbnailer itself changes.
 *
 * So there is no revalidation here on purpose: it would spend a request per tile
 * to confirm something that cannot have moved.
 */
export async function fetchThumb(host: AssetBrowserHost, url: string): Promise<Blob | null> {
  // CACHE FIRST. The whole point, and the reason a revisit costs nothing.
  try {
    const c = await caches.open(THUMB_CACHE);
    const hit = await c.match(url);
    if (hit) return await hit.blob();
  } catch { /* Cache API unavailable (insecure context) — go to the network */ }

  /**
   * A THUMBNAIL THAT IS NOT THERE STAYS NOT THERE.
   *
   * Libraries accumulate entries whose file has since been deleted — a render
   * from last month, a project cleaned up. Every one of them 404s, and without
   * this the panel re-requests them on every repaint: measured at 22 failed
   * requests per scope switch on a real library, repeated indefinitely, each
   * one producing a console error that buries genuine failures.
   *
   * Session-lived on purpose, not persisted. A missing file can legitimately
   * come back — a mirror finishes, a drive is reconnected — and remembering the
   * failure across reloads would hide it after it was fixed.
   */
  if (missing.has(url)) return null;

  const token = isOurOrigin(url) ? await host.getIdToken().catch(() => null) : null;
  try {
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (res.ok) {
      try {
        const copy = res.clone();
        void caches.open(THUMB_CACHE).then(c => c.put(url, copy)).catch(() => {});
      } catch { /* Cache API unavailable */ }
      return await res.blob();
    }
    /**
     * ONLY 404 AND 410 ARE REMEMBERED — the server saying the thing is gone.
     *
     * A 401 is a token that has not arrived yet, a 500 is a bad minute, and a
     * 429 is backpressure. Remembering those would turn a transient problem
     * into a permanently blank tile for the rest of the session.
     */
    if (res.status === 404 || res.status === 410) missing.add(url);
  } catch { /* network failure and nothing cached — the caller draws a placeholder */ }

  return null;
}

/**
 * Resolve a thumbnail to an object URL for an `<img>`.
 *
 * Returns a disposer — object URLs leak until revoked, and a library grid churns
 * through hundreds of them as the user filters.
 */
export function loadThumbInto(
  host: AssetBrowserHost,
  img: HTMLImageElement,
  url: string,
  onFail?: () => void,
  /** Omit for a grid tile (resized); pass 0 for the full-size original. */
  width = 240,
): () => void {
  let alive = true;
  let created = '';
  const src = width > 0 ? thumbUrl(host, url, width) : url;
  void fetchThumb(host, src).then(blob => {
    if (!alive) return;
    if (!blob) { onFail?.(); return; }
    created = URL.createObjectURL(blob);
    img.src = created;
  });
  return () => {
    alive = false;
    if (created) URL.revokeObjectURL(created);
  };
}

// `playableUrl` lived here and was removed 2026-08-01. It pushed EVERY video
// through /api/studio/media-proxy, including on-disk library files the server
// already serves with Range support — and it carried no auth token, so the
// element it fed could only 404. Its two jobs are now done properly and
// separately by `videoPreviewSrc` (pick the 720p proxy) and `mediaSrc` (resolve
// the origin and attach the token).
