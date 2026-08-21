/**
 * The animation runtime the renderer puts in every block frame.
 *
 * ── WHAT THESE ARE REALLY GUARDING ───────────────────────────────────────────
 * A block obeying its own instructions — self-contained, no network, register a
 * paused GSAP timeline — had no way to obtain GSAP. It called `gsap.timeline()`
 * against `undefined`. The shipped blocks masked it by each loading GSAP from a
 * CDN, which the same instructions forbid and the published-block sandbox blocks
 * outright, so the failure only appeared for exactly the blocks users write.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GSAP_VERSION,
  __setBlockRuntime,
  blockRuntimeScript,
  dropRedundantGsapTag,
  ensureBlockRuntime,
} from './block-runtime';
import { blockSrcdoc } from './block-render';

afterEach(() => { __setBlockRuntime(null); vi.unstubAllGlobals(); });

const tag = (url: string) => `<script src="${url}"></script>`;

describe('dropping a block’s own GSAP tag', () => {
  it('removes the CDN tag every shipped block carries', () => {
    const out = dropRedundantGsapTag(
      `<head>${tag(`https://cdn.jsdelivr.net/npm/gsap@${GSAP_VERSION}/dist/gsap.min.js`)}</head>`,
    );
    expect(out).not.toMatch(/<script/);
  });

  it('removes an unpinned one, which can only mean “whatever is current”', () => {
    expect(dropRedundantGsapTag(tag('/lib/gsap.min.js'))).toBe('');
  });

  /**
   * THE ONE IT MUST NOT TOUCH.
   *
   * A block asking for a different GSAP is asking deliberately. Swapping it for
   * ours would change how the animation behaves with nothing on screen to show
   * why — the kind of difference that is nearly untraceable later.
   */
  it('leaves a DIFFERENT pinned version alone', () => {
    const other = tag('https://cdn.jsdelivr.net/npm/gsap@3.9.1/dist/gsap.min.js');
    expect(dropRedundantGsapTag(other)).toBe(other);
  });

  it('does not touch unrelated libraries', () => {
    const three = tag('https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js');
    expect(dropRedundantGsapTag(three)).toBe(three);
  });

  it('leaves a block that never mentioned GSAP untouched', () => {
    const html = '<div>hi</div><script>const t=gsap.timeline({paused:true});</script>';
    expect(dropRedundantGsapTag(html)).toBe(html);
  });
});

describe('loading the runtime', () => {
  it('fetches both parts once and reuses them', async () => {
    const spy = vi.fn(async (url: string) => new Response(`/*${url}*/`, { status: 200 }));
    vi.stubGlobal('fetch', spy);

    const a = await ensureBlockRuntime();
    const b = await ensureBlockRuntime();

    expect(a).toBe(b);
    expect(spy).toHaveBeenCalledTimes(2); // gsap + TextPlugin, not four
    expect(a).toContain('gsap-3.14.2.min.js');
    expect(a).toContain('TextPlugin-3.14.2.min.js');
    // Registered for the 37 blocks that use `text:` and never register it.
    expect(a).toContain('registerPlugin(TextPlugin)');
  });

  /**
   * A BLOCK STILL PAINTS WITHOUT IT. Losing the preview entirely because a
   * static asset 404'd would be worse than showing it unanimated, and the
   * block's own report already carries `gsap: false` where that matters.
   */
  it('resolves null when it cannot be fetched, rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(ensureBlockRuntime()).resolves.toBeNull();
  });

  it('does not cache a failure permanently', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await ensureBlockRuntime()).toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    expect(await ensureBlockRuntime()).not.toBeNull();
  });
});

describe('injecting it into the frame', () => {
  it('is empty until the runtime has loaded, so srcdoc stays a pure function', () => {
    expect(blockRuntimeScript()).toBe('');
  });

  /**
   * A literal `</script>` in the source would close the tag early and spill the
   * rest of GSAP into the document as text. Neither vendored file contains one
   * today — this is what stops a future version bump from breaking every frame.
   */
  it('neutralises a closing tag hidden in the source', () => {
    __setBlockRuntime('var s = "</script><img onerror=alert(1)>";');
    const out = blockRuntimeScript();
    expect(out).not.toContain('</script><img');
    expect(out.match(/<\/script>/g) ?? []).toHaveLength(1);
  });
});

describe('the srcdoc a block actually renders in', () => {
  const BLOCK = '<html><head></head><body><h1 class="h">Hi</h1>'
    + '<script>const t=gsap.timeline({paused:true});window.__timelines={b:t};</script>'
    + '</body></html>';

  it('puts GSAP in before the block’s own script, which is the only thing that matters', () => {
    __setBlockRuntime('window.gsap = {timeline(){return{}}};');
    const out = blockSrcdoc(BLOCK);

    const runtimeAt = out.indexOf('window.gsap =');
    const blockAt = out.indexOf('const t=gsap.timeline');
    expect(runtimeAt).toBeGreaterThan(-1);
    expect(runtimeAt).toBeLessThan(blockAt);
  });

  /**
   * ORDER AGAINST THE CSP: the policy has to be the FIRST thing in head or a
   * script above it has already run unpoliced — including ours.
   */
  it('still lets the CSP come first in an untrusted frame', () => {
    __setBlockRuntime('window.gsap = {};');
    const out = blockSrcdoc(BLOCK, {}, 'p1', [], { untrusted: true });

    const cspAt = out.indexOf('Content-Security-Policy');
    const runtimeAt = out.indexOf('window.gsap =');
    expect(cspAt).toBeGreaterThan(-1);
    expect(cspAt).toBeLessThan(runtimeAt);
  });

  /**
   * THE WHOLE POINT, STATED AS A TEST.
   *
   * A published block renders under `script-src 'unsafe-inline'` with an opaque
   * origin, where no `<script src>` can load at all. So the block must arrive
   * with its CDN tag gone AND the runtime present, or it renders frozen.
   */
  it('makes a CDN-loading block self-sufficient in the published sandbox', () => {
    __setBlockRuntime('window.gsap = {};');
    const withCdn = `<html><head>${
      tag(`https://cdn.jsdelivr.net/npm/gsap@${GSAP_VERSION}/dist/gsap.min.js`)
    }</head><body><script>gsap.timeline({paused:true});</script></body></html>`;

    const out = blockSrcdoc(withCdn, {}, 'p1', [], { untrusted: true });

    expect(out).not.toContain('cdn.jsdelivr.net');
    expect(out).toContain('window.gsap =');
  });

  it('paints a block even when the runtime never loaded', () => {
    const out = blockSrcdoc(BLOCK);
    expect(out).toContain('Hi');
  });
});
