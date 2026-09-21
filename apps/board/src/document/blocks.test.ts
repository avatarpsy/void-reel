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
