/**
 * The page model both painters read.
 *
 * The card and the focus overlay render the same script two ways — a thumbnail
 * in px and a page in inches — and they must never disagree about what it SAYS.
 * The margin marks are the reason: they are the whole point of looking at the
 * page while working, and a mark that appears in one view and not the other is
 * worse than no mark at all.
 */
import { describe, expect, it } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { writeScript } from './screenplay-doc';
import { pageModel } from './screenplay-lines';
import { screenplayView, shotsByScene } from './screenplay-view';
import { createShots, setShotFields } from './shots';

const SCRIPT = `Title: The leak

# ACT ONE

## SEQUENCE 1 — the demo
= Make them believe it.

INT. BOARDROOM — DAY

Six people around a table. A laptop open.

FOUNDER
Watch this.

CUT TO:

INT. CORRIDOR — LATER

She walks fast.
`;

function board() {
  const b = makeTestBoard();
  writeScript(b.std, b.surfaceId, SCRIPT);
  return b;
}

describe('screenplayView', () => {
  it('reads the title and describes every line of the source', () => {
    const b = board();
    const v = screenplayView(b.std);
    expect(v.script.title).toBe('The leak');
    // One entry per SOURCE line, in order — the editor formats line N from
    // entry N, so a count that drifted would indent the wrong lines.
    const page = pageModel(v.text);
    expect(page.lines).toHaveLength(v.text.split(String.fromCharCode(10)).length);
  });

  it('marks scene headings and nothing else', () => {
    const page = pageModel(screenplayView(board().std).text);
    const marked = page.lines.filter(l => l.mark !== undefined);
    expect(marked).toHaveLength(2);
    expect(marked.every(l => l.type === 'scene_heading')).toBe(true);
    // No shots yet, so both read as uncovered.
    expect(marked.every(l => l.mark === '—' && !l.covered)).toBe(true);
  });

  /** The mark IS the coverage — verified from the shots, never asserted. */
  it('counts the shots covering each scene', () => {
    const b = board();
    const key = screenplayView(b.std).script.scenes[0].key;
    const [a, c] = createShots(b.std, b.surfaceId, ['wide', 'closer']);
    setShotFields(b.std, a, { sceneKey: key } as never);
    setShotFields(b.std, c, { sceneKey: key } as never);

    const shots = shotsByScene(b.std);
    const page = pageModel(screenplayView(b.std).text, k => shots.get(k) ?? 0);
    const marked = page.lines.filter(l => l.mark !== undefined);
    expect(marked[0].mark).toBe('2');
    expect(marked[0].covered).toBe(true);
    // The second scene still has none.
    expect(marked[1].mark).toBe('—');
    expect(screenplayView(b.std).stat).toContain('1/2 scenes covered');
  });

  it('reports an empty script as empty rather than as a blank page', () => {
    const b = makeTestBoard();
    const v = screenplayView(b.std);
    expect(v.script.empty).toBe(true);
    expect(v.stat).toBe('');
    expect(pageModel(v.text).pages).toBe(0);
  });
});
