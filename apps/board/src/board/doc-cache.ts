/**
 * Derived reads, computed once per document revision.
 *
 * ── THE PROBLEM THIS SOLVES, MEASURED ────────────────────────────────────────
 * Every shot card and the screenplay page subscribe to `blockUpdated` and call
 * `requestUpdate()` when any OTHER block changes — they have to, because a
 * card's scene number comes from where its neighbours are and its sequence pill
 * comes from the screenplay. Rendering one card then runs, from scratch:
 *
 *   readParsed(std)   → parseFountain over the WHOLE screenplay
 *   sceneNumber       → getBlocksByFlavour + JSON.parse(xywh) + sort, per shot
 *   coverage(...)     → both of the above, cross-referenced
 *
 * `blockUpdated` fires on every pointermove of a drag. So dragging one card on a
 * sixty-shot board with a four-hundred-line script ran sixty full Fountain
 * parses and sixty full board scans PER FRAME — O(n²) in shots, O(n·m) in script
 * length. That is the whole of "it gets sluggish when the board is big": not
 * rendering, not media, not the canvas. Arithmetic nobody was doing on purpose.
 *
 * ── THE FIX, AND WHY IT IS SAFE ──────────────────────────────────────────────
 * A board document has exactly one writer at a time and a monotonic revision:
 * `blockUpdated` fires after every mutation, whoever made it — the user, the
 * agent, or a cloud merge. So anything derived PURELY from the document is valid
 * for exactly one revision, and recomputing it more than once per revision is
 * waste by definition.
 *
 * Keyed on the Store, in a WeakMap, so a board that is closed takes its cache
 * with it and a test that mounts fifty stores does not accumulate fifty caches.
 *
 * THE ONE RULE: only put a function here whose result depends on NOTHING but the
 * document. `effectiveModel`, for instance, reads the pushed model catalogue as
 * well, so it must not be cached against a document revision — its answer can
 * change without the document changing at all.
 */
import type { BlockStdScope } from '@blocksuite/std';
import type { Store } from '@blocksuite/store';

interface Entry {
  rev: number;
  value: unknown;
}

/** Revision per store, bumped by that store's own `blockUpdated`. */
const revs = new WeakMap<Store, { n: number }>();
/** Memo slots per store, keyed by the caller's tag. */
const caches = new WeakMap<Store, Map<string, Entry>>();

/**
 * This document's revision, subscribing on first ask.
 *
 * Lazy rather than wired up at mount: `shots.ts` and `screenplay-doc.ts` are
 * pure modules used by headless tests and by the compile path, neither of which
 * has a mount to hang a subscription on. Asking is the trigger.
 *
 * The subscription is never disposed, deliberately — it is held by the store's
 * own slot and refers only to the store, so it is a self-contained cycle that
 * dies with the document. Handing back a disposer would mean every caller had a
 * lifetime to get wrong.
 */
export function docRev(store: Store): number {
  let slot = revs.get(store);
  if (!slot) {
    slot = { n: 0 };
    revs.set(store, slot);
    const held = slot;
    store.slots.blockUpdated.subscribe(() => { held.n++; });
  }
  return slot.n;
}

/**
 * Run `compute` at most once per document revision.
 *
 * `tag` names the slot and must be unique per derivation — two callers sharing a
 * tag would serve each other's answers. Module-level constants, never a template
 * string built from arguments: a per-argument tag is a cache with no bound, and
 * this one lives as long as the board.
 */
export function perRev<T>(std: BlockStdScope, tag: string, compute: () => T): T {
  const store = std.store;
  const rev = docRev(store);

  let bucket = caches.get(store);
  if (!bucket) {
    bucket = new Map();
    caches.set(store, bucket);
  }

  const hit = bucket.get(tag);
  if (hit && hit.rev === rev) return hit.value as T;

  const value = compute();
  bucket.set(tag, { rev, value });
  return value;
}

/**
 * Drop everything cached for a store.
 *
 * For tests, which build a document with the store API and then assert on a
 * derived read. Production never needs it: the revision moves on its own.
 */
export function clearDocCache(store: Store): void {
  caches.delete(store);
}
