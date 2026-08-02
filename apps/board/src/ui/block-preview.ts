/**
 * WHEN a block preview runs — and how many at once.
 *
 * The rendering half lives in `block-render.ts`; this half is the scheduler.
 * They are separate because they fail differently and they are read at
 * different times: one is "how do I make a HyperFrames block paint in a
 * browser", the other is "there are 128 tiles and 20 shot cards, which of them
 * should actually be running right now".
 *
 * The split also makes the scheduler testable on its own, which matters —
 * see `lazy-preview.test.ts` for the bug that motivated it.
 */
import { mountBlockPreview, type PreviewHandle, type SlotFill } from './block-render';

export {
  blockSrcdoc, loadBlock, mountBlockPreview, onBlockReport,
  type BlockDoc, type BlockReport, type PreviewHandle, type SlotFill,
} from './block-render';

/* ────────────────────────────────────────────────────────────────────────────
 * LAZY PREVIEWS — ONE RECONCILER FOR EVERY SURFACE
 *
 * Both the shot card and the panel's tiles want the same thing: show this
 * block, but only while it is on screen, and swap cleanly when the block
 * changes. The card grew its own IntersectionObserver for this and got it
 * WRONG in a way worth naming, because the same mistake is easy to repeat:
 * its callback said `if (visible && !mounted) mount()`. When the block changed
 * the old preview was still mounted, so `mounted` was truthy, nothing
 * remounted, and the card showed the previous composition under the new
 * block's name — the drag appeared to do nothing.
 *
 * The fix is structural, not a patched condition. There is now ONE piece of
 * state — what SHOULD be shown — and one function that makes reality match it.
 * Visibility changes and block changes both just call it.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How many compositions may run at once, across the whole board.
 *
 * Every preview is a live document with CSS keyframes and, for a good number of
 * blocks, GSAP and shader-ish effects. The panel can show forty tiles and a
 * board can hold twenty graphics; running all of them is a real cost on a
 * laptop. Anything over the cap simply waits — a tile that never gets a slot
 * keeps its glyph, which is the previous behaviour rather than a broken one.
 */
const MAX_LIVE = 24;
/** Mount order, so the oldest yields when the cap is reached. */
const live = new Set<LazyPreview>();
/**
 * Wanted a slot and did not get one.
 *
 * WITHOUT THIS THE CAP IS PERMANENT. A grid can show more tiles than the budget
 * allows; the ones that missed out would keep their glyph forever, because
 * nothing re-runs `reconcile` for a preview whose visibility never changes
 * again. Handing a freed slot straight to a waiter makes the shortfall
 * self-healing: scroll one composition off screen and the next one in line
 * renders.
 */
const waiting = new Set<LazyPreview>();

/** Priority per instance, so the budget can evict the right one. */
const rank = new WeakMap<LazyPreview, number>();

function requestSlot(who: LazyPreview): boolean {
  if (live.has(who)) return true;
  if (live.size >= MAX_LIVE) {
    // A CARD MAY TAKE A TILE'S SLOT. Scanning the library must never cost the
    // user sight of a scene they have actually built.
    if ((rank.get(who) ?? 0) > 0) {
      for (const other of live) {
        if ((rank.get(other) ?? 0) === 0) { other.retryYield(); break; }
      }
    }
    if (live.size >= MAX_LIVE) { waiting.add(who); return false; }
  }
  waiting.delete(who);
  live.add(who);
  return true;
}

function releaseSlot(who: LazyPreview): void {
  waiting.delete(who);
  if (!live.delete(who)) return;
  const next = waiting.values().next().value as LazyPreview | undefined;
  if (next) { waiting.delete(next); next.retry(); }
}

export interface LazyPreview {
  /**
   * Say what should be showing. Cheap and idempotent.
   *
   * `slots` is what the shot actually puts INTO the block — dropped media and
   * typed words, already resolved against the block's declared slots. The 102
   * slot-driven blocks never read the values themselves, so without this they
   * preview the designer's placeholder content whatever the user has done.
   */
  set(name: string, vars?: Record<string, string>, slots?: SlotFill[]): void;
  /** Loop it (hover) or let it hold its finished frame. */
  setLoop(on: boolean): void;
  /** A slot freed up — used by the budget, not by callers. */
  retry(): void;
  /** Budget-internal: release the slot but stay in the queue. */
  retryYield(): void;
  destroy(): void;
}

export interface LazyOptions {
  /**
   * Who yields when the budget is full.
   *
   * A shot card is the user's own work and must always render; a panel tile is
   * one of 128 they are scanning past. Without this, opening the media panel on
   * a graphic-heavy board could starve the cards of slots — the one thing that
   * must never happen, because a blank card looks like a lost scene.
   */
  priority?: 'card' | 'tile';
}

/**
 * A preview that mounts itself when `host` is on screen and tears down when it
 * is not.
 *
 * `rootMargin` is generous on purpose: panning a card into view should find it
 * already rendered rather than showing an empty well that fills a beat later.
 */
export function lazyBlockPreview(host: HTMLElement, opts: LazyOptions = {}): LazyPreview {
  let wantName = '';
  let wantVars: Record<string, string> = {};
  let wantSlots: SlotFill[] = [];
  /** What the mounted preview is actually showing. '' when nothing is mounted. */
  let shown = '';
  let handle: PreviewHandle | null = null;
  let visible = false;
  let dead = false;
  let looping = false;
  /** What the host showed before a preview took it over — see `unmount`. */
  const original = host.innerHTML;

  const sig = () => `${wantName}::${JSON.stringify(wantVars)}::${JSON.stringify(wantSlots)}`;

  function unmount(): void {
    handle?.destroy();
    handle = null;
    shown = '';
    releaseSlot(api);
    // PUT BACK WHAT WAS THERE. A panel tile's host holds its kind glyph; wiping
    // it left an empty square, which reads as a broken thumbnail rather than as
    // a preview that is not running.
    if (!dead) host.innerHTML = original;
  }

  /**
   * Make what is on screen match what was asked for.
   *
   * Every path leads here, which is the point — there is no combination of
   * "visible changed" and "block changed" that can leave a stale composition up.
   */
  function reconcile(): void {
    if (dead) return;
    if (!wantName || !visible) { unmount(); return; }
    if (shown === sig() && handle) return;

    // Same block, different values: swap them in without restarting the
    // animation under the user's cursor.
    if (handle && shown.startsWith(`${wantName}::`)) {
      handle.update(wantVars, wantSlots);
      shown = sig();
      return;
    }
    if (!requestSlot(api)) return;
    handle?.destroy();
    handle = mountBlockPreview(host, wantName, wantVars, wantSlots);
    if (looping) handle.setLoop(true);
    shown = sig();
  }

  const io = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver(entries => {
        const next = entries.some(e => e.isIntersecting);
        if (next === visible) return;
        visible = next;
        reconcile();
      }, { root: null, rootMargin: '250px' })
    : null;

  const api: LazyPreview = {
    set(name, vars = {}, slots = []) {
      const nextName = String(name || '').trim();
      if (nextName === wantName
        && JSON.stringify(vars) === JSON.stringify(wantVars)
        && JSON.stringify(slots) === JSON.stringify(wantSlots)) {
        // Nothing changed, but the host may have been re-created under us by a
        // template re-render — in which case the iframe is gone and `shown` is
        // a lie. Re-mount when that has happened.
        if (wantName && visible && !host.firstElementChild) { shown = ''; reconcile(); }
        return;
      }
      wantName = nextName;
      wantVars = { ...vars };
      wantSlots = [...slots];
      reconcile();
    },
    setLoop(on) {
      if (looping === on) return;
      looping = on;
      handle?.setLoop(on);
    },
    retry() {
      // Only worth anything if this one still wants to be showing.
      if (!dead && wantName && visible && !handle) reconcile();
    },
    /** Hand the slot back so a higher-priority preview can have it. */
    retryYield() {
      unmount();
      waiting.add(api);
    },
    destroy() {
      dead = true;
      io?.disconnect();
      unmount();
    },
  };

  rank.set(api, opts.priority === 'card' ? 1 : 0);
  if (io) io.observe(host);
  else { visible = true; }
  return api;
}

/**
 * Open one block full-size, on top of everything.
 *
 * WHY THIS EXISTS: the preview on a shot card is 190px tall and deliberately
 * inert — it has to be, or the composition's own scripts would swallow the
 * gestures the canvas needs. But a 190px render is for recognising a block, not
 * for judging one, and "let me actually look at this" is the next thing anyone
 * wants. So the card's preview opens here.
 *
 * REPLAY IS A REMOUNT. These compositions are CSS keyframes and one-shot GSAP
 * timelines with no transport to seek — the honest way to watch it again is to
 * run it again, which is exactly what the renderer will do.
 */
export function openBlockLightbox(
  name: string,
  vars: Record<string, string> = {},
  opts: { subtitle?: string; slots?: SlotFill[] } = {},
): () => void {
  const el = document.createElement('div');
  el.className = 'vs-blocklb';
  el.innerHTML = `
    <div class="vs-blocklb__scrim" data-close></div>
    <div class="vs-blocklb__box" role="dialog" aria-label="${name} preview">
      <header>
        <span class="vs-blocklb__name">${name}</span>
        ${opts.subtitle ? `<span class="vs-blocklb__sub">${opts.subtitle}</span>` : ''}
        <button type="button" data-replay title="Play it again">Replay</button>
        <button type="button" data-close aria-label="Close">✕</button>
      </header>
      <div class="vs-blocklb__stage" data-stage></div>
    </div>`;
  document.body.append(el);

  const stage = el.querySelector<HTMLElement>('[data-stage]')!;
  // ALWAYS LOOPS. Everywhere else a composition settles on its finished frame
  // to keep the board cheap; this is the one surface whose whole purpose is
  // watching the motion.
  // WITH THE SHOT'S OWN CONTENT. Opening the full-size view used to drop the
  // slot fills, so a composition the user had filled in previewed as the
  // designer's placeholder the moment they expanded it.
  let handle = mountBlockPreview(stage, name, vars, opts.slots ?? []);
  handle.setLoop(true);

  const close = (): void => {
    handle.destroy();
    el.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  // Capture: the canvas below binds keys too, and Escape there clears the
  // selection rather than closing this.
  document.addEventListener('keydown', onKey, true);

  el.addEventListener('click', e => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-close],[data-replay]');
    if (!act) return;
    if (act.hasAttribute('data-replay')) {
      handle.destroy();
      handle = mountBlockPreview(stage, name, vars, opts.slots ?? []);
      handle.setLoop(true);
      return;
    }
    close();
  });

  return close;
}
