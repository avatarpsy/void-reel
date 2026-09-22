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

import type { Block, DocSpec, Inline } from './blocks';
import { parseMarkdown } from './blocks';
import { loadImages } from './images';

const PAGE = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 },
};
const MARGIN = 72; // 1 inch
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

export interface Fonts { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont; mono: PDFFont }

function fontFor(r: Inline, f: Fonts): PDFFont {
  if (r.code) return f.mono;
  if (r.bold && r.italic) return f.boldItalic;
  if (r.bold) return f.bold;
  if (r.italic) return f.italic;
  return f.regular;
}

export interface Piece { text: string; font: PDFFont; width: number; run: Inline }

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
export function layout(runs: Inline[], f: Fonts, size: number, maxWidth: number, dropped: { n: number }): Piece[][] {
  const lines: Piece[][] = [];
  let line: Piece[] = [];
  let width = 0;
  const flush = () => { lines.push(line); line = []; width = 0; };

  for (const run of runs) {
    const font = fontFor(run, f);
    const text = winAnsi(run.text, dropped);
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
        const extra = prev.font.widthOfTextAtSize(lead, size);
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
              line.push({ text: chunk, font, width: font.widthOfTextAtSize(chunk, size), run });
              flush();
              chunk = ch;
            } else chunk += ch;
          }
          if (chunk) {
            line.push({ text: chunk, font, width: font.widthOfTextAtSize(chunk, size), run });
            width += font.widthOfTextAtSize(chunk, size);
          }
          continue;
        }
        line.push({ text: word, font, width: w, run });
        width += w;
      }
    });
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [[]];
}

export interface PdfResult { blob: Blob; pages: number; droppedGlyphs: number }

export async function renderPdf(spec: DocSpec): Promise<PdfResult> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');

  const blocks = parseMarkdown(spec.markdown, spec.title);
  const images = await loadImages(blocks);
  const pdf = await PDFDocument.create();
  const serif = spec.typeface !== 'sans';
  const f: Fonts = {
    regular: await pdf.embedFont(serif ? StandardFonts.TimesRoman : StandardFonts.Helvetica),
    bold: await pdf.embedFont(serif ? StandardFonts.TimesRomanBold : StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(serif ? StandardFonts.TimesRomanItalic : StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(serif ? StandardFonts.TimesRomanBoldItalic : StandardFonts.HelveticaBoldOblique),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
  const dropped = { n: 0 };

  const size = PAGE[spec.pageSize === 'letter' ? 'letter' : 'a4'];
  const colWidth = size.w - MARGIN * 2;
  const floor = MARGIN + FOOTER_GAP;

  let page: PDFPage = pdf.addPage([size.w, size.h]);
  let y = size.h - MARGIN;
  const newPage = () => { page = pdf.addPage([size.w, size.h]); y = size.h - MARGIN; };
  /** Reserve vertical space, starting a page when this block will not fit. */
  const need = (h: number) => { if (y - h < floor) newPage(); };

  const ink = rgb(0.09, 0.09, 0.10);
  const muted = rgb(0.42, 0.42, 0.44);
  const hair = rgb(0.82, 0.82, 0.84);
  const linkBlue = rgb(0.13, 0.36, 0.72);

  const drawLines = (
    lines: Piece[][], fontSize: number, indent: number, color = ink,
    firstPrefix?: { text: string; font: PDFFont },
    align: 'left' | 'center' | 'right' = 'left',
  ) => {
    const lineH = fontSize * LEADING;
    lines.forEach((line, i) => {
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
        page.drawText(piece.text, {
          x, y: y - fontSize, size: fontSize, font: piece.font,
          color: piece.run.link ? linkBlue : color,
        });
        if (piece.run.strike) {
          page.drawLine({
            start: { x, y: y - fontSize * 0.62 }, end: { x: x + piece.width, y: y - fontSize * 0.62 },
            thickness: 0.6, color,
          });
        }
        if (piece.run.link) {
          page.drawLine({
            start: { x, y: y - fontSize - 1.5 }, end: { x: x + piece.width, y: y - fontSize - 1.5 },
            thickness: 0.5, color: linkBlue,
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
          b.index === 0 && !b.ordered && b.level > 0 ? undefined : { text: marker, font: f.regular },
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
            x: MARGIN + 8, y: y - fs, size: fs, font: f.mono, color: rgb(0.16, 0.18, 0.22),
          });
          y -= lineH;
        }
        y -= 10;
        break;
      }
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
        const cw = colWidth / cols;
        const fs = 9.5;
        const drawRow = (cells: Inline[][], header: boolean) => {
          const laid = Array.from({ length: cols }, (_, i) =>
            layout((cells[i] || []).map((r) => ({ ...r, bold: header || r.bold })), f, fs, cw - 12, dropped));
          const rowH = Math.max(...laid.map((l) => l.length)) * fs * 1.4 + 8;
          need(rowH);
          if (header) {
            page.drawRectangle({
              x: MARGIN, y: y - rowH, width: colWidth, height: rowH, color: rgb(0.955, 0.955, 0.962),
            });
          }
          laid.forEach((lines, i) => {
            let ly = y - 5;
            for (const line of lines) {
              let x = MARGIN + i * cw + 6;
              for (const piece of line) {
                page.drawText(piece.text, { x, y: ly - fs, size: fs, font: piece.font, color: ink });
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
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const label = String(i + 1);
      const w = f.regular.widthOfTextAtSize(label, 9);
      p.drawText(label, { x: (size.w - w) / 2, y: MARGIN - 18, size: 9, font: f.regular, color: muted });
    });
  }

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
