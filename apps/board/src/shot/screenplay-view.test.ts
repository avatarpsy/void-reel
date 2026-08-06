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
import { rowClass, screenplayView } from './screenplay-view';
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
  it('reads the title and every element in source order', () => {
    const v = screenplayView(board().std);
    expect(v.script.title).toBe('The leak');
    expect(v.rows.length).toBeGreaterThan(0);
    // Source line indices must be strictly increasing, or a click on the page
    // maps back to the wrong place in the text.
    const lines = v.rows.map(r => r.line);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
  });

  it('marks scene headings and nothing else', () => {
    const v = screenplayView(board().std);
    const marked = v.rows.filter(r => r.mark !== null);
    expect(marked).toHaveLength(2);
    expect(marked.every(r => r.type === 'scene_heading')).toBe(true);
    // No shots yet, so both read as uncovered.
    expect(marked.every(r => r.mark === '—' && !r.covered)).toBe(true);
  });

  /** The mark IS the coverage — verified from the shots, never asserted. */
  it('counts the shots covering each scene', () => {
    const b = board();
    const key = screenplayView(b.std).script.scenes[0].key;
    const [a, c] = createShots(b.std, b.surfaceId, ['wide', 'closer']);
    setShotFields(b.std, a, { sceneKey: key } as never);
    setShotFields(b.std, c, { sceneKey: key } as never);

    const v = screenplayView(b.std);
    const marked = v.rows.filter(r => r.mark !== null);
    expect(marked[0].mark).toBe('2');
    expect(marked[0].covered).toBe(true);
    // The second scene still has none.
    expect(marked[1].mark).toBe('—');
    expect(v.stat).toContain('1/2 scenes covered');
  });

  it('reports an empty script as empty rather than as a blank page', () => {
    const b = makeTestBoard();
    const v = screenplayView(b.std);
    expect(v.script.empty).toBe(true);
    expect(v.stat).toBe('');
  });

  /**
   * Both painters key their styling off this string, so a change here changes
   * the card and the printed PDF together — which is the point of sharing it.
   */
  it('builds the class list the painters style from', () => {
    const v = screenplayView(board().std);
    const heading = v.rows.find(r => r.type === 'scene_heading')!;
    const action = v.rows.find(r => r.type === 'action')!;
    expect(rowClass(heading)).toBe('el-scene_heading marker');
    expect(rowClass(action)).toBe('el-action');
  });
});
