/**
 * A real PDF, typeset in the browser.
 *
 * ── WHY A LAYOUT ENGINE AND NOT THE PRINT DIALOG ────────────────────────────
 * `window.print()` produces a beautiful PDF and produces it only when a person
 * is sitting in front of the window and finishes the job themselves. Nothing is
 * saved, nothing has a URL, and an agent asked for "the PDF" has nothing to
 * hand back. So this lays the document out properly: real font metrics, real
 * line breaking, real pagination, page numbers, widow control.
 *
 * `pdf-lib` is ~400KB and dynamically imported, so it costs nothing until
 * somebody exports.
 *
 * ── THE ONE THING THIS CANNOT DO ────────────────────────────────────────────
 * The standard PDF fonts encode WinAnsi and nothing else, so Japanese, Arabic,
 * Devanagari and emoji have no glyphs. Rather than crash — which is what
 * pdf-lib does if you hand it such a character — arrows and ticks are
 * transliterated, the rest are dropped, and the COUNT is returned so the caller
 * can tell the user exactly what was lost and offer Word, which has no such
 * limit because the reader's machine resolves the fonts.
 */
import type { PDFFont, PDFPage } from 'pdf-lib';

import type { Block, DocAlign, DocSpec, Inline } from './blocks';
import { parseMarkdown } from './blocks';
import { loadImages } from './images';
import { loadDocumentFonts, type Style } from './fonts';

const PAGE = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 },
};
/** The default page margin, in points. `DocSpec.margin` overrides it per document. */
const DEFAULT_MARGIN = 72; // 1 inch
const FOOTER_GAP = 36;
const BODY_SIZE = 11;
const LEADING = 1.42;
const H_SIZE = [20, 15.5, 13, 11.5];
const H_BEFORE = [0, 20, 16, 14];
const H_AFTER = [10, 8, 6, 5];

/** cp1252's additions above Latin-1 — curly quotes, dashes, the ellipsis. */
const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split(''));
const TRANSLIT: Record<string, string> = {
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '⇐': '<=',
  '≥': '>=', '≤': '<=', '≈': '~', '≠': '!=', '−': '-',
  '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x', '★': '*', '☆': '*',
  '·': '-', '‹': '<', '›': '>', '‑': '-', '‒': '-',
  ' ': ' ', ' ': ' ', ' ': ' ', '​': '', '‍': '', '️': '',
};

/**
 * EXPORTED: the screenplay renderer sets the same standard fonts and needs the
 * same protection. Two copies of a transliteration table is two answers to
 * "what happens to an arrow".
 */
export function winAnsi(s: string, dropped: { n: number }): string {
  let out = '';
  for (const ch of String(s ?? '')) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRA.has(ch)) {
      out += ch;
    } else if (TRANSLIT[ch] !== undefined) {
      out += TRANSLIT[ch];
    } else if (ch === '\t') {
      out += '    ';
    } else if (ch === '\n') {
      // A HARD break, which the line splitter downstream consumes. Dropping it
      // here deleted every <br> in the document AND counted each as an
      // unrepresentable glyph, so the user was told they had lost characters
      // they had not lost.
      out += ch;
    } else {
      dropped.n++;
    }
  }
  return out;
}

/**
 * ── THE SHAPE `layout` NEEDS, WHICHEVER FONTS BACK IT ────────────────────────
 *
 * Kept as an interface rather than the concrete `DocumentFonts` so the line
 * breaker can still be driven by the tests with five plain standard fonts. The
 * thing under test is where the line breaks, not which file the glyph came from.
 */
export interface Fonts {
  pick(style: Style, codePoint: number): PDFFont | null;
  base(style: Style): PDFFont;
}

/** The five standard faces, wrapped in the interface above. */
export function fixedFonts(faces: Record<Style, PDFFont>): Fonts {
  return { pick: (style) => faces[style] ?? faces.regular, base: (style) => faces[style] ?? faces.regular };
}

function styleFor(r: Inline): Style {
  if (r.code) return 'mono';
  if (r.bold && r.italic) return 'boldItalic';
  if (r.bold) return 'bold';
  if (r.italic) return 'italic';
  return 'regular';
}

/**
 * Cut a run into stretches that share ONE font.
 *
 * A PDF text operation draws with a single font, so text mixing scripts — a
 * Hindi name in an English sentence — has to be split before it can be set. A
 * character no loaded face can set is transliterated if there is an obvious
 * ASCII stand-in and counted as dropped otherwise, which is the same contract
 * `winAnsi` had and the only part of it worth keeping.
 */
function shapeRun(
  text: string,
  style: Style,
  fonts: Fonts,
  dropped: { n: number },
): Array<{ text: string; font: PDFFont }> {
  const out: Array<{ text: string; font: PDFFont }> = [];
  const fallback = fonts.base(style);
  const push = (ch: string, font: PDFFont) => {
    const last = out[out.length - 1];
    if (last && last.font === font) last.text += ch;
    else out.push({ text: ch, font });
  };

  for (const ch of String(text ?? '')) {
    // A hard break is structure, not a glyph: it must survive to the splitter
    // below and must never be counted as an unrepresentable character.
    if (ch === '\n') { push(ch, fallback); continue; }
    if (ch === '\t') { push('    ', fallback); continue; }
    const cp = ch.codePointAt(0)!;
    const font = fonts.pick(style, cp);
    if (font) { push(ch, font); continue; }
    const stand = TRANSLIT[ch];
    if (stand !== undefined) {
      for (const c of stand) push(c, fonts.pick(style, c.codePointAt(0)!) ?? fallback);
      continue;
    }
    dropped.n++;
  }
  return out;
}

/**
 * One stretch of text, measured, with the size it was measured AT.
 *
 * The size is per piece rather than per block because a run may override it
 * (`[BIG]{size=28}`), and a width measured at one size and drawn at another is
 * the classic way text ends up overlapping the words after it.
 */
export interface Piece { text: string; font: PDFFont; width: number; size: number; run: Inline }

/** The size a run is set at: its own if it asked, else the block's. */
function sizeOf(run: Inline, blockSize: number): number {
  const own = Number(run.size);
  return Number.isFinite(own) && own > 0 ? own : blockSize;
}

/**
 * The tallest piece on a line — what its leading must be based on.
 *
 * A 28pt word inside 11pt prose needs the line to grow, or it overprints the
 * line above. Empty lines fall back to the block's size.
 */
export function lineSize(line: Piece[], blockSize: number): number {
  return line.reduce((n, piece) => Math.max(n, piece.size), 0) || blockSize;
}

/**
 * Greedy line breaking ACROSS runs, so one line can change font part-way —
 * which is the whole point of inline bold. Measured with real font metrics
 * rather than an average character width, which is what puts the right edge
 * where it belongs instead of overflowing on a line full of capitals.
 */
/**
 * EXPORTED FOR TESTS. It is the piece of this file with a history of being
 * subtly wrong in ways only a rendered page shows — a dropped space between
 * runs, a line that does not break — and testing it directly is far cheaper
 * than parsing a PDF back to find out.
 */
export function layout(
  runs: Inline[], f: Fonts, blockSize: number, maxWidth: number, dropped: { n: number },
): Piece[][] {
  const lines: Piece[][] = [];
  let line: Piece[] = [];
  let width = 0;
  const flush = () => { lines.push(line); line = []; width = 0; };

  // One pass per run becomes one pass per SAME-FONT stretch of that run, so a
  // sentence that changes script mid-way is set rather than half-dropped.
  const shaped = runs.flatMap((run) =>
    shapeRun(run.text, styleFor(run), f, dropped).map((part) => ({ ...part, run })));

  for (const { run, font, text } of shaped) {
    const size = sizeOf(run, blockSize);
    // Compared by VALUE once, so a paragraph whose two lines happened to be
    // identical would not have broken between them. The index is what it meant.
    const segments = text.split('\n');
    segments.forEach((segment, si) => {
      if (si > 0) flush(); // an explicit <br> — the only newline `winAnsi` keeps
      /**
       * ── A RUN THAT BEGINS WITH A SPACE ────────────────────────────────────
       *
       * Trailing space stays attached to its word, which keeps words apart
       * within a run. It does NOT cover the space BEFORE one: markdown like
       * `The **positioning** is that…` arrives as three runs — "The ",
       * "positioning", " is that…" — and `\S+\s*` cannot match from a leading
       * space, so that third run's space was dropped and the PDF read
       * "positioningis". Word was unaffected, which is why only a rendered
       * page showed it.
       *
       * The space belongs to the END of the previous piece, in that piece's
       * own font — so it is moved there, width and all. At the start of a line
       * there is nothing to attach it to and dropping it is correct.
       */
      const lead = segment.match(/^[^\S\n]+/)?.[0];
      if (lead && line.length) {
        const prev = line[line.length - 1]!;
        const extra = prev.font.widthOfTextAtSize(lead, prev.size);
        prev.text += lead;
        prev.width += extra;
        width += extra;
      }
      const words = segment.match(/\S+\s*/g) || [];
      for (const word of words) {
        const w = font.widthOfTextAtSize(word, size);
        if (width > 0 && width + font.widthOfTextAtSize(word.trimEnd(), size) > maxWidth) flush();
        if (w > maxWidth && width === 0) {
          // One unbreakable token wider than the column — a raw URL. Break it
          // by character rather than letting it run off the page.
          let chunk = '';
          for (const ch of word) {
            if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth && chunk) {
              line.push({ text: chunk, font, width: font.widthOfTextAtSize(chunk, size), size, run });
              flush();
              chunk = ch;
            } else chunk += ch;
          }
          if (chunk) {
            line.push({ text: chunk, font, width: font.widthOfTextAtSize(chunk, size), size, run });
            width += font.widthOfTextAtSize(chunk, size);
          }
          continue;
        }
        line.push({ text: word, font, width: w, size, run });
        width += w;
      }
    });
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [[]];
}

export interface PdfResult { blob: Blob; pages: number; droppedGlyphs: number }

export async function renderPdf(spec: DocSpec): Promise<PdfResult> {
  const { PDFDocument, rgb } = await import('pdf-lib');

  const blocks = parseMarkdown(spec.markdown, spec.title);
  const images = await loadImages(blocks);
  const pdf = await PDFDocument.create();
  const serif = spec.typeface !== 'sans';
  /**
   * Real embedded faces, chosen from what the document actually says — see
   * fonts.ts. This is what lets a PDF carry a Hindi name, a rupee sign or a
   * Polish surname; the base-14 fonts it replaced could not, and dropped them.
   */
  const f = await loadDocumentFonts(pdf, serif, spec.markdown ?? '');
  const dropped = { n: 0 };

  const sheet = PAGE[spec.pageSize === 'letter' ? 'letter' : 'a4'];
  // Landscape is the same sheet turned, which is what every word processor
  // means by it — not a different paper size.
  const size = spec.orientation === 'landscape'
    ? { w: sheet.h, h: sheet.w }
    : sheet;

  /**
   * Shadows the module default on purpose, so every measurement below — the
   * column, the floor, the image box, the page number — moves together. A
   * margin that only some of them honoured would be worse than none.
   */
  const MARGIN = typeof spec.margin === 'number'
    ? Math.max(18, Math.min(216, spec.margin))
    : spec.margin === 'narrow' ? 36 : spec.margin === 'wide' ? 108 : DEFAULT_MARGIN;

  const colWidth = size.w - MARGIN * 2;
  const hasHeader = !!String(spec.header ?? '').trim();
  // A running header needs room above the text, and a footer line needs room
  // below the page number that was already there.
  const topOffset = hasHeader ? 18 : 0;
  const floor = MARGIN + FOOTER_GAP;

  let page: PDFPage = pdf.addPage([size.w, size.h]);
  let y = size.h - MARGIN - topOffset;
  const newPage = () => {
    page = pdf.addPage([size.w, size.h]);
    y = size.h - MARGIN - topOffset;
  };
  /** Reserve vertical space, starting a page when this block will not fit. */
  const need = (h: number) => { if (y - h < floor) newPage(); };

  const ink = rgb(0.09, 0.09, 0.10);
  const muted = rgb(0.42, 0.42, 0.44);
  const hair = rgb(0.82, 0.82, 0.84);
  const linkBlue = rgb(0.13, 0.36, 0.72);

  /** `#rrggbb` → a pdf-lib colour. Anything else keeps the block's ink. */
  const inkOf = (hex: string | undefined, fallback: typeof ink) => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex ?? ''));
    if (!m) return fallback;
    const n = parseInt(m[1]!, 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };

  const drawLines = (
    lines: Piece[][], fontSize: number, indent: number, color = ink,
    firstPrefix?: { text: string; font: PDFFont },
    align: 'left' | 'center' | 'right' = 'left',
  ) => {
    lines.forEach((line, i) => {
      // The line's own height, not the block's: one big run has to push the
      // lines apart or it overprints the line above.
      const top = lineSize(line, fontSize);
      const lineH = top * LEADING;
      need(lineH);
      /**
       * Centred and right text are set by offsetting the line's own start, so
       * every piece after it follows — the pieces already carry their measured
       * widths, which is what makes this exact rather than approximate.
       */
      const lineWidth = line.reduce((n, piece) => n + piece.width, 0);
      const slack = Math.max(0, colWidth - indent - lineWidth);
      const offset = align === 'center' ? slack / 2 : align === 'right' ? slack : 0;
      let x = MARGIN + indent + offset;
      if (i === 0 && firstPrefix) {
        const w = firstPrefix.font.widthOfTextAtSize(firstPrefix.text, fontSize);
        page.drawText(firstPrefix.text, {
          x: MARGIN + indent - w - 6, y: y - fontSize, size: fontSize, font: firstPrefix.font, color,
        });
      }
      for (const piece of line) {
        const fs = piece.size;
        // Baselines sit on the LINE's baseline, so 11pt and 28pt on one line
        // rest on the same rule rather than each floating at its own height.
        const baseline = y - top;
        /**
         * Highlight first, under everything: a rectangle from a little below
         * the baseline to a little above the cap height, which is where a
         * highlighter pen would actually leave ink.
         */
        if (piece.run.highlight) {
          page.drawRectangle({
            x: x - 0.5, y: baseline - fs * 0.22, width: piece.width + 1, height: fs * 1.06,
            color: inkOf(piece.run.highlight, hair),
          });
        }
        const own = piece.run.link ? linkBlue : inkOf(piece.run.color, color);
        page.drawText(piece.text, { x, y: baseline, size: fs, font: piece.font, color: own });
        if (piece.run.strike) {
          page.drawLine({
            start: { x, y: baseline + fs * 0.28 }, end: { x: x + piece.width, y: baseline + fs * 0.28 },
            thickness: Math.max(0.5, fs * 0.055), color: own,
          });
        }
        if (piece.run.underline || piece.run.link) {
          page.drawLine({
            start: { x, y: baseline - fs * 0.13 }, end: { x: x + piece.width, y: baseline - fs * 0.13 },
            thickness: Math.max(0.5, fs * 0.05), color: own,
          });
        }
        x += piece.width;
      }
      y -= lineH;
    });
  };

  for (const b of blocks as Block[]) {
    switch (b.kind) {
      case 'heading': {
        const fs = H_SIZE[b.level - 1]!;
        y -= H_BEFORE[b.level - 1]!;
        const lines = layout(b.runs.map((r) => ({ ...r, bold: true })), f, fs, colWidth, dropped);
        /**
         * WIDOW CONTROL — a heading alone at the foot of a page is the single
         * most obvious sign a document was generated rather than typeset. If it
         * and two lines of what follows will not fit, start the page here.
         */
        const block = lines.length * fs * LEADING + BODY_SIZE * LEADING * 2;
        if (y - block < floor) newPage();
        drawLines(lines, fs, 0, ink, undefined, b.align ?? 'left');
        y -= H_AFTER[b.level - 1]!;
        break;
      }
      case 'para':
        drawLines(layout(b.runs, f, BODY_SIZE, colWidth, dropped), BODY_SIZE, 0, ink, undefined, b.align ?? 'left');
        y -= 7;
        break;
      case 'list': {
        const indent = 18 + b.level * 16;
        const marker = b.index > 0 && b.ordered ? `${b.index}.` : b.level > 0 ? '–' : '•';
        drawLines(
          layout(b.runs, f, BODY_SIZE, colWidth - indent, dropped), BODY_SIZE, indent, ink,
          // A continuation paragraph under a bullet gets no marker of its own.
          b.index === 0 && !b.ordered && b.level > 0
            ? undefined
            : { text: marker, font: f.base('regular') },
        );
        y -= 3;
        break;
      }
      case 'quote': {
        const indent = 24;
        const top = y;
        drawLines(
          layout(b.runs.map((r) => ({ ...r, italic: true })), f, BODY_SIZE, colWidth - indent, dropped),
          BODY_SIZE, indent, muted,
        );
        // Only rule the part that stayed on THIS page — a bar drawn from a
        // remembered `top` across a page break runs off the bottom.
        if (y < top) {
          page.drawLine({
            start: { x: MARGIN + 8, y: top - 2 }, end: { x: MARGIN + 8, y: Math.max(y + 4, floor) },
            thickness: 2, color: hair,
          });
        }
        y -= 7;
        break;
      }
      case 'code': {
        const fs = 9.5;
        const lineH = fs * 1.4;
        for (const raw of b.text.split('\n')) {
          need(lineH);
          page.drawRectangle({
            x: MARGIN, y: y - lineH + 2, width: colWidth, height: lineH,
            color: rgb(0.965, 0.965, 0.972),
          });
          page.drawText(winAnsi(raw, dropped), {
            x: MARGIN + 8, y: y - fs, size: fs, font: f.base('mono'), color: rgb(0.16, 0.18, 0.22),
          });
          y -= lineH;
        }
        y -= 10;
        break;
      }
      case 'pagebreak':
        /**
         * Only when there is something on this page. A break at the very top —
         * which is what a document opening with one produces — would otherwise
         * emit a blank first page, and blank pages in a contract look like a
         * printing fault.
         */
        if (y < size.h - MARGIN - topOffset - 1) newPage();
        break;
      case 'rule':
        need(20);
        y -= 8;
        page.drawLine({ start: { x: MARGIN, y }, end: { x: size.w - MARGIN, y }, thickness: 0.7, color: hair });
        y -= 14;
        break;
      case 'image': {
        const img = images.get(b.url);
        if (img) {
          const embedded = img.png ? await pdf.embedPng(img.bytes) : await pdf.embedJpg(img.bytes);
          /**
           * AN EXPLICIT WIDTH WINS, capped to the column.
           *
           * Without one this fell back to the column width for everything,
           * which reads a 1024px logo as 1024 POINTS and draws it 450pt wide —
           * a letterhead mark the size of the page. See `imageHints`.
           */
          const target = b.width
            ? Math.min(b.width, colWidth)
            : Math.min(embedded.width, colWidth);
          const scale = target / Math.max(1, embedded.width);
          const w = embedded.width * scale;
          const h = embedded.height * scale;
          // A picture taller than the text column gets its own page rather than
          // being cut in half.
          if (y - h < floor) newPage();
          const fit = Math.min(1, (size.h - MARGIN - floor) / h);
          const drawW = w * fit;
          const x = b.align === 'left'
            ? MARGIN
            : b.align === 'right'
              ? MARGIN + colWidth - drawW
              : MARGIN + (colWidth - drawW) / 2;
          page.drawImage(embedded, { x, y: y - h * fit, width: drawW, height: h * fit });
          y -= h * fit + 6;
        }
        if (b.alt) drawLines(layout([{ text: b.alt, italic: true }], f, 9, colWidth, dropped), 9, 0, muted);
        y -= 10;
        break;
      }
      case 'table': {
        const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
        /**
         * ── COLUMN WIDTHS ────────────────────────────────────────────────────
         *
         * Relative weights, normalised to the column width. A missing or short
         * `widths` is padded with 1s rather than rejected, so `cols: 3` on a
         * three-column table means "first one wide" and does not need the
         * author to spell out the two that are ordinary.
         */
        const weights = Array.from({ length: cols }, (_, i) => {
          const w = Number(b.widths?.[i]);
          return Number.isFinite(w) && w > 0 ? w : 1;
        });
        const total = weights.reduce((n, w) => n + w, 0);
        const widths = weights.map((w) => (colWidth * w) / total);
        const xs = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((n, w) => n + w, 0));
        const align = (i: number): DocAlign => b.align?.[i] ?? 'left';
        const fs = 9.5;
        const PAD = 6;

        const drawRow = (cells: Inline[][], header: boolean) => {
          const laid = Array.from({ length: cols }, (_, i) =>
            layout((cells[i] || []).map((r) => ({ ...r, bold: header || r.bold })), f, fs,
              Math.max(12, widths[i]! - PAD * 2), dropped));
          const rowH = Math.max(...laid.map((l) => l.length)) * fs * 1.4 + 8;
          /**
           * ── THE HEADER FOLLOWS THE TABLE ONTO THE NEXT PAGE ───────────────
           *
           * Word repeats it and so must this: a table that breaks across pages
           * leaves the reader on page two with four unlabelled columns. The
           * recursion is safe because the repeat is drawn on a FRESH page,
           * where it always fits.
           */
          if (y - rowH < floor) {
            newPage();
            if (!header && b.header.length) drawRow(b.header, true);
          }
          if (header) {
            page.drawRectangle({
              x: MARGIN, y: y - rowH, width: colWidth, height: rowH, color: rgb(0.955, 0.955, 0.962),
            });
          }
          laid.forEach((lines, i) => {
            let ly = y - 5;
            for (const line of lines) {
              const lineWidth = line.reduce((n, piece) => n + piece.width, 0);
              const slack = Math.max(0, widths[i]! - PAD * 2 - lineWidth);
              const a = align(i);
              const offset = a === 'center' ? slack / 2 : a === 'right' ? slack : 0;
              let x = xs[i]! + PAD + offset;
              for (const piece of line) {
                const cellInk = inkOf(piece.run.color, ink);
                if (piece.run.highlight) {
                  page.drawRectangle({
                    x: x - 0.5, y: ly - fs - piece.size * 0.22,
                    width: piece.width + 1, height: piece.size * 1.06,
                    color: inkOf(piece.run.highlight, hair),
                  });
                }
                page.drawText(piece.text, {
                  x, y: ly - fs, size: piece.size, font: piece.font, color: cellInk,
                });
                if (piece.run.underline) {
                  page.drawLine({
                    start: { x, y: ly - fs - piece.size * 0.13 },
                    end: { x: x + piece.width, y: ly - fs - piece.size * 0.13 },
                    thickness: 0.5, color: cellInk,
                  });
                }
                x += piece.width;
              }
              ly -= fs * 1.4;
            }
          });
          page.drawLine({
            start: { x: MARGIN, y: y - rowH }, end: { x: size.w - MARGIN, y: y - rowH },
            thickness: 0.5, color: hair,
          });
          y -= rowH;
        };
        if (b.header.length) drawRow(b.header, true);
        for (const r of b.rows) drawRow(r, false);
        y -= 12;
        break;
      }
    }
  }

  // Page numbers last, once the count is known. A one-page memo does not get
  // one — nobody numbers a single page.
  const pages = pdf.getPages();
  /**
   * ── RUNNING HEADER, FOOTER AND PAGE NUMBER ────────────────────────────────
   *
   * Drawn after the body, because `{pages}` cannot be known until the document
   * has finished paginating — which is exactly why "Page 2 of 7" is worth
   * having and why a one-pass renderer cannot produce it.
   *
   * Every line is set through `shapeRun`, so a header in Hindi works like any
   * other text rather than being the one place that quietly cannot.
   */
  const chrome = (text: string, atY: number, p: PDFPage, total: number, index: number) => {
    const filled = text
      .replace(/\{page\}/gi, String(index + 1))
      .replace(/\{pages\}/gi, String(total));
    const parts = shapeRun(filled, 'regular', f, dropped);
    const width = parts.reduce((n, part) => n + part.font.widthOfTextAtSize(part.text, 9), 0);
    let x = (size.w - width) / 2;
    for (const part of parts) {
      p.drawText(part.text, { x, y: atY, size: 9, font: part.font, color: muted });
      x += part.font.widthOfTextAtSize(part.text, 9);
    }
  };

  const headerText = String(spec.header ?? '').trim();
  const footerText = String(spec.footer ?? '').trim();
  pages.forEach((p, i) => {
    if (headerText) chrome(headerText, size.h - MARGIN + 6, p, pages.length, i);
    if (footerText) chrome(footerText, MARGIN - 30, p, pages.length, i);
    // The bare page number stays for a multi-page document with no footer of
    // its own; a document that supplies one can put {page} wherever it likes.
    if (!footerText && pages.length > 1) {
      const label = String(i + 1);
      const pageFont = f.base('regular');
      const w = pageFont.widthOfTextAtSize(label, 9);
      p.drawText(label, { x: (size.w - w) / 2, y: MARGIN - 18, size: 9, font: pageFont, color: muted });
    }
  });

  pdf.setTitle(spec.title || 'Document');
  pdf.setProducer('Voidspace');
  pdf.setCreator('Voidspace');

  const bytes = await pdf.save();
  return {
    blob: new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }),
    pages: pages.length,
    droppedGlyphs: dropped.n,
  };
}
