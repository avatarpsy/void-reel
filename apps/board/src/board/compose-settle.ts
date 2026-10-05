/**
 * ── LAY A COMPOSED PAGE OUT AGAIN ONCE IT HAS REALLY SIZED ───────────────────
 *
 * The browser half of `reflowComposed` (compose.ts), which owns the arithmetic.
 * This only waits, measures and applies.
 *
 * WHY IT WAITS: a note's height is decided by AFFiNE after it renders, through a
 * ResizeObserver that writes the grown `xywh` back to the model. Until that has
 * happened every box still reads the height `cardHeight` guessed, and laying the
 * page out from those would reproduce the overlaps this exists to remove. So it
 * polls the boxes each frame, with a cap so a hidden tab (no frames, no resize
 * observers) cannot hold a tool call open.
 *
 * "STOPPED CHANGING" IS NOT ENOUGH, measured: a note sits at its drawn height
 * for 600-900ms and then jumps (100 -> 564 for one 248-wide card), and on a
 * 20-element page the first quiet stretch arrived at ~700ms with the last
 * section still unrendered — it grew to 928 AFTER the re-layout, and the page
 * had 12 overlapping pairs again. So a card only counts as measured once its
 * height has moved off the drawn one, and the page keeps being watched after
 * each re-layout so a late grower triggers another.
 *
 * ONE UNDO: Yjs merges a write into the previous undo item when it lands within
 * `captureTimeout` (500ms) of the last captured change. The wait is longer than
 * that, so the moves would become a second Ctrl+Z. If the draw is still the top
 * of the undo stack — nothing else was done in between — the capture clock is
 * restarted so the moves join it. Otherwise they are their own step, and that
 * is reported rather than forced.
 */
import type { BlockStdScope } from '@blocksuite/std';
import { GfxControllerIdentifier, type GfxModel } from '@blocksuite/std/gfx';

import { clearOfOwned, fitFramesToMembers, type DrawResult } from './canvas';
import { type ComposeBox, type ComposePlan, reflowComposed } from './compose';
import { boundsOf, moveDown } from './space';

/** Long enough for a large page to render; short enough to keep a tool call snappy. */
const SETTLE_CAP_MS = 2000;
/** Unchanged for this long counts as settled. */
const STABLE_MS = 150;
/**
 * After a re-layout, keep watching this long for a late grower. A card moved
 * into view, or one that rendered late, can still change height.
 */
const WATCH_AFTER_MS = 350;
/** How long a page that did not settle inside the cap is still watched. */
const LATE_WATCH_MS = 6000;

export interface ComposeSettleResult {
  /** Cards moved to their measured rows. */
  moved: number;
  /** Did the heights stop changing before the cap? */
  settled: boolean;
  waitedMs: number;
  /** Did the moves merge into the draw's undo step? */
  oneUndo: boolean;
}

/** The next animation frame, or a short timer when frames are not coming. */
function nextTick(): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, 50);
    requestAnimationFrame(() => { clearTimeout(t); resolve(); });
  });
}

/**
 * Call IMMEDIATELY after `drawOnCanvas(std, plan.elements, { settle: false })`,
 * before any await: the undo item the draw opened is captured on entry.
 */
export async function settleComposed(
  std: BlockStdScope,
  plan: ComposePlan,
  drawn: DrawResult,
): Promise<ComposeSettleResult> {
  const history = std.store.history.undoManager;
  const drawItem = history.undoStack[history.undoStack.length - 1];

  const gfx = std.get(GfxControllerIdentifier);
  const surface = gfx.surface;
  const madeIds = drawn.ids.filter((id): id is string => !!id);
  const result: ComposeSettleResult = { moved: 0, settled: false, waitedMs: 0, oneUndo: false };
  if (!surface || !madeIds.length) return result;

  const modelOf = (id: string): GfxModel | undefined =>
    (surface.getElementById(id) ?? std.store.getBlock(id)?.model) as GfxModel | undefined;
  const measure = (): Record<string, ComposeBox | undefined> => {
    const boxes: Record<string, ComposeBox | undefined> = {};
    for (const [ref, id] of Object.entries(drawn.refs)) {
      const model = modelOf(id);
      boxes[ref] = model ? boundsOf(model) ?? undefined : undefined;
    }
    return boxes;
  };

  const noteRefs = plan.layout.sections.flatMap(sec => sec.rows.flat())
    .concat(plan.layout.subtitle ? [plan.layout.subtitle] : []);
  const drawnH = new Map(noteRefs.map(ref => [ref, measure()[ref]?.h]));
  const frames = plan.layout.sections
    .map(sec => ({
      frameId: drawn.refs[sec.frame],
      memberIds: sec.rows.flat().map(ref => drawn.refs[ref]).filter((id): id is string => !!id),
    }))
    .filter(f => !!f.frameId && f.memberIds.length > 0);

  let undoChecked = false;
  /** The undo item our first pass landed in, so a later pass joins only that. */
  let ourItem: unknown = null;
  const apply = (): void => {
    // ── One undo step, if nothing else happened in between ──────────────────
    if (!undoChecked) {
      undoChecked = true;
      const top = history.undoStack[history.undoStack.length - 1];
      if (drawItem && top === drawItem) {
        history.lastChange = Date.now();
        result.oneUndo = true;
      }
      // Off the storyboard strip first, as a whole batch — the same pass a
      // plain draw gets. The reflow anchors on the title, so it keeps that offset.
      try { clearOfOwned(std, madeIds); } catch { /* layout is never fatal */ }
    } else if (ourItem && history.undoStack[history.undoStack.length - 1] === ourItem) {
      // A later pass is still part of the same action; keep it in the same step.
      history.lastChange = Date.now();
    }

    const boxes = measure();
    const moves = reflowComposed(plan.layout, boxes);
    std.store.transact(() => {
      for (const { ref, y } of moves) {
        const id = drawn.refs[ref];
        const model = id ? modelOf(id) : undefined;
        const box = boxes[ref];
        if (!model || !box) continue;
        try {
          moveDown(gfx, model, y - box.y);
          result.moved++;
        } catch { /* deleted mid-pass */ }
      }
    });
    // LAST, around where the members now are.
    try { fitFramesToMembers(std, frames); } catch { /* layout is never fatal */ }
    ourItem ??= history.undoStack[history.undoStack.length - 1] ?? null;
  };

  // ── Wait, measure, lay out; again if anything grows afterwards ────────────
  const start = performance.now();
  let lastSig = '';
  let quietSince = start;
  let appliedSig: string | null = null;
  let appliedAt = 0;
  const gone = () => std.store.readonly || !madeIds.every(id => !!modelOf(id));
  const sigOf = (boxes: Record<string, ComposeBox | undefined>) =>
    noteRefs.map(ref => boxes[ref]?.h ?? '-').join('|');

  /** Poll until `deadline`; true once settled. False if the batch is gone. */
  const run = async (deadline: number): Promise<boolean> => {
    while (performance.now() < deadline) {
      await nextTick();
      // Undone, or partly deleted, while we waited: the layout is not ours to tidy.
      if (gone()) return false;

      const boxes = measure();
      const sig = sigOf(boxes);
      const now = performance.now();
      if (sig !== lastSig) { lastSig = sig; quietSince = now; continue; }
      if (now - quietSince < STABLE_MS) continue;

      const allGrown = noteRefs.every(ref => boxes[ref]?.h !== drawnH.get(ref));
      if (sig !== appliedSig && (allGrown || (appliedSig === null && now - start > SETTLE_CAP_MS / 2))) {
        apply();
        appliedSig = sig;
        appliedAt = performance.now();
        continue;
      }
      if (appliedSig === sig && allGrown && now - appliedAt >= WATCH_AFTER_MS) return true;
    }
    return false;
  };

  result.settled = await run(start + SETTLE_CAP_MS);
  result.waitedMs = Math.round(performance.now() - start);
  if (result.settled || gone()) return result;

  // At the cap: lay out from whatever is there, unless that is already done.
  if (sigOf(measure()) !== appliedSig) apply();

  /**
   * AND KEEP AN EYE ON IT AFTER ANSWERING. Measured: on a throttled tab the
   * last section was still growing when the cap hit, and three seconds later
   * the page had 7 overlapping pairs again. The tool call should not wait that
   * long, so the watch carries on in the background for a few seconds and
   * re-lays the page if anything grows. Same undo step while nothing else has
   * happened; it stops as soon as the batch is undone or deleted.
   */
  void run(performance.now() + LATE_WATCH_MS).catch(() => { /* layout is never fatal */ });

  return result;
}
