/**
 * Stale-while-revalidate for asset queries.
 *
 * ── WHY THIS IS IN THE PACKAGE ───────────────────────────────────────────────
 * The video editor had a cache. The board and the image editor did not, so every
 * tab switch, every type pill and every reopen of the panel cleared the list to
 * "Searching…" and went back to the network — for results that had not changed.
 * On a large library that is a visible stall on an action the user takes dozens
 * of times an hour, and it reads as the app being slow rather than as a missing
 * cache.
 *
 * Putting it beside `fetchAssets` means every host gets the same behaviour from
 * the same code, which is the point of this package. A cache per app is three
 * chances to expire differently.
 *
 * ── SHOW STALE, THEN CORRECT IT ──────────────────────────────────────────────
 * A cached page is shown IMMEDIATELY and a fresh request runs behind it. That is
 * the right trade for a media library: the cost of briefly showing a list that
 * is a minute out of date is nearly zero, and the cost of a blank panel on every
 * click is paid constantly.
 *
 * It is NOT the right trade everywhere, which is why `fetchAssets` is untouched
 * and this is a separate entry point. A caller that must not see stale data —
 * confirming a delete, say — keeps calling `fetchAssets`.
 */
import { fetchAssets } from './sources';
import type { AssetBrowserHost, AssetPage, AssetQuery } from './types';

/**
 * How long a cached page may be served before it is considered worthless.
 *
 * Two minutes, not "forever". Beyond that the library has plausibly changed
 * underneath the user — they generated something, or another editor saved a
 * file — and showing a page from last session would be a lie rather than a
 * head start. Below that, revalidation covers the difference.
 */
const MAX_AGE_MS = 2 * 60 * 1000;

/** Bounded so a long session cannot grow this without limit. */
const MAX_ENTRIES = 60;

interface Entry {
  page: AssetPage;
  at: number;
}

/**
 * Module-level, so it survives a panel unmounting.
 *
 * That is the case that matters: closing and reopening the asset panel is the
 * single most common way a user returns to a list they were just looking at.
 */
const store = new Map<string, Entry>();

/** Identity of a query. Offset included — page 2 is not page 1. */
export function cacheKey(q: AssetQuery): string {
  return JSON.stringify([q.scope, q.kind ?? 'all', (q.q ?? '').trim(), q.offset ?? 0, q.limit ?? 0]);
}

function remember(key: string, page: AssetPage): void {
  store.set(key, { page, at: Date.now() });
  // Cheapest sufficient eviction: Map preserves insertion order, so the first
  // key is the oldest write. An LRU would need a touch on every read for a
  // benefit nobody would notice at this size.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export interface CachedResult {
  page: AssetPage;
  /** True when this came from the cache and a fresh request is still running. */
  stale: boolean;
}

/**
 * Fetch a page, showing what we already had first.
 *
 * `onFresh` is called ONLY when the revalidated page differs from what was
 * served, so a caller can repaint on a real change instead of on every request.
 * Redrawing an identical grid makes the panel flicker for no reason and loses
 * the user's scroll position.
 */
export async function fetchAssetsCached(
  host: AssetBrowserHost,
  q: AssetQuery,
  onFresh?: (page: AssetPage) => void,
): Promise<CachedResult> {
  const key = cacheKey(q);
  const hit = store.get(key);
  const fresh = hit && Date.now() - hit.at < MAX_AGE_MS ? hit : null;

  if (!fresh) {
    const page = await fetchAssets(host, q);
    remember(key, page);
    return { page, stale: false };
  }

  /**
   * REVALIDATE IN THE BACKGROUND, and never let it throw into the caller.
   *
   * The user already has a usable list. Turning a failed refresh into a visible
   * error would replace working content with a message about content that is
   * still on screen.
   */
  void (async () => {
    try {
      const page = await fetchAssets(host, q);
      const changed = !samePage(page, fresh.page);
      remember(key, page);
      if (changed) onFresh?.(page);
    } catch { /* keep the stale page; it is still the best we have */ }
  })();

  return { page: fresh.page, stale: true };
}

/** Same items in the same order, and the same total. */
function samePage(a: AssetPage, b: AssetPage): boolean {
  if (a.total !== b.total) return false;
  if (a.items.length !== b.items.length) return false;
  for (let i = 0; i < a.items.length; i++) {
    if (a.items[i].id !== b.items[i].id) return false;
  }
  return true;
}

/**
 * Forget cached pages.
 *
 * Called after anything that CHANGES the library — an upload, a delete, a
 * rename, a publish. Without it the user performs an action, the panel refreshes
 * from cache, and their own change appears not to have happened, which is worse
 * than a slow list.
 *
 * With no argument it clears everything, which is the safe default for a
 * mutation whose blast radius is not obvious.
 */
export function invalidateAssetCache(scope?: string): void {
  if (!scope) { store.clear(); return; }
  for (const key of [...store.keys()]) {
    if (key.startsWith(`["${scope}"`)) store.delete(key);
  }
}

/** Test seam. */
export function __cacheSize(): number {
  return store.size;
}
