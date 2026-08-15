/**
 * Dropping a library asset — onto a shot, or onto open canvas.
 *
 * THE SPLIT IS THE WHOLE POINT, and it is what the founder asked for: the shot
 * behaviour is for SHOTS only.
 *
 *   ONTO A SHOT   — nothing is created on the canvas. The asset is appended to
 *                   that shot's media list, and the panel renders it in the lane
 *                   its kind belongs to, or in the slot it was dropped on. There
 *                   is no free block, so there is nothing to duplicate, strand,
 *                   arrange, or get stuck dragging.
 *   OPEN CANVAS   — an ordinary AFFiNE image or attachment, exactly as before.
 *                   That is thinking space and it should behave like any other
 *                   whiteboard.
 *
 * ONE DROP TARGET, NOT TWO. Registering a target on each shot as well as on the
 * canvas would mean two handlers racing for one gesture — the shape of the
 * duplication bug. There is a single target on the viewport; where the pointer
 * landed decides what happens.
 */
import type { BlockStdScope } from '@blocksuite/std';
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';

import type { ShotBlockComponent } from './shot-block';
import {
  addMedia, moveMedia, readShot, removeMedia, setMediaRole, setShotFields, shotAtPoint,
} from './shots';
import { rolesFor, type MediaRole, type ShotMedia } from './model';
import { findBlock } from './blocks';

/** What the panel's tiles put on the wire. */
export const ASSET_DRAG_TYPE = 'voidspace-asset';

export interface AssetDragEntity {
  type: typeof ASSET_DRAG_TYPE;
  /** Minted once per gesture in `setDragData`, so a repeated delivery of the
   *  SAME drag is provably a duplicate rather than a new one. */
  dragId: string;
  media: Omit<ShotMedia, 'id' | 'role'>;
  /**
   * WHERE THIS CAME FROM, when it came off a shot card.
   *
   * Present means the drag is a MOVE: the asset is removed from the shot it
   * started on. Absent means a copy from the panel, which is what a library
   * drag has always been.
   *
   * The distinction is the same one `canvas-drop.ts` already makes, for the
   * reason it states: leaving the original behind gives the user two of the same
   * thing and no way to tell which one the video will use. A reference dragged
   * from scene 3 to scene 4 has been MOVED, because that is what the gesture
   * looks like and what it means everywhere else on a canvas.
   *
   * `takeId` rather than `mediaId` when the tile was a TAKE. Takes and
   * references are different lists on the shot, so the remover has to know which
   * one to look in — and a take dragged out is being auditioned on the canvas,
   * never re-filed, which is why it is a copy (see `handleAssetDrop`).
   *
   * ⚠ `origin.mediaId` IS NOT `media.mediaId`. They sit in the same object and
   * mean different things:
   *
   *   origin.mediaId  the entry's id WITHIN ITS SHOT — what `removeMedia` and
   *                   `setMediaRole` address. Meaningless outside that shot.
   *   media.mediaId   the VOIDSPACE LIBRARY id — the same file wherever it is
   *                   used, on any shot, on any board.
   *
   * The names match what each side already calls its own field, so renaming
   * either would break a convention somewhere else. Passing one where the other
   * is expected fails silently: `removeMedia` simply finds nothing and returns
   * false, so a "move" quietly becomes a copy.
   */
  origin?: { shotId: string; mediaId?: string; takeId?: string };
}

/**
 * A composition block on the wire.
 *
 * A SEPARATE ENTITY, not a sixth media kind, because a block is not a file.
 * It has no url, no bytes and nothing to place on a canvas — dropping one says
 * "make this shot a graphic built from this design", which is a change to the
 * SHOT, not an addition to its media list. Folding it into `AssetDragEntity`
 * would have made `media.url` optional for every consumer of every drag, to
 * describe something that is never media.
 */
export const BLOCK_DRAG_TYPE = 'voidspace-block';

export interface BlockDragEntity {
  type: typeof BLOCK_DRAG_TYPE;
  dragId: string;
  /** The block's name, which is its identity everywhere else in the system. */
  name: string;
  /** Shown in the toast, so the confirmation names the thing they dragged. */
  label?: string;
}

export interface DropOutcome {
  target: 'shot' | 'canvas';
  shotId?: string;
  mediaId?: string;
}

/**
 * Where a dropped BLOCK lands.
 *
 * `refused` rather than a silent no-op for the open canvas: dropping a lower
 * third onto empty space is a reasonable thing to try, and "nothing happened"
 * is the worst possible answer. The caller turns it into a sentence.
 */
export type BlockDropOutcome =
  | { target: 'shot'; shotId: string; title: string }
  | { target: 'refused'; reason: string };

/** The default role for something dropped in, by kind. `reference` is the safest
 *  wrong answer for a picture: additive, where a wrong first-frame silently
 *  changes the video. Audio arrives as an effect rather than the score. */
function defaultRole(kind: ShotMedia['kind']): MediaRole {
  return kind === 'audio' ? 'sfx' : 'reference';
}

/** The shot component under a point, if any. */
function shotComponentAt(
  std: BlockStdScope,
  shotId: string,
): ShotBlockComponent | null {
  return (std.view.getBlock(shotId) as ShotBlockComponent | null) ?? null;
}

/**
 * Where a drop at these SCREEN coordinates would land.
 *
 * Exported so the highlight and the drop itself are decided by one function —
 * a drop that lands somewhere other than the zone that lit up is worse than no
 * highlight at all.
 */
export function dropZoneAt(
  std: BlockStdScope,
  clientX: number,
  clientY: number,
): { shotId: string; zone: string | null } | null {
  const gfx = std.get(GfxControllerIdentifier);
  const [mx, my] = gfx.viewport.toModelCoord(clientX, clientY);
  const shotId = shotAtPoint(std, [mx, my]);
  if (!shotId) return null;
  return { shotId, zone: shotComponentAt(std, shotId)?.zoneAt(clientX, clientY) ?? null };
}

/**
 * WHERE IN THE LANE A DROP LANDS — as an index into the shot's media list.
 *
 * Reads the tiles that are actually on screen and asks which one the pointer is
 * past, by their midpoints: dropping on the left half of a tile means "before
 * it", the right half means "after". That is the rule every list-reordering
 * interface uses, and it is the one people already expect.
 *
 * Measured from the DOM rather than computed from the model, because the lane
 * SCROLLS. A lane holding nine references shows four, and an index derived from
 * the model would be right about a row the user cannot see.
 *
 * Returns null when there is nothing to work out — no tiles, or the pointer is
 * not over a lane — and the caller then leaves the order alone.
 */
export function insertionIndexAt(
  std: BlockStdScope,
  shotId: string,
  mediaId: string,
  clientX: number,
  clientY: number,
): number | null {
  const doc = shotComponentAt(std, shotId)?.ownerDocument;
  const el = doc?.elementFromPoint(clientX, clientY) as HTMLElement | null;
  const strip = el?.closest<HTMLElement>('[data-strip]');
  if (!strip) return null;

  const tiles = [...strip.querySelectorAll<HTMLElement>('[data-drag-media]')];
  if (!tiles.length) return null;

  // The ids IN THIS LANE, in the order they are drawn. The shot's list also
  // holds the other lanes and the slotted media, so a lane index is not a list
  // index — the id is what carries across.
  const laneIds = tiles.map(t => t.dataset.dragMedia!).filter(Boolean);
  let before = laneIds.length;
  for (let i = 0; i < tiles.length; i++) {
    const r = tiles[i]!.getBoundingClientRect();
    if (clientX < r.left + r.width / 2) { before = i; break; }
  }

  const shot = readShot(std, shotId);
  if (!shot) return null;
  // Translate "before the Nth tile in this lane" into an index in the shot's
  // own list — the only thing `moveMedia` can act on.
  const targetId = laneIds[before];
  const list = shot.media.map(m => m.id);
  const from = list.indexOf(mediaId);
  if (from < 0) return null;
  const to = targetId ? list.indexOf(targetId) : list.length;
  if (to < 0) return null;
  // Removing the dragged item first shifts everything after it down one.
  return to > from ? to - 1 : to;
}

/** `moveMedia` takes a DELTA; a drop knows an absolute position. */
function moveMediaTo(std: BlockStdScope, shotId: string, mediaId: string, to: number): void {
  const shot = readShot(std, shotId);
  if (!shot) return;
  const from = shot.media.findIndex(m => m.id === mediaId);
  if (from < 0 || to === from) return;
  moveMedia(std, shotId, mediaId, to - from);
}

/**
 * Handle one drop.
 *
 * `placeOnCanvas` is injected rather than imported so this module has no
 * dependency on the blob/placement machinery — it only decides WHERE a drop
 * goes, which keeps the interesting rule in one readable place.
 */
export async function handleAssetDrop(
  std: BlockStdScope,
  entity: AssetDragEntity,
  at: { clientX: number; clientY: number },
  placeOnCanvas: (media: AssetDragEntity['media'], point: [number, number]) => Promise<void>,
): Promise<DropOutcome> {
  const hit = dropZoneAt(std, at.clientX, at.clientY);

  /**
   * DROPPED BACK ON ITS OWN SHOT.
   *
   * Never a remove-and-re-add: that loses the role, the tag, the trim and the
   * note, and sends the tile to the end of its lane. The gesture that looks most
   * like "I did not mean anything by that" would be the most destructive one on
   * the card.
   *
   * Landing on a LANE is a REORDER, and it is worth having. A model receives
   * references positionally — `@Image1`, `@Image2` — and the prompt refers back
   * to them by number, so order changes the output. `moveMedia` has existed
   * since the beginning and was reachable only by the agent; this is the same
   * operation with a pointer.
   */
  if (hit && entity.origin?.mediaId && hit.shotId === entity.origin.shotId) {
    const to = insertionIndexAt(std, hit.shotId, entity.origin.mediaId, at.clientX, at.clientY);
    if (to !== null) moveMediaTo(std, hit.shotId, entity.origin.mediaId, to);
    return { target: 'shot', shotId: hit.shotId, mediaId: entity.origin.mediaId };
  }
  // A TAKE dropped back on its own card: nothing. Takes are ordered by when they
  // were made, which is not a thing to rearrange.
  if (hit && entity.origin && hit.shotId === entity.origin.shotId) {
    return { target: 'shot', shotId: hit.shotId };
  }

  if (!hit) {
    await placeOnCanvas(entity.media, [at.clientX, at.clientY]);
    /**
     * A REFERENCE MOVES OUT TO THE CANVAS; A TAKE IS COPIED THERE.
     *
     * They are different objects and the gesture means different things. A
     * reference is an INPUT the user is taking off this shot — pulling it out
     * to the canvas is where it now lives, and leaving a duplicate behind would
     * mean the shot still generates from something the user just removed.
     *
     * A take is an OUTPUT and the shot's own record of what it produced. Pulling
     * one onto the canvas is auditioning it at size — the reason the canvas is
     * the scratch pad — and it must not silently delete the take, its cost, its
     * seed or its place in the strip. Discarding a take is the ✕, deliberately.
     */
    if (entity.origin?.mediaId && !entity.origin.takeId) {
      removeMedia(std, entity.origin.shotId, entity.origin.mediaId);
    }
    return { target: 'canvas' };
  }

  const kind = entity.media.kind;
  const id = addMedia(std, hit.shotId, { ...entity.media, role: defaultRole(kind) });
  if (!id) return { target: 'canvas' };

  // Landed on a DIFFERENT shot — the reference has moved, so it leaves the one
  // it came from. Takes are copied for the reason above.
  if (entity.origin?.mediaId && !entity.origin.takeId
      && entity.origin.shotId !== hit.shotId) {
    removeMedia(std, entity.origin.shotId, entity.origin.mediaId);
  }

  /**
   * Dropped ON a well: that is an explicit statement of what the asset is for,
   * and honouring it saves the user a second action.
   *
   * ASK WHAT IS LEGAL HERE rather than checking a fixed list. A graphic's wells
   * are its BLOCK'S OWN SLOTS — `screenshot`, `portrait`, whatever the author
   * named them — so `isSlotRole`, which only knew the built-in vocabulary,
   * answered false for every one of them and the drop fell through to a plain
   * reference. The picture landed on the card and the well it was dropped on
   * stayed empty, which is the most confusing possible outcome.
   */
  const shot = readShot(std, hit.shotId);
  const legal = rolesFor(
    shot?.kind ?? 'clip',
    kind,
    findBlock(shot?.composition ?? '')?.slots,
  );
  if (hit.zone && legal.includes(hit.zone as MediaRole)) {
    setMediaRole(std, hit.shotId, id, hit.zone as MediaRole);
  }
  return { target: 'shot', shotId: hit.shotId, mediaId: id };
}

/**
 * Handle one BLOCK drop.
 *
 * Onto a shot: that shot becomes a graphic rendered from this block. Its media,
 * its text and its planned length are all untouched — a shot that was going to
 * be a clip of a kitchen and is now a stat card still has the voiceover the user
 * wrote for it, and the references they gathered are still there to fill the
 * block's slots.
 *
 * The variables ARE cleared, and that is the one deliberate loss: they were the
 * previous block's slot values, and carrying `stat: "92%"` into a quote card
 * would put a number where the quote goes.
 */
export function handleBlockDrop(
  std: BlockStdScope,
  entity: BlockDragEntity,
  at: { clientX: number; clientY: number },
): BlockDropOutcome {
  const gfx = std.get(GfxControllerIdentifier);
  const [mx, my] = gfx.viewport.toModelCoord(at.clientX, at.clientY);
  const shotId = shotAtPoint(std, [mx, my]);

  if (!shotId) {
    return {
      target: 'refused',
      reason: 'Drop a block onto a shot — it becomes that scene’s graphic.',
    };
  }
  const shot = readShot(std, shotId);
  if (!shot) {
    return { target: 'refused', reason: 'That shot is no longer on the board.' };
  }

  setShotFields(std, shotId, {
    kind: 'hyperframes',
    composition: entity.name,
    // See the note above: slot values belong to the block that declared them.
    ...(shot.composition && shot.composition !== entity.name ? { compositionVars: {} } : {}),
  });

  return { target: 'shot', shotId, title: shot.title || 'the shot' };
}
