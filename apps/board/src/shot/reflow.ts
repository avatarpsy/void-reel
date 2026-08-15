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

import { readShots, relayoutShots } from './shots';

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

      return {
        onDragEnd: (_ctx: ExtensionDragEndContext) => {
          /**
           * READ THE ORDER, THEN SNAP TO IT.
           *
           * `readShots` sorts by x — which is exactly where the user just put
           * the card — so the order is already what they intended. This only
           * puts the cards back on the pitch.
           *
           * `relayoutShots` writes nothing when a card is already where it
           * belongs, so dragging a shot a few pixels and letting go costs one
           * write for that card and none for the rest.
           */
          const order = readShots(this.std).map(s => s.id);
          if (order.length > 1) relayoutShots(this.std, order);
        },
      };
    });
  }
}
