/**
 * Board → screenplay. The one-way door.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD:
 *
 *   shot count in  ==  `SCENE n` beat count out  ==  scene count in the project
 *   order preserved · every reference present on its scene · every role kept
 *
 * A user who hand-arranges twelve shots and gets nine back in a different order
 * will never trust the feature again, so the serialization is asserted against
 * the SAME parser the studio uses (`studio/src/spec/screenplay.ts`) before the
 * project is created — on the server, where the parser lives, and not "probably
 * fine because the format looks right".
 *
 * The heading grammar is fixed by that parser: `SCENE <n> — <heading>`.
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
  /** 1-based, and it is the scene number in the project. */
  n: number;
  id: string;
  title: string;
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

/** A heading the studio's parser reads back as one beat. */
function beatHeading(n: number, title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim() || 'Untitled';
  // Strip a leading "SCENE 3 —" the user or agent may already have typed, so a
  // shot named that way does not compile to "SCENE 1 — SCENE 3 — Kitchen".
  return `SCENE ${n} — ${clean.replace(/^(?:SCENE|SHOT)\s+\d+\s*[—\-–:|]\s*/i, '')}`;
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

    return {
      n: i + 1,
      id: shot.id,
      title: shot.title,
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

  const preamble = [
    header.title.trim() || 'Untitled',
    header.aspect ? `Aspect: ${header.aspect}` : '',
    header.goal.trim() ? `Goal: ${header.goal.trim()}` : '',
  ].filter(Boolean).join('\n');

  const body = shots.map(shot => {
    const lines = [beatHeading(shot.n, shot.title)];
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

  return { shots, screenplay: `${preamble}\n\n${body}\n`, loose };
}

/** Human summary of one shot, for the agent's digest. */
export function describeShot(shot: { media: ShotMedia[] }): string {
  if (!shot.media.length) return 'empty';
  const counts = new Map<MediaRole, number>();
  for (const m of shot.media) counts.set(m.role, (counts.get(m.role) ?? 0) + 1);
  return [...counts].map(([role, n]) => `${n} ${roleLabel(role).toLowerCase()}`).join(', ');
}
