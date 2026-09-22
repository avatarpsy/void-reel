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
import { headingNumbers, parseMarkdown, wantsNumbering } from './blocks';
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
/**
 * Single spacing, as a multiple of the font size. 1.42 rather than 1.2 because
 * a document is read at arm's length on paper, not on a screen.
 */
const LEADING = 1.42;

/**
 * What `lineSpacing` means in points-per-point. A spec asking for 2 means
 * DOUBLE the single-spaced leading, which is what a university or a court
 * means by double-spaced — not twice the font size.
 */
function leadingFor(spec: DocSpec): number {
  const asked = Number(spec.lineSpacing);
  if (!Number.isFinite(asked) || asked <= 0) return LEADING;
  return LEADING * Math.min(3, Math.max(0.8, asked));
}
const H_SIZE = [20, 15.5, 13, 11.5];

/**
 * How deep a contents page goes.
 *
 * Three levels is what a report or a contract lists. Listing every h4 as
 * well produces a contents page longer than the section it describes,
 * which is the commonest way one stops being useful.
 */
const TOC_DEPTH = 3;

/** A heading's words, with no marks — what a contents line reads as. */
function plain(runs: Inline[]): string {
  return runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
}
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

/**
 * ══════════════════════════════════════════════════════════════════════
 * A CONTENTS PAGE NEEDS THE DOCUMENT TO ALREADY EXIST
 * ══════════════════════════════════════════════════════════════════════
 *
 * "Payment ............ 4" cannot be written until it is known that
 * Payment fell on page 4 — and where it falls depends on how long the
 * contents page is, which depends on how many headings there are. So the
 * document is set TWICE: once to find out, once for real.
 *
 * The two passes paginate identically because the contents page occupies
 * the same lines in both — the entries are known from the headings before
 * either pass, and only the NUMBERS are missing the first time. Getting
 * that wrong is the classic way a contents page ends up off by one.
 *
 * Only ever two passes, and only when the document asks for contents. A
 * 61-page document sets in ~540ms, so the honest cost is about a second
 * for the documents long enough to want one.
 */
export async function renderPdf(spec: DocSpec): Promise<PdfResult> {
  const wantsToc = parseMarkdown(spec.markdown, spec.title)
    .some((b) => b.kind === 'toc');
  if (!wantsToc) return renderPass(spec, null);
  const probe = await renderPass(spec, null);
  return renderPass(spec, probe.headingPages);
}

/** One setting of the document. `known` fills the contents page. */
async function renderPass(
  spec: DocSpec,
  known: Map<number, number> | null,
): Promise<PdfResult & { headingPages: Map<number, number> }> {
  const { PDFDocument, rgb } = await import('pdf-lib');

  const blocks = parseMarkdown(spec.markdown, spec.title);
  // One answer for both writers — see `wantsNumbering`.
  const numbered = wantsNumbering(spec, blocks);
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
  /** Which page each heading landed on, by its order in the document. */
  const headingPages = new Map<number, number>();
  let headingIndex = 0;
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

  const numbers = headingNumbers(blocks as Block[], numbered);

  /**
   * The contents entries, in document order.
   *
   * Read from the BLOCKS rather than from what has been drawn so far,
   * because the contents page comes before the headings it lists — on
   * both passes it has to know the whole shape up front, or the first pass
   * would reserve the wrong number of lines and the second would
   * repaginate.
   */
  const tocEntries = (all: Block[]) => {
    const out: Array<{ index: number; level: number; text: string }> = [];
    let i = 0;
    for (const block of all) {
      if (block.kind !== 'heading') continue;
      const index = i;
      i += 1;
      // The title of the document is not an entry in its own contents.
      if (index === 0 && block.level === 1) continue;
      if (block.level > TOC_DEPTH) continue;
      // The SAME number the body will print — see `headingNumbers`.
      const label = numbers.get(index)?.number;
      out.push({
        index,
        level: block.level,
        text: `${label ? `${label} ` : ''}${plain(block.runs)}`,
      });
    }
    return out;
  };

  const newPage = () => {
    page = pdf.addPage([size.w, size.h]);
    y = size.h - MARGIN - topOffset;
  };
  /** Reserve vertical space, starting a page when this block will not fit. */
  const need = (h: number) => { if (y - h < floor) newPage(); };

  const leading = leadingFor(spec);
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

  /**
   * A heading, a caption or a table cell is RANGED, never justified.
   *
   * Justification needs a paragraph's worth of lines to spread slack
   * across. On three words it pulls them to opposite ends of the column,
   * which is the most recognisable sign of a machine setting type badly.
   */
  const ranged = (a?: DocAlign): DocAlign => (a === 'justify' ? 'left' : a ?? 'left');

  const drawLines = (
    lines: Piece[][], fontSize: number, indent: number, color = ink,
    firstPrefix?: { text: string; font: PDFFont },
    align: DocAlign = 'left',
  ) => {
    lines.forEach((line, i) => {
      // The line's own height, not the block's: one big run has to push the
      // lines apart or it overprints the line above.
      const top = lineSize(line, fontSize);
      const lineH = top * leading;
      need(lineH);
      /**
       * Centred and right text are set by offsetting the line's own start, so
       * every piece after it follows — the pieces already carry their measured
       * widths, which is what makes this exact rather than approximate.
       */
      const lineWidth = line.reduce((n, piece) => n + piece.width, 0);
      const slack = Math.max(0, colWidth - indent - lineWidth);
      /**
       * ── JUSTIFICATION ────────────────────────────────────────────────
       *
       * Both edges flush, by growing the spaces between words rather than
       * the gaps between letters — which is what a typesetter does and
       * what makes a contract or a report look set rather than typed.
       *
       * NEVER THE LAST LINE of a paragraph. Stretching four words across
       * a full column is the single most recognisable sign of a machine
       * doing this badly, so a final line is simply ranged left.
       *
       * A line with no spaces in it (one long word, a URL) is left alone
       * too: there is nothing to grow, and letter-spacing it would look
       * worse than the ragged edge it replaced.
       */
      const spaces = align === 'justify' && i < lines.length - 1
        ? line.reduce((n, piece) => n + (piece.text.match(/ /g)?.length ?? 0), 0)
        : 0;
      const perSpace = spaces > 0 ? slack / spaces : 0;
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
        /**
         * How wide this piece ends up once its own spaces have grown. The
         * decorations below are drawn across THIS, not the measured width,
         * or a highlight would stop short of the words it is behind.
         */
        const grown = perSpace * (piece.text.match(/ /g)?.length ?? 0);
        const drawnWidth = piece.width + grown;
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
            x: x - 0.5, y: baseline - fs * 0.22, width: drawnWidth + 1, height: fs * 1.06,
            color: inkOf(piece.run.highlight, hair),
          });
        }
        const own = piece.run.link ? linkBlue : inkOf(piece.run.color, color);
        if (grown > 0) {
          // Word by word, so each space can be wider than the font says.
          let wx = x;
          const parts = piece.text.split(' ');
          parts.forEach((part, pi) => {
            if (part) {
              page.drawText(part, { x: wx, y: baseline, size: fs, font: piece.font, color: own });
              wx += piece.font.widthOfTextAtSize(part, fs);
            }
            if (pi < parts.length - 1) {
              wx += piece.font.widthOfTextAtSize(' ', fs) + perSpace;
            }
          });
        } else {
          page.drawText(piece.text, { x, y: baseline, size: fs, font: piece.font, color: own });
        }
        if (piece.run.strike) {
          page.drawLine({
            start: { x, y: baseline + fs * 0.28 }, end: { x: x + drawnWidth, y: baseline + fs * 0.28 },
            thickness: Math.max(0.5, fs * 0.055), color: own,
          });
        }
        if (piece.run.underline || piece.run.link) {
          page.drawLine({
            start: { x, y: baseline - fs * 0.13 }, end: { x: x + drawnWidth, y: baseline - fs * 0.13 },
            thickness: Math.max(0.5, fs * 0.05), color: own,
          });
        }
        x += drawnWidth;
      }
      y -= lineH;
    });
  };

  for (const b of blocks as Block[]) {
    switch (b.kind) {
      case 'heading': {
        const fs = H_SIZE[b.level - 1]!;
        y -= H_BEFORE[b.level - 1]!;
        /**
         * The clause number, when the document asked to be numbered.
         * Counted here rather than written into the text, so inserting a
         * section renumbers everything after it instead of nothing.
         */
        const label = numbers.get(headingIndex)?.number ?? '';
        const runs = b.runs.map((r) => ({ ...r, bold: true }));
        const lines = layout(
          label ? [{ text: `${label} `, bold: true }, ...runs] : runs,
          f, fs, colWidth, dropped,
        );
        /**
         * WIDOW CONTROL — a heading alone at the foot of a page is the single
         * most obvious sign a document was generated rather than typeset. If it
         * and two lines of what follows will not fit, start the page here.
         */
        const block = lines.length * fs * leading + BODY_SIZE * leading * 2;
        if (y - block < floor) newPage();
        // Recorded AFTER the widow check, so the page is the one the
        // heading actually prints on rather than the one it was about to
        // overflow — which is the off-by-one a contents page shows up.
        headingPages.set(headingIndex, pdf.getPageCount());
        headingIndex += 1;
        // A heading is ranged or centred, never justified — see `DocAlign`.
        drawLines(lines, fs, 0, ink, undefined, ranged(b.align));
        y -= H_AFTER[b.level - 1]!;
        break;
      }

      case 'toc': {
        /**
         * ── THE CONTENTS PAGE ────────────────────────────────────────
         *
         * Entry, leader dots, page number. The dots are what make a long
         * title and a short one both readable across the measure, and
         * they are why a contents page looks like one rather than like a
         * list: the eye follows them to the number.
         *
         * On the FIRST pass the numbers are not known yet, so the space
         * is drawn and left blank. The lines are identical either way,
         * which is what keeps the two passes paginating the same.
         */
        const entries = tocEntries(blocks as Block[]);
        if (!entries.length) break;
        const titleFs = H_SIZE[1]!;
        y -= H_BEFORE[1]!;
        drawLines(layout([{ text: 'Contents', bold: true }], f, titleFs, colWidth, dropped),
          titleFs, 0, ink);
        y -= H_AFTER[1]!;
        const fs = BODY_SIZE;
        const lineH = fs * leading;
        entries.forEach((entry, n) => {
          need(lineH);
          // Indented by level, so the shape of the document is visible.
          const indent = (entry.level - 1) * 16;
          const at = known?.get(entry.index);
          const number = at ? String(at) : '';
          const numberFont = f.base('regular');
          const numberW = numberFont.widthOfTextAtSize(number, fs);
          const parts = shapeRun(entry.text, entry.level === 1 ? 'bold' : 'regular', f, dropped);
          const baseline = y - fs;
          let x = MARGIN + indent;
          for (const part of parts) {
            page.drawText(part.text, { x, y: baseline, size: fs, font: part.font, color: ink });
            x += part.font.widthOfTextAtSize(part.text, fs);
          }
          const right = MARGIN + colWidth;
          if (number) {
            page.drawText(number, {
              x: right - numberW, y: baseline, size: fs, font: numberFont, color: ink,
            });
            // Leader dots, stopping short of both ends so nothing collides.
            const from = x + 6;
            const to = right - numberW - 6;
            if (to > from) {
              const dot = numberFont.widthOfTextAtSize('.', fs);
              const count = Math.floor((to - from) / (dot * 2));
              for (let d = 0; d < count; d++) {
                page.drawText('.', {
                  x: from + d * dot * 2, y: baseline, size: fs, font: numberFont, color: hair,
                });
              }
            }
          }
          y -= lineH;
          if (n === entries.length - 1) y -= 10;
        });
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
      case 'space': {
        // Never at the top of a fresh page: leading a page with blank inches
        // looks like a fault, and the space was asked for BETWEEN two things.
        const room = Math.max(0, b.points);
        if (y < size.h - MARGIN - topOffset) y -= room;
        if (y < floor) newPage();
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
    headingPages,
  };
}
