/**
 * What the blob source must never stop doing.
 *
 * These are the properties that make a big board usable, and every one of them
 * is invisible from a typecheck or a build — the kind that come back silently
 * when somebody "simplifies" the queue or the stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeMediaRef } from '../board/media-ref';
import { __setToken } from '../board/parent-auth';
import { VoidspaceBlobSource } from './blob-source';

const IMAGE_REF = encodeMediaRef({ src: 'https://x.test/a.png', kind: 'image', mime: 'image/png' });
const VIDEO_REF = encodeMediaRef({ src: 'https://x.test/a.mp4', kind: 'video', mime: 'video/mp4' });

function pixel(): Blob {
  return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
}

/**
 * A fetch that records its calls and stays HELD until released.
 *
 * Held rather than instant, because the properties under test are about what
 * happens while requests are in flight — a stub that resolves immediately makes
 * every concurrency assertion vacuously true.
 */
function stubFetch() {
  const calls: string[] = [];
  const waiting: Array<() => void> = [];
  let open = false;
  const fn = vi.fn(async (url: string) => {
    calls.push(String(url));
    if (!open) await new Promise<void>(resolve => waiting.push(resolve));
    return { ok: true, status: 200, blob: async () => pixel() } as unknown as Response;
  });
  return {
    fn,
    calls,
    release: () => {
      open = true;
      waiting.splice(0).forEach(w => w());
    },
  };
}

/** Flush microtasks AND the timer queue — the source defers scheduling by a
 *  microtask so a whole batch of blocks is queued before anything starts. */
const tick = () => new Promise(r => setTimeout(r, 0));

describe('VoidspaceBlobSource', () => {
  let unparent: (() => void) | null = null;

  beforeEach(() => {
    __setToken('test-token');
    // Cache API is absent in happy-dom; the source must degrade, not throw.
    vi.stubGlobal('caches', undefined);

    // Stand in for the Nuxt page. Without a responder a forced refresh burns the
    // full startup backoff, which would make the 401 test take five seconds and
    // tell us nothing about the source.
    const onAsk = (e: Event) => {
      const d = (e as MessageEvent).data as { type?: string; requestId?: string } | null;
      if (d?.type !== 'voidspace:board-get-token' || !d.requestId) return;
      window.postMessage({ requestId: d.requestId, token: 'fresh-token' }, '*');
    };
    window.addEventListener('message', onAsk);
    unparent = () => window.removeEventListener('message', onAsk);
  });

  afterEach(() => {
    unparent?.();
    unparent = null;
  });

  it('never fetches a byte for video or audio — the player streams instead', async () => {
    const net = stubFetch();
    vi.stubGlobal('fetch', net.fn);
    const source = new VoidspaceBlobSource({ boardId: 'b1' });

    const blob = await source.get(VIDEO_REF);

    // A stub, with the right MIME: the attachment block refuses to render its
    // embed view without SOME blob, and its own resource controller treats null
    // as an error — but the bytes must stay on the server.
    expect(blob).toBeInstanceOf(Blob);
    expect(blob!.type).toBe('video/mp4');
    expect(blob!.size).toBeLessThan(16);
    expect(net.calls).toHaveLength(0);
  });

  it('fetches an image once and serves the second read from memory', async () => {
    const net = stubFetch();
    vi.stubGlobal('fetch', net.fn);
    const source = new VoidspaceBlobSource({ boardId: 'b2' });

    net.release();
    expect((await source.get(IMAGE_REF))!.size).toBe(3);

    const second = await source.get(IMAGE_REF);
    expect(second!.size).toBe(3);
    expect(net.calls).toEqual(['https://x.test/a.png']);
  });

  it('coalesces concurrent reads of the same key into one request', async () => {
    const net = stubFetch();
    vi.stubGlobal('fetch', net.fn);
    const source = new VoidspaceBlobSource({ boardId: 'b3' });

    const both = Promise.all([source.get(IMAGE_REF), source.get(IMAGE_REF)]);
    net.release();
    await both;

    expect(net.calls).toHaveLength(1);
  });

  it('caps concurrency, so opening a big board does not fire N requests at once', async () => {
    const net = stubFetch();
    vi.stubGlobal('fetch', net.fn);
    const source = new VoidspaceBlobSource({ boardId: 'b4' });

    const keys = Array.from({ length: 20 }, (_, i) =>
      encodeMediaRef({ src: `https://x.test/${i}.png`, kind: 'image' }));
    const all = Promise.all(keys.map(k => source.get(k)));
    // Let the queue schedule without letting any request finish.
    await tick();

    expect(net.calls.length).toBeLessThanOrEqual(6);

    net.release();
    await all;
    expect(net.calls).toHaveLength(20);
  });

  it('serves what is on screen first', async () => {
    const net = stubFetch();
    vi.stubGlobal('fetch', net.fn);
    const source = new VoidspaceBlobSource({ boardId: 'b5' });

    const keys = Array.from({ length: 12 }, (_, i) =>
      encodeMediaRef({ src: `https://x.test/${i}.png`, kind: 'image' }));
    // The last one queued is the one the user is looking at. Without the
    // viewport oracle it would be served twelfth.
    source.visibleKeys = () => new Set([keys[11]]);

    const all = Promise.all(keys.map(k => source.get(k)));
    await tick();

    expect(net.calls).toContain('https://x.test/11.png');

    net.release();
    await all;
  });

  it('reports a dead link as an error state rather than an empty box', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));
    const source = new VoidspaceBlobSource({ boardId: 'b6' });

    const states: Array<string | null | undefined> = [];
    source.blobState$(IMAGE_REF).subscribe(s => states.push(s.errorMessage));

    expect(await source.get(IMAGE_REF)).toBeNull();
    await tick();
    // The message is what the block prints on its card, so it has to say
    // something the user can act on.
    expect(states.at(-1)).toMatch(/no longer available/i);
  });

  it('never emits state synchronously on subscribe', async () => {
    // REGRESSION, measured in the browser: `ResourceController` subscribes from
    // inside a preact-signals effect and writes a signal in its handler. A
    // synchronous replay therefore wrote a signal mid-effect and signals killed
    // the whole effect with "Cycle detected" — 120 of them on a board with 120
    // media, taking every loading spinner and error card down with them.
    const source = new VoidspaceBlobSource({ boardId: 'b9' });
    let subscribeReturned = false;
    let emittedSynchronously = false;
    let emittedAtAll = false;
    const sub = source.blobState$(IMAGE_REF).subscribe(() => {
      if (!subscribeReturned) emittedSynchronously = true;
      emittedAtAll = true;
    });
    subscribeReturned = true;
    expect(emittedSynchronously).toBe(false);

    await tick();
    // Still DELIVERS — the value is held and replayed, just a tick later.
    expect(emittedAtAll).toBe(true);
    sub.unsubscribe();
  });

  it('retries once with a fresh token on 401, because a long session goes stale', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return n === 1
        ? ({ ok: false, status: 401 } as unknown as Response)
        : ({ ok: true, status: 200, blob: async () => pixel() } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const source = new VoidspaceBlobSource({ boardId: 'b7' });

    const blob = await source.get(IMAGE_REF);
    expect(blob!.size).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores the empty placeholder a streaming insert hands it', async () => {
    const source = new VoidspaceBlobSource({ boardId: 'b8' });
    // `placeAsset` gives `addAttachments` a zero-length File so nothing is
    // downloaded. Caching that would pin one empty byte as the asset forever.
    await source.set(VIDEO_REF, new Blob([], { type: 'video/mp4' }));
    expect(await source.list()).not.toContain(VIDEO_REF);
  });
});
