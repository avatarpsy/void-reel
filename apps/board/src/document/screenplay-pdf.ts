/**
 * A screenplay as a real PDF, set to the industry's actual measurements.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS WHEN THE DOCUMENT RENDERER ALREADY DOES
 * ══════════════════════════════════════════════════════════════════════════
 * A screenplay is a document and its CHROME should be identical to one — same
 * bar, same name field, same Download menu. Its PAGE is not. The format's
 * measurements are semantic: 12pt Courier at fixed indents is why a page runs
 * about a minute, which is the only reason anyone can judge pacing by looking
 * at a page count. Set a screenplay in a proportional face at prose measure and
 * you have destroyed the one piece of information its typography carries.
 *
 * So the shell is shared and this is the page.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT IT REPLACES
 * ══════════════════════════════════════════════════════════════════════════
 * `window.print()`. The screenplay's PDF was the browser's print dialog, which
 * saves nothing, hands back no file, and cannot run without a person in front
 * of it — the same gap the document exporter closed months of reasoning ago.
 * A screenwriter could not get a file out of their own script.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE MEASUREMENTS, AND WHY THEY ARE EXACT
 * ══════════════════════════════════════════════════════════════════════════
 * US Letter, 12pt Courier. Courier is 600/1000 em, so a 12pt character is
 * exactly 7.2pt wide and an inch holds exactly ten of them — which is why every
 * indent below is a round number of characters as well as of inches, and why a
 * page holds 54 lines. These are not house style; a reader who has held a
 * script will notice if they are wrong.
 */
import type { PDFFont, PDFPage } from 'pdf-lib';

/** Fountain element types, as the parser emits them. */
export interface ScriptLine {
  type: string;
  text: string;
  /** A title-page field's name and value — see `title_field` in `fountain.ts`. */
  key?: string;
  value?: string;
  /** Source line, when known — lets the editor mark where pages break. */
  line?: number;
}

const PAGE_W = 612;   // 8.5in
const PAGE_H = 792;   // 11in
const CH = 7.2;       // one 12pt Courier character
const LINE = 12;      // 12pt, set solid — 6 lines to the inch
const SIZE = 12;

/**
 * THE PAGE, in inches from the LEFT EDGE OF THE PAPER, as a script is
 * specified. Exported because the screen draws the same page:
 * `theme/screenplay-page.css` writes each of these in em (an inch is 6em at
 * 12pt Courier), and a test holds the two to each other.
 */
export const SCREENPLAY_INCHES = {
  left: 1.5,          // action and scene headings — the binding margin
  right: 1,
  top: 1,
  bottom: 1,
  character: 3.7,     // character cue
  parenthetical: 3.1,
  dialogue: 2.5,
} as const;

const IN = (n: number) => n * 72;
const LEFT = IN(SCREENPLAY_INCHES.left);
const RIGHT = PAGE_W - IN(SCREENPLAY_INCHES.right);  // 60 characters of text
const TOP = PAGE_H - IN(SCREENPLAY_INCHES.top);
const BOTTOM = IN(SCREENPLAY_INCHES.bottom);
const CHAR_X = IN(SCREENPLAY_INCHES.character);
const PAREN_X = IN(SCREENPLAY_INCHES.parenthetical);
const DIAL_X = IN(SCREENPLAY_INCHES.dialogue);

/** Wrap widths, in CHARACTERS, because the face is monospaced. */
export const WRAP = {
  action: 60,
  scene_heading: 60,
  centered: 60,
  transition: 60,
  character: 38,
  parenthetical: 28,
  dialogue: 35,
};

function wrap(text: string, chars: number): string[] {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (!line) { line = word; continue; }
    if (line.length + 1 + word.length <= chars) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

/** Rows of text a page holds between its margins — 54, six to the inch. */
const ROWS = Math.round((TOP - BOTTOM) / LINE);

/** One line of type on a page: which row, how far in, what it says. */
export interface LaidRow {
  row: number;
  /** From the LEFT EDGE OF THE PAPER, in points. */
  x: number;
  text: string;
  bold: boolean;
  /** The source line it came from, so the editor can mark where pages break. */
  line?: number;
}

export interface ScreenplayLayout {
  /** The title page's contents, or null when the script has no `Title:`. */
  title: { title: string; credit: string; corner: string[] } | null;
  /** The script's pages, after the title page. */
  pages: Array<{ rows: LaidRow[] }>;
  /** The source line each script page begins on — page 1 included. */
  starts: Array<{ page: number; line: number }>;
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * WHERE EVERY LINE GOES — the page, as numbers, with no PDF in sight
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Pure, so the EDITOR can ask the same question the printer does. The screen
 * shows a hairline where each page will break, and it is drawn from this, not
 * estimated — which is the only way "page 12" on screen is page 12 on paper.
 *
 * ── THE RHYTHM IS THE SOURCE'S ────────────────────────────────────────────
 * Every blank line in the Fountain is one blank line on the page; a scene
 * heading takes one more, so a new scene reads as a new scene. That is the
 * rule the editor draws by as well — line for line — so the gaps a writer sees
 * while typing are the gaps that print.
 *
 * The old rule ADDED spacing per element ON TOP of the source's blank lines:
 * three blank lines before every scene and two before every cue, where a
 * script has two and one. The page read loose, and ran longer than it was.
 *
 * ── WHAT IS KEPT TOGETHER ─────────────────────────────────────────────────
 * A scene heading is never the last thing on a page (it promises a scene the
 * page does not show), and a character cue is never parted from its first
 * line. Blank lines never open a page.
 */
export function layoutScreenplay(
  lines: ScriptLine[],
  opts: { title?: string; credit?: string } = {},
): ScreenplayLayout {
  const title = String(opts.title ?? '').trim();
  const pages: Array<{ rows: LaidRow[] }> = [{ rows: [] }];
  const starts: Array<{ page: number; line: number }> = [];
  let row = 0;
  /** Blank source lines waiting to be set before the next printed element. */
  let pending = 0;

  const newPage = () => { pages.push({ rows: [] }); row = 0; };
  const put = (text: string, x: number, bold: boolean, line?: number) => {
    if (row >= ROWS) newPage();
    const page = pages[pages.length - 1]!;
    if (!page.rows.length && line !== undefined) starts.push({ page: pages.length, line });
    page.rows.push({ row, x, text, bold, line });
    row++;
  };
  /**
   * Take `blanks` of space before an element `body` rows tall, which must have
   * `keep` more rows after it on the same page. Starts a page instead when it
   * will not fit — and then the blank lines are dropped, never carried over.
   */
  const room = (blanks: number, body: number, keep = 0) => {
    if (row === 0) return;
    if (row + blanks + body + keep > ROWS) { newPage(); return; }
    row += blanks;
  };

  for (const el of lines) {
    const type = String(el.type ?? 'action');
    const text = String(el.text ?? '');
    if (type === 'blank') { pending++; continue; }
    // A forced break on a page with nothing on it yet would print a blank page.
    if (type === 'page_break') {
      if (pages[pages.length - 1]!.rows.length) newPage();
      pending = 0;
      continue;
    }
    /**
     * NOT PRINTED, and the blank line around them goes with them — otherwise
     * a sequence heading between two scenes left a hole in the page where it
     * had been. The title fields are set on the title page instead.
     */
    if (type === 'synopsis' || type === 'section' || (type === 'title_field' && title)) {
      pending = 0;
      continue;
    }
    if (!text.trim()) continue;

    const blanks = type === 'scene_heading' ? pending + 1 : pending;
    pending = 0;
    const at = el.line;

    switch (type) {
      case 'scene_heading': {
        const body = wrap(text.toUpperCase(), WRAP.scene_heading);
        room(blanks, body.length, 2);
        for (const line of body) put(line, LEFT, true, at);
        break;
      }
      case 'character': {
        const body = wrap(text.toUpperCase(), WRAP.character);
        room(blanks, body.length, 1);
        for (const line of body) put(line, CHAR_X, false, at);
        break;
      }
      case 'parenthetical':
        room(blanks, 1);
        for (const line of wrap(text, WRAP.parenthetical)) put(line, PAREN_X, false, at);
        break;
      case 'dialogue':
        room(blanks, 1);
        for (const line of wrap(text, WRAP.dialogue)) put(line, DIAL_X, false, at);
        break;
      case 'transition':
        room(blanks, 1);
        for (const line of wrap(text.toUpperCase(), WRAP.transition)) {
          put(line, RIGHT - line.length * CH, false, at);
        }
        break;
      case 'centered':
        room(blanks, 1);
        for (const line of wrap(text, WRAP.centered)) put(line, (PAGE_W - line.length * CH) / 2, false, at);
        break;
      default:
        room(blanks, 1);
        for (const line of wrap(text, WRAP.action)) put(line, LEFT, false, at);
        break;
    }
  }

  return {
    title: title
      ? {
        title,
        credit: String(opts.credit ?? '').trim(),
        /**
         * The draft and the contact, bottom left — where every script carries
         * them. They were once printed as action on page two instead, straight
         * after a title page that had already said who wrote it.
         */
        corner: lines
          .filter((el) => el.type === 'title_field' && (el.key === 'draft date' || el.key === 'contact'))
          .map((el) => String(el.value ?? '').trim())
          .filter(Boolean),
      }
      : null,
    pages,
    starts,
  };
}

export interface ScreenplayPdfResult {
  blob: Blob;
  pages: number;
  droppedGlyphs: number;
}

export async function renderScreenplayPdf(
  lines: ScriptLine[],
  opts: { title?: string; credit?: string } = {},
): Promise<ScreenplayPdfResult> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const { winAnsi } = await import('./pdf');

  const pdf = await PDFDocument.create();
  const courier: PDFFont = await pdf.embedFont(StandardFonts.Courier);
  const bold: PDFFont = await pdf.embedFont(StandardFonts.CourierBold);
  const dropped = { n: 0 };
  const ink = rgb(0, 0, 0);
  const layout = layoutScreenplay(lines, opts);

  const text = (page: PDFPage, s: string, x: number, y: number, font: PDFFont) => {
    page.drawText(winAnsi(s, dropped), { x, y: y - SIZE, size: SIZE, font, color: ink });
  };

  /**
   * THE TITLE PAGE, which a script is not a script without. Centred, about a
   * third of the way down, credit below it — the convention everywhere.
   */
  if (layout.title) {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - IN(4);
    for (const line of wrap(layout.title.title.toUpperCase(), WRAP.centered)) {
      text(page, line, (PAGE_W - line.length * CH) / 2, y, bold);
      y -= LINE;
    }
    if (layout.title.credit) {
      y -= LINE * 2;
      for (const line of wrap(layout.title.credit, WRAP.centered)) {
        text(page, line, (PAGE_W - line.length * CH) / 2, y, courier);
        y -= LINE;
      }
    }
    y = BOTTOM + LINE * layout.title.corner.length;
    for (const line of layout.title.corner) {
      text(page, line, LEFT, y, courier);
      y -= LINE;
    }
  }

  layout.pages.forEach((laid, i) => {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    for (const r of laid.rows) text(page, r.text, r.x, TOP - r.row * LINE, r.bold ? bold : courier);
    /**
     * Page numbers top-right, from page two — and never on the title page,
     * which is the one rule everybody notices being broken.
     */
    if (i > 0) {
      const label = `${i + 1}.`;
      text(page, label, RIGHT - label.length * CH, PAGE_H - IN(0.5), courier);
    }
  });

  pdf.setTitle(layout.title?.title || 'Screenplay');
  pdf.setProducer('Voidspace');
  pdf.setCreator('Voidspace');

  return {
    blob: new Blob([(await pdf.save()) as unknown as BlobPart], { type: 'application/pdf' }),
    pages: pdf.getPageCount(),
    droppedGlyphs: dropped.n,
  };
}
