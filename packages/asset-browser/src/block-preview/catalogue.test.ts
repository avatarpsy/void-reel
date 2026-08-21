/**
 * IS THE USER'S OWN MACHINE ANSWERING?
 *
 * The two halves of blocks have different requirements, and conflating them is
 * the failure this guards: BROWSING works for everybody (the designs ship with
 * the server), but RENDERING one into a video happens on the user's computer.
 * So a person with no desktop app sees a complete, working library — and the
 * first thing they would learn otherwise is a failed drag.
 *
 * The signal is the listing's own `source`, because the route already asks the
 * device first and says so. One signal that is already arriving cannot disagree
 * with itself the way a separate probe could.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

async function fresh() {
  vi.resetModules();
  return import('./auth');
}

function listReturning(source: string, blocks: unknown[] = [{ name: 'a-block' }]) {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true, source, blocks }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
}

describe('desktopRendersBlocks', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('is false before anything has been listed', async () => {
    // Under-promising is the safe direction: claiming a machine is there when
    // nothing has answered would hide the one thing the user needs to be told.
    const { desktopRendersBlocks } = await fresh();
    expect(desktopRendersBlocks()).toBe(false);
  });

  it('is TRUE when the listing came from the device', async () => {
    vi.stubGlobal('fetch', listReturning('device'));
    const { loadBlockCatalogue, desktopRendersBlocks } = await fresh();
    await loadBlockCatalogue();
    expect(desktopRendersBlocks()).toBe(true);
  });

  it('is true when the device answered AND the shipped pack filled gaps', async () => {
    // `device+shipped` means the desktop replied and the server merged in
    // starters it did not have. The desktop is still there.
    vi.stubGlobal('fetch', listReturning('device+shipped'));
    const { loadBlockCatalogue, desktopRendersBlocks } = await fresh();
    await loadBlockCatalogue();
    expect(desktopRendersBlocks()).toBe(true);
  });

  it('is FALSE for a library that came only from the shipped pack', async () => {
    // The case this exists for: a full library, and nowhere to render.
    vi.stubGlobal('fetch', listReturning('shipped'));
    const { loadBlockCatalogue, desktopRendersBlocks, blockLibrarySource } = await fresh();
    const blocks = await loadBlockCatalogue();
    expect(blocks).toHaveLength(1);          // browsing works…
    expect(desktopRendersBlocks()).toBe(false); // …placing does not
    expect(blockLibrarySource()).toBe('shipped');
  });

  it('is false for a server-disk listing too — disk is not a renderer', async () => {
    vi.stubGlobal('fetch', listReturning('disk'));
    const { loadBlockCatalogue, desktopRendersBlocks } = await fresh();
    await loadBlockCatalogue();
    expect(desktopRendersBlocks()).toBe(false);
  });

  it('says why the library is empty, rather than showing a bare blank', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ blocks: [] }), { status: 200 })));
    const { loadBlockCatalogue, blockCatalogueError } = await fresh();
    expect(await loadBlockCatalogue()).toEqual([]);
    expect(blockCatalogueError()).toMatch(/desktop app/i);
  });

  it('reports a 401 as "sign in", not as a broken library', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const { loadBlockCatalogue, blockCatalogueError } = await fresh();
    await loadBlockCatalogue();
    expect(blockCatalogueError()).toMatch(/sign in/i);
  });

  it('does NOT cache an empty answer, so opening the desktop app recovers', async () => {
    // Empty almost always means the app is not running yet. Remembering that
    // would leave the panel empty until a reload, long after the reason went.
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ blocks: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ source: 'device', blocks: [{ name: 'x' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const { loadBlockCatalogue, desktopRendersBlocks } = await fresh();
    expect(await loadBlockCatalogue()).toEqual([]);
    expect((await loadBlockCatalogue()).map((b) => b.name)).toEqual(['x']);
    expect(desktopRendersBlocks()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
