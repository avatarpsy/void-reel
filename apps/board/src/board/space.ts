/**
 * WHERE THERE IS ROOM. Every write asks; nothing assumes.
 *
 * ── THE BUG THIS EXISTS TO CLOSE ─────────────────────────────────────────────
 * The board's system prompt tells the agent "LAYOUT IS THE BOARD'S JOB. Place
 * things roughly and let it resolve overlaps." That was true for ONE write path
 * out of four. `clearOfOwned` and `relaxOverlaps` are called from
 * `drawOnCanvas` and nowhere else, so `board_place_media` and
 * `board_generate_media` — the two that put PICTURES on the board — had no
 * collision handling of any kind. What they had instead was a fixed point:
 *
 *     { x: 0, y: SHOT_H + 240 }        // = (0, 1260)
 *
 * Measured against the real grid, scene row 1 is y 0–1020 and scene row 2 is
 * y 1076–2096, and x 0–360 is the `GUTTER` the spine draws its act and sequence
 * brackets into. So a placement with no reference to anchor to landed on top of
 * scene 2 AND inside the spine gutter — and because the point was fixed, every
 * subsequent placement landed on the previous one as well. That is the whole of
 * the "it overlaps things on the board" report.
 *
 * ── WHY THE PRIMITIVES MOVED HERE ────────────────────────────────────────────
 * `Box`, `overlaps`, `boundsOf` and `isLayoutInert` were private to `canvas.ts`,
 * which is precisely why only `canvas.ts` could do layout. They are geometry, not
 * drawing. Moving them makes the allocator reachable from the media paths without
 * a second implementation — and a second implementation of "do these two
 * rectangles intersect" is how the padded-overlap staircase bug got written the
 * first time.
 *
 * Imports go ONE WAY: `canvas.ts` → `space.ts`. Nothing here may import from
 * `canvas.ts`, or the module cycle takes the editor down on boot.
 *
 * ── THE RULES, CARRIED FORWARD VERBATIM ──────────────────────────────────────
 * These were learned the hard way against real agent output and re-breaking them
 * is the obvious failure mode. They are not preferences.
 *
 *  1. PUSH DOWN, NEVER SIDEWAYS. Horizontal position carries the meaning — a
 *     timeline, a comparison, a left-to-right order. Vertical space is free and
 *     infinite. Nothing is ever moved UP either: above is where the user's own
 *     earlier work tends to be.
 *  2. DETECT TRUE OVERLAP, NEVER A PADDED ONE. Adding tolerance to the test
 *     turned a deliberate nine-month row into a staircase, which is worse than
 *     the overlap because a staircase looks like a decision. Padding is added
 *     only when something is actually moved.
 *  3. THE BATCH MOVES AS ONE. Its internal geometry IS the design — a title over
 *     two columns, a row read left to right. Every member shifts by the same dy.
 *  4. A GROUP CANNOT BE MOVED BY WRITING `xywh` — `GfxGroupLikeElementModel`
 *     defines an empty setter and derives its bounds from its children.
 *  5. FRAMES AND CONNECTORS ARE INERT. A frame is supposed to sit under its
 *     contents; a connector has no position of its own.
 */
import { GfxControllerIdentifier, type GfxModel } from '@blocksuite/std/gfx';
import type { BlockStdScope } from '@blocksuite/std';

import { CARD_GAP, type Size } from './metrics';
import { SCREENPLAY_GUTTER, SCREENPLAY_W } from '../shot/screenplay-doc';

export interface Box { x: number; y: number; w: number; h: number }

/**
 * Blocks the board owns and manages elsewhere — the storyboard's own furniture.
 *
 * Lives here rather than in `canvas.ts` because both the reader and the allocator
 * need it and the allocator may not import the reader. Reported as ANCHORS (so an
 * arrow can point at a shot) but never as canvas furniture to be moved.
 */
export const OWNED_FLAVOURS = new Set([
  'voidspace:shot',
  'voidspace:screenplay',
  'voidspace:blockdraft',
]);

/**
 * Clearance kept around the board's own blocks, for the spine's marks.
 *
 * The spine — acts, sequences, scene brackets — is an SVG overlay drawn in model
 * space (`ui/spine.ts`), deliberately, because a bracket is a statement ABOUT the
 * board rather than a thing on it. So it appears in NO read and no layout pass
 * can see it. Its labels sit in the gutter around the strip, which is exactly
 * where a batch aimed near the strip ends up. This is the only defence.
 */
export const SPINE_MARGIN = 160;

/** Breathing room added when something IS moved. Never used for detection. */
export const PUSH_GAP = 32;

/** How wide a flowed batch may get before it wraps. Roughly three shot cards, so
 *  a mood board reads as a block beside the film rather than a line across it. */
export const ROW_MAX_W = 2088;

export function boundsOf(model: unknown): Box | null {
  const raw = (model as { xywh?: string })?.xywh;
  if (typeof raw !== 'string') return null;
  try {
    const [x, y, w, h] = JSON.parse(raw) as number[];
    return { x, y, w, h };
  } catch {
    return null;
  }
}

/**
 * TRUE GEOMETRIC OVERLAP, with no tolerance — and the tolerance is exactly what
 * made this dangerous.
 *
 * The first version tested with the same 40px padding it used when separating
 * things, so two elements merely CLOSE to each other counted as a collision. On
 * a real journal timeline the notes were 150 wide under shapes 130 wide at 168px
 * intervals, leaving 28px between a note and the next month's shape — under the
 * threshold. Every second month was shunted down and a deliberate row became a
 * staircase.
 */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w
    && a.x + a.w > b.x
    && a.y < b.y + b.h
    && a.y + a.h > b.y;
}

/** Elements that must never be moved, and never push anything. */
export function isLayoutInert(model: unknown): boolean {
  const m = model as { flavour?: string; type?: string; group?: unknown };
  // A FRAME is a container — it is SUPPOSED to sit under its contents, and
  // treating that as a collision would launch every framed board into space.
  if (m.flavour === 'affine:frame') return true;
  // A CONNECTOR has no position of its own; it follows its endpoints.
  if (m.type === 'connector') return true;
  // Anything inside a group (a mind map's nodes) is positioned BY the group.
  if (m.group) return true;
  return false;
}

/** The union of two boxes. */
function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

export function bboxOf(boxes: readonly Box[]): Box | null {
  return boxes.length ? boxes.reduce((acc, b) => union(acc, b)) : null;
}

/**
 * EVERYTHING THAT IS IN THE WAY.
 *
 * Owned blocks are included and then GROWN by `SPINE_MARGIN`, because the strip's
 * real footprint is bigger than its cards — the brackets and scene labels are
 * drawn beside it and are invisible to every read.
 *
 * `exclude` is not an optimisation. By the time a batch of media is arranged, its
 * blocks already exist on the canvas (the insert helpers created them in order to
 * size them from the real files), so without it every card would be an obstacle
 * to itself and the batch would march down the board for ever.
 */
export function occupancy(
  std: BlockStdScope,
  opts: { exclude?: Iterable<string> } = {},
): Box[] {
  const gfx = std.get(GfxControllerIdentifier);
  const skip = new Set(opts.exclude ?? []);
  const out: Box[] = [];

  for (const model of gfx.gfxElements as GfxModel[]) {
    const id = (model as unknown as { id?: string }).id;
    if (id && skip.has(id)) continue;
    if (isLayoutInert(model)) continue;
    const box = boundsOf(model);
    if (!box || !box.w || !box.h) continue;

    const flavour = (model as unknown as { flavour?: string }).flavour;
    out.push(flavour && OWNED_FLAVOURS.has(flavour) ? grow(box, SPINE_MARGIN) : box);
  }
  return out;
}

function grow(box: Box, by: number): Box {
  return { x: box.x - by, y: box.y - by, w: box.w + by * 2, h: box.h + by * 2 };
}

/**
 * The band the board's own blocks occupy, with room for the spine.
 *
 * One box rather than many: a batch has to clear the WHOLE storyboard, and
 * clearing it card by card would drop a batch into a gap between two scene rows
 * where the brackets are.
 */
export function ownedBand(std: BlockStdScope): Box | null {
  const gfx = std.get(GfxControllerIdentifier);
  let band: Box | null = null;
  for (const model of gfx.gfxElements as GfxModel[]) {
    const flavour = (model as unknown as { flavour?: string }).flavour;
    if (!flavour || !OWNED_FLAVOURS.has(flavour)) continue;
    const box = boundsOf(model);
    if (!box) continue;
    band = band ? union(band, box) : { ...box };
  }
  return band ? grow(band, SPINE_MARGIN) : null;
}

/**
 * ── THE THINKING REGION: x < 0, AND THAT IS A DECISION ───────────────────────
 *
 * Coordinate-less work used to go BELOW everything on the board. That is not a
 * region, it is a high-water mark, and it collides by construction:
 *
 *   the STORYBOARD grows DOWN  — `planBoard` inserts a scene row per scene, up to
 *                                SHOT_H + ACT_GAP = 1320px each
 *   the FILMSTRIP grows RIGHT  — one column per shot covering a scene, for ever
 *
 * So anything placed below the strip is in the path of the next scene, and
 * anything placed to its right is in the path of the next shot. Writing one more
 * scene re-created the overlap that had just been cleaned up, and no per-call
 * layout pass can prevent that — the collision is created later, by ordinary
 * work, in a write this module never sees.
 *
 * The only half-plane neither of those two can ever reach is x < 0. Thinking
 * lives there, growing downward, permanently out of the storyboard's way. Reading
 * order also improves — thinking, then the script, then the shots, which is the
 * order the work actually happens in.
 *
 * BUT x < 0 IS NOT EMPTY, and assuming it was is a mistake this made once. The
 * SCREENPLAY panel is placed at `-(SCREENPLAY_W + gutter)` — it reads before shot
 * 1, in the direction the board is laid out — so the band immediately left of the
 * origin is the script's. A `THINKING_EDGE` of `-CARD_GAP` put thinking on top of
 * it; the allocator then did its job and pushed every batch down below the
 * screenplay instead, which is not wrong but loses the alignment that makes a
 * scene's references sit beside that scene's row. The edge is therefore derived
 * from the screenplay's own geometry rather than guessed, so it cannot drift if
 * the panel is ever resized or moved.
 *
 * REJECTED: a band to the far right of the widest row. The strip grows into it by
 * definition, so it re-creates the same bug on a longer fuse.
 *
 * THE ONE COST, stated plainly: on a board that already has agent work below the
 * strip, new work now appears to the LEFT of it rather than under it. That is a
 * one-time discontinuity against a permanent class of collision. `THINKING_EDGE`
 * is the only knob — set it to a large positive number to put the region back
 * under the board.
 */
export const THINKING_EDGE = -(SCREENPLAY_W + SCREENPLAY_GUTTER + SPINE_MARGIN);

/**
 * Where the next batch of thinking goes.
 *
 * RIGHT-ALIGNED against `THINKING_EDGE`, which is why the batch's own width is an
 * argument. A fixed left edge for a region wide enough to hold a six-card mood
 * board would strand a single note two thousand pixels away from the board it is
 * about; hugging the edge instead means one note lands beside the spine and a
 * wide batch extends leftwards from the same boundary.
 *
 * `y` counts from the top of the REGION, not from the bottom of the board —
 * otherwise the region would march downward every time a scene was added, which
 * is the behaviour this exists to stop.
 */
export function thinkingOrigin(
  std: BlockStdScope,
  batchWidth = 0,
): { x: number; y: number } {
  const gfx = std.get(GfxControllerIdentifier);
  let bottom = 0;

  for (const model of gfx.gfxElements as GfxModel[]) {
    const box = boundsOf(model);
    if (!box) continue;
    // In the region only: anything reaching x >= 0 belongs to the board's side.
    if (box.x + box.w > THINKING_EDGE) continue;
    bottom = Math.max(bottom, box.y + box.h + CARD_GAP);
  }
  return { x: THINKING_EDGE - Math.max(batchWidth, 0), y: bottom };
}

/**
 * A FLOW, NOT A GRID — and the difference is what fixed a real overlap.
 *
 * The media path used a fixed 340px pitch decided BEFORE anything was placed. An
 * image card is sized from the real picture, so a row of references was laid out
 * on a pitch smaller than the cards themselves: measured, two 780px-wide
 * references at x=0 and x=340, overlapping by 440px. Sizes are not knowable until
 * the media has been read, so positions are decided from the boxes that actually
 * exist.
 *
 * Left to right, wrapping when the row would exceed `maxRowW`, each row as tall
 * as its tallest card. Reading order is preserved, which is what makes "these
 * four, in this order" mean anything to the person looking at them.
 *
 * Pure, so the tests drive it directly rather than through a canvas.
 */
export function flow(
  sizes: readonly Size[],
  at: { x: number; y: number },
  opts: { gap?: number; maxRowW?: number } = {},
): Box[] {
  const gap = opts.gap ?? CARD_GAP;
  const maxRowW = opts.maxRowW ?? ROW_MAX_W;

  const out: Box[] = [];
  let cursorX = at.x;
  let rowY = at.y;
  let rowH = 0;

  for (const size of sizes) {
    // Wrap BEFORE placing, so a card never starts beyond the row's width.
    if (cursorX > at.x && cursorX + size.w > at.x + maxRowW) {
      cursorX = at.x;
      rowY += rowH + gap;
      rowH = 0;
    }
    out.push({ x: cursorX, y: rowY, w: size.w, h: size.h });
    cursorX += size.w + gap;
    rowH = Math.max(rowH, size.h);
  }
  return out;
}

/**
 * THE ONE DOOR. Lay a batch out, then move the WHOLE thing down until it is
 * standing on nothing.
 *
 * Whole-batch, because rule 3: nudging individual members to clear an obstacle
 * breaks exactly what the internal layout was for. Down only, because rules 1
 * and 2. The result is the guarantee the prompt already promises — no agent write
 * lands on anything.
 *
 * Returns boxes in the order the sizes came in, so the caller can apply them to
 * its own blocks by index.
 */
export function reserveFlow(
  std: BlockStdScope,
  sizes: readonly Size[],
  opts: {
    at?: { x: number; y: number };
    exclude?: Iterable<string>;
    gap?: number;
    maxRowW?: number;
  } = {},
): Box[] {
  if (!sizes.length) return [];

  /**
   * MEASURE, THEN PLACE. With no caller-chosen origin the batch goes in the
   * thinking region, and that needs its width — which is only known once the flow
   * has been computed. So it is laid out at the origin twice: once to measure,
   * once for real.
   */
  let at = opts.at;
  if (!at) {
    const probe = bboxOf(flow(sizes, { x: 0, y: 0 }, opts))!;
    at = thinkingOrigin(std, probe.w);
  }

  const laid = flow(sizes, at, opts);
  const obstacles = occupancy(std, { exclude: opts.exclude });
  const dy = clearanceBelow(bboxOf(laid)!, obstacles);

  return dy ? laid.map(b => ({ ...b, y: b.y + dy })) : laid;
}

/**
 * How far DOWN a box has to move to stand on nothing.
 *
 * Re-checks from the top after each push: dropping below one obstacle can land on
 * another, and the second is not always below the first. Bounded, because a
 * pathological board must degrade into a slightly wrong position rather than a
 * frozen tab.
 */
export function clearanceBelow(box: Box, obstacles: readonly Box[]): number {
  let y = box.y;
  let guard = 0;
  while (guard++ < 200) {
    const hit = obstacles.find(o => overlaps({ ...box, y }, o));
    if (!hit) break;
    y = hit.y + hit.h + PUSH_GAP;
  }
  return Math.max(0, Math.round(y - box.y));
}

/**
 * Anything the agent placed that is bigger than a shot card.
 *
 * Reported in the canvas digest so the agent can SEE its own mess and offer to
 * fix it, rather than being the last to know — which is exactly what happened
 * with the 960 × 1707 stills. Excludes frames, which are containers and are
 * supposed to be large.
 */
export function oversizeIds(std: BlockStdScope, shotW: number, shotH: number): string[] {
  const gfx = std.get(GfxControllerIdentifier);
  const out: string[] = [];
  for (const model of gfx.gfxElements as GfxModel[]) {
    const flavour = (model as unknown as { flavour?: string }).flavour;
    if (flavour && OWNED_FLAVOURS.has(flavour)) continue;
    if (isLayoutInert(model)) continue;
    const box = boundsOf(model);
    if (!box) continue;
    if (box.w > shotW || box.h > shotH) {
      out.push((model as unknown as { id: string }).id);
    }
  }
  return out;
}

/**
 * Does anything the agent could have placed sit on anything else? The other half
 * of the digest's honesty — a board can be tidy-sized and still be a pile.
 *
 * ── IT MUST NOT USE `occupancy`, AND THE REASON IS A FALSE POSITIVE ──────────
 * `occupancy` GROWS owned blocks by `SPINE_MARGIN`, which is right for deciding
 * where to put something new (the brackets and scene labels are drawn in that
 * band and appear in no read) and completely wrong for reporting what is
 * actually on top of what. Shot cards sit `SHOT_GAP` = 56px apart; grown by 160
 * on each side they all intersect, so a PERFECTLY TIDY three-shot board reported
 * two collisions — measured. Every real storyboard would have told the agent it
 * was a mess and asked it to offer a tidy-up, which is worse than saying nothing
 * at all: a warning that is always on is a warning nobody reads.
 *
 * So this counts TRUE boxes, and it ignores owned-vs-owned pairs entirely — the
 * filmstrip's spacing is `relayoutShots`'s business, not the agent's. A loose
 * note sitting ON a shot card is still counted, because that one is real.
 *
 * TEXT COUNTS. An `affine:edgeless-text` grows to fit its content, so it can end
 * up over something without anybody having placed it there — and it is the one
 * kind `relaxOverlaps` deliberately will not move (moving text destroyed a
 * correct layout once). Counting it is what lets the agent SEE that and offer
 * `board_arrange`, which can move it.
 */
export function collisionCount(std: BlockStdScope): number {
  const gfx = std.get(GfxControllerIdentifier);
  const items: Array<{ box: Box; owned: boolean }> = [];

  for (const model of gfx.gfxElements as GfxModel[]) {
    if (isLayoutInert(model)) continue;
    const box = boundsOf(model);
    if (!box || !box.w || !box.h) continue;
    const flavour = (model as unknown as { flavour?: string }).flavour;
    items.push({ box, owned: !!flavour && OWNED_FLAVOURS.has(flavour) });
  }

  let n = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].owned && items[j].owned) continue;
      if (overlaps(items[i].box, items[j].box)) n++;
    }
  }
  return n;
}

/**
 * Shift one element down by `dy`.
 *
 * A GROUP — which is what a mind map is — CANNOT be moved by writing its `xywh`.
 * `GfxGroupLikeElementModel` defines `set xywh(_) {}`: an empty setter, because a
 * group's bounds are DERIVED from its children every time they are read. So the
 * obvious implementation silently does nothing, and the mind map stays exactly
 * where it was overlapping. BlockSuite's own drag expands to `childElements` and
 * moves each one (`mind-map-drag.ts`), and so does this.
 */
export function moveDown(
  gfx: { updateElement(model: never, props: Record<string, unknown>): void },
  model: GfxModel,
  dy: number,
): void {
  const kids = (model as unknown as { childElements?: GfxModel[] }).childElements;
  if (Array.isArray(kids) && kids.length) {
    for (const kid of kids) {
      const b = boundsOf(kid);
      if (b) gfx.updateElement(kid as never, { xywh: `[${b.x},${b.y + dy},${b.w},${b.h}]` });
    }
    return;
  }
  const b = boundsOf(model);
  if (b) gfx.updateElement(model as never, { xywh: `[${b.x},${b.y + dy},${b.w},${b.h}]` });
}
