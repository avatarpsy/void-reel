/**
 * The code that runs INSIDE a composition frame.
 *
 * It is a string rather than a module because it is injected into a document we
 * hand to an iframe, and that frame is sandboxed with an opaque origin: the host
 * cannot reach into it to seek a timeline, ask whether the fonts arrived, or
 * read a canvas out of it. Everything the host needs to know, the document has
 * to volunteer.
 *
 * It answers two things:
 *
 *   ready    — unprompted, once the frame has genuinely settled
 *   ping     — the same answer again, for a host that asked late
 *
 * It does NOT rasterise. That was tried and it cannot work in a browser: see
 * the note on the canvas limits below.
 *
 * WHY `ping` EXISTS. A postMessage only reaches a listener that is already
 * attached, and a same-origin host can fall back to reading the latch off the
 * document — but a SANDBOXED frame has an opaque origin, so that latch is
 * unreadable from outside. Without a way to re-ask, any ordering slip in the
 * host is an unrecoverable hang. Measured in a browser before this existed: a
 * listener attached one second late saw nothing while the frame behind it was
 * fully settled.
 */

/**
 * WHY RASTERISING DOES NOT HAPPEN IN THE BROWSER.
 *
 * The obvious route is an SVG foreignObject holding the frame's markup, drawn to
 * a canvas — it uses the browser's own engine, so typography and layout come out
 * exactly right. It was built, and it does not work: **a foreignObject taints
 * the canvas**, so toDataURL throws SecurityError and no pixels can be read back.
 *
 * Measured, because the first failure looked like a fonts problem: a MINIMAL
 * foreignObject holding one plain div, with no external reference of any kind,
 * taints — while a plain SVG rect in the same page does not. Confirmed on two
 * independent browsers, Chromium 148 and Chromium 150, so it is platform
 * behaviour rather than one browser's hardening. `html-to-image` uses the same
 * technique and would fail identically.
 *
 * Rasterising therefore belongs server-side, where a headless browser can render
 * and screenshot without a canvas in the path at all. These limits are kept
 * because they still bound what any RASTER target can hold: a poster at A0/300dpi
 * is ~140 megapixels and half a gigabyte of RGBA. The honest answer at that size
 * is a refusal naming the number — or a vector PDF, which a server-side renderer
 * can also produce and a canvas never could.
 */
export const MAX_CANVAS_DIMENSION = 16384;
export const MAX_CANVAS_AREA = 64_000_000; // ~8000×8000

/**
 * What the runtime posts out, and the only thing a host should act on.
 *
 * `pending` is a real answer to a ping — the frame exists and has not settled —
 * and is deliberately distinct from silence, which means nobody is home.
 */
export interface CompositionMessage {
  __composition: 'ready';
  state: 'ok' | 'timeout' | 'error' | 'pending';
  detail?: { seeked?: number; brokenImages?: string[] } | null;
  /** When the frame settled, by its own clock. The host only knows when it noticed. */
  atMs?: number;
}

export interface FrameRuntimeOptions {
  poseTime: number | 'end';
  timeoutMs: number;
  expectsTimeline: boolean;
}

/**
 * Source for the in-frame runtime.
 *
 * TWO SEQUENCES MUST NEVER APPEAR IN THIS STRING, and both have already bitten:
 *
 *   a backtick — this is built inside a template literal, so one ends the
 *   string and the syntax error surfaces somewhere else entirely.
 *
 *   a literal closing script tag — the runtime is injected as inline script
 *   content, and an HTML parser ends the element at the first one it sees,
 *   wherever it sits. Written in a COMMENT it still truncates the file: this
 *   runtime silently lost everything past character 3802, including its own
 *   message listener, so the frame loaded, animated, registered its timeline,
 *   and then answered nothing at all. Both are pinned by tests.
 */
export function frameRuntimeSource(o: FrameRuntimeOptions): string {
  const pose = o.poseTime === 'end' ? '"end"' : String(o.poseTime);
  return `
(function () {
  var POSE = ${pose};
  var TIMEOUT = ${o.timeoutMs};
  var EXPECTS_TIMELINE = ${o.expectsTimeline ? 'true' : 'false'};
  var settled = null;

  function reply(msg) {
    try { parent.postMessage(msg, '*'); } catch (e) {}
  }

  function post(state, detail) {
    if (settled) return;
    settled = {
      __composition: 'ready',
      state: state,
      detail: detail || null,
      atMs: Math.round(performance.now())
    };
    /* Latch before broadcasting. Same-origin hosts can read this off the
       document; sandboxed ones re-ask with ping. Either way the answer exists
       before anyone could have missed it. */
    try { window.__compositionReady = settled; } catch (e) {}
    try { document.documentElement.setAttribute('data-composition-ready', state); } catch (e) {}
    reply(settled);
  }

  function seek() {
    var seeked = 0;
    var reg = window.__timelines || {};
    for (var id in reg) {
      if (!Object.prototype.hasOwnProperty.call(reg, id)) continue;
      var tl = reg[id];
      if (!tl || typeof tl.pause !== 'function') continue;
      try {
        if (POSE === 'end') { tl.progress(1); }
        else if (typeof tl.seek === 'function') { tl.seek(POSE); }
        tl.pause();
        seeked++;
      } catch (e) {}
    }
    return seeked;
  }

  function images() {
    var list = Array.prototype.slice.call(document.images || []);
    return Promise.all(list.map(function (img) {
      if (img.complete) return null;
      return new Promise(function (res) {
        img.addEventListener('load', function () { res(null); }, { once: true });
        img.addEventListener('error', function () { res(img.getAttribute('data-vs-slot') || 'image'); }, { once: true });
      });
    })).then(function (r) { return r.filter(Boolean); });
  }

  function fonts() {
    try { return document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve(); }
    catch (e) { return Promise.resolve(); }
  }

  /* Only wait for a timeline that is actually coming. 15 of the 128 shipped
     blocks carry no GSAP, and waiting for one of those cost the whole timeout
     on every render — 8 seconds to learn nothing. */
  function timeline() {
    if (!EXPECTS_TIMELINE) return Promise.resolve(false);
    return new Promise(function (res) {
      var waited = 0;
      (function tick() {
        if (window.__timelines && Object.keys(window.__timelines).length) return res(true);
        if (waited >= TIMEOUT) return res(false);
        waited += 50;
        setTimeout(tick, 50);
      })();
    });
  }

  /* A CSS background-image is in neither document.images nor the font set, so
     without the load event a backdrop can be missing from a capture. */
  function subresources() {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise(function (res) {
      window.addEventListener('load', function () { res(); }, { once: true });
      setTimeout(res, TIMEOUT);
    });
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.__composition === 'ping') {
      reply(settled || { __composition: 'ready', state: 'pending', detail: null, atMs: Math.round(performance.now()) });
      return;
    }
  });

  setTimeout(function () { seek(); post('timeout'); }, TIMEOUT);

  Promise.resolve()
    .then(function () { return timeline(); })
    .then(function () { return Promise.all([fonts(), images(), subresources()]); })
    .then(function (r) {
      var brokenImages = (r && r[1]) || [];
      /* Seek AFTER the assets settle: seeking first lets a late image resize its
         container underneath an already-finished layout. */
      var seeked = seek();
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          post('ok', { seeked: seeked, brokenImages: brokenImages });
        });
      });
    })
    .catch(function (e) { seek(); post('error', String(e && e.message ? e.message : e)); });
})();`;
}
