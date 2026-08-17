/**
 * Dragging a shot to a new place in the filmstrip, and the strip tidying itself.
 *
 * ── WHAT THIS FIXES ──────────────────────────────────────────────────────────
 * Filmstrip order IS x-position: `readShots` sorts by it, and that sort is the
 * compile order. So dragging a card between two others already reorders the
 * film — correctly, and it always has.
 *
 * What did not happen is the tidying. Cards are laid out on a fixed pitch
 * (`shotBounds`), but `relayoutShots` only ran on create and delete. Drop a card
 * between scenes 2 and 3 and it stayed exactly where the pointer left it: the
 * order was right and the strip had a hole on one side and an overlap on the
 * other. It reads as a bug in the thing that just worked, which is the worst
 * moment to look broken.
 *
 * ── WHY AN InteractivityExtension ────────────────────────────────────────────
 * Same reason `canvas-drop.ts` uses one: a block already on the canvas is moved
 * by BlockSuite's own gfx layer, so no HTML5 drag or drop event is ever fired
 * and nothing in the DOM layer sees the gesture. The gfx interactivity API is
 * the only place it is observable.
 *
 * ── AND IT ONLY ACTS AT THE END ──────────────────────────────────────────────
 * Reflowing during the drag would fight the pointer: every move would re-sort
 * the strip under the user's hand and the card would jump between slots while
 * they were still deciding. The order is read once, on release.
 */
import {
  InteractivityExtension,
  type DragExtensionInitializeContext,
  type ExtensionDragEndContext,
} from '@blocksuite/std/gfx';

import { relayOffHostRelease } from './drag-release';
import { SHOT_H } from './model';
import { boardPlan, readShots, relayoutShots } from './shots';

export class ShotReflowExtension extends InteractivityExtension {
  static override key = 'voidspace-shot-reflow';

  override mounted(): void {
    this.action.onDragInitialize((context: DragExtensionInitializeContext) => {
      /**
       * ONLY WHEN SHOTS ARE WHAT IS MOVING.
       *
       * A marquee that happens to include a shot alongside three loose pictures
       * is somebody rearranging their canvas, and snapping the strip mid-gesture
       * would move things they did not ask to move. Every element in the drag
       * has to be a shot for this to be a filmstrip reorder.
       */
      const ids = context.elements
        .map(el => (el as unknown as { id?: string }).id)
        .filter((id): id is string => !!id);
      if (!ids.length) return {};

      const shotIds = new Set(readShots(this.std).map(s => s.id));
      if (!ids.every(id => shotIds.has(id))) return {};

      /**
       * A RELEASE OVER OUR OWN CHROME STILL HAS TO END THE DRAG. The manager
       * binds `pointerup` to the editor host, and the asset panel and toolbars
       * are siblings of it — see `drag-release.ts`. Without this, dragging a
       * card leftwards (which is how you move it earlier in the film) ends over
       * the panel and the move is never committed at all.
       */
      const endRelease = relayOffHostRelease(this.std);

      return {
        clear: endRelease,
        /**
         * ── AFTER THE DROP HAS ACTUALLY LANDED, NOT DURING IT ────────────────
         *
         * This ran synchronously and produced overlapping cards. BlockSuite
         * moves a dragged block by STASHING `xywh` — the writes are local while
         * the pointer is down — and commits them to the document in
         * `GfxBlockComponent.onDragEnd` with `model.pop('xywh')`. Our handler ran
         * first, so:
         *
         *   • the shot order was still the one cached from BEFORE the drag (a
         *     stashed write never reaches `blockUpdated`, so the per-revision
         *     memo was never invalidated), and
         *   • whatever box we assigned to the dragged card was then overwritten
         *     by the pop.
         *
         * Measured on three cards: dragging C to the far left left C at x=247
         * and A at x=360 — two cards overlapping, C off the grid. A 40px nudge
         * of B put B and C at the same x. From the user's side that is "I move
         * them and they snap back", and sometimes worse than snap-back.
         *
         * One frame later the pop has been committed, `blockUpdated` has moved
         * the revision, and the order read here is the order the user just made.
         * A frame is also invisible: the card is already sitting where it was
         * dropped, and it slides onto the grid from there.
         */
        onDragEnd: (_ctx: ExtensionDragEndContext) => {
          requestAnimationFrame(() => this.settle(ids));
        },
      };
    });
  }

  /** Re-file whatever moved, then put the strip back on its pitch. */
  private settle(ids: string[]): void {
    // The gesture may have ended by deleting the card, or the board may have
    // been closed between the drop and this frame.
    if (!ids.some(id => this.std.store.getBlock(id))) return;

    /**
     * WHICH ROW IT LANDED IN IS A STATEMENT ABOUT THE FILM.
     *
     * The board is a grid: a scene is a row (`shot/layout.ts`). So a card
     * dropped inside another scene's row has been moved to that scene, and
     * saying so is the whole reason the rows are there — the alternative is a
     * card that visibly sits under "sc 4" while still claiming to cover sc 2,
     * and a layout that snaps it back on the next open.
     *
     * SIDEWAYS IS STILL A RE-CUT. Landing in the row it started in changes no
     * scene and only its place in that row, which is the reorder this extension
     * has always done.
     */
    for (const id of ids) this.refile(id);

    /**
     * THEN SNAP.
     *
     * `readShots` sorts by row and then by x — which, now that this runs after
     * the drop has been committed, is exactly where the user just put the card.
     * This only puts the cards back on the pitch.
     *
     * `relayoutShots` writes nothing when a card is already where it belongs, so
     * dragging a shot a few pixels and letting go costs one write for that card
     * and none for the rest.
     */
    const order = readShots(this.std).map(s => s.id);
    if (order.length) relayoutShots(this.std, order);
  }

  /**
   * Put a shot on whatever scene its new row belongs to.
   *
   * BY VERTICAL OVERLAP, not by the card's top edge: a card dropped straddling
   * two rows belongs to the one it is mostly in, which is what it looks like it
   * is in. Comparing a single edge makes a card that is 90% inside a row read as
   * being in the row above.
   *
   * The rows come from the plan the layout just drew, so the answer is against
   * the geometry the user was actually looking at.
   *
   * Writes nothing when the scene has not changed, and nothing at all on a flat
   * board — a piece with no screenplay has one row, and re-filing within it
   * would be asserting a scene nobody wrote.
   */
  private refile(id: string): void {
    const plan = boardPlan(this.std);
    if (plan.flat) return;

    const block = this.std.store.getBlock(id);
    if (!block) return;
    let box: number[];
    try { box = JSON.parse((block.model.props as { xywh: string }).xywh) as number[]; }
    catch { return; }
    const [, top, , height] = box;
    const bottom = top + (height || SHOT_H);

    let best: { key: string; overlap: number } | null = null;
    for (const row of plan.rows) {
      const overlap = Math.min(bottom, row.y + row.height) - Math.max(top, row.y);
      if (overlap > 0 && (!best || overlap > best.overlap)) {
        best = { key: row.sceneKey, overlap };
      }
    }
    // Off every row — dropped in the margin below the film. Left alone rather
    // than filed under the nearest thing, which would be a guess about the one
    // decision this gesture is supposed to make explicit.
    if (!best) return;

    const props = block.model.props as { sceneKey?: string };
    if ((props.sceneKey ?? '') === best.key) return;
    this.std.store.captureSync();
    this.std.store.updateBlock(block.model, { sceneKey: best.key });
  }
}
