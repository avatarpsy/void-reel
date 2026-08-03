/**
 * Loading-function tests.
 *
 * These pin the URL rules shared by the video, image and board editors. Every
 * case below is a bug that actually shipped: a relative URL fetched against an
 * iframe's own origin, a media element handed a URL with no token, and a 96px
 * tile served by re-reading the full-size master.
 */
import { describe, expect, it } from 'vitest';
import { absoluteUrl, mediaSrc, thumbUrl, tileSrc, videoPreviewSrc } from './thumbs';
import type { AssetBrowserHost } from './types';

const host: AssetBrowserHost = {
  getIdToken: async () => 'tok',
  apiBase: () => 'https://voidspace.test',
};

describe('absoluteUrl', () => {
  it('prefixes a relative Voidspace path with the API origin', () => {
    // Iframed apps: a bare '/api/...' resolves against the SPA's own dev server.
    expect(absoluteUrl('/api/media-library/file?id=x', 'https://voidspace.test'))
      .toBe('https://voidspace.test/api/media-library/file?id=x');
  });

  it('leaves absolute, blob and data URLs untouched', () => {
    for (const u of ['https://cdn/x.png', 'blob:abc', 'data:image/png;base64,AA']) {
      expect(absoluteUrl(u, 'https://voidspace.test')).toBe(u);
    }
  });
});

describe('mediaSrc — <video>/<audio>', () => {
  it('appends the auth token, because an element src cannot send a header', async () => {
    const out = await mediaSrc(host, '/api/media-library/file?id=x');
    expect(out).toBe('https://voidspace.test/api/media-library/file?id=x&t=tok');
  });

  it('does not double-append a token that is already there', async () => {
    const out = await mediaSrc(host, '/api/media-library/file?id=x&t=old');
    expect(out).toBe('https://voidspace.test/api/media-library/file?id=x&t=old');
  });

  it('still returns a usable src when signed out', async () => {
    const anon: AssetBrowserHost = { ...host, getIdToken: async () => null };
    expect(await mediaSrc(anon, '/api/x')).toBe('https://voidspace.test/api/x');
  });

  it('leaves cloud URLs alone — they carry their own signature', async () => {
    expect(await mediaSrc(host, 'https://cdn/x.mp4')).toBe('https://cdn/x.mp4');
  });
});

describe('videoPreviewSrc', () => {
  it('prefers the 720p proxy so browsing never pulls a 4K master', () => {
    expect(videoPreviewSrc({ url: '/master.mov', proxyUrl: '/proxy?id=1' })).toBe('/proxy?id=1');
  });

  it('falls back to the original when the server has no proxy', () => {
    expect(videoPreviewSrc({ url: '/master.mp4', proxyUrl: null })).toBe('/master.mp4');
  });
});

describe('tileSrc', () => {
  it('uses the server thumbnail when there is one, rather than resizing the master', () => {
    // The server rasterises once and caches on disk; re-deriving from the master
    // per viewer is the expensive mistake this replaced.
    expect(tileSrc(host, { url: '/api/media-library/file?id=x', kind: 'video',
                           thumbnailUrl: '/api/media-library/thumb?id=x&w=360' }))
      .toBe('https://voidspace.test/api/media-library/thumb?id=x&w=360');
  });

  it('asks the proxy for a RESIZED copy of a remote image', () => {
    const out = tileSrc(host, { url: 'https://cdn/big.png', kind: 'image' });
    expect(out).toContain('/api/studio/media-proxy?url=');
    expect(out).toContain('w=240');
  });

  it('returns nothing for kinds with no raster preview, so the host draws an icon', () => {
    expect(tileSrc(host, { url: '/f', kind: 'sfx', hasRasterPreview: false })).toBe('');
    expect(tileSrc(host, { url: '/f', kind: 'music' })).toBe('');
  });
});

describe('thumbUrl', () => {
  it('does NOT proxy a local path — the server already serves it', () => {
    // Proxying a relative URL makes the server fetch its own file over HTTP.
    expect(thumbUrl(host, '/api/media-library/file?id=x'))
      .toBe('https://voidspace.test/api/media-library/file?id=x');
  });

  it('leaves an already-sized URL alone', () => {
    const sized = 'https://voidspace.test/api/studio/media-proxy?url=a&w=240';
    expect(thumbUrl(host, sized)).toBe(sized);
  });
});

/**
 * WHO GETS THE TOKEN. A bearer credential belongs only on our own origins, and
 * sending it elsewhere does not merely leak — it BREAKS the request: an
 * `Authorization` header makes the fetch non-simple, so the browser preflights
 * it, and a third-party origin that never allowed that header fails the
 * preflight outright. The file then appears unreachable while being perfectly
 * public.
 *
 * Measured on a web-imported reference in the user's own library: 200 without
 * the header, `TypeError: Failed to fetch` with it, and the UI blaming an
 * expired link.
 */
describe('fetchThumb — who receives the auth token', () => {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const fakeFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    return {
      ok: true,
      clone: () => ({}),
      blob: async () => new Blob(['x']),
    } as unknown as Response;
  };

  async function fetchWith(url: string) {
    calls.length = 0;
    const realFetch = globalThis.fetch;
    const realCaches = (globalThis as { caches?: unknown }).caches;
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    // The cache write is best-effort; stub it so the test does not depend on
    // the Cache API existing in the runner.
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({ put: async () => {}, match: async () => undefined }),
    };
    try {
      const { fetchThumb } = await import('./thumbs');
      await fetchThumb(host, url);
      return calls[0];
    } finally {
      globalThis.fetch = realFetch;
      (globalThis as { caches?: unknown }).caches = realCaches;
    }
  }

  it('sends the token to a Voidspace host', async () => {
    expect((await fetchWith('https://voidspace.ai/api/media/1'))?.auth).toBe('Bearer tok');
  });

  it('sends the token for a relative path — that is our own origin', async () => {
    expect((await fetchWith('/api/studio/local-asset?f=a.png'))?.auth).toBe('Bearer tok');
  });

  it('NEVER sends the token to a third-party host', async () => {
    for (const url of [
      'https://storage.googleapis.com/bucket/web-imports/a.jpg',
      'https://i.ytimg.com/vi/abc/maxresdefault.jpg',
      'https://voidspace.ai.attacker.test/x.png',
    ]) {
      expect((await fetchWith(url))?.auth).toBeUndefined();
    }
  });
});

/**
 * THE ONE THAT WAS COSTING A REQUEST PER TILE.
 *
 * The Cache API was consulted only when the network FAILED, which made it an
 * offline fallback wearing the word "cache". Measured on a real library, a
 * single scope switch issued ~120 thumbnail requests, and switching away and
 * back issued ~120 more — for images that had just been on screen.
 *
 * These URLs are addressed by asset id or content hash, so a different image is
 * a different url. Reading the cache first cannot serve the wrong picture, and
 * revalidating would spend a request per tile to confirm something that cannot
 * have moved.
 */
describe('fetchThumb — the cache is read first', () => {
  function harness(opts: { cached?: boolean }) {
    const netCalls: string[] = [];
    const realFetch = globalThis.fetch;
    const realCaches = (globalThis as { caches?: unknown }).caches;

    globalThis.fetch = (async (url: string) => {
      netCalls.push(String(url));
      return {
        ok: true,
        clone: () => ({}),
        blob: async () => new Blob(['from-network']),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({
        put: async () => {},
        match: async () => (opts.cached
          ? ({ blob: async () => new Blob(['from-cache']) } as unknown as Response)
          : undefined),
      }),
    };
    return {
      netCalls,
      restore() {
        globalThis.fetch = realFetch;
        (globalThis as { caches?: unknown }).caches = realCaches;
      },
    };
  }

  it('serves a cached thumbnail without touching the network', async () => {
    const h = harness({ cached: true });
    try {
      const { fetchThumb } = await import('./thumbs');
      const blob = await fetchThumb(host, 'https://voidspace.test/api/media-library/thumb/abc');

      expect(await blob!.text()).toBe('from-cache');
      expect(h.netCalls, 'a cached thumbnail still went to the network').toEqual([]);
    } finally { h.restore(); }
  });

  it('falls to the network when nothing is cached', async () => {
    const h = harness({ cached: false });
    try {
      const { fetchThumb } = await import('./thumbs');
      const blob = await fetchThumb(host, 'https://voidspace.test/api/media-library/thumb/xyz');

      expect(await blob!.text()).toBe('from-network');
      expect(h.netCalls).toHaveLength(1);
    } finally { h.restore(); }
  });
});

/**
 * A library accumulates entries whose file has since been deleted — a render
 * from last month, a project cleaned up. Each 404s on every repaint: 22 failed
 * requests per scope switch on a real library, repeated indefinitely, each one
 * a console error burying the genuine failures.
 */
describe('fetchThumb — a missing thumbnail is asked for once', () => {
  function harness(status: number) {
    const netCalls: string[] = [];
    const realFetch = globalThis.fetch;
    const realCaches = (globalThis as { caches?: unknown }).caches;
    globalThis.fetch = (async (url: string) => {
      netCalls.push(String(url));
      return { ok: false, status, clone: () => ({}), blob: async () => new Blob() } as unknown as Response;
    }) as unknown as typeof fetch;
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({ put: async () => {}, match: async () => undefined }),
    };
    return {
      netCalls,
      restore() {
        globalThis.fetch = realFetch;
        (globalThis as { caches?: unknown }).caches = realCaches;
      },
    };
  }

  it('does not re-request a 404 on every repaint', async () => {
    const h = harness(404);
    try {
      const { fetchThumb } = await import('./thumbs');
      const url = 'https://voidspace.test/api/studio/local-asset?filename=deleted.mp4';
      expect(await fetchThumb(host, url)).toBeNull();
      expect(await fetchThumb(host, url)).toBeNull();
      expect(await fetchThumb(host, url)).toBeNull();

      expect(h.netCalls, 'a known-missing thumbnail was requested again').toHaveLength(1);
    } finally { h.restore(); }
  });

  /**
   * A 401 is a token that has not arrived yet and a 500 is a bad minute.
   * Remembering those would turn a transient problem into a permanently blank
   * tile for the rest of the session.
   */
  it('keeps trying after a transient failure', async () => {
    const h = harness(500);
    try {
      const { fetchThumb } = await import('./thumbs');
      const url = 'https://voidspace.test/api/studio/local-asset?filename=flaky.mp4';
      await fetchThumb(host, url);
      await fetchThumb(host, url);

      expect(h.netCalls).toHaveLength(2);
    } finally { h.restore(); }
  });
});
