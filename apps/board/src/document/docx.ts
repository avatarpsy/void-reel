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
import type { Block, DocSpec, Inline } from './blocks';
import { parseMarkdown } from './blocks';
import { loadImages, type LoadedImage } from './images';

/** Word measures in half-points; 22 is the 11pt a report is expected to be. */
const BODY_HALF_PT = 22;
const TWIP_PER_INCH = 1440;

export async function renderDocx(spec: DocSpec): Promise<Blob> {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle,
    Table, TableRow, TableCell, WidthType, ExternalHyperlink, ImageRun, Footer, PageNumber,
  } = await import('docx');

  const HEADING = [
    HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4,
  ] as const;

  const blocks = parseMarkdown(spec.markdown, spec.title);
  const images = await loadImages(blocks);
  const serif = spec.typeface !== 'sans';
  const body = serif ? 'Georgia' : 'Calibri';
  const display = serif ? 'Georgia' : 'Calibri Light';
  const mono = 'Consolas';

  const runsOf = (runs: Inline[], font: string, extra: Record<string, unknown> = {}): any[] => {
    const out: any[] = [];
    for (const r of runs) {
      const base = {
        text: r.text,
        bold: r.bold,
        italics: r.italic,
        strike: r.strike,
        font: r.code ? mono : font,
        ...(r.code ? { shading: { fill: 'F2F2F2' } } : {}),
        ...extra,
      };
      if (r.link) {
        out.push(new ExternalHyperlink({
          link: r.link,
          children: [new TextRun({ ...base, style: 'Hyperlink' })],
        }));
      } else {
        out.push(new TextRun(base));
      }
    }
    return out;
  };

  /** The one mapping from our word to Word's, so the two cannot disagree. */
  const alignOf = (a?: 'left' | 'center' | 'right') =>
    a === 'center' ? AlignmentType.CENTER
      : a === 'right' ? AlignmentType.RIGHT
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

  const children: any[] = [];
  for (const b of blocks as Block[]) {
    switch (b.kind) {
      case 'heading':
        children.push(new Paragraph({
          heading: HEADING[b.level - 1],
          children: runsOf(b.runs, display),
          spacing: { before: b.level === 1 ? 0 : 280, after: 140 },
          ...(b.align ? { alignment: alignOf(b.align) } : {}),
          // Word's own rule: a heading never sits alone at the foot of a page.
          keepNext: true,
        }));
        break;
      case 'para':
        children.push(new Paragraph({
          children: runsOf(b.runs, body),
          spacing: { after: 160, line: 300 }, // ~1.25 leading; single reads cramped
          ...(b.align ? { alignment: alignOf(b.align) } : {}),
        }));
        break;
      case 'list':
        children.push(new Paragraph({
          children: runsOf(b.runs, body),
          spacing: { after: 80, line: 300 },
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
          spacing: { before: 120, after: 160, line: 300 },
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
        const cell = (runs: Inline[], header: boolean) => new TableCell({
          children: [new Paragraph({
            children: runsOf(runs, body, header ? { bold: true } : {}),
            spacing: { before: 60, after: 60 },
          })],
          ...(header ? { shading: { fill: 'F2F2F2' } } : {}),
        });
        const rows: any[] = [];
        if (b.header.length) {
          // `tableHeader` repeats it at the top of every page the table spans.
          rows.push(new TableRow({ tableHeader: true, children: b.header.map((c) => cell(c, true)) }));
        }
        for (const r of b.rows) rows.push(new TableRow({ children: r.map((c) => cell(c, false)) }));
        if (rows.length) {
          children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
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
      }],
    },
    sections: [{
      properties: {
        page: {
          size: spec.pageSize === 'letter'
            ? { width: 12240, height: 15840 }   // 8.5 x 11in, in twips
            : { width: 11906, height: 16838 },  // A4
          margin: {
            top: TWIP_PER_INCH, bottom: TWIP_PER_INCH,
            left: TWIP_PER_INCH, right: TWIP_PER_INCH,
          },
        },
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ children: [PageNumber.CURRENT], font: body, size: 18, color: '8A8A8A' })],
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
