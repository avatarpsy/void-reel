/**
 * A document, as blocks — the shape both exporters read.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS RUNS ON THE DEVICE
 * ══════════════════════════════════════════════════════════════════════════
 * Typesetting a document is real work: measuring every word against real font
 * metrics, breaking lines, paginating, embedding pictures. It is also perfectly
 * parallel across users and needs nothing but the text — which makes it exactly
 * the wrong thing to put on a shared server. One user exporting a 200-page
 * report would be spending everyone else's latency.
 *
 * The device it belongs on is the one the user is already sitting at. A browser
 * has the same fonts, the same arithmetic and an idle CPU, and the file it
 * produces never has to travel. The server's job here is storage — bytes in,
 * URL out — and nothing else.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ONE BLOCK MODEL, TWO BACKENDS
 * ══════════════════════════════════════════════════════════════════════════
 * `parseMarkdown` produces blocks; `../document/docx` and `../document/pdf`
 * consume them. Neither backend reads markdown, so the two formats cannot drift
 * apart in what they understand — a heading is a heading in both, and a feature
 * added here reaches both at once.
 *
 * Both backends are dynamically imported by `index.ts`, so choosing PDF never
 * downloads the Word writer and neither is in the bundle for a user who exports
 * nothing. This file is the only always-loaded part, and it is deliberately the
 * small one.
 */
import { marked } from 'marked';

/** A stretch of text with its marks. `link` carries an href, not a style. */
export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: string;
}

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; runs: Inline[] }
  | { kind: 'para'; runs: Inline[] }
  | { kind: 'list'; ordered: boolean; level: number; index: number; runs: Inline[] }
  | { kind: 'quote'; runs: Inline[] }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'rule' }
  | {
    kind: 'image'; url: string; alt: string;
    /**
     * How wide to draw it, in points. Absent means "as wide as the column",
     * which is right for a chart and catastrophic for a logo.
     */
    width?: number;
    align?: DocAlign;
  }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][] };

export type DocAlign = 'left' | 'center' | 'right';

export type DocFormat = 'pdf' | 'docx' | 'md';

export interface DocSpec {
  markdown: string;
  /** Becomes the `# heading` when the markdown has none, and the file's name. */
  title?: string;
  pageSize?: 'a4' | 'letter';
  /** `serif` reads as a report, `sans` as a memo. Both are document faces. */
  typeface?: 'serif' | 'sans';
}

/**
 * A SOFT LINE BREAK IS A SPACE.
 *
 * Markdown's rule, and the bug that made this function exist. Everyone wraps
 * their prose at 80 columns, so a paragraph arrives as "…avatars to build\n
 * audiences at a scale…". `marked` hands that newline through untouched, and
 * both backends then set it with no gap at all: the PDF read "buildaudiences"
 * and Word did the same. It was invisible in the block model and obvious the
 * moment anyone LOOKED at a rendered page.
 *
 * A HARD break — two trailing spaces, or `<br>` — is a separate `br` token and
 * still becomes a real newline, so nothing is lost by collapsing these.
 */
function soften(text: unknown): string {
  return String(text ?? '').replace(/[ \t]*\r?\n[ \t]*/g, ' ');
}

/** Flatten marked's inline tokens into runs, carrying marks down through nesting. */
function inlineRuns(tokens: any[] | undefined, inherited: Partial<Inline> = {}): Inline[] {
  const out: Inline[] = [];
  const push = (text: string, marks: Partial<Inline>) => {
    if (!text) return;
    const last = out[out.length - 1];
    // Merge adjacent runs with identical marks — fewer, longer runs wrap better
    // and produce far smaller .docx XML.
    if (last && !!last.bold === !!marks.bold && !!last.italic === !!marks.italic
      && !!last.code === !!marks.code && !!last.strike === !!marks.strike
      && last.link === marks.link) {
      last.text += text;
      return;
    }
    out.push({ text, ...marks });
  };
  for (const t of tokens || []) {
    switch (t.type) {
      case 'text':
        // A `text` token may itself have children (e.g. inside a list item).
        if (t.tokens?.length) out.push(...inlineRuns(t.tokens, inherited));
        else push(soften(t.text), inherited);
        break;
      case 'strong': out.push(...inlineRuns(t.tokens, { ...inherited, bold: true })); break;
      case 'em': out.push(...inlineRuns(t.tokens, { ...inherited, italic: true })); break;
      case 'del': out.push(...inlineRuns(t.tokens, { ...inherited, strike: true })); break;
      case 'codespan': push(soften(t.text), { ...inherited, code: true }); break;
      case 'link': out.push(...inlineRuns(t.tokens, { ...inherited, link: String(t.href || '') })); break;
      case 'br': push('\n', inherited); break;
      case 'image': push(soften(t.text || t.href), inherited); break;
      case 'escape': push(String(t.text ?? ''), inherited); break;
      case 'html': break; // raw html has no meaning in a Word file or a PDF
      default: push(soften(t.raw ?? t.text), inherited); break;
    }
  }
  return out.filter((r) => r.text !== '');
}

/** Paragraphs that contain nothing but one image become image blocks. */
/**
 * ── HOW BIG, AND WHERE — WRITTEN ON THE URL ──────────────────────────────────
 *
 * `![logo](https://…/logo.png#w=120&align=left)`
 *
 * Markdown cannot size an image, and every document with a letterhead needs to:
 * a company mark is 100 points wide, not 450. Without this the renderer scaled
 * every picture to the full text column, so a logo took a whole page — measured,
 * on a real certificate: two pages, the first one entirely logo.
 *
 * WHY THE URL FRAGMENT rather than a marker in the text. This document is also
 * an EDITABLE PAGE on the board, and it goes markdown -> BlockSuite -> markdown
 * whenever anyone touches it. A `::center::` or `{w=120}` marker in the prose
 * survives that round trip as VISIBLE TEXT the user then has to delete. A
 * fragment rides on the image's own src, is never displayed, and is never sent
 * to a server either — `fetch` strips it — so the same url still resolves.
 *
 * Unknown or malformed hints are ignored rather than rejected: a hint is a
 * refinement, and refusing to draw a picture because its width was misspelt
 * would be a worse document than one with a big picture in it.
 */
function imageHints(url: string): { width?: number; align?: DocAlign } {
  const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
  if (!hash) return {};
  const out: { width?: number; align?: DocAlign } = {};
  for (const part of hash.split('&')) {
    const [rawKey, rawValue] = part.split('=');
    const key = String(rawKey ?? '').trim().toLowerCase();
    const value = String(rawValue ?? '').trim().toLowerCase();
    if (key === 'w' || key === 'width') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out.width = Math.min(2000, n);
    } else if (key === 'align') {
      if (value === 'left' || value === 'center' || value === 'right') out.align = value;
    }
  }
  return out;
}

function loneImage(
  tokens: any[] | undefined,
): { url: string; alt: string; width?: number; align?: DocAlign } | null {
  const real = (tokens || []).filter((t) => !(t.type === 'text' && !String(t.text ?? '').trim()));
  if (real.length === 1 && real[0].type === 'image' && real[0].href) {
    const url = String(real[0].href);
    return { url, alt: String(real[0].text || ''), ...imageHints(url) };
  }
  return null;
}

function listBlocks(token: any, level: number, out: Block[]): void {
  const ordered = !!token.ordered;
  const start = Number(token.start) || 1;
  token.items?.forEach((item: any, i: number) => {
    // A list item holds block tokens. The first paragraph is the item's own
    // line; anything after it (a nested list, a second paragraph) is its body.
    let first = true;
    for (const child of item.tokens || []) {
      if (child.type === 'list') { listBlocks(child, level + 1, out); continue; }
      if (child.type === 'text' || child.type === 'paragraph') {
        const runs = inlineRuns(child.tokens);
        if (!runs.length) continue;
        if (first) {
          out.push({ kind: 'list', ordered, level, index: start + i, runs });
          first = false;
        } else {
          // A continuation paragraph, indented under its bullet.
          out.push({ kind: 'list', ordered: false, level: level + 1, index: 0, runs });
        }
        continue;
      }
      blockFor(child, out, level + 1);
    }
  });
}

function blockFor(token: any, out: Block[], level = 0): void {
  switch (token.type) {
    case 'heading': {
      const depth = Math.min(4, Math.max(1, Number(token.depth) || 1)) as 1 | 2 | 3 | 4;
      const runs = inlineRuns(token.tokens);
      if (runs.length) out.push({ kind: 'heading', level: depth, runs });
      break;
    }
    case 'paragraph': {
      const img = loneImage(token.tokens);
      if (img) { out.push({ kind: 'image', ...img }); break; }
      const runs = inlineRuns(token.tokens);
      if (runs.length) out.push({ kind: 'para', runs });
      break;
    }
    case 'list': listBlocks(token, level, out); break;
    case 'blockquote':
      for (const child of token.tokens || []) {
        if (child.type === 'paragraph' || child.type === 'text') {
          const runs = inlineRuns(child.tokens);
          if (runs.length) out.push({ kind: 'quote', runs });
        } else blockFor(child, out, level);
      }
      break;
    case 'code':
      out.push({ kind: 'code', text: String(token.text ?? ''), lang: token.lang || undefined });
      break;
    case 'hr': out.push({ kind: 'rule' }); break;
    case 'table': {
      const header = (token.header || []).map((c: any) => inlineRuns(c.tokens));
      const rows = (token.rows || []).map((r: any) => r.map((c: any) => inlineRuns(c.tokens)));
      out.push({ kind: 'table', header, rows });
      break;
    }
    case 'space': break;
    case 'html': break;
    default: {
      const runs = inlineRuns(token.tokens || [{ type: 'text', text: token.text ?? '' }]);
      if (runs.length) out.push({ kind: 'para', runs });
      break;
    }
  }
}

export function parseMarkdown(markdown: string, title?: string): Block[] {
  const md = String(markdown ?? '');
  const out: Block[] = [];
  for (const token of marked.lexer(md)) blockFor(token, out);

  /**
   * A title supplied by the caller becomes the document's H1 — but only when
   * the document does not already say it.
   *
   * ── WHY THE LEVEL IS NOT ENOUGH ───────────────────────────────────────────
   * This used to skip the prepend only for a level-1 opening heading, which is
   * right until something DEMOTES the headings. The board-as-page export does
   * exactly that: every frame becomes a section, so the document's own `#` is
   * pushed to `##` — and since the title is derived from that same heading, the
   * Word file opened with
   *
   *     [Heading1] Weekly Update
   *     [Heading2] Weekly Update
   *
   * Found in a file that had actually been downloaded, not in a test. Comparing
   * the TEXT catches it at any level while still letting a document that opens
   * "## Overview" under the title "Q4 Plan" keep both, which is correct.
   */
  const t = String(title ?? '').trim();
  if (t) {
    const firstReal = out.find((b) => b.kind !== 'rule');
    const sameWords = firstReal?.kind === 'heading'
      && firstReal.runs.map((r) => r.text).join('').trim().toLowerCase() === t.toLowerCase();
    const already = firstReal?.kind === 'heading' && (firstReal.level === 1 || sameWords);
    /**
     * ── A DOCUMENT THAT OPENS WITH A PICTURE HAS ITS OWN MASTHEAD ─────────────
     *
     * The title is injected so a document is never untitled. But a LETTERHEAD
     * opens with a logo, and shoving the file name above it produced exactly
     * what a letterhead must not look like: a big black heading, then the
     * company mark, then the real title. Observed on a real certificate.
     *
     * An author who began with an image has composed their own opening, so the
     * title stops being a heading and remains what it also is — the name of the
     * file they download.
     */
    const ownMasthead = firstReal?.kind === 'image';
    if (!already && !ownMasthead) out.unshift({ kind: 'heading', level: 1, runs: [{ text: t }] });
  }
  return out;
}

/**
 * The twin of the image editor's `exportFileName`
 * (apps/image/src/services/pptx-export.ts). Same character class and the same
 * "drop, never escape" rule, so a name behaves identically whichever exporter
 * a user reaches; only the fallback noun differs, because "presentation.docx"
 * would be a lie. They are not shared because the two editors are separate
 * bundles with no common module, so the rule is written twice and pinned by
 * tests on both sides.
 */
export function documentFileName(title: string | undefined, format: DocFormat): string {
  const base = String(title || '').replace(/[^\w .-]+/g, '').trim() || 'document';
  return `${base}.${format}`;
}

export const DOC_CONTENT_TYPE: Record<DocFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown;charset=utf-8',
};
