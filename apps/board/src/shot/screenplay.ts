/**
 * Board → screenplay. The one-way door.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD:
 *
 *   shot count in  ==  `SHOT n` heading count out  ==  item count in the project
 *   order preserved · every reference present on its shot · every role kept
 *
 * A user who hand-arranges twelve shots and gets nine back in a different order
 * will never trust the feature again, so the serialization is asserted against
 * the SAME parser the studio uses (`studio/src/spec/screenplay.ts`) before the
 * project is created — on the server, where the parser lives, and not "probably
 * fine because the format looks right".
 *
 * The heading grammar is fixed by that parser: `SHOT <n> — <heading>`.
 *
 * ── WHY THE HEADINGS SAY SHOT, NOT SCENE ─────────────────────────────────────
 * Because a SCENE is a different object now, and it is one level up: continuous
 * action in one place and time, which several shots may cover. Emitting `SCENE n`
 * for what is really one clip would mean the compiled document used the word for
 * something the board uses it for too, and a language model reading both would
 * have no way to tell which was meant.
 *
 * The studio's parser has always accepted `SHOT n` as well as `SCENE n`, so this
 * costs nothing downstream: the same headings parse, the same count is checked,
 * the same numbering reaches the timeline.
 *
 * ── TWO ARTIFACTS TRAVEL, AND THEY ARE NOT THE SAME DOCUMENT ─────────────────
 * The board holds ONE screenplay, in Fountain, written by a person. Compile
 * emits TWO things from it:
 *
 *   `script`      the Fountain source, verbatim. The writer's document. Kept so
 *                 the film can always be read as it was written, and so a later
 *                 edit round-trips instead of starting from a derivative.
 *
 *   `screenplay`  the PRODUCTION screenplay: `SHOT n` headings, one per shot, in
 *                 filmstrip order, with each shot's scene, action, references and
 *                 slots under it. This is what the studio parses and what the
 *                 video agent builds from.
 *
 * They are different because they answer different questions. The script says
 * what the film IS; the production screenplay says what to make, in the order
 * the timeline wants it, with the count the invariant checks. Deriving one from
 * the other at read time would mean re-parsing prose on every turn and getting a
 * different answer as the prose changed.
 *
 * The scene structure rides in the production screenplay's PREAMBLE, which the
 * studio keeps in context at every turn regardless of how long the film gets.
 * `SEQUENCE 1` and `SCENE 2 —` in the preamble cannot be mistaken for a shot
 * heading: the grammar requires SHOT/SCENE followed by digits AND the parser only
 * counts headings, so the preamble contributes nothing to the shot count.
 *
 * READING A SHOT IS NOW JUST READING ITS PROPS. This used to be a spatial query
 * over the canvas — whatever was geometrically inside a frame — which meant a
 * reference nudged a pixel out of bounds silently vanished from the compiled
 * video. A shot owns its media, so what compiles is exactly what the panel shows.
 */
import type { BlockStdScope } from '@blocksuite/std';

import {
  roleLabel, formatTime, isTimed, trimWindow,
  type MediaRole, type RefKind, type ShotMedia,
} from './model';
import { effectiveModel, referenceTag } from './models';
import { slotFills } from './slots';
import { readShots } from './shots';
import { readParsed, readScript } from './screenplay-doc';
import { sequenceOf, type ParsedScript } from './fountain';

export interface CompiledReference {
  id: string;
  role: MediaRole;
  kind: 'image' | 'video' | 'audio';
  /** FULL QUALITY. The panel draws a display variant; the render must not. */
  url: string;
  mediaId?: string;
  scope?: string;
  name: string;
  /** What it is OF, and the name the prompt calls it by. */
  refKind?: RefKind;
  tag?: string;
  /**
   * The positional tag the MODEL will see — `@Image2`, `@Video1`. Computed
   * against the shot's own model, because the spelling and the numbering are
   * both model-specific. Empty for models that do not read tags.
   */
  promptTag?: string;
  sourceUrl?: string;
  credit?: string;
  /** The user's direction for this reference, verbatim. */
  note?: string;
  /**
   * The seconds of the media that ARE the reference. Absent = the whole thing.
   *
   * Carried as numbers, not baked into the url: the file is not cut, and the
   * generation step is what applies the window. A url with `#t=` would be a
   * hint some consumers honour and others ignore.
   */
  inSec?: number;
  outSec?: number;
  durationSec?: number;
}

export interface CompiledShot {
  /** 1-based, and it is this shot's item number in the project. */
  n: number;
  id: string;
  title: string;
  /**
   * WHICH SCENE OF THE SCREENPLAY THIS SHOT COVERS, resolved at compile time.
   *
   * Resolved strings rather than keys, because the consumer is a video agent
   * that has never seen this board and cannot look a key up. All empty for an
   * off-script shot, which is legal and compiles normally.
   */
  sceneKey: string;
  /** The scene's number in the screenplay, 1-based. 0 when off-script. */
  scene: number;
  /** The scene's slugline: `INT. KITCHEN — DAY`. */
  sceneSlug: string;
  /** The sequence heading this scene sits under. Empty when there is none. */
  sequence: string;
  action?: string;
  voiceover?: string;
  camera?: string;
  /** Chosen per shot; empty means the project default. */
  model?: string;
  durationSec?: number;
  /**
   * What the studio should build.
   *
   * `video` for a generated clip and `hyperframes` for a composition — the
   * studio's own scene-kind vocabulary (`resolveSceneKind`), not the board's,
   * so nothing is translated on arrival. Every clip is `video` rather than
   * `avatar`: the avatar kind auto-attaches the presenter's likeness, and on a
   * board the references are the ones the user actually chose.
   */
  kind: 'video' | 'hyperframes';
  /** The HyperFrames block a graphic is built from, and its slot values. */
  composition?: string;
  compositionVars?: Record<string, string>;
  /** Slot-keyed values — media urls and typed words together. See below. */
  slots?: Array<{ key: string; kind: string; value: string }>;
  references: CompiledReference[];
}

export interface CompiledBoard {
  shots: CompiledShot[];
  screenplay: string;
  /**
   * The FOUNTAIN SOURCE, verbatim — the document the writer actually wrote.
   *
   * Carried alongside the production screenplay rather than instead of it, so
   * the film can always be read as written and a later edit round-trips through
   * a real screenplay instead of through a derivative of one.
   */
  script: string;
  /**
   * The structure as data, alongside the prose in `screenplay`.
   *
   * Both, deliberately: the prose is what a model reads, and this is what code
   * reads. Generated from the same parse in the same pass, so they cannot
   * disagree.
   */
  structure: {
    title: string;
    sequences: Array<{ n: number; title: string; synopsis: string }>;
    scenes: Array<{
      key: string; n: number; heading: string; synopsis: string;
      sequence: string; shotNumbers: number[];
    }>;
  };
  /**
   * Media the user left on the OPEN CANVAS.
   *
   * Reported so the confirm sheet can say what will NOT be carried over rather
   * than dropping it silently — "I had that clip on the board and it's not in
   * the video" is a bug report, and it is avoidable with one sentence.
   *
   * Exact now, where it used to be a guess: a shot owns its media, so anything
   * still sitting on the surface as its own block is by definition not in a
   * scene.
   */
  loose: number;
}

/** A heading the studio's parser reads back as one numbered unit. */
function shotHeading(n: number, title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim() || 'Untitled';
  // Strip a leading "SHOT 3 —" the user or agent may already have typed, so a
  // shot named that way does not compile to "SHOT 1 — SHOT 3 — Kitchen".
  return `SHOT ${n} — ${clean.replace(/^(?:SCENE|SHOT)\s+\d+\s*[—\-–:|]\s*/i, '')}`;
}

const REF_LABEL: Record<MediaRole, string> = {
  firstFrame: 'FIRST FRAME',
  lastFrame: 'LAST FRAME',
  motionRef: 'MOTION REF',
  reference: 'REFERENCE',
  sfx: 'SFX',
  bgm: 'MUSIC',
  background: 'BACKGROUND',
  figure: 'FIGURE',
  inset: 'INSET',
  logo: 'LOGO',
  texture: 'TEXTURE',
};

/** Slots first, then references — a planner reading top-down should meet the
 *  inputs that most change the output before the supporting material. The
 *  composition roles sit with the slots for the same reason: on a graphic they
 *  ARE the structure. */
const ROLE_ORDER: MediaRole[] = [
  'firstFrame', 'lastFrame', 'motionRef',
  'background', 'figure', 'inset', 'logo', 'texture',
  'reference', 'sfx', 'bgm',
];

function toReference(m: ShotMedia, promptTag: string): CompiledReference {
  const win = isTimed(m.kind) ? trimWindow(m) : null;
  return {
    id: m.id,
    role: m.role,
    kind: m.kind,
    url: m.url,
    mediaId: m.mediaId,
    scope: m.scope,
    name: m.name || m.kind,
    ...(m.refKind ? { refKind: m.refKind } : {}),
    ...(m.tag ? { tag: m.tag } : {}),
    ...(promptTag ? { promptTag } : {}),
    ...(m.sourceUrl ? { sourceUrl: m.sourceUrl } : {}),
    ...(m.credit ? { credit: m.credit } : {}),
    ...(m.note ? { note: m.note } : {}),
    // ONLY WHEN ACTUALLY TRIMMED. Emitting 0 → duration for every clip would
    // make the render step apply a cut to things nobody cut, and would make a
    // whole-clip reference indistinguishable from a deliberate full-length one.
    ...(win?.trimmed ? { inSec: win.start, outSec: win.end } : {}),
    ...(m.durationSec ? { durationSec: m.durationSec } : {}),
  };
}

/**
 * One line of the reference legend.
 *
 * `@Image2 — sarah (character): sarah-portrait.jpg`
 *
 * THIS LINE IS THE WHOLE POINT OF TAGS. A generation model receives references
 * as bare numbers and the prompt has to address them the same way, so without a
 * legend a motion prompt reads "@Image2 turns to the window" and nobody — not
 * the user, not the agent on its next turn, not whoever debugs the output — can
 * say what @Image2 was. With it, the number and the meaning travel together.
 */
function legendLine(ref: CompiledReference): string {
  const what = [ref.tag, ref.refKind].filter(Boolean).join(', ');
  const head = ref.promptTag ? `${ref.promptTag} — ` : '';
  const label = what ? `${what}: ` : '';
  // The window and the direction ride on the same line as the reference they
  // belong to. Split across lines they read as separate instructions, and the
  // planner has to guess which reference "use this under the intro" is about.
  const window = ref.inSec !== undefined && ref.outSec !== undefined
    ? ` [${formatTime(ref.inSec)}–${formatTime(ref.outSec)}]`
    : '';
  const note = ref.note ? ` — ${ref.note.replace(/\s+/g, ' ')}` : '';
  return `  ${head}${label}${ref.name}${window}${note}`;
}

export function compileBoard(
  std: BlockStdScope,
  header: { title: string; aspect: string; goal: string },
): CompiledBoard {
  /**
   * THE SCREENPLAY IS READ FIRST, and it is optional.
   *
   * A board with no screenplay compiles exactly as it always did — every shot is
   * off-script and nothing else changes. That is the flexibility rule applied to
   * compile: someone who sketched twelve shots without writing a word has done
   * nothing wrong and must not be stopped.
   */
  const script = readScript(std);
  const parsed = readParsed(std);
  const sceneIndex = new Map(parsed.scenes.map(c => [c.key, c] as const));

  const shots = readShots(std).map((shot, i): CompiledShot => {
    const caps = effectiveModel(shot.model);
    /**
     * ROLE ORDER FIRST, THEN TAG NUMBERS FROM THAT ORDER.
     *
     * The positional tag a model sees is its index in the list it is HANDED, so
     * the numbering has to be computed after the sort, not from the board's
     * storage order. Numbering first and sorting second would produce a legend
     * that disagrees with the payload — the worst kind of wrong, because
     * everything looks present and one reference silently means another.
     */
    const ordered = [...shot.media]
      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));

    const isGraphic = shot.kind === 'hyperframes';
    // Resolved once — the same function the card previews from, so what the
    // user saw and what is compiled cannot disagree.
    const graphicSlots = isGraphic ? slotFills(shot) : [];

    const placed = sceneIndex.get(shot.sceneKey);
    const seq = placed ? sequenceOf(parsed, placed) : null;

    return {
      n: i + 1,
      id: shot.id,
      title: shot.title,
      // Resolved only when the key still names a scene. A shot whose slugline
      // was renamed away compiles as off-script rather than as a wrong scene.
      sceneKey: placed ? shot.sceneKey : '',
      scene: placed?.n ?? 0,
      sceneSlug: placed?.heading ?? '',
      sequence: seq?.title ?? '',
      // Only what the user actually WROTE. An empty field must not become a line
      // in the screenplay: the planner would treat it as an approved description.
      ...(shot.action.trim() ? { action: shot.action.trim() } : {}),
      ...(shot.voiceover.trim() ? { voiceover: shot.voiceover.trim() } : {}),
      // CAMERA is a clip's framing and movement. A graphic has neither — it is
      // rendered from a layout — so carrying it would put a camera direction on
      // a scene with no camera.
      ...(!isGraphic && shot.camera.trim() ? { camera: shot.camera.trim() } : {}),
      // A graphic is not generated, so its model is meaningless.
      ...(!isGraphic && shot.model ? { model: shot.model } : {}),
      ...(shot.durationSec > 0 ? { durationSec: shot.durationSec } : {}),
      kind: isGraphic ? 'hyperframes' as const : 'video' as const,
      ...(isGraphic && shot.composition ? { composition: shot.composition } : {}),
      ...(isGraphic && Object.keys(shot.compositionVars ?? {}).length
        ? { compositionVars: shot.compositionVars }
        : {}),
      /**
       * WHAT GOES IN THE BLOCK, resolved and slot-keyed.
       *
       * This is the shape `compose_scene({ block, slots })` already takes, so
       * the pipeline reads one map instead of reassembling it from a media
       * list, a variables object and a role vocabulary. The dropped picture and
       * the typed headline arrive as peers, because to the composition that is
       * exactly what they are.
       */
      ...(isGraphic && graphicSlots.length ? { slots: graphicSlots } : {}),
      references: ordered.map(m => toReference(m, referenceTag(caps, ordered, m.id))),
    };
  });

  // Which shots ended up on which scene — reported, so "scene 3 has no shots"
  // is a fact downstream rather than something to be inferred.
  const shotsByScene = new Map<string, number[]>();
  for (const shot of shots) {
    if (!shot.sceneKey) continue;
    const list = shotsByScene.get(shot.sceneKey) ?? [];
    list.push(shot.n);
    shotsByScene.set(shot.sceneKey, list);
  }

  const preamble = [
    header.title.trim() || parsed.title.trim() || 'Untitled',
    header.aspect ? `Aspect: ${header.aspect}` : '',
    header.goal.trim() ? `Goal: ${header.goal.trim()}` : '',
    /**
     * THE NUMBERING LEGEND — one line that stops a downstream agent guessing.
     *
     * Two things are numbered here and they are not the same: SCENE n is a scene
     * of the written screenplay, which several shots may cover, and SHOT n is
     * one clip. State the mapping outright rather than trusting inference.
     */
    parsed.scenes.length
      ? 'Numbering: SEQUENCE headings are runs of the film, SCENE n are the '
        + 'written scenes, and SHOT n below are the individual clips — shot n is '
        + 'item n on the timeline. Several shots may cover one scene.'
      : '',
    structureBlock(parsed, shotsByScene),
  ].filter(Boolean).join('\n');

  const body = shots.map(shot => {
    const lines = [shotHeading(shot.n, shot.title)];
    // WHERE THIS SHOT BELONGS, restated on the shot itself. The structure block
    // above already says it, but a long screenplay is read in slices — and the
    // slice a video agent loads is this one.
    if (shot.scene) {
      const seq = shot.sequence ? `${shot.sequence} · ` : '';
      lines.push(`  COVERS: ${seq}SCENE ${shot.scene} — ${shot.sceneSlug}`);
    }
    // WHAT THE USER WROTE COMES FIRST: it is the scene's meaning, and the
    // references are the material it is made from.
    if (shot.action) lines.push(`  ACTION: ${shot.action.replace(/\s+/g, ' ')}`);
    if (shot.voiceover) lines.push(`  VO: ${shot.voiceover.replace(/\s+/g, ' ')}`);
    if (shot.camera) lines.push(`  CAMERA: ${shot.camera.replace(/\s+/g, ' ')}`);
    if (shot.durationSec) lines.push(`  LENGTH: ${shot.durationSec}s`);
    if (shot.kind === 'hyperframes') {
      lines.push(`  GRAPHIC: ${shot.composition || 'block not chosen'}`);
      // The slot values ARE the copy on screen — the words the viewer reads.
      // Left out of the screenplay they would be invisible to the planner, and
      // a graphic scene would read as having no content at all.
      Object.entries(shot.compositionVars ?? {})
        .filter(([, v]) => String(v).trim())
        .forEach(([k, v]) => lines.push(`    ${k}: ${String(v).replace(/\s+/g, ' ')}`));
    } else if (shot.model) {
      lines.push(`  MODEL: ${shot.model}`);
    }
    shot.references.forEach(r => lines.push(`  ${REF_LABEL[r.role] ?? roleLabel(r.role)}: ${r.name}`));

    /**
     * The legend — emitted when any reference has something the bare
     * `ROLE: name` lines above cannot carry.
     *
     * NOT gated on the model reading @-tags, which is what it used to be and was
     * wrong: a trim window and a usage direction are the USER'S decisions and
     * matter on every model. Gating on tags meant "use this sting under the
     * intro" and "these four seconds" were silently dropped for Grok and Kling —
     * the two things hardest to notice missing, because the reference is still
     * there and still listed.
     */
    const annotated = shot.references.filter(
      r => r.promptTag || r.tag || r.note || r.inSec !== undefined,
    );
    if (annotated.length) {
      lines.push('  REFERENCES:');
      annotated.forEach(r => lines.push(`  ${legendLine(r)}`));
    }
    return lines.join('\n');
  }).join('\n\n');

  const loose = ['affine:image', 'affine:attachment']
    .reduce((n, flavour) => n + std.store.getBlocksByFlavour(flavour).length, 0);

  const structure = {
    title: parsed.title,
    sequences: parsed.sequences.map((q, i) => ({
      n: i + 1,
      title: q.title,
      synopsis: q.synopsis.join(' '),
    })),
    scenes: parsed.scenes.map(c => ({
      key: c.key,
      n: c.n,
      heading: c.heading,
      synopsis: c.synopsis.join(' '),
      sequence: sequenceOf(parsed, c)?.title ?? '',
      shotNumbers: shotsByScene.get(c.key) ?? [],
    })),
  };

  return { shots, screenplay: `${preamble}\n\n${body}\n`, script, loose, structure };
}

/** Human summary of one shot, for the agent's digest. */
export function describeShot(shot: { media: ShotMedia[] }): string {
  if (!shot.media.length) return 'empty';
  const counts = new Map<MediaRole, number>();
  for (const m of shot.media) counts.set(m.role, (counts.get(m.role) ?? 0) + 1);
  return [...counts].map(([role, n]) => `${n} ${roleLabel(role).toLowerCase()}`).join(', ');
}

/**
 * The written structure, as the production screenplay's preamble carries it.
 *
 * Sequences and their scenes, each scene naming the shots that cover it. This is
 * where a downstream agent learns that shots 4 and 5 are two angles on one
 * moment rather than two different moments — which decides whether they should
 * match, cut together, and share a look.
 */
function structureBlock(
  script: ParsedScript,
  shotsByScene: Map<string, number[]>,
): string {
  if (!script.scenes.length) return '';
  const out: string[] = ['', 'STRUCTURE'];
  let seq: string | null = null;
  for (const scene of script.scenes) {
    const s = sequenceOf(script, scene);
    const title = s?.title ?? '';
    if (title !== seq) {
      seq = title;
      out.push(title ? `  ${title}` : '  (no sequence)');
      if (s?.synopsis.length) out.push(`    ${s.synopsis.join(' ')}`);
    }
    const covers = shotsByScene.get(scene.key) ?? [];
    /**
     * PREFIXED WITH `·`, AND THAT IS LOAD-BEARING.
     *
     * The studio's heading grammar is `^\s*(?:SCENE|SHOT)\s+\d+` — `^\s*`
     * allows leading whitespace, so an INDENTED `SCENE 1 — …` in this block
     * parses as a numbered heading and inflates the shot count. Measured: a
     * 4-shot board reported 7, which would fail the compile invariant outright.
     *
     * The middot stops the line matching while leaving it perfectly readable.
     * Do not remove it, and do not start any line in this block with SCENE or
     * SHOT followed by a number.
     */
    out.push(`    · SCENE ${scene.n} — ${scene.heading}`);
    if (scene.synopsis.length) out.push(`      ${scene.synopsis.join(' ')}`);
    out.push(covers.length
      ? `      SHOTS: ${covers.join(', ')}`
      : '      SHOTS: none');
  }
  return out.join('\n');
}
