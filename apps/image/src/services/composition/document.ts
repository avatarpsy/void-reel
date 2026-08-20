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
   */
  poseTime?: number | 'end';
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
}

export interface PreparedComposition {
  html: string;
  /** The size the block was DESIGNED at. Render here and scale — never resize the
   *  frame to fit a box, because blocks are laid out in pixels (only 15 of 128
   *  use `vw`, none use `vh`), so a different frame width is a different design. */
  width: number;
  height: number;
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
  root: Element,
  spec: SlotSpec,
  value: unknown,
  warnings: string[],
  key: string,
): void {
  const v = String(value);

  if (spec.var) {
    (root as HTMLElement).style.setProperty(spec.var, v);
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

  const width = num(root?.getAttribute('data-width'), 1920);
  const height = num(root?.getAttribute('data-height'), 1080);
  const durationSec = num(root?.getAttribute('data-duration'), 0);

  // ── Slots ────────────────────────────────────────────────────────────────
  const unfilled: string[] = [];
  for (const [key, spec] of Object.entries(slots)) {
    if (!spec) continue;
    if (filled(values[key])) {
      if (root) applySlot(doc, root, spec, values[key], warnings, key);
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
    durationSec,
    unfilled,
    warnings,
  };
}
