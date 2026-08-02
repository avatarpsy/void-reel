/**
 * Source contract tests.
 *
 * These pin the behaviours that are easy to "simplify" away later and expensive
 * to notice when they go — every one is a real property of the video editor's
 * library panel that the board now depends on too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAssets, normaliseKind } from './sources';
import type { AssetBrowserHost, AssetItem } from './types';

const host: AssetBrowserHost = {
  getIdToken: async () => 'tok',
  apiBase: () => 'https://voidspace.test',
};

function mockFetch(body: unknown, ok = true) {
  const fn = vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('kind normalisation', () => {
  it('maps the Library flavours onto the five the browser knows', () => {
    expect(normaliseKind('footage')).toBe('video');
    expect(normaliseKind('clip')).toBe('video');
    expect(normaliseKind('narration')).toBe('voice');
    expect(normaliseKind('sfx')).toBe('sfx');
    expect(normaliseKind('song')).toBe('music');
    expect(normaliseKind('still')).toBe('image');
  });
});

describe('mine scope — /api/studio/library', () => {
  it('sends auth and the user Storage dir, and normalises items', async () => {
    const f = mockFetch({ items: [{ id: 'a', url: 'https://x/img.png?sig=1', type: 'image', label: 'Hero' }], total: 1 });
    const page = await fetchAssets(host, { scope: 'mine', q: 'hero', limit: 10 });

    const [url, init] = f.mock.calls[0] as unknown as [string, any];
    expect(url).toContain('/api/studio/library?');
    // `outputDir` is what makes disk manifests appear at all — losing it makes
    // half the user's library silently vanish.
    expect(url).toContain('outputDir=');
    expect(init.headers.Authorization).toBe('Bearer tok');

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ kind: 'image', label: 'Hero', scope: 'mine' });
    // Key strips the query string: the same asset seen twice must dedupe even
    // when one URL carries a signature.
    expect(page.items[0].key).toBe('https://x/img.png');
    expect(page.semantic).toBe(false);
  });

  it('drops items with no url rather than rendering dead tiles', async () => {
    mockFetch({ items: [{ id: 'a', url: '' }, { id: 'b', url: 'https://x/y.png' }], total: 2 });
    const page = await fetchAssets(host, { scope: 'mine' });
    expect(page.items.map(i => i.id)).toEqual(['b']);
  });

  it('throws on a failed request instead of reporting an empty library', async () => {
    mockFetch({}, false);
    // "No results" when the request FAILED is indistinguishable from an empty
    // library — the worst possible outcome, so it must surface.
    await expect(fetchAssets(host, { scope: 'mine' })).rejects.toThrow(/library 500/);
  });
});

describe('shared scope — semantic lane', () => {
  it('POSTs to search-text when there is a query', async () => {
    const f = mockFetch({ items: [], total: 0, vector: { active: true } });
    const page = await fetchAssets(host, { scope: 'shared', q: 'rain on a window' });

    const [url, init] = f.mock.calls[0] as unknown as [string, any];
    expect(url).toContain('/api/media-library/search-text');
    // POST because the endpoint embeds server-side; the vector never rides in a URL.
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).q).toBe('rain on a window');
    expect(page.semantic).toBe(true);
  });

  it('GETs the plain search when the query is empty', async () => {
    const f = mockFetch({ items: [], total: 0 });
    await fetchAssets(host, { scope: 'shared', q: '   ' });

    const [url, init] = f.mock.calls[0] as unknown as [string, any];
    // Browsing must not pay for an embedding round trip.
    expect(url).toContain('/api/media-library/search?');
    expect(init?.method).toBeUndefined();
  });

  it('reads the preview fields the SERVER ACTUALLY SENDS', async () => {
    // Regression: this mapping read `thumbnailUrl` and `previewUrl`, neither of
    // which exists on a media-library item (the field is `thumbUrl`). It failed
    // SILENTLY — every tile fell back to proxying the full-size master, which is
    // why the grid was slow. Same for `originalName` vs the `filename` guess.
    mockFetch({
      items: [{
        id: 'x1', kind: 'footage', originalName: 'IMG_2043.mov', slug: 'img-2043',
        url: '/api/media-library/file?id=x1',
        thumbUrl: '/api/media-library/thumb?id=x1&w=360',
        proxyUrl: '/api/media-library/proxy?id=x1',
        hasRasterPreview: true, addedAt: '2026-07-01T00:00:00Z',
      }],
      total: 1,
    });
    const page = await fetchAssets(host, { scope: 'shared' });

    expect(page.items[0].thumbnailUrl).toBe('/api/media-library/thumb?id=x1&w=360');
    // The 720p proxy is what makes video preview cheap — dropping it was why
    // browsing pulled masters.
    expect(page.items[0].proxyUrl).toBe('/api/media-library/proxy?id=x1');
    // The real filename, not the sanitised slug.
    expect(page.items[0].label).toBe('IMG_2043.mov');
    expect(page.items[0].kind).toBe('video');
  });

  it('suppresses the thumbnail when it would only be a placeholder', async () => {
    // Audio/fonts/3D have no raster preview; the server returns a placeholder
    // SVG. Rendering that reads as a broken image, so the host shows its own
    // kind icon instead.
    mockFetch({
      items: [{ id: 'a1', kind: 'sfx', url: '/api/media-library/file?id=a1',
                thumbUrl: '/api/media-library/thumb?id=a1&w=360', hasRasterPreview: false }],
      total: 1,
    });
    const page = await fetchAssets(host, { scope: 'shared' });
    expect(page.items[0].thumbnailUrl).toBeUndefined();
    expect(page.items[0].hasRasterPreview).toBe(false);
  });

  it('reports the ranking the SERVER used, not the one requested', async () => {
    // The semantic lane can decline (cold model, upgrade mid-flight) and still
    // return good keyword results. A badge that lies about this is worse than none.
    mockFetch({ items: [], total: 0, vector: { active: false } });
    const page = await fetchAssets(host, { scope: 'shared', q: 'sunset' });
    expect(page.semantic).toBe(false);
  });
});

describe('device scope', () => {
  it('is empty when the host offers no browserSource', async () => {
    const page = await fetchAssets(host, { scope: 'device' });
    expect(page.items).toEqual([]);
  });

  it('delegates entirely to the host when one is given', async () => {
    const withBrowser: AssetBrowserHost = {
      ...host,
      browserSource: {
        list: async () => [
          { id: 'l1', url: 'blob:1', key: 'blob:1', kind: 'video', label: 'local', scope: 'device' },
        ],
      },
    };
    const page = await fetchAssets(withBrowser, { scope: 'device' });
    expect(page.items[0].label).toBe('local');
  });
});

/**
 * BLOCKS ARE A KIND, NOT A SCOPE.
 *
 * They live in the user's Voidspace folder rather than the Library, so no scope
 * can fetch them and every scope has to be able to show them. That inversion —
 * the kind decides the source, not the scope — is the thing worth pinning: get
 * it wrong and asking for blocks silently returns footage.
 */
describe('the block kind', () => {
  const blocks: AssetItem[] = [
    {
      id: 'block:user/my-lower-third', url: 'block:user/my-lower-third',
      key: 'block:user/my-lower-third', kind: 'block', label: 'my-lower-third',
      detail: 'lower-third · 3 slots', scope: 'mine',
    },
    {
      id: 'block:starter/stat-card', url: 'block:starter/stat-card',
      key: 'block:starter/stat-card', kind: 'block', label: 'stat-card',
      detail: 'data · 8 slots', scope: 'shared',
    },
  ];
  const withBlocks: AssetBrowserHost = {
    ...host,
    blockSource: { list: () => blocks },
  };

  it('serves blocks from the block source whatever the scope says', async () => {
    for (const scope of ['mine', 'shared', 'project', 'device'] as const) {
      const page = await fetchAssets(withBlocks, { scope, kind: 'block' });
      expect(page.items.map(i => i.label)).toEqual(['my-lower-third', 'stat-card']);
    }
  });

  /**
   * A stock install ships 128 starter blocks. Letting them into the mixed list
   * would bury the user's own footage under templates on every search.
   */
  it('never leaks into "all"', async () => {
    mockFetch({ items: [{ id: 'v1', url: 'https://x/a.mp4', type: 'video', label: 'take' }], total: 1 });
    const page = await fetchAssets(withBlocks, { scope: 'mine', kind: 'all' });
    expect(page.items.every(i => i.kind !== 'block')).toBe(true);
  });

  /** People look for a block by what it DOES, which lives in `detail`. */
  it('searches the detail line, not only the name', async () => {
    const page = await fetchAssets(withBlocks, { scope: 'mine', kind: 'block', q: 'lower-third' });
    expect(page.items.map(i => i.label)).toEqual(['my-lower-third']);

    const byCategory = await fetchAssets(withBlocks, { scope: 'mine', kind: 'block', q: 'data' });
    expect(byCategory.items.map(i => i.label)).toEqual(['stat-card']);
  });

  it('is empty — not an error — for a host with no block source', async () => {
    const page = await fetchAssets(host, { scope: 'mine', kind: 'block' });
    expect(page.items).toEqual([]);
  });
});
