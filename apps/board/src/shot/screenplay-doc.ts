/**
 * The screenplay — the stage that was missing.
 *
 * ── WHY A BOARD NEEDS ONE ────────────────────────────────────────────────────
 * The board went straight from "describe your video" to a filmstrip of shots.
 * That skips what a real production decides first: the STRUCTURE — what runs of
 * the film exist, what each one has to accomplish, where the hook is, where it
 * turns. Shots are how a section gets photographed; they are not a substitute
 * for knowing what the section is.
 *
 * Skipping it costs twice. The user gets a shot list with no spine, so "is this
 * working?" has no answer beyond taste. And the AGENT has nothing to reason
 * with: asked to improve shot 4 it can only talk about shot 4, because nothing
 * anywhere says shot 4 is the turn and the whole film hangs off it.
 *
 * ── THE VOCABULARY, AND WHY IT IS THIS ONE ───────────────────────────────────
 *      Screenplay  →  Sequence  →  Scene  →  Shot
 *
 * Standard film grammar, kept whole rather than collapsed:
 *
 *   SEQUENCE  a run with ONE JOB — the hook, the turn, the payoff.
 *   SCENE     continuous action in ONE PLACE AND TIME. That is what makes a
 *             scene a scene, which is why it carries a slug: INT. KITCHEN — DAY.
 *   SHOT      one uninterrupted take. One generated clip. One item on the
 *             editor's timeline.
 *
 * This is the SAME ladder the video editor uses. It is not board vocabulary that
 * gets translated on the way out — a sequence here is a sequence there, and a
 * shot here is the thing the editor builds. That is the whole reason to spell it
 * correctly: two halves of one product that name the same object differently
 * will eventually disagree about it.
 *
 * ── EACH LEVEL GETS ITS OWN TOKEN SPACE ──────────────────────────────────────
 * Sequences are NUMBERED (SEQUENCE 1), scenes are LETTERED (SCENE A), shots are
 * NUMBERED (SHOT 1). Not decoration — it is what stops two different things from
 * ever both being "2", in a document a language model has to read.
 *
 * Neither "beat" nor "act" appears anywhere. A beat is a story-analysis note
 * rather than a container, and an act is a feature-length division that carries
 * no information at the twenty to ninety seconds this product makes. Both were
 * removed from the editor at the same time as this was written, so there is one
 * vocabulary in the whole system rather than one per surface.
 *
 * ── WHAT EACH LEVEL IS THE RIGHT SCOPE FOR ───────────────────────────────────
 * This is why the levels earn their keep rather than being taxonomy:
 *
 *   sequence  music cue, pacing budget, overall look
 *   scene     location, time of day, continuity within the moment
 *   shot      camera, model, duration, references, SFX, narration
 *
 * ── WHERE IT LIVES ───────────────────────────────────────────────────────────
 * A BLOCK on the surface, exactly like a shot — same schema shape, same parent,
 * same persistence, same undo. Not hidden document state: the screenplay is a
 * thing the user reads and edits, so it is a thing they can see, select, move
 * and type into. Making it a block means every mechanism that already works for
 * shots — collaborative editing, Ctrl+Z, the flush that saves the board, the
 * agent's RPC — works for it with no second path to keep in sync.
 *
 * There is at most ONE per board. `ensureScreenplay` is the only constructor, so
 * a second cannot be created by accident, and `readScreenplay` always resolves
 * to the same object.
 *
 * ── HOW THE LEVELS LINK ──────────────────────────────────────────────────────
 * ONE parent pointer each, never two:
 *
 *   shot.sceneId  →  scene.sequenceId  →  sequence
 *
 * A shot does NOT also carry a sequenceId. Two pointers can disagree, and the
 * day they do, "which sequence is this shot in?" has two answers and the runtime
 * budget silently double-counts. Derive it; do not store it twice.
 *
 * Every pointer may be empty, at every level, and that is a supported state
 * rather than a broken one. Someone sketching shots before writing a screenplay
 * is working normally; a scene not yet placed in a sequence is a decision not yet
 * made. Nothing in the pipeline requires any of it — an entirely unstructured
 * board compiles exactly as it always did.
 */
import { BlockModel, BlockSchemaExtension, defineBlockSchema } from '@blocksuite/store';
import type { BlockStdScope } from '@blocksuite/std';
import { GfxCompatible, type GfxCommonBlockProps } from '@blocksuite/std/gfx';

/** What a sequence is DOING in the film. The vocabulary is deliberately small. */
export const SEQUENCE_PURPOSES = [
  'hook', 'setup', 'context', 'turn', 'escalate', 'proof', 'payoff', 'cta',
] as const;
export type SequencePurpose = (typeof SEQUENCE_PURPOSES)[number];

export const PURPOSE_HINT: Record<SequencePurpose, string> = {
  hook: 'The first seconds. Earns the next ten.',
  setup: 'Who and where, only as much as is needed.',
  context: 'The fact the payoff will depend on.',
  turn: 'Where the video stops being what it seemed.',
  escalate: 'Raises what is at stake.',
  proof: 'The evidence — a demo, a number, a receipt.',
  payoff: 'What the hook promised, delivered.',
  cta: 'The one thing to do next.',
};

export interface Sequence {
  /**
   * STABLE for the life of the board. Shots point at it, so renaming a sequence
   * must not orphan its shots and reordering must not reassign them.
   */
  id: string;
  /** A few words a human recognises: "the leak lands". */
  title: string;
  purpose: SequencePurpose;
  /** What has to happen here, in the writer's words. */
  summary: string;
  /** Roughly how long this run should play. A budget, not a promise. */
  targetSec: number;
  /**
   * The music cue for this run, if the user has chosen one.
   *
   * Here rather than on a shot because that is the scope a cue actually has —
   * music changes at a sequence boundary. Empty means "carry on with whatever
   * the previous sequence was playing", which is also what a composer means.
   */
  music: string;
  /** Look/tone direction that applies to every shot in the run. */
  look: string;
}

/**
 * A SCENE — continuous action in one place and time.
 *
 * The level between a sequence and a shot, and the one that makes coverage
 * possible: three angles on the same moment are three shots in ONE scene, which
 * is how a person plans them and how continuity gets checked. Without it, "the
 * kitchen conversation" is three unrelated cards that merely happen to be
 * adjacent.
 */
export interface Scene {
  /** STABLE for the life of the board — shots point at it. */
  id: string;
  /**
   * Which sequence this scene belongs to. Empty = not placed yet, which is a
   * normal intermediate state and not an error.
   */
  sequenceId: string;
  /**
   * The slugline: `INT. KITCHEN — DAY`. Place and time, which is the ONLY thing
   * that defines a scene's boundaries — the moment either changes, it is a new
   * scene. Free text rather than parsed fields, because a video is as likely to
   * want "PHONE SCREEN" or "TITLE CARD" as a location.
   */
  slug: string;
  /** What happens here, in the writer's words. */
  summary: string;
}

/** The screenplay as a plain, structured-clone-safe object. */
export interface Screenplay {
  title: string;
  /** One sentence: what the video IS. The thing to keep re-reading. */
  logline: string;
  /** Who it is for and where it plays — decides pacing more than genre does. */
  audience: string;
  /** narrator | dialogue | hybrid — mirrors the studio's own vocabulary. */
  voice: string;
  /** Free-form direction: references, tone, what to avoid. The studio calls
   *  this `researchNotes` and treats it as the most important creative input. */
  notes: string;
  sequences: Sequence[];
  scenes: Scene[];
}

/**
 * A scene's display label: A, B, … Z, AA, AB.
 *
 * LETTERED so a board scene can never be mistaken for a timeline scene, which is
 * numbered and means one clip. See the token-space note in the file header.
 */
export function sceneLetter(i: number): string {
  let n = i;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

export type ScreenplayProps = Screenplay & GfxCommonBlockProps;

/** Panel geometry. Sits to the LEFT of shot 1 — it is what the shots come from. */
export const SCREENPLAY_W = 560;
export const SCREENPLAY_H = 720;

export const ScreenplayBlockSchema = defineBlockSchema({
  flavour: 'voidspace:screenplay',
  props: (): ScreenplayProps => ({
    title: '',
    logline: '',
    audience: '',
    voice: '',
    notes: '',
    sequences: [],
    scenes: [],
    xywh: `[0,0,${SCREENPLAY_W},${SCREENPLAY_H}]`,
    index: 'a0',
    lockedBySelf: false,
    scale: 1,
    rotate: 0,
  }),
  metadata: {
    version: 1,
    role: 'content',
    parent: ['affine:surface'],
    children: [],
  },
  toModel: () => new ScreenplayBlockModel(),
});

export class ScreenplayBlockModel extends GfxCompatible<ScreenplayProps>(BlockModel) {}

export const ScreenplayBlockSchemaExtension = BlockSchemaExtension(ScreenplayBlockSchema);

export function emptyScreenplay(): Screenplay {
  return {
    title: '', logline: '', audience: '', voice: '', notes: '',
    sequences: [], scenes: [],
  };
}

function normaliseSequence(raw: unknown, i: number): Sequence {
  const q = (raw ?? {}) as Partial<Sequence>;
  const purpose = SEQUENCE_PURPOSES.includes(q.purpose as SequencePurpose)
    ? (q.purpose as SequencePurpose)
    : 'setup';
  return {
    id: String(q.id || `s${i + 1}`),
    title: String(q.title ?? ''),
    purpose,
    summary: String(q.summary ?? ''),
    targetSec: Number(q.targetSec) > 0 ? Number(q.targetSec) : 0,
    music: String(q.music ?? ''),
    look: String(q.look ?? ''),
  };
}

function normaliseScene(raw: unknown, i: number): Scene {
  const c = (raw ?? {}) as Partial<Scene>;
  return {
    id: String(c.id || `c${i + 1}`),
    sequenceId: String(c.sequenceId ?? ''),
    slug: String(c.slug ?? ''),
    summary: String(c.summary ?? ''),
  };
}

/** The board's screenplay block, or null when the user has not started one. */
export function screenplayBlock(std: BlockStdScope): ScreenplayBlockModel | null {
  const found = std.store.getBlocksByFlavour('voidspace:screenplay');
  return (found[0]?.model as ScreenplayBlockModel | undefined) ?? null;
}

/**
 * The screenplay as plain data.
 *
 * Every field is COPIED. What is stored on a block is a reactive proxy, and
 * structured clone refuses those — the exact failure that once made `board_read`
 * return an error for a whole board. See [[feedback-iframe-boundary-plain-data]].
 */
export function readScreenplay(std: BlockStdScope): Screenplay {
  const model = screenplayBlock(std);
  if (!model) return emptyScreenplay();
  const p = model.props;
  return {
    title: String(p.title ?? ''),
    logline: String(p.logline ?? ''),
    audience: String(p.audience ?? ''),
    voice: String(p.voice ?? ''),
    notes: String(p.notes ?? ''),
    sequences: Array.isArray(p.sequences) ? p.sequences.map(normaliseSequence) : [],
    scenes: Array.isArray(p.scenes) ? p.scenes.map(normaliseScene) : [],
  };
}

/**
 * The board's screenplay block, created if this board has none.
 *
 * Placed to the LEFT of the filmstrip's origin, so it reads before shot 1 in the
 * direction the board is laid out — the document the shots come from, sitting
 * where a reader would look first.
 */
export function ensureScreenplay(
  std: BlockStdScope,
  surfaceId: string,
): ScreenplayBlockModel {
  const existing = screenplayBlock(std);
  if (existing) return existing;
  const id = std.store.addBlock(
    'voidspace:screenplay',
    { xywh: `[${-(SCREENPLAY_W + 120)},0,${SCREENPLAY_W},${SCREENPLAY_H}]` },
    surfaceId,
  );
  return std.store.getBlock(id)!.model as ScreenplayBlockModel;
}

/**
 * Write the screenplay, as ONE undoable action.
 *
 * `transact` so a rewrite of six sequences is one Ctrl+Z rather than six — the
 * same rule every other board mutation follows, and the reason an agent's edit
 * can be taken back in a single gesture.
 */
export function writeScreenplay(
  std: BlockStdScope,
  surfaceId: string,
  patch: Partial<Screenplay>,
): Screenplay {
  const model = ensureScreenplay(std, surfaceId);
  std.store.transact(() => {
    for (const k of ['title', 'logline', 'audience', 'voice', 'notes'] as const) {
      if (typeof patch[k] === 'string') model.props[k] = patch[k]!;
    }
    if (patch.sequences) model.props.sequences = patch.sequences.map(normaliseSequence);
    if (patch.scenes) model.props.scenes = patch.scenes.map(normaliseScene);
  });
  return readScreenplay(std);
}

/** Mint an id that will not collide with an existing sequence. */
export function nextSequenceId(existing: Sequence[]): string {
  let n = existing.length + 1;
  const taken = new Set(existing.map(q => q.id));
  while (taken.has(`s${n}`)) n++;
  return `s${n}`;
}

/** Mint a scene id that will not collide with an existing one. */
export function nextSceneId(existing: Scene[]): string {
  let n = existing.length + 1;
  const taken = new Set(existing.map(c => c.id));
  while (taken.has(`c${n}`)) n++;
  return `c${n}`;
}

/** True when there is enough here to be worth showing. */
export function hasScreenplay(s: Screenplay): boolean {
  return !!(s.logline.trim() || s.sequences.length || s.scenes.length);
}

/** Total of every sequence's budget — what the film is planned to run. */
export function plannedRuntimeSec(s: Screenplay): number {
  return s.sequences.reduce((n, q) => n + (q.targetSec > 0 ? q.targetSec : 0), 0);
}

/**
 * The structure, as the compiled screenplay's PREAMBLE should carry it.
 *
 * ── WHY THE PREAMBLE, SPECIFICALLY ───────────────────────────────────────────
 * The studio's parser splits a screenplay at `SHOT n` headings and keeps
 * everything before the first one as the preamble, which it holds in context at
 * EVERY turn no matter how long the film gets. So the structure belongs there:
 * it is small, it is globally relevant, and it is the one part guaranteed never
 * to be sliced away.
 *
 * `SEQUENCE 1` and `SCENE A` cannot be mistaken for shot headings — that parser
 * matches only `SHOT`/`SCENE` followed by DIGITS — so adding this cannot change
 * the shot count, which is the invariant compile refuses to break.
 *
 * ── WHY PROSE, NOT JSON ──────────────────────────────────────────────────────
 * Its destination is a PROMPT. The studio planner and the video agent both read
 * `spec.screenplay` as text, and a JSON blob in the middle of a system prompt is
 * something a model has to parse before it can think.
 */
export function formatStructure(
  s: Screenplay,
  shotsByScene: Map<string, number[]> = new Map(),
): string {
  if (!s.sequences.length && !s.scenes.length) return '';
  const out: string[] = ['STRUCTURE'];

  const letterOf = new Map(s.scenes.map((c, i) => [c.id, sceneLetter(i)] as const));

  const renderScene = (c: Scene, indent: string): void => {
    const shots = shotsByScene.get(c.id) ?? [];
    const slug = c.slug.trim() || 'unplaced';
    out.push(`${indent}SCENE ${letterOf.get(c.id)} — ${slug}`);
    if (c.summary.trim()) out.push(`${indent}  ${c.summary.replace(/\s+/g, ' ').trim()}`);
    out.push(shots.length
      ? `${indent}  SHOTS: ${shots.join(', ')}`
      : `${indent}  SHOTS: none yet`);
  };

  s.sequences.forEach((q, i) => {
    const dur = q.targetSec ? ` · ${q.targetSec}s` : '';
    const title = q.title.trim() ? ` — ${q.title.trim()}` : '';
    out.push('', `SEQUENCE ${i + 1} · ${q.purpose.toUpperCase()}${dur}${title}`);
    if (q.summary.trim()) out.push(`  ${q.summary.replace(/\s+/g, ' ').trim()}`);
    if (q.look.trim()) out.push(`  LOOK: ${q.look.replace(/\s+/g, ' ').trim()}`);
    if (q.music.trim()) out.push(`  MUSIC: ${q.music.replace(/\s+/g, ' ').trim()}`);
    const scenes = s.scenes.filter(c => c.sequenceId === q.id);
    if (!scenes.length) out.push('  SCENES: none yet');
    else scenes.forEach(c => renderScene(c, '  '));
  });

  // Scenes nobody has placed in a sequence yet. Listed rather than dropped: a
  // scene with shots in it is real work, and silently omitting it from the
  // structure is how a downstream agent concludes those shots do not belong.
  const loose = s.scenes.filter(c => !s.sequences.some(q => q.id === c.sequenceId));
  if (loose.length) {
    out.push('', 'NOT IN ANY SEQUENCE');
    loose.forEach(c => renderScene(c, '  '));
  }
  return out.join('\n');
}

/** The label a shot card shows for its scene: "A · INT. KITCHEN". '' if none. */
export function sceneLabel(s: Screenplay, sceneId: string): string {
  const i = s.scenes.findIndex(c => c.id === sceneId);
  if (i < 0) return '';
  const slug = s.scenes[i].slug.trim();
  return slug ? `${sceneLetter(i)} · ${slug}` : sceneLetter(i);
}

/** The sequence a shot ends up in, resolved THROUGH its scene. See the header:
 *  one parent pointer per level, so this is derived and never stored twice. */
export function sequenceOfScene(s: Screenplay, sceneId: string): Sequence | null {
  const scene = s.scenes.find(c => c.id === sceneId);
  if (!scene) return null;
  return s.sequences.find(q => q.id === scene.sequenceId) ?? null;
}
