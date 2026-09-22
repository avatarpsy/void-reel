/**
 * A real Word file, written in the browser.
 *
 * The `docx` package is ~500KB and only a user who actually exports needs it,
 * so it is imported at the moment of use rather than at module load. Vite gives
 * it its own chunk; a session that never exports never downloads it.
 *
 * WHAT WORD GETS THAT A PDF CANNOT GIVE: editable text, real headings that feed
 * a navigation pane and a table of contents, comments and track-changes, and —
 * the one that matters most in practice — any script at all. A PDF written with
 * the standard fonts cannot set Japanese or emoji; this can, because the fonts
 * are resolved on the reader's machine, not embedded by us.
 */
import type { Block, DocAlign, DocSpec, Inline } from './blocks';
import { headingNumbers, parseMarkdown, wantsNumbering } from './blocks';
import { loadImages, type LoadedImage } from './images';

/** Word measures in half-points; 22 is the 11pt a report is expected to be. */
const BODY_HALF_PT = 22;
const TWIP_PER_INCH = 1440;

export async function renderDocx(spec: DocSpec): Promise<Blob> {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle,
    Table, TableRow, TableCell, TableLayoutType, WidthType, ExternalHyperlink, ImageRun,
    Footer, Header, PageNumber,
    PageBreak, PageOrientation, TableOfContents, LevelFormat,
  } = await import('docx');

  const HEADING = [
    HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4,
  ] as const;

  const blocks = parseMarkdown(spec.markdown, spec.title);
  // One answer for both writers — see `wantsNumbering`.
  const numbered = wantsNumbering(spec, blocks);
  /**
   * The SAME numbering the PDF prints — see `headingNumbers`. Word is told
   * the level and counts for itself, so it gets the DEPTH rather than the
   * digits; a heading the rule does not number (the document's own title)
   * gets no numbering property at all.
   */
  const numbers = headingNumbers(blocks, numbered);
  let headingIndex = 0;
  const images = await loadImages(blocks);
  const serif = spec.typeface !== 'sans';
  const body = serif ? 'Georgia' : 'Calibri';
  const display = serif ? 'Georgia' : 'Calibri Light';
  const mono = 'Consolas';

  /** `#aabbcc` → `AABBCC`. Word rejects the hash and ignores the colour. */
  /**
   * Word measures line spacing in TWENTIETHS OF A POINT, and 240 is single.
   * 300 has always been this writer's body leading (1.25); `lineSpacing` scales
   * from single so that 2 means what a university means by double-spaced.
   */
  const LINE = 300;
  const asked = Number(spec.lineSpacing);
  const line = Number.isFinite(asked) && asked > 0
    ? Math.round(240 * Math.min(3, Math.max(0.8, asked)))
    : LINE;

  /** The newline a hard break becomes in the block model. */
  const BREAK = String.fromCharCode(10);

  const hex6 = (value: string) => String(value ?? '').replace('#', '').toUpperCase();

  const runsOf = (runs: Inline[], font: string, extra: Record<string, unknown> = {}): any[] => {
    const out: any[] = [];
    for (const r of runs) {
      const base = {
        text: r.text,
        bold: r.bold,
        italics: r.italic,
        strike: r.strike,
        // docx's own shape: `{}` means a plain single underline, and the key
        // must be ABSENT rather than false, or Word draws one anyway.
        ...(r.underline ? { underline: {} } : {}),
        ...(r.color ? { color: hex6(r.color) } : {}),
        // Shading is Word's highlight. `highlight` also exists but takes one of
        // 15 named colours, so it cannot carry an arbitrary hex.
        ...(r.highlight ? { shading: { fill: hex6(r.highlight) } } : {}),
        // HALF-POINTS. A 22pt run is `size: 44`; passing 22 sets it at 11pt,
        // which looks like the size was ignored rather than halved.
        ...(r.size ? { size: Math.round(r.size * 2) } : {}),
        font: r.code ? mono : font,
        ...(r.code ? { shading: { fill: 'F2F2F2' } } : {}),
        ...extra,
      };
      /**
       * ── A HARD BREAK INSIDE A RUN ─────────────────────────────────────────
       *
       * The PDF splits on the newline and sets two lines. Word has no newline
       * inside a run at all: the character is simply not rendered, so an
       * address block came out as one welded line — found by unzipping the
       * .docx and looking for `<w:br/>`, which was not there.
       *
       * `break: 1` puts the break BEFORE that run's text, so the pieces after
       * the first each carry one.
       */
      const pieces = String(base.text ?? '').split(BREAK);
      const parts = pieces.map((text, i) => ({ ...base, text, ...(i ? { break: 1 } : {}) }));
      for (const part of parts) {
        if (r.link) {
          out.push(new ExternalHyperlink({
            link: r.link,
            children: [new TextRun({ ...part, style: 'Hyperlink' })],
          }));
        } else {
          out.push(new TextRun(part));
        }
      }
    }
    return out;
  };

  /** A heading is ranged or centred, never justified — see `DocAlign`. */
  const ranged = (a?: DocAlign): DocAlign => (a === 'justify' ? 'left' : a ?? 'left');

  /**
   * The one mapping from our word to Word's, so the two cannot disagree.
   *
   * `justify` is free here: Word has set both edges flush since it existed,
   * and its own hyphenation and spacing rules are better than anything we
   * would write. The PDF has to do the work itself — see `drawLines`.
   */
  const alignOf = (a?: DocAlign) =>
    a === 'center' ? AlignmentType.CENTER
      : a === 'right' ? AlignmentType.RIGHT
        : a === 'justify' ? AlignmentType.JUSTIFIED
          : AlignmentType.LEFT;

  const picture = (img: LoadedImage, requested?: number) => {
    // Fit the text column — 6.5in at 1in margins. An explicit width wins, so a
    // logo can be a logo; without one this fell back to the column and set a
    // letterhead mark the width of the page. See `imageHints` in blocks.ts.
    const maxW = 624; // px at 96dpi
    const target = requested ? Math.min(requested, maxW) : Math.min(img.width, maxW);
    const scale = target / Math.max(1, img.width);
    return new ImageRun({
      data: img.bytes,
      type: img.png ? 'png' : 'jpg',
      transformation: {
        width: Math.round(img.width * scale),
        height: Math.round(img.height * scale),
      },
    } as any);
  };

  /**
   * `{page}` and `{pages}` become Word's own FIELDS rather than baked numbers,
   * so they stay correct when the reader edits the document and the pagination
   * moves. A number typed into a footer is wrong the moment anybody adds a
   * paragraph.
   */
  const chromeRuns = (text: string): any[] => {
    const out: any[] = [];
    for (const part of String(text).split(/(\{page\}|\{pages\})/gi)) {
      if (!part) continue;
      const low = part.toLowerCase();
      if (low === '{page}') {
        out.push(new TextRun({ children: [PageNumber.CURRENT], font: body, size: 18, color: '8A8A8A' }));
      } else if (low === '{pages}') {
        out.push(new TextRun({ children: [PageNumber.TOTAL_PAGES], font: body, size: 18, color: '8A8A8A' }));
      } else {
        out.push(new TextRun({ text: part, font: body, size: 18, color: '8A8A8A' }));
      }
    }
    return out;
  };
  const headerText = String(spec.header ?? '').trim();
  const footerText = String(spec.footer ?? '').trim();
  const docxMargin = typeof spec.margin === 'number'
    // Points to twips: 20 twips to a point.
    ? Math.max(360, Math.min(4320, Math.round(spec.margin * 20)))
    : spec.margin === 'narrow' ? Math.round(TWIP_PER_INCH / 2)
      : spec.margin === 'wide' ? Math.round(TWIP_PER_INCH * 1.5)
        : TWIP_PER_INCH;

  const children: any[] = [];
  for (const b of blocks as Block[]) {
    switch (b.kind) {
      case 'pagebreak':
        children.push(new Paragraph({ children: [new PageBreak()] }));
        break;

      case 'toc':
        /**
         * Word's OWN contents field, not a list we typed.
         *
         * It is built from the heading styles already in the document, so
         * it renumbers and repaginates itself when the reader edits — which
         * a list of our own page numbers could not, and would be wrong the
         * first time they added a paragraph.
         *
         * The cost is honest and worth saying: Word populates the field
         * when it opens the file, and until it does the reader may see
         * "Right-click to update". Some lightweight viewers show it empty.
         * The PDF has a real, already-set contents page for that reason.
         */
        children.push(new Paragraph({
          children: [new TextRun({ text: 'Contents', bold: true, size: 31 })],
          spacing: { before: 280, after: 140 },
        }));
        // `1-3`: the same three levels the PDF lists.
        children.push(new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-3' }));
        break;
      case 'space':
        /**
         * An empty paragraph whose HEIGHT IS the gap. Word has no other way to
         * say 'leave this much room' that survives being edited afterwards.
         *
         * EXACT line spacing, not `after`. Spacing-after is added to the
         * paragraph's own line, and an empty paragraph still has one — so a
         * 36pt gap came out of Word at about 49pt while the PDF gave 36pt,
         * and the same document did not match itself across the two formats.
         * An exact line makes the paragraph's whole height the number asked
         * for. Twentieths of a point, which is what `w:line` counts.
         */
        children.push(new Paragraph({
          text: '',
          spacing: { before: 0, after: 0, line: Math.round(b.points * 20), lineRule: 'exact' },
        }));
        break;
      case 'heading': {
        const headingDepth = numbers.get(headingIndex)?.depth;
        headingIndex += 1;
        children.push(new Paragraph({
          heading: HEADING[b.level - 1],
          children: runsOf(b.runs, display),
          spacing: { before: b.level === 1 ? 0 : 280, after: 140 },
          // Ranged or centred, never justified — a heading has too few
          // words to spread slack across. See `DocAlign`.
          ...(b.align ? { alignment: alignOf(ranged(b.align)) } : {}),
          // Word counts these itself, so they survive the reader editing.
          ...(headingDepth !== undefined
            ? { numbering: { reference: 'vs-heading-numbers', level: headingDepth - 1 } }
            : {}),
          // Word's own rule: a heading never sits alone at the foot of a page.
          keepNext: true,
        }));
        break;
      }
      case 'para':
        children.push(new Paragraph({
          children: runsOf(b.runs, body),
          spacing: { after: 160, line }, // 1.25 leading; single reads cramped
          ...(b.align ? { alignment: alignOf(b.align) } : {}),
        }));
        break;
      case 'list':
        children.push(new Paragraph({
          children: runsOf(b.runs, body),
          spacing: { after: 80, line },
          ...(b.ordered
            ? { numbering: { reference: 'vs-ordered', level: Math.min(2, b.level) } }
            : { bullet: { level: Math.min(2, b.level) } }),
        }));
        break;
      case 'quote':
        children.push(new Paragraph({
          children: runsOf(b.runs, body, { italics: true, color: '4A4A4A' }),
          indent: { left: 480 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, space: 12, color: 'BDBDBD' } },
          spacing: { before: 120, after: 160, line },
        }));
        break;
      case 'code':
        // One paragraph per line: Word has no <pre>, and a single run holding
        // newlines collapses to one long line in some readers.
        for (const line of b.text.split('\n')) {
          children.push(new Paragraph({
            children: [new TextRun({ text: line || ' ', font: mono, size: 19 })],
            shading: { fill: 'F6F6F6' },
            indent: { left: 240 },
            spacing: { after: 0, line: 260 },
          }));
        }
        children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
        break;
      case 'rule':
        children.push(new Paragraph({
          text: '',
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 8, color: 'D0D0D0' } },
          spacing: { before: 160, after: 200 },
        }));
        break;
      case 'image': {
        const img = images.get(b.url);
        // An image with no stated alignment stays centred, which is right for a
        // figure; a letterhead says `align=left` and gets it.
        const imgAlign = b.align ? alignOf(b.align) : AlignmentType.CENTER;
        if (img) {
          children.push(new Paragraph({
            alignment: imgAlign,
            spacing: { before: 160, after: 80 },
            children: [picture(img, b.width)],
          }));
        }
        if (b.alt) {
          children.push(new Paragraph({
            alignment: imgAlign,
            children: [new TextRun({ text: b.alt, font: body, size: 18, italics: true, color: '6A6A6A' })],
            spacing: { after: 200 },
          }));
        }
        break;
      }
      case 'table': {
        const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
        /**
         * Relative weights, expressed to Word as percentages of the table. Same
         * normalisation as the PDF writer, so `cols: 3,1,1` produces the same
         * proportions in both files rather than two tables that look related.
         */
        const weights = Array.from({ length: cols }, (_, i) => {
          const w = Number(b.widths?.[i]);
          return Number.isFinite(w) && w > 0 ? w : 1;
        });
        const sum = weights.reduce((n, w) => n + w, 0);
        const pct = weights.map((w) => (w / sum) * 100);
        const cell = (runs: Inline[], header: boolean, i: number) => new TableCell({
          children: [new Paragraph({
            children: runsOf(runs, body, header ? { bold: true } : {}),
            spacing: { before: 60, after: 60 },
            ...(b.align?.[i] ? { alignment: alignOf(b.align[i]!) } : {}),
          })],
          width: { size: pct[i] ?? 100 / cols, type: WidthType.PERCENTAGE },
          ...(header ? { shading: { fill: 'F2F2F2' } } : {}),
        });
        const rows: any[] = [];
        if (b.header.length) {
          // `tableHeader` repeats it at the top of every page the table spans.
          rows.push(new TableRow({
            tableHeader: true, children: b.header.map((c, i) => cell(c, true, i)),
          }));
        }
        for (const r of b.rows) {
          rows.push(new TableRow({ children: r.map((c, i) => cell(c, false, i)) }));
        }
        if (rows.length) {
          children.push(new Table({
            rows,
            width: { size: 100, type: WidthType.PERCENTAGE },
            // Without this Word ignores the per-cell percentages and sizes the
            // columns to their contents instead.
            layout: TableLayoutType.FIXED,
          }));
          children.push(new Paragraph({ text: '', spacing: { after: 200 } }));
        }
        break;
      }
    }
  }

  if (!children.length) children.push(new Paragraph({ text: '' }));

  const doc = new Document({
    title: spec.title || undefined,
    creator: 'Voidspace',
    description: spec.title ? `${spec.title} — created in Voidspace` : 'Created in Voidspace',
    styles: { default: { document: { run: { font: body, size: BODY_HALF_PT } } } },
    numbering: {
      config: [{
        reference: 'vs-ordered',
        levels: [0, 1, 2].map((level) => ({
          level,
          format: level === 0 ? 'decimal' : level === 1 ? 'lowerLetter' : 'lowerRoman',
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
        })),
      }, {
        /**
         * NUMBERED HEADINGS — 1, 1.1, 1.1.1 — as Word's own multilevel list.
         *
         * Not text we wrote into the heading: Word renumbers this when the
         * reader inserts a section, which is the entire reason a contract
         * or a policy numbers its clauses in the first place. A literal
         * "3.2" typed into the words is wrong the moment anybody edits.
         *
         * `%1.%2` and `%1.%2.%3` are Word's own syntax for "the counters
         * above me, then mine".
         */
        reference: 'vs-heading-numbers',
        levels: [0, 1, 2, 3].map((level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: Array.from({ length: level + 1 }, (_, n) => `%${n + 1}`).join('.'),
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 0, hanging: 360 } } },
        })),
      }],
    },
    sections: [{
      properties: {
        page: {
          size: {
            ...(spec.pageSize === 'letter'
              ? { width: 12240, height: 15840 }   // 8.5 x 11in, in twips
              : { width: 11906, height: 16838 }), // A4
            // Word turns the sheet itself; the width/height above stay as the
            // paper's, which is what every word processor means by landscape.
            ...(spec.orientation === 'landscape'
              ? { orientation: PageOrientation.LANDSCAPE }
              : {}),
          },
          margin: {
            top: docxMargin, bottom: docxMargin, left: docxMargin, right: docxMargin,
          },
        },
      },
      ...(headerText
        ? {
          headers: {
            default: new Header({
              children: [new Paragraph({
                alignment: AlignmentType.CENTER,
                children: chromeRuns(headerText),
              })],
            }),
          },
        }
        : {}),
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            // A document that supplies its own footer owns it — page numbers go
            // wherever it puts {page}. Otherwise the bare number stays.
            children: footerText
              ? chromeRuns(footerText)
              : [new TextRun({ children: [PageNumber.CURRENT], font: body, size: 18, color: '8A8A8A' })],
          })],
        }),
      },
      children,
    }],
  });

  // `toBlob` and not `toBuffer`: there is no Node Buffer here, and a Blob is
  // what both a download and an upload want anyway.
  return Packer.toBlob(doc);
}
