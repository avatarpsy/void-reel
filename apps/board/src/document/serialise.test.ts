/**
 * THE ROUND TRIP: parse(serialise(parse(x))) === parse(x).
 *
 * Compared as BLOCKS rather than as strings, deliberately. Two markdown files
 * can say the same thing with different characters — `*a*` and `_a_`, one space
 * or three in a table — and pinning the string would fail on differences that
 * are not differences. What must not change is the document.
 *
 * The property matters because an imported .docx goes model -> markdown -> note
 * -> model -> file. If that loop is not stable, a document loses a little of
 * itself every time it is opened, and the loss is invisible until it is large.
 */
import { describe, it, expect } from 'vitest';

import { parseMarkdown } from './blocks';
import { toMarkdown } from './serialise';

const NL = String.fromCharCode(10);

/** Parse, serialise, parse again — and say what changed. */
function stable(markdown: string) {
  const once = parseMarkdown(markdown);
  const twice = parseMarkdown(toMarkdown(once));
  return { once, twice, text: toMarkdown(once) };
}

function expectStable(markdown: string) {
  const { once, twice } = stable(markdown);
  expect(twice).toEqual(once);
}

describe('a document survives being written back out', () => {
  it('keeps headings, prose and the marks on its runs', () => {
    expectStable([
      '# Title',
      '',
      'Plain, **bold**, *italic*, ++underlined++, ==highlighted==, ~~struck~~ and `code`.',
      '',
      '## Second level',
      '',
      'A [link](https://voidspace.ai) and [a coloured run]{color=#cc0000 size=18}.',
    ].join(NL));
  });

  it('keeps alignment', () => {
    expectStable([
      '<!-- align:center -->',
      '# Certificate',
      '',
      '<!-- align:right -->',
      '22 September 2026',
    ].join(NL));
  });

  it('keeps lists, including nesting and numbering', () => {
    expectStable([
      '- one',
      '- two',
      '  - nested',
      '',
      '1. first',
      '2. second',
    ].join(NL));
  });

  it('keeps a table with its alignment and its column widths', () => {
    expectStable([
      '<!-- columns: 4,1,1 -->',
      '| Description | Qty | Amount |',
      '| :--- | :---: | ---: |',
      '| A line item | 2 | 1,200.00 |',
    ].join(NL));
  });

  it('keeps page breaks, rules and deliberate space', () => {
    expectStable([
      'Before.',
      '',
      '<!-- space: 72 -->',
      '',
      '---',
      '',
      '<!-- pagebreak -->',
      '',
      'After.',
    ].join(NL));
  });

  it('keeps an image with its width and placement', () => {
    const { twice } = stable('![Voidspace](https://voidspace.ai/logo.png#w=64&align=center)');
    expect(twice[0]).toMatchObject({
      kind: 'image', width: 64, align: 'center', alt: 'Voidspace',
    });
  });

  it('keeps a quote and a fenced code block', () => {
    expectStable([
      '> a quote',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join(NL));
  });

  it('keeps a hard break inside a paragraph', () => {
    const { twice } = stable(['Voidspace Technologies  ', 'Secunderabad'].join(NL));
    expect(twice).toHaveLength(1);
    const text = (twice[0] as any).runs.map((r: any) => r.text).join('');
    expect(text.split(NL)).toEqual(['Voidspace Technologies', 'Secunderabad']);
  });
});

describe('the corners, which is where a serialiser actually fails', () => {
  /** A pipe inside a cell ends the cell unless it is escaped. */
  it('escapes a pipe inside a table cell', () => {
    const { twice } = stable([
      '| A | B |',
      '| --- | --- |',
      '| x \\| y | z |',
    ].join(NL));
    const cell = (twice[0] as any).rows[0][0].map((r: any) => r.text).join('');
    expect(cell).toBe('x | y');
  });

  /**
   * ── STARTS FROM BLOCKS, NOT FROM MARKDOWN ────────────────────────────────
   *
   * This is the case an IMPORT produces: a .docx whose text literally contains
   * asterisks, underscores or brackets. Starting from markdown cannot test it —
   * `**x**` in markdown means bold, so the round trip is trivially fine, and an
   * earlier version of this test passed with the escaping switched off entirely.
   */
  it('escapes markup characters that are just characters', () => {
    const LITERAL = [
      'Costs 5 * 3 dollars',
      'Not **bold**, just asterisks',
      'file_name_with_underscores and _leading',
      'A # hash, a [bracket] and a <tag>',
      'A backtick ` and a tilde ~~',
      'Ends with a backslash ' + String.fromCharCode(92),
      '+ not a list item',
    ];
    for (const text of LITERAL) {
      const blocks: any[] = [{ kind: 'para', runs: [{ text }] }];
      const back = parseMarkdown(toMarkdown(blocks as any));
      const got = (back[0] as any).runs.map((r: any) => r.text).join('');
      expect(got, text).toBe(text);
    }
  });

  it('keeps a mark around text that also needs escaping', () => {
    const blocks: any[] = [{ kind: 'para', runs: [{ text: '5 * 3', bold: true, underline: true }] }];
    const back = parseMarkdown(toMarkdown(blocks as any)) as any[];
    expect(back[0].runs[0]).toMatchObject({ text: '5 * 3', bold: true, underline: true });
  });
  /** A run that is BOTH a link and coloured has to keep both. */
  it('keeps a link that also carries a colour', () => {
    const { twice } = stable('[the dashboard](https://x.test){color=navy size=14}');
    expect((twice[0] as any).runs[0]).toMatchObject({
      text: 'the dashboard', link: 'https://x.test', color: '#1b2a4a', size: 14,
    });
  });

  it('does not end a code fence early on a snippet containing backticks', () => {
    const inner = ['```', 'nested', '```'].join(NL);
    const { twice } = stable(['````', inner, '````'].join(NL));
    expect((twice[0] as any).text).toContain('nested');
  });

  it('writes nothing for an empty document rather than a stray marker', () => {
    expect(toMarkdown([]).trim()).toBe('');
  });

  /** The output must not grow on each pass — a classic escaping bug. */
  it('does not accumulate escapes over repeated trips', () => {
    let text = 'A * B _ C ` D [E] F';
    const sizes: number[] = [];
    for (let i = 0; i < 4; i++) {
      text = toMarkdown(parseMarkdown(text));
      sizes.push(text.length);
    }
    expect(new Set(sizes).size).toBe(1);
  });
});
