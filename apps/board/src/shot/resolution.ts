/**
 * Context resolution for the board — the same three tiers the video editor uses.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────
 * Covering a screenplay shot by shot is a LONG job: forty scenes is forty turns,
 * and the agent has to stay oriented across all of them. Two ways that fails:
 *
 *   • send the whole script every turn → a feature-length one blows the window
 *     and the bill, and the current scene is buried in it;
 *   • send a summary → the agent builds shots from a paraphrase, and the film
 *     quietly stops being the one that was written.
 *
 * The editor already solved this (`studio/src/spec/resolution.ts`,
 * `screenplay.ts`), and the answer is neither: hold a constant-size MAP and load
 * the SLICE you are working on.
 *
 *   T0  HEADER    title, credit, the writer's own synopses. Small, always sent.
 *   T1  OUTLINE   one line per scene, with its key. The map. Always sent.
 *   T2  FOCUS     the focused scene VERBATIM, plus its neighbours. Loaded JIT.
 *
 * Any other scene is one `board_read_script` call away, so nothing is ever
 * unreachable — only unloaded. That is what makes a 40-scene script cost the
 * same per turn as a 4-scene one.
 *
 * ── VERBATIM, NOT SUMMARISED ─────────────────────────────────────────────────
 * The focused scene is sent as written, every word. The agent is about to decide
 * how to photograph it, and a summary of a scene is not a scene: the detail the
 * action lingers on is exactly the thing a shot has to contain.
 *
 * Pure and deterministic — no I/O, no time — so every rule here is a unit test.
 */
import type { BlockStdScope } from '@blocksuite/std';

import { perRev } from '../board/doc-cache';
import { findScene, sequenceOf, type ParsedScript } from './fountain';
import { readParsed } from './screenplay-doc';
import { readShots } from './shots';

export interface ScriptContext {
  body: string;
  /** `full` when the whole script fitted; `scoped` when it was windowed. */
  mode: 'full' | 'scoped' | 'empty';
  /** Scene keys included verbatim — for logging and tests. */
  included: string[];
  totalScenes: number;
}

export interface ScriptContextOptions {
  /** Scripts at or under this many characters go verbatim in full. */
  fullLimit?: number;
  /** How many scenes on EACH side of the focus to include in full. */
  window?: number;
}

/**
 * Render the script for the agent's context at the current resolution.
 *
 * `focusKey` is the scene being worked on right now. In scoped mode that scene
 * and its neighbours are verbatim; everything else is one outline line.
 */
export function renderScriptContext(
  script: ParsedScript,
  focusKey?: string | null,
  opts: ScriptContextOptions = {},
): ScriptContext {
  const fullLimit = opts.fullLimit ?? 6000;
  const window = Math.max(0, opts.window ?? 1);

  if (script.empty || (!script.scenes.length && !script.elements.length)) {
    return { body: '', mode: 'empty', included: [], totalScenes: 0 };
  }

  const whole = renderWhole(script);

  // Small enough, or nothing parseable to slice by → send it whole. Slicing a
  // script we could not read would risk dropping the thing being written.
  if (whole.length <= fullLimit || script.scenes.length === 0) {
    return {
      body: whole,
      mode: 'full',
      included: script.scenes.map(s => s.key),
      totalScenes: script.scenes.length,
    };
  }

  const idx = focusKey ? script.scenes.findIndex(s => s.key === focusKey) : -1;
  // With no focus yet, open on the first scenes so a fresh session still starts
  // from the real script rather than from the map alone.
  const center = idx >= 0 ? idx : 0;
  const lo = Math.max(0, center - (idx >= 0 ? window : 0));
  const hi = Math.min(script.scenes.length - 1, center + window);

  const out: string[] = [];
  const header = renderHeader(script);
  if (header) out.push(header, '');
  out.push('OUTLINE — every scene. Full text of any of them: board_read_script.');
  out.push(outlineOf(script, new Set(script.scenes.slice(lo, hi + 1).map(s => s.key))));

  const included: string[] = [];
  out.push('', '─────────────────────────────────────────────');
  for (let i = lo; i <= hi; i++) {
    const scene = script.scenes[i];
    included.push(scene.key);
    out.push('', renderScene(script, scene.key) ?? '');
  }

  return { body: out.join('\n'), mode: 'scoped', included, totalScenes: script.scenes.length };
}

/** T0 — the durable header. Title, credit, and the writer's own intent. */
export function renderHeader(script: ParsedScript): string {
  const out: string[] = [];
  if (script.title) out.push(`TITLE: ${script.title}`);
  if (script.credit) out.push(`BY: ${script.credit}`);
  for (const a of script.acts) {
    if (a.synopsis.length) out.push(`${a.title}: ${a.synopsis.join(' ')}`);
  }
  return out.join('\n');
}

/**
 * T1 — one line per scene, grouped under its sequence.
 *
 * `«you are here»` marks what is loaded verbatim below, so the agent can tell at
 * a glance which part of the map it is actually holding.
 */
export function outlineOf(script: ParsedScript, loaded: Set<string> = new Set()): string {
  const out: string[] = [];
  let seq = -2;
  for (const scene of script.scenes) {
    if (scene.sequenceIndex !== seq) {
      seq = scene.sequenceIndex;
      const s = sequenceOf(script, scene);
      if (s) out.push(`  ## ${s.title}${s.synopsis.length ? ` — ${s.synopsis[0]}` : ''}`);
      else out.push('  ## (no sequence)');
    }
    const mark = loaded.has(scene.key) ? '  «loaded»' : '';
    out.push(`    ${scene.n}. [${scene.key}] ${scene.heading}${mark}`);
  }
  return out.join('\n');
}

/** T2 — one scene, verbatim, with the sequence it belongs to for context. */
export function renderScene(script: ParsedScript, key: string): string | null {
  const scene = findScene(script, key);
  if (!scene) return null;
  const out: string[] = [];
  const s = sequenceOf(script, scene);
  if (s) out.push(`## ${s.title}${s.synopsis.length ? ` — ${s.synopsis[0]}` : ''}`);
  out.push(`SCENE ${scene.n} [${scene.key}]`);
  out.push(scene.heading);
  for (const syn of scene.synopsis) out.push(`= ${syn}`);
  if (scene.body) out.push('', scene.body);
  return out.join('\n');
}

/** The whole script as the agent should see it — header, then every scene. */
function renderWhole(script: ParsedScript): string {
  const out: string[] = [];
  const header = renderHeader(script);
  if (header) out.push(header, '');
  let seq = -2;
  let act = -2;
  for (const scene of script.scenes) {
    if (scene.sequenceIndex !== seq) {
      seq = scene.sequenceIndex;
      const s = sequenceOf(script, scene);
      if (s) {
        const a = actIndexBefore(script, s.line);
        if (a !== act) { act = a; if (a >= 0) out.push('', `# ${script.acts[a].title}`); }
        out.push('', `## ${s.title}${s.synopsis.length ? ` — ${s.synopsis[0]}` : ''}`);
      }
    }
    out.push('', `SCENE ${scene.n} [${scene.key}]`, scene.heading);
    for (const syn of scene.synopsis) out.push(`= ${syn}`);
    if (scene.body) out.push('', scene.body);
  }
  // A script with no sluglines yet — an opening paragraph someone is still
  // shaping. Send it as they wrote it rather than reporting nothing.
  if (!script.scenes.length) {
    return script.elements.filter(e => e.type !== 'blank').map(e => e.text).join('\n');
  }
  return out.join('\n').trim();
}

function actIndexBefore(script: ParsedScript, line: number): number {
  let idx = -1;
  script.acts.forEach((a, i) => { if (a.line <= line) idx = i; });
  return idx;
}

// ── Coverage: which scenes still need shots ─────────────────────────────────

export interface Coverage {
  key: string;
  n: number;
  heading: string;
  shots: number;
}

/**
 * How much of the script the board has actually covered.
 *
 * VERIFIED FROM THE BOARD, never asserted by the agent. This is the editor's
 * anti-"said done but wasn't" rule applied here: a scene is covered when shots
 * pointing at it exist, and no amount of the agent believing otherwise changes
 * that. It is also the to-do list — `uncovered` is literally the work left.
 */
export function coverage(
  script: ParsedScript,
  shots: Array<{ sceneKey: string }>,
): { scenes: Coverage[]; uncovered: string[]; offScript: number } {
  const count = new Map<string, number>();
  for (const s of shots) {
    if (!s.sceneKey) continue;
    count.set(s.sceneKey, (count.get(s.sceneKey) ?? 0) + 1);
  }
  const known = new Set(script.scenes.map(s => s.key));
  const scenes = script.scenes.map(s => ({
    key: s.key, n: s.n, heading: s.heading, shots: count.get(s.key) ?? 0,
  }));
  return {
    scenes,
    uncovered: scenes.filter(s => s.shots === 0).map(s => s.key),
    /**
     * Shots pointing at no scene, or at a scene that is no longer in the script.
     *
     * Counted rather than hidden: a shot whose scene was renamed out from under
     * it is real work the user did, and it must show up somewhere or it looks
     * like the board silently ate it.
     */
    offScript: shots.filter(s => !s.sceneKey || !known.has(s.sceneKey)).length,
  };
}

/**
 * Coverage for THIS BOARD, computed once per document revision.
 *
 * `coverage` itself stays pure and argument-driven — it is the unit-tested rule,
 * and compile and the agent digest both call it with lists they already hold.
 * This is the render path's door to it: the screenplay page draws a margin mark
 * per scene and repaints whenever any block changes, so without the memo one
 * pointermove re-derived the whole script's coverage.
 */
export function boardCoverage(
  std: BlockStdScope,
): { scenes: Coverage[]; uncovered: string[]; offScript: number } {
  return perRev(std, 'script:coverage', () => coverage(readParsed(std), readShots(std)));
}

/**
 * The next scene to work on: the first uncovered one, in reading order.
 *
 * Reading order, not "shortest" or "most complete" — a film is built front to
 * back because that is how a person watches it, and an agent that hops around
 * produces a storyboard nobody can review.
 */
export function nextScene(
  script: ParsedScript,
  shots: Array<{ sceneKey: string }>,
): string | null {
  return coverage(script, shots).uncovered[0] ?? null;
}
