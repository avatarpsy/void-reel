/**
 * THE OPEN CANVAS, as something the agent can actually use.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Everything the agent could do to a board was a SHOT or the SCREENPLAY. It
 * could draft a storyboard and it could not draw a box. Meanwhile the toolbar
 * gives a person sticky notes, shapes, arrows, mind maps, pen, text, frames and
 * images — so the two collaborators were working on the same surface with
 * completely different vocabularies, and the assistant's half of a brainstorm
 * was "here is a list, in the chat".
 *
 * The board is a THINKING surface before it is a storyboard. If the agent cannot
 * put a diagram, a mood board, a mind map or a labelled reference on it, then it
 * cannot participate in the part of the work that happens before shots exist —
 * which is most of the work.
 *
 * ── THE DESIGN, AND WHY IT IS THREE FUNCTIONS AND NOT TWELVE ─────────────────
 * The obvious shape is one tool per element type: `board_add_note`,
 * `board_add_shape`, `board_add_arrow`… That is wrong for the thing people
 * actually ask for. "Map out the funnel" is nine boxes and eight arrows, and as
 * separate calls that is seventeen round trips, seventeen undo steps, and a
 * diagram the user watches assemble itself one wrong-looking fragment at a time.
 *
 * So creation is ONE BATCHED CALL over a list of specs, and the specs can refer
 * to each other by a caller-chosen `ref` before any of them have ids. A whole
 * diagram is one call, one transaction, ONE Ctrl+Z.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * Brush strokes. A pen path is a gesture, not a statement — an agent emitting
 * bezier points is imitating handwriting rather than drawing, and the result
 * reads as a forgery of the user's own scribbles. Shapes, connectors and text
 * say the same things legibly.
 *
 * ── COORDINATES ──────────────────────────────────────────────────────────────
 * MODEL space, the same units `xywh` is stored in, y DOWN. Never screen pixels:
 * the viewport moves, and a spec computed against it would land somewhere else
 * by the time it was applied. `x`/`y` are optional everywhere — omitted, the
 * batch is laid out in clear space beside whatever is already on the board, so
 * an agent that has no opinion about position does not have to invent one.
 */
import type { BlockStdScope } from '@blocksuite/std';
import { GfxControllerIdentifier, type GfxModel } from '@blocksuite/std/gfx';
import { EdgelessCRUDIdentifier } from '@blocksuite/affine/blocks/surface';
import { DefaultTheme } from '@blocksuite/affine/model';
import { Text } from '@blocksuite/store';
import * as Y from 'yjs';

import { readBlockMeta } from './board-meta';
import { decodeMediaRef } from './media-ref';
/**
 * GEOMETRY LIVES IN `space.ts`, and it moved there for a reason.
 *
 * `Box`, `overlaps`, `boundsOf` and `isLayoutInert` were private to this file,
 * which is exactly why only this file could do layout — `board_place_media` and
 * `board_generate_media` had no collision handling at all while the prompt told
 * the agent the board would resolve overlaps for it. Imports go one way:
 * `canvas.ts` → `space.ts`, never back.
 */
import {
  type Box, OWNED_FLAVOURS, PUSH_GAP, bboxOf, boundsOf, collisionCount, isLayoutInert,
  moveDown, overlaps, oversizeIds, ownedBand, thinkingOrigin,
} from './space';
import { SHOT_H, SHOT_W } from '../shot/model';


/**
 * A SMALL NAMED PALETTE, and the reason it is small.
 *
 * BlockSuite colours are theme-aware tokens (`{ dark, light }`), not hex — a
 * hard-coded `#ffffff` note is invisible in light mode and screaming in dark.
 * Handing the agent an open colour field would therefore produce boards that
 * look correct to whoever generated them and broken to everyone else.
 *
 * Nine words, mapped onto AFFiNE's own palette, so every colour an agent can
 * choose is one a designer already chose and both themes are handled for us.
 */
const PALETTE = {
  yellow: 'Yellow',
  orange: 'Orange',
  red: 'Red',
  magenta: 'Magenta',
  purple: 'Purple',
  blue: 'Blue',
  teal: 'Teal',
  green: 'Green',
  grey: 'Grey',
} as const;

export type ColorName = keyof typeof PALETTE;

export const COLOR_NAMES = Object.keys(PALETTE) as ColorName[];

function paletteValue(palettes: ReadonlyArray<{ key: string; value: unknown }>,
                      key: string): unknown | null {
  return palettes.find(p => p.key === key)?.value ?? null;
}

/** A shape/connector colour, from a name. Falls back to the theme default. */
function strokeColor(name?: string): unknown {
  const key = PALETTE[(name ?? '') as ColorName];
  return (key && paletteValue(DefaultTheme.StrokeColorShortPalettes, key))
    ?? DefaultTheme.shapeStrokeColor;
}

function fillColor(name?: string): unknown {
  if (name === 'transparent') return DefaultTheme.transparent;
  const key = PALETTE[(name ?? '') as ColorName];
  return (key && paletteValue(DefaultTheme.FillColorShortPalettes, key))
    ?? DefaultTheme.shapeFillColor;
}

/** Note backgrounds live in their own, softer palette — a Medium fill behind a
 *  paragraph of text is unreadable, which is why AFFiNE keeps two. */
function noteColor(name?: string): unknown {
  const key = PALETTE[(name ?? '') as ColorName];
  return (key && paletteValue(DefaultTheme.NoteBackgroundColorPalettes, key))
    ?? DefaultTheme.noteBackgrounColor;
}

// ── What the agent sends ─────────────────────────────────────────────────────

/** Where a connector attaches: an existing element, one made in this batch, or
 *  a bare point on the canvas. */
export type Anchor =
  | { id: string }
  | { ref: string }
  | { x: number; y: number };

interface Common {
  /** A name for THIS batch only, so later specs can point at this one before it
   *  has an id. Never stored. */
  ref?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export type MindmapTree = { text: string; children?: MindmapTree[] };

export type ElementSpec =
  | (Common & { kind: 'note'; text: string; color?: string })
  | (Common & { kind: 'text'; text: string; color?: string; fontSize?: number })
  | (Common & {
      kind: 'shape';
      shape?: 'rect' | 'roundedRect' | 'ellipse' | 'diamond' | 'triangle';
      text?: string;
      fill?: string;
      stroke?: string;
      filled?: boolean;
    })
  | (Common & {
      kind: 'connector';
      from: Anchor;
      to: Anchor;
      label?: string;
      mode?: 'straight' | 'orthogonal' | 'curve';
      stroke?: string;
      /** Arrowheads. `both` for a two-way relationship, `none` for a plain tie. */
      ends?: 'end' | 'start' | 'both' | 'none';
    })
  | (Common & {
      kind: 'mindmap';
      tree: MindmapTree;
      style?: 1 | 2 | 3 | 4;
      layout?: 'right' | 'left' | 'balance';
    })
  | (Common & {
      kind: 'frame';
      title?: string;
      /** What this frame CONTAINS, by `ref` or `id`. Registered as real
       *  membership, so dragging the frame takes its contents with it. */
      contains?: Array<{ id: string } | { ref: string }>;
    })
  | (Common & { kind: 'group'; members: Array<{ id: string } | { ref: string }>; title?: string })
  | (Common & { kind: 'link'; url: string; title?: string; description?: string });

export interface DrawResult {
  /** Created ids, in spec order. `null` where a spec was refused. */
  ids: Array<string | null>;
  /** `ref` → id, for the caller's own bookkeeping. */
  refs: Record<string, string>;
  /** One line per refusal, so a partly-applied batch explains itself. */
  problems: string[];
}

// ── Placement ────────────────────────────────────────────────────────────────

/**
 * Where a batch with no coordinates goes: `thinkingOrigin` in `space.ts`, shared
 * with the media paths.
 *
 * A second copy is how the two halves of the board came to disagree about where
 * "clear space" was — this one scanned the whole canvas while the media path used
 * a fixed `SHOT_H + 240` that landed on scene 2.
 */


/** Default size per kind, so a spec only has to say what it IS. */
/**
 * ── HOW BIG A LABEL ACTUALLY IS ──────────────────────────────────────────────
 *
 * An approximation, on purpose. Real metrics need a laid-out font, which does
 * not exist when a spec is being turned into a box — and the alternative in
 * place until now was the constant 260x40 for every `text` element at every
 * size, which is wrong by a factor of three on an ordinary title.
 *
 * `GLYPH_EM` is the mean advance width of a character as a fraction of the font
 * size for the sans-serif the board draws in. 0.58 is a little over the true
 * mean (~0.52) BY DESIGN: overestimating leaves a roomy box, underestimating
 * puts the next element on top of the words.
 */
const GLYPH_EM = 0.58;
const LINE_EM = 1.35;

export function measureLabel(
  text: string,
  fontSize: number,
  maxWidth?: number,
): { w: number; h: number } {
  const size = Math.max(1, fontSize);
  const lines = String(text ?? '').split(/\r?\n/);
  const widthOf = (line: string) => Math.ceil(Math.max(1, line.length) * size * GLYPH_EM);

  const natural = Math.max(...lines.map(widthOf), size);
  const w = maxWidth ? Math.max(size, maxWidth) : natural;

  // Wrapped rows, so a long label constrained to a column reports the height it
  // will really occupy rather than one line's worth.
  let rows = 0;
  for (const line of lines) rows += Math.max(1, Math.ceil(widthOf(line) / w));

  return { w: Math.ceil(w), h: Math.ceil(rows * size * LINE_EM) };
}

const SIZE: Record<string, { w: number; h: number }> = {
  note: { w: 400, h: 100 },
  text: { w: 260, h: 40 },
  shape: { w: 200, h: 120 },
  frame: { w: 900, h: 600 },
  // AFFiNE's own horizontal link-card proportions. A bookmark drawn at any other
  // ratio letterboxes its preview image.
  link: { w: 400, h: 114 },
};

// ── Reading ──────────────────────────────────────────────────────────────────

export interface CanvasItem {
  id: string;
  /** The agent's vocabulary, not BlockSuite's flavours. */
  kind: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Set on the board's own blocks, which are read and written by other tools.
   *  An arrow may point at one; nothing here may restyle or delete one. */
  owned?: true;

  /**
   * WHERE IT CAME FROM — the prompt that made it, or the page it came off.
   *
   * The difference between "that one, but warmer" being an EDIT and being a
   * fresh guess. Without it the agent sees nine similar pictures and cannot tell
   * which prompt produced which, so every follow-up starts from nothing.
   *
   * Truncated hard: this rides on a canvas read of a board that may hold two
   * hundred items, and the point is to recognise a picture, not to reproduce its
   * prompt verbatim — `board_media_info` gives the whole thing for one id.
   */
  prompt?: string;
  /** The canvas blocks it was generated FROM, so a follow-up can reuse them. */
  referenceIds?: string[];
  /** The page a web import came off. */
  sourceUrl?: string;
  /**
   * The scene this loose reference is ABOUT, if it says.
   *
   * Makes "what have we got for scene 3" answerable without the agent keeping its
   * own list. Still not compiled — only a shot's own references are — and still
   * the user's to drag anywhere; see `BlockMeta.sceneKey`.
   */
  sceneKey?: string;
}

/** Text out of anything that carries some, without caring how it stores it. */
function textOf(std: BlockStdScope, model: unknown): string {
  const m = model as {
    text?: unknown;
    title?: unknown;
    props?: { text?: unknown; title?: unknown; url?: string; name?: string };
    children?: Array<{ id: string }>;
  };
  const direct = m.props?.text ?? m.text ?? m.props?.title ?? m.title;
  if (typeof direct === 'string') return direct;
  if (direct && typeof (direct as Y.Text).toString === 'function') {
    const s = String(direct);
    if (s && s !== '[object Object]') return s;
  }
  // A note holds its words in child paragraphs.
  if (Array.isArray(m.children) && m.children.length) {
    return m.children
      .map(c => {
        const child = std.store.getBlock(c.id)?.model.props as { text?: unknown } | undefined;
        return child?.text ? String(child.text) : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return m.props?.url ?? m.props?.name ?? '';
}

/** BlockSuite's name for a thing → the agent's. */
function kindOf(model: { flavour?: string; type?: string }): string {
  const flavour = model.flavour;
  if (flavour) {
    return ({
      'affine:note': 'note',
      'affine:frame': 'frame',
      'affine:image': 'image',
      'affine:attachment': 'media',
      'affine:bookmark': 'link',
      'affine:edgeless-text': 'text',
      'voidspace:shot': 'shot',
      'voidspace:screenplay': 'screenplay',
      'voidspace:blockdraft': 'block-draft',
    } as Record<string, string>)[flavour] ?? flavour;
  }
  return model.type ?? 'unknown';
}

/**
 * WHAT THE USER HAS SELECTED, and the media among it.
 *
 * The load-bearing primitive for "use THESE as references". Someone marquees
 * four stills, says "make me one in this style", and every part of that sentence
 * except the style is carried by the selection — so without a channel for it the
 * request is unanswerable, and the agent's only move is to ask which four.
 *
 * Media urls come back separately because that is what a generation call takes:
 * resolving them here means the parent page never has to know how a board stores
 * an image (a `vsmedia:` reference behind a blob source, not a url).
 */
export interface CanvasSelection {
  ids: string[];
  items: CanvasItem[];
  /** Full-quality urls of the selected images/clips, in selection order. */
  mediaUrls: string[];
}

/**
 * WHERE A RESULT MADE FROM THESE BELONGS.
 *
 * Just below their bounding box: a row of references reads left-to-right, so
 * the thing made from them reads as the next line. Used by BOTH the pending
 * placeholder and the real placement, so the spinner is replaced in the spot it
 * occupied rather than the picture appearing somewhere else a minute later.
 *
 * Null when none of the ids resolve to something with a box — the caller then
 * falls back to its own clear space, because there is nothing to be near.
 */
export function anchorFor(std: BlockStdScope, referenceIds: string[]): { x: number; y: number } | null {
  if (!referenceIds.length) return null;
  const boxed = readCanvas(std).filter(i => referenceIds.includes(i.id));
  if (!boxed.length) return null;
  return {
    x: Math.min(...boxed.map(a => a.x)),
    y: Math.max(...boxed.map(a => a.y + a.h)) + 64,
  };
}

export function readSelection(std: BlockStdScope): CanvasSelection {
  const items = readCanvas(std, true);
  return {
    ids: items.map(i => i.id),
    items,
    mediaUrls: items
      .map(i => mediaUrlOf(std, i.id))
      .filter((u): u is string => !!u),
  };
}

/**
 * The FULL-QUALITY url behind a canvas media block.
 *
 * `boardMeta.originalUrl` first, then the reference the block actually points
 * at. The card DRAWS the display variant (a thumbnail or 720p proxy) and that is
 * exactly what a generation must not be given — an image model handed a 320px
 * proxy produces a 320px-worth of detail and the user blames the model.
 */
export function mediaUrlOf(std: BlockStdScope, id: string): string | null {
  const block = std.store.getBlock(id);
  if (!block) return null;
  if (block.flavour !== 'affine:image' && block.flavour !== 'affine:attachment') return null;

  const meta = readBlockMeta(std.store.doc.spaceDoc, id);
  if (meta?.originalUrl) return meta.originalUrl;

  const sourceId = (block.model.props as { sourceId?: string }).sourceId;
  return (sourceId ? decodeMediaRef(sourceId)?.src : null) ?? null;
}

/**
 * Everything on the canvas, in one list.
 *
 * INCLUDING the board's own blocks, marked `owned`. Leaving them out made the
 * agent's picture of the board a lie — it would place a note straight on top of
 * scene 3 because as far as it could tell that space was empty, and it could not
 * draw an arrow from an idea to the shot the idea was about.
 */
/**
 * How much of an element's text a read carries.
 *
 * Two caps, because a canvas read answers two different questions. The default
 * is RECOGNITION — "what is on this board, and where" — over a board that may
 * hold two hundred items, so 400 characters is plenty and anything more is
 * context spent on notes nobody asked about. The full cap is TRANSCRIPTION —
 * "turn what I wrote into a document" — which is unanswerable from a preview,
 * because the note the user spent ten minutes on is exactly the one that runs
 * past 400 characters.
 *
 * `full` is still capped, and the caller caps the TOTAL as well: an uncapped
 * read of a big board is a context bomb with a reasonable-looking name.
 */
const PREVIEW_CHARS = 400;
const FULL_CHARS = 4_000;

/** What subset of the canvas to read, and how much of each element's text. */
export interface CanvasRead {
  /** Only what the user has selected right now. */
  selectionOnly?: boolean;
  /** Only these ids. Wins over `selectionOnly` when both are given. */
  ids?: string[];
  /** Untruncated text, up to `FULL_CHARS` per element. */
  full?: boolean;
}

/**
 * @param where `true` is shorthand for `{ selectionOnly: true }` — kept because
 *   the selection push and a dozen tests call it that way, and widening a
 *   signature is cheaper than rewriting call sites that were already correct.
 */
export function readCanvas(std: BlockStdScope, where: boolean | CanvasRead = false): CanvasItem[] {
  const gfx = std.get(GfxControllerIdentifier);
  const out: CanvasItem[] = [];
  const opt: CanvasRead = typeof where === 'boolean' ? { selectionOnly: where } : where;
  const cap = opt.full ? FULL_CHARS : PREVIEW_CHARS;
  const wanted = opt.ids?.length
    ? new Set(opt.ids)
    : opt.selectionOnly
    ? new Set(gfx.selection.selectedIds)
    : null;

  for (const model of gfx.gfxElements as GfxModel[]) {
    if (wanted && !wanted.has((model as unknown as { id: string }).id)) continue;
    const bound = boundsOf(model);
    if (!bound) continue;
    const m = model as unknown as { id: string; flavour?: string; type?: string };
    // Only media carries provenance, and only media blocks have a meta entry —
    // so this is a lookup on the few, not a walk over the many.
    const meta = m.flavour === 'affine:image' || m.flavour === 'affine:attachment'
      ? readBlockMeta(std.store.doc.spaceDoc, m.id)
      : undefined;
    out.push({
      id: m.id,
      kind: kindOf(m),
      text: textOf(std, model).slice(0, cap),
      x: Math.round(bound.x),
      y: Math.round(bound.y),
      w: Math.round(bound.w),
      h: Math.round(bound.h),
      ...(m.flavour && OWNED_FLAVOURS.has(m.flavour) ? { owned: true as const } : {}),
      ...(meta?.prompt ? { prompt: meta.prompt.slice(0, 160) } : {}),
      ...(meta?.sceneKey ? { sceneKey: meta.sceneKey } : {}),
      ...(meta?.referenceIds?.length ? { referenceIds: meta.referenceIds } : {}),
      ...(meta?.sourceUrl ? { sourceUrl: meta.sourceUrl } : {}),
    });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * A one-paragraph summary of the open canvas, small enough to ride on EVERY
 * turn.
 *
 * ── WHAT IT FIXES ────────────────────────────────────────────────────────────
 * The agent's per-turn context was storyboard-shaped: shots, screenplay,
 * compiles, selection. It said NOTHING about the canvas. So on a board holding
 * forty notes and three mind maps the agent's view every turn was "0 shots, no
 * screenplay" — it was blind to the entire body of work until it happened to
 * call `board_canvas_read`, and an agent that believes a surface is empty does
 * not go looking. Every "it ignored what I already put on the board" complaint
 * is downstream of this.
 *
 * ── WHY IT IS THIS SMALL ─────────────────────────────────────────────────────
 * Same discipline as the screenplay map: one line per scene rides every turn,
 * the TEXT is pulled on demand. Here that means counts, frame titles and the
 * opening words of the notes — enough for the agent to know what is there and
 * what to ask for, never enough to be the read itself. A digest that grew with
 * the board would make a big board expensive on every message, which is the
 * exact cost the map pattern exists to avoid.
 *
 * `owned` blocks are EXCLUDED. Shots and the screenplay are already reported in
 * full alongside this, and counting them twice makes a board look like it holds
 * more than it does — the kind of small lie that shows up as an agent
 * confidently describing work that is not there.
 */
export interface CanvasDigest {
  /** Loose items on the canvas, excluding shots and the screenplay. */
  total: number;
  /** How many of each kind — `{ note: 12, shape: 4, connector: 3 }`. */
  kinds: Record<string, number>;
  /** Frame titles, in reading order. Frames are how people group on a canvas,
   *  so these are the section headings of whatever they are building. */
  frames: string[];
  /** The opening words of each text-bearing element, in reading order. */
  notes: string[];
  /**
   * IS THE BOARD A MESS? Two numbers, and they are the agent's only way to know.
   *
   * Everything above this line is an inventory — counts, titles, openings — with
   * no geometry in it at all. So the standing per-turn picture of the board could
   * not express "your references are stacked on top of each other" or "that still
   * is bigger than the shot it belongs to", which is why the agent was the last
   * to know about both of the bugs this work was reported for.
   *
   * Deliberately NOT a list of boxes. A digest must not grow with the board, and
   * the agent does not need coordinates to say a sentence about the state of the
   * canvas or to offer `board_arrange` — it needs to know there is something to
   * offer. `board_canvas_read` is one call away when it wants the real geometry.
   */
  tidy: {
    /** Pairs of loose elements sitting on each other. 0 is a clean board. */
    collisions: number;
    /** Elements drawn larger than a shot card, which a reference never should be. */
    oversize: number;
  };
}

/** Frames and notes are capped: a digest must not grow with the board. */
const DIGEST_FRAMES = 16;
const DIGEST_NOTES = 24;
const DIGEST_NOTE_CHARS = 90;

export function canvasDigest(std: BlockStdScope): CanvasDigest {
  const kinds: Record<string, number> = {};
  const frames: string[] = [];
  const notes: string[] = [];
  let total = 0;

  // `readCanvas` already sorts into reading order (y, then x) and already
  // resolves kind and text — so the digest is a projection of the read rather
  // than a second walk that could disagree with it.
  for (const item of readCanvas(std)) {
    if (item.owned) continue;
    total++;
    kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;

    const text = item.text.trim();
    if (!text) continue;
    // The first line is the title of a note and the label of a frame; the rest
    // is body, which belongs in a read and not in a summary.
    const head = text.split('\n', 1)[0]!.slice(0, DIGEST_NOTE_CHARS);
    if (item.kind === 'frame') {
      if (frames.length < DIGEST_FRAMES) frames.push(head);
    } else if (notes.length < DIGEST_NOTES) {
      notes.push(head);
    }
  }

  return {
    total,
    kinds,
    frames,
    notes,
    tidy: {
      collisions: collisionCount(std),
      oversize: oversizeIds(std, SHOT_W, SHOT_H).length,
    },
  };
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * Inline markdown → real formatting.
 *
 * `**bold**`, `*italic*` and `` `code` `` are what a language model writes
 * without being asked, every time. Passed through as a plain string they render
 * as literal asterisks, which is the single cheapest way to make a generated
 * board look unfinished — the content can be excellent and it still reads as a
 * dump. Observed on a real journal map: "**The pitch outpaces the life.**"
 *
 * Deltas rather than a rich-text parser: a note is a sentence or two, and the
 * three marks below are the whole vocabulary anyone uses in one.
 */
function inlineDeltas(raw: string): Array<{ insert: string; attributes?: Record<string, true> }> {
  const out: Array<{ insert: string; attributes?: Record<string, true> }> = [];
  // Longest marker first, so `**x**` is not read as two italics.
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let at = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(raw))) {
    if (m.index > at) out.push({ insert: raw.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ insert: m[1], attributes: { bold: true } });
    else if (m[2] !== undefined) out.push({ insert: m[2], attributes: { italic: true } });
    else out.push({ insert: m[3], attributes: { code: true } });
    at = m.index + m[0].length;
  }
  if (at < raw.length) out.push({ insert: raw.slice(at) });

  // `Text` refuses an empty delta list; a blank line is a real paragraph.
  return out.length ? out : [{ insert: '' }];
}

/** A `Text` carrying inline formatting. */
function richText(raw: string): Text {
  return new Text(inlineDeltas(raw) as never);
}

/**
 * Turn plain text into note children.
 *
 * A shallow markdown, and deliberately shallow: headings and bullets are what
 * people write on a sticky note, and anything richer belongs in a document. A
 * blank line is a paragraph break, which is the one convention nobody has to be
 * told about. Inline marks are handled by `richText` above.
 */
function fillNote(std: BlockStdScope, noteId: string, text: string): void {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let wrote = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);

    if (bullet) {
      std.store.addBlock('affine:list', { type: 'bulleted', text: richText(bullet[1]) }, noteId);
    } else if (numbered) {
      std.store.addBlock('affine:list', { type: 'numbered', text: richText(numbered[1]) }, noteId);
    } else if (heading) {
      std.store.addBlock(
        'affine:paragraph',
        { type: `h${heading[1].length}`, text: richText(heading[2]) },
        noteId,
      );
    } else {
      std.store.addBlock('affine:paragraph', { type: 'text', text: richText(line) }, noteId);
    }
    wrote = true;
  }

  // An empty note is a grey rectangle nobody can explain. Give it one paragraph
  // so it is at least a place to type.
  if (!wrote) std.store.addBlock('affine:paragraph', { type: 'text', text: new Text('') }, noteId);
}

const CONNECTOR_MODE = { straight: 0, orthogonal: 1, curve: 2 } as const;

/**
 * Draw a batch onto the canvas as ONE undoable action.
 *
 * Specs are applied IN ORDER, and a `ref` becomes resolvable the moment its spec
 * has been created — so a connector may point at a shape defined earlier in the
 * same array, which is what makes a diagram one call.
 *
 * A spec that cannot be applied is SKIPPED and reported rather than aborting the
 * batch: eight boxes and one bad arrow should leave eight boxes and a sentence
 * saying which arrow was wrong, not an empty canvas and a stack trace.
 */
export function drawOnCanvas(
  std: BlockStdScope,
  specs: ElementSpec[],
): DrawResult {
  const crud = std.get(EdgelessCRUDIdentifier);
  const gfx = std.get(GfxControllerIdentifier);
  const surface = gfx.surface;
  const rootId = std.store.root?.id;

  const ids: Array<string | null> = [];
  const refs: Record<string, string> = {};
  const problems: string[] = [];
  /** Frame membership, resolved after the batch — a member may be a `ref` to
   *  something declared later in the same array. */
  const framesToFill: Array<{
    frameId: string;
    members: Array<{ id: string } | { ref: string }>;
    /** True when the caller gave no coordinates, so the frame must be fitted
     *  around its members once they have sized and settled. */
    derive: boolean;
  }> = [];

  if (!surface || !rootId) {
    return { ids: specs.map(() => null), refs, problems: ['The canvas is not ready yet.'] };
  }

  /**
   * The thinking region is RIGHT-ALIGNED, so it needs this batch's width — and
   * for a draw that is the widest thing being auto-placed, since they stack in
   * one column. Only the declared widths count: a note's HEIGHT grows to fit its
   * text, but its width is whatever was asked for.
   */
  const autoWidth = specs.reduce((max, spec) => {
    if (spec.x !== undefined && spec.y !== undefined) return max;
    return Math.max(max, spec.w ?? SIZE[spec.kind]?.w ?? 200);
  }, 0);
  const origin = thinkingOrigin(std, autoWidth);
  /** How far the auto-placed cursor has walked down the free band. */
  let flowY = origin.y;

  const resolve = (a: Anchor | undefined): { id?: string; position?: [number, number] } | null => {
    if (!a) return null;
    if ('ref' in a) {
      const id = refs[a.ref];
      return id ? { id } : null;
    }
    if ('id' in a) {
      // Verified, because a connector to a missing id renders as an arrow from
      // nowhere and is impossible to explain afterwards.
      const exists = !!surface.getElementById(a.id) || !!std.store.getBlock(a.id);
      return exists ? { id: a.id } : null;
    }
    return { position: [a.x, a.y] };
  };

  std.store.captureSync();
  std.store.transact(() => {
    for (const spec of specs) {
      const size = SIZE[spec.kind] ?? { w: 200, h: 120 };
      /**
       * ── A LABEL'S BOX HAS TO MATCH ITS TYPE ────────────────────────────────
       *
       * MEASURED, before this existed: EVERY `text` element came out 260x40, at
       * every font size and every length. "THE QUIET WAR" at 56px needs about
       * 420x76. "Short" at 96px needs about 280x130. A 56-character label at
       * 32px needs about 1000 wide.
       *
       * The renderer draws the glyphs anyway, so it looks survivable — and then
       * every layout decision downstream is made against a box that is a
       * fiction. Things get placed on top of titles, frames fit around the wrong
       * bounds, and `relaxOverlaps` will not intervene because it deliberately
       * trusts an author-sized element (see AUTO_SIZED). That is the "text
       * overlaps other text" report, and no amount of better prompting could
       * have fixed it: the caller was never told the default ignores fontSize.
       *
       * An estimate is enough and is vastly better than a constant. It is
       * deliberately generous, so the error is a slightly roomy title rather
       * than a collision.
       */
      const measured = spec.kind === 'text'
        ? measureLabel((spec as { text?: string }).text ?? '',
                       (spec as { fontSize?: number }).fontSize ?? 24,
                       spec.w)
        : null;
      const w = spec.w ?? measured?.w ?? size.w;
      const h = spec.h ?? measured?.h ?? size.h;
      /**
       * ── A FRAME THAT NAMES ITS MEMBERS TAKES ITS BOX FROM THEM ─────────────
       *
       * THE FAILURE THIS FIXES, seen on a real brainstorm. Seven frames were
       * drawn, each with `contains`, none with coordinates — because the whole
       * point of `contains` is that the caller does not know where the members
       * will end up. Every one of them was treated as an ordinary unplaced
       * element: given `origin.x`, given the next `flowY`, and given the default
       * 900x600 frame size. The result was a column of seven EMPTY titled boxes
       * down the left of the board while the notes they were supposed to gather
       * sat somewhere else entirely, unframed.
       *
       * It cannot be fixed by asking the caller for coordinates. A frame wraps
       * notes, and a note's height is decided by AFFiNE after it renders — the
       * same reason `relaxOverlaps` exists. The bounding box is not knowable at
       * authoring time, so the board has to compute it afterwards.
       *
       * `arrange.ts` has done this correctly all along (`makeFrame`: bbox of the
       * members, plus a pad, plus room for the title bar). This is that, applied
       * to the frames `board_draw` makes.
       */
      const derivedFrame = spec.kind === 'frame'
        && !!spec.contains?.length
        && (spec.x === undefined || spec.y === undefined);
      const placed = !derivedFrame && (spec.x === undefined || spec.y === undefined);
      const x = spec.x ?? origin.x;
      const y = spec.y ?? flowY;
      if (placed) flowY = y + h + 40;

      let id: string | null = null;

      try {
        switch (spec.kind) {
          case 'note': {
            id = crud.addBlock(
              'affine:note',
              {
                xywh: `[${x},${y},${w},${h}]`,
                displayMode: 'edgeless',
                background: noteColor(spec.color),
              },
              rootId,
            ) ?? null;
            if (id) fillNote(std, id, spec.text ?? '');
            break;
          }

          case 'text': {
            // The SURFACE text element, not `affine:edgeless-text`. A label on a
            // canvas is one string with a colour and a size; the block is a
            // document container that also accepts images and code, and using it
            // for "Q3" produces a rich-text host for a two-character caption.
            id = crud.addElement('text', {
              xywh: `[${x},${y},${w},${h}]`,
              text: new Y.Text(spec.text ?? ''),
              fontSize: spec.fontSize ?? 24,
              ...(spec.color ? { color: strokeColor(spec.color) } : {}),
            }) ?? null;
            break;
          }

          case 'shape': {
            const name = spec.shape ?? 'roundedRect';
            id = crud.addElement('shape', {
              xywh: `[${x},${y},${w},${h}]`,
              shapeType: name === 'roundedRect' ? 'rect' : name,
              radius: name === 'roundedRect' ? 0.1 : 0,
              fillColor: fillColor(spec.fill),
              strokeColor: strokeColor(spec.stroke ?? spec.fill),
              // Filled by default: an outline-only box on a white canvas is
              // invisible at the zoom people review a diagram at.
              filled: spec.filled ?? true,
              ...(spec.text ? { text: new Y.Text(spec.text) } : {}),
            }) ?? null;
            break;
          }

          case 'connector': {
            const from = resolve(spec.from);
            const to = resolve(spec.to);
            if (!from || !to) {
              problems.push(
                `Could not draw a connector: ${!from ? 'the start' : 'the end'} does not exist. `
                + 'Use an id from board_canvas_read, a ref defined earlier in this same call, or a point.',
              );
              break;
            }
            const ends = spec.ends ?? 'end';
            id = crud.addElement('connector', {
              source: from,
              target: to,
              mode: CONNECTOR_MODE[spec.mode ?? 'curve'],
              stroke: strokeColor(spec.stroke),
              frontEndpointStyle: ends === 'start' || ends === 'both' ? 'Arrow' : 'None',
              rearEndpointStyle: ends === 'end' || ends === 'both' ? 'Arrow' : 'None',
              ...(spec.label ? { labelText: new Y.Text(spec.label) } : {}),
            }) ?? null;
            break;
          }

          case 'mindmap': {
            /**
             * THE WHOLE TREE IN ONE PROPERTY.
             *
             * `MindmapElementModel.propsToY` accepts a plain nested
             * `{ text, children }` and builds the shapes, the connectors and the
             * layout itself — so a mind map is a single spec rather than n
             * shapes the agent would have to position by hand. This is the one
             * element where doing it any other way produces something visibly
             * worse than what the toolbar makes.
             */
            id = crud.addElement('mindmap', {
              children: toMindmapNode(spec.tree, x, y),
              style: spec.style ?? 1,
              layoutType: spec.layout === 'left' ? 1 : spec.layout === 'balance' ? 2 : 0,
            }) ?? null;
            break;
          }

          case 'frame': {
            id = crud.addBlock(
              'affine:frame',
              {
                xywh: `[${x},${y},${w},${h}]`,
                title: new Text(spec.title ?? 'Frame'),
              },
              surface.id,
            ) ?? null;
            /**
             * A FRAME THAT OWNS WHAT IS IN IT, when the caller says what that is.
             *
             * Without `childElementIds` a frame is decoration: it looks like a
             * section and behaves like a rectangle sitting behind some notes, so
             * the user drags the section and the contents stay where they were.
             * `FrameBlockModel` has supported membership all along and the board
             * never set it — invisible, because `board_document` reads sections by
             * geometric containment and the export kept working.
             *
             * Resolved AFTER the batch, since a member may be a `ref` to something
             * later in the same array — see the adoption pass below.
             */
            if (id && spec.contains?.length) {
              framesToFill.push({ frameId: id, members: spec.contains, derive: derivedFrame });
            }
            break;
          }

          case 'link': {
            /**
             * A WEB PAGE AS A CARD — the reference that is not a file.
             *
             * Half of what someone puts on a mood board is a URL: a competitor's
             * ad, a Behance board, an article that made the point. Until the
             * bookmark block was registered there was nowhere for one to go — the
             * toolbar's own Link button was silently broken for the same reason
             * (see `extensions.store.ts`).
             *
             * `title`/`description` are set when given so the card reads as
             * something before its preview resolves — the preview is fetched by
             * the block itself and needs a network round trip, during which an
             * untitled card is a grey rectangle with a URL on it.
             */
            const url = String(spec.url ?? '').trim();
            if (!/^https?:\/\//i.test(url)) {
              problems.push(`"${url}" is not an http(s) url, so no link card was made.`);
              break;
            }
            id = crud.addBlock(
              'affine:bookmark',
              {
                url,
                style: 'horizontal',
                xywh: `[${x},${y},${spec.w ?? 400},${spec.h ?? 114}]`,
                ...(spec.title ? { title: spec.title } : {}),
                ...(spec.description ? { description: spec.description } : {}),
              },
              surface.id,
            ) ?? null;
            break;
          }

          case 'group': {
            const members = spec.members
              .map(m => ('ref' in m ? refs[m.ref] : m.id))
              .filter((v): v is string => !!v);
            if (members.length < 2) {
              problems.push('A group needs at least two members that exist.');
              break;
            }
            const children = new Y.Map<boolean>();
            members.forEach(m => children.set(m, true));
            id = crud.addElement('group', {
              children,
              title: new Y.Text(spec.title ?? ''),
              showTitle: !!spec.title,
            }) ?? null;
            break;
          }

          default:
            problems.push(`Unknown element kind "${(spec as { kind: string }).kind}".`);
        }
      } catch (err) {
        problems.push(`${spec.kind}: ${(err as Error)?.message ?? String(err)}`);
        id = null;
      }

      ids.push(id);
      if (id && spec.ref) refs[spec.ref] = id;
    }

  });

  /**
   * FRAME MEMBERSHIP, resolved AFTER the transaction and not inside it.
   *
   * `store.getBlock(id)` RETURNS UNDEFINED for a block created in the transaction
   * that is still open — models are materialised by a store observer, so the id is
   * real and the model is not there yet. Measured directly: a frame created and
   * looked up in one `transact` reports `frame? false`, and `addChild` is never
   * reached.
   *
   * The first version of this ran inside the transaction and appeared to work,
   * because the notes created after the frame flushed the store as a side effect —
   * so it passed for a frame declared BEFORE its contents and would have failed
   * silently for one declared after. Running it here does not depend on that.
   *
   * NO `captureSync()`, deliberately: these writes merge into the undo unit the
   * batch already opened, so `board_draw` keeps its one-call-one-undo promise —
   * the same argument `relaxOverlaps` makes two frames later.
   */
  /** Frames whose box is the bounding box of what they hold — fitted below, in
   *  the same deferred pass that resolves overlaps, because a note's height and
   *  a mind map's bounds are both decided after this function returns. */
  const derivedFrames: Array<{ frameId: string; memberIds: string[] }> = [];
  for (const pending of framesToFill) {
    const memberIds = pending.members
      .map(m => ('ref' in m ? refs[m.ref] : m.id))
      .filter((id): id is string => !!id);
    const missing = pending.members.length - memberIds.length;
    if (missing > 0) {
      problems.push(
        `${missing} member(s) of frame ${pending.frameId} could not be resolved, `
        + 'so the frame does not contain them.',
      );
    }
    if (!memberIds.length) continue;
    if (pending.derive) derivedFrames.push({ frameId: pending.frameId, memberIds });
    const adopted = adoptIntoFrame(std, pending.frameId, memberIds);
    if (adopted < memberIds.length) {
      problems.push(
        `Frame ${pending.frameId} took ${adopted} of ${memberIds.length} members, so `
        + 'dragging it will not move the rest.',
      );
    }
  }

  /**
   * RESOLVE OVERLAPS ONCE EVERYTHING HAS SIZED ITSELF.
   *
   * Deferred by two frames on purpose. A note's height is decided by AFFiNE
   * after it renders its children, and a mind map's bounds by its own layout
   * pass — so measuring inside the transaction would measure the sizes the
   * agent guessed rather than the sizes that happened.
   *
   * NO `captureSync()` before it, deliberately: that would open a second undo
   * unit and cost the user two Ctrl+Zs for one call. Within a couple of frames
   * the writes merge into the unit this batch already opened, so the promise
   * `board_draw` makes — one call, one undo — still holds.
   */
  const madeIds = ids.filter((id): id is string => !!id);
  if (madeIds.length) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (std.store.readonly) return;
      /**
       * THE BATCH MAY BE GONE BY NOW, and touching it if it is throws inside
       * Lit rather than here. Two frames is long enough for the user to hit
       * Ctrl+Z — the E2E does exactly that — and writing to a model whose host
       * has been detached surfaces as
       * "Cannot read properties of null (reading 'insertBefore')" from
       * `ChildPart._commitNode`, with a stack entirely inside lit and no hint
       * of what asked for it.
       *
       * If any part of the batch has vanished, the layout it belonged to is not
       * ours to tidy any more.
       */
      const stillHere = madeIds.every(id =>
        !!surface.getElementById(id) || !!std.store.getBlock(id));
      if (!stillHere) return;
      // ORDER MATTERS: clear the board's own region FIRST, then resolve the
      // batch's internal collisions at wherever it ended up. The other way
      // round tidies a layout and then moves the whole thing anyway.
      try { clearOfOwned(std, madeIds); } catch { /* never break a draw over layout */ }
      try { relaxOverlaps(std, madeIds); } catch { /* never break a draw over layout */ }
      // LAST, because it measures what the two passes above just moved. A frame
      // fitted before them wraps where its members USED to be.
      try { fitFramesToMembers(std, derivedFrames); } catch { /* layout is never fatal */ }
    }));
  }

  return { ids, refs, problems };
}

/**
 * ── NOTHING MAY LAND ON TOP OF ANYTHING ELSE ─────────────────────────────────
 *
 * THE FAILURE THIS FIXES, observed on a real board. The agent laid out a year of
 * journal entries as a timeline: nine month shapes evenly spaced, a note under
 * each, a mind map below them and a summary note beside it. The plan was good.
 * The result was unreadable, because two of those sizes are NOT KNOWABLE when
 * the call is written:
 *
 *   • a NOTE auto-grows to fit its text. The agent asked for 150×(unspecified)
 *     and AFFiNE made it 150×284 — measured. Everything the agent placed below,
 *     reasoning about a ~100px note, was then underneath a 284px one.
 *   • a MIND MAP lays ITSELF out. Its width and height are whatever the tree
 *     needs, and no caller can compute them in advance.
 *
 * So this is not something better prompting can fix — the information does not
 * exist at authoring time. The board has to resolve it after the fact.
 *
 * THE RULE: push DOWN, never sideways. Horizontal position almost always
 * carries meaning on a canvas — a timeline, a comparison, a left-to-right flow —
 * and nudging a month sideways to make room would destroy the one relationship
 * the layout was built to show. Vertical space is free and infinite.
 *
 * Earlier specs hold their ground and later ones move, because people write a
 * batch in the order they want it read.
 */
/**
 * ONLY THE ELEMENTS WHOSE SIZE THE AGENT COULD NOT HAVE KNOWN MAY BE MOVED.
 *
 * ── WHY THIS RESTRICTION EXISTS, AND WHAT IT COST TO LEARN ───────────────────
 * The first version moved anything that collided. Replayed against a real spec —
 * a title, a subtitle and nine month cards all at y=250, evenly spaced, with NO
 * overlaps anywhere — it moved the title down 72px, the subtitle 161px, and
 * split the row into two heights. It destroyed a correct layout.
 *
 * The reason is that a `text` element auto-sizes to its content, so the bounds
 * it reports are not the ones the spec asked for; a cascade then amplifies each
 * small discrepancy down the batch.
 *
 * The honest scope is much narrower than "resolve overlaps". Two kinds — and
 * only two — have a size the caller genuinely CANNOT predict:
 *
 *   note     grows to fit its text (measured: 150×100 requested → 150×284)
 *   mindmap  lays itself out; its bounds are whatever the tree needs
 *
 * Everything else — shapes, text, images, links — is placed at a size the agent
 * chose, and it chose it for a reason. If those overlap, that is the layout the
 * author asked for and it is not ours to redesign.
 */
const AUTO_SIZED = new Set(['affine:note']);

function isAutoSized(model: unknown): boolean {
  const m = model as { flavour?: string; type?: string };
  return (!!m.flavour && AUTO_SIZED.has(m.flavour)) || m.type === 'mindmap';
}

export function relaxOverlaps(std: BlockStdScope, createdIds: string[]): number {
  const gfx = std.get(GfxControllerIdentifier);
  const created = new Set(createdIds);

  const all: Array<{ id: string; model: GfxModel; box: Box; mine: boolean }> = [];
  for (const model of gfx.gfxElements as GfxModel[]) {
    if (isLayoutInert(model)) continue;
    const box = boundsOf(model);
    if (!box || !box.w || !box.h) continue;
    const id = (model as unknown as { id: string }).id;
    all.push({ id, model, box, mine: created.has(id) });
  }

  /**
   * EVERYTHING is an obstacle. Only the auto-sized things MOVE.
   *
   * That asymmetry is the whole design: a note that grew into a row of shapes
   * steps out of the way, and the row — which the agent positioned deliberately
   * — never budges.
   */
  const placed = all.filter(e => !e.mine || !isAutoSized(e.model)).map(e => e.box);
  const mine = all.filter(e => e.mine && isAutoSized(e.model))
    .sort((a, b) => createdIds.indexOf(a.id) - createdIds.indexOf(b.id));

  let moved = 0;
  for (const entry of mine) {
    let guard = 0;
    // Re-check from the top after each push: dropping below one obstacle can
    // land on another.
    while (guard++ < 200) {
      const hit = placed.find(p => overlaps(entry.box, p));
      if (!hit) break;
      entry.box = { ...entry.box, y: hit.y + hit.h + PUSH_GAP };
    }
    placed.push(entry.box);

    const original = boundsOf(entry.model)!;
    const dy = Math.round(entry.box.y) - Math.round(original.y);
    if (dy !== 0) {
      try {
        moveDown(gfx, entry.model, dy);
        moved++;
      } catch { /* deleted mid-pass — the next draw re-reads anyway */ }
    }
  }
  return moved;
}

/**
 * ── AN AGENT BATCH MAY NOT LAND ON THE STORYBOARD ────────────────────────────
 *
 * `relaxOverlaps` resolves collisions BETWEEN elements the agent made. It
 * cannot help with the other kind, and that is the one people report as "it
 * overwrote my board": a batch drawn straight on top of the filmstrip, the
 * screenplay, and the spine.
 *
 * Three separate reasons the agent cannot avoid this by itself:
 *
 *  • THE SPINE IS NOT ON THE CANVAS. Acts, sequences and scene brackets are an
 *    SVG overlay drawn in model space (`ui/spine.ts`) — deliberately, since a
 *    bracket is a statement ABOUT the board rather than a thing on it. So it
 *    appears in no read, and no layout pass can see it. Its labels sit in the
 *    gutter around the strip, which is exactly where a batch aimed near the
 *    strip ends up.
 *
 *  • `freeOrigin` ONLY APPLIES WHEN THE AGENT GIVES NO COORDINATES. The moment
 *    it lays out a designed page — a title, two frames side by side, notes
 *    inside them — every element carries an explicit x/y, and nothing then keeps
 *    the batch below the strip.
 *
 *  • `relaxOverlaps` MOVES ONLY NOTES AND MIND MAPS, for good reasons recorded
 *    below. A frame or a text label placed over a shot card is never moved.
 *
 * ── WHY THE WHOLE BATCH MOVES, AND NOTHING INSIDE IT ─────────────────────────
 * The internal geometry of a batch is the design: a title above two columns, a
 * row read left to right. Nudging individual members to clear the strip would
 * break exactly what `relaxOverlaps` learned the hard way not to break — so this
 * translates every element by the SAME dy. The layout arrives intact, just
 * lower. Nothing is ever moved sideways, and nothing moves up.
 */
export function clearOfOwned(std: BlockStdScope, createdIds: string[]): number {
  const gfx = std.get(GfxControllerIdentifier);
  const created = new Set(createdIds);

  const mine: Array<{ model: GfxModel; box: Box }> = [];
  for (const model of gfx.gfxElements as GfxModel[]) {
    const box = boundsOf(model);
    if (!box) continue;
    if (!created.has((model as unknown as { id: string }).id)) continue;
    // A group's children are created too; moving both would double the shift.
    if ((model as unknown as { group?: unknown }).group) continue;
    mine.push({ model, box });
  }

  // `ownedBand` already grows the strip by `SPINE_MARGIN`, which is the whole
  // reason this cannot be done from a read: the brackets and scene labels are an
  // SVG overlay and appear in no read at all.
  const band = ownedBand(std);
  if (!band || !mine.length) return 0;

  const batch = bboxOf(mine.map(m => m.box))!;
  if (!overlaps(batch, band)) return 0;

  // Down to just below the band. Never up: above the strip is where the user's
  // own earlier work tends to be, and a batch that jumps backwards past it is
  // no better than one that lands on the strip.
  const dy = band.y + band.h - batch.y;
  if (dy <= 0) return 0;

  for (const m of mine) moveDown(gfx as never, m.model, dy);
  return mine.length;
}

/**
 * Register members on a frame.
 *
 * Through the model's own `addChild` when it has one — AFFiNE maintains
 * `childElementIds` as a plain record and the method is what keeps presentation
 * order and the surface index in step. The direct write is the fallback for a
 * model shape that does not expose it, rather than the first choice.
 */
export function adoptIntoFrame(
  std: BlockStdScope,
  frameId: string,
  memberIds: string[],
): number {
  const frame = std.store.getBlock(frameId)?.model as unknown as {
    addChild?: (el: unknown) => void;
    props?: { childElementIds?: Record<string, boolean> };
  } | undefined;
  /**
   * A MISSING FRAME MEANS THE CALLER IS STILL INSIDE THE TRANSACTION THAT MADE IT.
   *
   * `store.getBlock` cannot see a block whose transaction has not committed, so
   * this returned 0 and the frame ended up decorative — with no error anywhere,
   * which is how the original version shipped looking like it worked. The count is
   * returned so a caller can say so; see the note at both call sites.
   */
  if (!frame) return 0;

  const gfx = std.get(GfxControllerIdentifier);
  let added = 0;

  for (const id of memberIds) {
    const el = gfx.surface?.getElementById(id) ?? std.store.getBlock(id)?.model;
    if (!el) continue;
    if (typeof frame.addChild === 'function') {
      // AFFiNE's own door. It refuses a cycle (`canSafeAddToContainer`) and keeps
      // the surface index in step, neither of which a direct write would do.
      frame.addChild(el);
    } else if (frame.props) {
      frame.props.childElementIds = { ...(frame.props.childElementIds ?? {}), [id]: true };
    } else {
      continue;
    }
    added++;
  }
  return added;
}

/**
 * A plain tree in the shape the mindmap element wants.
 *
 * Positions are only needed on the ROOT — the element lays the rest out itself,
 * which is exactly why a mind map is worth having as a primitive rather than as
 * a pile of shapes and arrows.
 */
function toMindmapNode(
  tree: MindmapTree,
  x: number,
  y: number,
): { text: string; xywh: string; children: unknown[] } {
  const build = (node: MindmapTree, depth: number): { text: string; children: unknown[] } => ({
    text: String(node.text ?? '').slice(0, 200),
    children: (node.children ?? []).slice(0, 24).map(c => build(c, depth + 1)),
  });
  const root = build(tree, 0);
  return { ...root, xywh: `[${x},${y},180,60]` };
}

// ── Editing ──────────────────────────────────────────────────────────────────

export type EditOp =
  | { id: string; op: 'move'; x: number; y: number }
  | { id: string; op: 'resize'; w: number; h: number }
  | { id: string; op: 'text'; text: string }
  | { id: string; op: 'color'; fill?: string; stroke?: string }
  | { id: string; op: 'delete' };

export interface EditResult {
  changed: number;
  problems: string[];
}

/**
 * Apply a batch of changes to things already on the canvas, as ONE undo step.
 *
 * REFUSES THE BOARD'S OWN BLOCKS. A shot is not canvas furniture — it has its
 * own tools, its own validation and its own layout rule (the filmstrip IS the
 * order), so letting a generic `move` drag one would silently renumber the film.
 * Saying so is better than a special case that half-works.
 */
export function editCanvas(std: BlockStdScope, ops: EditOp[]): EditResult {
  const crud = std.get(EdgelessCRUDIdentifier);
  const gfx = std.get(GfxControllerIdentifier);
  const surface = gfx.surface;
  const problems: string[] = [];
  let changed = 0;

  if (!surface) return { changed: 0, problems: ['The canvas is not ready yet.'] };

  std.store.captureSync();
  std.store.transact(() => {
    for (const op of ops) {
      const element = surface.getElementById(op.id);
      const block = element ? null : std.store.getBlock(op.id);
      const model = (element ?? block?.model) as
        | (GfxModel & { flavour?: string; xywh?: string })
        | undefined;

      if (!model) {
        problems.push(`Nothing on the canvas with id ${op.id}.`);
        continue;
      }
      if (block && OWNED_FLAVOURS.has(block.flavour)) {
        problems.push(
          `${op.id} is a ${kindOf(block.model)} — it has its own tools. `
          + 'Use board_update_shot, board_reorder_shots or board_delete_shot instead.',
        );
        continue;
      }

      try {
        if (op.op === 'delete') {
          crud.deleteElements([model as GfxModel]);
          changed++;
          continue;
        }

        const bound = boundsOf(model);
        const patch: Record<string, unknown> = {};

        if (op.op === 'move' && bound) {
          patch.xywh = `[${op.x},${op.y},${bound.w},${bound.h}]`;
        } else if (op.op === 'resize' && bound) {
          patch.xywh = `[${bound.x},${bound.y},${Math.max(1, op.w)},${Math.max(1, op.h)}]`;
        } else if (op.op === 'text') {
          // A note keeps its words in child blocks, so "set the text" means
          // replacing them — an in-place edit of a Y.Text would append.
          if (block?.flavour === 'affine:note') {
            [...block.model.children].forEach(c => std.store.deleteBlock(c));
            fillNote(std, op.id, op.text);
            changed++;
            continue;
          }
          patch.text = new Y.Text(op.text);
        } else if (op.op === 'color') {
          if (block?.flavour === 'affine:note') {
            patch.background = noteColor(op.fill);
          } else {
            if (op.fill) patch.fillColor = fillColor(op.fill);
            if (op.stroke) patch.strokeColor = strokeColor(op.stroke);
            // A connector has one colour and calls it `stroke`.
            if ((model as { type?: string }).type === 'connector') {
              patch.stroke = strokeColor(op.stroke ?? op.fill);
              delete patch.fillColor;
              delete patch.strokeColor;
            }
          }
        }

        if (!Object.keys(patch).length) {
          problems.push(`Nothing to change on ${op.id} for "${op.op}".`);
          continue;
        }

        if (element) crud.updateElement(op.id, patch);
        else std.store.updateBlock(block!.model, patch);
        changed++;
      } catch (err) {
        problems.push(`${op.id}: ${(err as Error)?.message ?? String(err)}`);
      }
    }
  });

  return { changed, problems };
}

/**
 * ── FIT A FRAME AROUND WHAT IT HOLDS ─────────────────────────────────────────
 *
 * A frame that names its members has no coordinates worth asking the caller
 * for: it wraps notes, a note's height is decided by AFFiNE after it renders,
 * and `relaxOverlaps` may have pushed half of them down afterwards. The box can
 * only be computed here, once everything has settled.
 *
 * Without this, a `contains` frame drawn without coordinates was allocated a
 * slot in the flow like any other element and given the default 900x600 — so a
 * seven-section board came out as seven empty titled rectangles in a column
 * down the left, with every note it should have gathered sitting outside them.
 *
 * The geometry matches `makeFrame` in `arrange.ts` deliberately: one pad all
 * round, plus room above for the title bar, which AFFiNE draws OUTSIDE the box.
 * Two ways to draw a section must not produce two different looking sections.
 */
export function fitFramesToMembers(
  std: BlockStdScope,
  frames: ReadonlyArray<{ frameId: string; memberIds: string[] }>,
): number {
  if (!frames.length) return 0;
  const gfx = std.get(GfxControllerIdentifier);
  const surface = gfx.surface;
  if (!surface) return 0;

  /** Same pad and title bar as `arrange.ts` — see the note above. */
  const PAD = 56;
  const TITLE_H = 48;
  let fitted = 0;

  for (const { frameId, memberIds } of frames) {
    const frame = std.store.getBlock(frameId)?.model as unknown as {
      xywh?: string;
    } | undefined;
    if (!frame) continue;

    const boxes = memberIds
      .map(id => surface.getElementById(id) ?? std.store.getBlock(id)?.model)
      .map(el => (el ? boundsOf(el) : null))
      .filter((b): b is Box => !!b);
    if (!boxes.length) continue;

    const b = bboxOf(boxes);
    if (!b) continue;

    const x = Math.round(b.x - PAD);
    const y = Math.round(b.y - PAD - TITLE_H);
    const w = Math.round(b.w + PAD * 2);
    const h = Math.round(b.h + PAD * 2 + TITLE_H);
    // Written through the model rather than the CRUD helper: the frame already
    // exists and this is a resize, so it merges into the undo unit the batch
    // opened. One call is still one Ctrl+Z.
    frame.xywh = `[${x},${y},${w},${h}]`;
    fitted++;
  }
  return fitted;
}
