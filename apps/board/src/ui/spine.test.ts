/**
 * THE SPINE'S LABELS MUST NOT PRINT THROUGH EACH OTHER.
 *
 * Reported from a real board: "sc 1 / INT. SOFIA'S ROOM — NIGHT" with "no shots
 * yet" struck straight across it, on every scene of a fresh script.
 *
 * The cause was a character budget standing in for a width. The heading was
 * trimmed at 34 CHARACTERS into a column of 128 PIXELS (`GUTTER 360 − SCENE_X
 * 232`), and 34 characters of the 19px label face is about 320px — so the trim
 * could never fit, every slugline ran past `GUTTER`, and `no shots yet` is drawn
 * at `GUTTER` on a baseline eleven pixels away.
 *
 * These tests are about WIDTHS, not characters, because that is the mistake.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeTestBoard } from '../blocksuite/test-board';
import { writeScript } from '../shot/screenplay-doc';
import { installSpine, trimToWidth } from './spine';

/** A stand-in font: every glyph one unit wide, so the arithmetic is visible. */
const unit = (s: string) => s.length;

/** Something closer to the real face — capitals and punctuation are wide. */
const proportional = (s: string) =>
  [...s].reduce((w, ch) => w + (/[A-Z0-9—.]/.test(ch) ? 12 : /[il.'’ ]/.test(ch) ? 4 : 9), 0);

describe('trimToWidth', () => {
  it('leaves text that already fits completely alone', () => {
    expect(trimToWidth('INT. KITCHEN', 100, unit)).toBe('INT. KITCHEN');
    // No ellipsis is added at the boundary, because nothing was cut.
    expect(trimToWidth('exactly-ten', 11, unit)).toBe('exactly-ten');
  });

  it('cuts to the WIDTH, and the result really fits', () => {
    const out = trimToWidth("INT. SOFIA'S ROOM — NIGHT", 10, unit);
    expect(out.endsWith('…')).toBe(true);
    expect(unit(out)).toBeLessThanOrEqual(10);
  });

  it('fits a proportional face, where a character count cannot', () => {
    // The reported slugline against the real 128px column. A 34-character budget
    // would have let all 25 characters through at ~260px; a width budget cannot.
    const heading = "INT. SOFIA'S ROOM — NIGHT";
    const out = trimToWidth(heading, 128, proportional);
    expect(proportional(out)).toBeLessThanOrEqual(128);
    expect(out.length).toBeLessThan(heading.length);
  });

  it('never returns a bare ellipsis when nothing can fit', () => {
    // "…" alone reads as a rendering fault rather than as a truncation.
    expect(trimToWidth('INT. KITCHEN', 1, unit)).toBe('');
    expect(trimToWidth('INT. KITCHEN', 0, unit)).toBe('');
    expect(trimToWidth('INT. KITCHEN', -50, unit)).toBe('');
  });

  it('does not leave a dangling space before the ellipsis', () => {
    expect(trimToWidth('INT. KITCHEN SINK', 7, unit)).not.toContain(' …');
  });

  it('is monotonic — more room never gives less text', () => {
    const heading = 'EXT. SATHYA MORNING MARKET — DAY';
    let last = -1;
    for (let w = 4; w <= 400; w += 7) {
      const len = trimToWidth(heading, w, proportional).length;
      expect(len).toBeGreaterThanOrEqual(last);
      last = len;
    }
    expect(trimToWidth(heading, 400, proportional)).toBe(heading);
  });
});

/**
 * The measuring fallback needs the font size, and the font size lives in CSS.
 * Two declarations of one number drift; this is the guard that says so.
 */
describe('the label sizes the spine measures with', () => {
  const css = readFileSync(
    join(__dirname, '..', 'theme', 'voidspace.css'),
    'utf8',
  );

  const sizeOf = (selector: string): number => {
    const block = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    return Number(/font-size:\s*(\d+)px/.exec(block)?.[1]);
  };

  it('matches the stylesheet', () => {
    // Mirrored in `spine.ts` as SCENE_H_SIZE / SCENE_N_SIZE.
    expect(sizeOf('.vs-spine__scene-h')).toBe(19);
    expect(sizeOf('.vs-spine__scene-n')).toBe(24);
  });
});

/**
 * THE WHOLE DRAWING, checked for collisions — the report, reproduced.
 *
 * The script is the one from the screenshot: a sequence, three scenes, no shots
 * on any of them. Every label was drawn and then measured; before the fix the
 * heading and "no shots yet" intersected on all three rows.
 */
describe('the spine on the reported board', () => {
  /** Class → font size, matching `voidspace.css`. */
  const SIZE: Record<string, number> = {
    'vs-spine__label--act': 46,
    'vs-spine__label--seq': 30,
    'vs-spine__scene-n': 24,
    'vs-spine__scene-h': 19,
    'vs-spine__empty': 22,
  };

  const SCRIPT = [
    'Title: Sofia - Small Moments',
    '',
    '## SEQUENCE 1 — THE MOMENT',
    '= Twenty seconds, vertical.',
    '',
    "INT. SOFIA'S ROOM — NIGHT",
    'Half-lit.',
    '',
    'EXT. SATHYA MORNING MARKET — DAY',
    'Warm morning light.',
    '',
    "INT. SOFIA'S ROOM — CONTINUOUS",
    'Back in the dim warmth.',
  ].join('\n');

  /**
   * A label's ink box. `y` is the BASELINE, so the glyphs sit above it.
   *
   * A GLYPH BOX IS TALLER THAN ITS FONT SIZE, and the first version of this test
   * assumed it was not — so it passed while `sc 1` and the heading really did
   * overlap by two pixels, which only a real browser saw. Measured with `getBBox`
   * in Chromium: a 24px label draws a 29px box and a 19px one a 23px box, both
   * about 1.22×, because the box carries the face's full ascent and descent
   * whether the string uses them or not. The top sits a full font-size above the
   * baseline and the descent hangs below it.
   */
  const ASCENT = 1.0;
  const BOX_H = 1.22;

  function boxOf(node: Element) {
    const cls = (node.getAttribute('class') ?? '').split(/\s+/).find(c => c in SIZE) ?? '';
    const size = SIZE[cls] ?? 20;
    const x = Number(node.getAttribute('x'));
    const y = Number(node.getAttribute('y'));
    // The same estimate the spine falls back to when there are no text metrics,
    // which is what this environment has.
    const w = (node.textContent ?? '').length * size * 0.55;
    return {
      x, y: y - size * ASCENT, w, h: size * BOX_H, text: node.textContent ?? '',
    };
  }

  const hit = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  it('draws no two labels on top of each other', () => {
    const board = makeTestBoard();
    writeScript(board.std, board.surfaceId, SCRIPT);
    const host = document.createElement('div');
    document.body.append(host);
    const dispose = installSpine(board as never, host);

    const boxes = [...host.querySelectorAll('text')].map(boxOf);
    expect(boxes.length).toBeGreaterThanOrEqual(10);

    const clashes: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (hit(boxes[i], boxes[j])) clashes.push(`"${boxes[i].text}" × "${boxes[j].text}"`);
      }
    }
    expect(clashes).toEqual([]);

    dispose();
    host.remove();
  });
});
