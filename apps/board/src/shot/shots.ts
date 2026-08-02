/**
 * Shots — creating them, ordering them, and changing what is in them.
 *
 * THE ONE PLACE THAT KNOWS THE SHAPE OF A SHOT. The agent tools, the drop
 * handler, the compile step and the tests all go through here, so none of them
 * can get it subtly wrong on its own.
 *
 * WHAT CHANGED, AND WHY IT MATTERS
 * A shot used to be an `affine:frame` and its media were loose canvas blocks
 * that lived inside it by GEOMETRY. Reading a shot meant a spatial query;
 * changing one meant moving blocks around and hoping nothing else moved them
 * back. Now a shot is a block that owns its media as data:
 *
 *   • reading is `model.props` — no geometry, no scan, nothing to be one pixel
 *     outside of;
 *   • the agent gets the whole shot in a single read and can address any
 *     reference by id;
 *   • there is no free-floating block to duplicate, strand, or fight over.
 */
import type { BlockStdScope } from '@blocksuite/std';
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';
import { generateKeyBetween } from 'fractional-indexing';

import {
  SHOT_GAP, SHOT_H, SHOT_W, normaliseTag,
  type MediaRole, type RefKind, type ShotBlockModel, type ShotKind, type ShotMedia,
} from './model';

export interface ShotView {
  id: string;
  title: string;
  action: string;
  voiceover: string;
  camera: string;
  media: ShotMedia[];
  /** Video model id, or '' for the project default. */
  model: string;
  /** Planned seconds, or 0 for "not decided". */
  durationSec: number;
  /** 'clip' (generated) or 'graphic' (a composition). */
  kind: ShotKind;
  /** The designed block a graphic is built from; '' when not chosen. */
  composition: string;
  /** Values for that block's declared slots. */
  compositionVars: Record<string, string>;
  x: number;
}

function propsOf(std: BlockStdScope, id: string) {
  const block = std.store.getBlock(id);
  return block ? (block.model.props as ShotBlockModel['props']) : null;
}

/** Where shot `order` sits. The filmstrip reads left to right, and that IS the
 *  compile order — there is no second, hidden ordering to disagree with it. */
export function shotBounds(order: number): { x: number; y: number; w: number; h: number } {
  return { x: order * (SHOT_W + SHOT_GAP), y: 0, w: SHOT_W, h: SHOT_H };
}

/** Every shot, in filmstrip order. */
export function readShots(std: BlockStdScope): ShotView[] {
  return std.store
    .getBlocksByFlavour('voidspace:shot')
    .map(block => {
      const p = block.model.props as ShotBlockModel['props'];
      const [x] = JSON.parse(p.xywh || '[0,0,0,0]') as number[];
      return {
        id: block.id,
        title: p.title ?? '',
        action: p.action ?? '',
        voiceover: p.voiceover ?? '',
        camera: p.camera ?? '',
        media: p.media ?? [],
        model: p.model ?? '',
        durationSec: p.durationSec ?? 0,
        // Boards written before graphic shots existed have neither prop. A
        // shot with no kind is a CLIP — that is what every one of them was.
        kind: (p.kind as ShotKind) ?? 'clip',
        composition: p.composition ?? '',
        /**
         * COPIED, not referenced.
         *
         * This prop is backed by Yjs, so what the store hands back is a
         * REACTIVE PROXY. Structured clone refuses a proxy — so the moment a
         * shot had any composition variables, every `postMessage` carrying a
         * digest died with "could not be cloned" and `board_read` returned an
         * error for the WHOLE board, not just that shot. Measured: two shots on
         * the canvas, one stat card, and the agent could no longer read
         * anything.
         *
         * The same trap the model catalogue fell into from the other direction
         * (a Vue reactive proxy going in). Both boundaries now hand over plain
         * data; `media` was already safe because the digest rebuilds each entry.
         */
        compositionVars: { ...(p.compositionVars ?? {}) },
        x,
      };
    })
    .sort((a, b) => a.x - b.x);
}

export function readShot(std: BlockStdScope, id: string): ShotView | null {
  return readShots(std).find(s => s.id === id) ?? null;
}

/**
 * Add shots as ONE undoable action, appended to the filmstrip.
 *
 * `captureSync()` FIRST, and it is not optional: `transact` groups the writes
 * but does not open an undo unit, so on a fresh board the batch merges into the
 * still-open seed and the user's first Ctrl+Z appears to do nothing at all.
 *
 * Indexes come from the layer's own batch generator. `generateIndex()` reads the
 * manager's CURRENT state and the manager does not see a block until its
 * transaction commits, so calling it per shot returns the same key every time
 * and the shots end up tied in z-order.
 */
export function createShots(std: BlockStdScope, surfaceId: string, titles: string[]): string[] {
  const start = readShots(std).length;
  const layer = std.get(GfxControllerIdentifier).layer;
  const nextIndex = layer.createIndexGenerator();
  const ids: string[] = [];

  std.store.captureSync();
  std.store.transact(() => {
    titles.forEach((title, i) => {
      const b = shotBounds(start + i);
      ids.push(std.store.addBlock(
        'voidspace:shot',
        { title, xywh: `[${b.x},${b.y},${b.w},${b.h}]`, index: nextIndex(), media: [] },
        surfaceId,
      ));
    });
  });
  return ids;
}

/**
 * Re-flow the filmstrip into the given order.
 *
 * Order is the ARGUMENT, never the current geometry: a user dragging a panel
 * aside to look at it must not silently re-cut their film. And because a shot
 * owns its media, moving one moves everything in it — there is nothing left
 * behind at the old coordinates.
 */
export function relayoutShots(std: BlockStdScope, ids: string[]): void {
  std.store.captureSync();
  std.store.transact(() => {
    ids.forEach((id, order) => {
      const block = std.store.getBlock(id);
      if (!block) return;
      const b = shotBounds(order);
      const current = (block.model.props as { xywh: string }).xywh;
      const next = `[${b.x},${b.y},${b.w},${b.h}]`;
      if (current !== next) std.store.updateBlock(block.model, { xywh: next });
    });
  });
}

export function deleteShot(std: BlockStdScope, id: string): boolean {
  const block = std.store.getBlock(id);
  if (!block) return false;
  std.store.captureSync();
  std.store.deleteBlock(block.model);
  // Close the gap so the filmstrip stays contiguous — a hole reads as a bug,
  // and compile numbers scenes by position.
  relayoutShots(std, readShots(std).map(s => s.id));
  return true;
}

export function setShotFields(
  std: BlockStdScope,
  id: string,
  patch: Partial<Pick<ShotView,
    'title' | 'action' | 'voiceover' | 'camera' | 'model' | 'durationSec' | 'kind'
    | 'composition' | 'compositionVars'
  >>,
): boolean {
  const block = std.store.getBlock(id);
  if (!block) return false;
  std.store.captureSync();
  std.store.updateBlock(block.model, patch);
  return true;
}

/** A stable id for one reference within its shot. */
function mediaId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * THE MEDIA LIST IS EDITED IN PLACE, NEVER REPLACED.
 *
 * `updateBlock(model, { media: [...] })` looks harmless and is not: a `media`
 * prop is backed by a `Y.Array` of `Y.Map`s, so handing it a new array deletes
 * every element and re-inserts every element. Appending fifty references one at
 * a time then costs 1 + 2 + … + 50 element writes, and Yjs keeps the tombstones.
 * Measured: fifty shots holding a thousand references between them came to
 * 2.2 MB — a document that has to be read off disk and pushed to Storage on
 * every save, for a board whose actual content is a few hundred short strings.
 *
 * The reactive proxy's `splice` translates to a Y insert or delete of exactly
 * the items involved, and setting a field on an element writes that one field.
 * The same thousand references cost ~200 KB that way, and an append is O(1)
 * rather than O(n) — which is what "handles large projects" has to mean here.
 *
 * Everything below goes through this, so no caller has to know.
 */
function editMedia<T>(
  std: BlockStdScope,
  shotId: string,
  edit: (list: ShotMedia[]) => T | null,
): T | null {
  const block = std.store.getBlock(shotId);
  if (!block) return null;
  const list = (block.model.props as { media?: ShotMedia[] }).media;
  if (!list) return null;
  let result: T | null = null;
  std.store.captureSync();
  std.store.updateBlock(block.model, () => { result = edit(list) ?? null; });
  return result;
}

/**
 * Add a reference to a shot.
 *
 * Returns the new entry's id so a caller can immediately set its role or remove
 * it — the agent adds and then classifies in the same turn.
 */
export function addMedia(
  std: BlockStdScope,
  shotId: string,
  media: Omit<ShotMedia, 'id'>,
): string | null {
  const entry: ShotMedia = { ...media, id: mediaId() };
  return editMedia(std, shotId, list => {
    list.splice(list.length, 0, entry);
    return entry.id;
  });
}

export function removeMedia(std: BlockStdScope, shotId: string, id: string): boolean {
  return editMedia(std, shotId, list => {
    const at = list.findIndex(m => m.id === id);
    if (at < 0) return null;
    list.splice(at, 1);
    return true;
  }) ?? false;
}

/**
 * Say what a reference is FOR.
 *
 * A slot role is exclusive: naming a second FIRST FRAME demotes the previous one
 * to a plain reference rather than silently leaving two, because a shot with two
 * first frames is a contradiction the pipeline would have to guess about.
 */
export function setMediaRole(
  std: BlockStdScope,
  shotId: string,
  id: string,
  role: MediaRole,
): boolean {
  return editMedia(std, shotId, list => {
    const target = list.find(m => m.id === id);
    if (!target) return null;
    /**
     * ONE PER ROLE, except the two that are genuinely lists.
     *
     * This used to ask `isSlotRole`, which knows only the built-in vocabulary —
     * so a graphic could end up with two `screenshot` references and the
     * composition would silently take whichever came first. Asking the question
     * the other way round covers the block's own slot names for free: a shot
     * holds one first frame, one background, one screenshot and one backing
     * track, but any number of sound effects and parked references.
     */
    if (role !== 'reference' && role !== 'sfx') {
      list.forEach(m => { if (m.id !== id && m.role === role) m.role = 'reference'; });
    }
    target.role = role;
    return true;
  }) ?? false;
}

/**
 * Name a reference, say what it is OF, and how to use it.
 *
 * All three optional and independently settable: the agent usually learns the
 * kind first ("that's the location") and the name later, the user renames
 * something already classified, and the direction ("under the intro") arrives
 * whenever they think of it.
 */
export function tagMedia(
  std: BlockStdScope,
  shotId: string,
  id: string,
  patch: { tag?: string; refKind?: RefKind; note?: string },
): boolean {
  return editMedia(std, shotId, list => {
    const target = list.find(m => m.id === id);
    if (!target) return null;
    if (patch.tag !== undefined) {
      const clean = normaliseTag(patch.tag);
      // An empty tag REMOVES the name rather than storing '', so a reference is
      // either named or it is not — no third state to reason about.
      if (clean) target.tag = clean;
      else delete target.tag;
    }
    if (patch.refKind !== undefined) target.refKind = patch.refKind;
    if (patch.note !== undefined) {
      const clean = patch.note.trim().slice(0, 600);
      if (clean) target.note = clean;
      else delete target.note;
    }
    return true;
  }) ?? false;
}

/**
 * Set the part of a clip that IS the reference.
 *
 * CLAMPED AND ORDERED HERE, once, so nothing downstream has to wonder. An
 * out-point past the end of the media, or before the in-point, is not an error
 * worth refusing — it is a dragged handle or an agent's estimate — but it must
 * not survive into compile, where it would become a zero-length or out-of-range
 * cut nobody can see until the video comes back wrong.
 *
 * Passing `null` for either end clears it, which is how "use the whole thing"
 * is expressed. `durationSec` rides along because whatever measured the media
 * (the inspector's player, usually) is the only thing that knows it.
 */
export function trimMedia(
  std: BlockStdScope,
  shotId: string,
  id: string,
  patch: { inSec?: number | null; outSec?: number | null; durationSec?: number },
): boolean {
  return editMedia(std, shotId, list => {
    const target = list.find(m => m.id === id);
    if (!target) return null;

    if (patch.durationSec !== undefined && patch.durationSec > 0) {
      target.durationSec = Math.round(patch.durationSec * 100) / 100;
    }
    const dur = target.durationSec ?? 0;
    const round = (v: number) => Math.max(0, Math.round(v * 100) / 100);

    if (patch.inSec === null) delete target.inSec;
    else if (patch.inSec !== undefined) {
      target.inSec = dur > 0 ? Math.min(round(patch.inSec), dur) : round(patch.inSec);
    }
    if (patch.outSec === null) delete target.outSec;
    else if (patch.outSec !== undefined) {
      target.outSec = dur > 0 ? Math.min(round(patch.outSec), dur) : round(patch.outSec);
    }

    // Ordered. A window that ends before it starts is not a window, and the
    // fix a person means by dragging past the other handle is "swap them".
    if (target.inSec !== undefined && target.outSec !== undefined
        && target.outSec <= target.inSec) {
      const [a, b] = [target.outSec, target.inSec];
      target.inSec = a;
      target.outSec = b;
      if (target.outSec <= target.inSec) delete target.outSec;
    }
    // A window covering the whole media is the same as no window, and storing
    // it would make every untrimmed clip claim to be trimmed.
    if (dur > 0 && (target.inSec ?? 0) <= 0.01 && (target.outSec ?? dur) >= dur - 0.01) {
      delete target.inSec;
      delete target.outSec;
    }
    return true;
  }) ?? false;
}

/** Move a reference within its lane. Order is what a model receives as
 *  `@Image1`, `@Image2`, so it has to be something the user can change. */
export function moveMedia(std: BlockStdScope, shotId: string, id: string, delta: number): boolean {
  return editMedia(std, shotId, list => {
    const from = list.findIndex(m => m.id === id);
    if (from < 0) return null;
    const to = Math.max(0, Math.min(list.length - 1, from + delta));
    if (to === from) return null;
    // Read the plain value out before the splice: the element is a live proxy
    // and re-inserting it after its Y.Map has been deleted would insert a
    // detached one.
    const moved = { ...list[from] };
    list.splice(from, 1);
    list.splice(to, 0, moved);
    return true;
  }) ?? false;
}

/** The shot at a point in MODEL coordinates, if any. */
export function shotAtPoint(std: BlockStdScope, point: [number, number]): string | null {
  for (const shot of readShots(std)) {
    const p = propsOf(std, shot.id);
    if (!p) continue;
    const [x, y, w, h] = JSON.parse(p.xywh) as number[];
    if (point[0] >= x && point[0] <= x + w && point[1] >= y && point[1] <= y + h) return shot.id;
  }
  return null;
}

/** An index above everything on the canvas, so a new object is never buried. */
export function topIndex(std: BlockStdScope): string {
  let top: string | null = null;
  const consider = (v: unknown) => {
    if (typeof v === 'string' && v && (top === null || v > top)) top = v;
  };
  for (const block of Object.values(std.store.blocks.peek())) {
    consider((block.model.props as { index?: unknown }).index);
  }
  const surface = std.get(GfxControllerIdentifier).surface as unknown as
    | { elementModels?: Array<{ index?: unknown }> } | null;
  surface?.elementModels?.forEach(el => consider(el.index));
  return generateKeyBetween(top, null);
}
