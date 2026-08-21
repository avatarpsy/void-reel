/**
 * Turn a block into a document that renders the SAME WAY EVERY TIME.
 *
 * A HyperFrames block is an HTML document that animates itself with a GSAP
 * timeline registered on `window.__timelines[<composition id>]`. Left alone it
 * sits in its opening state, which is usually nothing: `data-chart` draws bars at
 * `height: 0` and a source line at `opacity: 0`, so a naive render produces a
 * blank frame that looks exactly like a broken block. Every still therefore has
 * to SEEK the timeline, and the frame it seeks to has to be chosen, not left to
 * whenever the capture happened to run.
 *
 * That is what this module produces: a self-contained document, with its slots
 * filled, its runtime local rather than fetched from a CDN, and a small agent
 * inside it that reports when the frame is genuinely settled.
 *
 * WHY DETERMINISM IS A CORRECTNESS PROPERTY AND NOT A NICETY
 * Renders are content-addressed and cached. A cache key is a lie unless the same
 * input produces the same pixels, and a composition depends on three racy things
 * — fonts loading, images decoding, and the timeline registering. Without an
 * explicit gate the cache stores whatever the frame looked like mid-build, and
 * thumbnails flicker between renders for reasons nobody can reproduce.
 *
 * WHAT THIS MODULE DOES NOT DO
 * It does not rasterise. Producing the document and capturing pixels from it are
 * separate jobs on purpose: this half is pure string/DOM work that runs anywhere
 * and is testable without a browser, and the capture half needs a real renderer.
 */

import { frameRuntimeSource } from './frame-runtime';
import type { CompositionSource } from '../../types/project';

/** How a block declares one fillable hole. Verified against the shipped library:
 *  every slot binds by EXACTLY ONE of `sel` or `var` — colours by variable (48 of
 *  48), everything else by selector (397 of 397). */
export interface SlotSpec {
  kind: 'text' | 'image' | 'video' | 'color';
  /** CSS selector for the element this slot fills. */
  sel?: string;
  /** CSS custom property this slot sets, on the composition root. */
  var?: string;
  /** The designer's placeholder. Kept in `preview`, removed in `render`. */
  sample?: string;
  /**
   * The only values this slot accepts, when it is a fixed set.
   *
   * Without this, a slot that is really an enum arrives as a free text box. The
   * entrance animation is the case that forced it: six legal values, a
   * placeholder showing one of them, and no way for anybody to discover the
   * other five except by asking the agent. A slot that knows its own options can
   * be drawn as a menu and is then impossible to get wrong.
   */
  values?: string[];
}

export type FillMode = 'preview' | 'render';

export interface PrepareOptions {
  /** Declared slots, from the block manifest. */
  slots?: Record<string, SlotSpec>;
  /** Values to fill them with, by slot key. Empty/missing values are UNFILLED. */
  values?: Record<string, unknown>;
  /**
   * `preview` leaves an unfilled slot showing the designer's sample, which is
   * what a picker or a thumbnail wants — a block should always look like
   * something. `render` HIDES it, because a lower third with no subtitle should
   * draw no subtitle line, and shipping the designer's demo text inside a user's
   * work is the failure that survives all the way to a published deck.
   */
  fillMode?: FillMode;
  /**
   * Where to freeze the timeline, in seconds. `'end'` is the settled state and
   * the right default for a still: it is what the design resolves to.
   *
   * `'live'` does not freeze it at all, and is for a frame being WATCHED rather
   * than captured — present mode, and the panel's replay. Never use it for a
   * render: an unposed capture catches the entrance mid-flight, and two stills
   * of the same document then disagree.
   */
  poseTime?: number | 'end' | 'live';
  /**
   * Local GSAP. 113 of the 128 shipped blocks fetch it from cdn.jsdelivr.net at
   * render time, so offline, on a locked-down network, or inside a frame with a
   * strict CSP they render blank — silently, and looking like a design fault.
   * Rewriting the tag to a vendored copy is what makes rendering dependable.
   */
  runtimeUrl?: string;
  /** Milliseconds to wait for fonts, images and the timeline before giving up
   *  and capturing anyway. A late font is worth a bounded wait, never a hang. */
  readyTimeoutMs?: number;
  /**
   * Render into THIS frame instead of the one the block declares.
   *
   * Needed because the twelve deck-ready blocks are `1080x1920` natively while
   * listing 16:9 among their supported aspects: reading the root's declared size
   * yields a portrait frame for a landscape deck. Their CSS does adapt —
   * `stat-punch` forced to 1920×1080 reflows into landscape correctly — but the
   * frame has to be given, not inferred.
   *
   * This is a LAYOUT change, not a resolution one: text rewraps and `clamp()`
   * resolves against the new width. Export scale is a separate multiplier
   * applied at render time.
   */
  frameWidth?: number;
  frameHeight?: number;
}

export interface PreparedComposition {
  html: string;
  /** The frame this document will render into — the requested one when given,
   *  otherwise what the block declares. This is what a renderer should size to. */
  width: number;
  height: number;
  /** What the block declared, before any override. Kept so a caller can tell
   *  that it asked a portrait block to lay out landscape, which is worth knowing
   *  when a design comes back looking unlike its thumbnail. */
  nativeWidth: number;
  nativeHeight: number;
  durationSec: number;
  /** Slot keys that had no value. Reported so a caller can say so rather than
   *  shipping a slide with the designer's placeholder still in it. */
  unfilled: string[];
  warnings: string[];
}

/** Blocks declare their frame on the composition root. */
const ROOT_SELECTOR = '[data-composition-id]';

/** Matches the CDN GSAP tag the shipped blocks carry. */
const GSAP_SRC = /^https?:\/\/cdn\.jsdelivr\.net\/npm\/gsap@[^/]+\/dist\/gsap(\.min)?\.js$/i;

const DEFAULT_READY_TIMEOUT_MS = 8000;

function num(v: string | null | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** A value that is present and not blank. Anything else leaves the slot unfilled. */
function filled(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

/**
 * Fill one slot. Colours are CSS variables on the root; everything else is an
 * element found by selector — text becomes its content, media becomes its `src`.
 */
function applySlot(
  doc: Document,
  spec: SlotSpec,
  value: unknown,
  warnings: string[],
  key: string,
): void {
  const v = String(value);

  /**
   * COLOURS GO ON THE DOCUMENT ROOT, NOT THE COMPOSITION ROOT.
   *
   * Custom properties inherit downward only, and blocks consume these ABOVE the
   * composition element — `html,body{background:var(--bg,#0A0A12)}` is the
   * shipped pattern. Set on the composition div, a variable reaches its
   * descendants and never reaches body.
   *
   * `render-hyperframes.post.ts` sets them on `document.documentElement` for the
   * same reason, including the `--<key>` fallback for a slot that names no
   * variable. Matching it exactly is the point: the same block themed two ways
   * on two surfaces is a bug nobody can diagnose from either side.
   */
  if (spec.var || spec.kind === 'color') {
    const prop = spec.var || `--${key}`;
    (doc.documentElement as HTMLElement).style.setProperty(prop, v);
    return;
  }
  if (!spec.sel) {
    warnings.push(`slot "${key}" declares neither sel nor var, so nothing could be filled`);
    return;
  }

  const el = doc.querySelector(spec.sel);
  if (!el) {
    // Not fatal: a block edited after its manifest was written can lose an
    // element. Losing one line is better than refusing to render the slide.
    warnings.push(`slot "${key}" selector "${spec.sel}" matched nothing`);
    return;
  }

  if (spec.kind === 'image' || spec.kind === 'video') {
    el.setAttribute('src', v);
    // An <img> that never loads holds the ready-gate open until it times out,
    // and a broken picture is worth reporting rather than waiting for.
    el.setAttribute('data-vs-slot', key);
    return;
  }
  el.textContent = v;
}

/**
 * Hide a declared slot that nobody filled. Only meaningful for element-bound
 * slots: a colour is a CSS variable with no element to hide, and it already
 * falls back to whatever the stylesheet declares.
 *
 * The `kind !== 'color'` test is redundant with `!spec.var` for every block in
 * the shipped library (all 48 colour slots bind by variable), and is kept anyway
 * so this matches `render-hyperframes.post.ts` condition for condition. Two
 * surfaces that hide slightly different sets of elements would render the same
 * block differently, and nobody would work out why.
 */
function hideUnfilled(doc: Document, spec: SlotSpec): void {
  if (!spec.sel || spec.var || spec.kind === 'color') return;
  const el = doc.querySelector(spec.sel);
  if (el instanceof HTMLElement) el.style.display = 'none';
  else if (el) el.setAttribute('style', `${el.getAttribute('style') ?? ''};display:none`);
}

/**
 * Produce a deterministic, self-contained document for one composition.
 *
 * Pure DOM work — no rendering, no network. Runs in a browser or in jsdom, which
 * is what lets the fiddly parts (slot binding, fill modes, runtime rewriting) be
 * tested without a renderer.
 */
export function prepareComposition(html: string, opts: PrepareOptions = {}): PreparedComposition {
  const warnings: string[] = [];
  const slots = opts.slots ?? {};
  const values = opts.values ?? {};
  const fillMode: FillMode = opts.fillMode ?? 'render';
  const poseTime = opts.poseTime ?? 'end';
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  /**
   * NOTHING FILLED MEANS HIDE NOTHING, even in `render`.
   *
   * A decorative block — a transition, a sting, a background — declares slots
   * and is often chosen precisely for the content baked into it. Hiding every
   * unfilled slot there does not tidy the design, it blanks it. Matches the same
   * guard in `render-hyperframes.post.ts`, which is where the reasoning was
   * worked out for the board.
   */
  const anyFilled = Object.keys(slots).some((k) => filled(values[k]));

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.querySelector(ROOT_SELECTOR);
  if (!root) {
    warnings.push(`no ${ROOT_SELECTOR} element — falling back to 1920x1080`);
  }

  const nativeWidth = num(root?.getAttribute('data-width'), 1920);
  const nativeHeight = num(root?.getAttribute('data-height'), 1080);
  const durationSec = num(root?.getAttribute('data-duration'), 0);

  /**
   * The frame the block will lay out into. Written back onto the root, because
   * that is what every renderer sizes the page from — leaving the declared value
   * there would render a landscape deck slide in a portrait frame.
   */
  // `??` alone would accept 0 and NaN as a frame, and Math.max would then turn a
  // zero into a one-pixel page — a nonsense request answered with nonsense
  // instead of the block's own frame.
  const width = num(String(opts.frameWidth ?? ''), nativeWidth);
  const height = num(String(opts.frameHeight ?? ''), nativeHeight);
  if (root && (width !== nativeWidth || height !== nativeHeight)) {
    root.setAttribute('data-width', String(width));
    root.setAttribute('data-height', String(height));
  }

  // ── Slots ────────────────────────────────────────────────────────────────
  const unfilled: string[] = [];
  for (const [key, spec] of Object.entries(slots)) {
    if (!spec) continue;
    if (filled(values[key])) {
      applySlot(doc, spec, values[key], warnings, key);
      continue;
    }
    unfilled.push(key);
    if (fillMode === 'render' && anyFilled) hideUnfilled(doc, spec);
  }
  // Values for keys the manifest never declared are a caller bug, and silently
  // dropping them is how "I set the headline and nothing happened" happens.
  for (const key of Object.keys(values)) {
    if (!slots[key] && filled(values[key])) {
      warnings.push(`value given for "${key}", which this block does not declare as a slot`);
    }
  }

  // ── Runtime ──────────────────────────────────────────────────────────────
  if (opts.runtimeUrl) {
    for (const s of Array.from(doc.querySelectorAll('script[src]'))) {
      if (GSAP_SRC.test(s.getAttribute('src') ?? '')) s.setAttribute('src', opts.runtimeUrl);
    }
  }
  /**
   * Whatever is STILL fetched from the network after vendoring is a rendering
   * risk, and it is worth naming every time — not only when nothing was
   * vendored. A block can carry GSAP plus a second dependency, and reporting
   * only the all-or-nothing case let that second one fail silently, which is the
   * exact failure mode vendoring exists to remove.
   */
  const external = Array.from(doc.querySelectorAll('script[src]'))
    .map((s) => s.getAttribute('src') ?? '')
    .filter((src) => /^https?:/i.test(src));
  if (external.length) {
    warnings.push(
      `block fetches ${external.length} external script(s) that were not vendored: ${external.join(', ')}`,
    );
  }

  // ── Ready agent ──────────────────────────────────────────────────────────
  /**
   * Does this document animate at all? A block with no GSAP registers no
   * timeline, and waiting for one that is never coming costs the whole timeout
   * on every render — measured against the 15 shipped blocks that have none.
   */
  const expectsTimeline = Array.from(doc.querySelectorAll('script')).some((s) =>
    GSAP_SRC.test(s.getAttribute('src') ?? '')
    || /gsap/i.test(s.getAttribute('src') ?? '')
    || /__timelines/.test(s.textContent ?? ''),
  );

  const agent = doc.createElement('script');
  agent.textContent = frameRuntimeSource({
    poseTime,
    timeoutMs: readyTimeoutMs,
    expectsTimeline,
  });
  (doc.body ?? doc.documentElement).appendChild(agent);

  return {
    html: `<!DOCTYPE html>${doc.documentElement.outerHTML}`,
    width,
    height,
    nativeWidth,
    nativeHeight,
    durationSec,
    unfilled,
    warnings,
  };
}

/**
 * Prepare the document for a composition that is already ON a layer.
 *
 * The one way to build a document from a stored `CompositionSource`, and it
 * exists because the alternative was every caller hand-mapping five fields.
 * That is not tedium, it is a correctness hole: the cache key is computed over
 * `frameWidth`/`frameHeight`/`slots`/`fillMode`/`poseTime`, so a caller that
 * passed a different frame than the one on the source would render something the
 * key does not describe — and the cache would then hand that render to a
 * composition it does not match. Reading them from one place makes the two agree
 * by construction rather than by everyone remembering.
 *
 * `slots` here is the block's MANIFEST (what holes exist); `source.slots` is the
 * VALUES. Two different things that both got called slots long before this.
 */
export function prepareFromSource(
  html: string,
  source: CompositionSource,
  manifest: Record<string, SlotSpec> = {},
  opts: Pick<PrepareOptions, 'runtimeUrl' | 'readyTimeoutMs' | 'poseTime'> = {},
): PreparedComposition {
  return prepareComposition(html, {
    slots: manifest,
    values: source.slots,
    fillMode: source.fillMode,
    /**
     * An override rather than a stored value, because "play it" is a property
     * of how the frame is being LOOKED AT, not of the slide. Writing 'live'
     * onto the source would change the render cache key and make presenting a
     * deck re-render every slide in it.
     */
    poseTime: opts.poseTime ?? source.poseTime,
    frameWidth: source.frameWidth,
    frameHeight: source.frameHeight,
    runtimeUrl: opts.runtimeUrl,
    readyTimeoutMs: opts.readyTimeoutMs,
  });
}
