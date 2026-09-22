/**
 * ══════════════════════════════════════════════════════════════════════════
 * THE CANVAS LEAVES THE SAME ROOM THE FILE WILL
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The board is not a page previewer — it is a BlockSuite note, laid out by the
 * browser — so the only thing that can keep it honest is using the exporter's
 * own numbers. `document-view.css` writes every gap as `calc(N * var(--vs-pt))`
 * for exactly that reason: N is the exporter's N, and this reads both files and
 * checks that it still is.
 *
 * ── WHY A SOURCE TEST AND NOT A RENDERED ONE ──────────────────────────────
 * jsdom has no layout, so it cannot answer what a gap measured. A real browser
 * can, and did — that is how these values were confirmed, against a document
 * dropped into a running board. But that check cannot run in this suite, and a
 * check that does not run is not a check. This one catches the thing that
 * actually happens: somebody tunes `H_AFTER` in `pdf.ts` and the board quietly
 * stops matching.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${__dirname}/../theme/document-view.css`, 'utf8');
const pdf = readFileSync(`${__dirname}/pdf.ts`, 'utf8');

/** The numbers the PDF writer actually uses. */
function constants(): Record<string, number[]> {
  const grab = (name: string) => {
    const hit = new RegExp(`const ${name} = \\[([^\\]]+)\\]`).exec(pdf);
    if (!hit) throw new Error(`${name} is no longer an array literal in pdf.ts`);
    return hit[1]!.split(',').map((n) => Number(n.trim()));
  };
  return { H_SIZE: grab('H_SIZE'), H_BEFORE: grab('H_BEFORE'), H_AFTER: grab('H_AFTER') };
}

/** Every `selector { ... }` in the file, split once. */
const CALC = /calc\(\s*([\d.]+)\s*\*\s*var\(--vs-pt\)\s*\)/g;
const RULES = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));

/**
 * The points in the rule whose selector contains `needle`.
 *
 * Returned in CSS order — top, then bottom for a two-value margin, so a
 * heading reads `[before, after]` exactly as the exporter names them.
 */
function points(needle: string, prop = '--affine-paragraph-margin'): number[] {
  // Split on ';' and compare names literally. A dynamically built RegExp
  // here is one backslash away from silently matching nothing, which is
  // exactly how a test that checks a stylesheet stops checking it.
  const declared = (body: string) => body.split(';')
    .map((d) => d.trim())
    .find((d) => d.slice(0, d.indexOf(':')).trim() === prop);
  const rule = RULES.find((r) => r.sel.includes(needle) && declared(r.body));
  if (!rule) throw new Error(`no rule setting ${prop} for ${needle}`);
  const value = declared(rule.body)!.slice(prop.length + 1);
  return [...value.matchAll(CALC)].map((m) => Number(m[1]));
}

describe('the board leaves the room the file will', () => {
  const { H_BEFORE, H_AFTER } = constants();

  it('converts points with the body sizes the two sides actually use', () => {
    // 11pt in the file, 16px on screen — a document is read further from a
    // screen than from paper. Everything else is derived from this one ratio.
    expect(css).toContain('--vs-pt: calc(16 / 11 * 1px)');
    expect(pdf).toContain('const BODY_SIZE = 11;');
  });

  for (const level of [1, 2, 3, 4]) {
    it(`gives an h${level} the exporter's ${H_BEFORE[level - 1]}pt before and ${H_AFTER[level - 1]}pt after`, () => {
      const got = points(`.affine-paragraph-rich-text-wrapper.h${level}`);
      // A zero `before` is written as a bare 0 rather than calc(0 * …), so an
      // h1 yields one number and the rest yield two.
      const want = H_BEFORE[level - 1] === 0
        ? [H_AFTER[level - 1]!]
        : [H_BEFORE[level - 1]!, H_AFTER[level - 1]!];
      expect(got).toEqual(want);
    });
  }

  it('gives a paragraph the 7pt the exporter drops after one', () => {
    expect(pdf).toMatch(/case 'para':[\s\S]{0,400}?y -= 7;/);
    expect(points('affine-paragraph')).toEqual([7]);
  });

  it('gives a list the tighter 3pt', () => {
    expect(pdf).toMatch(/case 'list': \{[\s\S]{0,900}?y -= 3;/);
    expect(points('affine-list', '--affine-list-margin')).toEqual([3]);
  });

  it("gives a rule the exporter's asymmetric 8pt above and 14pt below", () => {
    // `rule` belongs to what follows it, which is why the two differ.
    expect(pdf).toMatch(/case 'rule':[\s\S]{0,200}?y -= 8;[\s\S]{0,300}?y -= 14;/);
    expect(points('affine-divider > .affine-block-component', 'margin')).toEqual([8, 14]);
  });

  it('makes one unit of gap the SPACE_UNIT it is defined as', () => {
    const unit = /export const SPACE_UNIT = (\d+)/.exec(
      readFileSync(`${__dirname}/align-marks.ts`, 'utf8'),
    );
    expect(unit).toBeTruthy();
    expect(points("affine-paragraph[data-vs-mark='space']", 'line-height'))
      .toEqual([Number(unit![1])]);
  });

  /**
   * THE ONE THAT MAKES THE REST TRUE.
   *
   * The exporter takes the room after a block and THEN the room before the
   * next, so a gap is the two added. Sibling margins collapse to the larger
   * instead — right for paragraph-after-paragraph (7 and 0) and wrong for a
   * heading after a paragraph, which should open 27pt and collapsed to 20pt.
   * Flex items do not collapse.
   */
  it('stops the gaps collapsing, so they add up like the exporter', () => {
    expect(css).toMatch(
      /\.affine-block-children-container \{[^}]*display: flex;[^}]*flex-direction: column;/s,
    );
  });

  /**
   * THE ONE THAT BROKE THE RULE ON THE PAGE.
   *
   * The page margin used to be given to EVERY `.affine-block-children-
   * container` and then taken back from an allowlist of block types —
   * paragraph, list, table, image. `affine-divider` was never on that list,
   * so the divider's own nested container kept a 56px/64px page margin and
   * stood 137px tall.
   *
   * BlockSuite's divider container is `height: 1px; display: flex;
   * flex-direction: column; justify-content: center`, so that 137px
   * overflowed a one-pixel line and centring split the overflow evenly —
   * lifting the `hr` 68px above its own block, where it drew a hairline
   * through the last line of the paragraph above. Measured at top=239.9 in a
   * container at top=287.9.
   *
   * Naming the page column by POSITION cannot fall out of step with a list
   * of block types, which is the only reason this can be a static check.
   */
  it('gives the page margin to the page column only, by position', () => {
    const page = RULES.filter((r) => r.body.includes('56px 64px 64px'));
    expect(page).toHaveLength(1);
    expect(page[0]!.sel).toContain('.affine-note-block-container > .affine-block-children-container');
    // And the default for a container is the nested one, not the page one.
    const plain = RULES.find((r) => r.sel.endsWith('.affine-block-children-container')
      && !r.sel.includes('>') && r.body.includes('padding'));
    expect(plain?.body).toContain('padding: 0 0 0 24px');
  });

  /** 18px top and bottom of BlockSuite's own, which the exporter does not leave. */
  it('does not let the divider carry padding the file has no room for', () => {
    const rule = RULES.find((r) => r.sel.includes('.affine-divider-block-container'));
    expect(rule?.body).toContain('padding: 0');
  });

  /**
   * BlockSuite sets these margins as an INLINE style reading its own variable,
   * and an inline style outranks any stylesheet rule. Setting `margin` on the
   * component is therefore a no-op that looks exactly like a working rule —
   * which is what the previous version of this file did for months, matching
   * the 10px fallback by coincidence.
   */
  it('sets the spacing through the variable, not past it', () => {
    const doomed = /affine-(?:paragraph|list) > \.affine-block-component \{[^}]*\bmargin:/s;
    expect(css).not.toMatch(doomed);
  });
});
