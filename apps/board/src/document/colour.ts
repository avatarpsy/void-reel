/**
 * The document's colour vocabulary. One copy.
 *
 * ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
 * There were three of these. `blocks.ts` parsed a colour when it read
 * `[x]{color=navy}`, `inline-marks.ts` parsed one when the same text crossed
 * onto the canvas, and `docx-import.ts` parsed one when a Word file arrived —
 * each with its own list of names.
 *
 * That is not merely untidy. The first two have to agree EXACTLY or a document
 * shows one colour on the page and exports another, which is the single most
 * confusing fault a document tool can have and the hardest to notice: nobody
 * compares a screen and a PDF swatch by swatch. There is a test asserting the
 * two readers agree; this file is what makes that easy to keep true rather than
 * a coincidence maintained by hand.
 */

/**
 * The sixteen names worth supporting, and the shades chosen for PAPER.
 *
 * Not the CSS named colours: `red` in CSS is #ff0000, which on a printed page
 * is a fire alarm. These are the values a designer would actually set a line of
 * a letter in.
 */
export const NAMED_COLOURS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#cc0000',
  green: '#107c10',
  blue: '#1a56db',
  yellow: '#f5c400',
  orange: '#e06c00',
  purple: '#6b21a8',
  grey: '#666666',
  gray: '#666666',
  navy: '#1b2a4a',
  teal: '#0f6e6e',
  maroon: '#7a1f1f',
  olive: '#5c6b16',
  silver: '#b8b8b8',
  lime: '#3fb618',
};

/** What `==this==` means when no colour is named: the highlighter yellow. */
export const HIGHLIGHT_DEFAULT = '#fff3a3';

/**
 * A colour as `#rrggbb`, or undefined for anything that is not one.
 *
 * Undefined rather than a fallback on purpose: a caller that cannot read a
 * colour should leave the text alone and let it follow the document, not pin
 * black onto it. `auto` is Word's word for exactly that and is rejected here
 * for the same reason.
 */
export function normaliseColour(value: string | null | undefined): string | undefined {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'auto' || raw === 'none' || raw === 'inherit') return undefined;

  const named = NAMED_COLOURS[raw];
  if (named) return named;

  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(raw);
  if (!hex) return undefined;
  const digits = hex[1]!;
  return `#${digits.length === 3 ? digits.split('').map((c) => c + c).join('') : digits}`;
}

/**
 * `#aabbcc` → `AABBCC`. Word rejects the hash and silently ignores the colour,
 * which looks exactly like the colour not having been set.
 */
export function hex6(value: string): string {
  return String(value ?? '').replace('#', '').toUpperCase();
}

/**
 * The reverse: a hex back to the name a document would write, when there is one.
 *
 * Used when a colour comes off the canvas and has to be written as markup —
 * `color=navy` reads better than `color=#1b2a4a` and survives a hand-edit that
 * a hex would not.
 */
export function nameOfColour(value: string): string | undefined {
  const hex = normaliseColour(value);
  if (!hex) return undefined;
  for (const [name, known] of Object.entries(NAMED_COLOURS)) {
    // `gray` and `grey` share a value; the first spelling in the map wins, and
    // it is `grey` because the rest of this codebase is written in English.
    if (known === hex) return name;
  }
  return undefined;
}
