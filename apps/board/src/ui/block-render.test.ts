/**
 * Making a HyperFrames block renderable outside the desktop app.
 *
 * THE ONE THING THAT MAKES THIS WORK is the shim. Every block's first line is
 * `window.__hyperframes.getVariables()`, and that object is injected by the
 * DESKTOP renderer — which is not present in a browser tab. Without it the
 * script throws on line one and the preview is a blank rectangle with nothing
 * saying why. These tests pin the contract the blocks actually rely on, taken
 * from the shipped `stat-card`:
 *
 *   <html data-composition-variables='[{id,type,label,default}]'>
 *
 * and the merge rule — declared defaults, with the shot's own values over the
 * top — because "browse the library" and "preview MY scene" are the same
 * renderer with different answers.
 */
import { describe, expect, it } from 'vitest';

import { blockSrcdoc } from './block-render';

/** The real shape, trimmed: a declaration, a head, and a script that reads it. */
const BLOCK = `<!DOCTYPE html>
<html data-composition-variables='[
  {"id":"stat","type":"string","label":"The number","default":"73%"},
  {"id":"caption","type":"string","label":"Supporting line","default":"of people never finish"}
]'>
<head><meta charset="utf-8"></head>
<body>
<div id="root" data-composition-id="root" data-width="1080" data-height="1920"></div>
<script>const v = window.__hyperframes.getVariables();</script>
</body>
</html>`;

/** Evaluate the injected shim the way the iframe would, and read it back. */
function scriptContaining(srcdoc: string, needle: string): string {
  const all = [...srcdoc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const hit = all.find(code => code.includes(needle));
  if (!hit) throw new Error(`no injected script contains ${needle}`);
  return hit;
}

function variablesFrom(srcdoc: string, declaration: string): Record<string, string> {
  const shim = scriptContaining(srcdoc, '__hyperframes');
  const win: Record<string, any> = {};
  const doc = {
    documentElement: {
      getAttribute: (n: string) => (n === 'data-composition-variables' ? declaration : null),
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', shim)(win, doc);
  return win.__hyperframes.getVariables();
}

const DECL = JSON.stringify([
  { id: 'stat', type: 'string', label: 'The number', default: '73%' },
  { id: 'caption', type: 'string', label: 'Supporting line', default: 'of people never finish' },
]);

describe('blockSrcdoc', () => {
  it('puts the shim inside <head>, ahead of the block’s own script', () => {
    const out = blockSrcdoc(BLOCK);
    expect(out).toContain('__hyperframes');
    // The block's script is at the end of body, so "before it" is what matters.
    expect(out.indexOf('__hyperframes = {')).toBeLessThan(out.indexOf('getVariables();</script>'));
    // And the document itself is untouched — nothing is rewritten or stripped.
    expect(out).toContain('data-composition-id="root"');
    expect(out).toContain('<meta charset="utf-8">');
  });

  it('still injects when a block has no <head>', () => {
    const out = blockSrcdoc('<html data-composition-variables=\'[]\'><body>hi</body></html>');
    expect(out).toContain('__hyperframes');
    expect(out.indexOf('__hyperframes')).toBeLessThan(out.indexOf('<body>'));
  });

  it('injects even for a fragment with no <html> at all', () => {
    const out = blockSrcdoc('<div id="root"></div>');
    expect(out).toContain('__hyperframes');
    expect(out).toContain('<div id="root">');
  });
});

describe('the __hyperframes shim', () => {
  /**
   * BROWSING shows the designer's content. A block previewed with nothing
   * filled in must look like the design it is, not like an empty template —
   * which is exactly what the starter blocks mean by "previewable on its own".
   */
  it('falls back to every declared default', () => {
    const v = variablesFrom(blockSrcdoc(BLOCK), DECL);
    expect(v).toEqual({ stat: '73%', caption: 'of people never finish' });
  });

  /** PREVIEWING A SHOT shows that shot. */
  it('lets the shot’s own values win', () => {
    const v = variablesFrom(blockSrcdoc(BLOCK, { stat: '92%' }), DECL);
    expect(v.stat).toBe('92%');
    // Untouched keys keep the design's fallback rather than going blank.
    expect(v.caption).toBe('of people never finish');
  });

  /**
   * A slot the user cleared is not an instruction to render nothing — the card
   * writes '' for an emptied field, and honouring that would blank the design
   * rather than restore it.
   */
  it('treats an empty or whitespace value as unset', () => {
    const v = variablesFrom(blockSrcdoc(BLOCK, { stat: '', caption: '   ' }), DECL);
    expect(v.stat).toBe('73%');
    expect(v.caption).toBe('of people never finish');
  });

  it('passes through a key the block never declared', () => {
    const v = variablesFrom(blockSrcdoc(BLOCK, { brandName: 'Voidspace' }), DECL);
    expect(v.brandName).toBe('Voidspace');
  });

  it('survives a block that declares nothing', () => {
    const v = variablesFrom(blockSrcdoc(BLOCK, { stat: '5' }), '');
    expect(v).toEqual({ stat: '5' });
  });

  /**
   * THE INJECTION HAZARD. These values are the user's own copy, and a stat
   * reading `</script>` would otherwise close the shim early and hand the rest
   * of the document to the parser as markup — the block would render, subtly
   * wrong, with no error anywhere.
   */
  it('cannot be broken out of by a value containing a script tag', () => {
    const nasty = '</script><img src=x onerror=alert(1)>';
    const out = blockSrcdoc(BLOCK, { stat: nasty });
    // The literal closing tag must not appear inside the shim.
    const shim = scriptContaining(out, '__hyperframes');
    expect(shim).not.toContain('</script>');
    // And it still arrives intact as a VALUE.
    expect(variablesFrom(out, DECL).stat).toBe(nasty);
  });

  it('carries a quote-heavy value through unchanged', () => {
    const said = 'she said "no" — twice';
    expect(variablesFrom(blockSrcdoc(BLOCK, { caption: said }), DECL).caption).toBe(said);
  });
});

/**
 * PLAYING THE BLOCK.
 *
 * 113 of 128 shipped blocks build a PAUSED GSAP timeline and register it for
 * the desktop renderer to seek. In a browser that means frame zero, forever —
 * which is what "most of them are stuck on one frame" was. The driver is what
 * turns a still into a preview.
 */
describe('the timeline driver', () => {
  /** Run the injected driver against a fake `window.__timelines`. */
  function drive(timelines: Record<string, any>, ticks = 3) {
    const out = blockSrcdoc(BLOCK);
    const code = scriptContaining(out, 'vs-block-play');
    const timers: Array<() => void> = [];
    const listeners: Array<(e: { data: unknown }) => void> = [];
    const win: Record<string, any> = {
      __timelines: timelines,
      setTimeout: (fn: () => void) => { timers.push(fn); return 0; },
      addEventListener: (type: string, fn: (e: { data: unknown }) => void) => {
        if (type === 'message') listeners.push(fn);
      },
      /** Deliver a parent → frame control message, as postMessage would. */
      __vsMessage: (data: unknown) => listeners.forEach(fn => fn({ data })),
      /** Drain the settle timers, which is what lands the poster frame. */
      __vsRunTimers: () => { while (timers.length) timers.shift()!(); },
    };
    // eslint-disable-next-line no-new-func
    new Function('window', 'setTimeout', code)(win, win.setTimeout);
    for (let i = 0; i < ticks && timers.length; i++) timers.shift()!();
    return win;
  }

  function fakeTimeline(seconds = 3) {
    const calls: string[] = [];
    return {
      calls,
      repeat(n: number) { calls.push(`repeat:${n}`); return this; },
      repeatDelay(n: number) { calls.push(`repeatDelay:${n}`); return this; },
      play(from: number) { calls.push(`play:${from}`); return this; },
      duration() { return seconds; },
      pause(at?: number) { calls.push(`pause:${at ?? ''}`); return this; },
    };
  }

  it('is injected after the block’s own script, never before it', () => {
    const out = blockSrcdoc(BLOCK);
    // It can only play a timeline the block has already built.
    expect(out.indexOf('getVariables();</script>')).toBeLessThan(out.indexOf('vs-block-play'));
    // And inside the document, not appended past </body>.
    expect(out.indexOf('vs-block-play')).toBeLessThan(out.indexOf('</body>'));
  });

  /**
   * ONCE, then hold. A grid of twenty-two compositions looping forever is real
   * permanent work for a panel you are only scanning — and it shows you a
   * RANDOM frame, so a wipe caught mid-transition reads as broken. The end
   * state is the composition's designed look.
   */
  it('plays a registered timeline through once, not on a loop', () => {
    const tl = fakeTimeline();
    drive({ 'stat-card': tl });
    expect(tl.calls.slice(0, 2)).toEqual(['repeat:0', 'play:0']);
  });

  /**
   * NOT THE END FRAME. Plenty of these are built to hand off to the next scene
   * and finish FADED OUT — app-showcase, apple-money-count and browser-mockup
   * all went blank on completion, which looked identical to the frozen bug they
   * had just been rescued from. 70% is past the reveal and before the outro.
   */
  it('settles on a poster frame, not on whatever the end happens to be', () => {
    const tl = fakeTimeline(4);
    const win = drive({ 'stat-card': tl }, 8);
    win.__vsRunTimers();
    expect(tl.calls).toContain('pause:2.8');
  });

  it('pauses without a seek when the duration is unknown', () => {
    const tl = fakeTimeline(0);
    const win = drive({ 'stat-card': tl }, 8);
    win.__vsRunTimers();
    expect(tl.calls).toContain('pause:');
  });

  it('drives every timeline a composition registers', () => {
    const a = fakeTimeline();
    const b = fakeTimeline();
    drive({ intro: a, outro: b });
    expect(a.calls.slice(0, 2)).toEqual(['repeat:0', 'play:0']);
    expect(b.calls.slice(0, 2)).toEqual(['repeat:0', 'play:0']);
  });

  /** The poll must not restart something it already started. */
  it('never plays the same timeline twice', () => {
    const tl = fakeTimeline();
    drive({ 'stat-card': tl }, 6);
    expect(tl.calls.filter(c => c.startsWith('play')).length).toBe(1);
  });

  /** Hovering asks for motion; leaving hands the frame budget straight back. */
  it('loops on request and settles again when the request is withdrawn', () => {
    const tl = fakeTimeline();
    const win = drive({ 'stat-card': tl });
    tl.calls.length = 0;

    win.__vsMessage({ type: 'vs-block-play', loop: true });
    expect(tl.calls).toEqual(['repeat:-1', 'repeatDelay:0.6', 'play:0']);

    tl.calls.length = 0;
    win.__vsMessage({ type: 'vs-block-play', loop: false });
    // Back to the poster frame, not frozen wherever the hover happened to end.
    expect(tl.calls).toEqual(['repeat:0', 'pause:2.0999999999999996']);
  });

  it('ignores messages that are not for it', () => {
    const tl = fakeTimeline();
    const win = drive({ 'stat-card': tl });
    tl.calls.length = 0;
    win.__vsMessage({ type: 'something-else', loop: true });
    expect(tl.calls).toEqual([]);
  });

  /** A CSS-keyframe block registers nothing; the browser already drives it. */
  it('does nothing, and does not throw, when there are no timelines', () => {
    expect(() => drive({})).not.toThrow();
    expect(() => drive(undefined as never)).not.toThrow();
  });

  /** A block that registered something odd must not take the preview down. */
  it('survives a timeline that is not one', () => {
    const tl = { play: () => { throw new Error('nope'); } };
    expect(() => drive({ weird: tl, ok: fakeTimeline() })).not.toThrow();
  });
});

/**
 * THE UNDECLARED DEPENDENCY.
 *
 * 37 shipped blocks animate copy with `gsap.to(el, { text: … })` and none of
 * them registers TextPlugin — the desktop renderer registers it globally, so
 * the requirement is real and invisible. Without it GSAP does not throw; it
 * logs "Missing plugin?" and animates nothing, so the block renders perfectly
 * and the words simply never arrive.
 */
describe('gsap plugins', () => {
  const withGsap = (url = 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js') => `<html>
<head></head>
<body>
<div id="root" data-width="1080" data-height="1920"></div>
<script src="${url}"></script>
<script>gsap.to('.x', { text: 'hello' });</script>
</body></html>`;

  /**
   * ── THIS CHANGED WHEN THE RENDERER STARTED PROVIDING GSAP ──────────────────
   *
   * TextPlugin used to be injected after whatever GSAP tag the block carried,
   * because the block's tag was the only GSAP there was. Now the runtime is
   * injected into every frame with TextPlugin already registered, so a tag
   * asking for the version we provide is redundant and is removed — which is
   * also what makes the block work in the published sandbox, where no
   * `<script src>` of any kind can load.
   *
   * `withGsapPlugins` is therefore no longer the common path. It survives for
   * the one case that still needs it: a block deliberately pinning a DIFFERENT
   * GSAP, whose tag is left alone and which must get a matching plugin.
   */
  it('removes a tag asking for the version we already provide', () => {
    const out = blockSrcdoc(withGsap());
    expect(out).not.toContain('cdn.jsdelivr.net');
    // Nothing is left pointing at a file the sandbox could never load.
    expect(out).not.toContain('dist/TextPlugin.min.js');
    // The block's own code is untouched.
    expect(out).toContain("gsap.to('.x'");
  });

  it('removes an unpinned tag too — it can only mean “current”', () => {
    const out = blockSrcdoc(withGsap('/lib/gsap.js'));
    expect(out).not.toContain('src="/lib/gsap.js"');
    expect(out).not.toContain('src="/lib/TextPlugin.js"');
  });

  /**
   * DERIVED, NOT PINNED. A plugin from a different GSAP version than the core
   * is a support burden nobody would think to look for.
   */
  it('takes the plugin version from the block, never from here', () => {
    const out = blockSrcdoc(withGsap('https://cdn.jsdelivr.net/npm/gsap@3.9.1/dist/gsap.min.js'));
    expect(out).toContain('gsap@3.9.1/dist/TextPlugin.min.js');
    expect(out).not.toContain('3.14.2');
  });

  it('leaves a block that never loads gsap completely alone', () => {
    const plain = '<html><head></head><body><div id="root"></div></body></html>';
    const out = blockSrcdoc(plain);
    // The reporter mentions TextPlugin when it reports whether it loaded, so
    // assert on the SCRIPT TAG rather than the bare word.
    expect(out).not.toContain('TextPlugin.min.js');
    expect(out).not.toContain('registerPlugin(TextPlugin)');
  });

  /** Registration must never be what breaks a preview. */
  it('swallows a registration failure on the version-pinned path', () => {
    const out = blockSrcdoc(withGsap('https://cdn.jsdelivr.net/npm/gsap@3.9.1/dist/gsap.min.js'));
    expect(out).toMatch(/try\s*\{\s*gsap\.registerPlugin\(TextPlugin\);\s*\}\s*catch/);
  });
});
