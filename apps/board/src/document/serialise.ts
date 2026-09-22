/**
 * Blocks BACK to markdown — the inverse of `parseMarkdown`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS HAS TO EXIST
 * ══════════════════════════════════════════════════════════════════════════
 * Until now the model only ever flowed one way: markdown in, a file out. That
 * is enough to CREATE a document and useless for EDITING one. A .docx the user
 * uploads is not markdown — it is runs, styles and section properties — and the
 * only way to put it on the board, let the agent change a paragraph, and hand
 * back a .docx that still looks like their document is to have a round trip:
 *
 *     .docx / .pdf  ->  Block[]  ->  markdown  ->  note (editable)
 *                                       |
 *                       Block[]  <------+  ->  .pdf / .docx
 *
 * This is the arrow that was missing. With it the importers can be as rich as
 * they like: whatever they recover lands in the model, and the model already
 * knows how to write all three formats.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IT MUST SURVIVE ITS OWN OUTPUT
 * ══════════════════════════════════════════════════════════════════════════
 * `parse(serialise(blocks))` has to equal `blocks`, or a document loses a
 * little of itself every time it is opened and saved. That is pinned by tests
 * on real documents rather than asserted here, because the failures are all in
 * the corners: a pipe inside a table cell, a run that both is a link and has a
 * colour, an asterisk in ordinary prose.
 */
import type { Block, DocAlign, Inline } from './blocks';

/** Characters that would otherwise be read back as markup. */
function escapeText(text: string): string {
  return String(text ?? '')
    // The backslash first, or every escape added below gets escaped again.
    .replace(/\\/g, '\\\\')
    // The pipe is NOT here: it is only special inside a table, and escaping it
    // twice — once here and once in the cell — produced `x \| y`, which reads
    // back as a cell containing a backslash and then a new column.
    // `#`, `>`, `+` and `-` are only markup at the START of a line, and a
    // phone number written `\+91` is what escaping them everywhere looks like.
    // The line-start case is handled by `escapeLineStart` below.
    .replace(/([*_`~[\]<>])/g, '\\$1');
}

/**
 * A line that would be read back as a list, a heading or a quote.
 *
 * Applied to the finished LINE rather than to each run, because whether a
 * character is markup depends on where it is: `# ` opens a heading at the
 * start of a line and is a hash anywhere else.
 */
function escapeLineStart(line: string): string {
  return line.replace(/^(\s*)([-+>#]|\d+[.)])(\s)/, '$1\\$2$3');
}

/**
 * One run, with its marks.
 *
 * Order matters and is not arbitrary: the span wrapper `[…]{…}` has to be
 * OUTSIDE the emphasis markers, because `[**x**]{color=red}` parses and
 * `**[x]{color=red}**` makes the span the content of the bold, which then has
 * to be unwrapped again on the way back in.
 */
function runToMarkdown(run: Inline): string {
  let text = run.code ? String(run.text ?? '') : escapeText(run.text);
  if (!text) return '';

  // A hard break inside a run is a real newline in the model and a
  // backslash-newline in markdown. Done before the marks wrap it, so the
  // markers do not straddle a line end.
  const BREAK = String.fromCharCode(10);
  const HARD = String.fromCharCode(92, 10);
  if (!run.code && text.includes(BREAK)) text = text.split(BREAK).join(HARD);

  if (run.code) text = `\`${text}\``;
  if (run.bold) text = `**${text}**`;
  if (run.italic) text = `*${text}*`;
  if (run.strike) text = `~~${text}~~`;
  if (run.underline) text = `++${text}++`;

  const attrs: string[] = [];
  // The default highlight is what `==x==` means, so it is written that way
  // rather than as a span with the colour spelled out.
  const plainHighlight = run.highlight === '#fff3a3';
  if (plainHighlight) text = `==${text}==`;
  else if (run.highlight) attrs.push(`highlight=${run.highlight}`);
  if (run.color) attrs.push(`color=${run.color}`);
  if (run.size) attrs.push(`size=${run.size}`);

  if (run.link && attrs.length) return `[${text}](${run.link}){${attrs.join(' ')}}`;
  if (run.link) return `[${text}](${run.link})`;
  if (attrs.length) return `[${text}]{${attrs.join(' ')}}`;
  return text;
}

function runsToMarkdown(runs: Inline[] | undefined): string {
  return (runs ?? []).map(runToMarkdown).join('');
}

/** A table cell cannot contain a raw pipe or a line break. */
function cellToMarkdown(runs: Inline[] | undefined): string {
  return runsToMarkdown(runs)
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .trim() || ' ';
}

/**
 * A markdown table column can be ranged left, centred or ranged right, and
 * that is the whole vocabulary — there is no justified column in the
 * syntax. Typed to the three that exist rather than given a fourth entry
 * that would be a lie, and coerced where it is read.
 */
const ALIGN_ROW: Record<'left' | 'center' | 'right', string> = {
  left: ':---',
  center: ':---:',
  right: '---:',
};

/** A cell has no justified setting; anything else falls back to ranged left. */
function cellAlign(a?: DocAlign | null): 'left' | 'center' | 'right' {
  return a === 'center' || a === 'right' ? a : 'left';
}

function alignComment(align: DocAlign | undefined): string[] {
  return align && align !== 'left' ? [`<!-- align:${align} -->`] : [];
}

/**
 * The image url carries its own size and placement — see `imageHints`. Written
 * back onto the fragment so a document that arrived with a 64pt logo leaves
 * with one.
 */
function imageUrl(url: string, width?: number, align?: DocAlign): string {
  const hints: string[] = [];
  if (width) hints.push(`w=${Math.round(width)}`);
  if (align && align !== 'left') hints.push(`align=${align}`);
  if (!hints.length) return url;
  // Any fragment the url already had is replaced: ours is the meaning that
  // matters and two fragments is not a url.
  return `${url.split('#')[0]}#${hints.join('&')}`;
}

/** One block, as the lines it occupies. */
function blockToLines(b: Block): string[] {
  switch (b.kind) {
    case 'heading':
      return [...alignComment(b.align), `${'#'.repeat(b.level)} ${runsToMarkdown(b.runs)}`];

    case 'para':
      return [...alignComment(b.align), escapeLineStart(runsToMarkdown(b.runs))];

    case 'list': {
      const indent = '  '.repeat(Math.max(0, b.level));
      const marker = b.ordered ? `${b.index || 1}.` : '-';
      return [`${indent}${marker} ${runsToMarkdown(b.runs)}`];
    }

    case 'quote':
      return [`> ${runsToMarkdown(b.runs)}`];

    case 'code': {
      // A fence longer than anything inside it, so a snippet that itself
      // contains three backticks does not end the block early.
      const longest = Math.max(2, ...[...String(b.text ?? '').matchAll(/`+/g)].map((m) => m[0].length));
      const fence = '`'.repeat(longest + 1);
      return [`${fence}${b.lang ?? ''}`, String(b.text ?? ''), fence];
    }

    case 'rule':
      return ['---'];

    case 'pagebreak':
      return ['<!-- pagebreak -->'];

    case 'space':
      return [`<!-- space: ${Math.round(b.points)} -->`];

    case 'image':
      return [
        ...alignComment(b.align),
        `![${escapeText(b.alt ?? '')}](${imageUrl(b.url, b.width, b.align)})`,
      ];

    case 'table': {
      const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
      const out: string[] = [];
      if (b.widths?.length) out.push(`<!-- columns: ${b.widths.map((w) => Math.round(w * 100) / 100).join(',')} -->`);
      const row = (cells: Inline[][]) => `| ${Array.from({ length: cols }, (_, i) => cellToMarkdown(cells[i])).join(' | ')} |`;
      out.push(row(b.header.length ? b.header : []));
      out.push(`| ${Array.from({ length: cols }, (_, i) => ALIGN_ROW[cellAlign(b.align?.[i])]).join(' | ')} |`);
      for (const r of b.rows) out.push(row(r));
      return out;
    }

    default:
      return [];
  }
}

/** Two blocks of the same list belong together; everything else gets air. */
function needsBlankLine(previous: Block, next: Block): boolean {
  if (previous.kind === 'list' && next.kind === 'list') return false;
  return true;
}

/**
 * The whole document, as markdown.
 *
 * Ends with a single newline, like every other text file, so appending to it
 * does not weld a new paragraph onto the last one.
 */
export function toMarkdown(blocks: Block[]): string {
  const NL = String.fromCharCode(10);
  const out: string[] = [];
  let previous: Block | undefined;
  for (const b of blocks) {
    const lines = blockToLines(b);
    if (!lines.length) continue;
    if (previous && needsBlankLine(previous, b)) out.push('');
    out.push(...lines);
    previous = b;
  }
  return out.join(NL).replace(/\n{3,}/g, NL + NL).trim() + NL;
}
