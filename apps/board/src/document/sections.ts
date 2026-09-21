/**
 * A document, addressable by section — so a long one can be read and changed
 * without moving all of it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE PROBLEM THIS EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════════
 * `create_document` could write a document and nothing could read one back or
 * revise it. The only tools that reached a note were `board_canvas_read` with
 * `full: true`, which returns the WHOLE text unbounded, and `board_edit_canvas`,
 * which REPLACES the whole text. On a 61-page report — measured at 21,000 words
 * — changing one paragraph therefore meant pulling 21,000 words into context
 * and sending 21,000 back. It worked and it did not scale, which is the same
 * thing as being broken for the documents people actually keep.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE FOUR RULES IT IS BUILT ON
 * ══════════════════════════════════════════════════════════════════════════
 * 1. OUTLINE FIRST, BODY ON DEMAND. The cheap complete index is always
 *    affordable; the text is fetched per section. Same shape as `read_document`
 *    for files and the screenplay map for scripts — the only access pattern in
 *    this codebase that stays affordable as the thing grows.
 *
 * 2. SECTIONS ARE ADDRESSED BY BLOCK ID, NOT BY INDEX OR HEADING TEXT. An
 *    index shifts the moment anything above it is inserted or deleted, and a
 *    heading is neither unique nor stable — rename it and every address the
 *    caller is holding goes stale, silently, pointing at the wrong section
 *    rather than at none. A block id survives every edit to its neighbours.
 *
 * 3. A READ SAYS WHAT IT LEFT OUT. Truncation that is not reported is a caller
 *    confidently summarising a document it has seen half of.
 *
 * 4. EDITS ARE SCOPED TO A SECTION. Replacing one costs one, so the cost of a
 *    change is proportional to the change and not to the document.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT COUNTS AS A SECTION
 * ══════════════════════════════════════════════════════════════════════════
 * A heading, plus everything after it until the next heading of the SAME OR
 * HIGHER level. So `##` owns the `###`s beneath it and ends at the next `##`.
 * That is how everyone reads a document, and it means "replace section 2" takes
 * its subsections with it, which is what the caller meant.
 *
 * Anything before the first heading is a real section too — the preamble — and
 * it is addressable like the rest, because a document that opens with two
 * paragraphs before its first heading is common and those paragraphs must be
 * editable.
 */
import type { MountedBoard } from '../blocksuite/editor';

/** Paragraph `type` values that are headings, in depth order. */
const HEADING_TYPES = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

function headingLevel(model: any): number {
  if (model?.flavour !== 'affine:paragraph') return 0;
  const i = HEADING_TYPES.indexOf(model?.props?.type ?? model?.type);
  return i === -1 ? 0 : i + 1;
}

function textOf(model: any): string {
  return String(model?.text?.toString?.() ?? '').trim();
}

function wordsIn(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

export interface DocumentSection {
  /** The heading block's id — STABLE across edits to other sections. */
  id: string;
  /** 1–6, or 0 for the preamble before the first heading. */
  level: number;
  /** The heading text; '' for the preamble. */
  heading: string;
  words: number;
  /** How many blocks it spans, heading included. */
  blocks: number;
}

interface Range extends DocumentSection {
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * The two spans differ by ONE rule, so they are one function.
 *
 * `nested` (the default) is what a section MEANS: a heading owns everything
 * until the next heading of the same or higher level, so replacing `## Findings`
 * takes `### Detail` with it. Ranges therefore overlap, and every edit is
 * written knowing that.
 *
 * `flat` cuts at EVERY heading instead, giving small non-overlapping pieces.
 * That is the shape a whole-document read needs, and nesting is wrong for it
 * twice over: summing all sections emits the nested ones twice, and taking only
 * the shallowest gives one chunk the size of the document, because almost every
 * document has a single `#` title that owns the entire body. Measured — a
 * forty-section report came back whole against a 4,000-character budget.
 */
function spans(board: MountedBoard, noteId: string, mode: 'nested' | 'flat' = 'nested'): Range[] {
  const note: any = board.store.getBlock(noteId)?.model;
  const kids: any[] = note?.children ?? [];
  if (!kids.length) return [];

  const heads = kids
    .map((kid, i) => ({ i, level: headingLevel(kid) }))
    .filter((h) => h.level > 0);

  const make = (start: number, end: number, level: number, heading: string): Range => ({
    id: String(kids[start]!.id),
    level,
    heading,
    words: kids.slice(start, end).reduce((n, k) => n + wordsIn(textOf(k)), 0),
    blocks: end - start,
    start,
    end,
  });

  const out: Range[] = [];
  // Whatever comes before the first heading — a document often opens with prose,
  // and those paragraphs have to be addressable like everything else.
  const firstHeading = heads[0]?.i ?? kids.length;
  if (firstHeading > 0) out.push(make(0, firstHeading, 0, ''));

  heads.forEach((h, n) => {
    const end = mode === 'flat'
      ? heads[n + 1]?.i ?? kids.length
      : heads.find((x) => x.i > h.i && x.level <= h.level)?.i ?? kids.length;
    out.push(make(h.i, end, h.level, textOf(kids[h.i])));
  });
  return out;
}

const ranges = (board: MountedBoard, noteId: string): Range[] => spans(board, noteId, 'nested');
const chunks = (board: MountedBoard, noteId: string): Range[] => spans(board, noteId, 'flat');

/** Drop any range wholly inside another, so a parent and its child read once. */
function dropContained(picked: Range[]): Range[] {
  return picked.filter((s) => !picked.some((o) => o !== s && o.start <= s.start && o.end >= s.end));
}

/** The cheap, complete index. Never truncated — this is what makes the rest affordable. */
export function outline(board: MountedBoard, noteId: string): DocumentSection[] {
  return ranges(board, noteId).map(({ id, level, heading, words, blocks }) =>
    ({ id, level, heading, words, blocks }));
}

export interface DocumentSummary {
  noteId: string;
  title: string;
  words: number;
  sections: number;
}

/**
 * Every document on the board.
 *
 * A board can hold several — a brief, its research, the plan that came out of
 * them — so nothing here may assume "the" document. Notes with no words are
 * left out: an empty sticky is not a document, and listing it as one sends the
 * caller reading blank pages.
 */
export function listDocuments(board: MountedBoard): DocumentSummary[] {
  const root: any = board.store.root;
  const out: DocumentSummary[] = [];
  for (const child of root?.children ?? []) {
    if (child.flavour !== 'affine:note') continue;
    const secs = ranges(board, String(child.id));
    const words = secs.reduce((n, s) => n + s.words, 0);
    if (!words) continue;
    const firstHeading = secs.find((s) => s.level > 0 && s.heading);
    const firstText = (child.children ?? []).map(textOf).find(Boolean) ?? '';
    out.push({
      noteId: String(child.id),
      title: firstHeading?.heading || firstText.slice(0, 120),
      words,
      sections: secs.length,
    });
  }
  return out;
}

export interface SearchHit {
  /** The section the match is in — pass it straight back to read or edit it. */
  id: string;
  heading: string;
  /** The matching line, trimmed, so the caller can judge without a second read. */
  line: string;
  /** 1-based, among the matches. */
  n: number;
}

/**
 * GREP, for a document.
 *
 * The outline tells you a document's shape; it cannot tell you where a word is.
 * Without this, "what does it say about pricing" on a sixty-page report means
 * reading the whole thing to find two sentences — which is precisely the cost
 * this module exists to avoid, reintroduced by the one question people ask most.
 *
 * It returns the SECTION ID with every hit, so a search leads directly into a
 * bounded read or an edit of exactly the right place.
 */
export async function searchDocument(
  board: MountedBoard,
  noteId: string,
  needle: string,
  opts: { max?: number } = {},
): Promise<SearchHit[]> {
  const term = String(needle ?? '').trim().toLowerCase();
  if (!term) return [];
  const { sliceToMarkdown } = await import('./note-io');
  const note: any = board.store.getBlock(noteId)?.model;
  const kids: any[] = note?.children ?? [];
  const max = opts.max ?? 40;

  const out: SearchHit[] = [];
  // Flat chunks, so every hit is attributed to the NEAREST heading rather than
  // to whichever ancestor happens to contain it.
  for (const chunk of chunks(board, noteId)) {
    const md = await sliceToMarkdown(board, kids.slice(chunk.start, chunk.end));
    for (const line of md.split('\n')) {
      if (!line.toLowerCase().includes(term)) continue;
      out.push({
        id: chunk.id,
        heading: chunk.heading,
        line: line.trim().slice(0, 240),
        n: out.length + 1,
      });
      if (out.length >= max) return out;
    }
  }
  return out;
}

export interface ReadResult {
  markdown: string;
  /** Sections that did not fit, so the caller cannot summarise what it has not seen. */
  omitted: Array<{ id: string; heading: string; words: number }>;
  words: number;
}

/**
 * Read whole sections, up to a budget.
 *
 * Cut at a SECTION boundary rather than at a character count: half a section is
 * worse than none, because it reads as complete. The omitted ones come back by
 * id so the next call can ask for exactly them.
 */
export async function readSections(
  board: MountedBoard,
  noteId: string,
  opts: { ids?: string[]; budget?: number } = {},
): Promise<ReadResult> {
  const { noteToMarkdown } = await import('./note-io');
  const all = ranges(board, noteId);
  /**
   * With no ids this is the whole document, so it walks the TOP-LEVEL sections:
   * summing every section would emit each nested one twice, once inside its
   * parent and once alone. With ids it is exactly what was asked for, minus any
   * section already contained in another — asking for both a parent and its
   * child is a reasonable thing to do and must not double the text.
   */
  const wanted = opts.ids?.length
    ? dropContained(all.filter((s) => opts.ids!.includes(s.id)))
    : chunks(board, noteId);
  const budget = opts.budget ?? 40_000;

  // One conversion, then slice — `fromBlockSnapshot` on the whole note is a
  // single pass, and doing it per section would re-walk the document N times.
  const full = await noteToMarkdown(board, noteId);
  if (!wanted.length) return { markdown: '', omitted: [], words: 0 };

  // Whole document requested and it fits: hand it over unsliced, which keeps
  // the markdown byte-identical to what an export would produce.
  if (!opts.ids?.length && full.length <= budget) {
    return { markdown: full, omitted: [], words: wanted.reduce((n, s) => n + s.words, 0) };
  }

  const pieces: string[] = [];
  const omitted: ReadResult['omitted'] = [];
  let used = 0;
  let words = 0;
  for (const section of wanted) {
    const md = await sectionMarkdown(board, noteId, section);
    if (used + md.length > budget && pieces.length) {
      omitted.push({ id: section.id, heading: section.heading, words: section.words });
      continue;
    }
    pieces.push(md);
    used += md.length;
    words += section.words;
  }
  return { markdown: pieces.join('\n\n'), omitted, words };
}

/**
 * One section as markdown.
 *
 * Converts a note holding ONLY that section's blocks, so the output is the same
 * markdown the whole-document conversion would produce for those blocks — no
 * second serialiser to drift.
 */
async function sectionMarkdown(
  board: MountedBoard,
  noteId: string,
  section: Range,
): Promise<string> {
  const { sliceToMarkdown } = await import('./note-io');
  const note: any = board.store.getBlock(noteId)?.model;
  const kids: any[] = (note?.children ?? []).slice(section.start, section.end);
  return sliceToMarkdown(board, kids);
}

export type EditWhere = 'replace' | 'before' | 'after' | 'append' | 'delete';

export interface EditResult {
  ok: true;
  /** The outline AFTER the edit, so the caller's addresses are never stale. */
  outline: DocumentSection[];
}

/**
 * Change one section.
 *
 * Returns the new outline every time, deliberately: an edit moves block indices
 * and can merge or split sections, and a caller working from the outline it had
 * BEFORE would address the wrong thing next. Handing back the truth costs a few
 * lines and removes a whole class of silent mistake.
 */
export async function editSection(
  board: MountedBoard,
  noteId: string,
  where: EditWhere,
  opts: { sectionId?: string; markdown?: string } = {},
): Promise<EditResult> {
  const note: any = board.store.getBlock(noteId)?.model;
  if (!note) throw new Error('That document is not on the board any more.');

  const all = ranges(board, noteId);
  const target = opts.sectionId ? all.find((s) => s.id === opts.sectionId) : undefined;
  if (opts.sectionId && !target) {
    throw new Error(
      `No section ${opts.sectionId} in this document. Read the outline again — `
      + 'section ids change only when that section is deleted.',
    );
  }

  const md = String(opts.markdown ?? '');
  if (where !== 'delete' && !md.trim()) {
    throw new Error('Nothing to write — `markdown` is empty.');
  }

  // Where the new blocks go, and which old ones leave.
  let insertAt: number;
  let removeFrom = 0;
  let removeCount = 0;
  if (where === 'append') {
    insertAt = (note.children ?? []).length;
  } else if (where === 'replace') {
    insertAt = target!.start;
    removeFrom = target!.start;
    removeCount = target!.end - target!.start;
  } else if (where === 'before') {
    insertAt = target!.start;
  } else if (where === 'after') {
    insertAt = target!.end;
  } else {
    insertAt = -1;
    removeFrom = target!.start;
    removeCount = target!.end - target!.start;
  }

  /**
   * INSERT FIRST, THEN DELETE.
   *
   * The other order empties the note for an instant, and on a document whose
   * every section is being rewritten in turn that is a visible flicker and a
   * window where a concurrent read sees nothing. Inserting first also means a
   * failure to build the new blocks leaves the old ones untouched.
   */
  let inserted = 0;
  if (where !== 'delete') {
    const { insertMarkdownAt } = await import('./note-io');
    inserted = await insertMarkdownAt(board, noteId, md, insertAt);
  }

  if (removeCount > 0) {
    const kids: any[] = note.children ?? [];
    // Indices shifted by whatever we just put in above them.
    const from = removeFrom + (insertAt <= removeFrom ? inserted : 0);
    const doomed = kids.slice(from, from + removeCount);
    for (const block of doomed) {
      try { board.store.deleteBlock(block); } catch { /* already gone */ }
    }
  }

  return { ok: true, outline: outline(board, noteId) };
}
