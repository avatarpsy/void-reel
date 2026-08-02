/**
 * Compile is a ONE-WAY DOOR: it turns a board into a project and locks the board.
 *
 * So the thing worth testing is not the formatting — it is that nothing the user
 * made is lost or reordered on the way through. Every test here is a way the old
 * geometry-based compile silently dropped work.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { compileBoard } from './screenplay';
import { readParsed, writeScript } from './screenplay-doc';
import { setModelCatalogue, type ModelCaps } from './models';
import { addMedia, createShots, setMediaRole, setShotFields, tagMedia, trimMedia } from './shots';
import type { ShotMedia } from './model';

/** Two real capability shapes — one that reads @-tags, one that does not. */
const SEEDANCE: ModelCaps = {
  id: 'bytedance/seedance-2', label: 'ByteDance Seedance 2',
  minDurationSec: 4, maxDurationSec: 15, allowedDurations: [4, 5, 8, 10, 12, 15],
  nativeDialogue: true, nativeAudio: true, acceptsVoiceReference: true,
  supportsLastFrame: true, usesReferenceTags: true, referenceTagSyntax: 'Image',
  deliveryModes: ['reference', 'first-frame'], defaultDelivery: 'reference',
};
const KLING: ModelCaps = {
  id: 'kling/v2-5-turbo-image-to-video-pro', label: 'Kling 2.5 Turbo Pro',
  minDurationSec: 5, maxDurationSec: 10, allowedDurations: [5, 10],
  nativeDialogue: false, nativeAudio: false, acceptsVoiceReference: false,
  supportsLastFrame: false, usesReferenceTags: false, referenceTagSyntax: 'image',
  deliveryModes: ['first-frame'], defaultDelivery: 'first-frame',
};

const HEADER = { title: 'Rain', aspect: '9:16', goal: 'Sell the mood' };

function media(over: Partial<ShotMedia> = {}): Omit<ShotMedia, 'id'> {
  return {
    kind: 'image',
    role: 'reference',
    src: 'https://example.test/thumb.png',
    url: 'https://example.test/master.png',
    name: 'still.png',
    ...over,
  };
}

describe('compileBoard', () => {
  it('emits exactly one heading per shot, in filmstrip order', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['Kitchen', 'Street', 'Window']);

    const out = compileBoard(board.std, HEADER);
    expect(out.shots.map(s => s.title)).toEqual(['Kitchen', 'Street', 'Window']);
    expect(out.screenplay.match(/^SHOT \d+ — /gm)).toHaveLength(3);
    expect(out.screenplay).toContain('SHOT 2 — Street');
  });

  /**
   * SHOT, NOT SCENE — and the distinction is load-bearing, not cosmetic.
   *
   * A scene is a different object one level up: several shots may cover one.
   * If the per-clip headings also said SCENE, the compiled document would use
   * the word for two things and a model reading it could not tell which.
   */
  it('numbers clips as SHOT so SCENE stays free for the level above', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['Kitchen']);
    const text = compileBoard(board.std, HEADER).screenplay;
    expect(text).toContain('SHOT 1 — Kitchen');
    expect(text).not.toMatch(/^SCENE \d+ — /m);
  });

  /** A shot named "SCENE 3 — Kitchen" by the user or the agent must not compile
   *  to "SHOT 1 — SCENE 3 — Kitchen". */
  it('does not double up a heading prefix the title already carries', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['SCENE 3 — Kitchen']);
    expect(compileBoard(board.std, HEADER).screenplay).toContain('SHOT 1 — Kitchen');
  });

  it('carries what the user wrote, and only what they wrote', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    setShotFields(board.std, id, { action: 'She turns', camera: 'Slow push in' });

    const out = compileBoard(board.std, HEADER);
    expect(out.screenplay).toContain('ACTION: She turns');
    expect(out.screenplay).toContain('CAMERA: Slow push in');
    // An empty field must NOT become a line: the planner would read it as an
    // approved description of a scene nobody wrote.
    expect(out.screenplay).not.toContain('VO:');
    expect(out.shots[0].voiceover).toBeUndefined();
  });

  /**
   * THE INVARIANT THAT MATTERS MOST. Under the old model a reference nudged one
   * pixel outside its frame vanished from the compiled video with no warning.
   * A shot owns its media now, so there is no bounds test left to fail.
   */
  it('carries every reference on its shot, with full-quality urls', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    for (let i = 0; i < 40; i++) addMedia(board.std, id, media({ name: `ref-${i}.png` }));

    const out = compileBoard(board.std, HEADER);
    expect(out.shots[0].references).toHaveLength(40);
    // The MASTER, never the tile the canvas drew.
    expect(out.shots[0].references.every(r => r.url === 'https://example.test/master.png')).toBe(true);
  });

  it('orders references by role, slots before supporting material', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    const song = addMedia(board.std, id, media({ kind: 'audio', name: 'score.mp3', role: 'bgm' }))!;
    addMedia(board.std, id, media({ name: 'mood.png' }));
    const first = addMedia(board.std, id, media({ name: 'open.png' }))!;
    setMediaRole(board.std, id, first, 'firstFrame');

    const out = compileBoard(board.std, HEADER);
    expect(out.shots[0].references.map(r => r.role)).toEqual(['firstFrame', 'reference', 'bgm']);
    expect(out.shots[0].references.at(-1)!.id).toBe(song);
    // And the screenplay says what each one is FOR, not just that it exists.
    expect(out.screenplay).toContain('FIRST FRAME: open.png');
    expect(out.screenplay).toContain('MUSIC: score.mp3');
  });

  it('puts the header above the beats', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['Kitchen']);
    const out = compileBoard(board.std, HEADER);
    expect(out.screenplay.startsWith('Rain\nAspect: 9:16\nGoal: Sell the mood')).toBe(true);
  });
});

/**
 * The legend is what makes a numbered reference mean something. Without it a
 * motion prompt reads "@Image2 turns to the window" and nobody — not the user,
 * not the agent on its next turn — can say what @Image2 was.
 */
describe('compileBoard — reference tags', () => {
  beforeEach(() => setModelCatalogue([SEEDANCE, KLING], SEEDANCE.id));

  it('numbers references from the ORDER COMPILE EMITS, not storage order', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    setShotFields(board.std, id, { model: SEEDANCE.id });
    // Added mood-first, but a first frame outranks it in the compiled order —
    // so the FIRST FRAME must be @Image1, whatever order they went in.
    const mood = addMedia(board.std, id, media({ name: 'mood.png' }))!;
    const open = addMedia(board.std, id, media({ name: 'open.png' }))!;
    setMediaRole(board.std, id, open, 'firstFrame');

    const refs = compileBoard(board.std, HEADER).shots[0].references;
    expect(refs.map(r => [r.name, r.promptTag])).toEqual([
      ['open.png', '@Image1'],
      ['mood.png', '@Image2'],
    ]);
    expect(refs[0].id).toBe(open);
    expect(refs[1].id).toBe(mood);
  });

  it('writes a legend naming each reference', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    setShotFields(board.std, id, { model: SEEDANCE.id });
    const sarah = addMedia(board.std, id, media({ name: 'sarah-portrait.jpg' }))!;
    tagMedia(board.std, id, sarah, { tag: 'Sarah', refKind: 'character' });

    const out = compileBoard(board.std, HEADER);
    expect(out.screenplay).toContain('REFERENCES:');
    // The tag is normalised — a prompt token cannot carry a capital or a space.
    expect(out.screenplay).toContain('@Image1 — sarah, character: sarah-portrait.jpg');
    expect(out.shots[0].references[0].tag).toBe('sarah');
    expect(out.shots[0].references[0].refKind).toBe('character');
  });

  /**
   * A model that does not read @-tags gets no NUMBERS — but the user's own
   * words survive. Gating the legend on tag support (which is what this did at
   * first) silently dropped every name, note and trim window on Grok and Kling,
   * and those are the hardest things to notice missing: the reference is still
   * there and still listed.
   */
  it('writes no @-numbers for a tag-less model, but still says what things are', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    setShotFields(board.std, id, { model: KLING.id });
    const m = addMedia(board.std, id, media({ name: 'mood.png' }))!;
    tagMedia(board.std, id, m, { tag: 'mood', refKind: 'style' });

    const out = compileBoard(board.std, HEADER);
    expect(out.shots[0].references[0].tag).toBe('mood');
    expect(out.shots[0].references[0].promptTag).toBeUndefined();
    expect(out.screenplay).toContain('REFERENCES:');
    expect(out.screenplay).toContain('mood, style: mood.png');
    // No numbering scheme the model does not use.
    expect(out.screenplay).not.toContain('@Image');
    expect(out.screenplay).not.toContain('@image');
  });

  it('carries a usage note and a trim window into the legend', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    setShotFields(board.std, id, { model: SEEDANCE.id });
    const clip = addMedia(board.std, id, media({
      kind: 'video', name: 'take-01.mp4', durationSec: 90,
    }))!;
    tagMedia(board.std, id, clip, { tag: 'the take', note: 'the bit where she turns to the window' });
    trimMedia(board.std, id, clip, { inSec: 12.5, outSec: 16.5 });

    const out = compileBoard(board.std, HEADER);
    const ref = out.shots[0].references[0];
    expect(ref.inSec).toBe(12.5);
    expect(ref.outSec).toBe(16.5);
    expect(ref.note).toBe('the bit where she turns to the window');
    expect(out.screenplay)
      .toContain('@Video1 — the-take: take-01.mp4 [0:12.5–0:16.5] — the bit where she turns to the window');
  });

  /** An untrimmed clip must not claim a window — a render step would apply a
   *  cut to something nobody cut. */
  it('emits no window for a clip that was never trimmed', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    setShotFields(board.std, id, { model: SEEDANCE.id });
    addMedia(board.std, id, media({ kind: 'video', name: 'take.mp4', durationSec: 30 }));

    const ref = compileBoard(board.std, HEADER).shots[0].references[0];
    expect(ref.inSec).toBeUndefined();
    expect(ref.outSec).toBeUndefined();
    expect(ref.durationSec).toBe(30);
  });

  it('carries the shot’s model and length into the screenplay', () => {
    const board = makeTestBoard();
    const [id] = createShots(board.std, board.surfaceId, ['Kitchen']);
    setShotFields(board.std, id, { model: SEEDANCE.id, durationSec: 8 });

    const out = compileBoard(board.std, HEADER);
    expect(out.shots[0].model).toBe(SEEDANCE.id);
    expect(out.shots[0].durationSec).toBe(8);
    expect(out.screenplay).toContain('LENGTH: 8s');
  });
});

/**
 * THE HANDOFF — one Fountain document in, two artifacts out.
 *
 * The script is what the writer wrote; the production screenplay is what the
 * editor builds from. These pin that both travel, that the shot count invariant
 * survives the structure being added, and that an off-script shot is carried
 * rather than dropped.
 */
describe('compileBoard carries the written script and the production screenplay', () => {
  const SCRIPT = `Title: The leak

# ACT ONE

## SEQUENCE 1 — the demo
= Make them believe it.

INT. BOARDROOM — DAY

Six people around a table.

INT. USER DESK — NIGHT

A tired person types.
`;

  function boardWithScript() {
    const board = makeTestBoard();
    writeScript(board.std, board.surfaceId, SCRIPT);
    return board;
  }

  it('emits the Fountain source verbatim, alongside the production screenplay', () => {
    const board = boardWithScript();
    createShots(board.std, board.surfaceId, ['Wide']);
    const out = compileBoard(board.std, HEADER);
    // Verbatim: a later edit must round-trip through a real screenplay, not
    // through a derivative of one.
    expect(out.script).toBe(SCRIPT);
    expect(out.screenplay).toContain('SHOT 1 — Wide');
  });

  it('puts the written structure in the preamble, above the first shot heading', () => {
    const board = boardWithScript();
    const [a, b] = createShots(board.std, board.surfaceId, ['Wide', 'Close']);
    const key = readParsed(board.std).scenes[0].key;
    setShotFields(board.std, a, { sceneKey: key });
    setShotFields(board.std, b, { sceneKey: key });

    const out = compileBoard(board.std, HEADER);
    const firstHeading = out.screenplay.search(/^SHOT 1 — /m);
    const structureAt = out.screenplay.indexOf('STRUCTURE');
    expect(structureAt).toBeGreaterThan(-1);
    expect(structureAt).toBeLessThan(firstHeading);
    expect(out.screenplay).toContain('SEQUENCE 1 — the demo');
    expect(out.screenplay).toContain('· SCENE 1 — INT. BOARDROOM — DAY');
    // Two shots on ONE scene — coverage, and the thing a downstream agent needs
    // in order to know they should match and cut together.
    expect(out.screenplay).toContain('SHOTS: 1, 2');
  });

  it('says which scenes have no shots', () => {
    const board = boardWithScript();
    const [a] = createShots(board.std, board.surfaceId, ['Wide']);
    setShotFields(board.std, a, { sceneKey: readParsed(board.std).scenes[0].key });
    expect(compileBoard(board.std, HEADER).screenplay).toContain('SHOTS: none');
  });

  /**
   * THE INVARIANT, ASSERTED AGAINST THE STUDIO'S OWN GRAMMAR.
   *
   * The parser matches `^\s*(?:SCENE|SHOT)\s+\d+` — and `^\s*` means LEADING
   * WHITESPACE DOES NOT PROTECT A LINE. An indented `SCENE 1 — …` in the
   * structure block therefore parses as a numbered heading and inflates the
   * count: a 4-shot board once reported 7, which fails compile outright.
   *
   * This regex is a copy of the studio's, deliberately, so the board can prove
   * the property in its own test run rather than only at the server boundary.
   */
  const STUDIO_HEADING = /^\s*(?:SCENE|SHOT)\s+(\d+)\s*(?:[—\-–:|].*)?$/gim;

  it('adds no numbered heading for a sequence or a scene', () => {
    const board = boardWithScript();
    const [a, b] = createShots(board.std, board.surfaceId, ['Wide', 'Close']);
    const keys = readParsed(board.std).scenes.map(c => c.key);
    setShotFields(board.std, a, { sceneKey: keys[0] });
    setShotFields(board.std, b, { sceneKey: keys[1] });

    const text = compileBoard(board.std, HEADER).screenplay;
    const headings = text.match(STUDIO_HEADING) ?? [];
    // TWO shots on the board → exactly TWO headings, however much structure
    // sits above them.
    expect(headings).toHaveLength(2);
    // Trimmed: the grammar's leading `^\s*` consumes the newline before the
    // heading, so a raw match starts with it.
    expect(headings.every(h => h.trim().startsWith('SHOT '))).toBe(true);
  });

  it('keeps the count right when many scenes are listed in the structure', () => {
    const board = makeTestBoard();
    // Ten written scenes, one shot. The structure block is long; the count is 1.
    writeScript(board.std, board.surfaceId, Array.from({ length: 10 }, (_, i) =>
      `INT. ROOM ${i + 1} — DAY\n\nSomething.\n`).join('\n'));
    createShots(board.std, board.surfaceId, ['Only shot']);
    const text = compileBoard(board.std, HEADER).screenplay;
    expect(text.match(STUDIO_HEADING) ?? []).toHaveLength(1);
  });

  it('tells each shot which scene it covers, resolved', () => {
    const board = boardWithScript();
    const [a] = createShots(board.std, board.surfaceId, ['Wide']);
    setShotFields(board.std, a, { sceneKey: readParsed(board.std).scenes[1].key });
    const out = compileBoard(board.std, HEADER);
    expect(out.shots[0]).toMatchObject({
      scene: 2, sceneSlug: 'INT. USER DESK — NIGHT', sequence: 'SEQUENCE 1 — the demo',
    });
    expect(out.screenplay).toContain('COVERS: SEQUENCE 1 — the demo · SCENE 2 — INT. USER DESK — NIGHT');
  });

  /**
   * A shot whose slugline was renamed away. It must compile — the user's work is
   * on it — but as off-script rather than as a scene that no longer exists.
   */
  it('compiles a shot whose scene was renamed, as off-script', () => {
    const board = boardWithScript();
    const [a] = createShots(board.std, board.surfaceId, ['Orphan']);
    setShotFields(board.std, a, { sceneKey: 'int-kitchen-day' });
    const out = compileBoard(board.std, HEADER);
    expect(out.shots).toHaveLength(1);
    expect(out.shots[0].scene).toBe(0);
    expect(out.shots[0].sceneKey).toBe('');
    expect(out.screenplay).toContain('SHOT 1 — Orphan');
  });

  /** The flexibility rule: a board nobody wrote a script for still compiles. */
  it('compiles a board with no screenplay at all, unchanged', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['Wide', 'Close']);
    const out = compileBoard(board.std, HEADER);
    expect(out.shots).toHaveLength(2);
    expect(out.script).toBe('');
    expect(out.screenplay).not.toContain('STRUCTURE');
    expect(out.structure.scenes).toEqual([]);
  });
});
