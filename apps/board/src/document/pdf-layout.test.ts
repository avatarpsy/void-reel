/**
 * Line breaking, and the spaces between runs.
 *
 * ── WHY THIS IS TESTED HERE AND NOT THROUGH A RENDERED PDF ──────────────────
 * Because the bugs this catches are invisible everywhere else. A PDF's text is
 * Flate-compressed, so nothing greps it; the block model is correct; Word is
 * correct. The only two places the fault appears are a reader's eyes and this
 * function — and one of those is cheap to run on every commit.
 *
 * Every case below is one that actually shipped or nearly did.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { layout, fixedFonts, type Fonts } from './pdf';
import type { Inline } from './blocks';

let f: Fonts;
beforeAll(async () => {
  const pdf = await PDFDocument.create();
  // The standard faces, wrapped in the same interface the real renderer uses.
  // What is under test is where the line breaks, not which file a glyph is in.
  f = fixedFonts({
    regular: await pdf.embedFont(StandardFonts.TimesRoman),
    bold: await pdf.embedFont(StandardFonts.TimesRomanBold),
    italic: await pdf.embedFont(StandardFonts.TimesRomanItalic),
    boldItalic: await pdf.embedFont(StandardFonts.TimesRomanBoldItalic),
    mono: await pdf.embedFont(StandardFonts.Courier),
  });
});

/** What the page would actually read, line by line. */
function render(runs: Inline[], width = 400, size = 11): string[] {
  return layout(runs, f, size, width, { n: 0 }).map(l => l.map(p => p.text).join(''));
}

describe('spaces between runs', () => {
  /**
   * THE ONE THAT SHIPPED. `The **positioning** is that…` is three runs and the
   * third begins with the space. `\S+\s*` cannot match from a leading space, so
   * it was dropped and the page read "positioningis".
   */
  it('keeps the space that BEGINS a run', () => {
    const runs: Inline[] = [
      { text: 'The ' }, { text: 'positioning', bold: true }, { text: ' is that creators win.' },
    ];
    expect(render(runs).join(' ')).toBe('The positioning is that creators win.');
  });

  it('keeps the space that ENDS a run', () => {
    const runs: Inline[] = [
      { text: 'Creators get a ' }, { text: 'studio', bold: true }, { text: '.' },
    ];
    expect(render(runs).join(' ')).toBe('Creators get a studio.');
  });

  /** Two marks touching must NOT gain a space that is not in the source. */
  it('invents no space between adjacent marks', () => {
    const runs: Inline[] = [{ text: 'bold', bold: true }, { text: 'italic', italic: true }];
    expect(render(runs).join('')).toBe('bolditalic');
  });

  it('keeps spaces around a link and inline code', () => {
    const runs: Inline[] = [
      { text: 'See the ' }, { text: 'dashboard', link: 'https://x.test' },
      { text: ' for ' }, { text: 'npm run report', code: true }, { text: ' today.' },
    ];
    expect(render(runs, 600).join(' ')).toBe('See the dashboard for npm run report today.');
  });

  /** A leading space at the start of a LINE is correctly dropped, not indented. */
  it('drops a leading space when there is nothing before it', () => {
    expect(render([{ text: '   Indented?' }])[0]).toBe('Indented?');
  });
});

describe('breaking', () => {
  it('wraps to the column rather than overflowing it', () => {
    const lines = render([{ text: 'word '.repeat(60) }], 200);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(f.base('regular').widthOfTextAtSize(line.trimEnd(), 11)).toBeLessThanOrEqual(200);
    }
  });

  /** A raw URL is one token wider than the column; it must break, not escape. */
  it('breaks an unbreakable token instead of running off the page', () => {
    const url = `https://example.com/${'segment'.repeat(30)}`;
    const lines = render([{ text: url }], 200);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe(url);
  });

  it('breaks on a hard <br> and nowhere else', () => {
    expect(render([{ text: 'first\nsecond' }], 600)).toEqual(['first', 'second']);
  });

  /** Compared by value once, so two identical lines did not break between them. */
  it('breaks between two identical hard-broken lines', () => {
    expect(render([{ text: 'same\nsame' }], 600)).toEqual(['same', 'same']);
  });

  it('returns one empty line for no runs, rather than nothing to draw', () => {
    expect(layout([], f, 11, 400, { n: 0 })).toEqual([[]]);
  });
});
