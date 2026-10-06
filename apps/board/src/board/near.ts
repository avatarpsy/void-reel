/**
 * PUT IT WHERE THE USER WILL LOOK FOR IT.
 *
 * ── THE REPORT ───────────────────────────────────────────────────────────────
 * The founder, on a board holding a tall document whose "## 4. The song" section
 * carried the lyrics: the song the agent generated, and the tracks it placed,
 * landed in clear space far left of the document. Nothing was wrong with the
 * allocator — it found empty room, as designed. What it did not know was that a
 * track has a natural home on this board (beside its lyrics), so the user had to
 * go and find their own song on an infinite canvas.
 *
 * "Clear space" answers "where will this not overlap anything". The question the
 * user is asking is "where would I look for it". This module answers the second
 * and hands the first back to `space.ts`, which still owns collision.
 *
 * ── THE ORDER OF PREFERENCE ──────────────────────────────────────────────────
 *   1. `near` — the caller named an anchor (and maybe a document section).
 *   2. references — a generation goes beside what it was made from (rpc.ts
 *      keeps that path; it predates this module and is unchanged).
 *   3. a scene/shot the item is about — `sceneKey`, or a shot whose title the
 *      item's name repeats.
 *   4. a document section the item belongs to — audio beside lyrics/song/music;
 *      anything whose name repeats a heading beside that heading.
 *   5. its own kind — tracks join the tracks, images the images, in creation
 *      order, so a board grows a media area instead of scattered cards.
 *   6. nothing to go on — the old default (thinking region on a storyboard;
 *      to the right of the content on a board with no storyboard).
 *
 * ── RULES CARRIED OVER FROM `space.ts` ──────────────────────────────────────
 * Collision is still decided on TRUE boxes from `occupancy`, the batch moves as
 * one, and nothing is ever moved UP. The one addition: a batch beside an anchor
 * may move RIGHT instead of down when down is much further, because "beside the
 * lyrics, a little further out" is still beside the lyrics and "two thousand
 * pixels below them" is not.
 *
 * Imports go one way: this reads `canvas.ts`/`space.ts`; neither imports this.
 */
import type { BlockStdScope } from '@blocksuite/std';

import { readBlockMeta } from './board-meta';
import { readCanvas, type CanvasItem } from './canvas';
import { CARD_GAP, type Size } from './metrics';
import {
  type Box, ROW_MAX_W, bboxOf, clearanceBelow, flow, occupancy, overlaps,
  ownedBand, reserveFlow, thinkingOrigin, PUSH_GAP,
} from './space';
import { withoutMarks } from '../document/align-marks';
import { readShots } from '../shot/shots';

export type NearSide = 'right' | 'below' | 'left';

/** What a caller may say. Everything optional except the anchor id. */
export interface NearSpec {
  id: string;
  /** A heading inside a document note: its section id (the heading block id)
   *  or its text ("The song", "4", "lyrics"). */
  section?: string;
  side?: NearSide;
}

/** Why the board chose the spot — surfaced so the agent can say it. */
export type NearReason =
  | 'asked' | 'references' | 'scene' | 'shot' | 'lyrics' | 'section'
  | 'group' | 'media-area' | 'thinking';

export interface PlacedNear {
  /** The canvas element it was placed beside ('' for an area, not an element). */
  id: string;
  /** The anchor's kind in the agent's vocabulary (note, shot, media…). */
  kind: string;
  /** The heading it was aligned with, when it was a document section. */
  section?: string;
  sectionId?: string;
  side: NearSide;
  reason: NearReason;
  /** One sentence the agent can repeat to the user. */
  where: string;
}

export interface PlacementItem {
  kind: 'image' | 'video' | 'audio';
  name?: string;
  sceneKey?: string;
}

interface Anchor {
  box: Box;
  id: string;
  kind: string;
  owned: boolean;
  /** Model-space y to align the batch's top with (a section's heading). */
  alignY?: number;
  section?: { id: string; heading: string };
  side: NearSide;
  reason: NearReason;
  label: string;
}

// ── words ───────────────────────────────────────────────────────────────────

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'your', 'our', 'their',
  'generated', 'track', 'image', 'video', 'clip', 'audio', 'media', 'picture', 'new',
  'version', 'take', 'final', 'draft', 'part', 'section',
]);

function words(s: string): string[] {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

function overlapCount(a: string[], b: string[]): number {
  const set = new Set(b);
  return new Set(a.filter(w => set.has(w))).size;
}

/** Does `name` really point at `title`? Two shared words, or the whole of a
 *  short title. One shared common word ("launch") is not enough on its own. */
function nameMatches(name: string, title: string): number {
  const n = words(name);
  const t = words(title);
  if (!n.length || !t.length) return 0;
  const k = overlapCount(n, t);
  if (k >= 2) return k;
  if (k === 1 && t.length === 1) return 1;
  return 0;
}

const SONG_HEADING = /\b(lyric|lyrics|song|songs|track|tracks|music|soundtrack|score|anthem|jingle|chorus|verse|vocals?)\b/i;
// Not "bridge" or "hook": both are ordinary words in a marketing brief.
const LYRIC_BODY = /\b(lyrics?|chorus|verse|pre-chorus)\b/i;

// ── documents ───────────────────────────────────────────────────────────────

interface Heading { id: string; heading: string; level: number; index: number; body: string }

function headingLevel(model: any): number {
  if (model?.flavour !== 'affine:paragraph') return 0;
  const t = model?.props?.type ?? model?.type;
  const m = /^h([1-6])$/.exec(String(t ?? ''));
  return m ? Number(m[1]) : 0;
}

function blockText(model: any): string {
  return withoutMarks(model?.text?.toString?.() ?? model?.props?.text?.toString?.() ?? '').trim();
}

/** Every heading of a note with the text under it (up to the next heading). */
function headingsOf(std: BlockStdScope, noteId: string): Heading[] {
  const note: any = std.store.getBlock(noteId)?.model;
  const kids: any[] = note?.children ?? [];
  const out: Heading[] = [];
  let cur: Heading | null = null;
  kids.forEach((kid, index) => {
    const level = headingLevel(kid);
    if (level) {
      cur = { id: String(kid.id), heading: blockText(kid), level, index, body: '' };
      out.push(cur);
    } else if (cur && cur.body.length < 4000) {
      cur.body += `${blockText(kid)}\n`;
    }
  });
  return out;
}

/** Notes that are documents: they have words. */
function documentNotes(std: BlockStdScope): CanvasItem[] {
  return readCanvas(std).filter(i => i.kind === 'note' && i.text.trim().length > 0);
}

/**
 * Pick a heading from what the caller said: an id, a number ("4"), or words.
 * Returns null rather than a guess when nothing reasonably matches.
 */
function findSection(heads: Heading[], said: string): Heading | null {
  const s = said.trim();
  if (!s) return null;
  const byId = heads.find(h => h.id === s);
  if (byId) return byId;
  const lower = s.toLowerCase();
  const exact = heads.find(h => h.heading.toLowerCase() === lower);
  if (exact) return exact;
  // "4" or "4." or "section 4" → a heading that starts with that number.
  const num = /(\d+)/.exec(lower)?.[1];
  if (num && /^\s*(section\s*)?\d+\.?\s*$/.test(lower)) {
    const byNum = heads.find(h => new RegExp(`^\\s*${num}[.):\\s]`).test(h.heading));
    if (byNum) return byNum;
  }
  const contains = heads.find(h => h.heading.toLowerCase().includes(lower));
  if (contains) return contains;
  let best: Heading | null = null;
  let bestScore = 0;
  const w = words(s);
  for (const h of heads) {
    const k = overlapCount(w, words(h.heading));
    if (k > bestScore) { best = h; bestScore = k; }
  }
  // Lyrics asked for by meaning ("the lyrics") on a note whose heading says "song".
  if (!best && SONG_HEADING.test(s)) best = songSection(heads, '')?.head ?? null;
  return best;
}

/** The heading a track belongs under, scored. */
function songSection(heads: Heading[], name: string): { head: Heading; score: number } | null {
  let best: { head: Heading; score: number } | null = null;
  for (const h of heads) {
    let score = 0;
    if (/\blyric/i.test(h.heading)) score += 4;
    else if (SONG_HEADING.test(h.heading)) score += 3;
    if (LYRIC_BODY.test(h.body)) score += 1;
    score += 2 * nameMatches(name, h.heading);
    if (score > 0 && (!best || score > best.score)) best = { head: h, score };
  }
  return best;
}

/**
 * Where a heading starts, in MODEL space.
 *
 * Measured off the rendered note when it is on screen: the heading's offset
 * inside the note element, as a fraction of the element's height, times the
 * note's model height. The ratio of two screen measurements cancels the zoom
 * and the note's own scale (same trick as `doc-tables.ts`).
 *
 * Off screen the note may not be rendered, so it falls back to an estimate from
 * the text above the heading — lines, not characters, since a heading and a
 * short lyric line each take a line whatever their length.
 */
export function sectionY(std: BlockStdScope, noteId: string, headingId: string, note: Box): number {
  const el = typeof document !== 'undefined'
    ? document.querySelector(`affine-edgeless-note[data-block-id="${noteId}"]`)
    : null;
  const head = el?.querySelector(`[data-block-id="${headingId}"]`);
  const nr = el?.getBoundingClientRect();
  const hr = head?.getBoundingClientRect();
  /**
   * SCALE FROM THE WIDTH, NEVER THE HEIGHT. A document note renders as tall as
   * its text, and its stored `xywh` height is NOT that — measured: a three-page
   * note stored h=1120 and drew 2292 model units tall. Dividing by the rendered
   * height mapped section 2 onto section 1's paragraphs. The width is fixed by
   * the model, so `rendered width / model width` is the true zoom × scale.
   */
  if (nr && hr && nr.width > 1 && note.w > 0 && hr.height > 0) {
    const k = nr.width / note.w;
    const dy = (hr.top - nr.top) / k;
    if (dy >= 0) return Math.round(note.y + dy);
  }

  const model: any = std.store.getBlock(noteId)?.model;
  const kids: any[] = model?.children ?? [];
  const lines = (k: any) => {
    const n = Math.max(1, Math.ceil(blockText(k).length / 70));
    return headingLevel(k) ? n + 1 : n;
  };
  let before = 0;
  let total = 0;
  let seen = false;
  for (const k of kids) {
    if (String(k.id) === headingId) seen = true;
    const l = lines(k);
    if (!seen) before += l;
    total += l;
  }
  if (!total) return note.y;
  // The stored height undersizes a long document (see above), so the estimate
  // is proportional over whichever is taller: the stored box or the text.
  const h = Math.max(note.h, total * LINE_H + NOTE_PAD * 2);
  return Math.round(note.y + NOTE_PAD + Math.min(1, before / total) * (h - NOTE_PAD * 2));
}

/** Rough model-space line height and page padding of a document note, for the
 *  off-screen estimate only. */
const LINE_H = 30;
const NOTE_PAD = 64;

/**
 * A note's box as it is DRAWN — the stored height can be far short of the text
 * (see `sectionY`). Measured when on screen; the stored box otherwise.
 */
function renderedBox(noteId: string, box: Box): Box {
  const el = typeof document !== 'undefined'
    ? document.querySelector(`affine-edgeless-note[data-block-id="${noteId}"]`)
    : null;
  const r = el?.getBoundingClientRect();
  if (!r || r.width <= 1 || box.w <= 0) return box;
  const h = r.height / (r.width / box.w);
  return h > box.h ? { ...box, h: Math.round(h) } : box;
}

// ── anchors ─────────────────────────────────────────────────────────────────

function itemLabel(item: CanvasItem): string {
  const first = item.text.split('\n').map(s => s.trim()).find(Boolean) ?? '';
  const clean = first.replace(/^#+\s*/, '').slice(0, 60);
  return clean ? `${item.kind} "${clean}"` : item.kind;
}

function boxOf(i: CanvasItem): Box {
  const box = { x: i.x, y: i.y, w: i.w, h: i.h };
  return i.kind === 'note' ? renderedBox(i.id, box) : box;
}

function sectionAnchor(
  std: BlockStdScope,
  note: CanvasItem,
  head: Heading,
  side: NearSide,
  reason: NearReason,
): Anchor {
  const box = boxOf(note);
  return {
    box,
    id: note.id,
    kind: note.kind,
    owned: false,
    alignY: sectionY(std, note.id, head.id, box),
    section: { id: head.id, heading: head.heading },
    side,
    reason,
    label: `${itemLabel(note)}, section "${head.heading}"`,
  };
}

/**
 * Resolve what the caller named. Returns a reason string on failure so the
 * caller can tell the agent, then fall back to the default rather than refuse —
 * a misnamed anchor must not cost the user their generation.
 */
export function resolveNear(
  std: BlockStdScope,
  near: NearSpec,
  item?: PlacementItem,
): { ok: true; anchor: Anchor } | { ok: false; message: string } {
  const all = readCanvas(std);
  const target = all.find(i => i.id === near.id);
  if (!target) {
    return { ok: false, message: `near: nothing on the canvas has id ${near.id}, so it was placed by the board's default.` };
  }
  const side: NearSide = near.side === 'below' || near.side === 'left' ? near.side : 'right';
  if (target.kind === 'note') {
    const heads = headingsOf(std, target.id);
    const said = String(near.section ?? '').trim();
    const head = said
      ? findSection(heads, said)
      // A track sent to a document with no section named still belongs beside
      // its lyrics if the document has some.
      : item?.kind === 'audio' ? songSection(heads, item.name ?? '')?.head ?? null : null;
    if (head) return { ok: true, anchor: sectionAnchor(std, target, head, side, 'asked') };
    const anchor: Anchor = {
      box: boxOf(target), id: target.id, kind: target.kind, owned: false, side, reason: 'asked',
      label: itemLabel(target),
    };
    if (said) {
      return { ok: true, anchor: { ...anchor, label: `${anchor.label} (no section matched "${said}", so beside its top)` } };
    }
    return { ok: true, anchor };
  }
  return {
    ok: true,
    anchor: {
      box: boxOf(target), id: target.id, kind: target.kind, owned: !!target.owned, side, reason: 'asked',
      label: itemLabel(target),
    },
  };
}

/** The canvas block of a media item, with the kind its meta records. */
function mediaKindOf(std: BlockStdScope, item: CanvasItem): 'image' | 'video' | 'audio' | null {
  if (item.kind !== 'image' && item.kind !== 'media') return null;
  const meta = readBlockMeta(std.store.doc.spaceDoc, item.id);
  if (meta?.kind) return meta.kind;
  return item.kind === 'image' ? 'image' : null;
}

/**
 * THE DEFAULT — what makes this work without the agent remembering to ask.
 * See the order of preference at the top of the file.
 */
export function defaultAnchor(
  std: BlockStdScope,
  item: PlacementItem,
  exclude: Iterable<string> = [],
): Anchor | null {
  const skip = new Set(exclude);
  const name = item.name ?? '';

  // 3. A scene or a shot this is about.
  const shots = readShots(std);
  if (item.sceneKey) {
    const shot = shots.find(s => s.sceneKey === item.sceneKey);
    const card = shot && readCanvas(std, { ids: [shot.id] })[0];
    if (card) {
      return {
        box: boxOf(card), id: card.id, kind: 'shot', owned: true, side: 'left', reason: 'scene',
        label: `the row of scene ${item.sceneKey}`,
      };
    }
  }
  if (name && shots.length) {
    let best: { id: string; title: string; score: number } | null = null;
    for (const s of shots) {
      const score = nameMatches(name, s.title ?? '');
      if (score && (!best || score > best.score)) best = { id: s.id, title: s.title, score };
    }
    const card = best && readCanvas(std, { ids: [best.id] })[0];
    if (best && card) {
      return {
        box: boxOf(card), id: card.id, kind: 'shot', owned: true, side: 'left', reason: 'shot',
        label: `the row of shot "${best.title}"`,
      };
    }
  }

  // 4. A document section it belongs to.
  const docs = documentNotes(std);
  let bestDoc: { note: CanvasItem; head: Heading; score: number; reason: NearReason } | null = null;
  for (const note of docs) {
    const heads = headingsOf(std, note.id);
    if (item.kind === 'audio') {
      const hit = songSection(heads, name);
      if (hit && (!bestDoc || hit.score > bestDoc.score)) {
        bestDoc = { note, head: hit.head, score: hit.score, reason: 'lyrics' };
      }
    } else if (name) {
      for (const h of heads) {
        const k = nameMatches(name, h.heading);
        if (k && (!bestDoc || k > bestDoc.score)) bestDoc = { note, head: h, score: k, reason: 'section' };
      }
    }
  }
  if (bestDoc) return sectionAnchor(std, bestDoc.note, bestDoc.head, 'right', bestDoc.reason);
  // A track on a board whose document talks about lyrics without a heading for
  // them still belongs beside that document rather than in empty space.
  if (item.kind === 'audio') {
    const lyricNote = docs.find(d => LYRIC_BODY.test(d.text) || /\bsong\b/i.test(d.text));
    if (lyricNote) {
      return {
        box: boxOf(lyricNote), id: lyricNote.id, kind: 'note', owned: false, side: 'right',
        reason: 'lyrics', label: itemLabel(lyricNote),
      };
    }
  }

  // 5. Its own kind — the media area grows by kind, in creation order.
  // Media parked beside a document belongs to THAT section (a song beside its
  // lyrics); joining it would file an unrelated card under someone else's
  // heading, so the group ignores anything sitting alongside a note.
  const canvas = readCanvas(std);
  const notes = canvas.filter(i => i.kind === 'note');
  const besideANote = (i: { x: number; y: number; w: number; h: number }) => notes.some(n =>
    i.y < n.y + n.h && i.y + i.h > n.y
    && (Math.abs(i.x + i.w - n.x) <= 240 || Math.abs(i.x - (n.x + n.w)) <= 240));
  const same = canvas
    .filter(i => !skip.has(i.id) && mediaKindOf(std, i) === item.kind && !besideANote(i));
  if (same.length) {
    // The last row of that group: the bottom-most card, and its row-mates.
    const last = same.reduce((a, b) => (b.y + b.h > a.y + a.h || (b.y + b.h === a.y + a.h && b.x > a.x) ? b : a));
    const label = item.kind === 'audio' ? 'the other tracks' : item.kind === 'video' ? 'the other clips' : 'the other images';
    return {
      box: boxOf(last), id: last.id, kind: last.kind, owned: false,
      side: item.kind === 'audio' ? 'below' : 'right', reason: 'group', label,
    };
  }
  return null;
}

// ── geometry ────────────────────────────────────────────────────────────────

/**
 * `occupancy`, plus every document note at its DRAWN height.
 *
 * A note's stored height can be half of what it draws (a three-page document:
 * stored 1120, drawn 2292), so the plain occupancy let a card land on the lower
 * half of a document — measured, on the first browser run of this module.
 */
function obstaclesFor(std: BlockStdScope, exclude: Iterable<string>): Box[] {
  const skip = new Set(exclude);
  const out = occupancy(std, { exclude: skip });
  for (const item of readCanvas(std)) {
    if (item.kind !== 'note' || skip.has(item.id)) continue;
    const drawn = boxOf(item);
    if (drawn.h > item.h) out.push(drawn);
  }
  return out;
}

/** How far LEFT a box has to move to stand on nothing (away from the storyboard). */
function clearanceLeft(box: Box, obstacles: readonly Box[]): number {
  let x = box.x;
  let guard = 0;
  while (guard++ < 200) {
    const hit = obstacles.find(o => overlaps({ ...box, x }, o));
    if (!hit) break;
    x = hit.x - box.w - PUSH_GAP;
  }
  return Math.max(0, Math.round(box.x - x));
}

/** How far RIGHT a box has to move to stand on nothing. Mirrors clearanceBelow. */
function clearanceRight(box: Box, obstacles: readonly Box[]): number {
  let x = box.x;
  let guard = 0;
  while (guard++ < 200) {
    const hit = obstacles.find(o => overlaps({ ...box, x }, o));
    if (!hit) break;
    x = hit.x + hit.w + PUSH_GAP;
  }
  return Math.max(0, Math.round(x - box.x));
}

/**
 * Lay the batch out beside the anchor and clear it of everything else.
 *
 * Down is preferred (rule 1 of `space.ts`); right is taken only when down is
 * far and right is nearer, so a column beside a document never ends up a screen
 * below the section it is about.
 */
function layBeside(
  std: BlockStdScope,
  sizes: readonly Size[],
  anchor: Anchor,
  exclude: Iterable<string>,
): Box[] {
  const gap = CARD_GAP;
  const column = { maxRowW: 1 };
  let at: { x: number; y: number };
  let opts: { maxRowW?: number } = column;

  if (anchor.owned) {
    /**
     * BESIDE A SHOT MEANS BESIDE ITS ROW, ON THE THINKING SIDE.
     *
     * Right of a shot is the next shot and below it is the next scene row — the
     * storyboard grows into both. So a shot's material lines up with its row in
     * the thinking region left of the script, which is where `board_arrange`
     * with a `sceneKey` puts a scene's references too.
     */
    const w = bboxOf(flow(sizes, { x: 0, y: 0 }, { maxRowW: ROW_MAX_W }))!.w;
    at = { x: thinkingOrigin(std, w).x, y: anchor.box.y };
    opts = { maxRowW: ROW_MAX_W };
  } else if (anchor.side === 'below') {
    at = { x: anchor.box.x, y: anchor.box.y + anchor.box.h + gap };
    // A track group stays a column; anything else continues as a row.
    opts = anchor.reason === 'group' ? column : { maxRowW: ROW_MAX_W };
  } else if (anchor.side === 'left') {
    const w = Math.max(...sizes.map(s => s.w));
    at = { x: anchor.box.x - gap - w, y: anchor.alignY ?? anchor.box.y };
  } else if (anchor.reason === 'group') {
    // Images/clips continue the group's row, wrapping under it at ROW_MAX_W.
    at = { x: anchor.box.x + anchor.box.w + gap, y: anchor.box.y };
    opts = { maxRowW: ROW_MAX_W };
  } else {
    at = { x: anchor.box.x + anchor.box.w + gap, y: anchor.alignY ?? anchor.box.y };
  }

  const laid = flow(sizes, at, opts);
  const bb = bboxOf(laid)!;
  const obstacles = obstaclesFor(std, exclude);
  const dy = clearanceBelow(bb, obstacles);
  if (!dy) return laid;
  /**
   * Down unless it is far and sideways is nearer: RIGHT beside a note (still
   * beside it, a little further out), LEFT in the thinking region (further from
   * the storyboard, still level with the shot's row). Never toward the strip.
   */
  if (anchor.owned) {
    const dl = clearanceLeft(bb, obstacles);
    if (dy > 600 && dl < dy) return laid.map(b => ({ ...b, x: b.x - dl }));
    return laid.map(b => ({ ...b, y: b.y + dy }));
  }
  const dx = anchor.side === 'below' ? Infinity : clearanceRight(bb, obstacles);
  if (dy > 600 && dx < dy) return laid.map(b => ({ ...b, x: b.x + dx }));
  return laid.map(b => ({ ...b, y: b.y + dy }));
}

/**
 * The media area on a board with no storyboard: a column to the right of
 * everything, top-aligned with the content. On a storyboard the strip grows
 * right for ever, so the thinking region (x < 0) is kept there.
 */
function mediaArea(std: BlockStdScope, sizes: readonly Size[], exclude: Iterable<string>, kind: PlacementItem['kind']): Box[] | null {
  if (ownedBand(std)) return null;
  const obstacles = obstaclesFor(std, exclude);
  const all = bboxOf(obstacles);
  if (!all) return null;
  const at = { x: all.x + all.w + CARD_GAP * 2, y: all.y };
  return flow(sizes, at, { maxRowW: kind === 'audio' ? 1 : ROW_MAX_W });
}

export interface Placement {
  boxes: Box[];
  placedNear: PlacedNear | null;
  problems: string[];
}

function describe(anchor: Anchor): PlacedNear {
  const where = anchor.reason === 'group'
    ? `with ${anchor.label}`
    : anchor.owned
      ? `beside ${anchor.label}, in the thinking area left of the script`
      : `${anchor.side === 'below' ? 'below' : anchor.side === 'left' ? 'left of' : 'next to'} the ${anchor.label}`;
  return {
    id: anchor.id,
    kind: anchor.kind,
    ...(anchor.section ? { section: anchor.section.heading, sectionId: anchor.section.id } : {}),
    side: anchor.owned ? 'left' : anchor.side,
    reason: anchor.reason,
    where,
  };
}

/**
 * THE ONE ENTRY POINT for "where does this batch go".
 *
 * `references` is the existing generation rule (below the references); it is
 * kept verbatim so a generation from references lands exactly where it did.
 */
export function planPlacement(
  std: BlockStdScope,
  sizes: readonly Size[],
  opts: {
    item: PlacementItem;
    near?: NearSpec | null;
    referenceIds?: string[];
    exclude?: Iterable<string>;
  },
): Placement {
  const exclude = [...(opts.exclude ?? [])];
  const problems: string[] = [];
  if (!sizes.length) return { boxes: [], placedNear: null, problems };

  if (opts.near?.id) {
    const r = resolveNear(std, opts.near, opts.item);
    if (r.ok) {
      return { boxes: layBeside(std, sizes, r.anchor, exclude), placedNear: describe(r.anchor), problems };
    }
    problems.push(r.message);
  }

  const refIds = opts.referenceIds ?? [];
  if (refIds.length) {
    const refs = readCanvas(std, { ids: refIds });
    if (refs.length) {
      const at = {
        x: Math.min(...refs.map(a => a.x)),
        y: Math.max(...refs.map(a => a.y + a.h)) + 64,
      };
      return {
        boxes: reserveFlow(std, sizes, { at, exclude }),
        placedNear: {
          id: refs[0]!.id,
          kind: refs[0]!.kind,
          side: 'below',
          reason: 'references',
          where: `below the ${refs.length} reference${refs.length > 1 ? 's' : ''} it was made from`,
        },
        problems,
      };
    }
  }

  const anchor = defaultAnchor(std, opts.item, exclude);
  if (anchor) {
    return { boxes: layBeside(std, sizes, anchor, exclude), placedNear: describe(anchor), problems };
  }

  const area = mediaArea(std, sizes, exclude, opts.item.kind);
  if (area) {
    const dy = clearanceBelow(bboxOf(area)!, obstaclesFor(std, exclude));
    return {
      boxes: dy ? area.map(b => ({ ...b, y: b.y + dy })) : area,
      placedNear: { id: '', kind: 'area', side: 'right', reason: 'media-area', where: 'in the media area to the right of the board’s content' },
      problems,
    };
  }

  return {
    boxes: reserveFlow(std, sizes, { exclude }),
    placedNear: { id: '', kind: 'area', side: 'left', reason: 'thinking', where: 'in the thinking area left of the script' },
    problems,
  };
}

/** Accept `near` from the wire: an object, or a bare id string. */
export function parseNear(raw: unknown): NearSpec | null {
  if (typeof raw === 'string' && raw.trim()) return { id: raw.trim() };
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? '').trim();
  if (!id) return null;
  return {
    id,
    ...(typeof r.section === 'string' && r.section.trim() ? { section: r.section.trim() } : {}),
    ...(r.side === 'right' || r.side === 'below' || r.side === 'left' ? { side: r.side } : {}),
  };
}
