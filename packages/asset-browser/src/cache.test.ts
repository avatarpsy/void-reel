/**
 * Stale-while-revalidate for asset queries.
 *
 * ── THE COMPLAINT THIS ANSWERS ───────────────────────────────────────────────
 * "I'm not sure if the media is cached because it's loading every time." It was
 * not. The video editor had a cache; the board and the image editor went back to
 * the network on every tab switch, every type pill and every reopen — clearing
 * the list to "Searching…" first, for results that had not changed.
 *
 * The behaviour worth pinning is not "it caches". It is the three things that
 * make a cache safe to have: a stale page is served INSTANTLY, a fresh one
 * replaces it only when it actually differs, and a mutation can throw it away.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { __cacheSize, fetchAssetsCached, invalidateAssetCache } from './cache';
import type { AssetBrowserHost } from './types';

function hostReturning(items: Array<{ id: string }>, spy?: ReturnType<typeof vi.fn>) {
  const f = spy ?? vi.fn();
  f.mockImplementation(async () => new Response(
    JSON.stringify({ items: items.map(i => ({ ...i, url: `/f/${i.id}`, kind: 'image', label: i.id })), total: items.length }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', f);
  return {
    apiBase: () => 'https://voidspace.test',
    getIdToken: async () => 'tok',
  } as unknown as AssetBrowserHost;
}

afterEach(() => { invalidateAssetCache(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('serving what we already had', () => {
  it('goes to the network the first time', async () => {
    const spy = vi.fn();
    const host = hostReturning([{ id: 'a' }], spy);

    const r = await fetchAssetsCached(host, { scope: 'mine', kind: 'image' });

    expect(r.stale).toBe(false);
    expect(r.page.items).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  /**
   * THE ONE THAT MATTERS. A second look at the same list must not blank the
   * panel and wait — that is the stall the user was seeing.
   */
  it('answers a repeat query from cache, without waiting', async () => {
    const spy = vi.fn();
    const host = hostReturning([{ id: 'a' }], spy);
    await fetchAssetsCached(host, { scope: 'mine', kind: 'image' });

    const r = await fetchAssetsCached(host, { scope: 'mine', kind: 'image' });

    expect(r.stale, 'the second identical query went back to the network').toBe(true);
    expect(r.page.items[0].id).toBe('a');
  });

  it('treats a different scope, kind, query or page as a different thing', async () => {
    const spy = vi.fn();
    const host = hostReturning([{ id: 'a' }], spy);

    await fetchAssetsCached(host, { scope: 'mine', kind: 'image' });
    await fetchAssetsCached(host, { scope: 'mine', kind: 'video' });
    await fetchAssetsCached(host, { scope: 'shared', kind: 'image' });
    await fetchAssetsCached(host, { scope: 'mine', kind: 'image', q: 'rain' });
    await fetchAssetsCached(host, { scope: 'mine', kind: 'image', offset: 120 });

    expect(spy).toHaveBeenCalledTimes(5);
  });
});

describe('correcting a stale page', () => {
  /**
   * REPAINT ONLY ON A REAL CHANGE. Redrawing an identical grid makes the panel
   * flicker and loses the user's scroll position, for no new information.
   */
  it('does not call back when the fresh page is identical', async () => {
    const host = hostReturning([{ id: 'a' }]);
    await fetchAssetsCached(host, { scope: 'mine' });

    const onFresh = vi.fn();
    await fetchAssetsCached(host, { scope: 'mine' }, onFresh);
    await new Promise(r => setTimeout(r, 20));   // let revalidation land

    expect(onFresh).not.toHaveBeenCalled();
  });

  it('calls back when the library has actually changed', async () => {
    const spy = vi.fn();
    const host = hostReturning([{ id: 'a' }], spy);
    await fetchAssetsCached(host, { scope: 'mine' });

    // The next response has a new item, as if something was generated.
    spy.mockImplementation(async () => new Response(
      JSON.stringify({ items: [{ id: 'a', url: '/f/a', kind: 'image' }, { id: 'b', url: '/f/b', kind: 'image' }], total: 2 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const onFresh = vi.fn();
    const r = await fetchAssetsCached(host, { scope: 'mine' }, onFresh);
    expect(r.stale).toBe(true);                  // the old page came back first
    await new Promise(res => setTimeout(res, 20));

    expect(onFresh).toHaveBeenCalledTimes(1);
    expect(onFresh.mock.calls[0][0].items).toHaveLength(2);
  });

  /**
   * A FAILED REFRESH MUST NOT DESTROY A WORKING LIST.
   *
   * The user already has usable content on screen; turning a background failure
   * into a visible error would replace it with a message about content that is
   * still right there.
   */
  it('keeps the stale page when revalidation fails', async () => {
    const spy = vi.fn();
    const host = hostReturning([{ id: 'a' }], spy);
    await fetchAssetsCached(host, { scope: 'mine' });

    spy.mockImplementation(async () => { throw new Error('offline'); });

    const onFresh = vi.fn();
    const r = await fetchAssetsCached(host, { scope: 'mine' }, onFresh);
    await new Promise(res => setTimeout(res, 20));

    expect(r.page.items[0].id).toBe('a');
    expect(onFresh).not.toHaveBeenCalled();
  });
});

describe('throwing the cache away', () => {
  /**
   * Without this, a user uploads a file, the panel refreshes from cache, and
   * their own change appears not to have happened — worse than a slow list.
   */
  it('forgets everything after a mutation', async () => {
    const spy = vi.fn();
    const host = hostReturning([{ id: 'a' }], spy);
    await fetchAssetsCached(host, { scope: 'mine' });

    invalidateAssetCache();

    const r = await fetchAssetsCached(host, { scope: 'mine' });
    expect(r.stale).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('can forget one scope without dropping the rest', async () => {
    const spy = vi.fn();
    const host = hostReturning([{ id: 'a' }], spy);
    await fetchAssetsCached(host, { scope: 'mine' });
    await fetchAssetsCached(host, { scope: 'shared' });

    invalidateAssetCache('mine');

    expect((await fetchAssetsCached(host, { scope: 'mine' })).stale).toBe(false);
    expect((await fetchAssetsCached(host, { scope: 'shared' })).stale).toBe(true);
  });

  /** A long session must not grow this without bound. */
  it('stays bounded', async () => {
    const host = hostReturning([{ id: 'a' }]);
    for (let i = 0; i < 80; i++) {
      await fetchAssetsCached(host, { scope: 'mine', q: `q${i}` });
    }
    expect(__cacheSize()).toBeLessThanOrEqual(60);
  });
});
