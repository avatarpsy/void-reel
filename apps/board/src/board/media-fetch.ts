/**
 * Fetching an asset's bytes — the one place the board decides HOW to ask.
 *
 * ── THE BUG THIS EXISTS TO END ───────────────────────────────────────────────
 * Both fetch sites on this board used to send `Authorization: Bearer …` on every
 * request that had a token, whatever the host. That is correct for our own API
 * and catastrophic for anything else, because an `Authorization` header makes a
 * cross-origin request NON-SIMPLE: the browser must send a CORS preflight first,
 * and a Google Cloud Storage bucket with no CORS configuration refuses it. The
 * `fetch` then rejects — it never reaches a status code — and both call sites
 * turned that into `null`.
 *
 * Measured against production, from `https://voidspace.ai`, on a real Library
 * object (`storage.googleapis.com/voidspace-v1.appspot.com/web-imports/…`):
 *
 *     plain fetch                          → 200
 *     same fetch + Authorization header    → TypeError: Failed to fetch
 *     same fetch + any custom header        → TypeError: Failed to fetch
 *     via /api/studio/media-proxy          → 200
 *
 * So every image in the user's Library failed to load on the board, and the
 * failure surfaced as "That asset could not be loaded — its link may have
 * expired." The asset was fine. The link was fine. We were asking wrongly, and
 * then blaming the asset — which is what sent an agent round a loop of
 * re-importing media that had never been broken, and re-placing it.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *   same origin      → send the token. `/api/studio/local-asset` REQUIRES it,
 *                      and same-origin requests are never preflighted.
 *   cross origin     → ask plainly. If that fails, go through our own
 *                      media-proxy, which is same-origin, allow-lists the media
 *                      hosts and adds the CORS headers the bucket does not.
 *
 * This is deliberately the same strategy the video editor already uses
 * (`apps/web/src/services/library-drop.ts` → `fetchLibraryBlob`): direct first,
 * proxy on failure, auth only where it belongs. Two surfaces reading the same
 * Library should not disagree about how to read it.
 */
import { defaultApiBase } from '@openreel/asset-browser';

import { awaitParentToken, getParentToken } from './parent-auth';

/**
 * How long to wait for the parent's Firebase session before giving up on a
 * same-origin authenticated read.
 *
 * The parent restores its session asynchronously and `NO_TOKEN_TTL` then makes
 * "no token" the answer for the next thirty seconds, so a block that connects in
 * that window would otherwise take a 401 and render as a permanent "Image not
 * found" — the asset was fine and only a gesture that re-asked would fix it.
 */
const AUTH_WAIT_MS = 8_000;

function sameOrigin(url: string): boolean {
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/** Our own proxy, which is same-origin and therefore never preflighted. */
function proxied(url: string, width?: number): string {
  const w = width && width > 0 ? `&w=${Math.round(width)}` : '';
  return `${defaultApiBase()}/api/studio/media-proxy?url=${encodeURIComponent(url)}${w}`;
}

async function tryFetch(url: string, headers?: Record<string, string>): Promise<Blob | null | 'auth'> {
  try {
    const res = await fetch(url, headers ? { headers } : undefined);
    if (res.ok) return await res.blob();
    // A 401/403 is the ONE failure worth re-asking with a better token. Anything
    // else — 404, 500, a dead link — is an honest answer, and asking again would
    // turn one failure into two.
    if (res.status === 401 || res.status === 403) return 'auth';
    return null;
  } catch {
    // Threw rather than answered: CORS refused it, or the host is unreachable.
    return null;
  }
}

export interface FetchMediaOptions {
  /**
   * Ask the proxy for a resized variant, in CSS pixels.
   *
   * Only reachable on the proxy path, and only meaningful for images — it is a
   * hint for cards, never a promise. The Library currently returns no
   * `displayUrl` at all for most rows, so without this a 300px card can pull a
   * full-size master.
   */
  width?: number;
}

/**
 * An asset's bytes, or null if it genuinely cannot be read.
 *
 * Never throws: every caller here is placing or painting a card, and a dead link
 * is a thing to report, not a crash.
 */
export async function fetchMediaBlob(
  url: string,
  opts: FetchMediaOptions = {},
): Promise<Blob | null> {
  if (!url) return null;

  // Minted in this document — an object URL from a drop, or an inline data URL.
  // No origin, no token, nothing to negotiate.
  if (/^(blob:|data:)/i.test(url)) {
    const got = await tryFetch(url);
    return got === 'auth' ? null : got;
  }

  if (sameOrigin(url)) {
    let token = await getParentToken().catch(() => null);
    for (let attempt = 0; attempt < 2; attempt++) {
      const got = await tryFetch(url, token ? { Authorization: `Bearer ${token}` } : undefined);
      if (got !== 'auth') return got;
      if (attempt > 0) break;
      // Stale token → refresh it. Never had one → the session may still be
      // restoring, so wait for it rather than concluding there is none.
      token = token
        ? await getParentToken(true).catch(() => null)
        : await awaitParentToken(AUTH_WAIT_MS).catch(() => null);
      if (!token) return null;
    }
    return null;
  }

  // ── CROSS-ORIGIN: ask plainly ────────────────────────────────────────────
  // No headers at all, so the request stays simple and no preflight is needed.
  // Library objects are public and answer this directly.
  const direct = await tryFetch(url);
  if (direct instanceof Blob) return direct;

  // Refused, unreachable, or genuinely private. Our proxy is same-origin, so it
  // is never preflighted, and it can reach hosts the browser cannot.
  const viaProxy = await tryFetch(proxied(url, opts.width));
  if (viaProxy instanceof Blob) return viaProxy;

  /**
   * LAST RESORT, and only for a host that answered `401`/`403` rather than
   * refusing the connection — that combination means CORS is configured and the
   * object really is access-controlled, so a token is worth offering. A host
   * that rejected the preflight never gets here, because it returned null.
   */
  if (direct === 'auth') {
    const token = await getParentToken().catch(() => null);
    if (token) {
      const authed = await tryFetch(url, { Authorization: `Bearer ${token}` });
      if (authed instanceof Blob) return authed;
    }
  }

  return null;
}

/**
 * Why a fetch failed, in words a person can act on.
 *
 * "Its link may have expired" was the only explanation the board ever offered,
 * and it was usually wrong — which mattered more than it sounds, because an
 * agent reads that sentence and believes it, then goes and re-imports media that
 * was never broken.
 */
export function describeFetchFailure(url: string): string {
  if (sameOrigin(url)) return 'That asset could not be read — you may need to sign in again.';
  return 'That asset could not be loaded. Its link may have expired, or the file may have been removed.';
}
