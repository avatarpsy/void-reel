/**
 * The screenplay: Sequence → Scene → Shot.
 *
 * These tests pin the two things that are easy to break and expensive to notice:
 * the STRUCTURE surviving compile intact, and every level staying optional. A
 * board where writing a screenplay became mandatory would be a regression no
 * typecheck would catch.
 */
import { describe, expect, it } from 'vitest';

import { makeTestBoard } from '../blocksuite/test-board';
import { compileBoard } from './screenplay';
import { createShots, readShots, setShotFields } from './shots';
import {
  emptyScreenplay, formatStructure, hasScreenplay, plannedRuntimeSec, readScreenplay,
  sceneLabel, sceneLetter, sequenceOfScene, writeScreenplay,
  type Scene, type Sequence,
} from './screenplay-doc';

const HEADER = { title: 'Rain', aspect: '9:16', goal: 'Sell the mood' };

function seq(over: Partial<Sequence> = {}): Sequence {
  return {
    id: 's1', title: 'the leak lands', purpose: 'hook',
    summary: 'A memo appears', targetSec: 8, music: '', look: '', ...over,
  };
}

function scene(over: Partial<Scene> = {}): Scene {
  return { id: 'c1', sequenceId: 's1', slug: 'INT. NEWSROOM — DAY', summary: '', ...over };
}

describe('the screenplay document', () => {
  it('is absent until something is written, and reads as empty rather than null', () => {
    const board = makeTestBoard();
    const s = readScreenplay(board.std);
    expect(s).toEqual(emptyScreenplay());
    expect(hasScreenplay(s)).toBe(false);
  });

  it('creates its block on first write and reuses it forever after', () => {
    const board = makeTestBoard();
    writeScreenplay(board.std, board.surfaceId, { logline: 'A memo leaks' });
    writeScreenplay(board.std, board.surfaceId, { audience: 'Founders' });

    expect(board.std.store.getBlocksByFlavour('voidspace:screenplay')).toHaveLength(1);
    const s = readScreenplay(board.std);
    // The second write must PATCH, not replace — losing the logline here would
    // mean every agent edit silently wiped the fields it did not mention.
    expect(s.logline).toBe('A memo leaks');
    expect(s.audience).toBe('Founders');
  });

  it('returns plain data, not the reactive proxy postMessage refuses', () => {
    const board = makeTestBoard();
    writeScreenplay(board.std, board.surfaceId, {
      sequences: [seq()], scenes: [scene()],
    });
    const s = readScreenplay(board.std);
    // structuredClone is exactly what the RPC boundary does. A proxy throws
    // DataCloneError here — the failure that once broke `board_read` outright.
    expect(() => structuredClone(s)).not.toThrow();
  });

  it('letters scenes past Z without colliding', () => {
    expect(sceneLetter(0)).toBe('A');
    expect(sceneLetter(25)).toBe('Z');
    expect(sceneLetter(26)).toBe('AA');
    expect(sceneLetter(27)).toBe('AB');
    const seen = new Set(Array.from({ length: 60 }, (_, i) => sceneLetter(i)));
    expect(seen.size).toBe(60);
  });

  it('resolves a shot to its sequence THROUGH its scene, never directly', () => {
    const board = makeTestBoard();
    writeScreenplay(board.std, board.surfaceId, {
      sequences: [seq({ id: 'sA' })],
      scenes: [scene({ id: 'cA', sequenceId: 'sA' })],
    });
    const s = readScreenplay(board.std);
    expect(sequenceOfScene(s, 'cA')?.id).toBe('sA');
    // A scene not placed in a sequence resolves to nothing rather than guessing.
    expect(sequenceOfScene(s, 'nope')).toBeNull();
    expect(sceneLabel(s, 'cA')).toBe('A · INT. NEWSROOM — DAY');
  });

  it('sums the planned runtime from sequences only', () => {
    const s = { ...emptyScreenplay(), sequences: [seq({ targetSec: 8 }), seq({ id: 's2', targetSec: 12 })] };
    expect(plannedRuntimeSec(s)).toBe(20);
  });
});

describe('formatStructure', () => {
  it('nests scenes under their sequence and names shots by number', () => {
    const s = {
      ...emptyScreenplay(),
      sequences: [seq({ id: 's1', targetSec: 8 })],
      scenes: [scene({ id: 'c1', sequenceId: 's1' })],
    };
    const out = formatStructure(s, new Map([['c1', [1, 2]]]));
    expect(out).toContain('SEQUENCE 1 · HOOK · 8s — the leak lands');
    expect(out).toContain('SCENE A — INT. NEWSROOM — DAY');
    expect(out).toContain('SHOTS: 1, 2');
  });

  it('says so when a scene has no shots — that is the to-do list', () => {
    const s = {
      ...emptyScreenplay(),
      sequences: [seq()],
      scenes: [scene()],
    };
    expect(formatStructure(s)).toContain('SHOTS: none yet');
  });

  /** A sequence deleted mid-edit orphans its scenes. Those scenes may still own
   *  shots, so dropping them from the structure would make real work invisible. */
  it('lists scenes that are not in any sequence rather than dropping them', () => {
    const s = {
      ...emptyScreenplay(),
      sequences: [],
      scenes: [scene({ id: 'c9', sequenceId: 'gone' })],
    };
    const out = formatStructure(s, new Map([['c9', [4]]]));
    expect(out).toContain('NOT IN ANY SEQUENCE');
    expect(out).toContain('SHOTS: 4');
  });
});

describe('compileBoard carries the structure', () => {
  it('puts sequences and scenes in the preamble, above the first shot heading', () => {
    const board = makeTestBoard();
    const [a, b] = createShots(board.std, board.surfaceId, ['Wide', 'Close']);
    writeScreenplay(board.std, board.surfaceId, {
      logline: 'A memo leaks',
      sequences: [seq({ id: 's1' })],
      scenes: [scene({ id: 'c1', sequenceId: 's1' })],
    });
    setShotFields(board.std, a, { sceneId: 'c1' });
    setShotFields(board.std, b, { sceneId: 'c1' });

    const out = compileBoard(board.std, HEADER);
    const firstHeading = out.screenplay.search(/^SHOT 1 — /m);
    const structureAt = out.screenplay.indexOf('SEQUENCE 1');
    expect(structureAt).toBeGreaterThan(-1);
    // In the PREAMBLE — the studio keeps that in context at every turn, which is
    // the whole reason the structure goes there rather than at the end.
    expect(structureAt).toBeLessThan(firstHeading);
    expect(out.screenplay).toContain('Logline: A memo leaks');
    expect(out.screenplay).toContain('SHOTS: 1, 2');
  });

  it('adds no shot headings for sequences or scenes', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['Wide']);
    writeScreenplay(board.std, board.surfaceId, {
      sequences: [seq({ id: 's1' }), seq({ id: 's2', title: 'the turn', purpose: 'turn' })],
      scenes: [scene({ id: 'c1' }), scene({ id: 'c2', sequenceId: 's2', slug: 'EXT. STREET' })],
    });
    // ONE shot on the board must mean ONE numbered heading, however much
    // structure sits above it — this is the invariant compile refuses to break.
    expect(compileBoard(board.std, HEADER).screenplay.match(/^SHOT \d+ — /gm)).toHaveLength(1);
  });

  it('tells each shot where it belongs, resolved — not as ids', () => {
    const board = makeTestBoard();
    const [a] = createShots(board.std, board.surfaceId, ['Wide']);
    writeScreenplay(board.std, board.surfaceId, {
      sequences: [seq({ id: 's1', purpose: 'hook' })],
      scenes: [scene({ id: 'c1', sequenceId: 's1' })],
    });
    setShotFields(board.std, a, { sceneId: 'c1' });

    const out = compileBoard(board.std, HEADER);
    expect(out.shots[0]).toMatchObject({
      scene: 'A', sceneSlug: 'INT. NEWSROOM — DAY', sequence: 1, purpose: 'hook',
    });
    expect(out.screenplay).toContain('IN: SEQUENCE 1 (hook) · SCENE A — INT. NEWSROOM — DAY');
  });

  it('states the numbering legend so a downstream agent never has to guess', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['Wide']);
    writeScreenplay(board.std, board.surfaceId, { sequences: [seq()] });
    expect(compileBoard(board.std, HEADER).screenplay).toContain('shot n is item n on the timeline');
  });

  /**
   * THE FLEXIBILITY RULE, as a test.
   *
   * Every level is optional. A board someone sketched without ever opening the
   * screenplay must compile exactly as it did before this feature existed.
   */
  it('compiles a board with no screenplay at all, unchanged', () => {
    const board = makeTestBoard();
    createShots(board.std, board.surfaceId, ['Wide', 'Close']);
    const out = compileBoard(board.std, HEADER);
    expect(out.shots).toHaveLength(2);
    expect(out.screenplay).not.toContain('SEQUENCE');
    expect(out.screenplay).not.toContain('STRUCTURE');
    expect(out.structure.sequences).toEqual([]);
  });

  it('compiles shots that are in a scene which is in no sequence', () => {
    const board = makeTestBoard();
    const [a] = createShots(board.std, board.surfaceId, ['Wide']);
    writeScreenplay(board.std, board.surfaceId, {
      scenes: [scene({ id: 'c1', sequenceId: '' })],
    });
    setShotFields(board.std, a, { sceneId: 'c1' });

    const out = compileBoard(board.std, HEADER);
    expect(out.shots[0].scene).toBe('A');
    expect(out.shots[0].sequence).toBe(0);
    expect(out.screenplay).toContain('NOT IN ANY SEQUENCE');
  });

  it('does not lose a shot whose scene was deleted', () => {
    const board = makeTestBoard();
    const [a] = createShots(board.std, board.surfaceId, ['Wide']);
    setShotFields(board.std, a, { sceneId: 'ghost' });
    const out = compileBoard(board.std, HEADER);
    expect(out.shots).toHaveLength(1);
    // Reported as unplaced rather than as belonging to a scene that is gone.
    expect(out.shots[0].scene).toBe('');
    expect(readShots(board.std)[0].sceneId).toBe('ghost');
  });
});
