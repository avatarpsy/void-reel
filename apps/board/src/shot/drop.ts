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
import { addMedia, readShot, setMediaRole, setShotFields, shotAtPoint } from './shots';
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

  if (!hit) {
    await placeOnCanvas(entity.media, [at.clientX, at.clientY]);
    return { target: 'canvas' };
  }

  const kind = entity.media.kind;
  const id = addMedia(std, hit.shotId, { ...entity.media, role: defaultRole(kind) });
  if (!id) return { target: 'canvas' };

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
