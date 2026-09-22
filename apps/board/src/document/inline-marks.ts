/**
 * Underline, highlight and colour, across the boundary into a note.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES
 * ══════════════════════════════════════════════════════════════════════════
 * BlockSuite's markdown adapter understands the marks markdown has — bold,
 * italic, strike, code, link — and nothing else. Our three extra ones are
 * written `++underline++`, `==highlight==` and `[text]{color=#c00}`, and to the
 * adapter those are just characters. So a certificate placed on the board
 * showed the user `[Nalamasa Dinesh]{color=#1a56db size=24}`, braces and all,
 * and exported without the colour.
 *
 * The marks themselves are NOT the problem: `underline`, `background` and
 * `color` are real inline attributes that BlockSuite stores, renders and puts
 * on its own formatting toolbar. The problem is only that markdown is the
 * transport and markdown cannot say them.
 *
 * So the conversion happens on the SNAPSHOT, on both sides of the adapter:
 * markers become attributes going in, attributes become markers coming out.
 * The same shape as the hard-break carrier next door, for the same reason.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SIZE IS NOT HERE, AND THAT IS NOT AN OVERSIGHT
 * ══════════════════════════════════════════════════════════════════════════
 * There is no native inline font size. A `size=24` reaches the PDF and the Word
 * file, and is lost if that line is hand-edited on the canvas — which is what
 * the tool guidance tells the model, so it can keep load-bearing things off it.
 */

import { eachDelta } from './align-marks';
import { HIGHLIGHT_DEFAULT, NAMED_COLOURS, normaliseColour } from './colour';

interface Attrs {
  underline?: true;
  background?: string;
  color?: string;
}

/**
 * The three markers, longest-lived first.
 *
 * `[text]{…}` is matched before the others so that `[++x++]{color=red}` is read
 * as a coloured span containing an underline rather than the other way round —
 * which is also the order `serialise.ts` writes them in.
 */
const SPAN = /\[([^\]\n]+)\]\{([^}\n]*)\}/;
const UNDERLINE = /\+\+(?=\S)([\s\S]*?\S)\+\+/;
const HIGHLIGHT = /==(?=\S)([\s\S]*?\S)==/;

/** `{color=#c00 highlight=yellow}` → the attributes BlockSuite understands. */
function spanAttrs(body: string): Attrs {
  const out: Attrs = {};
  for (const [, key, value] of body.matchAll(/(\w+)\s*=\s*"?([^\s"}]+)"?/g)) {
    const name = String(key).toLowerCase();
    if (name === 'color' || name === 'colour') out.color = normaliseColour(String(value));
    else if (name === 'highlight' || name === 'background' || name === 'bg') {
      out.background = normaliseColour(String(value));
    } else if (name === 'underline' && value !== 'false') out.underline = true;
    // `size` is deliberately not here — see the note at the top of the file.
  }
  if (!out.color) delete out.color;
  if (!out.background) delete out.background;
  return out;
}

/**
 * One delta's text, cut into pieces with the attributes its markers imply.
 *
 * Recursive so the marks nest: `++a **b** c++` has already been split into
 * bold and non-bold deltas by the adapter, and each of those is processed here
 * independently, so both halves come back underlined.
 */
function split(text: string, inherited: Attrs): Array<{ text: string; attrs: Attrs }> {
  for (const [pattern, apply] of [
    [SPAN, (m: RegExpExecArray) => spanAttrs(m[2]!)] as const,
    [UNDERLINE, () => ({ underline: true as const })] as const,
    [HIGHLIGHT, () => ({ background: HIGHLIGHT_DEFAULT })] as const,
  ]) {
    const m = pattern.exec(text);
    if (!m) continue;
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    const inner = m[1]!;
    return [
      ...(before ? split(before, inherited) : []),
      ...split(inner, { ...inherited, ...apply(m) }),
      ...(after ? split(after, inherited) : []),
    ];
  }
  return text ? [{ text, attrs: inherited }] : [];
}

/**
 * GOING IN: markers in the text become attributes on the delta.
 *
 * Runs on the snapshot the adapter produced, so the text is already broken into
 * deltas by the marks markdown DOES have — and the markers this understands are
 * whatever is left over as characters.
 */
export function markersToAttributes(root: unknown): void {
  eachDelta(root, (delta, owner) => {
    let changed = false;
    const out: any[] = [];
    for (const part of delta) {
      const text = typeof part?.insert === 'string' ? part.insert : '';
      if (!text || !/(\+\+|==|\]\{)/.test(text)) { out.push(part); continue; }
      const pieces = split(text, {});
      if (pieces.length === 1 && !Object.keys(pieces[0]!.attrs).length) {
        out.push(part);
        continue;
      }
      changed = true;
      for (const piece of pieces) {
        const attributes = { ...(part.attributes ?? {}), ...piece.attrs };
        out.push(Object.keys(attributes).length
          ? { insert: piece.text, attributes }
          : { insert: piece.text });
      }
    }
    if (changed) owner.delta = out;
  });
}

/**
 * COMING OUT: attributes become markers the markdown can carry.
 *
 * The order matters and mirrors `serialise.ts`: a span wrapper goes OUTSIDE the
 * underline, because `[++x++]{color=red}` parses and the other nesting does not.
 */
export function attributesToMarkers(root: unknown): void {
  eachDelta(root, (delta, owner) => {
    let changed = false;
    const out: any[] = [];
    for (const part of delta) {
      const attributes: any = part?.attributes ?? {};
      const text = typeof part?.insert === 'string' ? part.insert : '';
      const background = typeof attributes.background === 'string' ? attributes.background : '';
      const colour = typeof attributes.color === 'string' ? attributes.color : '';
      if (!text.trim() || (!attributes.underline && !background && !colour)) {
        out.push(part);
        continue;
      }
      changed = true;

      /**
       * A colour BlockSuite wrote itself is a CSS variable, not a hex — the
       * toolbar's swatches are theme tokens. There is no hex to recover, so the
       * mark is written by NAME, which `blocks.ts` also accepts.
       */
      let wrapped = text;
      if (attributes.underline) wrapped = `++${wrapped}++`;
      if (background && !colour) {
        const named = tokenName(background);
        wrapped = named ? `[${wrapped}]{highlight=${named}}` : `==${wrapped}==`;
      } else if (colour) {
        const named = tokenName(colour);
        const parts = [`color=${named ?? colour}`];
        if (background) parts.push(`highlight=${tokenName(background) ?? background}`);
        wrapped = `[${wrapped}]{${parts.join(' ')}}`;
      }

      // The attributes are REMOVED once they are in the text, or the adapter
      // would drop them and the markers would be doubled by the next trip.
      const rest = { ...attributes };
      delete rest.underline;
      delete rest.background;
      delete rest.color;
      out.push(Object.keys(rest).length
        ? { insert: wrapped, attributes: rest }
        : { insert: wrapped });
    }
    if (changed) owner.delta = out;
  });
}

/**
 * `var(--affine-text-highlight-foreground-red)` → `red`.
 *
 * Returns undefined for a plain hex, which is already a colour the mark syntax
 * accepts, and for a token whose name is not one of ours — better a document
 * that loses one highlight than one with `var(--affine…)` printed in it.
 */
function tokenName(value: string): string | undefined {
  if (/^#[0-9a-f]{3,6}$/i.test(value)) return undefined;
  const m = /(?:foreground|background|highlight)-([a-z]+)\s*\)?\s*$/i.exec(value);
  const name = m?.[1]?.toLowerCase();
  return name && NAMED_COLOURS[name] ? name : undefined;
}

/** The span as the adapter leaves it: the opening bracket escaped. */
const ESCAPED_SPAN = /\\\[([^\]\n]+)\]\{([^}\n]*)\}/g;

/**
 * Put back the bracket the adapter escaped.
 *
 * BlockSuite escapes `[` on the way out, which is right for prose and fatal
 * for our span: the colour reads back as a literal bracket and is gone. Only
 * the FULL span shape is unescaped, so an escaped bracket in someone's own
 * prose stays escaped.
 */
export function unescapeSpans(markdown: string): string {
  return String(markdown ?? '').replace(ESCAPED_SPAN, '[$1]{$2}');
}
