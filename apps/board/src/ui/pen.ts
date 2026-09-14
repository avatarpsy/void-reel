/**
 * The pen, made to feel like a pen.
 *
 * Two things a graphics tablet expects that AFFiNE's tools do not give it:
 *
 *  1. EVERY SAMPLE THE PEN TOOK, not one per animation frame.
 *  2. A TAP that erases, not only a swipe.
 *
 * Both are added by wrapping the tool instances the `ToolController` already
 * holds. `ToolController.get()` is public, and its dispatcher invokes handlers
 * as `tool[eventName](evt)` — a dynamic lookup at call time — so replacing a
 * method on the instance is an extension point by construction rather than a
 * way around one. It also means no `di.override`, no subclass, and no new
 * dependency on `@blocksuite/affine-gfx-brush`, whose tool classes are not
 * re-exported through the `@blocksuite/affine` umbrella we build against.
 *
 * ── 1. COALESCED SAMPLES ─────────────────────────────────────────────────────
 * `DragController` dispatches one `dragMove` per `pointermove`, and the browser
 * delivers those at the display's refresh rate — about 60 a second. A Wacom
 * samples at 130-200. The samples in between are not lost: they are attached to
 * the event that superseded them, and `getCoalescedEvents()` is how you read
 * them. A tool that never calls it draws a 60 Hz polygon through points a 200 Hz
 * pen measured, which shows up exactly where people notice it — as corners on
 * fast strokes — and it discards the per-sample PRESSURE with them, which is
 * what makes a stroke taper.
 *
 * Replaying them through the tool's own `dragMove` keeps every rule the tool
 * already implements (pressure detection, the shift-key straight line, the
 * stash/pop batching) instead of reimplementing any of it. It is also close to
 * free: `points` is stashed for the duration of a stroke, so an extra append
 * touches local state only, and `commands` — the perfect-freehand outline — is a
 * LAZY getter that recomputes once per actual paint however many times it was
 * invalidated in between.
 *
 * ── 2. TAP TO ERASE ──────────────────────────────────────────────────────────
 * `EraserTool` implements `dragStart`/`dragMove`/`dragEnd` and inherits a no-op
 * `click`. So the eraser rubs things out when you SWIPE across them and does
 * nothing at all when you TAP one — which is the first thing anybody tries, and
 * the natural gesture for a dot or a short mark. Measured before this: tapping a
 * stroke dead centre left the element count unchanged.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * The eraser stays an OBJECT eraser: touch a stroke and the whole stroke goes.
 * That is what AFFiNE means by it and what the toolbar icon promises, and
 * splitting strokes into surviving runs would make the same gesture mean
 * different things on different boards. What made object-erase feel broken was
 * never the semantics — it was the stray one-point elements left behind by the
 * double-mount bug, which survived every erase and kept the canvas littered.
 * That is fixed at its source in `editor.ts`.
 */
import { PointerEventState } from '@blocksuite/std';
import { GfxControllerIdentifier, type GfxModel } from '@blocksuite/std/gfx';

import type { MountedBoard } from '../blocksuite/editor';

/** Tools that draw a freehand path, and so want every sample. */
const FREEHAND_TOOLS = ['brush', 'highlighter'] as const;

/**
 * Samples closer together than this (in CSS pixels) carry no shape information
 * — that is the hand holding still — and dropping them keeps a slow, careful
 * line from accumulating a cloud of near-identical points that the smoothing
 * pass then has to average back out.
 */
const MIN_SAMPLE_GAP = 0.75;

/** How near a tap has to land to count as "on" something, in screen pixels. */
const TAP_HIT_THRESHOLD = 12;

interface DragMoveTool { dragMove(e: PointerEventState): void }
interface ClickTool { click(e: PointerEventState): void }

export function installPen(board: MountedBoard): () => void {
  const gfx = board.std.get(GfxControllerIdentifier);
  const restore: Array<() => void> = [];

  const toolNamed = <T>(toolName: string): T | undefined => {
    try {
      // A tool we do not register — or that upstream renamed — is not an error.
      // The board simply has nothing to improve for it.
      return gfx.tool.get({ toolName } as never) as T | undefined;
    } catch {
      return undefined;
    }
  };

  // ── 1. Every sample the pen took ──────────────────────────────────────────
  for (const toolName of FREEHAND_TOOLS) {
    const tool = toolNamed<DragMoveTool>(toolName);
    if (!tool || typeof tool.dragMove !== 'function') continue;

    const original = tool.dragMove.bind(tool);
    const patched = (e: PointerEventState): void => {
      for (const sample of coalescedBefore(e)) original(sample);
      original(e);
    };
    tool.dragMove = patched;
    restore.push(() => { if (tool.dragMove === patched) tool.dragMove = original; });
  }

  // ── 2. Tap to erase ───────────────────────────────────────────────────────
  const eraser = toolNamed<ClickTool>('eraser');
  if (eraser && typeof eraser.click === 'function') {
    const original = eraser.click.bind(eraser);
    const patched = (e: PointerEventState): void => {
      original(e);

      const [x, y] = gfx.viewport.toModelCoord(e.point.x, e.point.y);
      /**
       * Topmost only. `all: true` returns everything under the point, and
       * erasing the lot would take the frame a stroke happens to sit on along
       * with it — a tap should remove the ONE thing that was aimed at.
       *
       * The reach is divided by zoom for the same reason the eraser's own
       * cursor is: twelve pixels means twelve pixels of screen at any zoom, not
       * twelve model units that shrink to nothing as you zoom out.
       */
      const hit = gfx.getElementByPoint(x, y, {
        hitThreshold: TAP_HIT_THRESHOLD / Math.min(gfx.viewport.zoom, 1),
      }) as GfxModel | null;
      if (!hit || hit.isLocked?.()) return;

      board.store.captureSync();     // its own undo step, like every other erase
      gfx.deleteElement(hit);
    };
    eraser.click = patched;
    restore.push(() => { if (eraser.click === patched) eraser.click = original; });
  }

  return () => { for (const undo of restore) undo(); };
}

/**
 * The samples the browser folded into this event, as tool-ready states.
 *
 * Returns all of them EXCEPT the last: that one is the event itself, and the
 * caller replays it afterwards so the tool's bookkeeping ends on the real event.
 */
function coalescedBefore(e: PointerEventState): PointerEventState[] {
  const raw = e.raw;

  // Holding shift asks for a straight line. Feeding the in-between samples
  // through that axis clamp adds points which say nothing, and risks flipping
  // the horizontal/vertical decision part-way through a stroke.
  if (raw.shiftKey) return [];
  if (typeof raw.getCoalescedEvents !== 'function') return [];

  let events: PointerEvent[];
  try {
    events = raw.getCoalescedEvents();
  } catch {
    return [];                       // not implemented for this pointer type
  }
  if (events.length < 2) return [];

  // `PointerEventState` reads only `left`/`top` off the rect, and the container
  // offset on the event we were handed is exactly that — so no layout read.
  const rect = { left: e.containerOffset.x, top: e.containerOffset.y } as DOMRect;

  const out: PointerEventState[] = [];
  let lastX = 0;
  let lastY = 0;
  let seeded = false;

  for (let i = 0; i < events.length - 1; i++) {
    const c = events[i];
    if (seeded && Math.hypot(c.clientX - lastX, c.clientY - lastY) < MIN_SAMPLE_GAP) continue;
    seeded = true;
    lastX = c.clientX;
    lastY = c.clientY;
    out.push(new PointerEventState({
      event: c,
      rect,
      startX: e.start.x,
      startY: e.start.y,
      last: null,                    // freehand tools read `point`, never `delta`
    }));
  }
  return out;
}
