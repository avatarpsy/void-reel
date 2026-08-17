/**
 * THE BOARD AS A FILM — Acts ▸ Sequences ▸ Scenes ▸ Shots ▸ Takes, laid out so
 * you can see the shape of the thing you are making.
 *
 * ── WHAT THIS REPLACES, AND WHY ONE LINE WAS NOT ENOUGH ──────────────────────
 * Every shot used to sit on a single horizontal strip: `x = order * pitch`,
 * `y = 0`. That is honest for a thirty-second ad and useless for anything
 * longer. A feature is four hundred shots, and a four-hundred-card line tells
 * you nothing except that there are a lot of them — you cannot see which
 * sequence is thin, which scene has no coverage, or where the act turns.
 *
 * The hierarchy already exists and was invisible. The screenplay parser produces
 * acts, sequences and scenes; a shot already names the scene it covers; a shot
 * already owns its takes. Everything needed to draw the film was in the document
 * and nothing drew it.
 *
 * So the board becomes a grid:
 *
 *   a SCENE is a row      — its shots left to right, in the order they cut
 *   a SEQUENCE is a block of rows
 *   an ACT is a block of sequences
 *   a TAKE lives inside its shot, where it already did
 *
 * ── POSITION IS STILL THE ORDER, AND THAT IS THE POINT ───────────────────────
 * `shotOrder` sorted by x, so where a card sat WAS the order it cut in. That
 * property is worth keeping: it is why dragging a card between two others
 * reorders the film, with no second hidden structure to disagree with the one on
 * screen. The grid keeps it and adds a dimension — the sort is now (row, then
 * column), i.e. read the board the way you read a page. Top to bottom, left to
 * right, is act ▸ sequence ▸ scene ▸ shot by construction.
 *
 * Nothing here writes to the document. It plans; `relayoutShots` places, and
 * `board/spine.ts` draws the brackets over the result.
 */
import { actIndexAtLine, type ParsedScript } from './fountain';
import { SHOT_GAP, SHOT_H, SHOT_W } from './model';

/**
 * Room down the left for the brackets, and it is not decoration.
 *
 * The act bracket is outermost, the sequence bracket sits inside it, and the
 * scene's own label sits inside that. Three levels of nesting need three levels
 * of indent or they read as one bracket with a lot of text.
 */
export const GUTTER = 360;
/** Between scene rows inside one sequence — the tightest relationship. */
export const ROW_GAP = SHOT_GAP;
/** Extra air between sequences, so a sequence reads as a block. */
export const SEQ_GAP = 150;
/** And more again between acts. An act break should be visible at any zoom. */
export const ACT_GAP = 300;
/** A scene with no shots yet still gets a row — it is how you SEE the gap. */
export const EMPTY_ROW_H = 132;

export interface BoardRow {
  /** '' for the trailing row of shots that are not on the script. */
  sceneKey: string;
  /** 1-based scene number as the script counts them. 0 for the loose row. */
  sceneNumber: number;
  heading: string;
  /** Index into `ParsedScript.sequences`, or -1. */
  sequenceIndex: number;
  /** Index into `ParsedScript.acts`, or -1. */
  actIndex: number;
  /** Shot block ids, in the order they cut. */
  shotIds: string[];
  /** Model-space box of the row's content area — where the cards go. */
  y: number;
  height: number;
}

/** A run of rows under one heading, for the bracket that spans them. */
export interface BoardBand {
  title: string;
  /** Inclusive row indices. */
  from: number;
  to: number;
  /** Model-space vertical extent, so the bracket needs no second calculation. */
  y: number;
  height: number;
}

export interface BoardPlan {
  rows: BoardRow[];
  sequences: BoardBand[];
  acts: BoardBand[];
  /** Where a shot belongs, by block id. */
  place: Map<string, { x: number; y: number; w: number; h: number }>;
  /** True when the script has no structure worth drawing — see `hasStructure`. */
  flat: boolean;
}

/** The x of the nth shot in a row. */
function shotX(column: number): number {
  return GUTTER + column * (SHOT_W + SHOT_GAP);
}

/**
 * IS THERE A FILM SHAPE HERE AT ALL?
 *
 * A thirty-second ad has no acts and no sequences and should not be given empty
 * brackets to look at — the chrome would be bigger than the work. A board with
 * no screenplay at all is the same case. So the plan says `flat` and the drawing
 * layer renders one plain row of shots, exactly as the old filmstrip did.
 *
 * One scene is not structure either: a bracket around the only thing on the
 * board says nothing a person cannot see.
 */
function hasStructure(script: ParsedScript): boolean {
  return script.acts.length > 0 || script.sequences.length > 0 || script.scenes.length > 1;
}

/**
 * Plan the whole board.
 *
 * `shots` is passed in rather than read here so the caller controls the read —
 * this runs on the layout path and on the drawing path, and both already hold
 * the list.
 */
export function planBoard(
  script: ParsedScript,
  shots: Array<{ id: string; sceneKey: string; x: number }>,
): BoardPlan {
  const flat = !hasStructure(script);

  /**
   * WITHIN A SCENE, THE ORDER IS WHERE THE CARDS ALREADY ARE.
   *
   * The plan decides which ROW a shot belongs to; it must not decide the order
   * inside the row, because that is the user's — they set it by dragging, and
   * re-deriving it from anything else would undo their edit on the next open.
   */
  const byScene = new Map<string, string[]>();
  const ordered = [...shots].sort((a, b) => a.x - b.x);
  for (const shot of ordered) {
    const key = shot.sceneKey || '';
    const list = byScene.get(key);
    if (list) list.push(shot.id);
    else byScene.set(key, [shot.id]);
  }

  const rows: BoardRow[] = [];
  const place = new Map<string, { x: number; y: number; w: number; h: number }>();

  if (flat) {
    /**
     * ONE ROW, and it is the old filmstrip exactly. A short piece with no script
     * is not a degenerate film, it is the common case, and it should not be made
     * to look like one act of one sequence of one scene.
     */
    const ids = ordered.map(s => s.id);
    ids.forEach((id, i) => place.set(id, { x: shotX(i), y: 0, w: SHOT_W, h: SHOT_H }));
    rows.push({
      sceneKey: '', sceneNumber: 0, heading: '', sequenceIndex: -1, actIndex: -1,
      shotIds: ids, y: 0, height: ids.length ? SHOT_H : EMPTY_ROW_H,
    });
    return { rows, sequences: [], acts: [], place, flat };
  }

  // ── One row per scene, in the script's own order ──────────────────────────
  let y = 0;
  let prevSeq: number | null = null;
  let prevAct: number | null = null;

  for (const scene of script.scenes) {
    const seqIndex = scene.sequenceIndex;
    const actIndex = actIndexAtLine(script, scene.fromLine);

    // The gaps that make a block read as a block. Never before the first row —
    // a board that opens with three hundred pixels of nothing above it looks
    // broken rather than spacious.
    if (rows.length) {
      if (prevAct !== null && actIndex !== prevAct) y += ACT_GAP;
      else if (prevSeq !== null && seqIndex !== prevSeq) y += SEQ_GAP;
      else y += ROW_GAP;
    }

    const ids = byScene.get(scene.key) ?? [];
    byScene.delete(scene.key);
    const height = ids.length ? SHOT_H : EMPTY_ROW_H;
    ids.forEach((id, i) => place.set(id, { x: shotX(i), y, w: SHOT_W, h: SHOT_H }));

    rows.push({
      sceneKey: scene.key,
      sceneNumber: scene.n,
      heading: scene.heading,
      sequenceIndex: seqIndex,
      actIndex,
      shotIds: ids,
      y,
      height,
    });
    y += height;
    prevSeq = seqIndex;
    prevAct = actIndex;
  }

  /**
   * ── AND EVERYTHING THAT IS NOT ON THE SCRIPT ───────────────────────────────
   *
   * Shots with no scene, and shots whose scene key no longer resolves because
   * the writer renamed a slugline. Both are ordinary working states — a visual
   * idea sketched before its scene is written is normal — and both must be
   * VISIBLE rather than filed somewhere plausible. Putting them under the last
   * act would assert a place in the film that nobody chose, which is the one
   * thing this layout must never do.
   *
   * Last, and in one row, so the board reads as "the film, then the loose ends".
   */
  const loose = [...byScene.values()].flat();
  if (loose.length) {
    if (rows.length) y += ACT_GAP;
    loose.forEach((id, i) => place.set(id, { x: shotX(i), y, w: SHOT_W, h: SHOT_H }));
    rows.push({
      sceneKey: '', sceneNumber: 0, heading: '', sequenceIndex: -1, actIndex: -1,
      shotIds: loose, y, height: SHOT_H,
    });
  }

  return { rows, ...bands(script, rows), place, flat };
}

/**
 * The runs of rows a bracket spans.
 *
 * Computed from the rows rather than from the script so a bracket can never
 * enclose a row that is not there — an act whose scenes were all deleted draws
 * nothing, which is correct, rather than an empty brace over open canvas.
 *
 * The loose row is deliberately in NO band: it is not part of the film's
 * structure, and bracketing it would say it was.
 */
function bands(script: ParsedScript, rows: BoardRow[]): {
  sequences: BoardBand[]; acts: BoardBand[];
} {
  const run = (
    indexOf: (row: BoardRow) => number,
    titleOf: (i: number) => string,
  ): BoardBand[] => {
    const out: BoardBand[] = [];
    rows.forEach((row, at) => {
      const i = indexOf(row);
      if (i < 0 || !row.sceneKey) return;
      const last = out[out.length - 1];
      // Contiguous rows only. A sequence interrupted by a scene from another
      // sequence is two brackets, because that is what it looks like.
      if (last && last.to === at - 1 && last.title === titleOf(i)) {
        last.to = at;
        last.height = row.y + row.height - last.y;
        return;
      }
      out.push({ title: titleOf(i), from: at, to: at, y: row.y, height: row.height });
    });
    return out;
  };

  return {
    sequences: run(r => r.sequenceIndex, i => script.sequences[i]?.title ?? ''),
    acts: run(r => r.actIndex, i => script.acts[i]?.title ?? ''),
  };
}

/**
 * ONE ROW, REORDERED AROUND THE CARD THAT WAS DRAGGED.
 *
 * The rule is nearest-slot: the moved card takes whichever slot its CENTRE is
 * closest to. `Math.round` is the whole of it — half a pitch either way rounds
 * to the next slot — and that half-pitch is the threshold the eye is already
 * judging, because half a pitch is when the cards visibly overlap.
 *
 * ── WHAT THIS REPLACED, AND WHY IT READ AS A BUG ─────────────────────────────
 * The strip order used to be re-derived by sorting every card by its left edge.
 * Since all the cards are the same width, that means a card only changes places
 * once its edge passes its neighbour's — a full card AND the gap, 696px. Drag
 * one halfway onto the card beside it, which is what everybody does, and the
 * sort put it straight back. Indistinguishable from the board refusing the
 * gesture, and reported as "I move them and they snap back".
 *
 * Only the moved card is repositioned. The rest keep the order they had, so a
 * drop can never quietly reshuffle cards the user did not touch.
 */
export function nearestSlotOrder(
  rowIds: readonly string[],
  movedId: string,
  centre: number,
): string[] {
  const ids = [...rowIds];
  if (ids.length < 2 || !ids.includes(movedId)) return ids;

  const slot = Math.round((centre - (GUTTER + SHOT_W / 2)) / (SHOT_W + SHOT_GAP));
  // Clamped: a card dragged past the end of a row belongs at the end of it,
  // not nowhere.
  const target = Math.max(0, Math.min(ids.length - 1, slot));

  const rest = ids.filter(id => id !== movedId);
  rest.splice(target, 0, movedId);
  return rest;
}
