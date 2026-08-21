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
 * It does NOT rasterise. That was built, measured, and removed — the note below
 * says why, and where stills come from instead.
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
 * WHY RASTERISING DOES NOT HAPPEN IN THIS FILE, OR ANY FILE IN THE BROWSER.
 *
 * The obvious route is an SVG foreignObject holding the frame's markup, drawn to
 * a canvas — the browser's own engine renders it, so typography and layout come
 * out exact. It was built, and it cannot work: **a foreignObject taints the
 * canvas**, so toDataURL throws SecurityError and no pixels are readable.
 *
 * Measured rather than assumed, because the first failure looked like a fonts
 * problem: a MINIMAL foreignObject holding one plain div, with no external
 * reference of any kind, taints — while a plain SVG rect in the same page does
 * not. Confirmed on Chromium 148 and Chromium 150, so it is platform behaviour
 * rather than one browser's hardening, and `html-to-image` would fail the same
 * way for the same reason.
 *
 * Stills come from the user's own machine instead: the desktop app bundles Node
 * and a pinned hyperframes, which renders with real Chrome. See §15 and §16 of
 * PRESENTATION_BLOCKS_PLAN.md for the measurements, including which frame to
 * keep — the first one is the unplayed state and is blank.
 */

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
  /**
   * Where to hold the animation.
   *
   * A number or 'end' POSES the document — every animation is seeked there and
   * paused — which is what makes a still repeatable: a capture taken at mount
   * otherwise catches the entrance mid-flight and two stills of the same
   * document disagree.
   *
   * 'live' is the opposite and exists for watching rather than capturing. The
   * entrance animation was, until this, a control with no playback surface
   * anywhere in the product: the canvas overlay poses to the end, the page
   * thumbnails are baked stills, and every export is static. You could set an
   * animation and never once see it. Present mode mounts frames 'live', so the
   * slide plays exactly as it will when the deck is shown.
   */
  poseTime: number | 'end' | 'live';
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
  const pose = o.poseTime === 'end' || o.poseTime === 'live'
    ? `"${o.poseTime}"`
    : String(o.poseTime);
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

  /* CSS animations are invisible to window.__timelines, and a block is perfectly
     entitled to animate without GSAP — a fifth of the shipped library does, and
     every deck block does. Left alone they follow the wall clock, which means a
     still taken at mount catches the entrance mid-flight and two stills of the
     same document disagree. Posing them is what makes a CSS-animated block
     render the same way twice.

     An infinite animation (a drifting background wash) has no end to seek to, so
     "end" holds it at the close of its FIRST iteration: a defined phase, which is
     all determinism needs, and a more sensible one than an arbitrary clock
     reading. */
  function seekCss() {
    if (typeof document.getAnimations !== 'function') return 0;
    var posed = 0;
    var list;
    try { list = document.getAnimations(); } catch (e) { return 0; }
    for (var i = 0; i < list.length; i++) {
      var anim = list[i];
      try {
        if (POSE !== 'end') {
          /* GSAP seeks in seconds, the Web Animations API in milliseconds. */
          anim.currentTime = POSE * 1000;
        } else {
          var endMs = null;
          if (anim.effect && typeof anim.effect.getComputedTiming === 'function') {
            var t = anim.effect.getComputedTiming() || {};
            if (isFinite(t.endTime)) endMs = t.endTime;
            else if (isFinite(t.duration)) endMs = (t.delay || 0) + t.duration;
          }
          if (endMs !== null) anim.currentTime = endMs;
          /* Nothing to compute an end from: finish() is the API's own answer,
             and if it refuses (an infinite animation) leaving the clock where it
             is beats jumping to zero and showing the unplayed state. */
          else { try { anim.finish(); } catch (e) {} }
        }
        anim.pause();
        posed++;
      } catch (e) {}
    }
    return posed;
  }

  function seek() {
    /* 'live' means LET IT RUN: no seeking, no pausing. The frame is being
       watched rather than captured, so the entrance is the point of it. */
    if (POSE === 'live') return 0;
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
    return seeked + seekCss();
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
