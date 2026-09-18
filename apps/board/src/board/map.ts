/**
 * THE BOARD AS A MAP — structure and judgement, at constant cost.
 *
 * ── WHY A THIRD READ ─────────────────────────────────────────────────────────
 * Three reads existed and none of them answers "what is this board, and is it
 * any good":
 *
 *   board_screenshot   pixels. It does not scale — a big board downscales until
 *                      no card is legible, and it needs the tab to be painting,
 *                      so it times out exactly when the board got interesting.
 *   board_canvas_read  every element with x/y/w/h, flat and unbounded. The
 *                      caller has to infer the layout from coordinates.
 *   board_document     the right spine (a frame is a section, reading order is
 *                      top-to-bottom then left-to-right) but a full prose dump.
 *
 * ── THE FAILURE THAT PROVED IT ───────────────────────────────────────────────
 * Measured, on a real board: an agent had the complete geometry of 57 elements —
 * zero overlaps, consistent widths, frames fitted — declared it good, and the
 * user's verdict was "its crap, useless, it explains nothing". Every fault was
 * computable and none of it was computed:
 *
 *   • 57 elements and not one image, for a visual story project
 *   • 1340 x 5800 — a ribbon nothing can take in at any zoom
 *   • every card the same width and colour, so no hierarchy and nowhere to look
 *   • an element stranded outside every frame
 *
 * Raw coordinates are not structure, and a list of rectangles is not a critique.
 * So this DERIVES the layout ("3 columns x 2 rows") and REPORTS the qualities a
 * screenshot was standing in for. An agent can reason about the first and act on
 * the second; it cannot do either with 57 coordinate pairs.
 *
 * ── HOW IT STAYS CHEAP ───────────────────────────────────────────────────────
 * One line per SECTION, never per element, plus the ids that section holds. The
 * ids are the handle: `board_canvas_read { ids }` already reads one section in
 * full, so this needs no new scoping verb and the ladder is map -> section ->
 * item, exactly the progressive disclosure playbooks use.
 */


import type { BlockStdScope } from '@blocksuite/std';

import { type Box, overlaps } from './space';
import { readCanvas, type CanvasItem } from './canvas';

/** Positions within this many units are the same column or row to a reader. */
const ALIGN_TOLERANCE = 12;
/** A card is read at a glance; past this it is a paragraph wearing a card. */
const GLANCE_CHARS = 240;
/** Wider or taller than this and no zoom shows the whole board usefully. */
const RIBBON_RATIO = 3;

export interface MapSection {
  id: string;
  title: string;
  box: Box;
  items: number;
  /** What kinds sit in it — {note: 4} — so "all prose" is visible at a glance. */
  kinds: Record<string, number>;
  /** Derived, not measured: "3 columns x 2 rows", "a run of 5, left to right". */
  layout: string;
  /** The opening words of each item, so the section has a subject not just a name. */
  digest: string;
  /** Handles for the next level down: board_canvas_read { ids }. */
  ids: string[];
}

export interface BoardMap {
  board: {
    box: Box;
    aspect: string;
    elements: number;
    images: number;
    sections: number;
  };
  sections: MapSection[];
  /** Elements inside no frame. A few are fine; many means the board has no shape. */
  loose: { count: number; ids: string[]; digest: string };
  /**
   * What is WRONG with it, in the caller's own terms. Not warnings about the
   * document — judgements about whether it communicates.
   */
  issues: string[];
}

function firstLine(text: string, max = 34): string {
  const line = String(text ?? '').split(/\r?\n/).find(l => l.trim()) ?? '';
  const clean = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Distinct positions, with near-equal ones folded together. */
function tracks(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (!out.length || v - out[out.length - 1] > ALIGN_TOLERANCE) out.push(v);
  }
  return out;
}

/**
 * The shape of a group, said the way a person would say it.
 *
 * This is the whole point of the map: "3 columns x 2 rows" is something a
 * caller can check against what it intended. A list of x values is not.
 */
export function describeLayout(items: ReadonlyArray<{ x: number; y: number }>): string {
  if (!items.length) return 'empty';
  if (items.length === 1) return 'one item';
  const cols = tracks(items.map(i => i.x)).length;
  const rows = tracks(items.map(i => i.y)).length;
  if (rows === 1) return `a run of ${items.length}, left to right`;
  if (cols === 1) return `a column of ${items.length}`;
  return `${cols} columns x ${rows} rows`;
}

function ratio(box: Box): string {
  const w = Math.max(1, box.w);
  const h = Math.max(1, box.h);
  return w >= h ? `${(w / h).toFixed(1)}:1 wide` : `1:${(h / w).toFixed(1)} tall`;
}

/**
 * The judgements. Each one is a thing a person said out loud about a real
 * board, turned into something the board can notice about itself.
 */
function findIssues(
  box: Box,
  items: CanvasItem[],
  sections: MapSection[],
  looseCount: number,
): string[] {
  const out: string[] = [];
  const cards = items.filter(i => i.kind === 'note');
  const images = items.filter(i => i.kind === 'image' || i.kind === 'video').length;

  if (items.length >= 12 && images === 0) {
    out.push(
      `${items.length} elements and not one image. A board is looked at; if the meaning is `
      + 'only in the prose it is a document on a canvas.',
    );
  }

  const long = Math.max(box.w, box.h) / Math.max(1, Math.min(box.w, box.h));
  if (long > RIBBON_RATIO) {
    out.push(
      `The board is ${ratio(box)} — nothing that shape can be taken in. Zoomed out the cards `
      + 'are illegible, zoomed in the structure is gone.',
    );
  }

  if (cards.length >= 8) {
    const widths = new Set(cards.map(c => Math.round(c.w / 10) * 10));
    if (widths.size <= 2) {
      out.push(
        `Every card is one of ${widths.size} width(s) and they carry no emphasis between them. `
        + 'With no hierarchy the eye has nowhere to land.',
      );
    }
    const avg = cards.reduce((n, c) => n + (c.text?.length ?? 0), 0) / cards.length;
    if (avg > GLANCE_CHARS) {
      out.push(
        `Cards average ${Math.round(avg)} characters. A card is read at a glance — past about `
        + `${GLANCE_CHARS} it is a paragraph, and four short cards beat one long one.`,
      );
    }
  }

  if (looseCount > 0 && sections.length > 0) {
    out.push(
      `${looseCount} element(s) sit outside every frame. Stranded on a canvas they read as `
      + 'left-over rather than as part of anything.',
    );
  }

  let hits = 0;
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      if (overlaps(items[a], items[b])) hits++;
    }
  }
  if (hits) out.push(`${hits} pair(s) of elements overlap.`);

  return out;
}

/** The whole map. Never throws — a board that cannot be mapped is still a board. */
export function readBoardMap(std: BlockStdScope): BoardMap {
  /**
   * BOTH HALVES COME FROM `readCanvas`, and that is deliberate.
   *
   * Reading frames straight off the gfx layer looked tidier and was wrong twice
   * over: `isLayoutInert` is TRUE for a frame (so the overlap pass never shoves
   * a section around), which skipped every one of them; and a frame's title is
   * a Y.Text, which does not survive `String(...)` — every section came back
   * "Untitled section". `readCanvas` already solves both, and using it means the
   * map cannot drift from what every other read reports.
   */
  const all = readCanvas(std);
  const items = all.filter(i => i.kind !== 'frame');
  const frames = all
    .filter(i => i.kind === 'frame')
    .map(f => ({
      id: f.id,
      title: (f.text ?? '').trim() || 'Untitled section',
      box: { x: f.x, y: f.y, w: f.w, h: f.h } as Box,
    }))
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);

  /**
   * A card belongs to the section whose frame CONTAINS it. Geometric, like
   * `board_document`'s own rule — nothing to declare and nothing to keep in
   * step, and it is also what the user sees.
   */
  const claimed = new Set<string>();
  const sections: MapSection[] = frames.map(f => {
    const mine = items.filter(i =>
      !claimed.has(i.id)
      && i.x >= f.box.x && i.y >= f.box.y
      && i.x + i.w <= f.box.x + f.box.w && i.y + i.h <= f.box.y + f.box.h);
    for (const m of mine) claimed.add(m.id);
    const kinds: Record<string, number> = {};
    for (const m of mine) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
    return {
      id: f.id,
      title: f.title,
      box: f.box,
      items: mine.length,
      kinds,
      layout: describeLayout(mine),
      digest: mine.map(m => firstLine(m.text)).filter(Boolean).slice(0, 8).join(' · '),
      ids: mine.map(m => m.id),
    };
  });

  const loose = items.filter(i => !claimed.has(i.id));
  const box: Box = items.length
    ? {
      x: Math.min(...items.map(i => i.x)),
      y: Math.min(...items.map(i => i.y)),
      w: Math.max(...items.map(i => i.x + i.w)) - Math.min(...items.map(i => i.x)),
      h: Math.max(...items.map(i => i.y + i.h)) - Math.min(...items.map(i => i.y)),
    }
    : { x: 0, y: 0, w: 0, h: 0 };

  return {
    board: {
      box,
      aspect: ratio(box),
      elements: items.length,
      images: items.filter(i => i.kind === 'image' || i.kind === 'video').length,
      sections: sections.length,
    },
    sections,
    loose: {
      count: loose.length,
      ids: loose.map(i => i.id),
      digest: loose.map(i => firstLine(i.text)).filter(Boolean).slice(0, 6).join(' · '),
    },
    issues: findIssues(box, items, sections, loose.length),
  };
}
