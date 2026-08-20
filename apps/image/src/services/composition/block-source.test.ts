/**
 * Resolving a block reference into a document is the step where a slide either
 * appears or silently does not, so these pin the two halves that decide it: what
 * comes back off the wire, and what happens when nothing does.
 *
 * The fetch is stubbed rather than mocked through a module boundary — the route
 * shape (`POST /api/studio/blocks { action: 'get' }`) is part of the contract
 * being checked, and a mock of our own wrapper would not check it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadBlock, forgetBlock, resolveComposition } from './block-source';
import type { CompositionSource } from '../../types/project';

const HTML = `<!DOCTYPE html><html><body>
  <div data-composition-id="stat-punch" data-width="1080" data-height="1920">
    <div class="headline">Sample headline</div>
  </div>
</body></html>`;

const source = (over: Partial<CompositionSource> = {}): CompositionSource => ({
  block: 'stat-punch',
  tier: 'starter',
  slots: { headline: 'Reach by month' },
  fillMode: 'render',
  poseTime: 'end',
  frameWidth: 1920,
  frameHeight: 1080,
  renderHash: '',
  ...over,
});

const realFetch = globalThis.fetch;
let calls: { url: string; body: any }[] = [];

/** Answer the blocks route with `payload`; anything else 404s. */
function serve(payload: unknown, ok = true) {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return {
      ok,
      json: async () => payload,
    } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  // Every test names its own block, so the module-level cache cannot leak one
  // test's answer into the next.
  forgetBlock('stat-punch');
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('fetching a block', () => {
  it('asks the blocks route for it by name', async () => {
    serve({ ok: true, name: 'stat-punch', tier: 'starter', html: HTML, slots: {} });
    await loadBlock('stat-punch');
    expect(calls[0].url).toContain('/api/studio/blocks');
    expect(calls[0].body).toMatchObject({ action: 'get', name: 'stat-punch' });
  });

  it('reads the frame the block was designed at off its root', async () => {
    serve({ ok: true, name: 'stat-punch', tier: 'starter', html: HTML, slots: {} });
    const doc = await loadBlock('stat-punch');
    // Portrait native, which is exactly the case the frame override exists for:
    // twelve deck-ready blocks are 1080x1920 while listing 16:9 as supported.
    expect(doc?.nativeWidth).toBe(1080);
    expect(doc?.nativeHeight).toBe(1920);
  });

  it('keeps the slot manifest, which is what types the Inspector inputs', async () => {
    serve({
      ok: true, name: 'stat-punch', tier: 'user', html: HTML,
      slots: {
        headline: { kind: 'text', sel: '.headline', sample: 'Sample headline' },
        accent: { kind: 'color', var: '--accent' },
      },
    });
    const doc = await loadBlock('stat-punch');
    expect(doc?.slots.headline).toEqual({ kind: 'text', sel: '.headline', sample: 'Sample headline' });
    expect(doc?.slots.accent).toEqual({ kind: 'color', var: '--accent' });
    expect(doc?.tier).toBe('user');
  });

  it('drops a slot whose kind means nothing here', async () => {
    // A shared block is another user's work, and these fields go straight to
    // querySelector and style.setProperty. Guessing at an unknown kind is how an
    // image url ends up as an element's text content.
    serve({ ok: true, html: HTML, slots: { odd: { kind: 'spreadsheet', sel: '.x' } } });
    const doc = await loadBlock('stat-punch');
    expect(doc?.slots.odd).toBeUndefined();
  });

  it('shares one request between callers that ask at the same time', async () => {
    // The Inspector re-renders on every keystroke and the overlay remounts on
    // every selection change; nine slides on one block must not be nine fetches.
    serve({ ok: true, html: HTML, slots: {} });
    await Promise.all([loadBlock('stat-punch'), loadBlock('stat-punch'), loadBlock('stat-punch')]);
    expect(calls.length).toBe(1);
  });

  it('does not remember a failure as a broken block', async () => {
    // The library is served through the user's own machine, so "not right now"
    // is normal — the desktop app may be starting up. Caching that would keep
    // the block broken for the life of the page.
    serve({ ok: false }, false);
    expect(await loadBlock('stat-punch')).toBeNull();

    serve({ ok: true, html: HTML, slots: {} });
    expect(await loadBlock('stat-punch')).not.toBeNull();
  });

  it('refuses a nameless block without going near the network', async () => {
    serve({ ok: true, html: HTML, slots: {} });
    expect(await loadBlock('  ')).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('treats an answer with no html as no block at all', async () => {
    serve({ ok: true, name: 'stat-punch', tier: 'starter', slots: {} });
    expect(await loadBlock('stat-punch')).toBeNull();
  });
});

describe('resolving what a layer stores', () => {
  it('uses authored html and never asks for a block', async () => {
    // A composition carrying its own document has been edited away from whatever
    // block it started as; re-fetching would throw that editing away.
    serve({ ok: true, html: HTML, slots: {} });
    const r = await resolveComposition(source({ inlineHtml: '<p>mine</p>' }));
    expect(r?.html).toBe('<p>mine</p>');
    expect(calls.length).toBe(0);
  });

  it('fetches the block when there is no authored html', async () => {
    serve({ ok: true, name: 'stat-punch', tier: 'starter', html: HTML, slots: {} });
    const r = await resolveComposition(source());
    expect(r?.html).toBe(HTML);
  });

  it('says so when a block has moved tier, rather than swapping designs quietly', async () => {
    // A user block can shadow a starter of the same name. Same label, different
    // design — worth a sentence, not worth refusing to render.
    serve({ ok: true, name: 'stat-punch', tier: 'user', html: HTML, slots: {} });
    const r = await resolveComposition(source({ tier: 'starter' }));
    expect(r?.tier).toBe('user');
    expect(r?.warnings.join(' ')).toMatch(/starter library and now resolves to the user/);
  });

  it('is quiet when the tier is the one it was placed from', async () => {
    serve({ ok: true, name: 'stat-punch', tier: 'starter', html: HTML, slots: {} });
    const r = await resolveComposition(source({ tier: 'starter' }));
    expect(r?.warnings).toEqual([]);
  });

  it('returns nothing for a composition that names neither', async () => {
    serve({ ok: true, html: HTML, slots: {} });
    expect(await resolveComposition(source({ block: undefined }))).toBeNull();
  });

  it('returns nothing when the block cannot be loaded', async () => {
    serve({ ok: false }, false);
    expect(await resolveComposition(source())).toBeNull();
  });
});
