/**
 * A CONTROL THAT SAYS IT IS HIDDEN MUST BE HIDDEN.
 *
 * The board's chrome hides things with the `hidden` ATTRIBUTE, which works only
 * because of a UA rule — `[hidden] { display: none }` — that any class rule
 * setting `display` outranks. Every control in the top bar carries
 * `.vs-board-btn { display: inline-flex }`, so `hidden` on one of them did
 * nothing at all.
 *
 * That is not hypothetical. "Send to editor" is set `hidden` on a board with no
 * shots, and it sat on screen anyway, offering to compile a storyboard that did
 * not exist. The same trap had already been found twice in this file — the
 * running total and the selection hint each carry their own `[hidden]` rule
 * with a comment about it — and was missed a third time.
 *
 * A test rather than a fourth comment: this is a property of the STYLESHEET,
 * which no unit test of the DOM would ever look at, and the failure is
 * invisible in review because the markup is correct.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const CSS = readFileSync(join(__dirname, '../theme/voidspace.css'), 'utf8');

/** Classes the chrome hides with the `hidden` attribute, and therefore classes
 *  whose `display` must be beatable by it. */
const HIDDEN_BY_ATTRIBUTE = [
  'vs-board-btn',    // "Send to editor" — hidden until a shot exists
  'vs-board-sel',    // the selection hint
  'vs-board-total',  // the running cost
];

/** Strip comments so a rule quoted inside one does not count as a rule. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

describe('hiding a control with the hidden attribute', () => {
  for (const cls of HIDDEN_BY_ATTRIBUTE) {
    it(`.${cls} is actually hidden by [hidden]`, () => {
      const setsDisplay = new RegExp(`\\.${cls}\\s*\\{[^}]*display\\s*:`).test(RULES);
      const hasGuard = new RegExp(`\\.${cls}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`).test(RULES);
      // Only a class that sets `display` needs the guard — but every one of
      // these does, which is exactly why the trap keeps being sprung.
      expect(setsDisplay, `.${cls} no longer sets display — update this list`).toBe(true);
      expect(hasGuard, `.${cls} sets display, so [hidden] does nothing without an explicit rule`)
        .toBe(true);
    });
  }
});

describe('the top bar', () => {
  const UI = readFileSync(join(__dirname, 'board-ui.ts'), 'utf8');

  it('has no Add shot button — a shot is not the board default act', () => {
    expect(UI).not.toMatch(/data-act="add"/);
  });

  it('still offers a first shot from the empty state', () => {
    // Removing the toolbar button must not remove the only hand-operated way
    // to start a storyboard.
    expect(UI).toMatch(/data-act="first-shot"/);
    expect(UI).toMatch(/case 'first-shot'/);
  });

  it('ships the send button hidden, so an empty board offers no compile', () => {
    expect(UI).toMatch(/data-act="send" hidden/);
  });
});
