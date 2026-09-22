/**
 * A Word file, READ PROPERLY — into the same block model everything else uses.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY NOT MAMMOTH, WHICH WE ALREADY HAVE
 * ══════════════════════════════════════════════════════════════════════════
 * mammoth is a good library doing a different job, and it says so: it converts
 * SEMANTIC styles and deliberately discards direct formatting. Its documented
 * philosophy is that a heading should be a heading because it was styled as
 * one, not because somebody made it big and bold — which is right for turning
 * a Word file into clean HTML for the web, and wrong for editing.
 *
 * What it drops is exactly what a letterhead is made of: underline, text
 * colour, point size, paragraph alignment, page size, margins, orientation,
 * running headers and footers, table column widths, explicit page breaks. A
 * document that went out through mammoth and came back was a different
 * document — same words, none of the design.
 *
 * So this reads the OOXML. A .docx is a zip of XML, the markup is well
 * documented, and everything above is right there in it. It is more code than
 * calling a library, and it is the difference between "we can read your
 * document" and "we can edit your document".
 *
 * mammoth stays where it belongs: the READING path, where a model wants the
 * words and the formatting is noise.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT IS NOT RECOVERED, AND IS NOT PRETENDED
 * ══════════════════════════════════════════════════════════════════════════
 * Text boxes, shapes, SmartArt, charts, comments, tracked changes, footnotes,
 * fields other than page numbers, and anything positioned rather than flowed.
 * `unsupported` names what was seen and skipped, so the user is told rather
 * than left to notice.
 */
import type { Block, DocAlign, DocSpec, Inline } from './blocks';
import { readZipMap } from './zip';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export interface ImportedDocument {
  blocks: Block[];
  /** Page setup recovered from the section properties. */
  spec: Partial<DocSpec>;
  /** Pictures found, in document order, for a caller that can store them. */
  images: ImportedImage[];
  /** Constructs seen and not represented. Tell the user; do not swallow them. */
  unsupported: string[];
}

export interface ImportedImage {
  /** Where it appeared: the index of the image block in `blocks`. */
  blockIndex: number;
  bytes: Uint8Array;
  contentType: string;
  /** Points, from the drawing's own extent. */
  width?: number;
}

/* ── the small XML helpers ─────────────────────────────────────────────────── */

const kids = (el: Element, name: string): Element[] =>
  Array.from(el.children).filter((c) => c.localName === name);

const kid = (el: Element | null | undefined, name: string): Element | null =>
  el ? kids(el, name)[0] ?? null : null;

/** `w:val`, which is how OOXML says "the value of this element". */
const val = (el: Element | null): string | null =>
  el?.getAttributeNS(W, 'val') ?? el?.getAttribute('w:val') ?? null;

/**
 * A toggle property: `<w:b/>` is on, `<w:b w:val="0"/>` is off.
 *
 * The second form exists because a run can switch OFF something its style
 * turned on, and reading the element's presence alone makes every such run
 * bold. Word writes this constantly.
 */
function toggle(pr: Element | null, name: string): boolean {
  const el = kid(pr, name);
  if (!el) return false;
  const v = val(el);
  return v !== '0' && v !== 'false' && v !== 'off';
}

/**
 * A width, whatever unit it is in.
 *
 * `w:w` is twentieths of a point when the type is `dxa` and a PERCENTAGE when
 * the type is `pct` — and in the percentage case the value carries a literal
 * `%`, so `Number('66.666%')` is NaN and every column came out equal. The unit
 * does not matter here because the widths are normalised to relative weights;
 * only the number does.
 */
function widthValue(raw: string | null | undefined): number {
  const n = Number(String(raw ?? '').replace('%', '').trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Twentieths of a point — Word's unit for anything measured in points. */
const fromTwips = (raw: string | null | undefined): number | undefined => {
  const n = Number(raw);
  return Number.isFinite(n) ? n / 20 : undefined;
};

/** English Metric Units — 914400 per inch, used by everything in a drawing. */
const fromEmu = (raw: string | null | undefined): number | undefined => {
  const n = Number(raw);
  return Number.isFinite(n) ? (n / 914400) * 72 : undefined;
};

function colourOf(raw: string | null): string | undefined {
  const hex = String(raw ?? '').trim().toLowerCase();
  // `auto` means "whatever the theme says", which is the default ink — carrying
  // it as a colour would pin black onto text that should follow the document.
  if (!/^[0-9a-f]{6}$/.test(hex) || hex === 'auto') return undefined;
  return `#${hex}`;
}

const ALIGN: Record<string, DocAlign> = {
  center: 'center', right: 'right', end: 'right', left: 'left', start: 'left',
  // `both` is justified. The model has no justification, and LEFT is what it
  // looks like far more often than centre — the honest approximation.
  both: 'left', distribute: 'left',
};

/* ── runs ──────────────────────────────────────────────────────────────────── */

function runProps(rPr: Element | null, link?: string): Partial<Inline> {
  if (!rPr) return link ? { link } : {};
  const marks: Partial<Inline> = {};
  if (toggle(rPr, 'b')) marks.bold = true;
  if (toggle(rPr, 'i')) marks.italic = true;
  if (toggle(rPr, 'strike') || toggle(rPr, 'dstrike')) marks.strike = true;

  const u = kid(rPr, 'u');
  // `none` is Word switching underline off, and it is not the same as absent.
  if (u && val(u) !== 'none') marks.underline = true;

  const colour = colourOf(val(kid(rPr, 'color')));
  if (colour) marks.color = colour;

  // Half-points. A 22pt run is `<w:sz w:val="44"/>`, and reading it as 44 would
  // set every imported document at twice its real size.
  const sz = Number(val(kid(rPr, 'sz')));
  if (Number.isFinite(sz) && sz > 0) marks.size = Math.min(200, Math.max(4, sz / 2));

  // Two ways to highlight: a named colour, or cell shading behind the run.
  const highlight = val(kid(rPr, 'highlight'));
  const shd = kid(rPr, 'shd');
  const shading = colourOf(shd?.getAttributeNS(W, 'fill') ?? shd?.getAttribute('w:fill') ?? null);
  if (highlight && highlight !== 'none') marks.highlight = NAMED_HIGHLIGHT[highlight] ?? '#fff3a3';
  else if (shading && shading !== '#ffffff') marks.highlight = shading;

  if (val(kid(rPr, 'rStyle')) === 'Hyperlink' && !link) { /* styling only; no href here */ }
  if (link) marks.link = link;
  return marks;
}

/** Word's 15 highlight names, which are names rather than values. */
const NAMED_HIGHLIGHT: Record<string, string> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff',
  blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080',
  darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000',
};

const BREAK = String.fromCharCode(10);

/** One `w:r`, as runs — a run can produce several when it contains breaks. */
function runsOf(r: Element, marks: Partial<Inline>, ctx: Ctx): Inline[] {
  const out: Inline[] = [];
  const push = (text: string) => { if (text) out.push({ text, ...marks }); };
  for (const node of Array.from(r.children)) {
    switch (node.localName) {
      case 't': push(node.textContent ?? ''); break;
      case 'tab': push('\t'); break;
      case 'br':
        // A PAGE break inside a run is a block-level event; it is recorded on
        // the context and acted on by the paragraph that contains it.
        if ((node.getAttributeNS(W, 'type') ?? node.getAttribute('w:type')) === 'page') {
          ctx.pageBreakPending = true;
        } else push(BREAK);
        break;
      case 'noBreakHyphen': push('-'); break;
      case 'softHyphen': break;
      case 'drawing':
      case 'pict':
      case 'object':
        ctx.drawings.push(node);
        break;
      case 'footnoteReference':
      case 'endnoteReference':
        ctx.unsupported.add('footnotes');
        break;
      case 'fldChar':
      case 'instrText':
        ctx.unsupported.add('fields');
        break;
      default: break;
    }
  }
  return out;
}

interface Ctx {
  rels: Map<string, string>;
  media: Map<string, Uint8Array>;
  images: ImportedImage[];
  unsupported: Set<string>;
  drawings: Element[];
  pageBreakPending: boolean;
  numbering: Map<string, boolean>;
}

/** Every run in a paragraph, following hyperlinks into their children. */
function paragraphRuns(p: Element, ctx: Ctx): Inline[] {
  const out: Inline[] = [];
  const walk = (parent: Element, link?: string) => {
    for (const node of Array.from(parent.children)) {
      if (node.localName === 'r') {
        out.push(...runsOf(node, runProps(kid(node, 'rPr'), link), ctx));
      } else if (node.localName === 'hyperlink') {
        const id = node.getAttributeNS(R, 'id') ?? node.getAttribute('r:id');
        const href = id ? ctx.rels.get(id) : node.getAttributeNS(W, 'anchor') ? undefined : undefined;
        walk(node, href ?? link);
      } else if (node.localName === 'smartTag' || node.localName === 'sdt'
        || node.localName === 'sdtContent' || node.localName === 'ins') {
        // Structured tags and accepted insertions wrap ordinary runs.
        walk(node, link);
      } else if (node.localName === 'del') {
        // Deleted text under tracked changes is not in the document.
        ctx.unsupported.add('tracked changes');
      }
    }
  };
  walk(p);
  return mergeRuns(out);
}

/** Adjacent runs with identical marks become one — smaller and wraps better. */
function mergeRuns(runs: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out[out.length - 1];
    if (last
      && !!last.bold === !!run.bold && !!last.italic === !!run.italic
      && !!last.underline === !!run.underline && !!last.strike === !!run.strike
      && last.color === run.color && last.highlight === run.highlight
      && last.size === run.size && last.link === run.link) {
      last.text += run.text;
    } else out.push({ ...run });
  }
  return out;
}

/* ── paragraphs ────────────────────────────────────────────────────────────── */

const HEADING = /^heading\s*([1-9])$/i;

function headingLevel(style: string | null): 1 | 2 | 3 | 4 | null {
  const name = String(style ?? '');
  if (/^title$/i.test(name)) return 1;
  if (/^subtitle$/i.test(name)) return 2;
  const m = HEADING.exec(name.replace(/([a-z])([0-9])/i, '$1 $2'));
  if (!m) return null;
  const level = Number(m[1]);
  return (level <= 4 ? level : 4) as 1 | 2 | 3 | 4;
}

/** Pull the picture out of a drawing, and say how wide it was. */
function imageFrom(drawing: Element, ctx: Ctx): { bytes: Uint8Array; contentType: string; width?: number } | null {
  const embed = drawing.getElementsByTagName('*');
  let id: string | null = null;
  let width: number | undefined;
  for (const el of Array.from(embed)) {
    if (el.localName === 'blip') {
      id = el.getAttributeNS(R, 'embed') ?? el.getAttribute('r:embed');
    }
    if (el.localName === 'extent' && width === undefined) {
      width = fromEmu(el.getAttribute('cx'));
    }
  }
  if (!id) return null;
  const target = ctx.rels.get(id);
  if (!target) return null;
  // Relationship targets are relative to `word/`, and may say so explicitly.
  const path = target.startsWith('/') ? target.slice(1) : `word/${target.replace(/^\.\//, '')}`;
  const bytes = ctx.media.get(path) ?? ctx.media.get(target);
  if (!bytes) return null;
  const ext = (path.split('.').pop() ?? 'png').toLowerCase();
  const contentType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : 'image/png';
  return { bytes, contentType, width };
}

function paragraphBlocks(p: Element, ctx: Ctx, out: Block[]): void {
  const pPr = kid(p, 'pPr');
  ctx.drawings = [];
  ctx.pageBreakPending = false;

  const runs = paragraphRuns(p, ctx);

  // A break BEFORE this paragraph, from either spelling.
  if (toggle(pPr, 'pageBreakBefore')) out.push({ kind: 'pagebreak' });

  const style = val(kid(pPr, 'pStyle'));
  const align = ALIGN[String(val(kid(pPr, 'jc')) ?? '')] ?? undefined;

  // Pictures become their own blocks, in the order they appeared.
  for (const drawing of ctx.drawings) {
    const picture = imageFrom(drawing, ctx);
    if (!picture) { ctx.unsupported.add('shapes'); continue; }
    ctx.images.push({ blockIndex: out.length, ...picture });
    out.push({
      kind: 'image', url: '', alt: '',
      ...(picture.width ? { width: Math.round(picture.width) } : {}),
      ...(align ? { align } : {}),
    });
  }

  const numPr = kid(pPr, 'numPr');
  if (numPr && runs.length) {
    const level = Number(val(kid(numPr, 'ilvl')) ?? 0) || 0;
    const numId = val(kid(numPr, 'numId')) ?? '';
    out.push({
      kind: 'list',
      ordered: ctx.numbering.get(numId) ?? false,
      level: Math.max(0, Math.min(3, level)),
      index: 1,
      runs,
    });
  } else if (runs.length) {
    const level = headingLevel(style);
    if (level) out.push({ kind: 'heading', level, runs, ...(align ? { align } : {}) });
    else if (/^(quote|intensequote)$/i.test(String(style ?? ''))) out.push({ kind: 'quote', runs });
    else out.push({ kind: 'para', runs, ...(align ? { align } : {}) });
  } else if (!ctx.drawings.length && !ctx.pageBreakPending) {
    /**
     * An EMPTY paragraph is how a Word document is spaced, and there are
     * usually a lot of them. One is a blank line and becomes nothing; a RUN of
     * them is deliberate space, which is exactly what `space` exists for. The
     * caller collapses them — see `collapseEmpties`.
     *
     * A paragraph that exists only to carry a PAGE BREAK is not one of them.
     * Counting it made the gap grow by twelve points every time a document was
     * opened and saved — found by running the trip twice and diffing, which is
     * the only way a drift of one blank line shows up at all.
     */
    out.push({ kind: 'space', points: 0 });
  }

  if (ctx.pageBreakPending) out.push({ kind: 'pagebreak' });
}

/**
 * Empty paragraphs into one measured gap.
 *
 * Word documents are full of them and the model has something better: a run of
 * four blank paragraphs in a signature block is ~48 points of deliberate space.
 * A single one is just the gap between paragraphs, which the renderer already
 * puts there, so it is dropped.
 */
function collapseEmpties(blocks: Block[]): Block[] {
  const out: Block[] = [];
  let run = 0;
  const flush = () => {
    if (run >= 2) out.push({ kind: 'space', points: Math.min(700, run * 12) });
    run = 0;
  };
  for (const b of blocks) {
    if (b.kind === 'space' && b.points === 0) { run += 1; continue; }
    flush();
    out.push(b);
  }
  // A trailing run of blank paragraphs is the end of the file, not a gap.
  run = 0;
  return out;
}

/* ── tables ────────────────────────────────────────────────────────────────── */

function tableBlock(tbl: Element, ctx: Ctx): Block | null {
  const rows = kids(tbl, 'tr');
  if (!rows.length) return null;

  const cellsOf = (tr: Element) => kids(tr, 'tc').map((tc) => {
    const runs: Inline[] = [];
    for (const p of kids(tc, 'p')) {
      if (runs.length) runs.push({ text: ' ' });
      runs.push(...paragraphRuns(p, ctx));
    }
    return mergeRuns(runs);
  });

  // Word marks its repeating header row; without one, the first row is the
  // header if the table has more than one, which is what a reader assumes.
  const first = rows[0]!;
  const marked = !!kid(kid(first, 'trPr'), 'tblHeader');
  const hasHeader = marked || rows.length > 1;

  const header = hasHeader ? cellsOf(first) : [];
  const body = (hasHeader ? rows.slice(1) : rows).map(cellsOf);

  // Column widths: the grid is authoritative and is in twentieths of a point.
  /**
   * Two places say how wide a column is, and a file usually has only one of
   * them. `tblGrid` is what Word writes; a table laid out in PERCENTAGES —
   * which is what our own writer emits, and what most generated .docx files
   * use — puts the number on each cell as `w:tcW` instead, and reading only
   * the grid gave every column the same width.
   */
  const grid = kid(tbl, 'tblGrid');
  const gridWidths = grid
    ? kids(grid, 'gridCol')
      .map((c) => fromTwips(c.getAttributeNS(W, 'w') ?? c.getAttribute('w:w')) ?? 0)
      .filter((n) => n > 0)
    : [];
  const cellWidths = kids(first, 'tc').map((tc) => {
    const tcW = kid(kid(tc, 'tcPr'), 'tcW');
    return widthValue(tcW?.getAttributeNS(W, 'w') ?? tcW?.getAttribute('w:w'));
  }).filter((n) => n > 0);
  // Only when they actually differ: a grid of equal columns says nothing, and
  // writing `columns: 1,1,1` into every document is noise.
  const measured = gridWidths.length > 1 && new Set(gridWidths).size > 1
    ? gridWidths
    : cellWidths.length > 1 && new Set(cellWidths).size > 1 ? cellWidths : [];
  const widths = measured;

  // Cell alignment, taken from the first row that says anything.
  const align: Array<DocAlign | null> = [];
  for (const row of rows) {
    kids(row, 'tc').forEach((tc, i) => {
      if (align[i]) return;
      const p = kid(tc, 'p');
      const found = ALIGN[String(val(kid(kid(p, 'pPr'), 'jc')) ?? '')];
      if (found) align[i] = found;
    });
  }

  return {
    kind: 'table',
    header,
    rows: body,
    ...(align.some(Boolean) ? { align: align.map((a) => a ?? null) } : {}),
    // Normalised to relative weights — the model's own unit, and it keeps the
    // proportions when the page size differs from the one Word was using.
    ...(widths.length > 1 ? { widths: normalise(widths) } : {}),
  };
}

function normalise(widths: number[]): number[] {
  const total = widths.reduce((n, w) => n + w, 0) || 1;
  return widths.map((w) => Math.round((w / total) * widths.length * 100) / 100);
}

/* ── page setup ────────────────────────────────────────────────────────────── */

function pageSetup(sectPr: Element | null): Partial<DocSpec> {
  if (!sectPr) return {};
  const spec: Partial<DocSpec> = {};

  const pgSz = kid(sectPr, 'pgSz');
  const w = fromTwips(pgSz?.getAttributeNS(W, 'w') ?? pgSz?.getAttribute('w:w'));
  const h = fromTwips(pgSz?.getAttributeNS(W, 'h') ?? pgSz?.getAttribute('w:h'));
  const orient = pgSz?.getAttributeNS(W, 'orient') ?? pgSz?.getAttribute('w:orient');
  if (orient === 'landscape' || (w && h && w > h)) spec.orientation = 'landscape';
  // Letter is 612x792 points, A4 is 595x842. Compared on the SHORT side so the
  // test works the same in landscape.
  const shortest = Math.min(w ?? 0, h ?? 0);
  if (shortest > 600) spec.pageSize = 'letter';

  const pgMar = kid(sectPr, 'pgMar');
  const left = fromTwips(pgMar?.getAttributeNS(W, 'left') ?? pgMar?.getAttribute('w:left'));
  const top = fromTwips(pgMar?.getAttributeNS(W, 'top') ?? pgMar?.getAttribute('w:top'));
  // One number, because the model has one. The side margin is what a reader
  // sees as "the margin"; top and bottom follow it closely in every real
  // document and exactly in the ones Word's own presets produce.
  const margin = left ?? top;
  if (margin && margin > 0) spec.margin = Math.round(margin);

  return spec;
}

/** The text of a header or footer part, with Word's page fields turned back. */
function chromeText(doc: Document | null): string | undefined {
  if (!doc) return undefined;
  let out = '';
  for (const el of Array.from(doc.getElementsByTagName('*'))) {
    if (el.localName === 't') out += el.textContent ?? '';
    if (el.localName === 'instrText') {
      const code = (el.textContent ?? '').trim().toUpperCase();
      if (code.startsWith('NUMPAGES')) out += '{pages}';
      else if (code.startsWith('PAGE')) out += '{page}';
    }
  }
  const text = out.replace(/\s+/g, ' ').trim();
  return text || undefined;
}

/* ── the whole file ────────────────────────────────────────────────────────── */

function parseXml(bytes: Uint8Array | undefined): Document | null {
  if (!bytes) return null;
  const text = new TextDecoder().decode(bytes);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}

/** Which numbering definitions are ORDERED, so a list gets the right marker. */
function orderedNumbering(numbering: Document | null): Map<string, boolean> {
  const map = new Map<string, boolean>();
  if (!numbering) return map;
  const abstractOrdered = new Map<string, boolean>();
  for (const el of Array.from(numbering.getElementsByTagName('*'))) {
    if (el.localName === 'abstractNum') {
      const id = el.getAttributeNS(W, 'abstractNumId') ?? el.getAttribute('w:abstractNumId') ?? '';
      const lvl = kids(el, 'lvl')[0];
      const fmt = val(kid(lvl, 'numFmt')) ?? '';
      abstractOrdered.set(id, fmt !== 'bullet' && fmt !== 'none' && fmt !== '');
    }
  }
  for (const el of Array.from(numbering.getElementsByTagName('*'))) {
    if (el.localName === 'num') {
      const id = el.getAttributeNS(W, 'numId') ?? el.getAttribute('w:numId') ?? '';
      const abstractId = val(kid(el, 'abstractNumId')) ?? '';
      map.set(id, abstractOrdered.get(abstractId) ?? false);
    }
  }
  return map;
}

/** Relationship id to target, for hyperlinks and pictures. */
function relationships(doc: Document | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!doc) return map;
  for (const el of Array.from(doc.getElementsByTagName('*'))) {
    if (el.localName !== 'Relationship') continue;
    const id = el.getAttribute('Id');
    const target = el.getAttribute('Target');
    if (id && target) map.set(id, target);
  }
  return map;
}

export async function importDocx(bytes: Uint8Array): Promise<ImportedDocument> {
  const files = await readZipMap(bytes, (name) => (
    name === 'word/document.xml'
    || name === 'word/numbering.xml'
    || name === 'word/_rels/document.xml.rels'
    || /^word\/(header|footer)\d*\.xml$/.test(name)
    || name.startsWith('word/media/')
  ));

  const document = parseXml(files.get('word/document.xml'));
  if (!document) throw new Error('That Word file could not be read — its document part is missing or damaged.');

  const media = new Map<string, Uint8Array>();
  for (const [name, data] of files) if (name.startsWith('word/media/')) media.set(name, data);

  const ctx: Ctx = {
    rels: relationships(parseXml(files.get('word/_rels/document.xml.rels'))),
    media,
    images: [],
    unsupported: new Set<string>(),
    drawings: [],
    pageBreakPending: false,
    numbering: orderedNumbering(parseXml(files.get('word/numbering.xml'))),
  };

  const body = Array.from(document.getElementsByTagName('*')).find((el) => el.localName === 'body');
  if (!body) throw new Error('That Word file has no body.');

  const blocks: Block[] = [];
  let sectPr: Element | null = null;
  for (const node of Array.from(body.children)) {
    switch (node.localName) {
      case 'p': paragraphBlocks(node, ctx, blocks); break;
      case 'tbl': {
        const table = tableBlock(node, ctx);
        if (table) blocks.push(table);
        break;
      }
      case 'sectPr': sectPr = node; break;
      case 'sdt': {
        // A content control wrapping real content — walk into it.
        const inner = Array.from(node.getElementsByTagName('*')).filter((el) => el.localName === 'p');
        for (const p of inner) paragraphBlocks(p, ctx, blocks);
        break;
      }
      default: break;
    }
  }

  const spec: Partial<DocSpec> = pageSetup(sectPr);
  // The FIRST header and footer part: a document with different odd and even
  // pages has more, and the model has one of each.
  const headerName = [...files.keys()].filter((n) => /^word\/header\d*\.xml$/.test(n)).sort()[0];
  const footerName = [...files.keys()].filter((n) => /^word\/footer\d*\.xml$/.test(n)).sort()[0];
  const header = chromeText(parseXml(headerName ? files.get(headerName) : undefined));
  const footer = chromeText(parseXml(footerName ? files.get(footerName) : undefined));
  if (header) spec.header = header;
  if (footer) spec.footer = footer;

  const collapsed = collapseEmpties(blocks);
  // Image blocks moved when the empties collapsed, so their indices are
  // re-found rather than trusted — an off-by-one here puts a picture in the
  // wrong paragraph, which is the kind of bug that only shows up on page four.
  const imageBlocks = collapsed
    .map((b, i) => (b.kind === 'image' ? i : -1))
    .filter((i) => i >= 0);
  ctx.images.forEach((image, n) => {
    const at = imageBlocks[n];
    if (at !== undefined) image.blockIndex = at;
  });

  return {
    blocks: collapsed,
    spec,
    images: ctx.images,
    unsupported: [...ctx.unsupported],
  };
}
