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
}

const PAGE_W = 612;   // 8.5in
const PAGE_H = 792;   // 11in
const CH = 7.2;       // one 12pt Courier character
const LINE = 12;      // 12pt, set solid — 6 lines to the inch
const SIZE = 12;

/** From the LEFT EDGE OF THE PAPER, in inches, as a script is specified. */
const IN = (n: number) => n * 72;
const LEFT = IN(1.5);          // action and scene headings
const RIGHT = PAGE_W - IN(1);  // 60 characters of text
const TOP = PAGE_H - IN(1);
const BOTTOM = IN(1);
const CHAR_X = IN(3.7);        // character cue
const PAREN_X = IN(3.1);
const DIAL_X = IN(2.5);

/** Wrap widths, in CHARACTERS, because the face is monospaced. */
const WRAP = {
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

/** Blank lines BEFORE an element — the rhythm a script is read at. */
function leadingBlanks(type: string, previous: string | null): number {
  if (previous === null) return 0;
  if (type === 'scene_heading') return 2;
  if (type === 'character') return 1;
  if (type === 'action') return previous === 'action' ? 1 : 1;
  if (type === 'transition') return 1;
  if (type === 'centered') return 1;
  // Dialogue and parentheticals sit directly under their cue.
  return 0;
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

  let page: PDFPage = pdf.addPage([PAGE_W, PAGE_H]);
  let y = TOP;

  const newPage = () => { page = pdf.addPage([PAGE_W, PAGE_H]); y = TOP; };
  const draw = (text: string, x: number, font: PDFFont = courier) => {
    if (y < BOTTOM) newPage();
    page.drawText(winAnsi(text, dropped), { x, y: y - SIZE, size: SIZE, font, color: ink });
    y -= LINE;
  };
  const blank = (n: number) => {
    for (let i = 0; i < n; i++) {
      if (y < BOTTOM) { newPage(); return; } // never open a page with blank lines
      y -= LINE;
    }
  };

  /**
   * THE TITLE PAGE, which a script is not a script without. Centred, about a
   * third of the way down, credit below it — the convention everywhere.
   */
  const title = String(opts.title ?? '').trim();
  if (title) {
    y = PAGE_H - IN(4);
    for (const line of wrap(title.toUpperCase(), WRAP.centered)) {
      const w = line.length * CH;
      page.drawText(winAnsi(line, dropped), {
        x: (PAGE_W - w) / 2, y: y - SIZE, size: SIZE, font: bold, color: ink,
      });
      y -= LINE;
    }
    const credit = String(opts.credit ?? '').trim();
    if (credit) {
      y -= LINE * 2;
      for (const line of wrap(credit, WRAP.centered)) {
        const w = line.length * CH;
        page.drawText(winAnsi(line, dropped), {
          x: (PAGE_W - w) / 2, y: y - SIZE, size: SIZE, font: courier, color: ink,
        });
        y -= LINE;
      }
    }
    /**
     * The draft and the contact, bottom left — where every script carries
     * them. They were being printed as action on page two instead, straight
     * after a title page that had already said who wrote it.
     */
    const corner = lines
      .filter((el) => el.type === 'title_field' && (el.key === 'draft date' || el.key === 'contact'))
      .map((el) => String(el.value ?? '').trim())
      .filter(Boolean);
    y = BOTTOM + LINE * corner.length;
    for (const line of corner) {
      page.drawText(winAnsi(line, dropped), { x: LEFT, y: y - SIZE, size: SIZE, font: courier, color: ink });
      y -= LINE;
    }
    newPage();
  }

  let previous: string | null = null;
  for (const el of lines) {
    const type = String(el.type ?? 'action');
    const text = String(el.text ?? '');
    // The title page is set above, from the same fields. With no title there
    // is no title page, and a draft date must not vanish with it.
    if (type === 'title_field' && title) continue;
    // Not at the top of a page: the blank line that followed the title page
    // would otherwise open page two a line down.
    if (type === 'blank') { if (y < TOP) blank(1); continue; }
    if (type === 'page_break') { newPage(); previous = null; continue; }
    // Synopses and section headers are the writer's scaffolding, not the script.
    if (type === 'synopsis' || type === 'section') continue;
    if (!text.trim()) { previous = type; continue; }

    blank(leadingBlanks(type, previous));

    switch (type) {
      case 'scene_heading':
        for (const line of wrap(text.toUpperCase(), WRAP.scene_heading)) draw(line, LEFT, bold);
        break;
      case 'character':
        for (const line of wrap(text.toUpperCase(), WRAP.character)) draw(line, CHAR_X);
        break;
      case 'parenthetical':
        for (const line of wrap(text, WRAP.parenthetical)) draw(line, PAREN_X);
        break;
      case 'dialogue':
        for (const line of wrap(text, WRAP.dialogue)) draw(line, DIAL_X);
        break;
      case 'transition':
        for (const line of wrap(text.toUpperCase(), WRAP.transition)) {
          draw(line, RIGHT - line.length * CH);
        }
        break;
      case 'centered':
        for (const line of wrap(text, WRAP.centered)) {
          draw(line, (PAGE_W - line.length * CH) / 2);
        }
        break;
      default:
        for (const line of wrap(text, WRAP.action)) draw(line, LEFT);
        break;
    }
    previous = type;
  }

  /**
   * Page numbers top-right, from page two — and never on the title page, which
   * is the one rule everybody notices being broken.
   */
  const pages = pdf.getPages();
  const first = title ? 1 : 0;
  pages.forEach((p, i) => {
    if (i <= first) return;
    const label = `${i + 1 - first}.`;
    p.drawText(label, {
      x: RIGHT - label.length * CH, y: PAGE_H - IN(0.5) - SIZE,
      size: SIZE, font: courier, color: ink,
    });
  });

  pdf.setTitle(title || 'Screenplay');
  pdf.setProducer('Voidspace');
  pdf.setCreator('Voidspace');

  return {
    blob: new Blob([(await pdf.save()) as unknown as BlobPart], { type: 'application/pdf' }),
    pages: pages.length,
    droppedGlyphs: dropped.n,
  };
}
