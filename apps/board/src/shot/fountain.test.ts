/**
 * The Fountain parser, and the resolution layer built on it.
 *
 * These pin the two properties the whole feature rests on:
 *   • a scene's KEY survives edits elsewhere in the document
 *   • coverage is read from the board, never asserted
 *
 * Everything else — how a slugline is spelled, where dialogue indents — is
 * cosmetic by comparison. Those two are what stop a storyboard silently
 * detaching from the script it was built for.
 */
import { describe, expect, it } from 'vitest';

import { findScene, offsetOfLine, outline, parseFountain, sceneText, sequenceOf } from './fountain';
import { coverage, nextScene, renderScene, renderScriptContext } from './resolution';

const SCRIPT = `Title: Why most AI demos fail
Credit: Written by Nihar

# ACT ONE

## SEQUENCE 1 — The perfect demo
= Make them believe it, so the fall costs something.

INT. BOARDROOM — DAY

Six people around a table. A laptop open. The founder types.

                    FOUNDER
          Watch this.

The screen fills. Flawless. At the back, one person does not smile.

CUT TO:

## SEQUENCE 2 — The first real user

INT. USER DESK — NIGHT
= Where it stops being a demo.

A tired person types something the demo never saw.

                    USER
          (muttering)
          That's not what I asked for.

.SCREEN RECORDING

The error, full frame. Red on white.
`;

describe('parseFountain', () => {
  const s = parseFountain(SCRIPT);

  it('reads the title page', () => {
    expect(s.title).toBe('Why most AI demos fail');
    expect(s.credit).toBe('Written by Nihar');
  });

  it('reads acts and sequences from sections, with their synopses', () => {
    expect(s.acts.map(a => a.title)).toEqual(['ACT ONE']);
    expect(s.sequences.map(q => q.title)).toEqual([
      'SEQUENCE 1 — The perfect demo',
      'SEQUENCE 2 — The first real user',
    ]);
    expect(s.sequences[0].synopsis).toEqual(['Make them believe it, so the fall costs something.']);
  });

  it('reads sluglines as scenes, including a forced one', () => {
    expect(s.scenes.map(c => c.heading)).toEqual([
      'INT. BOARDROOM — DAY',
      'INT. USER DESK — NIGHT',
      'SCREEN RECORDING',
    ]);
    expect(s.scenes.map(c => c.n)).toEqual([1, 2, 3]);
  });

  it('attaches each scene to the sequence it sits under', () => {
    expect(sequenceOf(s, s.scenes[0])?.title).toContain('SEQUENCE 1');
    expect(sequenceOf(s, s.scenes[2])?.title).toContain('SEQUENCE 2');
  });

  it('attaches a synopsis written under a slugline to that scene', () => {
    expect(s.scenes[1].synopsis).toEqual(['Where it stops being a demo.']);
  });

  it('classifies dialogue, parentheticals and transitions', () => {
    const types = new Map(s.elements.filter(e => e.text).map(e => [e.text, e.type] as const));
    expect(types.get('FOUNDER')).toBe('character');
    expect(types.get('Watch this.')).toBe('dialogue');
    expect(types.get('(muttering)')).toBe('parenthetical');
    expect(types.get('CUT TO:')).toBe('transition');
  });

  /** Shouted action is not a character cue. This is the classic mis-parse. */
  it('does not read uppercase action as a character', () => {
    const s2 = parseFountain('INT. HALL — DAY\n\nTHE DOOR SLAMS.\n\nHe turns.\n');
    const el = s2.elements.find(e => e.text === 'THE DOOR SLAMS.');
    expect(el?.type).toBe('action');
  });

  it('strips notes and the boneyard — authoring scaffolding is never output', () => {
    const s2 = parseFountain('INT. HALL — DAY\n\nHe waits. [[check this]]\n\n/* cut for now\nAll of it. */\n');
    const text = s2.elements.map(e => e.text).join(' ');
    expect(text).not.toContain('check this');
    expect(text).not.toContain('cut for now');
  });

  it('never throws on half-written input', () => {
    for (const junk of ['', '   ', 'just a sentence', '# ', '=', 'INT.', '((']) {
      expect(() => parseFountain(junk)).not.toThrow();
    }
    expect(parseFountain('just a sentence').scenes).toHaveLength(0);
  });
});

/**
 * THE PROPERTY THAT MATTERS MOST.
 *
 * A key derived from POSITION would re-point every shot below an inserted scene
 * — silently turning a correct storyboard into a wrong one. These tests exist to
 * make that regression impossible to ship.
 */
describe('scene keys are identity, not position', () => {
  it('keeps a scene\'s key when another is inserted above it', () => {
    const before = parseFountain('INT. A — DAY\n\nOne.\n\nINT. B — DAY\n\nTwo.\n');
    const after = parseFountain('INT. NEW — DAY\n\nZero.\n\nINT. A — DAY\n\nOne.\n\nINT. B — DAY\n\nTwo.\n');
    const keyB1 = before.scenes.find(c => c.heading === 'INT. B — DAY')!.key;
    const keyB2 = after.scenes.find(c => c.heading === 'INT. B — DAY')!.key;
    expect(keyB2).toBe(keyB1);
    // Its NUMBER moved, which is display only.
    expect(after.scenes.find(c => c.key === keyB2)!.n).toBe(3);
  });

  it('keeps keys when the body of a scene is rewritten', () => {
    const a = parseFountain('INT. A — DAY\n\nOne.\n');
    const b = parseFountain('INT. A — DAY\n\nSomething entirely different, at length.\n');
    expect(b.scenes[0].key).toBe(a.scenes[0].key);
  });

  it('gives two identical sluglines distinct, stable keys', () => {
    const s = parseFountain('INT. A — DAY\n\nOne.\n\nINT. B — DAY\n\nTwo.\n\nINT. A — DAY\n\nThree.\n');
    const keys = s.scenes.map(c => c.key);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).not.toBe(keys[2]);
  });

  /** Renaming a slugline DOES change the key — and that is the design. */
  it('changes the key when the slugline is rewritten, so drift is visible', () => {
    const a = parseFountain('INT. KITCHEN — DAY\n\nOne.\n');
    const b = parseFountain('INT. GARAGE — DAY\n\nOne.\n');
    expect(b.scenes[0].key).not.toBe(a.scenes[0].key);
  });

  it('finds a scene by key and returns it verbatim', () => {
    const s = parseFountain(SCRIPT);
    const scene = findScene(s, s.scenes[0].key)!;
    expect(sceneText(scene)).toContain('Six people around a table');
    expect(findScene(s, 'nope')).toBeNull();
  });
});

describe('coverage is verified from the board', () => {
  const s = parseFountain(SCRIPT);
  const [k1, k2, k3] = s.scenes.map(c => c.key);

  it('counts shots per scene and names what is uncovered', () => {
    const cov = coverage(s, [{ sceneKey: k1 }, { sceneKey: k1 }, { sceneKey: k3 }]);
    expect(cov.scenes.map(c => c.shots)).toEqual([2, 0, 1]);
    expect(cov.uncovered).toEqual([k2]);
  });

  it('counts a shot whose scene no longer exists as off-script, not as coverage', () => {
    const cov = coverage(s, [{ sceneKey: 'int-kitchen-day' }, { sceneKey: '' }]);
    expect(cov.offScript).toBe(2);
    expect(cov.uncovered).toEqual([k1, k2, k3]);
  });

  it('walks scenes in reading order, so the film is built front to back', () => {
    expect(nextScene(s, [{ sceneKey: k1 }])).toBe(k2);
    expect(nextScene(s, [{ sceneKey: k1 }, { sceneKey: k2 }])).toBe(k3);
    expect(nextScene(s, s.scenes.map(c => ({ sceneKey: c.key })))).toBeNull();
  });
});

describe('resolution — constant context at any script length', () => {
  const s = parseFountain(SCRIPT);

  it('sends a short script whole', () => {
    const ctx = renderScriptContext(s, null);
    expect(ctx.mode).toBe('full');
    expect(ctx.totalScenes).toBe(3);
    expect(ctx.body).toContain('Six people around a table');
  });

  it('windows a long one to the focus and its neighbours, keeping the map', () => {
    // 60 scenes, each long enough to blow the limit outright.
    const long = Array.from({ length: 60 }, (_, i) =>
      `INT. ROOM ${i + 1} — DAY\n\n${'Something happens at length. '.repeat(12)}\n`).join('\n');
    const big = parseFountain(long);
    const focus = big.scenes[30].key;
    const ctx = renderScriptContext(big, focus);

    expect(ctx.mode).toBe('scoped');
    expect(ctx.totalScenes).toBe(60);
    // The focus and one neighbour each side, verbatim.
    expect(ctx.included).toEqual([big.scenes[29].key, focus, big.scenes[31].key]);
    // EVERY scene still appears in the map, so nothing is unreachable.
    expect(ctx.body).toContain(big.scenes[0].key);
    expect(ctx.body).toContain(big.scenes[59].key);
    // And it is bounded — the whole point.
    expect(ctx.body.length).toBeLessThan(long.length / 2);
  });

  it('marks which scenes are actually loaded, so the agent knows what it holds', () => {
    const long = Array.from({ length: 40 }, (_, i) =>
      `INT. ROOM ${i + 1} — DAY\n\n${'Words. '.repeat(60)}\n`).join('\n');
    const big = parseFountain(long);
    const ctx = renderScriptContext(big, big.scenes[10].key);
    expect(ctx.body).toContain('«loaded»');
    expect(ctx.body).toContain('board_read_script');
  });

  it('renders one scene verbatim with its sequence for context', () => {
    const text = renderScene(s, s.scenes[0].key)!;
    expect(text).toContain('SEQUENCE 1');
    expect(text).toContain('INT. BOARDROOM — DAY');
    expect(text).toContain('Watch this.');
    expect(renderScene(s, 'nope')).toBeNull();
  });

  it('reports empty rather than failing on a blank script', () => {
    expect(renderScriptContext(parseFountain(''), null).mode).toBe('empty');
  });

  /** A paragraph someone is still shaping, with no sluglines yet. */
  it('still shows prose that has no scenes yet', () => {
    const ctx = renderScriptContext(parseFountain('An idea about demos failing.'), null);
    expect(ctx.body).toContain('An idea about demos failing.');
  });

  it('outlines the script one line per scene', () => {
    const o = outline(s);
    expect(o).toContain('INT. BOARDROOM — DAY');
    expect(o).toContain('SEQUENCE 2');
    expect(o.split('\n').length).toBeLessThan(12);
  });
});

/**
 * The read↔write bridge for the screenplay page.
 *
 * A click on the formatted page has to land in the right place in the raw text,
 * or editing a long script means hunting for the line you were just pointing at.
 */
describe('offsetOfLine', () => {
  const script = 'Title: X\n\nINT. KITCHEN — DAY\n\nShe turns.\n';

  it('resolves line 0 to the start', () => {
    expect(offsetOfLine(script, 0)).toBe(0);
  });

  it('lands exactly on the start of a line', () => {
    expect(script.slice(offsetOfLine(script, 2))).toMatch(/^INT\. KITCHEN/);
    expect(script.slice(offsetOfLine(script, 4))).toMatch(/^She turns\./);
  });

  /** A click on an element whose source has since been rewritten. The end is the
   *  honest answer; throwing or returning 0 would silently move the caret. */
  it('clamps a line past the end to the end', () => {
    expect(offsetOfLine(script, 999)).toBe(script.length);
  });

  it('treats a negative or non-finite line as the start', () => {
    expect(offsetOfLine(script, -3)).toBe(0);
    expect(offsetOfLine(script, Number.NaN)).toBe(0);
  });

  /** Every parsed element must map back into the text it was parsed from. */
  it('round-trips every element the parser produced', () => {
    const parsed = parseFountain(script);
    for (const el of parsed.elements) {
      if (!el.text) continue;
      expect(script.slice(offsetOfLine(script, el.line))).toContain(el.text);
    }
  });
});

/**
 * ── A CUE HAS A BLANK LINE BEFORE IT ────────────────────────────────────────
 * Fountain: "any line entirely in uppercase, with one empty line before it and
 * without an empty line after it". Only the second half was checked, so an
 * ordinary capitalised action line mid-paragraph became a character cue and
 * swallowed the line after it as speech.
 *
 * It does not stop at the page. The compile writes that line onto a shot as a
 * spoken line, the video agent hands it to a voice, and an avatar says "the
 * lift arrives" out loud.
 */
describe('uppercase action is not a character cue', () => {
  const types = (src: string) =>
    parseFountain(src).elements.filter(e => e.type !== 'blank').map(e => `${e.type}:${e.text}`);

  it('does not turn a shouted action line into dialogue', () => {
    const out = types([
      'INT. STAIRWELL - DUSK', '',
      'He stops.',
      'SILENCE.',
      'The lift arrives.',
    ].join('\n'));
    expect(out).toEqual([
      'scene_heading:INT. STAIRWELL - DUSK',
      'action:He stops.',
      'action:SILENCE.',
      'action:The lift arrives.',
    ]);
  });

  it('still reads a real cue, which has its blank line', () => {
    const out = types([
      'INT. STAIRWELL - DUSK', '',
      'He stops.', '',
      'PSY',
      'Third time this week.',
    ].join('\n'));
    expect(out).toEqual([
      'scene_heading:INT. STAIRWELL - DUSK',
      'action:He stops.',
      'character:PSY',
      'dialogue:Third time this week.',
    ]);
  });

  it('keeps the extension on the cue and out of the name test', () => {
    const out = types(['PSY (V.O.)', 'I say yes before I decide to.'].join('\n'));
    expect(out).toEqual(['character:PSY (V.O.)', 'dialogue:I say yes before I decide to.']);
  });

  it('reads a cue at the very top of the document', () => {
    expect(types(['PSY', 'Alone.'].join('\n'))).toEqual(['character:PSY', 'dialogue:Alone.']);
  });

  it('honours a forced @cue even without the blank line', () => {
    const out = types(['He stops.', '@McAvoy', 'Forced.'].join('\n'));
    expect(out).toEqual(['action:He stops.', 'character:McAvoy', 'dialogue:Forced.']);
  });

  it('reads names with full stops and apostrophes', () => {
    const out = types([
      'DR. MEHTA', 'You look tired.', '',
      "MRS. O'BRIEN", 'He always does.',
    ].join('\n'));
    expect(out).toEqual([
      'character:DR. MEHTA', 'dialogue:You look tired.',
      "character:MRS. O'BRIEN", 'dialogue:He always does.',
    ]);
  });

  it('keeps a parenthetical under the cue as a parenthetical', () => {
    const out = types(['ASTRA', '(too cheerful)', 'That is just being neighbourly.'].join('\n'));
    expect(out).toEqual([
      'character:ASTRA',
      'parenthetical:(too cheerful)',
      'dialogue:That is just being neighbourly.',
    ]);
  });
});
