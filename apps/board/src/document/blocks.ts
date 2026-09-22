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
import { Marked } from 'marked';

import { isOnlyMarks, readMark } from './align-marks';

/**
 * A stretch of text with its marks. `link` carries an href, not a style.
 *
 * ── WHY THESE AND NOT A STYLE OBJECT ─────────────────────────────────────────
 * Every mark here is one a word processor puts on a toolbar AND one BlockSuite
 * stores natively on an inline delta (`bold`, `italic`, `strike`, `code`,
 * `underline`, `color`, `background`, `link`). Keeping the two sets aligned is
 * what lets a run survive the trip onto the canvas and back: a mark that only
 * this file knew about would be silently flattened the first time the user
 * edited the sentence it was on.
 *
 * `size` is the exception and is honest about it — there is no native inline
 * size, so it reaches PDF and Word but a hand-edit on the board loses it.
 */
export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: string;
  underline?: boolean;
  /** Ink, as `#rrggbb`. */
  color?: string;
  /** Highlight behind the text, as `#rrggbb`. */
  highlight?: string;
  /** Points, overriding the block's size. Absent means "whatever the block is". */
  size?: number;
}

/**
 * ── THE THREE MARKS MARKDOWN NEVER HAD ───────────────────────────────────────
 *
 *     ++underlined++            ==highlighted==            [red 18pt]{color=#c00 size=18}
 *
 * The first two are the de-facto extensions every editor that added these marks
 * chose, which matters because a user who pastes from one of them gets what they
 * meant. The third is Pandoc's bracketed span, and it carries everything that
 * needs a value rather than a flag.
 *
 * They are registered as REAL marked extensions rather than being found with a
 * regex over the finished runs, because a mark has to nest: `++a **b** c++` is
 * one underlined stretch containing a bold one, and only the lexer knows that.
 * A regex pass over flattened runs cannot see it and would cut the bold in half.
 */
const SPAN_ATTR = /(\w+)\s*=\s*"?([^\s"}]+)"?/g;

/** `{color=#c00 size=18}` → marks. Unknown keys are ignored, not an error. */
function spanMarks(body: string): Partial<Inline> {
  const marks: Partial<Inline> = {};
  for (const [, rawKey, rawValue] of String(body ?? '').matchAll(SPAN_ATTR)) {
    const key = String(rawKey).toLowerCase();
    const value = String(rawValue);
    if (key === 'color' || key === 'colour') marks.color = normaliseColour(value);
    else if (key === 'highlight' || key === 'background' || key === 'bg') {
      marks.highlight = normaliseColour(value);
    } else if (key === 'size') {
      const n = Number(value);
      // A size outside this range is a typo, not a design: 4pt is unreadable
      // and 400pt is one letter per page. Clamping beats rendering the mistake.
      if (Number.isFinite(n) && n > 0) marks.size = Math.min(200, Math.max(4, n));
    } else if (key === 'underline' && value !== 'false') marks.underline = true;
  }
  return marks;
}

/** The 16 CSS names worth supporting, plus `#abc` and `#aabbcc`. */
const NAMED_COLOURS: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#cc0000', green: '#107c10',
  blue: '#1a56db', yellow: '#f5c400', orange: '#e06c00', purple: '#6b21a8',
  grey: '#666666', gray: '#666666', navy: '#1b2a4a', teal: '#0f6e6e',
  maroon: '#7a1f1f', olive: '#5c6b16', silver: '#b8b8b8', lime: '#3fb618',
};

function normaliseColour(value: string): string | undefined {
  const raw = String(value ?? '').trim().toLowerCase();
  const named = NAMED_COLOURS[raw];
  if (named) return named;
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(raw);
  if (!hex) return undefined;
  const digits = hex[1]!;
  return `#${digits.length === 3 ? digits.split('').map((c) => c + c).join('') : digits}`;
}

/** What `==this==` means when no colour is named: the highlighter yellow. */
const HIGHLIGHT_DEFAULT = '#fff3a3';

const MARK_EXTENSIONS = [
  {
    name: 'vsUnderline',
    level: 'inline' as const,
    start: (src: string) => src.indexOf('++'),
    tokenizer(this: any, src: string) {
      const m = /^\+\+(?=\S)([\s\S]*?\S)\+\+/.exec(src);
      if (!m) return undefined;
      return { type: 'vsUnderline', raw: m[0], tokens: this.lexer.inlineTokens(m[1]!) };
    },
  },
  {
    name: 'vsHighlight',
    level: 'inline' as const,
    start: (src: string) => src.indexOf('=='),
    tokenizer(this: any, src: string) {
      const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
      if (!m) return undefined;
      return { type: 'vsHighlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]!) };
    },
  },
  {
    name: 'vsSpan',
    level: 'inline' as const,
    start: (src: string) => src.indexOf('['),
    tokenizer(this: any, src: string) {
      /**
       * Two shapes, because both are things people write:
       *
       *     [text]{color=red}              a span
       *     [text](https://x){color=red}   a LINK that is also red
       *
       * The second existed as a trap before it existed as a feature: marked
       * read the link and left `{color=red}` in the prose, so the document came
       * out with the braces printed in it. Found by looking at a page.
       */
      const linked = /^\[([^\]\n]+)\]\(([^)\s]*)\)\{([^}\n]*)\}/.exec(src);
      if (linked) {
        return {
          type: 'vsSpan', raw: linked[0],
          marks: { ...spanMarks(linked[3]!), link: linked[2]! },
          tokens: this.lexer.inlineTokens(linked[1]!),
        };
      }
      const m = /^\[([^\]\n]+)\]\{([^}\n]*)\}/.exec(src);
      if (!m) return undefined;
      return {
        type: 'vsSpan', raw: m[0],
        marks: spanMarks(m[2]!),
        tokens: this.lexer.inlineTokens(m[1]!),
      };
    },
  },
];

/**
 * Our own lexer, so `marked`'s global is left alone.
 *
 * `marked.use` mutates the shared instance, and this module is imported by the
 * board, the exporters and the agent tools. An extension registered globally
 * would change how every other caller in the bundle reads markdown.
 */
const lexer = new Marked({ extensions: MARK_EXTENSIONS as any });

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; runs: Inline[]; align?: DocAlign }
  | { kind: 'para'; runs: Inline[]; align?: DocAlign }
  | { kind: 'list'; ordered: boolean; level: number; index: number; runs: Inline[] }
  | { kind: 'quote'; runs: Inline[] }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'rule' }
  /**
   * An explicit page break — `<!-- pagebreak -->`.
   *
   * Every real document needs one: a title page, a section that must start on
   * the right, an appendix. Without it the only way to push content onto the
   * next page was to pad it with blank lines and hope, which stops working the
   * moment anybody edits a sentence above.
   */
  | { kind: 'pagebreak' }
  | {
    kind: 'image'; url: string; alt: string;
    /**
     * How wide to draw it, in points. Absent means "as wide as the column",
     * which is right for a chart and catastrophic for a logo.
     */
    width?: number;
    align?: DocAlign;
  }
  | {
    kind: 'table'; header: Inline[][]; rows: Inline[][][];
    /**
     * Per column, from markdown's own `| :--- | ---: |`. `null` is "unspecified",
     * which is not the same as left: a numeric column left alone should stay
     * left, but a column the author aligned right must not be overridden by a
     * later guess.
     */
    align?: Array<DocAlign | null>;
    /**
     * RELATIVE column widths — `[3, 1, 1]` is a wide first column and two
     * narrow ones. Relative rather than absolute because the same table has to
     * fit an A4 portrait page and a landscape one, and because a user thinks in
     * proportions. Absent means equal columns.
     */
    widths?: number[];
  };

export type DocAlign = 'left' | 'center' | 'right';

export type DocFormat = 'pdf' | 'docx' | 'md';

/** Page margins, named the way a word processor names them. */
export type DocMargin = 'normal' | 'narrow' | 'wide';

export interface DocSpec {
  markdown: string;
  /** Becomes the `# heading` when the markdown has none, and the file's name. */
  title?: string;
  pageSize?: 'a4' | 'letter';
  /** `serif` reads as a report, `sans` as a memo. Both are document faces. */
  typeface?: 'serif' | 'sans';
  /**
   * `normal` is an inch, the default every word processor opens with. `narrow`
   * fits more on a page for a dense internal document; `wide` leaves room for
   * notes in the margin. A number is points, for the rare exact requirement.
   */
  margin?: DocMargin | number;
  /** Landscape for a wide table or a slide-shaped handout. */
  orientation?: 'portrait' | 'landscape';
  /**
   * A line repeated at the top or bottom of EVERY page. `{page}` becomes the
   * page number and `{pages}` the total — which is what makes "Page 2 of 7"
   * possible, and what a contract needs to prove none of it is missing.
   */
  header?: string;
  footer?: string;
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
      && !!last.underline === !!marks.underline && last.color === marks.color
      && last.highlight === marks.highlight && last.size === marks.size
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
      case 'vsUnderline':
        out.push(...inlineRuns(t.tokens, { ...inherited, underline: true })); break;
      case 'vsHighlight':
        out.push(...inlineRuns(t.tokens, { ...inherited, highlight: HIGHLIGHT_DEFAULT }));
        break;
      case 'vsSpan':
        out.push(...inlineRuns(t.tokens, { ...inherited, ...(t.marks ?? {}) })); break;
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
      // marked reports `:--` as 'left', `--:` as 'right', `:-:` as 'center'
      // and a plain `---` as null — which is exactly the distinction worth
      // keeping, so it is passed through rather than defaulted.
      const align = (token.align || []).map((a: any) => (
        a === 'center' || a === 'right' || a === 'left' ? a as DocAlign : null));
      out.push({ kind: 'table', header, rows, ...(align.some(Boolean) ? { align } : {}) });
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
  /**
   * ── ALIGNMENT, WRITTEN AS A COMMENT ───────────────────────────────────────
   *
   *     <!-- align:center -->
   *     9/3/448, Rezimental Bazaar, Secunderabad
   *
   * Markdown has no alignment and a letterhead needs it: the footer is centred,
   * the date is often right. The comment applies to the NEXT block and nothing
   * after it, so it reads like the instruction it is.
   *
   * WHY A COMMENT AND NOT A MARKER. This document is also an editable page on
   * the board, and anything in the prose — `::center::`, `->text<-` — comes back
   * from that round trip as characters the user has to delete. BlockSuite's
   * markdown adapter DROPS an HTML comment instead of rendering it, so nothing
   * is ever shown. The honest cost: alignment does not survive a hand-edit on
   * the board, because `affine:paragraph` has no alignment prop to keep it in —
   * the document reverts to left, which is a plain document rather than a
   * broken one.
   */
  let pending: DocAlign | undefined;
  const ALIGN_COMMENT = /^\s*<!--\s*align\s*:\s*(left|center|centre|right)\s*-->\s*$/i;
  const BREAK_COMMENT = /^\s*<!--\s*(?:pagebreak|page-break|newpage)\s*-->\s*$/i;
  /**
   * `<!-- columns: 3,1,1 -->` before a table.
   *
   * Markdown's table syntax has no width, and a table of a long description
   * against two short numbers is the single most common real table there is —
   * set in equal thirds it reads badly and wraps where it should not.
   */
  const COLUMNS_COMMENT = /^\s*<!--\s*(?:columns|cols)\s*:\s*([\d.,\s]+?)\s*-->\s*$/i;
  let pendingWidths: number[] | undefined;
  for (const token of lexer.lexer(md)) {
    const raw = token.type === 'html' || token.type === 'paragraph'
      ? String((token as any).raw ?? '')
      : '';
    if (raw && BREAK_COMMENT.test(raw)) { out.push({ kind: 'pagebreak' }); continue; }
    const cols = raw ? COLUMNS_COMMENT.exec(raw) : null;
    if (cols) {
      const parsed = cols[1]!.split(',').map((n) => Number(n.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      pendingWidths = parsed.length ? parsed : undefined;
      continue;
    }
    const hit = raw ? ALIGN_COMMENT.exec(raw) : null;
    if (hit) {
      const word = hit[1]!.toLowerCase();
      pending = word === 'centre' ? 'center' : word as DocAlign;
      continue;
    }
    const before = out.length;
    blockFor(token, out);
    /**
     * A block that arrived from the CANVAS carries its alignment as an
     * invisible mark rather than a comment — the note had nowhere else to
     * keep it (see `align-marks.ts`). Reading both here means a document
     * exports the same whether it came straight from the agent or from a
     * note the user has been editing, and means the mark can never reach
     * a rendered page as a stray character.
     */
    for (let i = before; i < out.length; i++) {
      const b = out[i]!;
      const runs = 'runs' in b ? b.runs : null;
      const head = runs?.[0];
      if (!head) continue;
      const mark = readMark(head.text);
      if (mark.pagebreak) {
        // A paragraph that is nothing but the mark IS the break.
        if (isOnlyMarks(runs!.map((r) => r.text).join(''))) {
          out.splice(i, 1, { kind: 'pagebreak' });
          continue;
        }
        head.text = mark.text;
        out.splice(i, 0, { kind: 'pagebreak' });
        i += 1;
        continue;
      }
      if (mark.text === head.text) continue;
      head.text = mark.text;
      if (mark.align && (b.kind === 'para' || b.kind === 'heading' || b.kind === 'image')) {
        b.align = mark.align;
      }
    }
    if (pending && out.length > before) {
      const b = out[before]!;
      if (b.kind === 'para' || b.kind === 'heading' || b.kind === 'image') b.align = pending;
      pending = undefined;
    }
    if (pendingWidths && out.length > before) {
      const b = out[before]!;
      if (b.kind === 'table') b.widths = pendingWidths;
      pendingWidths = undefined;
    }
  }

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
