/**
 * How alignment and page breaks survive being EDITED on the canvas.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE PROBLEM, MEASURED
 * ══════════════════════════════════════════════════════════════════════════
 * A document on the board is an `affine:note`, and BlockSuite decides what a
 * paragraph can hold. Three things were tried and each was checked against a
 * real round trip rather than assumed:
 *
 *   `<!-- align:center -->`   the markdown adapter DROPS an html comment.
 *   `<u>`, `<span style=…>`   escaped to visible text: `\<span style="…">`.
 *   `updateBlock(p, {align})` accepted, readable, and never reaches yjs —
 *                             `prop:align` is absent from the encoded update,
 *                             so it is gone on the next load or sync.
 *
 * So there is no property to put it in, and no comment that survives. What DOES
 * survive is the one thing a paragraph is made of: its text.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE CARRIER
 * ══════════════════════════════════════════════════════════════════════════
 * U+2060 WORD JOINER, at the start of the paragraph, one for centred and two
 * for right. It is zero-width, it joins rather than breaks, and it is ignored
 * by screen readers — so the line looks and reads exactly as it did, and the
 * mark travels with the paragraph through every edit that does not delete the
 * first character of it.
 *
 * Honest about the cost: select the whole line, retype it, and the alignment
 * goes with the text that carried it. That is the same bargain every word
 * processor makes with a paragraph mark, and a document that quietly reverts to
 * left is a plain document rather than a broken one.
 *
 * The markdown a user or the agent writes still uses the readable comment. This
 * module is the translation, and it runs at exactly two points: on the way onto
 * the canvas and on the way back off it.
 */
import type { DocAlign } from './blocks';

const WJ = '\u2060';

export const MARK = {
  center: WJ,
  right: WJ + WJ,
  /**
   * A paragraph that is ONLY this is deliberate space, worth `SPACE_UNIT`
   * points. Several in a row are several units — which is why the amount is
   * carried by REPETITION rather than by a number: a paragraph can hold a
   * mark or it can hold text, and an encoded digit would be text the user
   * could see and delete.
   *
   * It also means the canvas shows the gap honestly: three empty paragraphs
   * ARE three blank lines, which is what the exported page will have.
   */
  space: WJ + WJ + WJ,
  /**
   * Justified — both edges flush. Fifth, so the longer marks are still
   * read before the shorter ones whose prefix they share.
   */
  justify: WJ + WJ + WJ + WJ + WJ,
  /**
   * A paragraph that is ONLY this is where the contents page goes.
   *
   * A marker, not the contents: the entries are derived at export from the
   * headings, so putting a real list on the canvas would be a second,
   * editable copy of the document's structure — stale the moment either
   * one changed, and no way to tell which was meant.
   */
  toc: WJ + WJ + WJ + WJ + WJ + WJ,
  /** A paragraph that is ONLY this turns on clause numbering. */
  numbering: WJ + WJ + WJ + WJ + WJ + WJ + WJ,
  /** A paragraph that is ONLY this is a page break — invisible, like a blank line. */
  pagebreak: WJ + WJ + WJ + WJ,
} as const;

/**
 * What one space mark is worth.
 *
 * Twelve points is one blank line at an 11pt body, so the count and the
 * appearance agree. A gap is rounded to the nearest unit: the alternative was
 * encoding an exact number into invisible characters, which is unreadable in
 * the file and impossible to edit on the canvas.
 */
export const SPACE_UNIT = 12;

/**
 * EVERY mark, longest first — and that order is the whole correctness
 * argument, not a detail.
 *
 * The marks are runs of the same character, so each one BEGINS WITH every
 * shorter one: five word joiners start with four, which start with three.
 * Read in any other order, a justified paragraph is a page break, a page
 * break is a gap, and a gap is a centred line — silently, on the way back
 * out of a note somebody edited.
 *
 * One table so there is one place to get it right, rather than a chain of
 * `if`s whose order is load-bearing and invisible.
 */
const MARKS: Array<[string, 'numbering' | 'toc' | 'justify' | 'pagebreak' | 'space' | 'right' | 'center']> = [
  [MARK.numbering, 'numbering'],
  [MARK.toc, 'toc'],
  [MARK.justify, 'justify'],
  [MARK.pagebreak, 'pagebreak'],
  [MARK.space, 'space'],
  [MARK.right, 'right'],
  [MARK.center, 'center'],
];

const ALIGN_COMMENT = /^[ \t]*<!--[ \t]*align[ \t]*:[ \t]*(left|center|centre|right|justify|justified)[ \t]*-->[ \t]*$/i;
const SPACE_COMMENT = /^[ \t]*<!--[ \t]*(?:space|gap)[ \t]*:[ \t]*(\d{1,3})[ \t]*-->[ \t]*$/i;
const NUMBERED_COMMENT = /^[ \t]*<!--[ \t]*(?:numbered|number[- ]headings)[ \t]*-->[ \t]*$/i;
const TOC_COMMENT = /^[ \t]*<!--[ \t]*(?:toc|contents|table[- ]of[- ]contents)[ \t]*-->[ \t]*$/i;
const BREAK_COMMENT = /^[ \t]*<!--[ \t]*(?:pagebreak|page-break|newpage)[ \t]*-->[ \t]*$/i;

/**
 * Markdown's syntax comes FIRST, then the mark.
 *
 * `# \u2060Title`, not `\u2060# Title` — a zero-width character before the hash
 * stops it being a heading at all, which turns a centred title into a line of
 * prose beginning with a hash. The list and quote markers have the same rule.
 */
const SYNTAX = /^([ \t]*(?:[-*+] |\d+[.)] |>[ \t]*|#{1,6} )*)/;

function markLine(line: string, mark: string): string {
  const prefix = SYNTAX.exec(line)?.[1] ?? '';
  return prefix + mark + line.slice(prefix.length);
}

/**
 * Comments → marks, for markdown about to become a note.
 *
 * A directive applies to the next line with something on it, which is what the
 * comment means when you read it and what the exporters already do with it.
 */
export function marksFromComments(markdown: string): string {
  const lines = String(markdown ?? '').split('\n');
  const out: string[] = [];
  let pending = '';
  for (const line of lines) {
    const align = ALIGN_COMMENT.exec(line);
    if (align) {
      const word = align[1]!.toLowerCase();
      // Left is the default and needs no mark; everything else gets its own.
      pending = word === 'right' ? MARK.right
        : word === 'left' ? ''
          : word === 'justify' || word === 'justified' ? MARK.justify
            : MARK.center;
      continue;
    }
    const gap = SPACE_COMMENT.exec(line);
    if (gap) {
      const units = Math.max(1, Math.min(40, Math.round(Number(gap[1]) / SPACE_UNIT)));
      for (let i = 0; i < units; i++) out.push(MARK.space, '');
      continue;
    }
    if (NUMBERED_COMMENT.test(line)) { out.push(MARK.numbering, ''); continue; }
    if (TOC_COMMENT.test(line)) { out.push(MARK.toc, ''); continue; }
    if (BREAK_COMMENT.test(line)) {
      // Its own paragraph, so it survives as a block rather than attaching to
      // whatever happens to follow it.
      out.push(MARK.pagebreak, '');
      continue;
    }
    if (pending && line.trim()) {
      out.push(markLine(line, pending));
      pending = '';
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** What a marked line says, and the line without it. */
export function readMark(
  text: string,
): { align?: DocAlign; pagebreak?: boolean; space?: boolean; toc?: boolean; numbering?: boolean; text: string } {
  const raw = String(text ?? '');
  for (const [mark, kind] of MARKS) {
    if (!raw.startsWith(mark)) continue;
    const text = raw.slice(mark.length);
    if (kind === 'numbering') return { numbering: true, text };
    if (kind === 'toc') return { toc: true, text };
    if (kind === 'pagebreak') return { pagebreak: true, text };
    if (kind === 'space') return { space: true, text };
    return { align: kind, text };
  }
  // A mark that ended up anywhere else is invisible junk, not an instruction.
  return { text: raw.replace(new RegExp(WJ, 'g'), '') };
}

/** True when the string has nothing in it but marks — an empty marked line. */
export function isOnlyMarks(text: string): boolean {
  return String(text ?? '').replace(new RegExp(WJ, 'g'), '').trim() === '';
}

/**
 * Marks → comments, for markdown leaving for a file or the agent.
 *
 * Invisible characters in a `.md` the user downloads would be a small mystery
 * to whoever opened it next, so they go back to being readable.
 */
export function commentsFromMarks(markdown: string): string {
  const out: string[] = [];
  let spaceUnits = 0;
  /** Write the gap that has been accumulating, if any. */
  const flushSpace = () => {
    if (spaceUnits > 0) out.push(`<!-- space: ${spaceUnits * SPACE_UNIT} -->`, '');
    spaceUnits = 0;
  };

  for (const line of String(markdown ?? '').split('\n')) {
    const prefix = SYNTAX.exec(line)?.[1] ?? '';
    const rest = line.slice(prefix.length);
    const mark = readMark(rest);
    if (mark.numbering && !mark.text.trim()) { out.push('<!-- numbered -->'); continue; }
    if (mark.toc && !mark.text.trim()) { out.push('<!-- toc -->'); continue; }
    if (mark.pagebreak) {
      out.push('<!-- pagebreak -->');
      if (mark.text.trim()) out.push(prefix + mark.text);
      continue;
    }
    if (mark.space && !mark.text.trim()) {
      // Counted here, written once below: a run of marks is ONE gap.
      spaceUnits += 1;
      continue;
    }
    /**
     * A BLANK LINE DOES NOT END A GAP.
     *
     * Each mark is its own paragraph, so markdown separates them with an
     * empty line — which meant a three-unit gap came back as three separate
     * twelve-point comments. They re-imported to the same height, so nothing
     * looked wrong; the file just grew a line every time it was saved.
     */
    if (spaceUnits > 0 && !line.trim()) continue;
    flushSpace();
    if (mark.align) out.push(`<!-- align:${mark.align} -->`);
    out.push(prefix + mark.text);
  }
  flushSpace();
  return out.join('\n');
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * THE HARD BREAK, WHICH WAS BEING EATEN
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `one··\ntwo` came back from the canvas as `onetwo`. Not a rendering fault —
 * the note itself held `onetwo`, because the markdown adapter drops the `br`
 * token on the way IN, so the two words were welded before anything was even
 * stored. An address block lost its lines and a signature block lost its name.
 *
 * BlockSuite's own representation is a literal newline inside the paragraph's
 * text — that is what shift+Enter types, and the inline editor renders it. So
 * the break is carried past the adapter as U+2028 LINE SEPARATOR, a character
 * the adapter treats as ordinary text, and swapped for a real newline in the
 * snapshot afterwards. Coming back, the swap runs the other way.
 */
const LS = '\u2028';

/** A backslash, then the newline it escapes. */
const BACKSLASH_BREAK = String.fromCharCode(92) + String.fromCharCode(10);

/** A markdown hard break becomes the carrier, before the adapter sees it. */
export function breaksToCarrier(markdown: string): string {
  return String(markdown ?? '')
    .replace(/<br\s*\/?>/gi, LS)
    .replace(/[ \t]{2,}\r?\n(?=[^\s])/g, LS);
}

/**
 * Every text delta in a block snapshot, however deeply it is nested.
 *
 * EXPORTED because `inline-marks.ts` walks the same snapshots for the same
 * reason, and two copies of a recursive walk over an untyped tree is two
 * chances to miss a container. A table keeps its cell text off to the side
 * rather than in `children`, which is why this walks every value rather than
 * just the block tree — a fact worth knowing once, not twice.
 */
export function eachDelta(node: any, visit: (delta: any[], owner: any) => void): void {
  if (!node || typeof node !== 'object') return;
  const delta = node?.props?.text?.delta;
  if (Array.isArray(delta)) visit(delta, node.props.text);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((v) => eachDelta(v, visit));
    else if (value && typeof value === 'object') eachDelta(value, visit);
  }
}

function swap(root: unknown, from: string, to: string): void {
  eachDelta(root, (delta) => {
    for (const part of delta) {
      if (typeof part?.insert === 'string' && part.insert.includes(from)) {
        part.insert = part.insert.split(from).join(to);
      }
    }
  });
}

/** In a freshly built snapshot, the carrier becomes the real newline. */
export function carrierToBreaks(root: unknown): void {
  swap(root, LS, '\n');
}

/** Leaving: a real newline becomes the carrier, which markdown can express. */
export function breaksToCarrierSnapshot(root: unknown): void {
  swap(root, '\n', LS);
}

/** And in the markdown that comes out, the carrier becomes a hard break. */
export function carrierToMarkdown(markdown: string): string {
  // Backslash then a REAL newline, which is CommonMark's hard break.
  // Two trailing spaces also works and was tried first: whitespace is the
  // first thing an editor or a `.trim()` removes, and a line break that
  // vanishes when a file is tidied is not a line break.
  return String(markdown ?? '').split(LS).join(BACKSLASH_BREAK);
}

/**
 * Text with every mark taken out — for anything a PERSON reads.
 *
 * A centred title's text begins with U+2060, and `.trim()` does not remove it
 * because it is not whitespace. So a document's title, a section's name and
 * anything else read straight off a block goes through here: invisible is fine
 * inside the document and not fine in a file name or a heading in a panel.
 */
export function withoutMarks(text: unknown): string {
  return String(text ?? '').split(WJ).join('').split(LS).join(' ');
}
