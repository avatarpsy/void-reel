/**
 * Fountain — the screenplay, as a screenplay.
 *
 * ── WHY A STANDARD AND NOT OUR OWN GRAMMAR ───────────────────────────────────
 * Fountain (fountain.io) is the plain-text screenplay format the industry
 * already uses. Writing to it means the document a user makes here opens in
 * Final Draft, Highland, Slugline and WriterDuet unchanged, and that a writer
 * arriving from any of those does not have to learn anything. A grammar we
 * invented would be a grammar only we speak.
 *
 * ── THE TWO LADDERS, AND WHERE THE BEAT WENT ─────────────────────────────────
 * A film has two structures and they are not the same thing:
 *
 *   WRITING      Act → Sequence → Scene → Beat     psychology, emotion, flow
 *   PRODUCTION   Sequence → Scene → Shot           what actually gets built
 *
 * Everything downstream of this document — the board, compile, the editor, the
 * timeline — speaks the PRODUCTION ladder only. There is no beat in any of it.
 *
 * The beat lives in the WRITING, and only in the writing. It is how the agent
 * THINKS while composing a scene — what changes here, where it turns, what the
 * audience feels on the way out — and that thinking is what stops a script from
 * being a competent list of things that happen. It is craft guidance in a
 * prompt, not a field in a schema.
 *
 * So this file has no concept of a beat, and neither does anything it feeds.
 * That is correct in two ways at once. A produced screenplay contains sluglines,
 * action, character, dialogue, parentheticals and transitions and nothing else —
 * annotating beats in the body would be an amateur tell that breaks the read.
 * And `(beat)` inside dialogue already means a PAUSE, so the word is occupied.
 *
 * What survives the writing is the effect of that thinking, in the prose itself:
 * where the scene cuts, what a character does before they speak, which detail
 * the action lingers on. The agent reads THAT back when it builds shots.
 *
 * What this file DOES read, because Fountain supports it and outlining practice
 * uses it, is the section/synopsis layer:
 *
 *   # ACT ONE                        a section, depth 1 → act
 *   ## SEQUENCE 1 — The demo         a section, depth 2 → sequence
 *   = Make them believe it.          a synopsis: the writer's intent, one line
 *
 * Sections and synopses are omitted from a printed script by every Fountain
 * tool, so they cost the read nothing while carrying exactly the intent the
 * agent needs in order to be useful about structure.
 */

/** What a parsed line IS. Enough to render a screenplay page correctly. */
export type ElementType =
  | 'scene_heading'
  | 'action'
  | 'character'
  | 'dialogue'
  | 'parenthetical'
  | 'transition'
  | 'section'
  | 'synopsis'
  | 'centered'
  | 'page_break'
  | 'blank'
  /**
   * `Title:`, `Credit:`, `Draft date:` — the title page.
   *
   * Its own type because it is not action. Read as action it was drawn on the
   * canvas as the raw `Title: …` line, and the PDF — which already sets a
   * proper title page from these fields — printed them AGAIN at the top of
   * page two.
   */
  | 'title_field';

export interface Element {
  type: ElementType;
  /** The source line as written. For a title field that is `Title: X`, so
   *  anything joining the text back together gets the script it was given. */
  text: string;
  /** Section depth, 1-based. Only on `section`. */
  depth?: number;
  /** The field's name, lowercased (`title`, `draft date`). Only on `title_field`. */
  key?: string;
  /** What the field says, without its name. Only on `title_field`. */
  value?: string;
  /** Line index in the source, so an editor can map a click back to the text. */
  line: number;
}

/**
 * ONE SCENE — the unit both ladders share, and the unit shots hang off.
 */
export interface FountainScene {
  /**
   * STABLE ACROSS EDITS ELSEWHERE IN THE DOCUMENT.
   *
   * Derived from the slugline plus an ordinal among identical sluglines, NOT
   * from position. A writer who inserts a scene at the top must not silently
   * re-point every shot below it — which is exactly what a positional id does,
   * and it is the single most destructive thing this feature could do.
   *
   * Changing a slugline DOES change the key. That is deliberate: it surfaces as
   * drift the user can see and fix, rather than a silent re-binding.
   */
  key: string;
  /** 1-based, in reading order. Display only — never an identity. */
  n: number;
  /** The slugline as written: `INT. BOARDROOM — DAY`. */
  heading: string;
  /** Everything under the heading up to the next scene or section. */
  body: string;
  /** Synopsis lines directly under the heading — the writer's own note. */
  synopsis: string[];
  /** The sequence this scene sits in, by index into `sequences`. -1 if none. */
  sequenceIndex: number;
  /** Line range in the source, for the editor and for JIT slicing. */
  fromLine: number;
  toLine: number;
}

export interface Section {
  /** `act` for depth 1, `sequence` for depth 2+. */
  kind: 'act' | 'sequence';
  title: string;
  synopsis: string[];
  line: number;
}

export interface ParsedScript {
  /** Everything before the first section or scene — title page, notes. */
  preamble: string;
  elements: Element[];
  acts: Section[];
  sequences: Section[];
  scenes: FountainScene[];
  /** Title-page fields, when the document has one (`Title: ...`). */
  title: string;
  credit: string;
  /** True when there is nothing worth calling a screenplay yet. */
  empty: boolean;
}

// ── Grammar ─────────────────────────────────────────────────────────────────

/** `INT. KITCHEN — DAY`, `EXT./INT. CAR - NIGHT`, `EST. TOWER — DAWN`. */
const SLUGLINE = /^\s*(?:INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\.?\/E\.?|INT\.?|EXT\.?|EST\.?)[\s.].*/i;
/** A forced scene heading: a line starting with a single dot, not `..`. */
const FORCED_SCENE = /^\s*\.(?!\.)(.+)$/;
/** `CUT TO:`, `SMASH CUT TO:`, `FADE OUT.` — uppercase, ends in `TO:`. */
const TRANSITION = /^\s*(?:[A-Z][A-Z0-9 '’\-]*TO:|FADE (?:IN|OUT)[.:]?|CUT TO BLACK\.?)\s*$/;
/** A forced transition: `> CUT TO:` (no trailing `<`, which means centered). */
const FORCED_TRANSITION = /^\s*>\s*(.+[^<])\s*$/;
/** `> THE END <` — centered text. */
const CENTERED = /^\s*>\s*(.+?)\s*<\s*$/;
/** `# ACT ONE`, `## SEQUENCE 1 — …`. */
const SECTION = /^\s*(#{1,6})\s*(.*)$/;
/** `= a one-line synopsis`. */
const SYNOPSIS = /^\s*=\s*(.*)$/;
/** `===` — a page break. */
const PAGE_BREAK = /^\s*={3,}\s*$/;
/** `(worried)` under a character name. */
const PARENTHETICAL = /^\s*\(.*\)\s*$/;
/** `Title: …` on the title page. */
const TITLE_FIELD = /^\s*(Title|Credit|Author|Authors|Source|Draft date|Contact|Notes|Copyright)\s*:\s*(.*)$/i;

/**
 * A CHARACTER CUE — uppercase, and followed by something to say.
 *
 * The "followed by" half is what stops shouted action ("THE DOOR SLAMS.") from
 * being read as a character with no lines. Fountain's own rule is the same: a
 * character cue must be followed by a non-blank line.
 */
function isCharacter(
  line: string,
  next: string | undefined,
  prev: string | undefined,
): boolean {
  const t = line.trim();
  if (!t || !next || !next.trim()) return false;
  /**
   * A CHARACTER CUE HAS A BLANK LINE BEFORE IT, and leaving that out is how
   * action turns into dialogue.
   *
   * Fountain: "any line entirely in uppercase, with one empty line before it
   * and without an empty line after it". Only the second half was checked, so
   * an ordinary capitalised action line mid-paragraph was read as a cue and
   * swallowed the line after it as speech:
   *
   *     He stops.
   *     SILENCE.            <- became CHARACTER
   *     The lift arrives.   <- became their DIALOGUE
   *
   * Which then travels: the compile writes that line as a spoken line, the
   * video agent gives it to a voice, and an avatar says "the lift arrives".
   * `prev === undefined` is the top of the document, which counts as blank.
   */
  // `@Name` forces a character cue — for lowercase or unusual names. Checked
  // BEFORE the blank-line rule, because forcing is the writer overriding
  // detection and a rule that ignores the override is not an override.
  if (t.startsWith('@')) return true;
  if (prev !== undefined && prev.trim()) return false;
  if (t.length > 60) return false;
  // Must contain a letter, and every letter must be uppercase.
  if (!/[A-Za-z]/.test(t)) return false;
  const nameOnly = t.replace(/\(.*?\)\s*$/, '').replace(/\s*\^\s*$/, '').trim();
  if (!nameOnly) return false;
  return nameOnly === nameOnly.toUpperCase() && !SLUGLINE.test(t) && !TRANSITION.test(t);
}

/** Strip notes and the boneyard — they are authoring scaffolding, never output. */
function stripHidden(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\[\[[\s\S]*?\]\]/g, '');
}

/** A slug for a scene key: lowercase, alphanumeric, dash-separated. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'scene';
}

export function emptyScript(): ParsedScript {
  return {
    preamble: '', elements: [], acts: [], sequences: [], scenes: [],
    title: '', credit: '', empty: true,
  };
}

/**
 * Parse a Fountain document.
 *
 * NEVER THROWS. A half-written script, a pasted paragraph, or a document with
 * no sluglines at all yields whatever could be read plus zero scenes — which
 * degrades to "you have not written scenes yet", not to an error. Someone
 * mid-sentence must never see a parser complaint.
 */
export function parseFountain(source: string): ParsedScript {
  const src = typeof source === 'string' ? stripHidden(source) : '';
  if (!src.trim()) return emptyScript();

  const lines = src.split(/\r?\n/);
  const elements: Element[] = [];
  const acts: Section[] = [];
  const sequences: Section[] = [];
  const scenes: FountainScene[] = [];
  let title = '';
  let credit = '';

  /** Ordinals per slugline, so two `INT. KITCHEN — DAY` scenes get distinct keys. */
  const seen = new Map<string, number>();
  let current: FountainScene | null = null;
  /** Where synopsis lines attach: the last section or scene we opened. */
  let synopsisTarget: { synopsis: string[] } | null = null;
  let inTitlePage = true;
  let preambleEnd = 0;

  const closeScene = (atLine: number) => {
    if (!current) return;
    current.toLine = atLine - 1;
    current.body = lines.slice(current.fromLine + 1, atLine).join('\n').trim();
    scenes.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();

    // ── Title page. Only at the very top, and only until a blank line after it.
    if (inTitlePage) {
      const tf = TITLE_FIELD.exec(line);
      if (tf) {
        const key = tf[1].toLowerCase();
        if (key === 'title') title = tf[2].trim();
        else if (key === 'credit' || key === 'author' || key === 'authors') {
          credit = credit || tf[2].trim();
        }
        elements.push({ type: 'title_field', text: line, key, value: tf[2].trim(), line: i });
        preambleEnd = i + 1;
        continue;
      }
      if (trimmed && !SECTION.test(line) && !SLUGLINE.test(line)) {
        // Ordinary prose before any structure — still preamble.
        if (!elements.length) { preambleEnd = i + 1; }
      }
      if (trimmed) inTitlePage = false;
    }

    if (!trimmed) { elements.push({ type: 'blank', text: '', line: i }); continue; }

    if (PAGE_BREAK.test(line)) {
      elements.push({ type: 'page_break', text: '', line: i });
      continue;
    }

    const sec = SECTION.exec(line);
    if (sec) {
      closeScene(i);
      const depth = sec[1].length;
      const entry: Section = { kind: depth === 1 ? 'act' : 'sequence', title: sec[2].trim(), synopsis: [], line: i };
      (depth === 1 ? acts : sequences).push(entry);
      synopsisTarget = entry;
      elements.push({ type: 'section', text: entry.title, depth, line: i });
      continue;
    }

    const syn = SYNOPSIS.exec(line);
    if (syn) {
      const text = syn[1].trim();
      if (synopsisTarget) synopsisTarget.synopsis.push(text);
      elements.push({ type: 'synopsis', text, line: i });
      continue;
    }

    const forced = FORCED_SCENE.exec(line);
    const isSlug = SLUGLINE.test(line);
    if (isSlug || forced) {
      closeScene(i);
      const heading = (forced ? forced[1] : trimmed).trim();
      const base = slugify(heading);
      const nth = (seen.get(base) ?? 0) + 1;
      seen.set(base, nth);
      current = {
        key: nth === 1 ? base : `${base}~${nth}`,
        n: scenes.length + 1,
        heading,
        body: '',
        synopsis: [],
        sequenceIndex: sequences.length - 1,
        fromLine: i,
        toLine: i,
      };
      synopsisTarget = current;
      elements.push({ type: 'scene_heading', text: heading, line: i });
      continue;
    }

    const centered = CENTERED.exec(line);
    if (centered) {
      elements.push({ type: 'centered', text: centered[1], line: i });
      continue;
    }

    const ftrans = FORCED_TRANSITION.exec(line);
    if (ftrans || TRANSITION.test(line)) {
      elements.push({ type: 'transition', text: (ftrans ? ftrans[1] : trimmed).trim(), line: i });
      continue;
    }

    if (isCharacter(line, lines[i + 1], i > 0 ? lines[i - 1] : undefined)) {
      elements.push({ type: 'character', text: trimmed.replace(/^@/, ''), line: i });
      continue;
    }

    // Dialogue and parentheticals follow a character cue until a blank line.
    const prev = elements[elements.length - 1];
    const inSpeech = prev && (prev.type === 'character' || prev.type === 'dialogue' || prev.type === 'parenthetical');
    if (inSpeech) {
      elements.push({
        type: PARENTHETICAL.test(line) ? 'parenthetical' : 'dialogue',
        text: trimmed,
        line: i,
      });
      continue;
    }

    elements.push({ type: 'action', text: trimmed, line: i });
  }

  closeScene(lines.length);

  return {
    preamble: lines.slice(0, preambleEnd).join('\n').trim(),
    elements,
    acts,
    sequences,
    scenes,
    title,
    credit,
    empty: scenes.length === 0 && !elements.some(e => e.type !== 'blank'),
  };
}

/** The scene with this key, or null. Identity, never position. */
export function findScene(script: ParsedScript, key: string): FountainScene | null {
  return script.scenes.find(s => s.key === key) ?? null;
}

/**
 * A scene as the agent should read it: heading, the writer's synopsis, and the
 * body verbatim. Verbatim because the agent is about to derive beats from it,
 * and a summary of a scene is not a scene.
 */
export function sceneText(scene: FountainScene): string {
  const out = [scene.heading];
  for (const s of scene.synopsis) out.push(`  = ${s}`);
  if (scene.body) out.push('', scene.body);
  return out.join('\n');
}

/** The sequence a scene belongs to, resolved. */
export function sequenceOf(script: ParsedScript, scene: FountainScene): Section | null {
  return scene.sequenceIndex >= 0 ? script.sequences[scene.sequenceIndex] ?? null : null;
}

/**
 * Which ACT something sits in — by line, not by a stored index.
 *
 * Fountain does not nest: `# ACT ONE` and `## SEQUENCE 1` are two flat lists of
 * sections that happen to appear in an order. What makes a sequence belong to an
 * act is simply that the act was declared above it and no other act has been
 * declared since — which is exactly what a reader understands from the page, and
 * the only thing the format actually says.
 *
 * Deriving it beats storing it: an index written at parse time would have to be
 * kept in step with every edit that moves a heading, and the failure mode is a
 * scene quietly filed under the wrong act. A line comparison cannot drift.
 *
 * -1 when nothing precedes it — a script with sequences and no acts is normal
 * (most short films), and so is one with neither.
 */
export function actIndexAtLine(script: ParsedScript, line: number): number {
  let at = -1;
  for (let i = 0; i < script.acts.length; i++) {
    if (script.acts[i]!.line <= line) at = i;
    else break;
  }
  return at;
}

/** The act a scene sits in, or null. See `actIndexAtLine`. */
export function actOf(script: ParsedScript, scene: FountainScene): Section | null {
  const at = actIndexAtLine(script, scene.fromLine);
  return at >= 0 ? script.acts[at] ?? null : null;
}

/**
 * A one-line-per-scene map of the whole script.
 *
 * The T1 tier: small enough to hold in context at every turn regardless of how
 * long the script gets, and enough to know where you are. Full scene text is
 * pulled on demand — see `renderScriptContext`.
 */
export function outline(script: ParsedScript): string {
  if (!script.scenes.length && !script.sequences.length) return '';
  const out: string[] = [];
  let act = -1;
  let seq = -1;
  for (const scene of script.scenes) {
    const s = sequenceOf(script, scene);
    if (s && script.sequences.indexOf(s) !== seq) {
      seq = script.sequences.indexOf(s);
      // Acts are printed when they change, so the reader keeps the big shape.
      const a = acts_before(script, s.line);
      if (a !== act) { act = a; if (a >= 0) out.push(`# ${script.acts[a].title}`); }
      out.push(`## ${s.title}${s.synopsis.length ? ` — ${s.synopsis[0]}` : ''}`);
    }
    out.push(`  ${scene.n}. [${scene.key}] ${scene.heading}`);
  }
  return out.join('\n');
}

function acts_before(script: ParsedScript, line: number): number {
  let idx = -1;
  script.acts.forEach((a, i) => { if (a.line <= line) idx = i; });
  return idx;
}

/**
 * Where line `line` starts in `text`, as a character offset.
 *
 * THE BRIDGE BETWEEN READING AND WRITING. The screenplay renders as a formatted
 * page built from parsed `Element`s, each of which remembers the source line it
 * came from, and it EDITS as raw Fountain in a textarea. Without a mapping
 * between those two the halves are unrelated documents that happen to be about
 * the same script — which is what made double-clicking scene 12 open the editor
 * at the end of the file, four hundred lines from the thing being pointed at.
 *
 * Clamped at both ends: a line past the end of the text resolves to the end,
 * which is the honest answer for a click on an element whose source has since
 * been rewritten.
 */
export function offsetOfLine(text: string, line: number): number {
  if (!Number.isFinite(line) || line <= 0) return 0;
  let at = 0;
  for (let i = 0; i < line; i++) {
    const next = text.indexOf('\n', at);
    if (next === -1) return text.length;
    at = next + 1;
  }
  return at;
}
