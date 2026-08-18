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

import { perRev } from '../board/doc-cache';
import { planBoard, type BoardPlan } from './layout';
import {
  SHOT_GAP, SHOT_H, SHOT_W, normaliseTag,
  type MediaRole, type RefKind, type ShotBlockModel, type ShotKind, type ShotMedia,
  type ShotTake,
} from './model';
import { readParsed } from './screenplay-doc';

export interface ShotView {
  id: string;
  title: string;
  action: string;
  voiceover: string;
  camera: string;
  media: ShotMedia[];
  /** Every attempt this shot has produced, oldest first. */
  takes: ShotTake[];
  /** Which take IS the shot; '' when not decided (see `chosenTake`). */
  chosenTakeId: string;
  /** Does the video model make its own sound? '' = not decided (silent). */
  voiceMode: '' | 'silent' | 'dialogue';
  /** Video model id, or '' for the project default. */
  model: string;
  /** Planned seconds, or 0 for "not decided". */
  durationSec: number;
  /** Output size (`720p`); '' = follow the model. */
  resolution: string;
  /** Frame shape (`16:9`); '' = let the model decide. */
  aspect: string;
  /** 'clip' (generated) or 'graphic' (a composition). */
  kind: ShotKind;
  /** The designed block a graphic is built from; '' when not chosen. */
  composition: string;
  /** Values for that block's declared slots. */
  compositionVars: Record<string, string>;
  /** Which screenplay scene this shot covers. '' when off-script. */
  sceneKey: string;
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

/**
 * THE FILMSTRIP ORDER — the expensive half of reading the board, cached.
 *
 * ── WHAT IS CACHED, AND WHAT DELIBERATELY IS NOT ─────────────────────────────
 * The cost of `readShots` is almost entirely in getting to the shots in the
 * right order: walking the block map for a flavour, `JSON.parse`-ing every
 * `xywh`, and sorting. Building the view objects afterwards is a handful of
 * property reads each.
 *
 * So the ORDER is memoised per document revision and the VIEWS are rebuilt on
 * every call. That split is not a compromise, it is the point: a shared view
 * object would be a live handle that a caller could write into, and the next
 * reader would see the tampering as though it were document state — a worse
 * failure than the slow read, and one `shots.test.ts` pins directly.
 *
 * Measured effect on the render path: painting an n-shot strip went from n
 * flavour-scans and n·m `JSON.parse` calls per frame to one of each.
 */
interface ShotOrder {
  /** Block ids, left to right. */
  ids: string[];
  /** id → x, so a view can be built without re-parsing `xywh`. */
  x: Map<string, number>;
  /** id → position, so a scene number is a lookup rather than a scan. */
  at: Map<string, number>;
}

function shotOrder(std: BlockStdScope): ShotOrder {
  return perRev(std, 'shots:order', () => {
    const rows = std.store
      .getBlocksByFlavour('voidspace:shot')
      .map(block => {
        /**
         * `peek()`, AND IT IS THE DIFFERENCE BETWEEN O(n) AND O(n²).
         *
         * BlockSuite props are signals and its components render inside a
         * tracking scope, so reading `props.xywh` SUBSCRIBES the caller to that
         * block's position. Every shot card reads this list — it is where its
         * SHOT number comes from — so reading the positions normally subscribed
         * every card to every other card's box.
         *
         * Measured on a 189-shot board: nudging ONE card by a single pixel
         * re-rendered all 189, and one `set_scene` (which moves a whole row)
         * cost 280ms in card templates. Filing a feature's worth of shots onto
         * their scenes took 35 seconds, almost all of it re-rendering cards
         * whose own content had not changed.
         *
         * `peek` reads the same value and subscribes to nothing. Nothing is lost:
         * a card's number can only change when shots move, and `relayoutShots`
         * writes the boxes of every card that moved — so each of them re-renders
         * for its own reason, with the new order already in the cache.
         */
        const gfx = block.model as unknown as { xywh$?: { peek(): string } };
        const raw = gfx.xywh$?.peek()
          ?? (block.model.props as ShotBlockModel['props']).xywh;
        let x = 0;
        let y = 0;
        try {
          const box = JSON.parse(raw || '[0,0,0,0]') as number[];
          x = box[0] ?? 0;
          y = box[1] ?? 0;
        } catch { x = 0; y = 0; }
        return { id: block.id, x, y };
      })
      /**
       * READ THE BOARD THE WAY YOU READ A PAGE — down, then across.
       *
       * This sorted by x alone, which was right while every shot sat on one
       * horizontal strip: where a card was WAS the order it cut in, and dragging
       * one between two others reordered the film with no second hidden
       * structure to disagree with the visible one.
       *
       * The board is a grid now (see `shot/layout.ts`) — a scene is a row, a
       * sequence is a block of rows, an act is a block of sequences — so the
       * same property needs the same rule in two dimensions. Top to bottom then
       * left to right IS act ▸ sequence ▸ scene ▸ shot, by construction, because
       * that is the order the layout places them in.
       *
       * The row tolerance is not tidiness: a card mid-drag is a few pixels off
       * its row, and comparing raw `y` would flip it above or below its
       * neighbours for the length of the gesture — the compile order flickering
       * while somebody nudges a card. Half a card's height is comfortably
       * narrower than the smallest gap the layout leaves between rows.
       */
      .sort((a, b) => {
        const row = Math.abs(a.y - b.y) > SHOT_H / 2 ? a.y - b.y : 0;
        return row || a.x - b.x;
      });

    return {
      ids: rows.map(r => r.id),
      x: new Map(rows.map(r => [r.id, r.x] as const)),
      at: new Map(rows.map((r, i) => [r.id, i] as const)),
    };
  });
}

/** Build one view. Fresh every time — see the note on `shotOrder`. */
function viewOf(std: BlockStdScope, id: string, x: number): ShotView | null {
  const p = propsOf(std, id);
  if (!p) return null;
  return {
    id,
    title: p.title ?? '',
    action: p.action ?? '',
    voiceover: p.voiceover ?? '',
    camera: p.camera ?? '',
    media: p.media ?? [],
    /**
     * PLAIN DATA, copied — for the same reason `compositionVars` below is.
     *
     * These props are Yjs-backed, so the store hands back a REACTIVE PROXY, and
     * `structuredClone` refuses one. A proxy reaching `postMessage` does not
     * fail politely on the offending field: it kills the whole message, which is
     * how one stat card's variables once made `board_read` return an error for
     * the entire board.
     *
     * `media` gets away with passing the proxy through only because the RPC
     * digest happens to rebuild every entry by hand. Relying on a consumer to
     * remember that is exactly the kind of thing that is fine until the day
     * somebody adds a second consumer, so takes are flattened at the source.
     *
     * `?? []` is the other half: boards made before takes existed have no such
     * key (see the note on `ShotProps.takes`).
     */
    takes: (p.takes ?? []).map(t => ({ ...t })),
    chosenTakeId: p.chosenTakeId ?? '',
    voiceMode: (p.voiceMode as ShotView['voiceMode']) ?? '',
    model: p.model ?? '',
    durationSec: p.durationSec ?? 0,
    // `?? ''` for the same reason as `takes ?? []`: boards written before
    // these props existed have no such key, and `props()` only defaults NEW
    // blocks. Unset means 'follow the model', which is what they all did.
    resolution: p.resolution ?? '',
    aspect: p.aspect ?? '',
    // Boards written before graphic shots existed have neither prop. A shot
    // with no kind is a CLIP — that is what every one of them was.
    kind: (p.kind as ShotKind) ?? 'clip',
    composition: p.composition ?? '',
    /**
     * COPIED, not referenced.
     *
     * This prop is backed by Yjs, so what the store hands back is a REACTIVE
     * PROXY. Structured clone refuses a proxy — so the moment a shot had any
     * composition variables, every `postMessage` carrying a digest died with
     * "could not be cloned" and `board_read` returned an error for the WHOLE
     * board, not just that shot. Measured: two shots on the canvas, one stat
     * card, and the agent could no longer read anything.
     *
     * The same trap the model catalogue fell into from the other direction (a
     * Vue reactive proxy going in). Both boundaries now hand over plain data;
     * `media` was already safe because the digest rebuilds each entry.
     *
     * It is also what stops a caller writing into the document through a read —
     * pinned by `shots.test.ts`, and the reason the cache above holds the order
     * rather than these objects.
     */
    compositionVars: { ...(p.compositionVars ?? {}) },
    sceneKey: p.sceneKey ?? '',
    x,
  };
}

/** Every shot, in filmstrip order. */
export function readShots(std: BlockStdScope): ShotView[] {
  const order = shotOrder(std);
  const out: ShotView[] = [];
  for (const id of order.ids) {
    const view = viewOf(std, id, order.x.get(id) ?? 0);
    // A block deleted between the cached scan and now. Skipping is right: the
    // revision has already moved, so the next read rebuilds the order anyway.
    if (view) out.push(view);
  }
  return out;
}

/** One shot, by id. Does not build the other n-1 views. */
export function readShot(std: BlockStdScope, id: string): ShotView | null {
  const order = shotOrder(std);
  if (!order.at.has(id)) return null;
  return viewOf(std, id, order.x.get(id) ?? 0);
}

/**
 * A shot's position in the filmstrip, 1-based — its SHOT number.
 *
 * NOT a scene number, though it was called one. A scene is a place and a moment
 * in the screenplay and its number comes from the script; a shot is one set-up
 * covering part of one, and several shots routinely share a scene. The card
 * showed this as "SCENE 1" an inch from a pill showing the real screenplay
 * scene, so two controls disagreed about the same word.
 *
 * Here rather than in the card because the card computed it by scanning and
 * sorting every shot on the board on every render, which made painting the strip
 * quadratic. Off the shared order it is a map lookup.
 *
 * 0 when the id is not a shot on this board, which is what a card mid-delete
 * sees for one frame.
 */
export function shotNumberOf(std: BlockStdScope, id: string): number {
  const at = shotOrder(std).at.get(id);
  return at === undefined ? 0 : at + 1;
}

/**
 * The exact string the OLD "+ Add shot" minted, and nothing else.
 *
 * Anchored at both ends and requiring the em dash, because this is the licence
 * to rewrite somebody's title: a shot a person actually named "Scene 3 — the
 * kitchen" must not match, and neither must "SCENE 12 — untitled draft".
 */
const LEGACY_AUTO_TITLE = /^SCENE (\d+) — untitled$/;

/**
 * Bring old boards onto the naming the app now uses.
 *
 * ── WHY THIS REWRITES DATA AT ALL, WHICH IS NORMALLY WRONG ───────────────────
 * The card's badge says SHOT 1 and its title said "SCENE 1 — untitled", an inch
 * apart, with a third control beside them showing the real SCREENPLAY scene.
 * Three numbers, two of them called the same thing. Renaming the badge fixed the
 * label and left the contradiction sitting in the document — and the title is not
 * only a label: it is carried into compile, so a film built from an old board
 * still ships shots called "scene".
 *
 * That string was written BY THE APP and never by a person, which is what makes
 * it safe to change: the pattern is the old minting function's exact output. A
 * title anybody typed cannot match it.
 *
 * `withoutTransact` so it is not an undo step. There is nothing here a user did
 * and nothing they would want to undo — and a board that greeted them with a
 * pending Ctrl+Z that renames their shots back would be worse than the
 * inconsistency.
 */
export function normaliseShotTitles(std: BlockStdScope): number {
  if (std.store.readonly) return 0;
  const stale = std.store
    .getBlocksByFlavour('voidspace:shot')
    .filter(b => LEGACY_AUTO_TITLE.test((b.model.props as ShotBlockModel['props']).title ?? ''));
  if (!stale.length) return 0;

  std.store.withoutTransact(() => {
    for (const block of stale) {
      const props = block.model.props as ShotBlockModel['props'];
      const n = LEGACY_AUTO_TITLE.exec(props.title ?? '')?.[1] ?? '';
      // The number IS kept: it was the shot's place in the film, which is what
      // the badge shows and what the user has been reading it as.
      std.store.updateBlock(block.model, { title: n ? `Shot ${n}` : '' });
    }
  });
  return stale.length;
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

  /**
   * THEN PUT THEM WHERE THEY BELONG.
   *
   * `shotBounds` above is a provisional spot at the end of the last row — a new
   * shot is on no scene, so on a board with a screenplay its real home is the
   * "not on the script yet" row, which only the plan knows where to put. Placing
   * first and re-flowing second keeps the block creation in one transaction (so
   * it is one undo step) without teaching it the grid.
   */
  relayoutShots(std, readShots(std).map(s => s.id));
  return ids;
}

/**
 * Re-flow the board into the film's own shape — Acts ▸ Sequences ▸ Scenes ▸
 * Shots, one row per scene.
 *
 * ── WHAT THE `ids` ARGUMENT STILL DECIDES, AND WHAT IT NO LONGER DOES ────────
 * It used to decide everything: position was `order * pitch` along one line, so
 * the array WAS the film. Now it decides the order WITHIN a scene and nothing
 * else — which row a shot lands in comes from the scene it says it covers, and
 * that is the user's own statement (the pill on the card), not something to be
 * inferred from where they happened to drag it.
 *
 * That split is the whole point. Dragging a card sideways past its neighbour
 * still re-cuts the film, exactly as before. Dragging it into a different
 * scene's row is a different act with a different meaning, and `reflow.ts` is
 * where it becomes one.
 *
 * Order is still the ARGUMENT and never the current geometry: a user dragging a
 * panel aside to look at it must not silently re-cut their film. And because a
 * shot owns its media, moving one moves everything in it — there is nothing left
 * behind at the old coordinates.
 */
export function relayoutShots(std: BlockStdScope, ids: string[]): void {
  const rank = new Map(ids.map((id, i) => [id, i] as const));
  const plan = planBoard(readParsed(std), ids.flatMap(id => {
    const p = propsOf(std, id);
    if (!p) return [];
    // `rank` and not the stored x: the caller's order is the intent, and the
    // geometry it is about to be given has not been written yet.
    return [{ id, sceneKey: p.sceneKey ?? '', x: rank.get(id) ?? 0 }];
  }));

  std.store.captureSync();
  std.store.transact(() => {
    for (const [id, b] of plan.place) {
      const block = std.store.getBlock(id);
      if (!block) continue;
      const current = (block.model.props as { xywh: string }).xywh;
      const next = `[${b.x},${b.y},${b.w},${b.h}]`;
      if (current !== next) std.store.updateBlock(block.model, { xywh: next });
    }
  });
}

/**
 * The board's current shape, for anything that DRAWS it.
 *
 * Memoised per document revision like the order is, and for the same reason: the
 * bracket overlay repaints on every viewport change, and re-parsing the
 * screenplay sixty times a second to find out where act two starts is not a
 * thing to do on a pan.
 */
export function boardPlan(std: BlockStdScope): BoardPlan {
  return perRev(std, 'shots:plan', () =>
    planBoard(readParsed(std), readShots(std).map(s => ({
      id: s.id, sceneKey: s.sceneKey, x: s.x,
    }))));
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
    | 'voiceMode'
    | 'composition' | 'compositionVars' | 'sceneKey'
  >>,
): boolean {
  const block = std.store.getBlock(id);
  if (!block) return false;

  /**
   * PUTTING A SHOT ON A SCENE MOVES IT, because a scene IS a row.
   *
   * Everything else here is content — the title, the prompt, the model — and
   * changes nothing about where the card sits. `sceneKey` is structural: it is
   * the shot's own statement about which part of the film it covers, and the
   * board draws that statement as a position (`shot/layout.ts`). Writing it
   * without re-flowing leaves a card sitting under one scene's bracket while
   * claiming another, which is the exact contradiction the grid exists to make
   * impossible.
   */
  const moved = 'sceneKey' in patch
    && (patch.sceneKey ?? '') !== ((block.model.props as { sceneKey?: string }).sceneKey ?? '');

  std.store.captureSync();
  std.store.updateBlock(block.model, patch);
  if (moved) relayoutShots(std, readShots(std).map(s => s.id));
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
 * THE TAKES LIST, edited in place — and BACKFILLED IF IT IS MISSING.
 *
 * Same in-place discipline as `editMedia` above, for the same Yjs reasons. The
 * extra job here is the one that would otherwise bite silently:
 *
 * `takes` did not exist when most boards were made. A BlockSuite schema's
 * `props()` supplies defaults when a block is CREATED; it does not reach back
 * into documents already on disk. So on any older board `props.takes` is
 * `undefined`, and an `editMedia`-shaped helper — which bails on a missing list
 * — would return null forever. Pressing Generate would do nothing at all, with
 * no error, on exactly the boards a real user already has work in.
 *
 * So a missing list is CREATED rather than refused. One write, once per shot,
 * and every board is on the same footing afterwards.
 */
function editTakes<T>(
  std: BlockStdScope,
  shotId: string,
  edit: (list: ShotTake[]) => T | null,
): T | null {
  const block = std.store.getBlock(shotId);
  if (!block) return null;
  const props = block.model.props as { takes?: ShotTake[] };
  std.store.captureSync();
  if (!props.takes) {
    // Seed the key, then re-read: the reactive proxy hands back the live
    // Y-backed array only after the prop exists.
    std.store.updateBlock(block.model, { takes: [] });
  }
  const list = (block.model.props as { takes?: ShotTake[] }).takes;
  if (!list) return null;
  let result: T | null = null;
  std.store.updateBlock(block.model, () => { result = edit(list) ?? null; });
  return result;
}

/**
 * Record an attempt at this shot.
 *
 * APPENDS. There is deliberately no "replace the take" — that is the invariant
 * that makes trying again free and makes the board safe to point an agent at.
 * Returns the new take's id so a caller can update its status when the job
 * finishes, or choose it immediately.
 */
export function addTake(
  std: BlockStdScope,
  shotId: string,
  take: Omit<ShotTake, 'id'>,
): string | null {
  const entry: ShotTake = { ...take, id: mediaId() };
  return editTakes(std, shotId, list => {
    list.splice(list.length, 0, entry);
    return entry.id;
  });
}

/**
 * Update a take in flight — status, the url it resolved to, what it cost.
 *
 * Field-by-field rather than by replacement, so Yjs writes only what changed
 * and a concurrent edit to a different field of the same take survives.
 */
export function updateTake(
  std: BlockStdScope,
  shotId: string,
  takeId: string,
  patch: Partial<Omit<ShotTake, 'id'>>,
): boolean {
  return editTakes(std, shotId, list => {
    const target = list.find(t => t.id === takeId);
    if (!target) return null;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      (target as unknown as Record<string, unknown>)[k] = v;
    }
    return true;
  }) ?? false;
}

/**
 * Say which take IS the shot.
 *
 * Writes a POINTER on the shot rather than a flag on the take, so there is
 * exactly one place that knows and nothing to keep in step. Refuses a take that
 * is not ready: choosing something still generating would put a url that does
 * not exist yet onto the timeline.
 */
export function chooseTake(std: BlockStdScope, shotId: string, takeId: string): boolean {
  const block = std.store.getBlock(shotId);
  if (!block) return false;
  const props = block.model.props as { takes?: ShotTake[]; chosenTakeId?: string };
  const target = (props.takes ?? []).find(t => t.id === takeId);
  if (!target || target.status !== 'ready') return false;
  if (props.chosenTakeId === takeId) return true;
  std.store.captureSync();
  std.store.updateBlock(block.model, { chosenTakeId: takeId });
  return true;
}

/**
 * Discard a take.
 *
 * Removing the CHOSEN one clears the pointer rather than silently promoting a
 * neighbour: `chosenTake()` then falls back to the newest ready take, which is
 * a rule the user can predict, where "the one next to it" is not.
 *
 * The Library item is untouched. A take already cut into a film must keep
 * playing, and this is only saying it is no longer a candidate here.
 */
export function removeTake(std: BlockStdScope, shotId: string, takeId: string): boolean {
  const done = editTakes(std, shotId, list => {
    const at = list.findIndex(t => t.id === takeId);
    if (at < 0) return null;
    list.splice(at, 1);
    return true;
  }) ?? false;
  if (!done) return false;
  const block = std.store.getBlock(shotId);
  const props = block?.model.props as { chosenTakeId?: string } | undefined;
  if (block && props?.chosenTakeId === takeId) {
    std.store.updateBlock(block.model, { chosenTakeId: '' });
  }
  return true;
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

/**
 * The shot at a point in MODEL coordinates, if any.
 *
 * ── THIS RUNS ON EVERY POINTERMOVE OF EVERY DRAG ─────────────────────────────
 * `canvas-drop.ts` asks it for each move so the shot under the pointer can light
 * up, which puts it squarely on the frame budget of a gesture.
 *
 * It used to walk `readShots`, and that was the wrong tool twice over. It builds
 * a full view of every shot — copying each one's takes and composition
 * variables — to read four numbers off each. Worse, `shotOrder`'s cache is keyed
 * on the DOCUMENT REVISION, and a drag moves a block, so every move invalidated
 * it: the flavour scan, the `JSON.parse` of every `xywh` and the sort all ran
 * again, per move, and then n view objects were allocated and thrown away. On a
 * board of twenty shots that is the judder in "dragging media is glitchy".
 *
 * Reading the blocks directly costs one parse per shot and allocates nothing.
 */
export function shotAtPoint(std: BlockStdScope, point: [number, number]): string | null {
  const [px, py] = point;
  for (const block of std.store.getBlocksByFlavour('voidspace:shot')) {
    const raw = (block.model.props as ShotBlockModel['props']).xywh;
    if (!raw) continue;
    let box: number[];
    try { box = JSON.parse(raw) as number[]; } catch { continue; }
    const [x, y, w, h] = box;
    if (px >= x && px <= x + w && py >= y && py <= y + h) return block.id;
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
