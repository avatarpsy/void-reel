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

import { SHOT_H } from '../shot/model';
import { readBlockMeta } from './board-meta';
import { decodeMediaRef } from './media-ref';

/** Blocks the board owns and manages elsewhere. Reported as ANCHORS (so an arrow
 *  can point at a shot) but never as canvas furniture to be restyled or moved. */
const OWNED_FLAVOURS = new Set([
  'voidspace:shot',
  'voidspace:screenplay',
  'voidspace:blockdraft',
]);

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
  | (Common & { kind: 'frame'; title?: string })
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
 * Somewhere clear to put a batch that did not say where it wanted to go.
 *
 * BELOW the filmstrip, not beside it. The strip grows to the right forever, so
 * anything placed at "the right-hand edge" is in the way of the next shot; the
 * band underneath is empty by construction and is where a person doodles anyway.
 */
function freeOrigin(std: BlockStdScope): { x: number; y: number } {
  const gfx = std.get(GfxControllerIdentifier);
  let bottom = SHOT_H + 160;
  let left = 0;
  let any = false;

  for (const model of gfx.gfxElements as GfxModel[]) {
    const bound = boundsOf(model);
    if (!bound) continue;
    if (!any) { left = bound.x; any = true; }
    left = Math.min(left, bound.x);
    bottom = Math.max(bottom, bound.y + bound.h + 160);
  }
  return { x: left, y: bottom };
}

function boundsOf(model: unknown): { x: number; y: number; w: number; h: number } | null {
  const raw = (model as { xywh?: string })?.xywh;
  if (typeof raw !== 'string') return null;
  try {
    const [x, y, w, h] = JSON.parse(raw) as number[];
    return { x, y, w, h };
  } catch {
    return null;
  }
}

/** Default size per kind, so a spec only has to say what it IS. */
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

  return { total, kinds, frames, notes };
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

  if (!surface || !rootId) {
    return { ids: specs.map(() => null), refs, problems: ['The canvas is not ready yet.'] };
  }

  const origin = freeOrigin(std);
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
      const w = spec.w ?? size.w;
      const h = spec.h ?? size.h;
      const placed = spec.x === undefined || spec.y === undefined;
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
      try { relaxOverlaps(std, madeIds); } catch { /* never break a draw over layout */ }
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
interface Box { x: number; y: number; w: number; h: number }

/**
 * TRUE GEOMETRIC OVERLAP, with no tolerance — and the tolerance is exactly what
 * made this dangerous.
 *
 * The first version tested with the same 40px padding it used when separating
 * things, so two elements merely CLOSE to each other counted as a collision. On
 * the journal timeline the notes were 150 wide under shapes 130 wide at 168px
 * intervals, leaving 28px between a note and the next month's shape — under the
 * threshold. Every second month was shunted down and a deliberate row became a
 * staircase. Worse than the overlap it replaced, because the overlap was
 * obviously wrong and the staircase looks like a decision.
 *
 * Detect real intersection; add breathing room only when actually moving
 * something. A layout that does not overlap is never touched.
 */
function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w
    && a.x + a.w > b.x
    && a.y < b.y + b.h
    && a.y + a.h > b.y;
}

/** Elements that must never be moved, and never push anything. */
function isLayoutInert(model: unknown): boolean {
  const m = model as { flavour?: string; type?: string; group?: unknown };
  // A FRAME is a container — it is SUPPOSED to sit under its contents, and
  // treating that as a collision would launch every framed board into space.
  if (m.flavour === 'affine:frame') return true;
  // A CONNECTOR has no position of its own; it follows its endpoints.
  if (m.type === 'connector') return true;
  // Anything inside a group (a mind map's nodes) is positioned BY the group.
  // Moving one node individually would tear the tree apart.
  if (m.group) return true;
  return false;
}

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

/** Breathing room added when something IS moved. Never used for detection. */
const PUSH_GAP = 32;

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
 * Shift one element down by `dy`.
 *
 * A GROUP — which is what a mind map is — CANNOT be moved by writing its `xywh`.
 * `GfxGroupLikeElementModel` defines `set xywh(_) {}`: an empty setter, because
 * a group's bounds are DERIVED from its children every time they are read. So
 * the obvious implementation silently does nothing, and the mind map stays
 * exactly where it was overlapping.
 *
 * BlockSuite's own drag handles this by expanding to `childElements` and moving
 * each one (`mind-map-drag.ts`), and so does this.
 */
function moveDown(
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
