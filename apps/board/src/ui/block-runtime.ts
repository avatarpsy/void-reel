/**
 * The animation runtime every block is allowed to assume is already there.
 *
 * ── THE CONTRACT WAS UNFULFILLABLE ───────────────────────────────────────────
 * The agent that writes blocks is told two things at once:
 *
 *   "ONE self-contained HTML document … no network requests of any kind"
 *   "if you animate, register a PAUSED GSAP timeline on window.__timelines[id]"
 *
 * Both are right, and together they were impossible: nothing put GSAP in the
 * frame. A block obeying its instructions called `gsap.timeline()` against
 * `undefined`. The 128 shipped blocks hid this because they each carry a
 * `<script src>` to a CDN — a thing the same instructions forbid, and a thing the
 * published-block sandbox blocks outright.
 *
 * So the renderer provides it. That is what makes the instruction true, and it is
 * what lets a user's own block animate AND be publishable: it no longer has to
 * reach for anything.
 *
 * ── WHY IT IS FETCHED AND INLINED, NOT LINKED ────────────────────────────────
 * A published block renders under `default-src 'none'; script-src 'unsafe-inline'`
 * in a sandboxed iframe with an opaque origin, where `'self'` resolves to nothing.
 * No `<script src>` of any kind can load there — not remote, not relative. Inline
 * is the only script that runs, so the runtime is fetched by the PARENT (ordinary
 * same-origin request, cached by the browser) and injected as inline text.
 *
 * ── WHY NOT BUNDLED ──────────────────────────────────────────────────────────
 * 83KB that only matters once someone looks at a block. Fetched on first use and
 * held for the life of the page; a board with no blocks never pays for it.
 *
 * ── WHY NOT three.js, d3, topojson ───────────────────────────────────────────
 * Deliberately just GSAP and TextPlugin. GSAP is the one the CONTRACT depends on
 * — it is how every block reports frames to the renderer, so without it a block
 * is not merely unanimated, it is unrenderable. The others are used by 20 shipped
 * blocks that are not publishable anyway (shipped blocks are not anyone's to
 * share) and three.js alone is 600KB, which is not worth injecting into every
 * preview on the chance one block wants it. If a user block ever needs one, the
 * mechanism here extends to it — see `RUNTIME_PARTS`.
 */

/** The version served from `public/blocks-runtime/`, and the one blocks pin. */
export const GSAP_VERSION = '3.14.2';

const RUNTIME_PARTS = [
  `/blocks-runtime/gsap-${GSAP_VERSION}.min.js`,
  `/blocks-runtime/TextPlugin-${GSAP_VERSION}.min.js`,
];

/**
 * REGISTERED FOR THEM, because they do not do it themselves.
 *
 * 37 of the shipped blocks animate copy with `gsap.to(el, { text: … })` and not
 * one calls `registerPlugin`. Missing, GSAP does not throw — it logs "Invalid
 * property text … Missing plugin?" and animates nothing, so the block renders
 * perfectly and the words simply never arrive.
 */
const REGISTER = 'try{gsap.registerPlugin(TextPlugin);}catch(e){}';

let runtime: string | null = null;
let inflight: Promise<string | null> | null = null;

/**
 * Fetch and cache the runtime. Safe to call repeatedly and concurrently.
 *
 * Resolves to null when it cannot be loaded, and callers carry on: a block that
 * cannot animate still lays out, and refusing to show it would be worse than
 * showing it still. The report a block sends back already carries `gsap: false`,
 * so the failure is visible where it matters rather than silent.
 */
export async function ensureBlockRuntime(): Promise<string | null> {
  if (runtime !== null) return runtime;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const sources = await Promise.all(RUNTIME_PARTS.map(async url => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url} -> ${res.status}`);
        return res.text();
      }));
      runtime = `${sources.join('\n;\n')}\n;${REGISTER}`;
      return runtime;
    } catch {
      // Left as null rather than cached-as-empty, so a later attempt can retry
      // after a transient failure instead of being permanently poisoned.
      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * The runtime as an inline `<script>`, or '' when it has not loaded.
 *
 * Synchronous by design: `blockSrcdoc` composes a string and must stay a pure
 * function of what it is given. Callers await `ensureBlockRuntime()` first.
 */
export function blockRuntimeScript(): string {
  if (!runtime) return '';
  // A literal `</script>` anywhere in the source would end the tag early and
  // spill the rest into the document as markup. Neither file contains one today;
  // this costs nothing and means a future version bump cannot break the frame.
  const safe = runtime.replace(/<\/script/gi, '<\\/script');
  return `<script>${safe}<\/script>`;
}

/** Test seam: set the cached runtime without touching the network. */
export function __setBlockRuntime(src: string | null): void {
  runtime = src;
  inflight = null;
}

/**
 * Drop a block's own GSAP tag when we are providing that exact version.
 *
 * WHY BOTHER, given an injected GSAP already makes the block work: predictability.
 * Left in place, the tag loads in a trusted preview and is blocked in a published
 * one, so the same block runs against two different copies of GSAP depending on
 * where it is shown. Removing the redundant tag makes both paths identical — and
 * saves 114 blocks a needless 72KB request each.
 *
 * ONLY when the version matches or is unpinned. A block that deliberately asks
 * for a different GSAP keeps its tag: silently swapping it for ours would be a
 * behaviour change we cannot see, which is exactly the kind of thing that makes
 * an animation subtly wrong with no way to trace it.
 */
export function dropRedundantGsapTag(html: string): string {
  /**
   * Matched on the FILENAME, with the version read separately.
   *
   * An earlier version of this pattern required the word "gsap" twice — once as a
   * path segment and once as the file — which is true of the CDN form
   * (`/gsap@3.14.2/dist/gsap.min.js`) and false of the ordinary vendored form
   * (`/lib/gsap.min.js`). It silently left the second kind in place, which is the
   * exact case a user copying a block into their own library produces.
   */
  return html.replace(
    /<script\b[^>]*\ssrc=["']([^"']*\bgsap(?:\.min)?\.js)["'][^>]*>\s*<\/script>/gi,
    (tag, url: string) => {
      const pinned = /\bgsap@([\d.]+)/i.exec(url)?.[1];
      return !pinned || pinned === GSAP_VERSION ? '' : tag;
    },
  );
}
