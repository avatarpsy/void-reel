/**
 * What these pin, and why each one is load-bearing.
 *
 * The blank-frame bug is the reason this module exists: a block left alone sits
 * in its opening state, which for `data-chart` is bars at `height: 0` — a render
 * that looks like a broken design and is actually an unplayed one. Everything
 * here protects some part of "the same input renders the same finished frame".
 */
import { describe, it, expect } from 'vitest';
import { prepareComposition, prepareFromSource, type SlotSpec } from './document';

/** Shaped like a real block: root carries the frame, GSAP comes from the CDN,
 *  and a timeline is registered on `window.__timelines`. */
const BLOCK = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body>
  <div id="root" data-composition-id="stat-card" data-width="1920" data-height="1080" data-duration="6">
    <div class="eyebrow">LIVE NOW</div>
    <div class="headline">Sample headline</div>
    <div class="subtitle">Sample subtitle</div>
    <img class="shot" src="" alt="" />
  </div>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <script>window.__timelines = {};</script>
</body></html>`;

const SLOTS: Record<string, SlotSpec> = {
  headline: { kind: 'text', sel: '.headline', sample: 'Sample headline' },
  subtitle: { kind: 'text', sel: '.subtitle', sample: 'Sample subtitle' },
  screenshot: { kind: 'image', sel: '.shot', sample: 'a screenshot' },
  accent: { kind: 'color', var: '--accent', sample: '#0066FF' },
};

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('the frame a block was designed at', () => {
  it('reads the native size from the composition root', () => {
    const r = prepareComposition(BLOCK);
    expect(r.width).toBe(1920);
    expect(r.height).toBe(1080);
    expect(r.durationSec).toBe(6);
  });

  it('falls back and says so when there is no composition root', () => {
    const r = prepareComposition('<html><body><p>hi</p></body></html>');
    expect(r.width).toBe(1920);
    expect(r.warnings.join(' ')).toMatch(/no \[data-composition-id\]/);
  });
});

describe('filling slots', () => {
  it('puts text in the element the manifest names', () => {
    const r = prepareComposition(BLOCK, { slots: SLOTS, values: { headline: 'Avatar Psy' } });
    expect(parse(r.html).querySelector('.headline')?.textContent).toBe('Avatar Psy');
  });

  it('sets media as src, not as text', () => {
    const url = 'https://example.com/a.png';
    const r = prepareComposition(BLOCK, { slots: SLOTS, values: { screenshot: url } });
    expect(parse(r.html).querySelector('.shot')?.getAttribute('src')).toBe(url);
  });

  it('sets a colour on the DOCUMENT root, where body can inherit it', () => {
    // Custom properties inherit downward only, and blocks consume these ABOVE
    // the composition element: html,body{background:var(--bg)} is the shipped
    // pattern, so a variable set on the composition div never reaches body.
    // render-hyperframes.post.ts sets them on documentElement for the same
    // reason; matching it is what keeps one block from theming two ways.
    const r = prepareComposition(BLOCK, { slots: SLOTS, values: { accent: '#FF1493' } });
    const html = parse(r.html).documentElement as HTMLElement;
    expect(html.style.getPropertyValue('--accent')).toBe('#FF1493');
  });

  it('falls back to --<key> for a colour slot that names no variable', () => {
    const slots = { tint: { kind: 'color' } as SlotSpec };
    const r = prepareComposition(BLOCK, { slots, values: { tint: '#123456' } });
    const html = parse(r.html).documentElement as HTMLElement;
    expect(html.style.getPropertyValue('--tint')).toBe('#123456');
  });

  it('reports a value for a slot the block does not declare, rather than dropping it', () => {
    const r = prepareComposition(BLOCK, { slots: SLOTS, values: { nope: 'x' } });
    expect(r.warnings.join(' ')).toMatch(/does not declare .*slot/);
  });

  it('survives a selector that matches nothing', () => {
    const slots = { gone: { kind: 'text', sel: '.not-here' } as SlotSpec };
    const r = prepareComposition(BLOCK, { slots, values: { gone: 'x' } });
    expect(r.warnings.join(' ')).toMatch(/matched nothing/);
  });
});

describe('fill modes', () => {
  // preview keeps a block looking like something in a picker; render must never
  // ship the designer's placeholder inside the user's work.
  it('preview leaves the designer sample in an unfilled slot', () => {
    const r = prepareComposition(BLOCK, { slots: SLOTS, fillMode: 'preview', values: { headline: 'X' } });
    const d = parse(r.html);
    expect(d.querySelector('.subtitle')?.textContent).toBe('Sample subtitle');
    expect((d.querySelector('.subtitle') as HTMLElement).style.display).not.toBe('none');
  });

  it('render hides an unfilled slot instead of showing the sample', () => {
    const r = prepareComposition(BLOCK, { slots: SLOTS, fillMode: 'render', values: { headline: 'X' } });
    const el = parse(r.html).querySelector('.subtitle') as HTMLElement;
    expect(el.style.display).toBe('none');
  });

  it('render leaves a colour slot alone — a variable has no element to hide', () => {
    const r = prepareComposition(BLOCK, { slots: SLOTS, fillMode: 'render', values: { headline: 'X' } });
    const root = parse(r.html).querySelector('[data-composition-id]') as HTMLElement;
    expect(root.getAttribute('style') ?? '').not.toMatch(/display:\s*none/);
  });

  it('counts blank and missing values as unfilled', () => {
    const r = prepareComposition(BLOCK, { slots: SLOTS, values: { headline: '   ', subtitle: undefined } });
    expect(r.unfilled).toEqual(expect.arrayContaining(['headline', 'subtitle']));
  });
});

describe('the runtime is vendored, not fetched', () => {
  // 113 of 128 blocks fetch GSAP from a CDN. Offline or behind a strict CSP that
  // fetch fails and the block renders blank — silently, looking like a design bug.
  it('rewrites the CDN GSAP tag to the local copy', () => {
    const r = prepareComposition(BLOCK, { runtimeUrl: '/vendor/gsap.min.js' });
    const srcs = [...parse(r.html).querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
    expect(srcs).toContain('/vendor/gsap.min.js');
    expect(srcs.join(' ')).not.toMatch(/cdn\.jsdelivr\.net/);
  });

  it('reports any other external script it did not vendor', () => {
    const withOther = BLOCK.replace('</body>', '<script src="https://example.com/x.js"></script></body>');
    const r = prepareComposition(withOther, { runtimeUrl: '/vendor/gsap.min.js' });
    expect(r.warnings.join(' ')).toMatch(/example\.com\/x\.js/);
  });

  it('leaves a block that needs no runtime untouched', () => {
    const noGsap = BLOCK.replace(/<script src="https:\/\/cdn[^"]*"><\/script>/, '');
    const r = prepareComposition(noGsap, { runtimeUrl: '/vendor/gsap.min.js' });
    expect(r.warnings.join(' ')).not.toMatch(/not vendored/);
  });
});

describe('the ready agent', () => {
  it('is injected, so the frame can report when it has settled', () => {
    const r = prepareComposition(BLOCK);
    expect(r.html).toMatch(/__composition/);
    expect(r.html).toMatch(/postMessage/);
  });

  it('seeks to the settled end state by default — a still of an unplayed block is blank', () => {
    const r = prepareComposition(BLOCK);
    expect(r.html).toMatch(/var POSE = "end"/);
    expect(r.html).toMatch(/progress\(1\)/);
  });

  it('honours an explicit pose time for scrubbing a specific frame', () => {
    const r = prepareComposition(BLOCK, { poseTime: 2.5 });
    expect(r.html).toMatch(/var POSE = 2\.5/);
  });

  it('carries a bounded timeout, so a missing font cannot hang a render', () => {
    const r = prepareComposition(BLOCK, { readyTimeoutMs: 1234 });
    expect(r.html).toMatch(/var TIMEOUT = 1234/);
  });

  it('seeks every registered timeline, not just the first', () => {
    // A document can host more than one composition; a half-seeked frame is the
    // blank-chart bug in a subtler form.
    const r = prepareComposition(BLOCK);
    expect(r.html).toMatch(/for \(var id in reg\)/);
  });
});

describe('the document stays a document', () => {
  it('comes back with a doctype and the original markup intact', () => {
    const r = prepareComposition(BLOCK, { slots: SLOTS, values: { headline: 'Kept' } });
    expect(r.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(parse(r.html).querySelector('.eyebrow')?.textContent).toBe('LIVE NOW');
  });

  it('does not mutate the caller\'s html', () => {
    const before = BLOCK;
    prepareComposition(BLOCK, { slots: SLOTS, values: { headline: 'X' } });
    expect(BLOCK).toBe(before);
  });
});

describe('the ready signal survives a late listener', () => {
  /**
   * A postMessage only reaches a listener that is already attached. A same-origin
   * host can fall back to reading the latch off the document — but a SANDBOXED
   * frame has an opaque origin, so that latch is unreadable from outside and the
   * host must be able to ASK again. Observed in a browser before this existed: a
   * listener attached one second late saw nothing while the frame behind it was
   * fully settled.
   *
   * Asserted by behaviour rather than by variable name — the first version of
   * these pinned an identifier and broke on a rename that changed nothing.
   */
  it('latches the outcome where a same-origin host can read it', () => {
    const r = prepareComposition(BLOCK);
    expect(r.html).toMatch(/window\.__compositionReady\s*=/);
    expect(r.html).toMatch(/data-composition-ready/);
  });

  it('answers a ping, which is the only way a sandboxed host can re-ask', () => {
    const r = prepareComposition(BLOCK);
    expect(r.html).toMatch(/'ping'/);
  });

  it('reports pending rather than silence when asked before it has settled', () => {
    const r = prepareComposition(BLOCK);
    expect(r.html).toMatch(/pending/);
  });
});

describe('consistency with the board renderer', () => {
  /**
   * The board and the image editor must render the same block the same way.
   * These pin the three places the two implementations could quietly diverge —
   * each one taken from `render-hyperframes.post.ts`, where the reasoning was
   * worked out first.
   */
  it('defaults to render, the mode that cannot leak a designer sample into finished work', () => {
    const r = prepareComposition(BLOCK, { slots: SLOTS, values: { headline: 'X' } });
    expect((parse(r.html).querySelector('.subtitle') as HTMLElement).style.display).toBe('none');
  });

  it('hides NOTHING when nothing was filled, so a decorative block is not blanked', () => {
    // A transition or sting declares slots and is often chosen precisely for the
    // content baked into it. Hiding every unfilled slot there does not tidy the
    // design, it erases it.
    const r = prepareComposition(BLOCK, { slots: SLOTS, fillMode: 'render', values: {} });
    const d = parse(r.html);
    expect((d.querySelector('.headline') as HTMLElement).style.display).not.toBe('none');
    expect((d.querySelector('.subtitle') as HTMLElement).style.display).not.toBe('none');
    expect(d.querySelector('.headline')?.textContent).toBe('Sample headline');
  });

  it('never hides a colour slot, by binding AND by kind', () => {
    const slots = { tint: { kind: 'color', sel: '.headline' } as SlotSpec, headline: SLOTS.headline };
    const r = prepareComposition(BLOCK, { slots, fillMode: 'render', values: { headline: 'X' } });
    // `tint` is unfilled and element-bound, but it is a colour — it must survive.
    expect((parse(r.html).querySelector('.headline') as HTMLElement).style.display).not.toBe('none');
  });
});

describe('waiting only for what is actually coming', () => {
  /**
   * 15 of the 128 shipped blocks carry no GSAP — browser-mockup, cta-endcard,
   * hook-statement and list-steps among them, which are some of the most
   * slide-shaped in the library. Waiting for a timeline that will never register
   * spent the WHOLE timeout on every render of those, turning an instant static
   * composition into an eight-second one.
   */
  it('expects a timeline when the block loads gsap', () => {
    const r = prepareComposition(BLOCK);
    expect(r.html).toMatch(/var EXPECTS_TIMELINE = true/);
  });

  it('does not wait for a timeline in a block that has no animation runtime', () => {
    const still = `<!DOCTYPE html><html><body>
      <div data-composition-id="poster" data-width="1080" data-height="1350">
        <div class="headline">Static</div>
      </div></body></html>`;
    const r = prepareComposition(still);
    expect(r.html).toMatch(/var EXPECTS_TIMELINE = false/);
  });

  it('recognises a timeline registered without a gsap script tag', () => {
    const inline = BLOCK.replace(/<script src="https:\/\/cdn[^"]*"><\/script>/, '');
    const r = prepareComposition(inline);
    // The block still registers on __timelines, so a timeline IS coming.
    expect(r.html).toMatch(/var EXPECTS_TIMELINE = true/);
  });

  it('waits for the load event, so a CSS background image cannot be missed', () => {
    // A background-image is not in document.images and is not a font, so the
    // other two gates do not see it at all.
    const r = prepareComposition(BLOCK);
    expect(r.html).toMatch(/function subresources/);
    expect(r.html).toMatch(/addEventListener\('load'/);
  });
});

describe('the frame a composition renders into', () => {
  /**
   * The twelve deck-ready blocks are 1080x1920 natively while listing 16:9 among
   * their aspects. Reading the root's declared size therefore hands a landscape
   * deck a portrait frame. Their CSS does adapt — stat-punch forced to 1920×1080
   * reflows into landscape correctly — but the frame has to be given.
   */
  const PORTRAIT = BLOCK.replace('data-width="1920" data-height="1080"', 'data-width="1080" data-height="1920"');

  it('defaults to the size the block declares', () => {
    const r = prepareComposition(PORTRAIT);
    expect([r.width, r.height]).toEqual([1080, 1920]);
    expect([r.nativeWidth, r.nativeHeight]).toEqual([1080, 1920]);
  });

  it('renders into a requested frame instead', () => {
    const r = prepareComposition(PORTRAIT, { frameWidth: 1920, frameHeight: 1080 });
    expect([r.width, r.height]).toEqual([1920, 1080]);
  });

  it('writes the frame onto the root, which is what a renderer sizes the page from', () => {
    // Leaving the declared value there renders a landscape slide in a portrait
    // page, whatever the caller believed it asked for.
    const r = prepareComposition(PORTRAIT, { frameWidth: 1920, frameHeight: 1080 });
    const root = parse(r.html).querySelector('[data-composition-id]')!;
    expect(root.getAttribute('data-width')).toBe('1920');
    expect(root.getAttribute('data-height')).toBe('1080');
  });

  it('still reports what the block declared, so a caller can see it overrode it', () => {
    const r = prepareComposition(PORTRAIT, { frameWidth: 1920, frameHeight: 1080 });
    expect([r.nativeWidth, r.nativeHeight]).toEqual([1080, 1920]);
  });

  it('leaves the root alone when the frame matches', () => {
    const r = prepareComposition(BLOCK, { frameWidth: 1920, frameHeight: 1080 });
    expect(parse(r.html).querySelector('[data-composition-id]')!.getAttribute('data-width')).toBe('1920');
  });

  it('falls back to the block frame for a nonsense request', () => {
    // ?? alone accepts 0 and NaN, and clamping then turns a zero into a
    // one-pixel page: nonsense answered with nonsense rather than with the
    // frame the block actually declares.
    for (const bad of [0, -5, Number.NaN]) {
      const r = prepareComposition(BLOCK, { frameWidth: bad, frameHeight: bad });
      expect([r.width, r.height]).toEqual([1920, 1080]);
    }
  });
});

describe('preparing from a stored composition', () => {
  /**
   * The bridge exists to stop the document and the cache key describing
   * different things. The key covers frame, slots, fill mode and pose; a caller
   * hand-mapping those could pass a frame the key does not mention, and the
   * cache would then serve that render to a composition it does not match.
   */
  const source = {
    block: 'stat-card',
    tier: 'starter' as const,
    slots: { headline: 'From the layer' },
    fillMode: 'render' as const,
    poseTime: 1.5,
    frameWidth: 1080,
    frameHeight: 1350,
    renderHash: 'whatever',
  };

  it('renders into the frame the source records, not the block default', () => {
    const r = prepareFromSource(BLOCK, source, SLOTS);
    expect([r.width, r.height]).toEqual([1080, 1350]);
  });

  it('fills from the source values against the block manifest', () => {
    const r = prepareFromSource(BLOCK, source, SLOTS);
    expect(parse(r.html).querySelector('.headline')?.textContent).toBe('From the layer');
  });

  it('carries the fill mode, so an unfilled slot is hidden as the source asked', () => {
    const r = prepareFromSource(BLOCK, source, SLOTS);
    expect((parse(r.html).querySelector('.subtitle') as HTMLElement).style.display).toBe('none');
  });

  it('carries the pose time', () => {
    expect(prepareFromSource(BLOCK, source, SLOTS).html).toMatch(/POSE = 1\.5/);
  });

  it('works with no manifest — an authored block declares no slots', () => {
    const r = prepareFromSource(BLOCK, { ...source, slots: {} });
    expect(r.unfilled).toEqual([]);
    expect(r.width).toBe(1080);
  });
});

/**
 * A BLOCK THAT KEEPS ITS MARKUP IN A `<template>`.
 *
 * `document.querySelector` cannot reach into template content — that is what a
 * template IS — so every slot these blocks declared resolved to null, the fill
 * was skipped, and the block rendered with the designer's placeholder text in
 * it. The call reported success. Measured across the starter library: 72
 * declared slots on 12 `code-snippet-*` blocks, none of them fillable.
 */
describe('a slot inside a template', () => {
  const TPL_BLOCK = [
    '<!doctype html><html><body>',
    '<div data-composition-id="tpl-demo">',
    '<template id="row"><div class="kicker">PLACEHOLDER</div></template>',
    '</div></body></html>',
  ].join('');
  const TPL_SLOTS: Record<string, SlotSpec> = { kicker: { sel: '.kicker', kind: 'text' } };

  const contentOf = (html: string) => {
    const tpl = parse(html).querySelector('template') as HTMLTemplateElement | null;
    return tpl?.content?.querySelector('.kicker')?.textContent ?? null;
  };

  it('fills it, rather than reporting success and changing nothing', () => {
    const r = prepareComposition(TPL_BLOCK, { slots: TPL_SLOTS, values: { kicker: 'REAL' } });
    expect(contentOf(r.html)).toBe('REAL');
  });

  it('does not warn that the selector matched nothing', () => {
    const r = prepareComposition(TPL_BLOCK, { slots: TPL_SLOTS, values: { kicker: 'REAL' } });
    expect((r.warnings ?? []).join(' ')).not.toMatch(/matched nothing/);
  });

  /**
   * Hiding only applies once SOMETHING has been filled — a block with no values
   * at all keeps the designer's sample text on purpose. So this fills one slot
   * and leaves the other, which is the case that actually occurs.
   */
  it('hides a sibling slot nobody filled', () => {
    const TWO = [
      '<!doctype html><html><body>',
      '<div data-composition-id="tpl-demo">',
      '<template id="row">',
      '<div class="kicker">PLACEHOLDER</div><div class="sub">ALSO PLACEHOLDER</div>',
      '</template>',
      '</div></body></html>',
    ].join('');
    const SLOTS2: Record<string, SlotSpec> = {
      kicker: { sel: '.kicker', kind: 'text' },
      sub: { sel: '.sub', kind: 'text' },
    };
    const r = prepareComposition(TWO, { slots: SLOTS2, values: { kicker: 'REAL' } });
    const tpl = parse(r.html).querySelector('template') as HTMLTemplateElement;
    expect(tpl.content.querySelector('.kicker')?.textContent).toBe('REAL');
    const sub = tpl.content.querySelector('.sub') as HTMLElement;
    // Either route is correct — the element inside template content may belong
    // to another document, where `instanceof HTMLElement` is false and the
    // attribute path runs instead.
    const hidden = sub.style?.display === 'none'
      || /display\s*:\s*none/.test(sub.getAttribute('style') ?? '');
    expect(hidden).toBe(true);
  });
});
