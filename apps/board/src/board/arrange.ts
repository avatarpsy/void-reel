/**
 * TIDYING UP — the verb the agent did not have.
 *
 * ── WHY THIS IS A TOOL AND NOT A PROMPT INSTRUCTION ──────────────────────────
 * The board's own prompt describes the brainstorm as two halves: "get it out fast
 * and messy, THEN give it shape… when it slows down, cluster what is there into
 * frames". The second half had no tool behind it. The only way to tidy was
 * `board_edit_canvas` with a `move` op per element, at coordinates the agent had
 * to compute — and `relaxOverlaps`'s own comments prove that is impossible from
 * where the agent stands:
 *
 *   a NOTE grows to fit its text (measured: 150×100 asked for, 150×284 made)
 *   a MIND MAP lays itself out; its bounds are whatever the tree needs
 *
 * So the sizes an arrangement depends on are not knowable when the call is
 * written. They ARE knowable here, after the fact, in the client, off the real
 * boxes. That asymmetry is the whole argument for this file: layout is a
 * measurement problem, and only one side of the bridge can measure.
 *
 * ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────
 * It never touches an `owned` block. The filmstrip's order IS the compile order
 * (`readShots` sorts by x), so a generic "tidy" that moved shot cards would
 * silently renumber the film — the single most expensive thing a tidy could do.
 * Those have their own verbs and this refuses them by name.
 */
import { GfxControllerIdentifier, type GfxModel } from '@blocksuite/std/gfx';
import { EdgelessCRUDIdentifier } from '@blocksuite/affine/blocks/surface';
import type { BlockStdScope } from '@blocksuite/std';
import { Text } from '@blocksuite/store';

import { adoptIntoFrame } from './canvas';
import { readBlockMeta } from './board-meta';
import { CARD_GAP } from './metrics';
import { boardPlan } from '../shot/shots';
import {
  type Box, OWNED_FLAVOURS, ROW_MAX_W, bboxOf, boundsOf, flow, isLayoutInert,
  reserveFlow, thinkingOrigin,
} from './space';

export type ArrangeAs = 'row' | 'column' | 'grid' | 'tidy';

export interface ArrangeRequest {
  /** What to arrange. Empty means everything loose the agent is allowed to move. */
  ids?: string[];
  /**
   * Arrange the references that say they are ABOUT this scene, and line them up
   * beside that scene's own row.
   *
   * The answer to "what have we got for scene 3, and can you tidy it" without the
   * agent keeping its own list of which picture belongs where — the blocks say so
   * themselves (`BlockMeta.sceneKey`). Combines with `ids`: named ids win.
   */
  sceneKey?: string;
  as?: ArrangeAs;
  /** Wrap the result in a titled frame, which then OWNS what is inside it. */
  frame?: string;
  /** Keep the arrangement where it already is rather than moving it to the
   *  thinking region. The right answer when the user asked to tidy something
   *  they are looking at. */
  inPlace?: boolean;
}

export interface ArrangeResult {
  moved: number;
  frameId?: string;
  problems: string[];
}

/** An element this may move: on the canvas, not owned, not positioned by a parent. */
interface Movable {
  id: string;
  model: GfxModel;
  box: Box;
}

function movables(std: BlockStdScope, ids?: string[]): {
  items: Movable[];
  problems: string[];
} {
  const gfx = std.get(GfxControllerIdentifier);
  const wanted = ids?.length ? new Set(ids) : null;
  const items: Movable[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const model of gfx.gfxElements as GfxModel[]) {
    const id = (model as unknown as { id?: string }).id;
    if (!id) continue;
    if (wanted && !wanted.has(id)) continue;
    seen.add(id);

    const flavour = (model as unknown as { flavour?: string }).flavour;
    if (flavour && OWNED_FLAVOURS.has(flavour)) {
      // Named rather than skipped: an agent that asked to tidy the board and got
      // a silent partial result will ask again.
      if (wanted) {
        problems.push(
          `${id} is part of the storyboard, so arranging it would renumber the film. `
          + 'Use board_reorder_shots for that.',
        );
      }
      continue;
    }
    /**
     * FRAMES AND CONNECTORS ARE NOT ARRANGED, they FOLLOW.
     *
     * A frame is a container that is supposed to sit under its contents, and a
     * connector has no position of its own — it is redrawn from its endpoints, so
     * moving the boxes it joins moves the arrow for free.
     */
    if (isLayoutInert(model)) continue;

    const box = boundsOf(model);
    if (!box || !box.w || !box.h) continue;
    items.push({ id, model, box });
  }

  for (const id of wanted ?? []) {
    if (!seen.has(id)) problems.push(`Nothing on the canvas with id ${id}.`);
  }
  return { items, problems };
}

/**
 * READING ORDER, which is the order the user's eye already uses.
 *
 * Top to bottom, then left to right — the same order `board_document` reads a
 * board in, and the same order `readCanvas` reports. Banded by row so that two
 * cards a few pixels apart vertically are not swapped by a rounding difference.
 */
function readingOrder(items: Movable[]): Movable[] {
  const BAND = 120;
  return [...items].sort((a, b) => {
    const rowA = Math.round(a.box.y / BAND);
    const rowB = Math.round(b.box.y / BAND);
    return rowA === rowB ? a.box.x - b.box.x : rowA - rowB;
  });
}

/**
 * The row width that produces the requested shape.
 *
 * `column` is 1 rather than 0 on purpose: `flow` places the first card before it
 * can wrap (`cursorX > at.x` is false), so a one-pixel budget yields exactly one
 * card per row — a column, with no second code path to keep in step.
 */
function rowWidthFor(as: ArrangeAs): number {
  if (as === 'row') return Number.MAX_SAFE_INTEGER;
  if (as === 'column') return 1;
  // grid / tidy: a block roughly three shot cards wide, so a cluster reads as a
  // block beside the film rather than a line across the board.
  return ROW_MAX_W;
}

/** Loose canvas blocks that say they are about this scene. */
function sceneScoped(std: BlockStdScope, sceneKey: string): string[] {
  const doc = std.store.doc.spaceDoc;
  const gfx = std.get(GfxControllerIdentifier);
  const out: string[] = [];
  for (const model of gfx.gfxElements as GfxModel[]) {
    const id = (model as unknown as { id?: string }).id;
    if (!id) continue;
    if (readBlockMeta(doc, id)?.sceneKey === sceneKey) out.push(id);
  }
  return out;
}

/** The y of a scene's row on the board, or null when it has none. */
function sceneRowY(std: BlockStdScope, sceneKey: string): number | null {
  const row = boardPlan(std).rows.find(r => r.sceneKey === sceneKey);
  return row ? row.y : null;
}

/**
 * Arrange, and optionally frame.
 *
 * ONE TRANSACTION, so a tidy is ONE Ctrl+Z. A tidy the user cannot undo in a
 * single gesture is worse than a mess, because the mess was at least theirs.
 */
export function arrangeCanvas(std: BlockStdScope, req: ArrangeRequest): ArrangeResult {
  const gfx = std.get(GfxControllerIdentifier);
  const crud = std.get(EdgelessCRUDIdentifier);
  if (!gfx.surface) return { moved: 0, problems: ['The canvas is not ready yet.'] };
  if (std.store.readonly) {
    return { moved: 0, problems: ['This board is open read-only.'] };
  }

  const as: ArrangeAs = req.as ?? 'tidy';
  /**
   * A SCENE'S OWN REFERENCES, when a scene was named and no ids were.
   *
   * Read off the blocks rather than taken from the caller: the agent does not have
   * to remember which of thirty pictures was for which scene, because each one
   * already says.
   */
  let ids = req.ids?.length ? req.ids : undefined;
  if (!ids && req.sceneKey) {
    ids = sceneScoped(std, req.sceneKey);
    /**
     * AN EMPTY SCOPE MUST REFUSE, NOT FALL BACK.
     *
     * `movables` treats an empty id list as "everything", which is right for a
     * bare tidy and catastrophic here: asking for one scene's references and
     * getting the WHOLE BOARD rearranged is the opposite of what was asked, and
     * the user would have no idea why their layout moved. Caught by a test that
     * exists for exactly this.
     */
    if (!ids.length) {
      return {
        moved: 0,
        problems: [
          `Nothing on the canvas says it is about ${req.sceneKey}. Place references with `
          + 'that sceneKey, or name the ids you mean.',
        ],
      };
    }
  }

  const found = movables(std, ids);
  const problems = [...found.problems];
  const items = readingOrder(found.items);

  if (!items.length) {
    problems.push('Nothing on the canvas could be arranged.');
    return { moved: 0, problems };
  }

  const sizes = items.map(i => ({ w: i.box.w, h: i.box.h }));
  const maxRowW = rowWidthFor(as);

  /**
   * IN PLACE means "keep this cluster where the user is looking at it" — so the
   * batch's own current top-left is the origin, and only its internal spacing
   * changes. `exclude` is the batch itself, or every member would be an obstacle
   * to itself and the whole cluster would slide down the board.
   */
  const current = bboxOf(items.map(i => i.box))!;
  /**
   * A SCENE'S REFERENCES LINE UP WITH THAT SCENE'S ROW.
   *
   * Same x as everything else in the thinking area — left of the script, out of
   * the grid's way — but at the row's own y, so scene 3's mood board sits beside
   * scene 3. That is the whole point of scoping: the board reads as the film with
   * its thinking alongside it, rather than as a film and a separate pile.
   *
   * Falls through to ordinary placement when the scene has no row yet (it is not
   * in the screenplay, or the slugline was rewritten) — a wrong row would be worse
   * than none.
   */
  const rowY = req.sceneKey ? sceneRowY(std, req.sceneKey) : null;

  const slots = req.inPlace
    ? reserveFlow(std, sizes, {
        at: { x: current.x, y: current.y },
        exclude: items.map(i => i.id),
        maxRowW,
      })
    : rowY !== null
      ? reserveFlow(std, sizes, {
          at: { ...thinkingOrigin(std, bboxOf(flow(sizes, { x: 0, y: 0 }, { maxRowW }))!.w), y: rowY },
          exclude: items.map(i => i.id),
          maxRowW,
        })
      : reserveFlow(std, sizes, { exclude: items.map(i => i.id), maxRowW });

  let moved = 0;
  std.store.captureSync();
  std.store.transact(() => {
    items.forEach((item, i) => {
      const slot = slots[i];
      if (!slot) return;
      if (slot.x === item.box.x && slot.y === item.box.y) return;
      try {
        writeBox(std, crud, item, slot);
        moved++;
      } catch (err) {
        problems.push(`${item.id}: ${(err as Error)?.message ?? String(err)}`);
      }
    });
  });

  let frameId: string | undefined;
  if (req.frame !== undefined) {
    const placed = items.map((item, i) => slots[i] ?? item.box);
    frameId = makeFrame(std, crud, req.frame, placed, items.map(i => i.id)) ?? undefined;
    if (!frameId) problems.push('The frame could not be created.');
  }

  return { moved, frameId, problems };
}

/**
 * Write one element's new box.
 *
 * A GROUP (a mind map) has an EMPTY `xywh` setter — its bounds are derived from
 * its children — so it is moved by translating `childElements`, which is what
 * BlockSuite's own drag does. Everything else takes the box directly; width and
 * height are preserved exactly, because arranging is about position and an
 * arrangement that also resized things would be a different, unasked-for edit.
 */
interface ElementWriter {
  updateElement(id: string, props: Record<string, unknown>): void;
}

function writeBox(
  std: BlockStdScope,
  crud: ElementWriter,
  item: Movable,
  slot: Box,
): void {
  const dx = slot.x - item.box.x;
  const dy = slot.y - item.box.y;
  const kids = (item.model as unknown as { childElements?: GfxModel[] }).childElements;

  if (Array.isArray(kids) && kids.length) {
    for (const kid of kids) {
      const b = boundsOf(kid);
      if (!b) continue;
      const id = (kid as unknown as { id: string }).id;
      writeXywh(std, crud, id, { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h });
    }
    return;
  }
  writeXywh(std, crud, item.id, { x: slot.x, y: slot.y, w: item.box.w, h: item.box.h });
}

function writeXywh(
  std: BlockStdScope,
  crud: ElementWriter,
  id: string,
  box: Box,
): void {
  const xywh = `[${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.w)},${Math.round(box.h)}]`;
  const surface = std.get(GfxControllerIdentifier).surface;
  if (surface?.getElementById(id)) {
    crud.updateElement(id, { xywh });
    return;
  }
  const block = std.store.getBlock(id);
  if (block) std.store.updateBlock(block.model, { xywh });
}

/**
 * A TITLED FRAME AROUND THE RESULT, and it OWNS what is inside it.
 *
 * `childElementIds` is the difference between a section and a rectangle that
 * happens to be behind some notes. `FrameBlockModel` supports membership
 * (`addChild`), and the board never set it — so every frame the agent drew was
 * decorative: the user dragged the section and the notes stayed where they were.
 *
 * `board_document` reads sections by geometric containment, which is why the
 * export kept working and the gap stayed invisible. Membership is what makes the
 * frame behave like the thing it looks like.
 */
function makeFrame(
  std: BlockStdScope,
  crud: { addBlock(flavour: string, props: Record<string, unknown>, parent: string): string | null },
  title: string,
  boxes: Box[],
  memberIds: string[],
): string | null {
  const gfx = std.get(GfxControllerIdentifier);
  const surface = gfx.surface;
  if (!surface) return null;

  const bounds = bboxOf(boxes);
  if (!bounds) return null;

  // Room for the frame's own title bar, which is drawn ABOVE its box.
  const PAD = CARD_GAP;
  const TITLE_H = 48;
  const box: Box = {
    x: bounds.x - PAD,
    y: bounds.y - PAD - TITLE_H,
    w: bounds.w + PAD * 2,
    h: bounds.h + PAD * 2 + TITLE_H,
  };

  let id: string | null = null;
  std.store.transact(() => {
    id = crud.addBlock(
      'affine:frame',
      {
        xywh: `[${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.w)},${Math.round(box.h)}]`,
        title: new Text(title || 'Section'),
      },
      surface.id,
    );
  });

  /**
   * ADOPTION AFTER THE TRANSACTION, never inside it.
   *
   * `store.getBlock(id)` returns UNDEFINED for a block created in a transaction
   * that is still open — models are materialised by a store observer, so the id is
   * real and the model is not there yet. Doing this inside the transact created
   * the frame and adopted nothing, silently.
   *
   * No `captureSync()` here or above: the frame and its membership merge into the
   * undo unit the arrangement already opened, so a tidy-and-frame is still one
   * Ctrl+Z.
   */
  if (id) adoptIntoFrame(std, id, memberIds);
  return id;
}

/** Exported for the tests: the shape a request produces, without a document. */
export function planArrangement(
  sizes: ReadonlyArray<{ w: number; h: number }>,
  as: ArrangeAs,
  at: { x: number; y: number } = { x: 0, y: 0 },
): Box[] {
  return flow(sizes, at, { maxRowW: rowWidthFor(as) });
}
