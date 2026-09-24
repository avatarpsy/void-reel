/**
 * The screenplay as a SHEET — the same object as a document on the canvas.
 *
 * The card lost its header strip (name, coverage count, Focus, Edit) and
 * became a plain page with a tag on its corner, like a document. Two things
 * that strip carried had to go somewhere, and a third thing was found wrong
 * while looking at it:
 *
 *   THE COVERAGE COUNT rides on the tag now.
 *   OPENING IT full size is the board bar's job, as for a document (browser).
 *   THE TITLE PAGE was drawn as its own source — `Title: …` lines — on the
 *   card and in focus, and the PDF, which already set a proper title page
 *   from those fields, printed them AGAIN at the top of page two.
 */
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { tagFor } from '../document/tags';
import { renderScreenplayPdf } from '../document/screenplay-pdf';
import { parseFountain } from './fountain';
import { screenplayBlock, writeScript } from './screenplay-doc';
import { pageModel } from './screenplay-lines';
import { screenplayView } from './screenplay-view';
import { createShots, setShotFields } from './shots';

const NL = String.fromCharCode(10);
const SCRIPT = [
  'Title: Sofia Storyboard',
  'Credit: Written for Sofia',
  'Draft date: 24 September 2026',
  'Contact: studio@example.com',
  '',
  "INT. SOFIA'S ROOM - MORNING",
  '',
  'Sofia sits close to the lens.',
  '',
  'EXT. SATHYA STREET - DAY',
  '',
  'A bright street in motion.',
].join(NL);

describe('the title page is a title page', () => {
  it('parses the fields as fields, not as action', () => {
    const s = parseFountain(SCRIPT);
    const fields = s.elements.filter((e) => e.type === 'title_field');
    expect(fields.map((f) => [f.key, f.value])).toEqual([
      ['title', 'Sofia Storyboard'],
      ['credit', 'Written for Sofia'],
      ['draft date', '24 September 2026'],
      ['contact', 'studio@example.com'],
    ]);
    // None of them is action any more — that is what printed them twice.
    expect(s.elements.some((e) => e.type === 'action' && /^Title:/.test(e.text))).toBe(false);
  });

  it('keeps the source line as the text, so nothing joining it back loses a name', () => {
    const [first] = parseFountain(SCRIPT).elements;
    expect(first).toMatchObject({ type: 'title_field', text: 'Title: Sofia Storyboard' });
  });

  it('still reads the title and credit the rest of the app uses', () => {
    const s = parseFountain(SCRIPT);
    expect(s.title).toBe('Sofia Storyboard');
    expect(s.credit).toBe('Written for Sofia');
  });

  it('tells the page which field each line is, and which characters are the key', () => {
    const [title] = pageModel(SCRIPT).lines;
    expect(title).toMatchObject({ type: 'title_field', key: 'title' });
    // 'Title: ' is syntax: hidden on the page, shown faintly on the caret's line.
    expect(title!.syntax).toEqual([[0, 'Title: '.length]]);
  });
});

describe('what the PDF prints', () => {
  /**
   * Standard Courier is not subsetted, so pdf-lib writes the text as hex
   * strings that decode straight back to what was set — unlike the document
   * exporter's embedded fonts, this one CAN be read, page by page.
   */
  async function pages(source: string): Promise<string[]> {
    const s = parseFountain(source);
    const { blob } = await renderScreenplayPdf(s.elements, { title: s.title, credit: s.credit });
    const buf = Buffer.from(new Uint8Array(await blob.arrayBuffer()));
    const raw = buf.toString('latin1');
    const out: string[] = [];
    let i = 0;
    for (;;) {
      const a = raw.indexOf('stream', i);
      if (a < 0) break;
      let at = a + 6;
      if (buf[at] === 13) at++;
      if (buf[at] === 10) at++;
      const e = raw.indexOf('endstream', at);
      if (e < 0) break;
      try {
        const body = inflateSync(buf.subarray(at, e)).toString('latin1');
        const texts = [...body.matchAll(/<([0-9A-Fa-f]+)> Tj/g)]
          .map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'));
        if (texts.length) out.push(texts.join(' | '));
      } catch { /* not a deflated stream */ }
      i = e + 9;
    }
    return out;
  }

  it('does not print the title fields again at the top of page two', async () => {
    const [titlePage, first] = await pages(SCRIPT);
    expect(titlePage).toContain('SOFIA STORYBOARD');
    // Measured before the fix: page two opened "Title: Sofia Storyboard |
    // Credit: Written for Sofia | Draft date: …".
    expect(first).not.toMatch(/Title:|Credit:|Draft date:|Contact:/);
    expect(first!.startsWith("INT. SOFIA'S ROOM")).toBe(true);
  });

  it('puts the draft date and contact on the title page, where scripts carry them', async () => {
    const [titlePage] = await pages(SCRIPT);
    expect(titlePage).toContain('24 September 2026');
    expect(titlePage).toContain('studio@example.com');
  });

  it('keeps a draft date when there is no title page to put it on', async () => {
    // No `Title:`, so no title page — the date must not simply vanish.
    const all = (await pages(['Draft date: 1 May', '', 'INT. HALL - DAY', '', 'Quiet.'].join(NL))).join(' ');
    expect(all).toContain('1 May');
  });
});

describe('the tag carries the coverage the header used to', () => {
  it('says how many scenes have shots', () => {
    const b = makeTestBoard();
    writeScript(b.std, b.surfaceId, SCRIPT);
    const id = screenplayBlock(b.std)!.id;
    expect(tagFor(b as any, id, false)).toBe('SCREENPLAY · 0/2 COVERED');

    const key = screenplayView(b.std).script.scenes[0]!.key;
    const [shot] = createShots(b.std, b.surfaceId, ['wide']);
    setShotFields(b.std, shot!, { sceneKey: key } as never);
    expect(tagFor(b as any, id, false)).toBe('SCREENPLAY · 1/2 COVERED');
  });

  it('is just SCREENPLAY while there are no scenes to count', () => {
    const b = makeTestBoard();
    writeScript(b.std, b.surfaceId, 'Title: Only a title');
    expect(tagFor(b as any, screenplayBlock(b.std)!.id, false)).toBe('SCREENPLAY');
  });
});
