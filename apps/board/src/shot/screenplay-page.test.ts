/**
 * The screenplay page — one editor, one stylesheet, one layout.
 *
 * Reading and writing used to be two renderings (a formatted page and a
 * textarea of raw Fountain), and neither measured quite like the PDF. What
 * is held to account here:
 *
 *   THE GAPS are the source's blank lines, plus one before a scene — on screen
 *   and in the PDF alike. The PDF used to ADD spacing per element on top of
 *   the source's own blank lines, printing three blank lines before a scene
 *   and two before every cue.
 *
 *   THE INDENTS on screen are the PDF's inches, written in em. The stylesheet
 *   is read and compared, number by number, against the typesetter.
 *
 *   THE PAGE BREAKS the editor draws are where the PDF turns the page, because
 *   both ask `layoutScreenplay`.
 *
 *   THE EDITOR formats each line as the element it is, and hides Fountain's
 *   syntax except on the caret's line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { layoutScreenplay, SCREENPLAY_INCHES, WRAP } from '../document/screenplay-pdf';
import { parseFountain } from './fountain';
import { createScreenplayEditor } from './screenplay-editor';
import { pageModel } from './screenplay-lines';

const NL = String.fromCharCode(10);
const lines = (...l: string[]) => l.join(NL);

/** Rows of blank space between two consecutive printed rows on page 1. */
function gapBefore(source: string, text: string): number {
  const s = parseFountain(source);
  const rows = layoutScreenplay(s.elements, { title: s.title, credit: s.credit }).pages[0]!.rows;
  const at = rows.findIndex((r) => r.text.startsWith(text));
  return rows[at]!.row - rows[at - 1]!.row - 1;
}

describe('the gaps are the source’s', () => {
  it('sets one blank line before a character cue, not two', () => {
    expect(gapBefore(lines('She waits.', '', 'SOFIA', 'Hello.'), 'SOFIA')).toBe(1);
  });

  it('sets one blank line between action paragraphs', () => {
    expect(gapBefore(lines('She waits.', '', 'He leaves.'), 'He leaves.')).toBe(1);
  });

  it('sets dialogue directly under its cue', () => {
    expect(gapBefore(lines('She waits.', '', 'SOFIA', 'Hello.'), 'Hello.')).toBe(0);
  });

  it('sets two blank lines before a scene heading, not three', () => {
    expect(gapBefore(lines('She waits.', '', 'INT. HALL - DAY', '', 'Quiet.'), 'INT. HALL')).toBe(2);
  });

  it('leaves no hole where a sequence heading and synopsis sat', () => {
    // They do not print, and the blank line around them goes with them.
    const src = lines('She waits.', '', '## SEQUENCE 2', '= The turn.', '', 'INT. HALL - DAY', '', 'Quiet.');
    expect(gapBefore(src, 'INT. HALL')).toBe(2);
  });
});

describe('where the pages break', () => {
  const LONG = Array.from({ length: 60 }, (_, i) => `Beat ${i + 1} of the long scene.`).join(NL + NL);

  it('breaks where the paper runs out, and tells the editor which line starts page 2', () => {
    const model = pageModel(lines('INT. HALL - DAY', '', LONG));
    expect(model.pages).toBeGreaterThan(1);
    const start = model.lines.findIndex((l) => l.pageStart === 2);
    expect(start).toBeGreaterThan(0);
    // It sits straight after the last line PRINTED on page 1, and everything
    // from there to page 2's first printed line is blank — the break is where
    // the PDF turns the page, with nothing printed between.
    const s = parseFountain(lines('INT. HALL - DAY', '', LONG));
    const laid = layoutScreenplay(s.elements).pages;
    const lastOnPage1 = laid[0]!.rows[laid[0]!.rows.length - 1]!.line!;
    const firstOnPage2 = laid[1]!.rows[0]!.line!;
    expect(start).toBe(lastOnPage1 + 1);
    for (let i = start; i < firstOnPage2; i++) expect(model.lines[i]!.type).toBe('blank');
  });

  it('keeps a sequence heading with the scene it leads into, not the page before', () => {
    const model = pageModel(lines(
      'Title: The Leak', '', '## SEQUENCE 1', '= The setup.', '', 'INT. HALL - DAY', '', 'Quiet.',
    ));
    // The break follows the title page directly, so the sequence heading is
    // on page 1 with its scene — above it, it read as part of the title page.
    expect(model.lines[1]!.pageStart).toBe(1);
  });

  it('never leaves a scene heading as the last thing on a page', () => {
    const scenes = Array.from({ length: 30 }, (_, i) =>
      lines(`INT. ROOM ${i + 1} - DAY`, '', 'Something happens here.', '', 'And again.')).join(NL + NL);
    const s = parseFountain(scenes);
    for (const page of layoutScreenplay(s.elements).pages) {
      const last = page.rows[page.rows.length - 1]!;
      expect(last.bold).toBe(false);
    }
  });

  it('never parts a character cue from its first line', () => {
    const talk = Array.from({ length: 40 }, (_, i) =>
      lines(`Beat ${i + 1}.`, '', 'SOFIA', 'I said it.')).join(NL + NL);
    const s = parseFountain(talk);
    const cueX = SCREENPLAY_INCHES.character * 72;
    for (const page of layoutScreenplay(s.elements).pages) {
      const last = page.rows[page.rows.length - 1]!;
      expect(last.x).not.toBe(cueX);
    }
  });

  it('marks the title page’s end when there is one', () => {
    const model = pageModel(lines('Title: The Leak', '', 'INT. HALL - DAY', '', 'Quiet.'));
    expect(model.lines.some((l) => l.pageStart === 1)).toBe(true);
    // And not when there is none — page 1 is simply the top of the sheet.
    expect(pageModel(lines('INT. HALL - DAY', '', 'Quiet.')).lines.some((l) => l.pageStart === 1)).toBe(false);
  });
});

describe('the stylesheet is the PDF’s geometry', () => {
  /**
   * An inch is 6em at 12pt Courier, and a character is 0.6em. Read the real
   * stylesheet and hold every indent to the typesetter's own numbers — this
   * is the check that "the screen matches the paper" is a fact, not a hope.
   */
  const css = readFileSync(join(__dirname, '..', 'theme', 'screenplay-page.css'), 'utf8');
  const rule = (selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', at));
  };
  const em = (inches: number) => `${+(inches * 6).toFixed(2)}em`;
  const TEXT_EMS = 60 * 0.6;
  const { left, right, top, bottom, character, parenthetical, dialogue } = SCREENPLAY_INCHES;

  it('sets the page margins', () => {
    expect(rule('.sp-sheet .cm-editor .cm-content'))
      .toContain(`padding: ${em(top)} ${em(right)} ${em(bottom)} ${em(left)}`);
  });

  it('indents the character cue to 3.7in', () => {
    expect(rule('.sp-sheet .cm-line.sp-character')).toContain(`padding-left: ${em(character - left)}`);
  });

  it('indents a parenthetical to 3.1in, 28 characters wide', () => {
    const inset = (parenthetical - left) * 6;
    const after = TEXT_EMS - inset - WRAP.parenthetical * 0.6;
    // Symmetric — which is why the stylesheet can say it with one value.
    expect(after).toBeCloseTo(inset);
    expect(rule('.sp-sheet .cm-line.sp-parenthetical')).toContain(`padding: 0 ${+inset.toFixed(2)}em`);
  });

  it('sets dialogue from 2.5in, 35 characters wide', () => {
    const inset = (dialogue - left) * 6;
    const after = TEXT_EMS - inset - WRAP.dialogue * 0.6;
    expect(rule('.sp-sheet .cm-line.sp-dialogue'))
      .toContain(`padding: 0 ${+after.toFixed(2)}em 0 ${+inset.toFixed(2)}em`);
  });

  it('centres on the PAGE, not on the text, as the PDF does', () => {
    // The text sits (left - right)/2 inches right of the page's middle; the
    // right padding that pulls it back is twice that.
    // The first `.sp-title_field {` is the rule it shares with `.sp-centered`.
    expect(rule('.sp-sheet .cm-line.sp-title_field')).toContain(`padding-right: ${em(left - right)}`);
  });
});

describe('the line model', () => {
  it('keeps line numbers true past a boneyard that spans lines', () => {
    // The notes are stripped, but their line breaks stay — or every line
    // after them would be formatted as the line three above it.
    const src = lines('/* cut', 'all of it', '*/', '', 'INT. HALL - DAY');
    const model = pageModel(src);
    expect(model.lines[4]!.type).toBe('scene_heading');
    expect(model.hidden).toHaveLength(1);
  });

  it('finds the syntax to hide on every kind of line that has some', () => {
    const model = pageModel(lines(
      'Title: The Leak', '', '## SEQUENCE 1', '= The setup.', '', '.FORCED HEADING', '',
      '@mcKenzie', 'Hi.', '', '> THE END <',
    ));
    const at = (i: number) => model.lines[i]!.syntax;
    expect(at(0)).toEqual([[0, 7]]);        // 'Title: '
    expect(at(2)).toEqual([[0, 3]]);        // '## '
    expect(at(3)).toEqual([[0, 2]]);        // '= '
    expect(at(5)).toEqual([[0, 1]]);        // '.'
    expect(at(7)).toEqual([[0, 1]]);        // '@'
    expect(at(10)).toEqual([[0, 2], [9, 11]]); // '> ' and ' <'
  });
});

describe('the editor', () => {
  const SCRIPT = lines(
    'Title: The Leak', '', 'INT. HALL - DAY', '', 'She waits.', '', 'SOFIA', '(quietly)', 'Hello.', '', 'CUT TO:',
  );

  function mount(text = SCRIPT, editable = false) {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = createScreenplayEditor(host, { text, editable });
    const classOf = (n: number) => host.querySelectorAll('.cm-line')[n]?.className ?? '';
    return { host, editor, classOf };
  }

  it('formats every line as the element it is', () => {
    const { classOf, editor } = mount();
    expect(classOf(0)).toContain('sp-title_field');
    expect(classOf(2)).toContain('sp-scene_heading');
    expect(classOf(4)).toContain('sp-action');
    expect(classOf(6)).toContain('sp-character');
    expect(classOf(7)).toContain('sp-parenthetical');
    expect(classOf(8)).toContain('sp-dialogue');
    expect(classOf(10)).toContain('sp-transition');
    editor.destroy();
  });

  it('hides the syntax while reading', () => {
    const { host, editor } = mount();
    const first = host.querySelector('.cm-line')!;
    expect(first.textContent).toBe('The Leak');
    editor.destroy();
  });

  it('reformats a line the moment it becomes something else', () => {
    const { host, editor, classOf } = mount(lines('She waits.', '', 'x'), true);
    // Typing a slugline over the last line turns it into a scene heading.
    const doc = editor.view.state.doc;
    editor.view.dispatch({ changes: { from: doc.line(3).from, to: doc.length, insert: 'INT. KITCHEN - NIGHT' } });
    expect(classOf(2)).toContain('sp-scene_heading');
    expect(host.querySelectorAll('.cm-line')[2]!.getAttribute('data-mark')).toBe('—');
    editor.destroy();
  });

  it('takes an outside rewrite without losing the text around it', () => {
    const { editor } = mount();
    editor.setText(SCRIPT.replace('She waits.', 'She runs.'));
    expect(editor.text()).toContain('She runs.');
    expect(editor.text()).toContain('CUT TO:');
    editor.destroy();
  });

  it('shows coverage in the margin mark as shots arrive', () => {
    const { host, editor } = mount();
    const heading = () => host.querySelectorAll('.cm-line')[2]!;
    expect(heading().getAttribute('data-mark')).toBe('—');
    const key = parseFountain(SCRIPT).scenes[0]!.key;
    editor.setCoverage(new Map([[key, 3]]));
    expect(heading().getAttribute('data-mark')).toBe('3');
    expect(heading().getAttribute('data-covered')).toBe('yes');
    editor.destroy();
  });
});
