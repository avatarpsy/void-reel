/**
 * How a running take is doing — held in memory, never in the document.
 *
 * ── WHY THIS IS NOT A TAKE PROP ─────────────────────────────────────────────
 * The obvious implementation is `updateTake(… { progress })` on every poll. It
 * is wrong twice over:
 *
 *   • It WRITES THE DOCUMENT three times a minute for the length of a render.
 *     Every write is a Yjs transaction, an undo step and a persistence round —
 *     so one clip becomes forty saves, and a user who presses ctrl-Z after a
 *     render undoes "sampling 14/24" instead of the edit they meant.
 *
 *   • It PERSISTS SOMETHING THAT EXPIRES. A percentage is only true while the
 *     job is running. Stored, it survives the job: reopen the board tomorrow and
 *     a take that died overnight still cheerfully reads "62%", which is a lie
 *     the card has no way to detect.
 *
 * Progress is ephemeral by nature, so it lives where ephemeral things live. On
 * reload it is simply gone, and the card falls back to the take's real `status`
 * — which IS persisted, and is the part that was always true.
 *
 * The same store carries `cancellable`, for the same reason: whether a stop
 * control can work depends on the job still existing in the page that started
 * it, which a reloaded tab no longer has.
 */

export interface TakeProgress {
  /** What to show instead of the generic "generating…". */
  label?: string;
  /** 0–1 when the runtime can say, absent when it cannot. Never fabricated. */
  pct?: number | null;
  /** Whether the page holds a handle that could actually stop this. */
  cancellable?: boolean;
}

const state = new Map<string, TakeProgress>();
const listeners = new Set<() => void>();

/** Repaint anything drawing take progress. Same contract as `onModelCatalogue`:
 *  progress is not a block prop, so nothing else marks a card dirty when it
 *  changes and the label would sit stale until an unrelated edit. */
export function onTakeProgress(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce(): void {
  listeners.forEach(fn => {
    try { fn(); } catch { /* one bad listener must not stop the rest repainting */ }
  });
}

/**
 * Merge in what the parent just said.
 *
 * MERGE, not replace. The two facts arrive from different places at different
 * times — `cancellable` once, when the node job is registered, and `label` on
 * every poll after that — so a replacing write would clear the stop control on
 * the very next progress line.
 */
export function setTakeProgress(takeId: string, info: TakeProgress): void {
  if (!takeId) return;
  state.set(takeId, { ...state.get(takeId), ...info });
  announce();
}

export function takeProgress(takeId: string): TakeProgress | null {
  return state.get(takeId) ?? null;
}

/** Forget a take's progress — when it reaches a terminal status, or its card
 *  goes away. Called on status change rather than on a timer so a stalled job
 *  keeps showing its last known phase instead of silently blanking. */
export function clearTakeProgress(takeId: string): void {
  if (state.delete(takeId)) announce();
}
