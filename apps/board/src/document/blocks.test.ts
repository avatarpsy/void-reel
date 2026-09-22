/**
 * The block model both exporters read.
 *
 * Testing HERE rather than through a rendered file is deliberate: a bug in the
 * parse shows up identically in Word and in the PDF, because they share this,
 * and finding it once is the whole reason the model exists.
 */
import { describe, it, expect } from 'vitest';

import { parseMarkdown, documentFileName } from './blocks';

const RICH = [
  '# Quarterly Review',
  '',
  'The **headline** is that retention *held* at ~62%, with a ~~small~~ notable dip.',
  'A link to the [dashboard](https://example.com/dash) sits here.',
  '',
  '## Findings',
  '',
  '1. Activation improved after the onboarding change.',
  '2. Churn concentrated in the free tier.',
  '   - Mostly week-two drop-off.',
  '',
  '> The thing we got wrong was measuring signups, not second sessions.',
  '',
  '| Metric | Q1 | Q2 |',
  '| --- | --- | --- |',
  '| Retention | 58% | 62% |',
  '',
  '---',
  '',
  'Run `npm run report` to regenerate.',
  '',
  '```',
  'const total = rows.reduce((a, r) => a + r.value, 0);',
  '```',
].join('\n');

describe('parseMarkdown', () => {
  it('turns each markdown construct into its own block kind', () => {
    const kinds = parseMarkdown(RICH).map((b) => b.kind);
    for (const kind of ['heading', 'para', 'list', 'quote', 'table', 'rule', 'code']) {
      expect(kinds, `no ${kind} block`).toContain(kind);
    }
  });

  it('carries marks down through nesting instead of losing them', () => {
    const [para] = parseMarkdown('A **bold _both_** and `code`.') as any[];
    expect(para.runs.some((r: any) => r.bold && r.italic)).toBe(true);
    expect(para.runs.some((r: any) => r.code)).toBe(true);
  });

  it('keeps a link as an href on the run, not as visible syntax', () => {
    const [para] = parseMarkdown('See [the docs](https://x.test/a).') as any[];
    const link = para.runs.find((r: any) => r.link);
    expect(link.link).toBe('https://x.test/a');
    expect(link.text).toBe('the docs');
    expect(para.runs.map((r: any) => r.text).join('')).not.toContain('](');
  });

  /**
   * THE ONE A READER SEES IMMEDIATELY. Everybody wraps prose at 80 columns, so
   * almost every real paragraph arrives with newlines in it. Losing them set
   * "…to build\naudiences…" as "buildaudiences" in BOTH formats. Markdown's own
   * rule is that a soft break is a space.
   */
  it('turns a soft line break into a space, not into nothing', () => {
    const [para] = parseMarkdown('avatars to build\naudiences at a scale') as any[];
    const text = para.runs.map((r: any) => r.text).join('');
    expect(text).toBe('avatars to build audiences at a scale');
    expect(text).not.toContain('\n');
  });

  it('keeps a HARD break, which is a different thing entirely', () => {
    const [para] = parseMarkdown('first line  \nsecond line') as any[];
    expect(para.runs.map((r: any) => r.text).join('')).toContain('\n');
  });

  /** The title is the caller's, the H1 is the document's — never both. */
  it('adds a title heading only when the markdown has none', () => {
    expect(parseMarkdown('# Already\n\nBody', 'Already')).toHaveLength(2);
    const withTitle = parseMarkdown('Body only', 'Supplied');
    expect(withTitle[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect((withTitle[0] as any).runs[0].text).toBe('Supplied');
  });

  it('reads a standalone image as an image block, not as a paragraph of alt text', () => {
    const [b] = parseMarkdown('![A chart](https://x.test/c.png)') as any[];
    expect(b).toMatchObject({ kind: 'image', url: 'https://x.test/c.png', alt: 'A chart' });
  });

  it('keeps a nested list nested', () => {
    const lists = parseMarkdown('- one\n  - deeper\n').filter((b) => b.kind === 'list') as any[];
    expect(lists).toHaveLength(2);
    expect(lists[1].level).toBeGreaterThan(lists[0].level);
  });

  it('is empty for empty input rather than producing a blank block', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('   \n\n  ')).toEqual([]);
  });
});

describe('documentFileName', () => {
  it('matches the image editor twin, differing only in the fallback noun', () => {
    expect(documentFileName('Q3 Review', 'docx')).toBe('Q3 Review.docx');
    expect(documentFileName('Q3/Q4: "review" <draft>', 'pdf')).toBe('Q3Q4 review draft.pdf');
    expect(documentFileName('a\\b|c?d*e', 'pdf')).toBe('abcde.pdf');
    for (const empty of ['', '   ', undefined, '///']) {
      expect(documentFileName(empty as any, 'pdf')).toBe('document.pdf');
    }
  });

  it('does not leave a space before the extension', () => {
    expect(documentFileName('  Spaced  ', 'docx')).toBe('Spaced.docx');
  });
});

/**
 * THE TITLE, WHEN THE DOCUMENT ALREADY SAYS IT.
 *
 * Found in a downloaded Word file, not in a test: the board-as-page export
 * turns every frame into a section, which pushes the document's own `#` down to
 * `##`. The title is derived from that same heading, so the file opened with
 * "Weekly Update" as Heading1 and "Weekly Update" again as Heading2.
 */
describe('a title the document already carries', () => {
  it('is not printed twice when the heading has been demoted', () => {
    const blocks = parseMarkdown('## Weekly Update\n\nBody.', 'Weekly Update');
    const headings = blocks.filter((b) => b.kind === 'heading') as any[];
    expect(headings).toHaveLength(1);
    expect(headings[0].runs.map((r: any) => r.text).join('')).toBe('Weekly Update');
  });

  it('ignores case and surrounding space when comparing', () => {
    expect(parseMarkdown('### weekly update\n\nBody.', '  Weekly Update  ')
      .filter((b) => b.kind === 'heading')).toHaveLength(1);
  });

  /** A real subheading under a different title must keep BOTH. */
  it('still adds a title that the document does not already state', () => {
    const blocks = parseMarkdown('## Overview\n\nBody.', 'Q4 Plan');
    const headings = blocks.filter((b) => b.kind === 'heading') as any[];
    expect(headings.map((h) => h.runs.map((r: any) => r.text).join('')))
      .toEqual(['Q4 Plan', 'Overview']);
  });
});

/**
 * A LETTERHEAD NEEDS A SMALL PICTURE.
 *
 * Markdown cannot size an image, so every picture was drawn at the full text
 * column — which reads a 1024px logo as 1024 POINTS and sets it 450pt wide.
 * Measured on a real certificate: two pages, the first one entirely logo.
 *
 * The hint rides on the url fragment because this document is ALSO an editable
 * page on the board: a marker in the prose would survive the round trip as
 * visible text the user has to delete, and a fragment is never displayed and
 * never sent to a server.
 */
describe('image size and placement hints', () => {
  const imageBlock = (md: string) =>
    parseMarkdown(md).find((b) => b.kind === 'image') as
      Extract<ReturnType<typeof parseMarkdown>[number], { kind: 'image' }>;

  it('reads a width off the url fragment', () => {
    const b = imageBlock('![](https://x.test/logo.png#w=120)');
    expect(b.width).toBe(120);
  });

  it('accepts the long spelling, and an alignment beside it', () => {
    const b = imageBlock('![](https://x.test/logo.png#width=96&align=left)');
    expect(b.width).toBe(96);
    expect(b.align).toBe('left');
  });

  it('leaves the url intact, fragment and all — fetch drops it anyway', () => {
    const b = imageBlock('![](https://x.test/logo.png#w=120)');
    expect(b.url).toBe('https://x.test/logo.png#w=120');
  });

  it('has no opinion when nothing was asked for', () => {
    const b = imageBlock('![](https://x.test/chart.png)');
    expect(b.width).toBeUndefined();
    expect(b.align).toBeUndefined();
  });

  it('ignores a hint it cannot read rather than refusing the picture', () => {
    const b = imageBlock('![](https://x.test/logo.png#w=wide&align=diagonal&nonsense)');
    expect(b.kind).toBe('image');
    expect(b.width).toBeUndefined();
    expect(b.align).toBeUndefined();
  });

  it('caps an absurd width instead of trusting it', () => {
    expect(imageBlock('![](https://x.test/logo.png#w=99999)').width).toBe(2000);
  });

  it('still keeps the alt text as the caption', () => {
    const b = imageBlock('![Revenue by month](https://x.test/c.png#w=300)');
    expect(b.alt).toBe('Revenue by month');
    expect(b.width).toBe(300);
  });
});

describe('a document that opens with a picture', () => {
  it('keeps its own masthead instead of a heading above the logo', () => {
    const out = parseMarkdown(
      [
        '![](https://x.test/logo.png#w=70&align=left)',
        '',
        '**Voidspace AI**',
        '',
        '## CERTIFICATE',
      ].join('\n'),
      'Internship Completion Certificate',
    );
    // The logo is still first: no file name stamped over the letterhead.
    expect(out[0]!.kind).toBe('image');
    const headings = out.filter((b) => b.kind === 'heading');
    expect(headings.map((h: any) => h.runs.map((r: any) => r.text).join(''))).toEqual(['CERTIFICATE']);
  });

  it('still titles an ordinary document that opens with prose', () => {
    const out = parseMarkdown('Just a paragraph.', 'Quarterly Review');
    expect(out[0]!.kind).toBe('heading');
  });
});

/**
 * ALIGNMENT, FOR THE PARTS OF A LETTERHEAD THAT NEED IT.
 *
 * Markdown has none, and a letterhead's footer is centred while its date is
 * often right. The directive is an HTML COMMENT because this document is also
 * an editable page on the board: anything written in the prose comes back from
 * that round trip as characters the user has to delete, and BlockSuite's
 * markdown adapter drops a comment rather than rendering it.
 */
describe('block alignment', () => {
  const first = (md: string) => parseMarkdown(md)[0]! as any;

  it('centres the block that follows the directive', () => {
    const b = first(['<!-- align:center -->', 'Secunderabad, Telangana'].join('\n'));
    expect(b.kind).toBe('para');
    expect(b.align).toBe('center');
  });

  it('applies to that block only, not the rest of the document', () => {
    const out = parseMarkdown(
      ['<!-- align:center -->', 'Centred line', '', 'Ordinary line'].join('\n'),
    ) as any[];
    expect(out[0].align).toBe('center');
    expect(out[1].align).toBeUndefined();
  });

  it('aligns a heading too', () => {
    const b = first(['<!-- align:center -->', '## CERTIFICATE'].join('\n'));
    expect(b.kind).toBe('heading');
    expect(b.align).toBe('center');
  });

  it('takes the British spelling, because someone will write it', () => {
    expect(first(['<!-- align:centre -->', 'Text'].join('\n')).align).toBe('center');
  });

  it('never leaves the directive in the document as text', () => {
    const out = parseMarkdown(['<!-- align:right -->', 'Date: 22 September 2026'].join('\n')) as any[];
    const text = out.flatMap((b) => b.runs ?? []).map((r: any) => r.text).join('');
    expect(text).not.toMatch(/align|<!--/);
  });

  it('leaves everything unaligned when the direction is not one', () => {
    const out = parseMarkdown(['<!-- align:diagonal -->', 'Text'].join('\n')) as any[];
    expect(out.every((b) => !b.align)).toBe(true);
  });
});

/**
 * PAGE BREAKS — the thing every real document needs and markdown has no word
 * for. Without one the only way to push a section onto a fresh page was blank
 * lines and hope, which stops working the moment a sentence above is edited.
 */
describe('page breaks', () => {
  it('reads the directive as a break, in all three spellings', () => {
    for (const word of ['pagebreak', 'page-break', 'newpage']) {
      const out = parseMarkdown(['One', '', `<!-- ${word} -->`, '', 'Two'].join('\n'));
      expect(out.map((b) => b.kind), word).toEqual(['para', 'pagebreak', 'para']);
    }
  });

  it('never leaves the directive in the text', () => {
    const out = parseMarkdown(['One', '', '<!-- pagebreak -->', '', 'Two'].join('\n')) as any[];
    const text = out.flatMap((b) => b.runs ?? []).map((r: any) => r.text).join(' ');
    expect(text).not.toMatch(/pagebreak|<!--/);
  });

  it('is not confused with an alignment directive', () => {
    const out = parseMarkdown(['<!-- align:center -->', 'Centred'].join('\n')) as any[];
    expect(out.map((b) => b.kind)).toEqual(['para']);
    expect(out[0].align).toBe('center');
  });
});

/**
 * THE MARKS MARKDOWN NEVER HAD. A letterhead needs underline; a marked-up draft
 * needs highlight; a certificate needs one line in the company's red.
 */
describe('run formatting', () => {
  const runsOf = (md: string) => (parseMarkdown(md)[0] as any).runs as any[];

  it('underlines ++text++ and keeps the marker out of the words', () => {
    const runs = runsOf('a ++under++ b');
    expect(runs.map((r) => r.text).join('')).toBe('a under b');
    expect(runs.find((r) => r.underline)?.text).toBe('under');
  });

  it('highlights ==text== in highlighter yellow', () => {
    expect(runsOf('a ==hot== b').find((r) => r.highlight)?.text).toBe('hot');
    expect(runsOf('a ==hot== b').find((r) => r.highlight)?.highlight).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('nests other marks inside them, rather than cutting them in half', () => {
    const runs = runsOf('++a **b** c++');
    expect(runs.every((r) => r.underline)).toBe(true);
    expect(runs.find((r) => r.bold)?.text).toBe('b');
  });

  it('reads colour and size off a bracketed span', () => {
    const [run] = runsOf('[Certificate]{color=#c00 size=22}');
    expect(run).toMatchObject({ text: 'Certificate', color: '#cc0000', size: 22 });
  });

  it('accepts a colour by name, and a three-digit hex', () => {
    expect(runsOf('[x]{color=red}')[0].color).toBe('#cc0000');
    expect(runsOf('[x]{color=#abc}')[0].color).toBe('#aabbcc');
  });

  it('ignores a colour that is not one', () => {
    expect(runsOf('[x]{color=ultraviolet}')[0].color).toBeUndefined();
  });

  /** A size typo must not produce a document with one letter per page. */
  it('clamps an absurd size instead of setting it', () => {
    expect(runsOf('[x]{size=4000}')[0].size).toBe(200);
    expect(runsOf('[x]{size=0.1}')[0].size).toBe(4);
  });

  /** THE REGRESSION THAT MATTERS: `[text](url)` is still a link, not a span. */
  it('leaves real links alone', () => {
    const [run] = runsOf('[dashboard](https://x.test)');
    expect(run).toMatchObject({ text: 'dashboard', link: 'https://x.test' });
  });

  /** A LINK that is also styled — and, before this, braces printed in the prose. */
  it('styles a link without leaving the braces in the text', () => {
    const [run] = runsOf('[big red](https://x.test){color=red size=18}');
    expect(run).toMatchObject({
      text: 'big red', link: 'https://x.test', color: '#cc0000', size: 18,
    });
  });

  it('does not weld two runs that differ only in colour', () => {
    const runs = runsOf('[a]{color=red}[b]{color=blue}');
    expect(runs.map((r) => r.color)).toEqual(['#cc0000', '#1a56db']);
  });

  it('leaves the markers as characters when they are not a pair', () => {
    expect(runsOf('2 + 2 == 4 and x++ is a language').map((r) => r.text).join(''))
      .toBe('2 + 2 == 4 and x++ is a language');
  });
});

/**
 * HTML ENTITIES. `&nbsp;` printed as six characters on a real certificate —
 * markdown decodes these on its way to HTML, and this pipeline never goes
 * through HTML, so nothing had ever decoded them.
 */
describe('entities', () => {
  const textOf = (md: string) =>
    (parseMarkdown(md)[0] as any).runs.map((r: any) => r.text).join('');

  it('decodes the named ones people actually type', () => {
    expect(textOf('Tom &amp; Jerry &mdash; &pound;5 &copy; 2026'))
      .toBe('Tom & Jerry \u2014 \u00a35 \u00a9 2026');
  });

  it('decodes numeric and hex references, including the rupee', () => {
    expect(textOf('&#8377;1,200 and &#x20B9;95')).toBe('\u20b91,200 and \u20b995');
  });

  it('leaves a non-entity ampersand exactly as typed', () => {
    expect(textOf('R&D spend & margin')).toBe('R&D spend & margin');
  });

  it('leaves nonsense alone rather than printing a replacement box', () => {
    expect(textOf('&notareal; &#999999999;')).toBe('&notareal; &#999999999;');
  });

  /** CommonMark's rule: a snippet showing `&amp;` means to show `&amp;`. */
  it('does not decode inside a code span', () => {
    const runs = (parseMarkdown('use `&amp;` in xml')[0] as any).runs;
    expect(runs.find((r: any) => r.code).text).toBe('&amp;');
  });
});

describe('deliberate vertical space', () => {
  it('reads <!-- space: 48 --> as a measured gap', () => {
    const out = parseMarkdown(['Sincerely,', '', '<!-- space: 48 -->', '', 'A. Signatory'].join('\n'));
    expect(out.map((b) => b.kind)).toEqual(['para', 'space', 'para']);
    expect(out[1]).toMatchObject({ points: 48 });
  });

  it('caps it at a page, because more than that is a page break', () => {
    expect(parseMarkdown('<!-- space: 999 -->')[0]).toMatchObject({ kind: 'space', points: 700 });
  });

  it('is not confused with the other directives', () => {
    const out = parseMarkdown(['<!-- space: 20 -->', '<!-- pagebreak -->'].join('\n\n'));
    expect(out.map((b) => b.kind)).toEqual(['space', 'pagebreak']);
  });
});
