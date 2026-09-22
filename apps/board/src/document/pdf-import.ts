/**
 * A PDF, turned back into a document you can edit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT "EDITING A PDF" HONESTLY MEANS
 * ══════════════════════════════════════════════════════════════════════════
 * A PDF has no paragraphs. It has glyphs at coordinates, and the fact that two
 * of them are in the same sentence is something a reader infers from where they
 * sit. There is no library that changes that — pdf-lib can add pages, stamp,
 * and fill form fields, and cannot reflow a line of existing text, because the
 * information needed to reflow it was thrown away when the file was made.
 *
 * So every tool that "edits a PDF" does one of two things, and it is worth
 * being clear about which:
 *
 *   1. ANNOTATE — draw on top, fill a field, add or remove a page. The original
 *      is untouched and unreflowed. pdf-lib does this today.
 *   2. CONVERT — infer the document back from the geometry, edit THAT, and
 *      write a new PDF. This is what Word does when you open a .pdf, and it is
 *      what this file does.
 *
 * Nobody does a third thing, and a product that implies otherwise is setting
 * the user up to be disappointed at exactly the wrong moment.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE INFERENCE
 * ══════════════════════════════════════════════════════════════════════════
 * Runs on a shared baseline are a LINE. Lines are joined into a PARAGRAPH while
 * the gap between them stays close to the line height and the left edge does
 * not move. A line set noticeably larger than the document's body size is a
 * HEADING, at a level set by how much larger. A line whose centre sits on the
 * column's centre — and whose left edge does not — is CENTRED. A run whose font
 * name says Bold is bold.
 *
 * Every one of those is a guess, and each is made from the strongest signal
 * available rather than from a threshold picked to make one file work. Where
 * the evidence is weak the answer is "ordinary paragraph", because a document
 * that is slightly flat is far better than one confidently wrong.
 */
import type { Block, DocAlign, Inline } from './blocks';

/** The shape `pdfLayout` in the app returns. Declared, not imported: the board
 * must not depend on the website's module graph. */
export interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
  font: string;
}

export interface PdfPageLayout {
  width: number;
  height: number;
  items: PdfTextItem[];
}

export interface ImportedPdf {
  blocks: Block[];
  /** What was guessed rather than read, so a caller can say so. */
  inferred: string[];
  pages: number;
}

/* ── lines ─────────────────────────────────────────────────────────────────── */

interface Line {
  items: PdfTextItem[];
  y: number;
  size: number;
  left: number;
  right: number;
}

/**
 * Runs sharing a baseline, in reading order.
 *
 * The tolerance is a FRACTION OF THE TYPE SIZE rather than a fixed number of
 * points: at 24pt a 3pt drift is the same line and at 7pt it is the next one.
 * A fixed tolerance works on the document it was tuned against and on no other.
 */
function toLines(items: PdfTextItem[]): Line[] {
  const sorted = [...items].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const lines: Line[] = [];
  for (const item of sorted) {
    const tolerance = Math.max(1.5, item.size * 0.4);
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - item.y) <= tolerance) {
      line.items.push(item);
      line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
      line.size = Math.max(line.size, item.size);
      line.left = Math.min(line.left, item.x);
      line.right = Math.max(line.right, item.x + item.width);
    } else {
      lines.push({
        items: [item], y: item.y, size: item.size,
        left: item.x, right: item.x + item.width,
      });
    }
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

const BOLD = /(bold|black|heavy|semibold|demibold|[-,]bd\b)/i;
const ITALIC = /(italic|oblique|[-,]it\b)/i;

/**
 * One line's runs, with the marks its fonts imply.
 *
 * The space between two runs has to be reconstructed: a PDF positions words and
 * frequently does not store the space between them, so a gap wider than a
 * fraction of the type size means a space was there. Getting this wrong is how
 * an imported PDF reads "thepositioningisthat".
 */
function lineRuns(line: Line): Inline[] {
  const out: Inline[] = [];
  let previous: PdfTextItem | undefined;
  for (const item of line.items) {
    let text = item.text;
    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      const needsSpace = gap > item.size * 0.18
        && !/\s$/.test(previous.text) && !/^\s/.test(text);
      if (needsSpace) text = ` ${text}`;
    }
    const marks: Partial<Inline> = {};
    if (BOLD.test(item.font)) marks.bold = true;
    if (ITALIC.test(item.font)) marks.italic = true;

    const last = out[out.length - 1];
    if (last && !!last.bold === !!marks.bold && !!last.italic === !!marks.italic) {
      last.text += text;
    } else out.push({ text, ...marks });
    previous = item;
  }
  return out.filter((r) => r.text.trim() !== '' || out.length === 1);
}

/* ── the document's own measurements ───────────────────────────────────────── */

/**
 * The body size: the size MOST OF THE TEXT is set in.
 *
 * Measured by how many characters are set at each size, not by how many runs —
 * a document with forty short headings and ten long paragraphs has more runs of
 * heading than of body, and taking the mode of the runs makes the headings the
 * body and the body a caption.
 */
function bodySize(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const line of lines) {
    const size = Math.round(line.size * 2) / 2;
    const chars = line.items.reduce((n, i) => n + i.text.trim().length, 0);
    weight.set(size, (weight.get(size) ?? 0) + chars);
  }
  let best = 11;
  let most = 0;
  for (const [size, chars] of weight) {
    if (chars > most) { most = chars; best = size; }
  }
  return best || 11;
}

/** The left edge most lines start at — the text column, ignoring indents. */
function columnLeft(lines: Line[]): number {
  const counts = new Map<number, number>();
  for (const line of lines) {
    const left = Math.round(line.left);
    counts.set(left, (counts.get(left) ?? 0) + 1);
  }
  let best = 0;
  let most = 0;
  for (const [left, n] of counts) if (n > most) { most = n; best = left; }
  return best;
}

function alignOf(line: Line, left: number, pageWidth: number, right: number): DocAlign | undefined {
  const slack = 6;
  const startsAtColumn = Math.abs(line.left - left) <= slack;
  const centre = (line.left + line.right) / 2;
  const pageCentre = pageWidth / 2;
  if (!startsAtColumn && Math.abs(centre - pageCentre) <= slack * 2) return 'center';
  if (!startsAtColumn && Math.abs(line.right - right) <= slack) return 'right';
  return undefined;
}

const BULLET = /^\s*([•●▪·⁃−-]|\*)\s+/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+/;

/* ── the whole document ────────────────────────────────────────────────────── */

export function importPdfLayout(pages: PdfPageLayout[]): ImportedPdf {
  const inferred = new Set<string>();
  const blocks: Block[] = [];

  const everyLine = pages.flatMap((p) => toLines(p.items));
  if (!everyLine.length) {
    return { blocks: [], inferred: ['no text — this looks like a scan'], pages: pages.length };
  }
  const body = bodySize(everyLine);
  const left = columnLeft(everyLine);
  const rightEdge = Math.max(...everyLine.map((l) => l.right));

  /** A paragraph being built, flushed when something ends it. */
  let open: { runs: Inline[]; align?: DocAlign } | null = null;
  const flush = () => {
    if (open && open.runs.length) {
      blocks.push({ kind: 'para', runs: merge(open.runs), ...(open.align ? { align: open.align } : {}) });
    }
    open = null;
  };

  pages.forEach((page, pageIndex) => {
    if (pageIndex > 0) { flush(); blocks.push({ kind: 'pagebreak' }); }
    const lines = toLines(page.items);
    let previous: Line | undefined;

    for (const line of lines) {
      const text = line.items.map((i) => i.text).join('').trim();
      if (!text) { previous = line; continue; }

      const align = alignOf(line, left, page.width, rightEdge);
      const runs = lineRuns(line);

      // A HEADING: set larger than the body, and short enough to be a title
      // rather than a paragraph that happens to be in a big face.
      const ratio = line.size / body;
      const level = ratio >= 1.6 ? 1 : ratio >= 1.35 ? 2 : ratio >= 1.15 ? 3 : 0;
      if (level && text.length <= 120) {
        flush();
        blocks.push({
          kind: 'heading', level: level as 1 | 2 | 3, runs,
          ...(align ? { align } : {}),
        });
        inferred.add('headings from type size');
        previous = line;
        continue;
      }

      const bullet = BULLET.exec(text);
      const numbered = NUMBERED.exec(text);
      if (bullet || numbered) {
        flush();
        const stripped = text.replace(bullet ? BULLET : NUMBERED, '');
        blocks.push({
          kind: 'list',
          ordered: !!numbered,
          level: Math.max(0, Math.min(3, Math.round((line.left - left) / 18))),
          index: numbered ? Number(numbered[1]) : 1,
          runs: [{ text: stripped }],
        });
        inferred.add('lists from their markers');
        previous = line;
        continue;
      }

      /**
       * A NEW PARAGRAPH, or the next line of the one being built?
       *
       * Two signals, and either one is enough: a vertical gap noticeably larger
       * than the line height, or a change of alignment. A first-line indent
       * also starts one, which is why the left edge is compared to the COLUMN
       * rather than to the previous line.
       */
      const gap = previous ? line.y - previous.y : 0;
      const newParagraph = !open
        || (previous && gap > line.size * 1.8)
        || open.align !== align;

      if (newParagraph) {
        flush();
        open = { runs: [], align };
      }
      if (open!.runs.length) {
        // Lines within a paragraph are joined by a space unless the previous
        // one ended mid-word with a hyphen.
        const last = open!.runs[open!.runs.length - 1]!;
        if (/[‐-—-]$/.test(last.text)) last.text = last.text.replace(/[‐-—-]$/, '');
        else last.text += ' ';
      }
      open!.runs.push(...runs);
      previous = line;
    }
  });
  flush();

  inferred.add('paragraphs from line spacing');
  return { blocks: tidy(blocks), inferred: [...inferred], pages: pages.length };
}

/** Adjacent runs with the same marks become one. */
function merge(runs: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && !!last.bold === !!run.bold && !!last.italic === !!run.italic) last.text += run.text;
    else out.push({ ...run });
  }
  return out.filter((r) => r.text !== '');
}

/** Trailing page breaks and empty paragraphs, which no document wants. */
function tidy(blocks: Block[]): Block[] {
  const out = blocks.filter((b) => !('runs' in b) || b.runs.some((r) => r.text.trim()));
  while (out.length && out[out.length - 1]!.kind === 'pagebreak') out.pop();
  return out;
}
