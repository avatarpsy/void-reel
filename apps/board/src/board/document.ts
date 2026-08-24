/**
 * The board, read as a DOCUMENT.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────
 * People think on a canvas and then need to send the result to somebody. Until
 * now the only way out of a board was `compile_to_video`, so an afternoon of
 * planning, research or analysis had exactly one destination — a film — and
 * every other kind of work ended as pixels the user had to retype somewhere
 * else. That is the whole gap: the board was excellent at collect and arrange
 * and had no produce.
 *
 * ── WHY FRAMES ARE THE STRUCTURE, AND NOT A NEW ONE ──────────────────────────
 * A document needs sections and an order, and the temptation is to invent a way
 * to declare them — tags, an outline panel, a "section" block. All of that is
 * admin work at the moment the user has least patience for it, which is the same
 * reasoning that got the canvas tag system withdrawn (BOARD_CREATIVE_PLATFORM_
 * PLAN §4.1).
 *
 * People already group on a canvas by putting like things near each other and
 * drawing a frame round them. So: **a frame is a section, what sits inside it is
 * that section's content, and reading order is top-to-bottom then left-to-right**
 * — exactly how the board already looks. Nothing new to learn, nothing to keep
 * in step, and rearranging the document is dragging a frame.
 *
 * A board with NO frames still exports fine: everything is loose, in reading
 * order, which is what a quick brainstorm should produce.
 *
 * ── WHAT IS DELIBERATELY LEFT OUT ────────────────────────────────────────────
 * `owned` blocks — shots, the screenplay, block drafts. The screenplay has its
 * own exporter with real screenplay typography (`ui/screenplay-focus.ts`), and a
 * filmstrip flattened into prose is noise in a document. They are reported to
 * the caller as a COUNT so the UI can say "3 shots were not included" rather
 * than silently dropping work — a silent omission reads as a broken export.
 *
 * Connectors, brush strokes and groups are also skipped: an arrow's meaning is
 * its position, and there is no honest prose for it.
 */
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';
import type { GfxModel } from '@blocksuite/std/gfx';
import type { BlockStdScope } from '@blocksuite/std';

import { mediaUrlOf } from './canvas';
import { perRev } from './doc-cache';

/** A frame, or the trailing catch-all for everything outside one. */
export interface DocSection {
  /** The frame's title. Empty for the catch-all. */
  title: string;
  /** Markdown chunks, in reading order. */
  chunks: string[];
}

export interface BoardDocument {
  title: string;
  sections: DocSection[];
  /** Shots/screenplay left out on purpose — surfaced so the UI can say so. */
  omittedOwned: number;
  /** True when the board had no frames, so the order is purely positional. */
  unframed: boolean;
}

interface Placed {
  id: string;
  kind: string;
  model: GfxModel;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Elements whose meaning is their position, not their text. */
const SKIP_KINDS = new Set(['connector', 'brush', 'group']);

/** Blocks the board manages with its own tools and exports elsewhere. */
const OWNED_KINDS = new Set(['shot', 'screenplay', 'block-draft']);

// ── reading the tree ─────────────────────────────────────────────────────────

/**
 * A Y.Text's marks, as markdown.
 *
 * `String(yText)` throws the formatting away, and a model writes `**bold**`
 * whether asked to or not — so a note that reads correctly on the canvas would
 * export as flat prose with the emphasis silently gone. Deltas are the only
 * place that information exists.
 */
function inlineMarkdown(text: unknown): string {
  const delta = (text as { toDelta?: () => Array<{ insert?: string; attributes?: Record<string, unknown> }> })
    ?.toDelta?.();
  if (!Array.isArray(delta)) return text ? String(text) : '';

  return delta.map((op) => {
    let s = typeof op.insert === 'string' ? op.insert : '';
    if (!s) return '';
    const a = op.attributes ?? {};
    // Innermost first, so `**_x_**` nests rather than interleaving.
    if (a.code) s = `\`${s}\``;
    if (a.italic) s = `*${s}*`;
    if (a.bold) s = `**${s}**`;
    if (a.strike) s = `~~${s}~~`;
    const link = (a.link ?? (a as { reference?: unknown }).reference) as string | undefined;
    if (typeof link === 'string' && link) s = `[${s}](${link})`;
    return s;
  }).join('');
}

function propsOf(model: unknown): Record<string, any> {
  return ((model as { props?: Record<string, any> })?.props ?? {}) as Record<string, any>;
}

/**
 * One block of a note, as markdown lines.
 *
 * Covers the block set this board actually registers (see
 * `blocksuite/extensions.store.ts`). An unregistered flavour cannot appear, and
 * an unknown one degrades to its text rather than vanishing — losing a
 * paragraph is worse than losing its styling.
 */
function blockMarkdown(
  std: BlockStdScope,
  blockId: string,
  depth = 0,
  headingOffset = 0,
): string[] {
  const block = std.store.getBlock(blockId);
  if (!block) return [];
  const model = block.model as unknown as { flavour?: string; children?: Array<{ id: string }> };
  const p = propsOf(block.model);
  const pad = '  '.repeat(depth);
  const out: string[] = [];
  const text = () => inlineMarkdown(p.text);

  switch (model.flavour) {
    case 'affine:paragraph': {
      const type = String(p.type ?? 'text');
      if (type === 'quote') {
        out.push(`${pad}> ${text()}`);
      } else if (/^h[1-6]$/.test(type)) {
        /**
         * DEMOTED BENEATH THE SECTION IT SITS IN.
         *
         * A note writes its own headings starting at `#`, which is correct on a
         * canvas where the note is the whole document. Dropped verbatim into a
         * section it produces `<h1>Cost</h1>` nested under `<h2>Risks</h2>` —
         * the subsection outranking its own parent, so in a printed PDF or a
         * Word import "Cost" is set larger than the section containing it.
         *
         * Observed in a browser against a real board; it cannot show up in a
         * test that renders one note on its own.
         */
        const level = Math.min(6, Number(type[1]) + headingOffset);
        out.push(`${pad}${'#'.repeat(level)} ${text()}`);
      } else {
        out.push(`${pad}${text()}`);
      }
      break;
    }
    case 'affine:list': {
      const type = String(p.type ?? 'bulleted');
      const marker = type === 'numbered' ? '1.'
        : type === 'todo' ? `- [${p.checked ? 'x' : ' '}]`
        : '-';
      out.push(`${pad}${marker} ${text()}`);
      break;
    }
    case 'affine:divider':
      out.push(`${pad}---`);
      break;
    case 'affine:callout':
      // Rendered as a quote: markdown has no callout, and a quote is the one
      // construct every reader and every Word importer understands.
      out.push(`${pad}> ${text()}`);
      break;
    case 'affine:image':
      // `sourceId` is an ENCODED MEDIA REF, not a url — see `mediaUrlOf`. Written
      // straight into markdown it produces `![](voidspace:...)`, which is a
      // broken image in every reader, and broken in a way that looks like the
      // picture simply did not export.
      out.push(`${pad}![](${mediaUrlOf(std, blockId) ?? ''})`);
      break;
    default:
      if (p.text) out.push(`${pad}${text()}`);
      break;
  }

  // A list nests, a callout holds its body, a paragraph can hold children.
  const nested = model.flavour === 'affine:list' || model.flavour === 'affine:callout' ? depth + 1 : depth;
  for (const child of model.children ?? []) {
    out.push(...blockMarkdown(std, child.id, nested, headingOffset));
  }
  return out;
}

/**
 * A mind map as a nested list.
 *
 * This is the element where the canvas and the page disagree most and where the
 * translation is most worth doing: a mind map IS an outline that happens to be
 * drawn radially, so it becomes the one thing in a document that a radial
 * picture cannot be — something you can read in order.
 */
function mindmapMarkdown(model: unknown): string[] {
  const root = (model as { tree?: any })?.tree;
  if (!root) return [];
  const out: string[] = [];
  const walk = (node: any, depth: number): void => {
    if (!node) return;
    const label = inlineMarkdown(node.element?.text).trim();
    if (label) out.push(`${'  '.repeat(depth)}- ${label}`);
    for (const child of node.children ?? []) walk(child, depth + (label ? 1 : 0));
  };
  walk(root, 0);
  return out;
}

/** One canvas element, as a markdown chunk. Empty string = contributes nothing. */
function elementMarkdown(std: BlockStdScope, item: Placed, headingOffset = 0): string {
  const p = propsOf(item.model);

  switch (item.kind) {
    case 'note':
    case 'text': {
      const children = (item.model as unknown as { children?: Array<{ id: string }> }).children ?? [];
      const lines = children.flatMap((c) => blockMarkdown(std, c.id, 0, headingOffset));
      return lines.join('\n').trim();
    }
    case 'mindmap':
      return mindmapMarkdown(item.model).join('\n').trim();
    // Both go through `mediaUrlOf`, which prefers the ORIGINAL url recorded in
    // `boardMeta` and falls back to decoding the media ref. Reading `sourceId`
    // directly yields an encoded ref that renders as a broken image.
    case 'image':
      return `![](${mediaUrlOf(std, item.id) ?? ''})`;
    case 'media':
      return `[${String(p.name ?? 'attachment')}](${mediaUrlOf(std, item.id) ?? ''})`;
    case 'link':
      return `[${String(p.title || p.url || 'link')}](${String(p.url ?? '')})`;
    default: {
      // Shapes and anything else that carries words: the words are the point.
      const t = inlineMarkdown(p.text ?? (item.model as { text?: unknown }).text).trim();
      return t;
    }
  }
}

// ── assembling ───────────────────────────────────────────────────────────────

function boundsOf(model: GfxModel): { x: number; y: number; w: number; h: number } | null {
  const b = (model as unknown as { elementBound?: any; xywh?: string }).elementBound;
  if (b && typeof b.x === 'number') return { x: b.x, y: b.y, w: b.w, h: b.h };
  const raw = (model as unknown as { xywh?: string }).xywh;
  if (typeof raw === 'string') {
    const [x, y, w, h] = JSON.parse(raw) as number[];
    return { x: x!, y: y!, w: w!, h: h! };
  }
  return null;
}

/**
 * Reading order: down the page, then across.
 *
 * ROW BANDING, and it is the part that makes this feel right rather than
 * technically correct. A strict `y` sort turns three cards laid out side by side
 * — which is a person saying "these are alternatives" — into three sections,
 * because their tops differ by eleven pixels. So anything whose top is within a
 * tolerance of the current row counts as the SAME row and is ordered left to
 * right, which is how the arrangement was meant to be read.
 */
const ROW_TOLERANCE = 120;

function readingOrder<T extends { x: number; y: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => (
    Math.abs(a.y - b.y) > ROW_TOLERANCE ? a.y - b.y : a.x - b.x
  ));
}

/** True when the element's CENTRE is inside the frame — not its whole box, so a
 *  note that pokes out of a frame still belongs to it, which is what the user
 *  sees and therefore what they mean. */
function inside(item: Placed, frame: Placed): boolean {
  const cx = item.x + item.w / 2;
  const cy = item.y + item.h / 2;
  return cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h;
}

/**
 * MEMOISED PER DOCUMENT REVISION, and it is not an optimisation.
 *
 * The document view repaints on `blockUpdated` so the page moves while the agent
 * works — and `blockUpdated` fires on every pointermove of a drag. Unmemoised,
 * dragging one note on a 200-item board re-walked every element, re-resolved
 * every frame's contents (O(n·frames)) and re-serialised every note's child
 * blocks PER FRAME. That is the exact arithmetic `doc-cache.ts` was written for
 * after it made the board sluggish once already.
 *
 * The title is applied OUTSIDE the cache: it is an argument, and a per-argument
 * cache tag is a cache with no bound. Sections are copied out rather than shared,
 * because a cached array handed to a caller is a live handle they can write into.
 */
export function boardDocument(std: BlockStdScope, title = ''): BoardDocument {
  const cached = perRev(std, 'board-document', () => buildDocument(std));
  return {
    title,
    sections: cached.sections.map(s => ({ title: s.title, chunks: [...s.chunks] })),
    omittedOwned: cached.omittedOwned,
    unframed: cached.unframed,
  };
}

function buildDocument(std: BlockStdScope): Omit<BoardDocument, 'title'> {
  const gfx = std.get(GfxControllerIdentifier);
  const placed: Placed[] = [];
  let omittedOwned = 0;

  for (const model of gfx.gfxElements as GfxModel[]) {
    const m = model as unknown as { id: string; flavour?: string; type?: string };
    const kind = kindOfModel(m);
    if (OWNED_KINDS.has(kind)) { omittedOwned++; continue; }
    if (SKIP_KINDS.has(kind)) continue;
    const b = boundsOf(model);
    if (!b) continue;
    placed.push({ id: m.id, kind, model, ...b });
  }

  const frames = readingOrder(placed.filter((i) => i.kind === 'frame'));
  const content = placed.filter((i) => i.kind !== 'frame');

  const sections: DocSection[] = [];
  const claimed = new Set<string>();

  for (const frame of frames) {
    // Smallest containing frame wins, so a frame nested inside another does not
    // steal its parent's contents — otherwise a "Risks" box drawn inside an
    // "Options" box would empty the section around it.
    const own = readingOrder(content.filter((i) => {
      if (claimed.has(i.id)) return false;
      if (!inside(i, frame)) return false;
      const smaller = frames.find((f) => f !== frame && inside(i, f)
        && f.w * f.h < frame.w * frame.h);
      return !smaller;
    }));
    own.forEach((i) => claimed.add(i.id));
    // 2: the document title is `#` and a section heading is `##`, so a note's
    // own `#` has to start at `###` to sit beneath the frame it is inside.
    const chunks = own.map((i) => elementMarkdown(std, i, 2)).filter(Boolean);
    const heading = inlineMarkdown(propsOf(frame.model).title
      ?? (frame.model as unknown as { title?: unknown }).title).trim();
    sections.push({ title: heading || 'Untitled section', chunks });
  }

  const loose = readingOrder(content.filter((i) => !claimed.has(i.id)));
  if (loose.length) {
    // 1: loose content sits under the document title but inside no section, so
    // it is demoted one level rather than two.
    const chunks = loose.map((i) => elementMarkdown(std, i, 1)).filter(Boolean);
    if (chunks.length) {
      // Named, not silently appended: if something the user expected in a
      // section lands here, the heading is what tells them the frame missed it.
      sections.push({ title: frames.length ? 'Elsewhere on the board' : '', chunks });
    }
  }

  return { sections, omittedOwned, unframed: frames.length === 0 };
}

/** `kindOf` is private to canvas.ts and this needs the same vocabulary; keeping
 *  one small copy beats exporting an internal and letting the two drift. */
function kindOfModel(model: { flavour?: string; type?: string }): string {
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

export function documentMarkdown(doc: BoardDocument): string {
  const out: string[] = [];
  if (doc.title) out.push(`# ${doc.title}`, '');
  for (const section of doc.sections) {
    if (section.title) out.push(`## ${section.title}`, '');
    for (const chunk of section.chunks) out.push(chunk, '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
