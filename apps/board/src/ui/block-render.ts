/**
 * Showing a HyperFrames block, live.
 *
 * WHY A LIVE RENDER AND NOT A THUMBNAIL. A block is layout, typography AND
 * MOTION. Zero previews exist on disk (`BLOCK_SHARING_BUILD_PLAN.md` §1 measured
 * that: 0 of 128), and even once they do, a still frame of a kinetic text slam
 * is the least informative frame of it. The block is a self-contained HTML
 * document that renders in a few milliseconds — so the honest preview is to run
 * it, which is also what the finished scene will do.
 *
 * THE SHIM IS THE WHOLE TRICK. Every block calls
 * `window.__hyperframes.getVariables()` on its first line and would throw
 * without it — that object is injected by the DESKTOP renderer, which is not
 * here. The contract is small and fully declared by the document itself:
 * `<html data-composition-variables='[{id,type,label,default}]'>` says what the
 * block takes and what it falls back to, which is exactly why the starter blocks
 * say they are "previewable on their own". So the shim reads the declaration and
 * merges whatever the shot has actually set over the top. A shot with
 * `{ stat: "92%" }` previews as 92%; an untouched block previews as its
 * designer's demo content, which is the right answer for browsing.
 *
 * ISOLATION: `sandbox="allow-scripts"` and deliberately NOT `allow-same-origin`.
 * That gives the block an opaque origin — it cannot read this document, our
 * cookies, our storage or the parent page, which is the boundary that matters
 * when arbitrary local JS runs inside the editor.
 *
 * WHAT IS NOT LOCKED DOWN, and why. 113 of 128 blocks pull GSAP and webfonts
 * from a CDN, so a `connect-src 'none'` CSP would render seven out of eight
 * blocks as a blank card. These are the user's OWN blocks, already running on
 * their own machine every time they render. The network lockdown belongs to
 * Phase 1 of block SHARING, where the block came from a stranger — see
 * `BLOCK_SHARING_BUILD_PLAN.md` §3. Adding it here would break the feature today
 * to defend against a threat that does not exist yet.
 */
import { getParentToken } from '../board/parent-auth';

/** One block's source, as the preview needs it. */
export interface BlockDoc {
  name: string;
  tier: 'user' | 'starter';
  html: string;
  /** Native composition size, from the root element's data attributes. */
  width: number;
  height: number;
}

/**
 * Fetched once per name, for the life of the page.
 *
 * A board with nine graphics on the same lower third would otherwise fetch it
 * nine times, and the panel re-renders on every keystroke of the search. Blocks
 * are ~5–35 KB and immutable within a session, so the cache is small and cannot
 * go stale in a way anyone would notice.
 *
 * The PROMISE is cached, not the result — two cards mounting in the same frame
 * must share one request rather than race two.
 */
const cache = new Map<string, Promise<BlockDoc | null>>();

/** `data-width="1080"` on the root. Absent on a hand-written block; 9:16 then. */
function sizeOf(html: string): { width: number; height: number } {
  const w = /data-width\s*=\s*["'](\d+)["']/.exec(html);
  const h = /data-height\s*=\s*["'](\d+)["']/.exec(html);
  return {
    width: w ? Number(w[1]) : 1080,
    height: h ? Number(h[1]) : 1920,
  };
}

export async function loadBlock(name: string): Promise<BlockDoc | null> {
  const key = String(name || '').trim();
  if (!key) return null;
  const hit = cache.get(key);
  if (hit) return hit;

  const req = (async (): Promise<BlockDoc | null> => {
    const token = await getParentToken().catch(() => null);
    const res = await fetch('/api/studio/blocks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ action: 'get', name: key }),
    }).catch(() => null);
    if (!res?.ok) return null;
    const j = await res.json().catch(() => null);
    if (!j?.ok || typeof j.html !== 'string' || !j.html) return null;
    return {
      name: j.name ?? key,
      tier: j.tier === 'user' ? 'user' : 'starter',
      html: j.html,
      ...sizeOf(j.html),
    };
  })();

  cache.set(key, req);
  // A failed fetch must not be remembered as "this block is broken" forever —
  // the desktop app may simply have been starting up.
  void req.then(doc => { if (!doc) cache.delete(key); });
  return req;
}

/** Escape for a `srcdoc` attribute set via property assignment (no HTML parse). */
function shimFor(vars: Record<string, string>): string {
  // Values are the user's own copy, so they go through JSON.stringify rather
  // than string concatenation — a stat reading `</script>` would otherwise end
  // the shim and take the rest of the document with it.
  const json = JSON.stringify(vars ?? {}).replace(/</g, '\\u003c');
  return `<script>(function(){
  var over = ${json};
  window.__hyperframes = {
    getVariables: function () {
      var out = {};
      try {
        var decl = JSON.parse(document.documentElement.getAttribute('data-composition-variables') || '[]');
        for (var i = 0; i < decl.length; i++) {
          var d = decl[i];
          if (d && d.id) out[d.id] = d['default'] != null ? d['default'] : '';
        }
      } catch (e) { /* an undeclared block simply has no defaults */ }
      for (var k in over) {
        if (String(over[k] == null ? '' : over[k]).trim()) out[k] = over[k];
      }
      return out;
    },
  };
})();<\/script>`;
}

/**
 * PRESS PLAY.
 *
 * 113 of the 128 shipped blocks build `gsap.timeline({ paused: true })` and
 * register it on `window.__timelines[id]`. That is not an oversight — it is the
 * contract: the desktop renderer creates the timeline paused and SEEKS it frame
 * by frame to capture the video. Nothing about a block plays itself.
 *
 * So in a browser they mounted and sat on frame zero, which is exactly what
 * "most of them are stuck on one frame" is. The three blocks that did animate
 * are the `data-no-timeline` ones: pure CSS keyframes, which the browser drives
 * on its own.
 *
 * A preview is not a render, so here the timeline gets PLAYED instead of
 * seeked, and looped — a two-second animation that runs once while you are
 * looking at a different tile has told you nothing. The repeat delay is the
 * beat between cycles that stops a wall of tiles looking like a slot machine.
 *
 * POLLED, not fired on load: the timeline is registered by an inline script
 * that runs after a BLOCKING GSAP fetch from a CDN, so how long it takes is a
 * network question. Bounded, so a block that registers nothing (the CSS ones)
 * costs a few cheap ticks and then stops.
 */
/**
 * WHAT THE BLOCK DID, reported back out.
 *
 * A preview runs in a sandbox with an OPAQUE ORIGIN, which is what makes it
 * safe and also what makes it undebuggable: the parent cannot read the frame's
 * document, so "why is this one still on frame zero" has no answer from the
 * outside. `postMessage` is the one channel that survives the boundary.
 *
 * This is not only for debugging. It is what lets the preview tell the
 * difference between the three ways a composition can show nothing — it threw,
 * it registered no timeline, or it genuinely renders empty — and say so instead
 * of leaving a blank rectangle that looks identical in all three cases.
 */
const REPORTER = `<script>(function(){
  var errors = [];
  window.addEventListener('error', function (e) {
    errors.push(String((e && e.message) || 'error') + (e && e.filename ? ' @ ' + e.filename : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    errors.push('unhandled: ' + String((e && e.reason && e.reason.message) || e.reason || ''));
  });
  function report(phase) {
    var tl = 0;
    try { for (var k in (window.__timelines || {})) tl++; } catch (e) {}
    var root = document.querySelector('[data-composition-id]') || document.body;
    var box = null;
    try { box = root.getBoundingClientRect(); } catch (e) {}
    try {
      parent.postMessage({
        type: 'vs-block-report',
        id: window.__vsPreviewId,
        phase: phase,
        timelines: tl,
        gsap: typeof window.gsap !== 'undefined',
        textPlugin: typeof window.TextPlugin !== 'undefined',
        nodes: root ? root.querySelectorAll('*').length : 0,
        w: box ? Math.round(box.width) : 0,
        h: box ? Math.round(box.height) : 0,
        errors: errors.slice(0, 4)
      }, '*');
    } catch (e) {}
  }
  window.addEventListener('load', function () { report('load'); setTimeout(function(){ report('settled'); }, 1500); });
})();<\/script>`;

/**
 * PRESS PLAY — ONCE, THEN HOLD.
 *
 * 113 of the 128 shipped blocks build `gsap.timeline({ paused: true })` and
 * register it on `window.__timelines[id]`. That is the contract: the desktop
 * renderer creates the timeline paused and SEEKS it frame by frame to capture
 * video. Nothing about a block plays itself, which is why they all sat on frame
 * zero in a browser.
 *
 * WHY ONCE AND NOT ON A LOOP, which is what this did first. Twenty-two
 * compositions looping forever in a grid — GSAP timelines, canvas draws, and 16
 * blocks in the kit that take a WebGL context — is real, permanent work for a
 * panel you are only scanning. It also picks a RANDOM frame to show you: glance
 * at a tile mid-transition and you see the transparent middle of a wipe, which
 * reads as "broken" when it is simply the wrong moment.
 *
 * Playing through once and holding the end state fixes both. The held frame is
 * the composition's finished, designed look — the single most useful frame it
 * has — and the cost drops to nothing the moment it settles. Motion is then
 * available on demand: hover a tile or a shot card and it loops, the lightbox
 * always loops.
 */
/**
 * PRESS PLAY, THEN HOLD A POSTER FRAME.
 *
 * 113 of the 128 shipped blocks build `gsap.timeline({ paused: true })` and
 * register it on `window.__timelines[id]`. That is the contract: the desktop
 * renderer creates the timeline paused and SEEKS it frame by frame to capture
 * video. Nothing about a block plays itself, which is why they all sat on frame
 * zero in a browser.
 *
 * WHY NOT JUST LOOP EVERYTHING, which is what this did first. Twenty-two
 * compositions animating forever in a grid — GSAP timelines, canvas draws, and
 * 16 blocks in the kit that take a WebGL context — is permanent work for a
 * panel you are only scanning.
 *
 * AND WHY NOT HOLD THE END, which is what it did second. Plenty of these are
 * built to hand off to the next scene, so they END FADED OUT: app-showcase,
 * apple-money-count and browser-mockup all went blank the moment they finished,
 * which looked exactly like the frozen-on-frame-zero bug they had just been
 * rescued from.
 *
 * So: play through once — some blocks paint to a canvas from timeline callbacks
 * and need the playhead to have actually travelled — then settle at 70% of the
 * duration. That is past the reveal and before the outro on a reveal, and the
 * middle of the movement on a transition, which makes it the most
 * representative single frame a composition has. Hovering plays it properly.
 */
const DRIVER = `<script>(function(){
  var tls = [];
  var tries = 0;
  var POSTER = 0.7;

  function poster(tl) {
    try {
      var d = typeof tl.duration === 'function' ? tl.duration() : 0;
      if (d > 0) tl.pause(d * POSTER); else tl.pause();
    } catch (e) {}
  }

  function settle(tl) {
    // GSAP timelines are thenable; the fallback timer covers a build where the
    // promise never resolves so a preview can never be left mid-flight.
    var done = false;
    var finish = function () { if (done) return; done = true; poster(tl); };
    try {
      var d = typeof tl.duration === 'function' ? tl.duration() : 3;
      setTimeout(finish, Math.min(12000, (d || 3) * 1000 + 200));
      if (typeof tl.then === 'function') tl.then(finish);
    } catch (e) { finish(); }
  }

  function collect() {
    var found = 0;
    for (var k in (window.__timelines || {})) {
      var tl = window.__timelines[k];
      if (!tl || tl.__vsSeen) continue;
      tl.__vsSeen = true;
      tls.push(tl);
      found++;
      try { tl.repeat(0); tl.play(0); settle(tl); } catch (e) {}
    }
    // Keep watching briefly: a composition may build several, and a slow CDN
    // can register them late.
    if (tries++ < 40) setTimeout(collect, found ? 400 : 100);
  }
  collect();

  function setLoop(on) {
    for (var i = 0; i < tls.length; i++) {
      var tl = tls[i];
      try {
        if (on) { tl.repeat(-1); tl.repeatDelay(0.6); tl.play(0); }
        else { tl.repeat(0); poster(tl); }
      } catch (e) {}
    }
  }

  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.type !== 'vs-block-play') return;
    setLoop(!!d.loop);
  });
})();<\/script>`;

/**
 * THE PLUGIN THE BLOCKS ASSUME IS ALREADY THERE.
 *
 * 37 of the 128 shipped blocks animate copy with `gsap.to(el, { text: … })`,
 * and NOT ONE of them calls `gsap.registerPlugin`. That works in the desktop
 * renderer because the renderer registers TextPlugin globally before it loads a
 * block — so the dependency is real, undeclared, and invisible until you host a
 * block somewhere else.
 *
 * What it looks like when it is missing is exactly what was reported: the block
 * renders, the layout is right, and the words never arrive. GSAP does not
 * throw — it logs `Invalid property text set to … Missing plugin?` and animates
 * nothing, which is why the tiles looked frozen rather than broken.
 *
 * The plugin URL is DERIVED from the block's own GSAP tag rather than pinned
 * here, so the two can never drift to different versions — every shipped block
 * currently loads gsap@3.14.2, and a block that pins something else gets the
 * matching plugin for free.
 *
 * Injected immediately after that tag: classic `<script src>` tags execute in
 * document order, so the plugin is registered before the block's own inline
 * script runs, which is the only moment that matters.
 */
const GSAP_TAG = /<script[^>]*\ssrc=["']([^"']*gsap(?:\.min)?\.js)["'][^>]*>\s*<\/script>/i;

function withGsapPlugins(html: string): string {
  return html.replace(GSAP_TAG, (tag, url: string) => {
    const plugin = url.replace(/gsap(\.min)?\.js$/i, 'TextPlugin$1.js');
    if (plugin === url) return tag;
    return `${tag}<script src="${plugin}"><\/script><script>try{gsap.registerPlugin(TextPlugin);}catch(e){}<\/script>`;
  });
}

/**
 * FILL THE SLOTS THE WAY THE HOST DOES.
 *
 * There are TWO filling mechanisms in the kit and only one of them is the
 * block's own business. Three blocks declare `variables[]` and call
 * `getVariables()` themselves — the shim above covers those. The other 102
 * declare `slots{}` with a `sel` or a `var` and never look at the values at
 * all: the HOST is expected to reach into the DOM and patch them.
 *
 * Which is why, before this, typing a headline on a `browser-mockup` shot
 * changed nothing on screen. The block was rendering perfectly — with the
 * designer's placeholder copy, because nobody had done the host's half.
 *
 * Runs LAST, after the block has built itself, and again on every repaint.
 */
function patcherFor(slots: SlotFill[]): string {
  // ALWAYS injected, even with nothing to fill: it is also the listener that
  // makes later edits land without a reload.
  const json = JSON.stringify(slots).replace(/</g, '\\u003c');
  return `<script>(function(){
  var fills = ${json};
  function apply() {
    for (var i = 0; i < fills.length; i++) {
      var f = fills[i];
      try {
        if (f.cssVar) {
          document.documentElement.style.setProperty(f.cssVar, f.value);
          if (document.body) document.body.style.setProperty(f.cssVar, f.value);
          continue;
        }
        if (!f.sel) continue;
        var nodes = document.querySelectorAll(f.sel);
        for (var j = 0; j < nodes.length; j++) {
          var el = nodes[j];
          if (f.kind === 'image' || f.kind === 'video') {
            // An <img>/<video> takes a src; anything else is a container that
            // wants it as a background, which is how the full-bleed slots work.
            if ('src' in el) { el.src = f.value; el.removeAttribute('srcset'); }
            else { el.style.backgroundImage = 'url(' + JSON.stringify(f.value).slice(1, -1) + ')'; el.style.backgroundSize = 'cover'; el.style.backgroundPosition = 'center'; }
          } else if (f.kind === 'color') {
            el.style.color = f.value;
          } else {
            el.textContent = f.value;
          }
        }
      } catch (e) { /* one bad selector must not stop the rest */ }
    }
  }
  apply();
  // The block's own script may rewrite its text after we patch — several build
  // their content from a timeline. Re-apply on the next frames rather than
  // racing it once and losing.
  var n = 0;
  var again = setInterval(function () { apply(); if (++n > 6) clearInterval(again); }, 120);

  /**
   * LIVE UPDATES, WITHOUT A RELOAD.
   *
   * Typing a headline used to reassign srcdoc, which tears the document down
   * and rebuilds it: the CDN fetch, the timeline, the whole composition,
   * restarting from frame zero on every edit. Patching in place is one DOM
   * write, so the preview keeps its poster frame and the change appears
   * instantly.
   */
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.type !== 'vs-block-slots' || !d.fills) return;
    fills = d.fills;
    apply();
  });
})();<\/script>`;
}

/**
 * The document to hand the iframe: the block, with the shim in front of it and
 * the driver behind it.
 *
 * The shim goes in `<head>` — it has to exist before the block's first line,
 * which calls `getVariables()`. The driver goes LAST, because it can only play
 * a timeline the block has already built.
 */
/** One resolved slot value, ready to be written into the composition. */
export interface SlotFill {
  key: string;
  kind: 'text' | 'image' | 'video' | 'color';
  value: string;
  sel?: string;
  cssVar?: string;
}

export function blockSrcdoc(
  html: string,
  vars: Record<string, string> = {},
  previewId = '',
  slots: SlotFill[] = [],
): string {
  // The reporter goes FIRST — its error listener has to predate the block's own
  // scripts or the failure it exists to catch happens before it is watching.
  const shim = `<script>window.__vsPreviewId=${JSON.stringify(previewId)};<\/script>${REPORTER}${shimFor(vars)}`;
  let out = withGsapPlugins(html);
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head([^>]*)>/i, `<head$1>${shim}`);
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html([^>]*)>/i, `<html$1><head>${shim}</head>`);
  else out = `${shim}${out}`;

  // Patcher BEFORE the driver: the values should already be in the DOM when the
  // timeline starts, or a composition that animates its text in would animate
  // the placeholder and then snap.
  const tail = `${patcherFor(slots)}${DRIVER}`;
  return /<\/body>/i.test(out)
    ? out.replace(/<\/body>/i, `${tail}</body>`)
    : `${out}${tail}`;
}

export interface PreviewHandle {
  /** Repaint with different values, without refetching the block. */
  update(vars: Record<string, string>, slots?: SlotFill[]): void;
  /**
   * Loop it, or let it settle on its finished frame.
   *
   * The composition is always played through once on mount — see `DRIVER` for
   * why. This is the on-demand half: hovering a tile or a card asks for motion,
   * and moving away gives the frame budget straight back.
   */
  setLoop(on: boolean): void;
  destroy(): void;
}

/**
 * Mount a live preview into `host`, scaled to fit.
 *
 * SCALED, NEVER RESIZED. A block lays itself out from `root.clientWidth` at
 * runtime — that is how one block serves 9:16, 1:1 and 16:9 — so shrinking the
 * iframe would make it re-layout for a 200px frame and the preview would show a
 * composition nobody will ever render. Rendering at native size and applying a
 * CSS transform keeps the proportions of the real thing.
 */
/** What a running composition told us about itself. See `REPORTER`. */
export interface BlockReport {
  name: string;
  phase: 'load' | 'settled';
  timelines: number;
  gsap: boolean;
  textPlugin: boolean;
  nodes: number;
  errors: string[];
}

const reportListeners = new Set<(r: BlockReport) => void>();
/** Subscribe to every preview's self-report — used by the diagnostics probe. */
export function onBlockReport(fn: (r: BlockReport) => void): () => void {
  reportListeners.add(fn);
  return () => reportListeners.delete(fn);
}

/** Live reports, keyed by preview id, so a mount can react to its own. */
const pending = new Map<string, (r: BlockReport) => void>();
let listening = false;

function listenForReports(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as (BlockReport & { type?: string; id?: string }) | null;
    if (d?.type !== 'vs-block-report') return;
    const fn = d.id ? pending.get(d.id) : undefined;
    fn?.(d);
    reportListeners.forEach(l => { try { l(d); } catch { /* one bad listener */ } });
  });
}

let previewSeq = 0;

export function mountBlockPreview(
  host: HTMLElement,
  name: string,
  vars: Record<string, string> = {},
  slots: SlotFill[] = [],
): PreviewHandle {
  let frame: HTMLIFrameElement | null = null;
  let current = { ...vars };
  let currentSlots = [...slots];
  let doc: BlockDoc | null = null;
  let dead = false;
  let ro: ResizeObserver | null = null;
  const previewId = `p${++previewSeq}`;
  listenForReports();

  host.textContent = '';
  const note = document.createElement('span');
  note.className = 'vs-blockprev__note';
  note.textContent = 'Loading preview…';
  host.append(note);

  function fit(): void {
    if (!frame || !doc) return;
    const box = host.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const scale = Math.min(box.width / doc.width, box.height / doc.height);
    frame.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }

  function paint(): void {
    if (dead || !doc) return;
    host.textContent = '';
    const f = document.createElement('iframe');
    f.className = 'vs-blockprev__frame';
    // No allow-same-origin: see the isolation note at the top of this file.
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('scrolling', 'no');
    f.setAttribute('aria-label', `${doc.name} preview`);
    f.width = String(doc.width);
    f.height = String(doc.height);
    f.style.width = `${doc.width}px`;
    f.style.height = `${doc.height}px`;
    f.srcdoc = blockSrcdoc(doc.html, current, previewId, currentSlots);
    frame = f;
    host.append(f);
    fit();
  }

  void loadBlock(name).then(d => {
    if (dead) return;
    if (!d) {
      // NAMED, not a spinner that never resolves. A block can genuinely be
      // missing — a board made on another machine references blocks that are
      // not installed here — and that is worth saying rather than hiding.
      note.textContent = `"${name}" isn’t installed on this computer`;
      return;
    }
    doc = d;
    pending.set(previewId, r => {
      if (dead || r.phase !== 'settled') return;
      // THREE WAYS TO SHOW NOTHING, and they are indistinguishable on screen.
      // Name the one that happened rather than leaving a blank rectangle.
      if (r.errors.length) {
        host.setAttribute('data-preview-state', 'error');
        host.setAttribute('title', `${d.name} failed to render: ${r.errors[0]}`);
      } else if (!r.timelines && !r.nodes) {
        host.setAttribute('data-preview-state', 'empty');
      } else {
        host.setAttribute('data-preview-state', 'ok');
      }
    });
    paint();
  });

  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => fit());
    ro.observe(host);
  }

  return {
    update(next, nextSlots) {
      current = { ...next };
      if (nextSlots) currentSlots = [...nextSlots];
      if (!frame || !doc) return;

      /**
       * CAN THE PATCHER REACH ALL OF IT?
       *
       * A slot with a `sel` or a `var` is written straight into the live DOM —
       * one write, no reload, animation intact. A block that declares bare
       * `variables[]` instead reads them ONCE at startup via `getVariables()`,
       * so nothing short of a rebuild will change what it shows. That is 3
       * blocks of 128, and this is how the other 102 stay instant.
       */
      const patchable = currentSlots.length > 0
        && currentSlots.every(f => f.sel || f.cssVar);

      /**
       * PATCH, DO NOT RELOAD, when only the slot values moved.
       *
       * variables[] blocks read their values once at startup, so those do
       * need a rebuild — but they are 3 of 128. The other 102 are patched by
       * selector, and reassigning `srcdoc` for them meant a full teardown, a
       * CDN fetch and the animation restarting on every keystroke.
       */
      if (patchable) {
        try {
          frame.contentWindow?.postMessage({ type: 'vs-block-slots', fills: currentSlots }, '*');
          return;
        } catch { /* fall through to the rebuild */ }
      }
      frame.srcdoc = blockSrcdoc(doc.html, current, previewId, currentSlots);
    },
    setLoop(on) {
      // Fire-and-forget across the sandbox boundary: the frame may still be
      // parsing, in which case the driver has not installed its listener yet
      // and the request is simply lost — which is correct, because a preview
      // that has not started has nothing to loop.
      try { frame?.contentWindow?.postMessage({ type: 'vs-block-play', loop: on }, '*'); }
      catch { /* a frame mid-teardown */ }
    },
    destroy() {
      dead = true;
      ro?.disconnect();
      pending.delete(previewId);
      frame?.remove();
      frame = null;
    },
  };
}
