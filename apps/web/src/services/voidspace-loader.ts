/**
 * Voidspace Loader — Fetches scene lists from Firestore and transforms them
 * into OpenReel Project objects for the video editor timeline.
 */

import { auth, db, storage } from "../config/firebase-config";
import { onAuthStateChanged } from "firebase/auth";
import { getDownloadURL, ref as storageRef } from "firebase/storage";
import { useVoidspaceStore } from "../stores/voidspace-store";
import { buildVoidspaceProjectId } from "./voidspace-project-id";
import {
  collection,
  getDocs,
  doc,
  getDoc,
  query,
  orderBy,
  onSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import type {
  Project,
  ProjectSettings,
  MediaItem,
  MediaMetadata,
  Timeline,
  Track,
  Clip,
  Subtitle,
  TextClip,
  CompoundClip,
  Transition,
  TransitionType,
} from "@openreel/core";
// Screenplay sequences → nested sequences on the timeline. See NEST_SEQUENCES
// below; the mapping is built and tested, and gated until the editor can open
// one.
import { buildSequenceCompounds } from "@openreel/core";

// ────────────────────────────────────────────
// Types matching Firestore document shapes
// ────────────────────────────────────────────

export interface VoidspaceSceneList {
  id: string;
  name?: string;
  // Automation writes the list's display name here, not `name`.
  title?: string;
  mood?: string;
  avatar_id?: string;
  avatar_name?: string;
  status?: string;
  created_at?: { seconds: number };
  updated_at?: { seconds: number };
  scene_count?: number;
  music_url?: string;
  music_title?: string;
  music_volume?: number;
  content_type?: string;
  aspect_ratio?: string;
  video_url?: string;
  video_description?: string;
  description?: string;
  content?: string;
  caption?: string;
  post_description?: string;
  thumbnail_url?: string;
  review_id?: string;
}

/**
 * THE KEY EVERY MEDIA AND CLIP ID IS BUILT FROM.
 *
 * ── ONE FUNCTION, BECAUSE TWO PLACES DERIVE IT AND THEY MUST NOT DRIFT ──────
 * The per-scene rebuild mints ids from it, and the STALE-BLOB PROBE reconstructs
 * the same prefixes to ask "does the saved timeline already cover this scene?".
 * When those two disagree the probe matches nothing, every scene looks missing,
 * and the loader throws away the user's saved arrangement and rebuilds from
 * board order — on every single load.
 *
 * That is not hypothetical: it is exactly what happened when the rebuild moved
 * to `source_shot_id` and the probe was left on `_docId`. Nothing errored. The
 * timeline simply reverted to storyboard order every time the project opened,
 * and the only visible symptom was a user's edit quietly undoing itself.
 *
 * `source_shot_id` is stable for the life of a shot, so inserting a shot above
 * another does not change its ids (see `compile.post.ts`). `_docId` — the scene
 * NUMBER — is the fallback for projects that never came from a board, and it is
 * what those projects have always used.
 */
export function sceneIdKey(scene: { _docId: string; source_shot_id?: string }): string {
  return String(scene.source_shot_id || scene._docId);
}

/**
 * KEEP THE USER'S CUT; ADD ONLY WHAT IS NEW.
 *
 * ── THE BEHAVIOUR THIS REPLACES ─────────────────────────────────────────────
 * The saved `project_state` blob IS the user's arrangement — every trim, every
 * reorder, every clip they moved. The loader prefers it, except when it looks
 * STALE: Firestore has scene media the blob does not cover. Until now "stale"
 * meant DISCARD, and the loader rebuilt every track from scene docs in
 * storyboard order.
 *
 * So adding one shot to the board and recompiling threw away the entire edit.
 * Not a crash, not a warning — the timeline simply reverted to board order, and
 * the more work somebody had done the more they lost. It is the single reason
 * "go back and add a shot" was unsafe once you had started editing.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * The saved arrangement wins for everything it already contains. Clips it has
 * never seen — identified by id, which is stable per shot (`sceneIdKey`) — are
 * APPENDED after the end of the saved timeline. Nothing is reordered, nothing
 * is removed, nothing is retimed except the genuinely new material.
 *
 * ── ONE DELTA FOR EVERY TRACK, AND THAT IS THE SUBTLE PART ──────────────────
 * A scene is not one clip: it is a video clip, a narration clip, possibly music
 * and alternate takes, all at the SAME instant. Appending each track
 * independently — "put the new clip after whatever this track ends with" —
 * would slide them apart from each other, and a shot's voiceover would drift
 * off its picture. So the shift is computed ONCE across all new clips and
 * applied uniformly: their internal sync is preserved exactly.
 *
 * ── WHY APPEND RATHER THAN INSERT ───────────────────────────────────────────
 * The board says where a shot sits on the BOARD. Once the user has rearranged
 * the timeline, that no longer maps onto anything: inserting into the middle of
 * their cut means guessing where they would have wanted it, and being wrong
 * moves work they have already placed. Appending is predictable, never
 * destructive, and one drag away from wherever they actually want it.
 */
export function mergeSavedArrangement(rebuilt: Project, savedIn: Project): Project {
  // Before anything else, and deliberately ahead of the "nothing new" early
  // return below — a project that opens with no new material is the ONE case
  // that most needs this, because re-sending the board is exactly what does not
  // reach it. See `healGraphicBlend`.
  const saved = healGraphicBlends(savedIn);

  const savedClipIds = new Set<string>();
  for (const t of saved.timeline.tracks) for (const c of t.clips) savedClipIds.add(c.id);
  for (const t of (saved.textClips ?? [])) savedClipIds.add(t.id);

  const newByTrack = new Map<string, Clip[]>();
  let newMin = Infinity;
  for (const t of rebuilt.timeline.tracks) {
    for (const c of t.clips) {
      if (savedClipIds.has(c.id)) continue;
      const list = newByTrack.get(t.id) ?? [];
      list.push(c);
      newByTrack.set(t.id, list);
      newMin = Math.min(newMin, c.startTime);
    }
  }
  const newTextClips = (rebuilt.textClips ?? []).filter((t) => !savedClipIds.has(t.id));
  for (const t of newTextClips) newMin = Math.min(newMin, t.startTime);

  // Nothing genuinely new: the blob was flagged stale by a probe that looks at
  // scene COUNTS, which can disagree with what is actually on the timeline (a
  // clip the user deleted, say). Returning the saved project untouched is
  // exactly right — there is nothing to add, and rebuilding would only undo
  // their work.
  if (!newByTrack.size && !newTextClips.length) return saved;

  const savedEnd = Math.max(
    0,
    ...saved.timeline.tracks.flatMap((t) => t.clips.map((c) => c.startTime + c.duration)),
    ...(saved.textClips ?? []).map((t) => t.startTime + t.duration),
  );
  /**
   * NOT CLAMPED TO ZERO, and that was a real flaw.
   *
   * The shift lands the first new clip exactly at the end of the saved cut. If
   * the user has TRIMMED their edit down, the board's layout puts the new clip
   * later than their timeline now ends — clamping at zero left it there, with a
   * hole of dead air in between that nothing explains. A negative delta is the
   * correct answer to "my cut is shorter than the board thinks": pull the new
   * material back so it starts where the film currently stops.
   */
  const delta = Number.isFinite(newMin) ? savedEnd - newMin : 0;
  const shift = <T extends { startTime: number }>(c: T): T =>
    ({ ...c, startTime: c.startTime + delta });

  const savedTrackIds = new Set(saved.timeline.tracks.map((t) => t.id));
  const rebuiltTrackById = new Map(rebuilt.timeline.tracks.map((t) => [t.id, t] as const));
  const tracks: Track[] = saved.timeline.tracks.map((t) => {
    const add = newByTrack.get(t.id);
    // The new shots' scene-boundary blends travel with them — see
    // `carryArrivingTransitions` for why only theirs.
    return add
      ? carryArrivingTransitions(
          { ...t, clips: [...t.clips, ...add.map(shift)] },
          new Set(add.map((c) => c.id)),
          rebuiltTrackById.get(t.id),
        )
      : t;
  });

  /**
   * A TRACK THE SAVED PROJECT HAS NEVER HAD — a "Take 2" that appeared because
   * the user generated an alternate since they last saved, or a "Graphic 1"
   * because they laid a lower third over a shot.
   *
   * Inserted before the first VIDEO track rather than appended, because array
   * order is z-order here and appending would put it at the BOTTOM of the
   * stack, underneath the footage it belongs over. Same rule the rebuild
   * follows; see the note there.
   *
   * Both prefixes, for the same reason and with the same fix. A graphic
   * appended below the picture is not subtly wrong — it is invisible, and the
   * user's report is "the overlay did nothing".
   */
  for (const t of rebuilt.timeline.tracks) {
    if (savedTrackIds.has(t.id)) continue;
    const add = newByTrack.get(t.id);
    const hasNewText = newTextClips.some(clip => clip.trackId === t.id);
    if (!add?.length && !hasNewText) continue;
    if (saved.deletedTracks?.some(track => track.id === t.id)) continue;
    const fresh: Track = { ...t, clips: (add ?? []).map(shift) };
    const firstVideo = tracks.findIndex((x) => x.type === "video");
    const stacksOnTop = t.type === "text" || t.id.startsWith("track-take-") || t.id.startsWith("track-graphic-");
    if (stacksOnTop && firstVideo >= 0) tracks.splice(firstVideo, 0, fresh);
    else tracks.push(fresh);
  }

  // Media the saved library has never seen. Union by id, saved first, so a
  // healed url in the blob is not overwritten by a stale rebuild copy.
  const savedMediaIds = new Set(saved.mediaLibrary.items.map((m) => m.id));
  const items = [
    ...saved.mediaLibrary.items,
    ...rebuilt.mediaLibrary.items.filter((m) => !savedMediaIds.has(m.id)),
  ];

  const allEnds = tracks.flatMap((t) => t.clips.map((c) => c.startTime + c.duration));
  const textClips = [...(saved.textClips ?? []), ...newTextClips.map(shift)];

  /**
   * THE SEQUENCES THE NEW CLIPS POINT AT.
   *
   * A nested sequence lives in two pieces: the INSTANCE, an ordinary clip on a
   * track, and the CONTENT, held once on `compoundClips`. The instance merges in
   * above with every other new clip — but the content is not on a track, so
   * without this it stayed behind in `rebuilt` and the merged project got an
   * instance pointing at a sequence that does not exist. That renders as a hole
   * and plays as silence, with nothing naming the cause.
   *
   * Union by id, SAVED FIRST — same rule as the media library, and for the same
   * reason: if the user has opened that sequence and edited it, their version is
   * the true one and a rebuild copy must not overwrite it. Sending to the editor
   * adds; it never overwrites.
   *
   * Still absent when neither side has any, so an ordinary project keeps no such
   * key at all.
   */
  const savedCompounds = saved.compoundClips ?? [];
  const savedCompoundIds = new Set(savedCompounds.map((c) => c.id));
  const compoundClips = [
    ...savedCompounds,
    ...(rebuilt.compoundClips ?? []).filter((c) => !savedCompoundIds.has(c.id)),
  ];

  return {
    ...saved,
    mediaLibrary: { items },
    timeline: {
      ...saved.timeline,
      tracks,
      duration: Math.max(
        0,
        ...allEnds,
        ...textClips.map((t) => t.startTime + t.duration),
      ),
    },
    textClips,
    ...(compoundClips.length ? { compoundClips } : {}),
    modifiedAt: Date.now(),
  };
}

/**
 * The alternate-take tracks, in the order they must sit in the array.
 *
 * ── PUSHED BEFORE `track-video`, AND THAT IS THE Z-ORDER ────────────────────
 * The shared painter sorts pixel tracks by DESCENDING array index, so a LOWER
 * index paints LAST and therefore sits ON TOP (`video-engine`, and pinned by
 * `stores/track-stacking.test.ts`). The timeline UI renders the array
 * top-to-bottom, so these also appear as the rows above Video — what the user
 * sees above IS above.
 *
 * Highest take number first, so Take 3 ends up above Take 2 above Video.
 *
 * ── `hidden` AND `muted`, AND BOTH ARE REQUIRED ─────────────────────────────
 * `hidden` alone is not enough: the word does not appear anywhere in
 * `packages/core/src/audio` — audibility is `!muted && (!solo || isSolo)` and
 * `getAudioTracksAtTime` explicitly includes video tracks. Ship these
 * hidden-only and the user sees one take while HEARING all four at once, with
 * nothing on screen to explain it.
 *
 * Extracted so the rules above are testable. They are invisible in the running
 * product until they are wrong, and then they are wrong in a way that reads as
 * the editor being broken rather than as a track flag.
 */
export function buildTakeTracks(clipsBySlot: Map<number, Clip[]>): Track[] {
  const out: Track[] = [];
  const slots = [...clipsBySlot.keys()].sort((a, b) => b - a);   // highest first
  for (const slot of slots) {
    const clips = clipsBySlot.get(slot) ?? [];
    // A slot with no clips would be an empty row the user has to wonder about.
    if (!clips.length) continue;
    out.push({
      id: `track-take-${slot}`,
      type: "video",
      name: `Take ${slot}`,
      clips,
      transitions: [],
      locked: false,
      hidden: true,
      muted: true,
      solo: false,
    });
  }
  return out;
}

/**
 * THE BLEND AT EVERY SCENE BOUNDARY — decided here, not left to the agent.
 *
 * ── THE INCIDENT ────────────────────────────────────────────────────────────
 * Founder, on an automated Seedance episode (28 Sep): "I liked the video, but
 * the agent did not add blend transitions between clips, so clip transitions
 * are abrupt." Nothing was broken in the usual sense. The chat side has a
 * scene-level `transitionIn`, but nothing ever carried it here — every track
 * this loader built had `transitions: []` — so the ONLY way a cut got a blend
 * was an agent remembering to call `clip-transitions` during finishing. An
 * unattended production has nobody to remember, and every cut shipped hard.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *  • A real cut (the board shot's camera line began "CUT —", or simply any
 *    shot that is not continuous) gets a short CROSSFADE — both shots on screen
 *    at once, the most natural blend the engine has. Not dipToBlack: a dip
 *    between every shot reads as a string of chapter breaks.
 *  • A CONTINUOUS shot (`continues_previous`, written by compile) opens on the
 *    previous shot's exact last frame. The seam is already invisible; a
 *    dissolve there would ghost two near-identical frames into a visible
 *    stutter. It stays a hard cut.
 *  • An explicit `transition_in` set in chat always wins, including `cut`.
 *
 * ── WHY IT CANNOT SHIFT THE NARRATION ───────────────────────────────────────
 * The engine centres a transition ON the cut (`getTransitionWindow`: the window
 * is A's end ± half the duration) and blends A's tail into B's head in place.
 * No clip moves, the film is not shortened, and narration and captions — which
 * sit on their own tracks, timed to each scene's start — stay exactly where
 * they are.
 *
 * Only ADJACENT clips are paired. A gap means a scene has no picture yet (still
 * generating, or failed); blending across a hole would dissolve into nothing.
 *
 * Ids derive from the incoming clip, which is stable per shot, so the editor's
 * additive merge sees the same transition on every rebuild instead of a new one.
 */
export const DEFAULT_SCENE_BLEND_SEC = 0.45;

const SCENE_TRANSITION_KINDS: Record<string, { type: TransitionType; params: Record<string, unknown> } | null> = {
  cut: null,
  fade: { type: "crossfade", params: {} },
  "slide-left": { type: "slide", params: { direction: "left" } },
  "slide-up": { type: "slide", params: { direction: "up" } },
  wipe: { type: "wipe", params: { direction: "left" } },
  zoom: { type: "zoom", params: {} },
};

export interface SceneBoundaryInfo {
  continuesPrevious?: boolean;
  transitionIn?: { kind?: string; durationSec?: number } | null;
}

export function buildSceneBoundaryTransitions(
  clips: Clip[],
  infoFor: (clipId: string) => SceneBoundaryInfo | undefined,
): Transition[] {
  const out: Transition[] = [];
  const ordered = [...clips].sort((a, b) => a.startTime - b.startTime);
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1];
    const b = ordered[i];
    if (Math.abs(a.startTime + a.duration - b.startTime) > 0.05) continue;

    const info = infoFor(b.id) ?? {};
    const explicitKind = typeof info.transitionIn?.kind === "string" ? info.transitionIn.kind : "";
    let spec: { type: TransitionType; params: Record<string, unknown> } | null;
    let wanted = DEFAULT_SCENE_BLEND_SEC;
    if (explicitKind) {
      // An unknown kind is a typo, not a request for a hard cut — blend.
      spec = explicitKind in SCENE_TRANSITION_KINDS
        ? SCENE_TRANSITION_KINDS[explicitKind]
        : SCENE_TRANSITION_KINDS.fade;
      const d = Number(info.transitionIn?.durationSec);
      if (d > 0) wanted = d;
    } else if (info.continuesPrevious) {
      spec = null;
    } else {
      spec = SCENE_TRANSITION_KINDS.fade;
    }
    if (!spec) continue;

    // Half the shorter clip is the ceiling `clip-transitions` uses too: a
    // transition consumes the tail of A and the head of B and must leave both.
    const ceiling = Math.max(0.1, Math.min(a.duration, b.duration) / 2);
    out.push({
      id: `tr-scene-${b.id}`,
      clipAId: a.id,
      clipBId: b.id,
      type: spec.type,
      duration: Math.max(0.1, Math.min(wanted, ceiling)),
      params: { ...spec.params },
    });
  }
  return out;
}

/**
 * Carry the scene-boundary blends that belong to clips ARRIVING in a merge.
 *
 * Both merges — the editor's live additive merge and `mergeSavedArrangement` —
 * add clips and nothing else, so without this a scene generated while the
 * editor was open landed with no blend even though the rebuild had one for it.
 * That is the normal shape of an automated production: the editor is open from
 * scene 1 and every later scene streams in.
 *
 * ONLY transitions touching a clip that is new in this merge. One between two
 * clips the user already has is theirs: if it is missing they removed it, and
 * re-adding it on every Firestore tick would make "no blend here" impossible.
 * The pair must still be adjacent where the clips actually landed.
 */
export function carryArrivingTransitions(
  target: Track,
  arrivingClipIds: Set<string>,
  source: Track | undefined,
): Track {
  const incoming = source?.transitions ?? [];
  if (!incoming.length || !arrivingClipIds.size) return target;
  const byId = new Map(target.clips.map((c) => [c.id, c] as const));
  const have = target.transitions ?? [];
  const add: Transition[] = [];
  for (const t of incoming) {
    if (!t.clipBId) continue;
    if (!arrivingClipIds.has(t.clipAId) && !arrivingClipIds.has(t.clipBId)) continue;
    const a = byId.get(t.clipAId);
    const b = byId.get(t.clipBId);
    if (!a || !b) continue;
    if (Math.abs(a.startTime + a.duration - b.startTime) > 0.05) continue;
    if (have.some((h) => h.id === t.id || (h.clipAId === t.clipAId && h.clipBId === t.clipBId))) continue;
    // One transition per edge: a clip's head or tail already blended with
    // something else would make the two compete for the same frames.
    if (have.some((h) => h.clipAId === a.id || h.clipBId === b.id)) continue;
    add.push(t);
  }
  return add.length ? { ...target, transitions: [...have, ...add] } : target;
}

/**
 * The GRAPHIC LAYER tracks — the take tracks' twin, and deliberately so.
 *
 * ── AN ORDINARY VIDEO TRACK, AND THAT IS THE DESIGN ──────────────────────────
 * A rendered graphic IS a video: an alpha WebM that composites over whatever is
 * below it. So it goes on `type: "video"` like everything else, and every
 * feature the editor already has — trim, move, razor, opacity, transitions,
 * save and load — works on it because there is nothing new to teach. The id and
 * the NAME are what make it recognisable; nothing keys behaviour off either.
 *
 * The one thing that IS special is where it sits in the array, and that is not
 * a graphics rule — it is the z-order rule every pixel track obeys.
 *
 * ── ONE TRACK PER LAYER POSITION, NOT PER SHOT ───────────────────────────────
 * Every shot's first layer shares "Graphic 1". A track per shot would give a
 * forty-shot film forty near-empty rows; per position gives it as many rows as
 * the busiest shot has layers, which is almost always one or two.
 *
 * ── VISIBLE AND UNMUTED, WHICH IS THE INVERSE OF A TAKE TRACK ────────────────
 * Takes are alternates you audition, so they arrive hidden and muted. A graphic
 * is part of the picture — it is supposed to be on screen — so it arrives
 * playing. Unmuted rather than muted because these renders carry no audio at
 * all; muting them would be a flag that means nothing and that somebody would
 * later have to explain.
 *
 * Highest layer number FIRST, so Graphic 2 ends up above Graphic 1 above the
 * picture — matching the card, where the last layer in the list is on top.
 */
/**
 * GIVE AN OLDER SAVED GRAPHIC CLIP ITS BLEND BACK.
 *
 * ── WHY THE MERGE CANNOT JUST BE LEFT ALONE ──────────────────────────────────
 * `mergeSavedArrangement` is deliberately additive: the saved cut wins for
 * everything it has, and only unseen clips are appended. That is exactly right
 * for the things the USER decided — where a clip sits, how it is trimmed.
 *
 * `blendMode` on a graphic clip is not one of those. It is a property of what
 * the clip IS: a HyperFrames overlay is rendered on a transparent background,
 * every transparent pixel reaches the compositor as BLACK, and without `screen`
 * it covers the shot rather than sitting on it. A project saved before the
 * loader started setting it would keep a broken clip forever, and re-sending the
 * board would never fix it — the saved blob wins every time.
 *
 * ── UNDEFINED ONLY, NEVER AN EXPLICIT VALUE ──────────────────────────────────
 * `undefined` means "written before this existed". Any actual value — including
 * `"normal"` — means somebody chose it in the inspector, and healing over that
 * would fight the user every time they opened the project. So this fills a hole
 * and never overwrites an answer.
 *
 * Scoped to graphic tracks by id for the same reason: these are the clips the
 * loader owns and rebuilds, and nothing else on the timeline has a blend it did
 * not ask for.
 */
export function healGraphicBlends(project: Project): Project {
  const tracks = (project.timeline?.tracks ?? []).map(healGraphicBlend);
  if (tracks.every((t, i) => t === project.timeline.tracks[i])) return project;
  // Only the ones actually filled in — a track that already carried the blend
  // is not news, and an inflated number in the console is a false lead the next
  // time somebody debugs an overlay.
  const n = project.timeline.tracks.reduce(
    (sum, t) => sum + (t.id.startsWith("track-graphic-")
      ? t.clips.filter((c) => c.blendMode === undefined).length
      : 0),
    0,
  );
  console.warn(
    `[voidspace-loader] Healed ${n} graphic clip(s) with no blend → "screen" `
    + `(saved before overlays carried one; without it the overlay's transparent `
    + `background paints black over the shot).`,
  );
  return { ...project, timeline: { ...project.timeline, tracks } };
}

function healGraphicBlend(track: Track): Track {
  if (!track.id.startsWith("track-graphic-")) return track;
  if (!track.clips.some((c) => c.blendMode === undefined)) return track;
  return {
    ...track,
    clips: track.clips.map((c) =>
      c.blendMode === undefined ? { ...c, blendMode: "screen" as const } : c,
    ),
  };
}

/**
 * WHERE A GRAPHIC LAYER SITS INSIDE ITS SHOT.
 *
 * ── WHY THIS LIVES HERE AND NOT ON THE BOARD ─────────────────────────────────
 * The board stores a RULE — an offset, an anchor and a hold — never a position,
 * because the shot's real length is whatever take the user finally picks. Only
 * this loop knows that number. An earlier draft had a twin of this function on
 * the board that nothing called: it was tested, it looked authoritative, and it
 * disagreed with the code that actually runs on exactly the case below. Deleted,
 * so there is one rule and it is the one that executes.
 *
 * ── THE FILE'S OWN LENGTH IS A CEILING ───────────────────────────────────────
 * `hold: 0` means "for the whole shot", and taken literally that would stretch a
 * 3-second render across an 8-second shot — five seconds frozen on its last
 * frame, which reads as a stall rather than a design. So a layer never plays
 * longer than the file it was rendered from.
 *
 * All three inputs are clamped, because every one of them can arrive wrong from
 * a real board: a hold longer than the shot, an offset past the end, an
 * end-anchored layer on a take shorter than itself.
 */
export function resolveGraphicWindow(
  layer: { offsetSec?: number; holdSec?: number; anchor?: string },
  slotStart: number,
  slotSec: number,
  fileSec: number,
): { startTime: number; duration: number } {
  const slot = Math.max(0, Number(slotSec) || 0);
  const file = Math.max(0, Number(fileSec) || 0);
  const offset = Math.max(0, Number(layer.offsetSec) || 0);
  const hold = Math.max(0, Number(layer.holdSec) || 0);
  // What it was ASKED to run for: its own hold, else the file, else the shot.
  const asked = hold || file || slot;

  const startTime = layer.anchor === "end"
    // Counted back from the end, so it follows a longer take instead of
    // stranding itself where the shorter one used to finish.
    ? Math.max(slotStart, slotStart + slot - offset - asked)
    : Math.min(slotStart + offset, slotStart + slot);

  const duration = Math.max(0, Math.min(
    asked,
    // Never runs into the next shot.
    slotStart + slot - startTime,
    // Never outlives the render it came from.
    file || asked,
  ));

  return { startTime, duration };
}

export function buildGraphicTracks(clipsByLayer: Map<number, Clip[]>): Track[] {
  const out: Track[] = [];
  const layers = [...clipsByLayer.keys()].sort((a, b) => b - a);   // highest first
  for (const layer of layers) {
    const clips = clipsByLayer.get(layer) ?? [];
    if (!clips.length) continue;
    out.push({
      id: `track-graphic-${layer}`,
      type: "video",
      name: `Graphic ${layer}`,
      clips,
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
  }
  return out;
}

interface SceneData {
  scene_number: number;
  /**
   * The BOARD SHOT this scene was compiled from.
   *
   * Written by `/api/board/compile`, and as of the identity work it is what
   * decides which scene a render belongs to when the storyboard is reordered —
   * a scene number is a position and positions move. Carried onto every
   * MediaItem and Clip built from this scene so the timeline can answer "which
   * shot is this?" without inferring it from an index that has already changed.
   */
  source_shot_id?: string;
  /**
   * The screenplay SEQUENCE this shot sits in — "The chase".
   *
   * Written by compile since the structure work and read by nothing until now.
   * Consecutive scenes sharing one is what becomes a nested sequence on the
   * timeline; empty means the shot is not in one, which is every short film.
   */
  board_sequence?: string;
  scene_text?: string;
  narration_text?: string;
  visual_description?: string;
  video_url?: string;
  url?: string;
  image_url?: string;
  first_frame_url?: string;
  preview_image_url?: string;
  music_start_ms?: number | string;
  music_end_ms?: number | string;
  audio_start_ms?: number | string;
  audio_end_ms?: number | string;
  music_url?: string;
  music_file_name?: string;
  music_title?: string;
  music_artist?: string;
  narration_url?: string;
  narration_start_ms?: number;
  narration_end_ms?: number;
  narration_duration_ms?: number;
  lyrics_lrc?: string;
  lyrics_json?: string;
  is_branding?: boolean;
  status?: string;
  /** Written by compile for a CONTINUOUS board shot — see `buildSceneBoundaryTransitions`. */
  continues_previous?: boolean;
  /** An explicit scene-level transition set in chat (`edit_scene transitionIn`). */
  transition_in?: { kind?: string; durationSec?: number } | null;
  edit_state?: {
    music_start_ms?: number | string;
    music_end_ms?: number | string;
    audio_start_ms?: number | string;
    audio_end_ms?: number | string;
  };
}

interface SceneVideoData {
  id: string;
  url?: string;
  video_url?: string;
  duration_ms?: number;
  tag?: string;
  source_type?: string;
  start_ms?: number;
  end_ms?: number;
  voice_mode?: string;
  has_embedded_audio?: boolean;
  word_timestamps?: Array<{ word: string; start: number; end: number }>;
}

const resolvedUrlCache = new Map<string, string>();
const mediaBlobCache = new Map<string, Blob>();

// Tiny deterministic hash for building stable media IDs from URLs.
// FNV-1a 32-bit, base36-encoded — short, dependency-free, and stable
// across reloads (which is what we want for the live-rebuild path).
function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Cross-project media-id collision heal. Legacy scene media ids used a
 * shared "-fallback" suffix (media-video-{sceneNo}-fallback) whenever the
 * per-take record couldn't be matched — and scene numbers repeat in EVERY
 * automation project, while the IndexedDB blob store is keyed by media id
 * GLOBALLY (per origin, not per project). Result: project B's clip
 * hydrated project A's video bytes from IndexedDB — "every project shows
 * the same Scene 1/2 video", and "paused frame is right (poster URL) but
 * playback is wrong (decodes the collided blob)". Re-key those items to
 * the URL-hash scheme the rebuild now mints and repoint their clips. The
 * new ids miss IndexedDB → bytes refetch from the item's OWN originalUrl →
 * correct per-project media, waveforms and filmstrips.
 */
export function migrateLegacyFallbackMediaIds<T extends Project>(project: T): T {
  const items = project.mediaLibrary?.items ?? [];
  const remap = new Map<string, string>();
  for (const m of items as any[]) {
    const match = /^media-(video|narration)-(.+)-fallback$/.exec(String(m?.id || ""));
    if (!match) continue;
    const url = typeof m?.originalUrl === "string" ? m.originalUrl : "";
    if (!url) continue; // nothing unique to key on — leave untouched
    remap.set(m.id, `media-${match[1]}-${match[2]}-${stableHash(url)}`);
  }
  if (remap.size === 0) return project;
  console.warn(
    `[voidspace-loader] migrating ${remap.size} legacy '-fallback' media id(s) — cross-project blob-collision heal`,
  );
  return {
    ...project,
    mediaLibrary: {
      ...project.mediaLibrary,
      items: (items as any[]).map((m: any) => {
        const next = remap.get(m.id);
        // Drop any in-memory blob too — it may already be the collided bytes.
        return next ? { ...m, id: next, blob: null } : m;
      }),
    },
    timeline: {
      ...project.timeline,
      tracks: (project.timeline?.tracks ?? []).map((t: any) => ({
        ...t,
        clips: (t.clips ?? []).map((c: any) =>
          remap.has(c.mediaId) ? { ...c, mediaId: remap.get(c.mediaId)! } : c,
        ),
      })),
    },
  } as T;
}

/**
 * Lightweight real-duration probe: loads only the audio's metadata via an
 * <audio> element and reads its true length. Cheap (no full decode), with a
 * 5s cap. Returns 0 when unavailable so the caller keeps its recorded value.
 */
function probeAudioDuration(blob: Blob | null): Promise<number> {
  return new Promise((resolve) => {
    if (!blob || typeof document === "undefined") return resolve(0);
    let settled = false;
    const el = document.createElement("audio");
    const obj = URL.createObjectURL(blob);
    const done = (d: number) => {
      if (settled) return;
      settled = true;
      try { URL.revokeObjectURL(obj); } catch { /* noop */ }
      resolve(Number.isFinite(d) && d > 0 ? d : 0);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => done(el.duration);
    el.onerror = () => done(0);
    setTimeout(() => done(0), 5000);
    el.src = obj;
  });
}

async function resolveMediaUrl(rawUrl?: string | null): Promise<string | null> {
  if (!rawUrl) return null;
  const url = String(rawUrl).trim();
  if (!url) return null;

  if (resolvedUrlCache.has(url)) {
    return resolvedUrlCache.get(url)!;
  }

  // Already a browser-usable URL.
  //
  // SAME-ORIGIN PATHS COUNT. HyperFrames renders on the desktop app and nothing
  // auto-uploads to cloud storage, so a graphic scene's media is served by this
  // app as an absolute path:
  //   /api/studio/local-asset?projectId=…&kind=render&filename=…
  // That is directly loadable by the browser, but it used to fall through to the
  // Firebase branch below, which treated the whole path+query as a STORAGE KEY
  // and 403'd ("User does not have permission to access 'api/studio/local-asset?…'").
  // Every locally-rendered clip did that on every project load — a failed
  // network round-trip each, before falling back to the raw value anyway.
  //
  // Protocol-relative ("//host/…") is excluded deliberately: it is cross-origin
  // and not something this app produces.
  const isSameOriginPath = url.startsWith('/') && !url.startsWith('//');
  if (/^https?:\/\//i.test(url) || /^blob:/i.test(url) || /^data:/i.test(url) || isSameOriginPath) {
    resolvedUrlCache.set(url, url);
    return url;
  }

  try {
    const downloadUrl = await getDownloadURL(storageRef(storage, url));
    resolvedUrlCache.set(url, downloadUrl);
    return downloadUrl;
  } catch (e) {
    console.warn("[voidspace-loader] Could not resolve storage URL, using raw value:", url, e);
    resolvedUrlCache.set(url, url);
    return url;
  }
}

// CORS-bypass proxy helper lives in @openreel/core/utils so every
// renderer surface (preview, export, video-engine, playback) routes
// through the same same-origin endpoint. See utils/cors-proxy.ts.
import { rewriteToProxy } from "@openreel/core";

/**
 * Stamp a Firebase ID token onto same-origin `/api/studio/local-asset`
 * URLs. The endpoint requires auth (requireUserId in studio-auth.ts)
 * and accepts a `?t=<idToken>` query fallback for HTML elements /
 * plain fetch calls that can't set an Authorization header. Without
 * this, the editor's music / video / image blob fetches got 401 and
 * silently fell back to `blob: null` — the audio engine drops the
 * track ("No blob available for media item"), so BGM never plays in
 * preview OR in the rendered MP4 even though the visuals on the
 * timeline look correct.
 *
 * Only stamps onto local-asset URLs; cross-origin sources (Suno temp
 * URLs, Kie outputs, Firebase Storage) keep their existing query
 * strings untouched.
 */
/**
 * Voidspace API paths that serve media and REQUIRE a signed-in user.
 *
 * ── WHY THIS IS A LIST AND NOT ONE REGEX ────────────────────────────────────
 * Only `/api/studio/local-asset` was stamped. `/api/media-library/file` — the
 * url that `use_media_library_asset` and `search_media` hand back for anything
 * in the user's own library — is just as authenticated (`requireUserId`, and it
 * answers 401 without a token), and it was fetched bare.
 *
 * The consequence was total and silent: EVERY attempt to put a library asset on
 * the timeline failed with "could not fetch media" in about 12ms. Watched on a
 * real run, the agent searched, found the media, tried to place it, failed,
 * assumed it had picked the wrong clip, searched again — and burned the whole
 * turn on a loop whose cause was a missing query parameter. "Find two videos in
 * my library and put them on the timeline" could not succeed at all.
 *
 * `requireUserId` accepts the token as `?t=`, so stamping is all that was ever
 * needed. `thumb` and `proxy` are here for the same reason: same auth, same
 * failure, and a thumbnail that 401s is a library that looks empty.
 */
const AUTHED_MEDIA_PATHS = [
  "/api/studio/local-asset",
  "/api/media-library/file",
  "/api/media-library/thumb",
  "/api/media-library/proxy",
];

async function maybeAuthStamp(url: string): Promise<string> {
  /**
   * SAME-ORIGIN ONLY. The token is a bearer credential: appending it to a URL
   * because the PATH happened to match would hand it to any third-party host
   * that chose the same path. Relative urls are ours by definition; an absolute
   * one has to prove it.
   */
  let path: string;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin) return url;
    path = parsed.pathname;
  } catch {
    return url;
  }
  if (!AUTHED_MEDIA_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return url;

  const u = auth.currentUser;
  if (!u) return url;
  try {
    const token = await u.getIdToken(false);
    if (!token) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}t=${encodeURIComponent(token)}`;
  } catch {
    return url;
  }
}

/**
 * Fetch the timeline blob for a project.
 *
 * WHY THIS IS A FETCH AND NOT A FIELD READ
 * `project_state` used to be a field on the scene_list document, so the loader
 * got it free with the document it was already reading. It now lives in Cloud
 * Storage (see the website's `project-state-store.ts`) because real projects
 * reach 875 KB and the Firestore document ceiling was refusing saves and
 * eating the user's undo history. Boards and image projects already stored
 * their documents this way; this is the third one catching up.
 *
 * The RETURN SHAPE IS DELIBERATELY IDENTICAL to the old field — `{ json,
 * history }` — so every downstream guard (poisoned-blob detection, empty-blob
 * safety net, stale-blob scene-count check, history extraction, stale-URL
 * healing) is untouched. Only where the string comes from changed.
 *
 * `inline` is the legacy field, passed through as a fallback: if this fetch
 * fails for any reason — network blip, auth hiccup, a project not yet migrated
 * on an older server — we use whatever the document still carries rather than
 * reporting "no timeline", which would send the loader down its per-scene
 * rebuild path and silently discard the user's real edit history.
 */
async function fetchProjectStateBlob(
  sceneListId: string,
  inline: { json?: string; history?: string } | undefined,
): Promise<{ json?: string; history?: string } | undefined> {
  try {
    const u = auth.currentUser;
    const token = u ? await u.getIdToken(false) : "";
    const res = await fetch(
      `/api/studio/projects/${encodeURIComponent(sceneListId)}/timeline-state?raw=1`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { hasBlob?: boolean; json?: string | null; history?: string | null };
    if (body?.hasBlob && typeof body.json === "string" && body.json) {
      return { json: body.json, ...(typeof body.history === "string" ? { history: body.history } : {}) };
    }
    // An authoritative "this project has no timeline yet" — a project the
    // pipeline created that nobody has opened in the editor. Returning the
    // inline field here would resurrect a blob the server has superseded, so
    // return nothing and let the per-scene rebuild do its job.
    if (body && body.hasBlob === false && !inline?.json) return undefined;
    if (body && body.hasBlob === false) {
      console.warn(
        "[voidspace-loader] server reports no timeline blob but the document still carries an inline one — using the inline copy (pre-migration project)",
      );
      return inline;
    }
    return inline;
  } catch (e) {
    console.warn(
      `[voidspace-loader] timeline blob fetch failed (${(e as Error)?.message ?? e}) — falling back to the inline field if present`,
    );
    return inline;
  }
}

export async function fetchMediaBlob(
  url: string | null,
  timeoutMs = 15000,
): Promise<Blob | null> {
  if (!url) return null;
  if (mediaBlobCache.has(url)) return mediaBlobCache.get(url)!;

  const tryFetch = async (targetUrl: string): Promise<Blob | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const stamped = await maybeAuthStamp(targetUrl);
      const res = await fetch(stamped, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(
          `[voidspace-loader] Blob fetch failed (${res.status}) for ${targetUrl}`,
        );
        return null;
      }
      const blob = await res.blob();
      if (blob.size > 0) {
        mediaBlobCache.set(url, blob);
        return blob;
      }
      return null;
    } catch (e) {
      console.warn(`[voidspace-loader] Blob fetch error for ${targetUrl}:`, e);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // For cross-origin URLs, route through the same-origin proxy from
  // the FIRST attempt. Hosts like tempfile.redpandaai.co serve no
  // `Access-Control-Allow-Origin` header so a direct fetch always
  // fails CORS — and even though we used to recover via the proxy on
  // the second attempt, the failed first attempt floods the console
  // with red `net::ERR_FAILED` lines on every project load. Cleaner
  // and faster to skip the wasted round-trip entirely.
  const proxied = rewriteToProxy(url);
  const isCrossOrigin = proxied !== url;

  let blob: Blob | null;
  if (isCrossOrigin) {
    blob = await tryFetch(proxied);
    if (blob) {
      // Cache against the ORIGINAL URL so future lookups keyed on
      // `originalUrl` hit immediately without re-routing.
      mediaBlobCache.set(url, blob);
      return blob;
    }
    // Proxy didn't have it — try the raw URL as a last resort. This
    // covers the rare case where the host actually does serve CORS
    // (some R2 buckets) but the proxy is misconfigured / down.
    blob = await tryFetch(url);
    if (blob) return blob;
  } else {
    // Same-origin URL — fetch direct.
    blob = await tryFetch(url);
    if (blob) return blob;
    // Retry with encoded URL for paths containing spaces/special chars
    if (url.includes(" ")) {
      blob = await tryFetch(encodeURI(url));
      if (blob) return blob;
    }
  }

  return null;
}

// ────────────────────────────────────────────
// sourceFile prediction (native relink hint)
// ────────────────────────────────────────────

/** Mirror "kind" → category subfolder, matching the server's layout
 *  (Voidspace-Website server/api/studio/mirror-asset.post.ts). */
const MIRROR_KIND_TO_FOLDER: Record<string, string> = {
  video: "videos",
  image: "frames",
  narration: "narrations",
  music: "music",
};
const MIRROR_KIND_TO_DEFAULT_EXT: Record<string, string> = {
  video: ".mp4",
  image: ".jpg",
  narration: ".mp3",
  music: ".mp3",
};

/** Same slug rules as the server's `safeSlug`. */
function mirrorSlug(input: string, max: number): string {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
}

function extFromUrl(url: string, kind: string): string {
  try {
    const path = new URL(url).pathname;
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    if (dot > slash && dot >= 0) return path.slice(dot).toLowerCase();
  } catch {
    /* not a parseable URL — fall through to default */
  }
  return MIRROR_KIND_TO_DEFAULT_EXT[kind] || "";
}

/**
 * Predict the on-disk `sourceFile` hint for a Voidspace-generated asset
 * so the editor's NATIVE handle-restore + relink path treats scene media
 * like any user-imported file (instead of relying on URL/scene fallbacks).
 *
 * The name mirrors the server's save convention
 * (`scene-<n>[-<role>]<ext>`, `bgm<ext>` for music). When the URL is the
 * local-asset proxy form it already carries the EXACT basename the server
 * wrote (`…/local-asset?…&filename=scene-1-primary.mp4`), so prefer that.
 * `size` is the live blob size when available (matches the mirrored file
 * byte-for-byte); 0 once the source URL has expired. The relink matcher's
 * structural `scene-<n>` strategy absorbs any assetId/extension variance.
 */
function deriveMirrorSourceFile(
  kind: "video" | "image" | "narration" | "music",
  sceneNumber: number | undefined,
  role: string | undefined,
  url: string,
  blob: Blob | null,
): MediaItem["sourceFile"] {
  let name: string | undefined;
  // Proxy URLs embed the real on-disk basename.
  if (/[?&]filename=/.test(url) && /local-asset/i.test(url)) {
    try {
      name = new URL(url, "http://_local_").searchParams.get("filename")?.toLowerCase() || undefined;
    } catch {
      /* ignore */
    }
  }
  if (!name) {
    const ext = extFromUrl(url, kind);
    const sceneTag = typeof sceneNumber === "number" ? `scene-${sceneNumber}` : "scene-x";
    const roleTag = role ? `-${mirrorSlug(role, 16)}` : "";
    name = kind === "music" ? `bgm${ext}` : `${sceneTag}${roleTag}${ext}`;
  }
  return {
    name,
    size: blob?.size ?? 0,
    lastModified: 0,
    folder: MIRROR_KIND_TO_FOLDER[kind],
  };
}

interface SceneImageData {
  id: string;
  url?: string;
  image_url?: string;
  tag?: string;
  source_type?: string;
}

interface SceneNarrationData {
  id: string;
  narration_url?: string;
  url?: string;
  script?: string;
  start_ms?: number;
  end_ms?: number;
  duration_ms?: number;
  word_timestamps?: Array<{ word: string; start: number; end: number }>;
  voice_mode?: string;
  has_embedded_audio?: boolean;
}

interface SceneSfxData {
  id: string;
  sfx_url?: string;
  url?: string;
  prompt?: string;
  start_ms?: number;
  end_ms?: number;
  duration_ms?: number;
  volume?: number;
  source_type?: string;
}

// ────────────────────────────────────────────
// Auth helpers
// ────────────────────────────────────────────

export function waitForAuth(timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (resolved) return;
      resolved = true;
      unsubscribe();
      resolve(user?.uid ?? null);
    });
    // Timeout: resolve null if auth state never fires
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      unsubscribe();
      console.warn("[waitForAuth] Timed out waiting for auth state");
      resolve(null);
    }, timeoutMs);
  });
}

export function getCurrentUserId(): string | null {
  return auth.currentUser?.uid ?? null;
}

// ────────────────────────────────────────────
// Firestore fetchers
// ────────────────────────────────────────────

export async function fetchSceneLists(
  userId: string,
): Promise<VoidspaceSceneList[]> {
  const ref = collection(db, "users", userId, "scene_lists");
  const snapshot = await getDocs(ref);
  return snapshot.docs
    .map((d) => ({ id: d.id, ...d.data() } as VoidspaceSceneList))
    .sort((a, b) => {
      const aTime = a.updated_at?.seconds ?? a.created_at?.seconds ?? 0;
      const bTime = b.updated_at?.seconds ?? b.created_at?.seconds ?? 0;
      return bTime - aTime; // newest first
    });
}

async function fetchScenes(
  userId: string,
  sceneListId: string,
): Promise<Array<SceneData & { _docId: string }>> {
  const ref = collection(
    db,
    "users",
    userId,
    "scene_lists",
    sceneListId,
    "scenes",
  );
  const q = query(ref, orderBy("scene_number"));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({ _docId: d.id, ...(d.data() as SceneData) }));
}

async function fetchSceneVideos(
  userId: string,
  sceneListId: string,
  sceneNum: string,
): Promise<SceneVideoData[]> {
  const ref = collection(
    db,
    "users",
    userId,
    "scene_lists",
    sceneListId,
    "scenes",
    sceneNum,
    "videos",
  );
  const snapshot = await getDocs(ref);
  return snapshot.docs.map(
    (d) => ({ id: d.id, ...d.data() } as SceneVideoData),
  );
}

async function fetchSceneImages(
  userId: string,
  sceneListId: string,
  sceneNum: string,
): Promise<SceneImageData[]> {
  const ref = collection(
    db,
    "users",
    userId,
    "scene_lists",
    sceneListId,
    "scenes",
    sceneNum,
    "images",
  );
  const snapshot = await getDocs(ref);
  return snapshot.docs.map(
    (d) => ({ id: d.id, ...d.data() } as SceneImageData),
  );
}

async function fetchSceneNarrations(
  userId: string,
  sceneListId: string,
  sceneNum: string,
): Promise<SceneNarrationData[]> {
  const ref = collection(
    db,
    "users",
    userId,
    "scene_lists",
    sceneListId,
    "scenes",
    sceneNum,
    "narrations",
  );
  const snapshot = await getDocs(ref);
  return snapshot.docs.map(
    (d) => ({ id: d.id, ...d.data() } as SceneNarrationData),
  );
}

async function fetchSceneSfx(
  userId: string,
  sceneListId: string,
  sceneNum: string,
  inlineSfxList?: SceneSfxData[],
): Promise<SceneSfxData[]> {
  // Prefer the inline `sfx_list` array on the scene doc (cheap — already
  // fetched as part of fetchScenes). The array is AUTHORITATIVE when
  // present at all (including when explicitly empty) — that means
  // `sfx_list: []` is "no SFX, on purpose" not "fall through to subcoll".
  //
  // We only fall back to the legacy `sfxs/` subcollection when the
  // field is genuinely absent (`undefined`). Conflating "absent" with
  // "empty array" was a real bug — clearing SFX via `{ sfx_list: [] }`
  // would silently re-hydrate from the stale subcollection.
  if (Array.isArray(inlineSfxList)) {
    return inlineSfxList.map((s, i) => ({ ...s, id: s.id ?? `sfx_${i}` } as SceneSfxData));
  }
  const ref = collection(
    db,
    "users",
    userId,
    "scene_lists",
    sceneListId,
    "scenes",
    sceneNum,
    "sfxs",
  );
  const snapshot = await getDocs(ref);
  return snapshot.docs.map(
    (d) => ({ id: d.id, ...d.data() } as SceneSfxData),
  );
}

/** Fetch all user music from the global music collection owned by this user */
export async function fetchUserMusic(userId: string): Promise<
  Array<{
    id: string;
    title?: string;
    artist?: string;
    url?: string;
    duration_ms?: number;
    avatar_id?: string;
  }>
> {
  // Music is stored in users/{userId}/scene_lists but also might be in a global music collection
  // For now fetch music referenced in scene lists
  const sceneLists = await fetchSceneLists(userId);
  const musicMap = new Map<string, { id: string; title?: string; artist?: string; url?: string; duration_ms?: number }>();

  for (const sl of sceneLists) {
    if (sl.music_url && !musicMap.has(sl.music_url)) {
      musicMap.set(sl.music_url, {
        id: sl.id,
        title: sl.music_title || sl.name,
        url: sl.music_url,
      });
    }
  }

  return Array.from(musicMap.values());
}

// ────────────────────────────────────────────
// Project builder
// ────────────────────────────────────────────

const DEFAULT_SCENE_DURATION = 6; // seconds
const DEFAULT_FPS = 30;

// Aspect-ratio → canvas dimensions, kept in lockstep with the studio's
// Remotion render (`studio/src/render.ts` → ASPECT_DIMENSIONS). The chat
// writes `aspect_ratio` onto the scene_list doc; we resolve it here so
// the editor canvas, timeline thumbnails, and final encode all agree.
const ASPECT_DIMENSIONS: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1':  { width: 1080, height: 1080 },
  '4:3':  { width: 1440, height: 1080 },
  '3:4':  { width: 1080, height: 1440 },
  '21:9': { width: 2560, height: 1080 },
};
const FALLBACK_DIM = ASPECT_DIMENSIONS['16:9'];

function resolveAspectDimensions(aspect: unknown): { width: number; height: number } {
  if (typeof aspect === 'string') {
    const key = aspect.trim();
    if (ASPECT_DIMENSIONS[key]) return ASPECT_DIMENSIONS[key];
    // Tolerate "16x9" / "16/9" variants.
    const norm = key.replace(/[x/]/g, ':');
    if (ASPECT_DIMENSIONS[norm]) return ASPECT_DIMENSIONS[norm];
  }
  return FALLBACK_DIM;
}

// TextClip style for caption phrases. The title-engine uses these
// fields for rendering; standard openreel Inspector edits (font size,
// color, alignment, transform) bind directly into this style and the
// clip's transform.
const CAPTION_TEXT_STYLE = {
  fontFamily: "Anton",
  fontSize: 72,
  fontWeight: "bold" as const,
  fontStyle: "normal" as const,
  color: "#FFFFFF",
  backgroundColor: "transparent",
  textAlign: "center" as const,
  verticalAlign: "middle" as const,
  lineHeight: 1.2,
  letterSpacing: 0,
  // Drop shadow + outline for legibility over busy backgrounds —
  // mirrors the look the subtitle-canvas-renderer produced for
  // Anton-family captions.
  strokeColor: "#000000",
  strokeWidth: 5,
};

// Bottom-center transform expressed in NORMALIZED canvas coords (0..1)
// so it scales correctly across 16:9 / 9:16 / 1:1 / etc. The Inspector
// Transform section edits these directly, so users can drag captions
// anywhere on the canvas after the initial placement.
const CAPTION_DEFAULT_TRANSFORM = {
  position: { x: 0.5, y: 0.85 },
  scale: { x: 1, y: 1 },
  rotation: 0,
  anchor: { x: 0.5, y: 0.5 },
  opacity: 1,
};

function makeMediaMeta(
  overrides: Partial<MediaMetadata> = {},
  dim: { width: number; height: number } = FALLBACK_DIM,
): MediaMetadata {
  return {
    duration: 0,
    width: dim.width,
    height: dim.height,
    frameRate: DEFAULT_FPS,
    codec: "",
    sampleRate: 44100,
    channels: 2,
    fileSize: 0,
    ...overrides,
  };
}

function makeDefaultTransform() {
  return {
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    anchor: { x: 0.5, y: 0.5 },
    opacity: 1,
  };
}

function parseTimestampToSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const simple = Number(trimmed);
  if (Number.isFinite(simple)) {
    if (simple > 1000) return simple / 1000;
    return simple;
  }

  const parts = trimmed.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return null;
}

function parseNumericTime(value: unknown, assumeMs = false): number | null {
  if (value == null) return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    if (assumeMs) return value / 1000;
    if (value > 1000) return value / 1000;
    return value;
  }

  if (typeof value === "string") {
    const parsed = parseTimestampToSeconds(value);
    if (parsed != null) return parsed;
  }

  return null;
}

function parseNumericMs(value: unknown): number | null {
  if (value == null) return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function resolveSceneMusicTimingMs(scene: SceneData): {
  startMs: number | null;
  endMs: number | null;
} {
  const row = scene as unknown as Record<string, unknown>;
  const editState =
    (row.edit_state as Record<string, unknown> | undefined) ??
    undefined;

  const startMs =
    parseNumericMs(row.music_start_ms) ??
    parseNumericMs(row.audio_start_ms) ??
    parseNumericMs(editState?.music_start_ms) ??
    parseNumericMs(editState?.audio_start_ms);

  const endMs =
    parseNumericMs(row.music_end_ms) ??
    parseNumericMs(row.audio_end_ms) ??
    parseNumericMs(editState?.music_end_ms) ??
    parseNumericMs(editState?.audio_end_ms);

  return {
    startMs,
    endMs,
  };
}

function parseLyricsJsonSegments(raw: string): Array<{ text: string; start: number; end?: number }> {
  try {
    const parsed = JSON.parse(raw);

    const candidates: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.lyrics)
        ? parsed.lyrics
        : Array.isArray(parsed?.lines)
          ? parsed.lines
          : Array.isArray(parsed?.segments)
            ? parsed.segments
            : Array.isArray(parsed?.words)
              ? parsed.words
              : [];

    const segments: Array<{ text: string; start: number; end?: number }> = [];

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const row = candidate as Record<string, unknown>;

      const text = [row.text, row.lyric, row.line, row.caption]
        .find((v) => typeof v === "string" && v.trim().length > 0) as string | undefined;

      if (!text) continue;

      const start =
        parseNumericTime(row.start_ms, true) ??
        parseNumericTime(row.startTime) ??
        parseNumericTime(row.start_time) ??
        parseNumericTime(row.start) ??
        parseNumericTime(row.time) ??
        parseNumericTime(row.timestamp);

      const end =
        parseNumericTime(row.end_ms, true) ??
        parseNumericTime(row.endTime) ??
        parseNumericTime(row.end_time) ??
        parseNumericTime(row.end);

      if (start == null) continue;

      segments.push({ text: text.trim(), start, end: end ?? undefined });
    }

    return segments.sort((a, b) => a.start - b.start);
  } catch {
    return [];
  }
}

function parseLrcSegments(raw: string): Array<{ text: string; start: number }> {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const segments: Array<{ text: string; start: number }> = [];

  for (const line of lines) {
    const matches = [...line.matchAll(/\[(\d{1,2}:\d{2}(?:\.\d{1,3})?)\]/g)];
    if (!matches.length) continue;

    const text = line.replace(/\[(\d{1,2}:\d{2}(?:\.\d{1,3})?)\]/g, "").trim();
    if (!text) continue;

    for (const match of matches) {
      const ts = parseTimestampToSeconds(match[1]);
      if (ts == null) continue;
      segments.push({ text, start: ts });
    }
  }

  return segments.sort((a, b) => a.start - b.start);
}

function setSceneListContext(
  sceneListId: string,
  slData: Record<string, unknown>,
) {
  const caption =
    (slData.video_description as string | undefined) ||
    (slData.description as string | undefined) ||
    (slData.content as string | undefined) ||
    (slData.caption as string | undefined) ||
    (slData.post_description as string | undefined) ||
    undefined;

  useVoidspaceStore.getState().setSceneList({
    sceneListId,
    name: (slData.name || slData.title) as string | undefined,
    videoUrl: slData.video_url as string | undefined,
    thumbnailUrl:
      (slData.thumbnail_url as string | undefined) ||
      (slData.preview_image_url as string | undefined) ||
      (slData.first_frame_url as string | undefined) ||
      (slData.image_url as string | undefined) ||
      undefined,
    avatarId: slData.avatar_id as string | undefined,
    avatarName: slData.avatar_name as string | undefined,
    reviewId: slData.review_id as string | undefined,
    caption,
  });
}

export async function fetchSceneListContext(
  userId: string,
  sceneListId: string,
): Promise<void> {
  const slDoc = await getDoc(doc(db, "users", userId, "scene_lists", sceneListId));
  if (!slDoc.exists()) return;
  const slData = slDoc.data() as Record<string, unknown>;

  // If the scene list has a review_id and no caption fields, fetch the review
  // document's description to use as the caption.
  const hasCaption =
    slData.video_description || slData.description || slData.content ||
    slData.caption || slData.post_description;

  if (!hasCaption && slData.review_id) {
    try {
      const reviewDoc = await getDoc(
        doc(db, "users", userId, "reviews", slData.review_id as string),
      );
      if (reviewDoc.exists()) {
        const reviewData = reviewDoc.data() as Record<string, unknown>;
        if (reviewData.description) {
          slData.description = reviewData.description;
        }
      }
    } catch (err) {
      console.warn("[voidspace-loader] Failed to fetch review caption:", err);
    }
  }

  setSceneListContext(sceneListId, slData);
}

/** Upstream hosts that hand out short-lived (~3-day TTL) media URLs: Kie
 *  (`tempfile.redpandaai.co`), Grok (`aiquickdraw`), Suno
 *  (`apiboxfiles.erweima.ai`). A URL on one of these WILL rot, so it must
 *  never be trusted as the durable pointer in a saved blob. */
export function isEphemeralMediaHost(u: unknown): u is string {
  return (
    typeof u === "string" &&
    /(tempfile\.redpandaai\.co|redpandaai\.co|tempfile\.aiquickdraw\.com|aiquickdraw\.com|apiboxfiles\.erweima\.ai)/i.test(
      u,
    )
  );
}

/** Minimal media-item shape the heal touches — structural, so the matcher
 *  stays unit-testable without the full MediaItem/Firestore types. */
export interface HealableMediaItem {
  id?: string;
  originalUrl?: string | null;
  blob?: unknown;
  thumbnailUrl?: string | null;
  type?: string;
  role?: string;
  category?: string;
}

/** Minimal live-scene shape: the per-scene durable URL fields + docId. */
export interface HealableScene {
  _docId: string;
  narration_url?: string;
  video_url?: string;
  first_frame_url?: string;
}

/**
 * Re-point any media item whose `originalUrl` is a frozen *ephemeral-host*
 * link (an expiring Kie/Grok/Suno temp URL) to its live, durable Firestore
 * value. Generated per-scene media ids embed the scene docId
 * (`media-narration-<docId>-…`, `media-video-<docId>…`,
 * `media-frame-<docId>-…`); project-level BGM is matched by `media-music-`
 * id / `music` role / `Music` category and healed against `musicUrl`.
 *
 * Conservative by design — a rewrite happens ONLY when the live replacement
 * is itself a non-ephemeral http(s) URL that differs from the current value,
 * so durable URLs and user imports are never disturbed and a still-temp
 * (un-mirrored) field is left alone rather than swapped for another dead
 * link. Mutates the passed items in place (nulls the stale in-memory blob so
 * the hydrate pass re-fetches + re-caches) and returns the count healed.
 * Pure + Firestore-free so it can be unit-tested — see voidspace-loader.test.ts.
 */
export function healStaleGeneratedMediaUrls(
  items: HealableMediaItem[],
  liveScenes: HealableScene[],
  musicUrl?: unknown,
): number {
  let healed = 0;
  const repoint = (m: HealableMediaItem, durable: unknown): void => {
    if (
      typeof durable === "string" &&
      /^https?:\/\//i.test(durable) &&
      !isEphemeralMediaHost(durable) &&
      durable !== m.originalUrl
    ) {
      m.originalUrl = durable;
      if (!(m.blob instanceof Blob)) m.blob = null;
      if (m.type === "image") m.thumbnailUrl = durable;
      healed++;
    }
  };

  for (const m of items) {
    if (!isEphemeralMediaHost(m?.originalUrl) || typeof m?.id !== "string") continue;
    const id = m.id;
    const scene = liveScenes.find(
      (s) =>
        id.startsWith(`media-narration-${s._docId}-`) ||
        id.startsWith(`media-video-${s._docId}`) ||
        id.startsWith(`media-frame-${s._docId}-`),
    );
    if (scene) {
      if (id.startsWith("media-narration-")) repoint(m, scene.narration_url);
      else if (id.startsWith("media-video-")) repoint(m, scene.video_url);
      else if (id.startsWith("media-frame-")) repoint(m, scene.first_frame_url);
    } else if (id.startsWith("media-music-") || m.role === "music" || m.category === "Music") {
      repoint(m, musicUrl);
    }
  }
  return healed;
}

/**
 * Load a Voidspace scene list and build a complete OpenReel Project.
 */
export async function loadSceneListAsProject(
  userId: string,
  sceneListId: string,
): Promise<Project> {
  console.log(`[voidspace-loader] Loading scene list: ${sceneListId} for user: ${userId}`);

  // 1) Fetch scene list metadata
  const slDoc = await getDoc(
    doc(db, "users", userId, "scene_lists", sceneListId),
  );
  if (!slDoc.exists()) {
    throw new Error(`Scene list "${sceneListId}" not found`);
  }
  const slData = slDoc.data();
  console.log(`[voidspace-loader] Scene list found: ${slData.name || sceneListId}`);

  // ── Project-state blob: the source of truth ────────────────────────
  // The editor's autoSaveManager serialises the full openreel Project
  // (timeline tracks, clips, mediaLibrary, textClips/captions, settings,
  // ActionHistory) to `scene_lists/{id}.project_state.json` on every
  // save. When present, this blob IS the project — no per-scene rebuild
  // needed, no field translation. openreel's own serializer + loadProject
  // handle deserialisation; everything round-trips natively.
  //
  // The per-scene Firestore fields (`scene.video_url`, `scene.narration_url`,
  // `videos/`, `narrations/` subcollections) are now used ONLY to bootstrap
  // a fresh project (no blob yet — first load after generation pipeline
  // produces media). Once the editor's first autosave fires, the blob
  // takes over forever.
  //
  // Agent edits go through editorBridge RPCs (patchClip, addClip,
  // addSfxClip, etc.), which dispatch through the editor's ActionExecutor
  // → ActionHistory → autoSaveManager. The blob captures them. There's
  // no parallel "agent writes per-scene + we reconcile" path — that's
  // the freshness/staleness machinery we just deleted.
  // The blob lives in Cloud Storage now; the scene_list document carries only a
  // pointer. `fetchProjectStateBlob` returns the SAME `{ json, history }` shape
  // the field used to have — deliberately, so none of the validation below had
  // to change — and falls back to the inline field for a project that has not
  // been migrated yet or when the fetch fails.
  const projectStateRaw = await fetchProjectStateBlob(
    sceneListId,
    (slData as Record<string, unknown>).project_state as { json?: string; history?: string } | undefined,
  );
  if (projectStateRaw && typeof projectStateRaw.json === "string" && projectStateRaw.json) {
    try {
      const parsed = JSON.parse(projectStateRaw.json) as Project;
      // POISONED-BLOB SELF-HEAL. Before the cross-project save guard shipped
      // (2026-07-18), a project switch could write project A's blob into
      // project B's scene_list — B then showed A's timeline forever ("wrong
      // project data"). Every voidspace project id embeds its scene-list id
      // as the trailing segment; a blob whose id belongs to a DIFFERENT
      // scene list is corruption, never legitimate. Discard it and rebuild
      // from this project's own scene tree (the next autosave overwrites
      // the poison with a correct blob). Do NOT carry its history or
      // tombstones — they belong to the other project.
      const blobId = typeof (parsed as any)?.id === "string" ? String((parsed as any).id) : "";
      if (blobId.startsWith("voidspace") && !blobId.endsWith(sceneListId)) {
        console.warn(
          `[voidspace-loader] project_state blob belongs to ANOTHER project (blob id ${blobId} ≠ scene list ${sceneListId}) — discarding poisoned blob, rebuilding from scenes`,
        );
      } else if (parsed && typeof parsed === "object" && parsed.timeline) {
        // Empty-blob safety net. If the blob's timeline is completely
        // empty (no tracks AND no media) but the chat doc has scenes,
        // a stale autosave wiped the project state — likely from a
        // wholesale loadProject() that beat the per-scene rebuild, an
        // early-firing save during a transient empty state, or an
        // agent edit chain that emptied the timeline. Without this
        // guard, the loader prefers the empty blob forever and the
        // user permanently loses access to their per-scene media —
        // even though the scenes still exist in Firestore.
        //
        // Fall back to per-scene rebuild but keep the persisted
        // history so snapshots survive (caller still gets the chance
        // to navigate back via the History panel if they want).
        const tracksCount = Array.isArray(parsed.timeline.tracks) ? parsed.timeline.tracks.length : 0;
        const totalClips = (parsed.timeline.tracks ?? []).reduce((n: number, t: any) => n + ((t?.clips?.length) ?? 0), 0);
        const mediaCount = parsed.mediaLibrary?.items?.length ?? 0;
        const textClipsCount = (parsed as any).textClips?.length ?? 0;
        const blobIsEmpty = tracksCount === 0 && totalClips === 0 && mediaCount === 0 && textClipsCount === 0;
        const scenesArr = (slData as Record<string, unknown>).scenes;
        const sceneListHasScenes = Array.isArray(scenesArr) ? scenesArr.length > 0 : false;

        // Stale-blob detection. The blob is only refreshed by the
        // editor's autosave; per-scene Firestore writes from the chat
        // (one per approveClip) bypass it entirely. So when the chat
        // generates Scene N+1 AFTER the editor already autosaved with
        // Scenes 1..N, the blob is missing the new scene's video and
        // returning it here would silently drop Scene N+1 from the
        // timeline (it'd never render, and the user would see only
        // the older scenes in the editor).
        //
        // Detect this by comparing the set of scene docIds with a
        // `video_url` in Firestore against the set of scene docIds
        // represented in the blob's mediaLibrary. The per-scene
        // rebuild path mints media item ids as
        // `media-video-${idKey}-${primaryVideo?.id ?? "fallback"}`
        // (see further down), so the docId is the stable prefix.
        // When Firestore has scenes the blob hasn't seen, fall
        // through to per-scene rebuild; `applyAdditiveMerge` on the
        // editor side then folds the new scene's media + clip into
        // the live project without disturbing existing user edits
        // (text clips, layout drift) that already came from the blob.
        let staleBlobMissing = 0;
        let firestoreVideoSceneCount = 0;
        let blobVideoSceneCount = 0;
        try {
          const firestoreScenes = await fetchScenes(userId, sceneListId);
          const firestoreVideoSceneIds: string[] = [];
          // Narration counts too. This probe used to look at `video_url` ONLY,
          // so a scene that gained a NARRATION but no new video left the blob
          // looking fresh: the per-scene rebuild was skipped and the voiceover
          // never reached the timeline. The audio existed everywhere else — on
          // disk, in Firestore, and the to-do read "done (media verified)" — so
          // the only place it was missing was the one that matters.
          const firestoreNarrationSceneIds: string[] = [];
          for (const s of firestoreScenes) {
            const vu = (s as any).video_url;
            if (typeof vu === "string" && vu) {
              firestoreVideoSceneIds.push(sceneIdKey(s as any));
            }
            const nu = (s as any).narration_url;
            if (typeof nu === "string" && nu) {
              firestoreNarrationSceneIds.push(sceneIdKey(s as any));
            }
          }
          firestoreVideoSceneCount = firestoreVideoSceneIds.length;
          // Match by prefix instead of regex. The per-scene rebuild
          // mints media ids as `media-video-${idKey}-${primaryVideo.id ?? "fallback"}`,
          // and primaryVideo.id is typically a UUID-with-dashes, so a
          // single regex like `^media-video-(.+?)-([^-]+|fallback)$`
          // splits the wrong way and pulls part of the UUID into the
          // captured docId — making every scene look "missing from
          // blob" even when it isn't. Iterating firestore docIds and
          // checking startsWith on the blob's media library is
          // unambiguous.
          const mediaItems = parsed.mediaLibrary?.items ?? [];
          const idsWithPrefix = (prefix: string): string[] => {
            const out: string[] = [];
            for (const m of mediaItems as Array<{ id?: string }>) {
              if (typeof m?.id === "string" && m.id.startsWith(prefix)) out.push(m.id);
            }
            return out;
          };
          // Same prefix-matching rule for both kinds (see the note above about
          // why startsWith beats a regex here).
          const countCovered = (sceneIds: string[], kind: string): number => {
            const ids = idsWithPrefix(`media-${kind}-`);
            let n = 0;
            for (const sceneId of sceneIds) {
              if (ids.some((mid) => mid.startsWith(`media-${kind}-${sceneId}-`))) n += 1;
            }
            return n;
          };
          blobVideoSceneCount = countCovered(firestoreVideoSceneIds, "video");
          const blobNarrationSceneCount = countCovered(firestoreNarrationSceneIds, "narration");
          const missingVideos = firestoreVideoSceneCount - blobVideoSceneCount;
          const missingNarrations =
            firestoreNarrationSceneIds.length - blobNarrationSceneCount;
          staleBlobMissing = Math.max(0, missingVideos) + Math.max(0, missingNarrations);
          if (missingNarrations > 0) {
            console.warn(
              `[voidspace-loader] blob is missing ${missingNarrations} scene narration(s) — rebuilding so the voiceover reaches the timeline.`,
            );
          }
        } catch (e) {
          // If the staleness probe fails, fall back to the existing
          // behaviour (return blob). The live subscription will retry
          // on the next snapshot tick.
          console.warn(
            "[voidspace-loader] stale-blob check failed (continuing with blob):",
            e,
          );
        }

        if (blobIsEmpty && sceneListHasScenes) {
          console.warn(
            `[voidspace-loader] project_state blob is EMPTY but scene_list has ${Array.isArray(scenesArr) ? scenesArr.length : 0} scenes — falling back to per-scene rebuild. Stale empty autosave detected.`,
          );
          // Stash the persisted history on the rebuild target, so we
          // get assigned to the rebuilt project below.
          if (typeof projectStateRaw.history === "string") {
            (slData as any).__pendingHistoryData = projectStateRaw.history;
          }
          // Carry the blob's deletion tombstones into the rebuild — the
          // rebuild re-derives every track from scene_lists and would
          // otherwise resurrect tracks the user deleted (the deletion only
          // exists as an absence in this blob).
          if (Array.isArray((parsed as any)?.deletedTracks)) {
            (slData as any).__pendingDeletedTracks = (parsed as any).deletedTracks;
          }
          // Fall through to per-scene rebuild.
        } else if (staleBlobMissing > 0) {
          console.warn(
            `[voidspace-loader] project_state blob is STALE — Firestore has ${firestoreVideoSceneCount} scene video(s), blob covers ${blobVideoSceneCount}. Missing ${staleBlobMissing}. Rebuilding to pick the new clip(s) up, then MERGING the saved arrangement back over it.`,
          );
          /**
           * KEEP THE USER'S CUT ACROSS THE REBUILD.
           *
           * The rebuild is still how new clips are discovered — it is the only
           * thing that reads scene docs. What changed is what happens to the
           * blob afterwards: it used to be dropped, which reverted the timeline
           * to storyboard order and threw away every trim and reorder the user
           * had made. Now it is carried through and merged back on at the end
           * (`mergeSavedArrangement`), so the rebuild contributes ONLY the
           * material the saved project had never seen.
           *
           * Stashed on `slData` exactly like `__pendingHistoryData` and
           * `__pendingDeletedTracks` — the established way this function passes
           * something from the blob branch into the rebuild.
           */
          (slData as any).__pendingSavedProject = parsed;
          if (typeof projectStateRaw.history === "string") {
            (slData as any).__pendingHistoryData = projectStateRaw.history;
          }
          if (Array.isArray((parsed as any)?.deletedTracks)) {
            (slData as any).__pendingDeletedTracks = (parsed as any).deletedTracks;
          }
          // Fall through to per-scene rebuild.
        } else {
          // Stash the serialised ActionHistory on the project as a
          // non-standard `__historyData` field. App.tsx peels this off
          // after `loadProject` runs and rehydrates the actionHistory.
          // Without this, undo/redo + chat-message snapshot restore
          // would silently die on every reload (the loader returns a
          // fresh project but `loadProject` mints an empty
          // ActionHistory, dropping all bookmarks).
          if (typeof projectStateRaw.history === "string") {
            (parsed as any).__historyData = projectStateRaw.history;
          }
          // Load-time transition scrub. Older blobs may contain transitions
          // with duplicate ids (root cause: action-executor used to mint
          // `transition-${Date.now()}` with no jitter, so a tight loop of
          // adds collided). Duplicate ids poison the bridge's
          // Map<id, transition> on register and the entire video preview
          // goes black. Strip duplicate-id and orphan transitions here so
          // a corrupt blob from before the executor fix is auto-healed on
          // load instead of breaking the renderer.
          let transitionsScrubbed = 0;
          for (const tr of (parsed.timeline?.tracks ?? []) as any[]) {
            const transitions: any[] = Array.isArray(tr.transitions) ? tr.transitions : [];
            if (transitions.length === 0) continue;
            const clipIds = new Set<string>((tr.clips ?? []).map((c: any) => c.id));
            const seen = new Set<string>();
            const cleaned: any[] = [];
            for (const t of transitions) {
              if (!t || typeof t.id !== "string") { transitionsScrubbed++; continue; }
              if (seen.has(t.id)) { transitionsScrubbed++; continue; }
              if (!clipIds.has(t.clipAId) || !clipIds.has(t.clipBId)) { transitionsScrubbed++; continue; }
              seen.add(t.id);
              cleaned.push(t);
            }
            if (cleaned.length !== transitions.length) {
              tr.transitions = cleaned;
            }
          }
          if (transitionsScrubbed > 0) {
            console.warn(`[voidspace-loader] Scrubbed ${transitionsScrubbed} corrupt transition(s) from blob (duplicate id or missing clip refs). Project will render as hard cuts where transitions were dropped.`);
          }
          // Music-track auto-heal. Older blobs minted before the
          // per-scene-music collapse landed in the rebuild path stamped
          // ONE music clip per scene on `track-music` even when the
          // entire project used a single global BGM. The clips are
          // contiguous (each scene picks up where the previous left
          // off via lastMusicOutPointSec), so playback is seamless —
          // but the timeline UI shows N stacked clips for what the
          // user expects to see as ONE BGM track, and a fresh BGM
          // approve doesn't visually replace the duplicates (the
          // blob keeps them frozen forever). Collapse adjacent same-
          // mediaId contiguous clips here so existing projects
          // self-repair on next load. Per-scene-override case (genuinely
          // different mediaIds per scene) is preserved.
          let musicClipsCollapsed = 0;
          for (const tr of (parsed.timeline?.tracks ?? []) as any[]) {
            if (tr?.id !== "track-music" || !Array.isArray(tr.clips) || tr.clips.length < 2) continue;
            const sorted = [...tr.clips].sort(
              (a: any, b: any) => (a.startTime ?? 0) - (b.startTime ?? 0),
            );
            const EPS = 0.01;
            const collapsed: any[] = [];
            for (const c of sorted) {
              const last = collapsed[collapsed.length - 1];
              if (
                last &&
                last.mediaId === c.mediaId &&
                Math.abs((last.startTime ?? 0) + (last.duration ?? 0) - (c.startTime ?? 0)) < EPS &&
                Math.abs((last.outPoint ?? 0) - (c.inPoint ?? 0)) < EPS
              ) {
                last.duration = (c.startTime ?? 0) + (c.duration ?? 0) - (last.startTime ?? 0);
                last.outPoint = c.outPoint;
                musicClipsCollapsed++;
              } else {
                collapsed.push(c);
              }
            }
            if (collapsed.length !== tr.clips.length) {
              tr.clips = collapsed;
            }
          }
          if (musicClipsCollapsed > 0) {
            console.warn(`[voidspace-loader] Collapsed ${musicClipsCollapsed} duplicate per-scene music clip(s) into contiguous segments. Old per-scene-BGM blob auto-healed.`);
          }

          // ── Stale generated-media URL heal ──
          // project_state froze whatever media URL was live at save time.
          // Generated assets (narration / video / frames / BGM) come from
          // upstreams with ~3-day TTLs; the chat pipeline mirrors each to a
          // durable GCS copy and repoints the per-scene Firestore field, but
          // that repoint lands AFTER the editor blob was saved with the temp
          // URL — and the blob is the load SSOT, so the timeline 404s once the
          // TTL lapses even though the chat (reading live Firestore) still
          // plays it. Re-point frozen temp-host URLs to their live durable
          // value via the pure matcher (unit-tested in voidspace-loader.test).
          // Same shape as the transition / music auto-heals above. Cheap
          // pre-check gates the extra Firestore read to blobs that need it.
          try {
            const items = (parsed.mediaLibrary?.items ?? []) as HealableMediaItem[];
            if (items.some((m) => isEphemeralMediaHost(m?.originalUrl))) {
              const liveScenes = await fetchScenes(userId, sceneListId);
              const healed = healStaleGeneratedMediaUrls(
                items,
                liveScenes,
                (slData as Record<string, unknown>).music_url,
              );
              if (healed > 0) {
                console.warn(`[voidspace-loader] Healed ${healed} stale generated-media URL(s) in project_state blob → live durable Firestore value (expired temp-host link(s) re-pointed; will re-fetch + cache to IndexedDB).`);
              }
            }
          } catch (e) {
            console.warn("[voidspace-loader] stale-media-URL heal skipped (non-blocking):", e);
          }

          // ── Graphic-layer blend heal ──
          // A blob saved before the loader started stamping `screen` on graphic
          // clips holds an overlay that COVERS the shot instead of sitting on
          // it, and because this branch is the load SSOT no amount of
          // re-sending the board would ever reach it. Same shape as the heals
          // above; see `healGraphicBlend`.
          let blended = healGraphicBlends(parsed);
          if (!blended.name || blended.name === "Voidspace Project") {
            blended = { ...blended, name: slData.name || slData.title || slData.avatar_name || "Voidspace Project" };
          }

          console.log(`[voidspace-loader] Using project_state blob (${projectStateRaw.json.length} bytes${projectStateRaw.history ? `, +${projectStateRaw.history.length}b history` : ""})`);
          // Heal legacy '-fallback' media ids (cross-project IndexedDB
          // blob collisions) before the blob enters the store.
          return migrateLegacyFallbackMediaIds(blended);
        }
      } else {
        console.warn("[voidspace-loader] project_state blob malformed, falling back to per-scene bootstrap");
      }
    } catch (e) {
      console.warn("[voidspace-loader] project_state JSON.parse failed, falling back:", e);
    }
  }

  // Resolve canvas dimensions. Priority order:
  //   1. `?aspect=…` query param on the iframe URL — wins over Firestore
  //      because the studio chat sets it from the welcome picker LIVE,
  //      so even if the doc was minted with a stale value (rehydrated
  //      session, race), the canvas matches what the user chose.
  //   2. `aspect_ratio` on the scene_list doc (canonical).
  //   3. `aspect` (legacy alias) on the scene_list doc.
  //   4. Default 16:9.
  // Every media item built below carries matching width/height — keeping
  // the openreel canvas, timeline thumbnails, and the final Remotion
  // encode all in lockstep.
  let urlAspect: string | undefined;
  if (typeof window !== 'undefined') {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = params.get('aspect');
      if (v) urlAspect = v;
    } catch {
      // ignore — fall through to Firestore.
    }
  }
  const dim = resolveAspectDimensions(
    urlAspect
      ?? (slData as Record<string, unknown>).aspect_ratio
      ?? (slData as Record<string, unknown>).aspect,
  );
  const mediaMeta = (overrides: Partial<MediaMetadata> = {}) =>
    makeMediaMeta(overrides, dim);

  // Populate scene list context in Voidspace store
  setSceneListContext(sceneListId, slData as Record<string, unknown>);

  // 2) Fetch all scenes
  const scenes = await fetchScenes(userId, sceneListId);
  console.log(`[voidspace-loader] Fetched ${scenes.length} scenes (doc IDs: ${scenes.map(s => s._docId).join(', ')})`);

  // 3) For each scene, fetch media in parallel
  const sceneMedia = await Promise.all(
    scenes.map(async (scene) => {
      const docId = scene._docId;
      // sfx_list array on the scene doc is the canonical source.
      // fetchSceneSfx falls back to subcollection only if absent.
      const inlineSfx = (scene as any).sfx_list as any[] | undefined;
      const [videos, images, narrations, sfxs] = await Promise.all([
        fetchSceneVideos(userId, sceneListId, docId),
        fetchSceneImages(userId, sceneListId, docId),
        fetchSceneNarrations(userId, sceneListId, docId),
        fetchSceneSfx(userId, sceneListId, docId, inlineSfx),
      ]);
      return { scene, videos, images, narrations, sfxs };
    }),
  );

  // 3b) PARALLEL media prewarm. The build loop below resolves + downloads
  // every asset SERIALLY (video, frame, narration, sfx per scene — each
  // awaited in order), so a 10-scene automation project serialized ~30
  // network fetches and the timeline couldn't render until the LAST one
  // finished. Warming the module-level resolvedUrlCache/mediaBlobCache in
  // parallel first makes the serial loop hit cache instantly — wall-clock
  // becomes the slowest single download instead of the sum of all of them.
  {
    const rawUrls = new Set<string>();
    const add = (u: unknown) => {
      if (typeof u === "string" && u.trim()) rawUrls.add(u.trim());
    };
    add((slData as any).music_url);
    for (const { scene, videos, images, narrations, sfxs } of sceneMedia) {
      const s = scene as any;
      add(s.first_frame_url); add(s.generated_first_frame_url);
      add(s.preview_image_url); add(s.image_url);
      add(s.narration_url); add(s.music_url); add(s.video_url);
      for (const v of videos as any[]) { add(v.url); add(v.video_url); }
      for (const im of images as any[]) { add(im.url); add(im.image_url); }
      for (const n of narrations as any[]) { add(n.narration_url); add(n.url); }
      for (const sx of sfxs as any[]) { add(sx.url); add(sx.sfx_url); add(sx.audio_url); }
    }
    if (rawUrls.size > 0) {
      const t0 = performance.now();
      await Promise.all(
        [...rawUrls].map(async (raw) => {
          try {
            const resolved = await resolveMediaUrl(raw);
            if (resolved) await fetchMediaBlob(resolved);
          } catch { /* the build loop keeps its own per-asset error handling */ }
        }),
      );
      console.log(
        `[voidspace-loader] Prewarmed ${rawUrls.size} media URLs in ${Math.round(performance.now() - t0)}ms`,
      );
    }
  }

  // 4) Build media library + timeline
  const mediaItems: MediaItem[] = [];
  const videoTrackClips: Clip[] = [];
  // What each picture clip's scene says about the cut INTO it — the input to
  // `buildSceneBoundaryTransitions` once the track is laid out.
  const sceneBoundaryByClip = new Map<string, SceneBoundaryInfo>();
  /**
   * Alternate takes, keyed by their POSITION in the stack (2, 3, 4…).
   *
   * Keyed by position rather than by shot so that every shot's second take
   * shares one "Take 2" track. Unhiding it then shows the alternate for exactly
   * the shots that have one, and leaves every other shot showing what it showed
   * — which is what makes comparing across a whole cut possible in one gesture.
   */
  const alternateTakeClips = new Map<number, Clip[]>();
  /**
   * The GRAPHIC LAYERS, keyed by layer position — the same idea as the takes
   * above, for the same reason: every shot's first layer shares "Graphic 1", so
   * a forty-shot film gets one or two extra rows rather than forty.
   */
  const graphicLayerClips = new Map<number, Clip[]>();
  /**
   * Screenplay sequences, as stretches of the finished timeline.
   *
   * Filled as the scene loop walks the film, because that loop is the only
   * place that knows where each shot ends up in time. Turned into nested
   * sequences after the tracks are assembled — see `buildSequenceCompounds`.
   */
  const sequenceSpans: Array<{ name: string; startTime: number; endTime: number }> = [];
  // Stills for scenes that have no moving picture at all. An ordinary clip on
  // an ordinary track — the point is the user SEES it in the timeline and can
  // move, trim or delete it, rather than it being missing entirely.
  const imageTrackClips: Clip[] = [];
  const narrationTrackClips: Clip[] = [];
  const sfxTrackClips: Clip[] = [];
  const musicTrackClips: Clip[] = [];
  const musicTrackSpecs: Array<{
    mediaId: string;
    sceneDocId: string;
    startTime: number;
    duration: number;
    inPoint: number;
    outPoint: number;
  }> = [];
  // Captions are emitted as TextClips on `track-captions` so the
  // standard openreel Inspector (Transform, Alignment, Effects, Text
  // Properties, Animation) operates on them like any other text. The
  // legacy `timeline.subtitles` array is kept empty to avoid double-
  // rendering on top of the TextClips.
  const subtitles: Subtitle[] = [];
  const captionTextClips: TextClip[] = [];
  // Caption sizing is proportional to the composition HEIGHT so captions are
  // viral-sized (~7.2%) and stay consistent across aspect ratios / resolutions.
  // The old fixed 72px looked tiny on a 1080x1920 vertical comp. Outline +
  // shadow scale with the font so legibility holds at any size. This ratio
  // matches the "Kinetic" preset in CaptionStylePanel.
  const captionFontSize = Math.round(dim.height * 0.072);
  const captionStyle = {
    ...CAPTION_TEXT_STYLE,
    fontSize: captionFontSize,
    strokeWidth: Math.max(4, Math.round(captionFontSize * 0.09)),
    shadowColor: "rgba(0,0,0,0.9)",
    shadowBlur: Math.round(captionFontSize * 0.18),
    shadowOffsetX: 0,
    shadowOffsetY: Math.round(captionFontSize * 0.06),
  };
  const pushCaption = (
    text: string,
    startTime: number,
    endTime: number,
    sceneDocId: string,
    chunkIdx: number,
    words?: { text: string; start: number; end: number }[],
  ) => {
    const duration = Math.max(0.1, endTime - startTime);
    captionTextClips.push({
      id: `caption-${sceneDocId}-${chunkIdx}`,
      trackId: "track-captions",
      startTime,
      duration,
      text,
      style: { ...captionStyle },
      transform: { ...CAPTION_DEFAULT_TRANSFORM },
      keyframes: [],
      // Kinetic word-pop: per-word timing (clip-relative) so the spoken word
      // is highlighted in sync. Present for dialogue/narration captions; lyrics
      // segments (no per-word data) stay static.
      ...(words && words.length > 0
        ? {
            captionWords: words,
            captionHighlight: true,
            captionHighlightColor: "#FFE600",
            captionAnimation: "word-highlight" as const,
          }
        : {}),
    });
  };

  let currentTime = 0; // running timeline position in seconds
  let fallbackMusicMediaId: string | null = null;
  let totalMusicDuration = 0;
  const musicMediaIdsByUrl = new Map<string, string>();
  let lastMusicMediaId: string | null = null;
  let lastMusicOutPointSec: number | null = null;

  const ensureMusicMediaItem = async (
    rawUrl: string | null | undefined,
    preferredTitle?: string,
  ): Promise<string | null> => {
    const resolvedUrl = await resolveMediaUrl(rawUrl ?? null);
    if (!resolvedUrl) return null;

    const existingMediaId = musicMediaIdsByUrl.get(resolvedUrl);
    if (existingMediaId) return existingMediaId;

    // Stable mediaId derived from the resolved URL — same hashing
    // rationale as scene video / narration above (id stability across
    // live-rebuilds → preserves selection + dedupes additive merges).
    const mediaId = `media-music-${stableHash(resolvedUrl)}`;
    musicMediaIdsByUrl.set(resolvedUrl, mediaId);
    // Fetch the music blob so the export-time audio engine can decode it.
    // Without a blob, getAudioBuffer() in audio-engine.ts returns null and
    // the track is silently dropped from the rendered MP4.
    const musicBlob = await fetchMediaBlob(resolvedUrl);
    mediaItems.push({
      id: mediaId,
      name: preferredTitle || "Background Music",
      type: "audio",
      fileHandle: null,
      blob: musicBlob,
      metadata: mediaMeta({ duration: 300, fileSize: musicBlob?.size || 0 }), // placeholder duration, updated from clips below
      thumbnailUrl: null,
      waveformData: null,
      originalUrl: resolvedUrl,
      category: "Music",
      role: "music",
      sourceFile: deriveMirrorSourceFile("music", undefined, undefined, resolvedUrl, musicBlob),
    });

    if (!fallbackMusicMediaId) {
      fallbackMusicMediaId = mediaId;
    }

    return mediaId;
  };

  // Track the global music URL so we create one media item for it
  await ensureMusicMediaItem(
    slData.music_url ?? scenes.find((s) => s.music_url)?.music_url ?? null,
    slData.music_title || "Background Music",
  );

  for (const { scene, videos, images, narrations, sfxs } of sceneMedia) {
    /**
     * THE KEY THAT MEDIA AND CLIP IDS ARE BUILT FROM — and it must survive a
     * reorder, which `_docId` does not.
     *
     * `_docId` is the scene NUMBER. Insert one shot in the middle of a
     * storyboard and every scene below renumbers, so every id derived from it
     * changes: `clip-video-3` becomes `clip-video-4`, and so on down the film.
     * The comment on `mediaId` below explains why that matters — the editor's
     * live subscription merges ADDITIVELY, and it identifies what it already has
     * by id. Renamed ids read as brand-new clips, so a recompile with the editor
     * open would leave the old ones in place and add a full second copy of every
     * scene below the insertion point.
     *
     * `source_shot_id` is stable for the life of the shot: inserting something
     * above it does not change it. That is exactly what it was made
     * load-bearing for (see `compile.post.ts`), and this is the second place it
     * pays for itself.
     *
     * FALLS BACK to `_docId` when absent, so a project that did not come from a
     * board — where there are no shot ids — keeps precisely the ids it has
     * today. Projects that DID come from a board see their ids change once, and
     * a reload settles it; the alternative is duplication every time somebody
     * inserts a shot.
     */
    const idKey = sceneIdKey(scene as any);

    const sceneFallbackVideoUrl = await resolveMediaUrl(
      scene.video_url ?? scene.url ?? null,
    );
    const sceneFallbackImageUrl = await resolveMediaUrl(
      scene.image_url ?? scene.first_frame_url ?? scene.preview_image_url ?? null,
    );

    // Pick the primary video. Prefer the asset whose URL matches the
    // scene-level `video_url` — that field is the chat side's
    // authoritative pointer to the latest approved clip, so honoring
    // it makes regen-approve actually swap the clip on the timeline
    // instead of replaying the oldest doc that happens to be tagged
    // `primary` from a prior generation.
    const videosWithUrls = videos.filter((v) => v.url || v.video_url);
    const primaryVideo =
      (scene.video_url
        ? videosWithUrls.find((v) => (v.url ?? v.video_url) === scene.video_url)
        : null) ??
      videosWithUrls.find((v) => v.tag === "primary") ??
      videosWithUrls[videosWithUrls.length - 1] ??
      null;
    const videoUrl = await resolveMediaUrl(
      primaryVideo?.url ?? primaryVideo?.video_url ?? sceneFallbackVideoUrl ?? null,
    );

    // Pick the primary image. Same idea as video — prefer whichever
    // asset matches the scene-level pointer so a regen-approved frame
    // wins over the first-tagged doc.
    const sceneImagePointer =
      scene.image_url ?? scene.first_frame_url ?? scene.preview_image_url ?? null;
    const primaryImage =
      (sceneImagePointer
        ? images.find((i) => (i.url ?? i.image_url) === sceneImagePointer)
        : null) ??
      images.find((i) => i.tag === "first_frame") ??
      images.find((i) => i.tag === "generated_first_frame") ??
      images[images.length - 1] ??
      null;
    const imageUrl = await resolveMediaUrl(
      primaryImage?.url ?? primaryImage?.image_url ?? sceneFallbackImageUrl ?? null,
    );

    // Pick narration. Same pointer-first rule so the editor swaps to
    // the regenerated TTS instead of the first-inserted doc — which
    // never matched the chat side's slider selection after regen.
    const narration =
      (scene.narration_url
        ? narrations.find(
            (n) => (n.narration_url ?? n.url) === scene.narration_url,
          )
        : null) ??
      narrations[narrations.length - 1] ??
      null;
    const narrationUrl =
      (await resolveMediaUrl(
        narration?.narration_url ??
          narration?.url ??
          scene.narration_url ??
          null,
      )) ?? null;

    // Per-scene-bootstrap path only — once the blob exists, this code
    // is bypassed entirely. music_disabled / narration_disabled flags
    // are no longer written (deleted via the bigger refactor); the
    // blob captures music presence/absence directly.
    const sceneMusicMediaId =
      (await ensureMusicMediaItem(
        scene.music_url ?? slData.music_url ?? null,
        scene.music_title || slData.music_title || "Background Music",
      )) ?? fallbackMusicMediaId;

    const { startMs: musicStartMs, endMs: musicEndMs } =
      resolveSceneMusicTimingMs(scene);
    const musicStartSec =
      musicStartMs != null ? Math.max(0, musicStartMs / 1000) : null;
    const musicEndSec =
      musicEndMs != null ? Math.max(0, musicEndMs / 1000) : null;

    // ── Resolve persisted video trim (Flutter parity) ──
    // Either side can store a trim window for the scene's primary video:
    //   - scene-level: `video_start_ms` / `video_end_ms` / `video_duration_ms`
    //     (web-side patchClip mirror writes here so the agent's edit_clip
    //      survives reload)
    //   - video-doc level: `start_ms` / `end_ms` (Flutter automation pipeline
    //     writes here)
    // Scene-level wins when both are present so a per-scene tweak survives
    // a video regen that mints a fresh primaryVideo doc.
    const videoStartMsRaw =
      typeof (scene as any).video_start_ms === "number"
        ? (scene as any).video_start_ms
        : typeof primaryVideo?.start_ms === "number"
          ? primaryVideo.start_ms
          : null;
    const videoEndMsRaw =
      typeof (scene as any).video_end_ms === "number"
        ? (scene as any).video_end_ms
        : typeof primaryVideo?.end_ms === "number"
          ? primaryVideo.end_ms
          : null;
    const hasVideoTrim =
      videoStartMsRaw != null &&
      videoEndMsRaw != null &&
      videoEndMsRaw > videoStartMsRaw;

    /**
     * The measured length of the take that PLAYS, when compile sent one.
     *
     * `primary` marks it — compile puts the chosen take first and flags exactly
     * one. Read by flag rather than by position so nothing here re-derives which
     * take is playing.
     */
    const playingTakeSec = (() => {
      const list = Array.isArray((scene as any).take_list)
        ? ((scene as any).take_list as any[])
        : [];
      const primary = list.find((t) => t?.primary === true) ?? list[0];
      const sec = Number(primary?.duration_sec);
      return Number.isFinite(sec) && sec > 0 ? sec : 0;
    })();

    // Compute scene duration from available timing data
    let sceneDuration = DEFAULT_SCENE_DURATION;
    if (hasVideoTrim) {
      // A trim shrinks the scene's slot on the timeline. Narration /
      // captions / SFX placed inside this scene rebase against the
      // shorter window automatically because they all use `currentTime`
      // (cumulative) + their own offsets.
      sceneDuration = (videoEndMsRaw! - videoStartMsRaw!) / 1000;
    } else if (primaryVideo?.duration_ms) {
      sceneDuration = primaryVideo.duration_ms / 1000;
    } else if (playingTakeSec > 0) {
      /**
       * A BOARD-COMPILED SHOT: THE PLAYING TAKE'S MEASURED LENGTH.
       *
       * Compile writes the take's url into `video_url` and its real, measured
       * duration into `take_list` — but it creates no ASSET row, so
       * `primaryVideo` is null and every board shot fell through to the 6s
       * default below. Measured on a real compile: a 10.04s take arrived as a
       * 6s clip and FOUR SECONDS OF THE USER'S FOOTAGE WERE SILENTLY CUT.
       *
       * The scene's planned `duration_seconds` is deliberately NOT used here.
       * It is what somebody asked for before anything existed; once a take is
       * chosen the shot IS that take's length, and a model that snaps 7s to 8s
       * would otherwise trim a second off its own output.
       *
       * It matters twice over now that graphics exist: a layer is placed against
       * this slot, so an end-anchored end card would land four seconds before
       * the picture actually ends.
       */
      sceneDuration = playingTakeSec;
    } else if (musicStartSec != null && musicEndSec != null) {
      sceneDuration = musicEndSec - musicStartSec;
    } else if (
      scene.narration_start_ms != null &&
      scene.narration_end_ms != null
    ) {
      sceneDuration = (scene.narration_end_ms - scene.narration_start_ms) / 1000;
    } else if (narration?.duration_ms) {
      sceneDuration = narration.duration_ms / 1000;
    }
    if (sceneDuration <= 0) sceneDuration = DEFAULT_SCENE_DURATION;

    // Build music track segments from scene trim timing (Flutter parity).
    // When music_start_ms/music_end_ms are present, use them as source in/out points.
    if (sceneMusicMediaId) {
      let inPoint: number | null = null;
      let outPoint: number | null = null;

      if (musicStartSec != null || musicEndSec != null) {
        inPoint =
          musicStartSec ??
          (musicEndSec != null ? Math.max(0, musicEndSec - sceneDuration) : 0);
        outPoint =
          musicEndSec ??
          (inPoint + sceneDuration);
      } else if (
        lastMusicOutPointSec != null &&
        lastMusicMediaId === sceneMusicMediaId
      ) {
        // Continue seamlessly if a previous scene established the source cursor.
        inPoint = lastMusicOutPointSec;
        outPoint = inPoint + sceneDuration;
      } else {
        // Backward compatibility for scenes without explicit trim timing.
        inPoint = 0;
        outPoint = sceneDuration;
      }

      if (inPoint != null && outPoint != null) {
        if (outPoint <= inPoint) {
          outPoint = inPoint + sceneDuration;
        }
        const duration = Math.max(0.001, Math.min(sceneDuration, outPoint - inPoint));
        const clippedOutPoint: number = inPoint + duration;

        musicTrackSpecs.push({
          mediaId: sceneMusicMediaId,
          sceneDocId: idKey,
          startTime: currentTime,
          duration,
          inPoint,
          outPoint: clippedOutPoint,
        });
        lastMusicMediaId = sceneMusicMediaId;
        lastMusicOutPointSec = clippedOutPoint;
      }
    }

    // ── Frame media item ──
    // Surface the scene's first-frame image in the editor's Assets
    // panel under "Frames". The image isn't placed on the timeline
    // (videoUrl handles that) but it must exist as its own media
    // entry so the user can preview / re-insert / drag-drop it.
    // Without this, generated frames lived only as `thumbnailUrl` on
    // the video clip and the Assets panel showed no Frames section
    // even when every scene had a first frame on disk.
    if (imageUrl) {
      const frameBlob = await fetchMediaBlob(imageUrl);
      const frameMediaId = `media-frame-${idKey}-${primaryImage?.id ?? stableHash(imageUrl)}`;
      mediaItems.push({
        id: frameMediaId,
        name: `Scene ${scene.scene_number} · Frame`,
        type: "image",
        fileHandle: null,
        blob: frameBlob,
        metadata: mediaMeta({ duration: 0, fileSize: frameBlob?.size || 0 }),
        thumbnailUrl: imageUrl,
        waveformData: null,
        originalUrl: imageUrl,
        category: "Frames",
        sceneNumber: scene.scene_number,
        shotId: scene.source_shot_id,
        role: "first_frame",
        sourceFile: deriveMirrorSourceFile("image", scene.scene_number, "first_frame", imageUrl, frameBlob),
      });
    }

    // ── Video clip ──
    // Only place the actual rendered video on the timeline. Scenes
    // without a generated video URL are skipped entirely — no image
    // fallback, no orphan image tracks. The user's chat flow guarantees
    // a video per scene before render is offered, so a missing video
    // means generation failed and we'd rather see a gap than a still.
    if (videoUrl) {
      const videoBlob = await fetchMediaBlob(videoUrl);
      // Stable IDs derived from Firestore doc keys so the editor's
      // selection / Inspector edits / undo history survive across the
      // periodic rebuilds the live subscription performs. Random
      // uuidv4()s would mint a fresh id on every Firestore tick which
      // (a) breaks selection mid-edit and (b) makes additive media-
      // library merges duplicate the same scene's video / narration.
      // Per-take suffix. When the videos-subcollection record can't be
      // matched (the media mirror rewrites scene.video_url to the durable
      // URL without touching the record, so the URL lookup misses), fall
      // back to a HASH OF THE URL — never a shared literal. The old
      // "fallback" literal made every take mint the SAME mediaId, so
      // applyAdditiveMerge saw no change and a regenerated take stayed
      // INVISIBLE on the timeline (the "replace on timeline not working"
      // bug). A URL-derived suffix changes whenever the take changes.
      const mediaId = `media-video-${idKey}-${primaryVideo?.id ?? stableHash(videoUrl)}`;
      mediaItems.push({
        id: mediaId,
        name: `Scene ${scene.scene_number} · Video`,
        type: "video",
        fileHandle: null,
        blob: videoBlob,
        metadata: mediaMeta({
          duration: sceneDuration,
          fileSize: videoBlob?.size || 0,
        }),
        thumbnailUrl: imageUrl,
        waveformData: null,
        originalUrl: videoUrl,
        category: "Scene Videos",
        sceneNumber: scene.scene_number,
        shotId: scene.source_shot_id,
        role: "primary",
        sourceFile: deriveMirrorSourceFile("video", scene.scene_number, "primary", videoUrl, videoBlob),
      });

      // inPoint / outPoint are SOURCE-FILE coordinates (which slice of the
      // underlying video to play); duration is timeline-slot length. When
      // a trim window was persisted, both move together — see
      // `hasVideoTrim` above. Without one, we play the whole source.
      const clipInPoint = hasVideoTrim ? videoStartMsRaw! / 1000 : 0;
      const clipOutPoint = hasVideoTrim
        ? videoEndMsRaw! / 1000
        : sceneDuration;
      videoTrackClips.push({
        id: `clip-video-${idKey}`,
        // Provenance: which board shot this came from. See Clip.shotId.
        shotId: scene.source_shot_id,
        mediaId,
        trackId: "track-video",
        startTime: currentTime,
        duration: sceneDuration,
        inPoint: clipInPoint,
        outPoint: clipOutPoint,
        effects: [],
        audioEffects: [],
        transform: makeDefaultTransform(),
        volume: primaryVideo?.has_embedded_audio ? 1 : 0,
        keyframes: [],
      });
      sceneBoundaryByClip.set(`clip-video-${idKey}`, {
        continuesPrevious: scene.continues_previous === true,
        transitionIn: scene.transition_in ?? null,
      });
    }

    /**
     * ── THE OTHER TAKES OF THIS SHOT ─────────────────────────────────────────
     *
     * Generated on the storyboard and carried here by compile as `take_list`.
     * Each one starts at the SAME instant as the clip above — they are
     * alternates, not a sequence — on its own muted, hidden track (built after
     * the loop). The user flips a track on to compare, drags one down to swap,
     * or razors across the stack to cut between them.
     *
     * The PRIMARY is skipped: it is already the video clip above. Skipping by
     * flag rather than by position, because `take_list` order is compile's and
     * nothing here should re-derive which one plays.
     *
     * EACH KEEPS ITS OWN LENGTH. A five-second take and an eight-second one are
     * genuinely different material; forcing both into the scene's slot would
     * hide that exactly when the user is deciding between them.
     */
    const takeList = Array.isArray((scene as any).take_list)
      ? ((scene as any).take_list as any[])
      : [];
    let takeSlot = 1;
    for (const t of takeList) {
      const takeUrl = String(t?.url ?? "");
      if (!takeUrl || t?.primary === true) continue;
      takeSlot += 1;

      const takeId = String(t?.id ?? "");
      const takeMediaId = `media-take-${idKey}-${takeId || takeSlot}`;
      const resolved = await resolveMediaUrl(takeUrl);
      if (!resolved) continue;

      const takeDuration = Number(t?.duration_sec) > 0
        ? Number(t.duration_sec)
        : sceneDuration;

      mediaItems.push({
        id: takeMediaId,
        name: `Scene ${scene.scene_number} · ${String(t?.label ?? `Take ${takeSlot}`)}`,
        type: "video",
        fileHandle: null,
        /**
         * NO BLOB, deliberately.
         *
         * The scene's own video is fetched so the renderer has bytes for it.
         * Alternates are hidden and muted by default — most of them are never
         * looked at — so pre-fetching every take of every shot would multiply
         * the cost of opening a storyboard-built project by the number of times
         * the user pressed Generate. The url is durable; the editor fetches on
         * demand when a track is unhidden.
         */
        blob: null,
        metadata: mediaMeta({ duration: takeDuration, fileSize: 0 }),
        thumbnailUrl: (t?.poster ? await resolveMediaUrl(String(t.poster)) : null) ?? null,
        waveformData: null,
        originalUrl: resolved,
        // Its own bucket in the Assets panel: these are alternates, not the
        // scene's footage, and mixing them into "Scene Videos" would make a
        // four-take shot look like four scenes.
        category: "Takes",
        sceneNumber: scene.scene_number,
        shotId: scene.source_shot_id,
        role: "take",
      });

      const list = alternateTakeClips.get(takeSlot) ?? [];
      list.push({
        id: `clip-take-${idKey}-${takeId || takeSlot}`,
        // Which take of which shot — the whole point of Phase 1's identity work.
        shotId: scene.source_shot_id,
        takeId: takeId || undefined,
        mediaId: takeMediaId,
        trackId: `track-take-${takeSlot}`,
        // THE SAME INSTANT as the playing take. Alternates, never a sequence.
        startTime: currentTime,
        duration: takeDuration,
        inPoint: 0,
        outPoint: takeDuration,
        effects: [],
        audioEffects: [],
        transform: makeDefaultTransform(),
        // Audible once the user unhides and unmutes the track to audition it.
        volume: 1,
        keyframes: [],
      });
      alternateTakeClips.set(takeSlot, list);
    }

    /**
     * ── THE GRAPHICS LAID OVER THIS SHOT ─────────────────────────────────────
     *
     * Each layer is an alpha WebM rendered from a HyperFrames block, placed on
     * its own ordinary video track ABOVE the picture, where the compositor
     * blends it over whatever is playing.
     *
     * ── THE WINDOW IS RESOLVED HERE, AND ONLY HERE ───────────────────────────
     * The board stores an offset and an anchor, never a timeline position,
     * because the shot's length is whatever the CHOSEN TAKE measures — which is
     * `sceneDuration`, known at this exact point and nowhere earlier. Resolving
     * it at compile time would bake in the length of whichever take happened to
     * be ticked, and the graphic would be in the wrong place the moment somebody
     * swapped it.
     *
     * ── CLAMPED TO THE SHOT, DELIBERATELY ────────────────────────────────────
     * A 5s lower third on a shot whose chosen take runs 4s is trimmed to 4s
     * rather than allowed to run into the next shot. A graphic that outlives its
     * scene reads as the editor having lost the cut, and it is the one failure
     * that survives all the way to a published video.
     */
    const graphicList = Array.isArray((scene as any).graphic_layers)
      ? ((scene as any).graphic_layers as any[])
      : [];
    let layerSlot = 0;
    for (const g of graphicList) {
      const gUrl = String(g?.url ?? "");
      if (!gUrl) continue;
      layerSlot += 1;

      const resolvedG = await resolveMediaUrl(gUrl);
      if (!resolvedG) continue;

      const fileDur = Number(g?.duration_sec) > 0 ? Number(g.duration_sec) : 0;
      const { startTime: start, duration } = resolveGraphicWindow(
        {
          offsetSec: Number(g?.offset_sec) || 0,
          holdSec: Number(g?.hold_sec) || 0,
          anchor: g?.anchor === "end" ? "end" : "start",
        },
        currentTime,
        sceneDuration,
        fileDur,
      );
      // A layer with nowhere left to play is dropped rather than added at zero
      // length, which the timeline draws as an unselectable sliver.
      if (duration <= 0.01) continue;

      const gId = String(g?.id ?? "");
      const gMediaId = `media-graphic-${idKey}-${gId || layerSlot}`;

      /**
       * WHICH BLOCK THIS IS, AND WHAT THE BOARD PUT IN IT.
       *
       * The same tag a block dragged straight onto the timeline gets. It is what
       * makes a board-made graphic an EDITABLE graphic in the editor rather than
       * an anonymous video: the inspector reads it to offer the block's slots,
       * and the agent reads it to answer "change that name". Two ways in, one
       * kind of object at the end — otherwise the same lower third would be
       * editable or not depending on where the user happened to add it.
       */
      const gBlock = String(g?.block ?? "").trim();
      const gSlots = (g?.slots && typeof g.slots === "object")
        ? (g.slots as Record<string, string>)
        : undefined;
      const graphicTag = gBlock
        ? {
            block: gBlock,
            ...(gSlots && Object.keys(gSlots).length ? { slots: { ...gSlots } } : {}),
            mode: "overlay" as const,
          }
        : null;

      mediaItems.push({
        id: gMediaId,
        name: `Scene ${scene.scene_number} · ${String(g?.label || g?.block || `Graphic ${layerSlot}`)}`,
        type: "video",
        fileHandle: null,
        // No blob, for the same reason a take has none: the url is durable and
        // the editor fetches on demand. A film with a lower third on every shot
        // would otherwise pre-fetch one render per shot just to open.
        blob: null,
        metadata: {
          ...mediaMeta({ duration: fileDur || duration, fileSize: 0 }),
          ...(graphicTag ? { graphic: graphicTag } : {}),
        },
        thumbnailUrl: null,
        waveformData: null,
        originalUrl: resolvedG,
        // Its own bucket in the Assets panel. A graphic is neither scene footage
        // nor an alternate take, and filing it as either makes a shot look like
        // it has material it does not.
        category: "Graphics",
        sceneNumber: scene.scene_number,
        shotId: scene.source_shot_id,
        role: "graphic",
      });

      const list = graphicLayerClips.get(layerSlot) ?? [];
      list.push({
        id: `clip-graphic-${idKey}-${gId || layerSlot}`,
        shotId: scene.source_shot_id,
        mediaId: gMediaId,
        trackId: `track-graphic-${layerSlot}`,
        startTime: start,
        duration,
        inPoint: 0,
        outPoint: duration,
        effects: [],
        audioEffects: [],
        transform: makeDefaultTransform(),
        // The clip's own copy of the tag above — surfaces that hold only a clip
        // (the inspector, the agent's timeline reads) do not have to go and find
        // the media item to name the block.
        ...(graphicTag ? { metadata: { graphic: graphicTag } } : {}),
        /**
         * SCREEN, WHICH IS HOW THIS COMPOSITOR PUTS A GRAPHIC OVER FOOTAGE.
         *
         * ── THE PROBLEM, IN THE CODEBASE'S OWN WORDS ─────────────────────────
         * `adobe-import` already documents it: "Our compositor draws NORMAL
         * blend, so placing a mostly-black overlay on top paints the frame
         * black." A HyperFrames overlay is rendered with a TRANSPARENT
         * background, and every transparent pixel arrives at the compositor as
         * black — so under normal blend the graphic does not sit on the shot, it
         * replaces it. Measured in the running editor before this: the frame
         * went to 3,3,3 with 1% lit, and hiding this one track brought the
         * footage back at 55,39,32.
         *
         * `screen` is the same answer that path already ships for exactly this
         * shape of asset (light leaks, particles, anything AE additively
         * blends): black contributes nothing, so the transparent field
         * disappears and the graphic's own pixels lay over the picture.
         *
         * ── AND IT IS AN ORDINARY CLIP FIELD, NOT A NEW MECHANISM ────────────
         * A rendered graphic IS a video clip, so it uses the blend mode every
         * clip already has. Nothing new was added to the timeline, the preview
         * painter or the exporter to support this — only the export path had to
         * start READING the field, which it had never done.
         *
         * ── THE ONE CASE IT APPROXIMATES ─────────────────────────────────────
         * Screen brightens rather than replaces, so a graphic whose own design
         * is DARK (a charcoal lower-third bar under white text) will read
         * lighter over bright footage than it does in the block preview. Bright
         * type, rules and stat callouts — what these overlays overwhelmingly
         * are — land exactly right. The user can change it per clip in the
         * inspector like any other blend.
         */
        blendMode: "screen",
        // These renders carry no audio. 1 rather than 0 so the clip behaves like
        // any other if the user later replaces its media with something that
        // does — a silent-by-flag clip is a trap nobody remembers setting.
        volume: 1,
        keyframes: [],
      });
      graphicLayerClips.set(layerSlot, list);
    }

    // ── Still clip (scenes with no moving picture) ──
    // An image-only scene used to contribute NOTHING to the timeline: the still
    // appeared in the Assets panel and the video track simply had a hole where
    // the scene should be. The user saw a gap and no way to tell what belonged
    // there. Placing it as a real clip keeps the timeline a truthful picture of
    // the video. Only when there is no video — a first frame that merely backs
    // an existing clip is already represented by that clip.
    if (!videoUrl && imageUrl) {
      const stillMediaId = `media-frame-${idKey}-${primaryImage?.id ?? stableHash(imageUrl)}`;
      imageTrackClips.push({
        id: `clip-image-${idKey}`,
        // Provenance: which board shot this came from. See Clip.shotId.
        shotId: scene.source_shot_id,
        mediaId: stillMediaId,
        trackId: "track-image",
        startTime: currentTime,
        duration: sceneDuration,
        // A still has no source timeline to seek: it holds for the whole slot.
        inPoint: 0,
        outPoint: sceneDuration,
        effects: [],
        audioEffects: [],
        transform: makeDefaultTransform(),
        volume: 0,
        keyframes: [],
      });
    }

    // ── Narration clip ──
    if (narrationUrl) {
      // Same per-take rule as the video media id above: URL-hash fallback,
      // never a shared literal (regens must mint a NEW media id).
      const narMediaId = `media-narration-${idKey}-${narration?.id ?? stableHash(narrationUrl)}`;
      const narDurMs = typeof narration?.duration_ms === "number" ? narration.duration_ms : null;
      let narDuration = narDurMs != null ? narDurMs / 1000 : sceneDuration;

      // Fetch the narration blob so the export-time audio engine can decode
      // it. The audio engine's getAudioBuffer() returns null when blob is
      // missing, which silently drops the narration from the rendered MP4
      // (caused the "missing narration" bug at export time).
      const narrationBlob = await fetchMediaBlob(narrationUrl);

      // Probe the REAL audio length from the decoded blob. `duration_ms` is
      // sometimes wrong in Firestore (a regen produced a longer take but the
      // field kept the old value, or a pipeline bug) — which showed an 11s
      // narration as a 1s clip. The decoded length is authoritative; use it
      // when it materially exceeds the recorded value.
      const probedNarDur = await probeAudioDuration(narrationBlob);
      if (probedNarDur > 0 && probedNarDur > narDuration + 0.5) {
        narDuration = probedNarDur;
      }

      mediaItems.push({
        id: narMediaId,
        name: `Scene ${scene.scene_number} · Narration`,
        type: "audio",
        fileHandle: null,
        blob: narrationBlob,
        metadata: mediaMeta({ duration: narDuration, fileSize: narrationBlob?.size || 0 }),
        thumbnailUrl: null,
        waveformData: null,
        originalUrl: narrationUrl,
        category: "Narrations",
        sceneNumber: scene.scene_number,
        shotId: scene.source_shot_id,
        role: "narration",
        // Narration is mirrored WITHOUT a role tag (server caller passes
        // none) → `scene-<n>.mp3`; pass role undefined to match that.
        sourceFile: deriveMirrorSourceFile("narration", scene.scene_number, undefined, narrationUrl, narrationBlob),
      });

      // Bullet-proof source-clip in/out resolution.
      //
      // Older studio chats wrote `start_ms`/`end_ms` as GLOBAL timeline
      // offsets (e.g. scene 2 narration had start_ms: 6000 even though
      // its audio file is only 6s long). The loader used to feed those
      // straight in as inPoint/outPoint, which made the audio element
      // play frames 6–12 of a 6s file — silence — and filtered every
      // word out of the captions because their timestamps fell below
      // trimStartSec.
      //
      // Heuristic: treat start_ms as the source-clip in-point ONLY if
      // it falls inside the audio file (i.e. < duration_ms). Anything
      // at or beyond duration_ms is a stale global offset; collapse to
      // 0..duration. This keeps both old and new docs working without
      // a Firestore migration.
      const rawStartMs = typeof narration?.start_ms === "number" ? narration.start_ms : 0;
      const rawEndMs = typeof narration?.end_ms === "number" ? narration.end_ms : null;
      const looksLikeGlobalOffset =
        narDurMs != null && rawStartMs > 0 && rawStartMs >= narDurMs;
      const inPoint = looksLikeGlobalOffset ? 0 : Math.max(0, rawStartMs / 1000);
      const outPoint = looksLikeGlobalOffset
        ? narDuration
        : (rawEndMs != null ? Math.max(inPoint, rawEndMs / 1000) : inPoint + narDuration);

      narrationTrackClips.push({
        id: `clip-narration-${idKey}`,
        // Provenance: which board shot this came from. See Clip.shotId.
        shotId: scene.source_shot_id,
        mediaId: narMediaId,
        trackId: "track-narration",
        startTime: currentTime,
        duration: Math.max(0.1, outPoint - inPoint),
        inPoint,
        outPoint,
        effects: [],
        audioEffects: [],
        transform: makeDefaultTransform(),
        volume: 1,
        keyframes: [],
      });
    }

    // ── SFX clips ──
    // Each SFX doc carries `sfx_url`, `start_ms` (offset into the scene),
    // `duration_ms`, and `volume`. We mount them as audio clips on
    // `track-sfx`, rebased onto the scene's cumulative start so they
    // ride the same timeline coordinate space as narration/music.
    for (const sfx of sfxs ?? []) {
      const sfxRawUrl = sfx.sfx_url ?? sfx.url ?? null;
      if (!sfxRawUrl) continue;
      const sfxUrl = await resolveMediaUrl(sfxRawUrl);
      if (!sfxUrl) continue;
      const sfxBlob = await fetchMediaBlob(sfxUrl);
      const sfxMediaId = `media-sfx-${stableHash(sfxRawUrl)}`;
      if (!mediaItems.find((m) => m.id === sfxMediaId)) {
        const sfxDur = typeof sfx.duration_ms === "number" ? sfx.duration_ms / 1000 : 2;
        mediaItems.push({
          id: sfxMediaId,
          name: sfx.prompt || "SFX",
          type: "audio",
          fileHandle: null,
          blob: sfxBlob ?? null,
          metadata: mediaMeta({ duration: sfxDur, fileSize: sfxBlob?.size || 0 }),
          thumbnailUrl: null,
          waveformData: null,
          originalUrl: sfxUrl,
          category: "SFX",
          role: "sfx",
        });
      }
      const offsetSec = (typeof sfx.start_ms === "number" ? sfx.start_ms : 0) / 1000;
      const durSec = typeof sfx.duration_ms === "number" ? sfx.duration_ms / 1000 : 2;
      const startTime = currentTime + Math.max(0, offsetSec);
      // Scene-prefix the clip id. `sfx.id` is just an index within ONE
      // scene's `sfx_list` (`sfx_0`, `sfx_1`, …) and collides across
      // scenes the moment two scenes both have an SFX. Without the
      // prefix, identical ids merged through `applyAdditiveMerge` show
      // up as multiple stacked entries with the same id — exactly the
      // "10 × clip-sfx-sfx_0 at startTime=92" pathology we hit in
      // production. Prefixing with the scene doc id makes every clip
      // distinct without changing the underlying media reuse.
      sfxTrackClips.push({
        id: `clip-sfx-${idKey}-${sfx.id}`,
        mediaId: sfxMediaId,
        trackId: "track-sfx",
        startTime,
        duration: Math.max(0.05, durSec),
        inPoint: 0,
        outPoint: Math.max(0.05, durSec),
        effects: [],
        audioEffects: [],
        transform: makeDefaultTransform(),
        volume: typeof sfx.volume === "number" ? Math.max(0, Math.min(2, sfx.volume)) : 1,
        keyframes: [],
      });
    }

    // ── Subtitles from word timestamps ──
    // Studio writes word_timestamps onto the narration doc post-TTS AND
    // onto the chosen video doc post-clip-STT. Earlier versions stamped
    // them only on the first scene's narration; check every available
    // source before giving up so every scene shows captions.
    //
    // Captions track narration. If narration was deliberately disabled
    // for this scene, suppress the caption build too — otherwise we'd
    // re-emit captions whose audio source is muted, which doesn't match
    // what the editor showed at save time.
    const videoWithWords = videos.find(
      (v) => Array.isArray(v.word_timestamps) && v.word_timestamps.length > 0,
    );
    const narrationWithWords = narrations.find(
      (n) => Array.isArray(n.word_timestamps) && n.word_timestamps!.length > 0,
    );
    const rawWordTs =
      narration?.word_timestamps ??
      narrationWithWords?.word_timestamps ??
      primaryVideo?.word_timestamps ??
      videoWithWords?.word_timestamps ??
      null;

    if (rawWordTs && rawWordTs.length > 0) {
      // Filter and rebase word timestamps to match trim handles (Flutter parity).
      // Same global-offset guard as the narration clip above: when
      // start_ms looks like a stale global offset (>= file duration),
      // collapse to 0..duration so all words pass through unfiltered.
      const narDurMsForWords = typeof narration?.duration_ms === "number" ? narration.duration_ms : null;
      const rawStartMsForWords = typeof narration?.start_ms === "number" ? narration.start_ms : 0;
      const rawEndMsForWords = typeof narration?.end_ms === "number" ? narration.end_ms : null;
      const wordsLookLikeGlobalOffset =
        narDurMsForWords != null && rawStartMsForWords > 0 && rawStartMsForWords >= narDurMsForWords;
      const trimStartSec = wordsLookLikeGlobalOffset ? 0 : rawStartMsForWords / 1000;
      const trimEndSec = wordsLookLikeGlobalOffset
        ? (narDurMsForWords != null ? narDurMsForWords / 1000 : sceneDuration)
        : (rawEndMsForWords != null ? rawEndMsForWords / 1000 : trimStartSec + sceneDuration);

      const wordTs = rawWordTs
        .filter(
          (w) =>
            typeof w.word === "string" &&
            w.word.trim().length > 0 &&
            w.start >= trimStartSec &&
            w.start < trimEndSec,
        )
        .map((w) => ({
          word: w.word,
          start: w.start - trimStartSec,
          end: Math.min(w.end - trimStartSec, sceneDuration),
        }));

      // Group words into phrase segments synced to narration timing.
      const WORDS_PER_CHUNK = 4;
      let chunkIdx = 0;
      for (let i = 0; i < wordTs.length; i += WORDS_PER_CHUNK) {
        const chunk = wordTs
          .slice(i, i + WORDS_PER_CHUNK)
          .map((w) => ({
            text: w.word.trim().toUpperCase(),
            startTime: w.start + currentTime,
            endTime: w.end + currentTime,
          }));
        if (chunk.length === 0) continue;

        const text = chunk.map((w) => w.text).join(" ");
        const startSec = chunk[0].startTime;
        const endSec = chunk[chunk.length - 1].endTime;
        // Word timing relative to the caption clip's own start, for word-pop.
        const clipWords = chunk.map((w) => ({
          text: w.text,
          start: Math.max(0, w.startTime - startSec),
          end: Math.max(0, w.endTime - startSec),
        }));
        pushCaption(text, startSec, endSec, idKey, chunkIdx++, clipWords);
      }
    } else {
      // Lyrics segments need rebasing relative to music_start_ms (Flutter parity).
      // lyrics_json / lyrics_lrc timestamps are absolute within the full song;
      // subtract the scene's music_start_ms to get scene-relative offsets.
      const lyricsBaseSec = musicStartSec;

      const jsonSegments = scene.lyrics_json
        ? parseLyricsJsonSegments(scene.lyrics_json)
        : [];

      if (jsonSegments.length > 0) {
        // Determine offset: prefer music_start_ms, fallback to first segment start
        const offsetSec = lyricsBaseSec ?? jsonSegments[0].start;

        let chunkIdx = 0;
        for (let i = 0; i < jsonSegments.length; i += 1) {
          const segment = jsonSegments[i];
          const rebasedStart = segment.start - offsetSec;
          const next = jsonSegments[i + 1];
          const rebasedNextStart = next != null ? next.start - offsetSec : null;
          const fallbackEnd =
            rebasedNextStart ?? Math.min(sceneDuration, rebasedStart + 2.5);
          const rebasedEnd = segment.end != null
            ? segment.end - offsetSec
            : fallbackEnd;

          // Skip segments outside scene bounds
          if (rebasedStart < 0 || rebasedStart >= sceneDuration) continue;
          if (rebasedEnd <= rebasedStart) continue;
          const clampedEnd = Math.min(rebasedEnd, sceneDuration);

          pushCaption(
            segment.text.toUpperCase(),
            currentTime + rebasedStart,
            currentTime + clampedEnd,
            idKey,
            chunkIdx++,
          );
        }
      } else if (scene.lyrics_lrc) {
        const lrcSegments = parseLrcSegments(scene.lyrics_lrc);
        // Determine offset: prefer music_start_ms, fallback to first segment start
        const offsetSec =
          lyricsBaseSec ??
          (lrcSegments.length > 0 ? lrcSegments[0].start : 0);

        // Detect WORD-LEVEL LRC (Suno timestamped lyrics — one word per tag).
        // When word-level, group into ~4-word phrases WITH per-word timing so
        // the captions render as karaoke word-highlight — identical to the
        // narration word_timestamps path (consistency) and surfacing the
        // inspector's Active-word colour picker + animation styles. Line-level
        // LRC (Flutter parity) stays as static captions.
        const singleWord = lrcSegments.filter(
          (s) => !/\s/.test(s.text.trim()),
        ).length;
        const wordLevel =
          lrcSegments.length > 1 && singleWord / lrcSegments.length > 0.6;

        let chunkIdx = 0;
        if (wordLevel) {
          const WORDS_PER_CHUNK = 4;
          for (let i = 0; i < lrcSegments.length; i += WORDS_PER_CHUNK) {
            const chunk = lrcSegments.slice(i, i + WORDS_PER_CHUNK);
            // Per-word absolute end = next word's start (cap +0.6s, floor +0.15s).
            const words = chunk.map((w, j) => {
              const nextAbs =
                chunk[j + 1]?.start ??
                lrcSegments[i + j + 1]?.start ??
                w.start + 0.5;
              const end = Math.max(w.start + 0.15, Math.min(nextAbs, w.start + 0.6));
              return { text: w.text.trim().toUpperCase(), absStart: w.start, absEnd: end };
            });
            const phraseAbsStart = words[0].absStart;
            const phraseAbsEnd = words[words.length - 1].absEnd;
            const rebasedStart = phraseAbsStart - offsetSec;
            const rebasedEnd = phraseAbsEnd - offsetSec;
            if (rebasedStart < 0 || rebasedStart >= sceneDuration) continue;
            const clampedEnd = Math.min(rebasedEnd, sceneDuration);
            if (clampedEnd <= rebasedStart) continue;
            // Display text: merge apostrophe / contraction fragments.
            let display = "";
            for (const w of words) {
              const join =
                display === "" ||
                display.endsWith("'") ||
                /^(VE|RE|LL|S|T|D|M|N'T)$/.test(w.text);
              display += (join ? "" : " ") + w.text;
            }
            // captionWords: per-word timing RELATIVE to the caption clip start.
            const capWords = words.map((w) => ({
              text: w.text,
              start: Math.max(0, w.absStart - phraseAbsStart),
              end: Math.max(0.1, w.absEnd - phraseAbsStart),
            }));
            pushCaption(
              display,
              currentTime + rebasedStart,
              currentTime + clampedEnd,
              idKey,
              chunkIdx++,
              capWords,
            );
          }
        } else {
          for (let i = 0; i < lrcSegments.length; i += 1) {
            const segment = lrcSegments[i];
            const rebasedStart = segment.start - offsetSec;
            const next = lrcSegments[i + 1];
            const rebasedNextStart = next != null ? next.start - offsetSec : null;
            const fallbackEnd =
              rebasedNextStart ?? Math.min(sceneDuration, rebasedStart + 2.5);

            // Skip segments outside scene bounds
            if (rebasedStart < 0 || rebasedStart >= sceneDuration) continue;
            if (fallbackEnd <= rebasedStart) continue;
            const clampedEnd = Math.min(fallbackEnd, sceneDuration);

            pushCaption(
              segment.text.toUpperCase(),
              currentTime + rebasedStart,
              currentTime + clampedEnd,
              idKey,
              chunkIdx++,
            );
          }
        }
      }
    }

    /**
     * WHERE THIS SHOT'S SEQUENCE RUNS TO.
     *
     * Consecutive scenes sharing a `board_sequence` are one stretch of the
     * film, and that stretch becomes a nested sequence. Extending the current
     * run rather than starting a new one is what makes it consecutive — two
     * separated runs of the same name stay two places in the film, because
     * something was put between them.
     */
    const seqName = String((scene as any).board_sequence ?? "").trim();
    const last = sequenceSpans[sequenceSpans.length - 1];
    if (seqName && last && last.name === seqName && Math.abs(last.endTime - currentTime) < 0.001) {
      last.endTime = currentTime + sceneDuration;
    } else if (seqName) {
      sequenceSpans.push({
        name: seqName,
        startTime: currentTime,
        endTime: currentTime + sceneDuration,
      });
    }

    currentTime += sceneDuration;
    totalMusicDuration = currentTime;
  }

  // ── Build music track clips ──
  //
  // Common case: ONE global `slData.music_url` applied to every scene.
  // Each scene loop iteration above pushed its own spec (per-scene
  // mediaIds + contiguous in/out points so a long BGM track gets sliced
  // scene-by-scene). For a single global track that produced N clips on
  // `track-music` — visually indistinguishable from "duplicate BGM"
  // even though playback is seamless. The agent renders BGM ONCE at
  // ~3-4 min length and just trims it to video length, so the user
  // expects to see ONE clip spanning [0, totalVideoDuration].
  //
  // Collapse adjacent specs that (a) share the same mediaId and
  // (b) chain contiguously (next.startTime ≈ prev.startTime + prev.duration
  // AND next.inPoint ≈ prev.outPoint), merging them into a single
  // clip. Per-scene-override case — different `scene.music_url` per
  // scene, or non-contiguous source windows — stays split, because
  // those are genuinely different audio segments.
  const EPSILON = 0.01;
  const mergedSpecs: typeof musicTrackSpecs = [];
  for (const spec of musicTrackSpecs) {
    const last = mergedSpecs[mergedSpecs.length - 1];
    if (
      last &&
      last.mediaId === spec.mediaId &&
      Math.abs(last.startTime + last.duration - spec.startTime) < EPSILON &&
      Math.abs(last.outPoint - spec.inPoint) < EPSILON
    ) {
      last.duration = spec.startTime + spec.duration - last.startTime;
      last.outPoint = spec.outPoint;
    } else {
      mergedSpecs.push({ ...spec });
    }
  }

  if (mergedSpecs.length > 0 && totalMusicDuration > 0) {
    for (const spec of mergedSpecs) {
      musicTrackClips.push({
        id: `clip-music-${spec.sceneDocId}`,
        mediaId: spec.mediaId,
        trackId: "track-music",
        startTime: spec.startTime,
        duration: spec.duration,
        inPoint: spec.inPoint,
        outPoint: spec.outPoint,
        effects: [],
        audioEffects: [],
        transform: makeDefaultTransform(),
        volume: typeof slData.music_volume === "number"
          ? Math.max(0, Math.min(2, slData.music_volume as number))
          : 0.3,
        keyframes: [],
      });
    }
  } else if (fallbackMusicMediaId && totalMusicDuration > 0) {
    // Fallback for older scene lists that don't have per-scene music timing.
    musicTrackClips.push({
      id: `clip-music-fallback-${fallbackMusicMediaId}`,
      mediaId: fallbackMusicMediaId,
      trackId: "track-music",
      startTime: 0,
      duration: totalMusicDuration,
      inPoint: 0,
      outPoint: totalMusicDuration,
      effects: [],
      audioEffects: [],
      transform: makeDefaultTransform(),
      volume: typeof slData.music_volume === "number"
        ? Math.max(0, Math.min(2, slData.music_volume as number))
        : 0.3,
      keyframes: [],
    });
  }

  // Ensure each music media metadata duration covers the furthest out-point used by its clips.
  if (musicTrackClips.length > 0) {
    const maxMusicOutPointByMedia = new Map<string, number>();
    for (const clip of musicTrackClips) {
      const currentMax = maxMusicOutPointByMedia.get(clip.mediaId) ?? 0;
      maxMusicOutPointByMedia.set(clip.mediaId, Math.max(currentMax, clip.outPoint));
    }

    for (const [mediaId, maxOutPoint] of maxMusicOutPointByMedia.entries()) {
      const musicItem = mediaItems.find((m) => m.id === mediaId);
      if (musicItem) {
        (musicItem as { metadata: MediaMetadata }).metadata = mediaMeta({
          duration: Math.max(maxOutPoint, musicItem.metadata.duration || 0),
        });
      }
    }
  }

  // Captions are emitted as TextClips on `track-captions` (built via
  // `pushCaption` above). They render through the title-engine, so the
  // standard openreel Inspector — Transform, Alignment, Effects, Text
  // Properties, Animations, Keyframes — operates on them like any other
  // text clip. `timeline.subtitles` is intentionally left empty so the
  // subtitle-canvas-renderer doesn't draw a second copy on top.

  // 5) Assemble tracks
  //
  // ⚠ Track ORDER matters for both the editor preview AND the export
  // renderer. Both sort tracks by descending `originalIndex` (last
  // track first → drawn FIRST → bottom of the stack), so a track at
  // index 0 ends up on TOP of the visual stack. We deliberately put
  // the captions track at index 0 (top) so subtitles render OVER the
  // video, not underneath it. The previous order had captions at the
  // tail of the array which made the video clip cover them in the
  // export — captions appeared in the preview only because the
  // preview-side renderer's "above-video" pass was structured around
  // the originalIndex < lowestVideoIndex predicate; the export
  // renderer has no such split, so the descending-sort z-order
  // dropped them straight into the bottom layer.
  const tracks: Track[] = [];

  if (captionTextClips.length > 0) {
    // Type "text" — see video-engine `getActiveTextClips` which filters
    // textClips by their track type. We register an empty `clips` array
    // here because TextClips live in `project.textClips` (managed by the
    // title-engine), not on the track itself.
    tracks.push({
      id: "track-captions",
      type: "text",
      name: "Captions",
      clips: [],
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
  }

  // ORDER MATTERS, and it is the opposite of what it looks like. The shared
  // z-order painter (compositeTracksToCtx) sorts pixel tracks by
  // `b.originalIndex - a.originalIndex`, so the HIGHEST index is painted FIRST
  // — i.e. furthest back. A LOWER index sits on TOP.
  //
  // Hence image AFTER video: a still never covers a moving clip if the two ever
  // overlap. Overlays are not derived here at all — an overlay is just an alpha
  // video the user or agent drops on its own video track, which stacks above
  // automatically (see the track/add stacking rule).
  /**
   * ── ALTERNATE TAKES, STACKED AT THE SAME MOMENT ──────────────────────────
   *
   * A shot generated four times on the storyboard arrives with four takes. They
   * are NOT laid end to end — that would make the film four times too long and
   * turn editing into deletion. They are time-aligned: the playing take is on
   * `track-video` below, and take 2 sits directly above it at the same instant,
   * take 3 above that. Flip a track's eye to compare, drag one down to swap, or
   * razor across the stack to cut between them.
   *
   * PUSHED BEFORE `track-video`, and that is the z-order, not a coincidence. The
   * shared painter sorts pixel tracks by DESCENDING array index, so a LOWER
   * index paints LAST and therefore sits ON TOP (see the note above, and
   * `stores/track-stacking.test.ts`). The timeline UI renders the array
   * top-to-bottom, so these also appear as the rows above Video — what the user
   * sees above IS above.
   *
   * `hidden` AND `muted`, and both are required. `hidden` alone is not enough:
   * the word `hidden` appears nowhere in `packages/core/src/audio` — audibility
   * is `!track.muted && (!hasSoloTracks || track.solo)` and
   * `getAudioTracksAtTime` explicitly includes video tracks. Ship these
   * hidden-only and the user sees one take while HEARING all four at once, with
   * nothing on screen to explain it.
   *
   * One track per take POSITION, not per shot: every shot's second take shares
   * "Take 2", so unhiding it shows the alternate for exactly the shots that have
   * one and leaves every other shot showing what it showed.
   */
  /**
   * GRAPHICS FIRST, THEN TAKES, THEN THE PICTURE.
   *
   * Array order is z-order — a lower index paints last, and therefore on top —
   * so pushing graphics before the take tracks is what puts a lower third over
   * BOTH the playing take and any alternate the user unhides to compare.
   *
   * Getting this order wrong is not subtly wrong: a graphic under the footage is
   * invisible, and the report is "the overlay did nothing".
   */
  for (const t of buildGraphicTracks(graphicLayerClips)) tracks.push(t);
  for (const t of buildTakeTracks(alternateTakeClips)) tracks.push(t);

  tracks.push({
    id: "track-video",
    type: "video",
    name: "Video",
    clips: videoTrackClips,
    transitions: buildSceneBoundaryTransitions(videoTrackClips, (id) => sceneBoundaryByClip.get(id)),
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  });

  if (imageTrackClips.length > 0) {
    tracks.push({
      id: "track-image",
      type: "image",
      name: "Images",
      clips: imageTrackClips,
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
  }

  // Only add narration track if it has clips (matches Flutter — no empty tracks)
  if (narrationTrackClips.length > 0) {
    tracks.push({
      id: "track-narration",
      type: "audio",
      name: "Narration",
      clips: narrationTrackClips,
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
  }

  if (sfxTrackClips.length > 0) {
    tracks.push({
      id: "track-sfx",
      type: "audio",
      name: "SFX",
      clips: sfxTrackClips,
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
  }

  if (musicTrackClips.length > 0) {
    tracks.push({
      id: "track-music",
      type: "audio",
      name: "Background Music",
      clips: musicTrackClips,
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
  }

  const timeline: Timeline = {
    tracks,
    subtitles,
    duration: totalMusicDuration || currentTime,
    markers: [],
  };

  const settings: ProjectSettings = {
    width: dim.width,
    height: dim.height,
    frameRate: DEFAULT_FPS,
    sampleRate: 44100,
    channels: 2,
  };

  const now = Date.now();

  // Honor the blob's deletion tombstones. This rebuild re-derives every
  // track from scene_lists — which would RESURRECT user-deleted tracks: the
  // first load after a reload is a WHOLESALE loadProject (the additive-merge
  // tombstone guard in App.tsx only sees later live ticks). Filter out the
  // clip ids that existed at deletion time and drop tombstoned tracks that
  // end up empty; clips generated AFTER the deletion still come through.
  const pendingDeleted = (slData as any).__pendingDeletedTracks;
  const deletedTracks: Array<{ id: string; clipIds: string[]; at: number }> =
    Array.isArray(pendingDeleted) ? pendingDeleted : [];
  if (deletedTracks.length > 0) {
    const tombClipIds = new Set(
      deletedTracks.flatMap((d) => (Array.isArray(d.clipIds) ? d.clipIds : [])),
    );
    const tombTrackIds = new Set(deletedTracks.map((d) => d.id));
    (timeline as { tracks: Track[] }).tracks = timeline.tracks
      .map((t) => ({ ...t, clips: t.clips.filter((c) => !tombClipIds.has(c.id)) }))
      .filter((t) => !tombTrackIds.has(t.id) || t.clips.length > 0);
  }

  /**
   * ── SCREENPLAY SEQUENCES → NESTED SEQUENCES ────────────────────────────────
   *
   * OFF BY DEFAULT, AND THAT IS THE POINT OF THE FLAG.
   *
   * The container works: it renders, it exports, it carries its own audio, and
   * it nests. What does not exist yet is the way IN — double-click to open a
   * sequence, edit inside, come back out. Until that lands, turning this on
   * would take a film that was five editable shots and hand the user two blocks
   * they cannot open. That is strictly worse than flat, so it ships dark.
   *
   * Everything behind the flag is built and tested, so enabling it is this one
   * line once the timeline UI can open a sequence — which comes with the
   * upstream merge, since their `ClipComponent` and `NestedSequenceSection`
   * need their design system.
   *
   * Ids are derived from the span's own position, not minted, because the
   * loader rebuilds on every Firestore tick and the editor merges additively
   * BY ID — a fresh id per rebuild would add a second copy of every sequence,
   * forever.
   */
  const NEST_SEQUENCES = false;
  let compoundClips: CompoundClip[] = [];
  if (NEST_SEQUENCES && sequenceSpans.length) {
    /**
     * No `overlays` here, and that is currently correct rather than an
     * oversight: every text clip this loader builds sits on `track-captions`
     * (see `captionTextClips`), which the default `includeTrackId` keeps OUT
     * of a sequence because a caption spans them.
     *
     * BEFORE FLIPPING THE FLAG, re-check that. The moment a title lands on a
     * shot's own video track, it must be passed here or it is silently dropped
     * when that shot is wrapped — picture in, words gone. `buildSequenceCompounds`
     * takes `overlays` for exactly this.
     */
    const built = buildSequenceCompounds(timeline.tracks, sequenceSpans, {
      idFor: (span) => `seq-${sceneListId}-${Math.round(span.startTime * 100)}`,
    });
    if (built.compounds.length) {
      compoundClips = built.compounds;
      (timeline as { tracks: Track[] }).tracks = built.tracks;
      console.log(
        `[voidspace-loader] Nested ${built.compounds.length} screenplay sequence(s) `
        + `into compound clips: ${built.compounds.map((c) => c.name).join(", ")}`,
      );
    }
  }

  const project: Project = {
    id: buildVoidspaceProjectId(userId, sceneListId, slData.avatar_id as string | undefined),
    name: slData.name || slData.title || slData.avatar_name || "Voidspace Project",
    createdAt: slData.created_at?.seconds
      ? slData.created_at.seconds * 1000
      : now,
    modifiedAt: slData.updated_at?.seconds
      ? slData.updated_at.seconds * 1000
      : now,
    settings,
    mediaLibrary: { items: mediaItems },
    timeline,
    textClips: captionTextClips,
    // Keep the tombstones on the rebuilt project so they persist through the
    // next autosave (otherwise one rebuild would erase the deletion record).
    ...(deletedTracks.length > 0 ? { deletedTracks } : {}),
    // Empty unless NEST_SEQUENCES is on — see above.
    ...(compoundClips.length ? { compoundClips } : {}),
  };

  // If the empty-blob safety net flagged a stale history we should
  // preserve, attach it here so App.tsx still rehydrates ActionHistory
  // (so prior snapshots remain visible/clickable). Without this, the
  // user loses their snapshot list when we fall back to per-scene
  // rebuild from an empty-blob recovery.
  const pendingHistory = (slData as any).__pendingHistoryData;
  if (typeof pendingHistory === "string") {
    (project as any).__historyData = pendingHistory;
    console.log(`[voidspace-loader] Preserved history (${pendingHistory.length}b) across empty-blob fallback rebuild`);
  }

  /**
   * THE SAVED ARRANGEMENT GOES BACK ON TOP.
   *
   * Set only by the STALE branch — never by the poisoned-blob branch (that data
   * belongs to a different project) and never by the empty-blob branch (there is
   * nothing in it to preserve). So this runs exactly when there is a real edit
   * to protect and real new material to add.
   *
   * `__historyData` is re-attached afterwards because the merge returns a new
   * object built from the SAVED project, and the history rides on the rebuilt
   * one.
   */
  /**
   * WHICH STORYBOARD THIS CAME FROM — the way back.
   *
   * `source_board_id` has been written on every compiled project since compile
   * existed and read by nothing, so the round trip was one-way in practice: you
   * could send a board to the editor and then had to go and find it again by
   * hand. Carried on the project the same way `__historyData` is — a field
   * App.tsx peels off after `loadProject` — because `Project` is openreel's own
   * type and Voidspace provenance does not belong in it.
   */
  const sourceBoardId = String((slData as Record<string, unknown>).source_board_id ?? '');
  if (sourceBoardId) (project as any).__sourceBoardId = sourceBoardId;

  const pendingSaved = (slData as any).__pendingSavedProject as Project | undefined;
  if (pendingSaved?.timeline?.tracks?.length) {
    const merged = mergeSavedArrangement(project, pendingSaved);
    const before = project.timeline.tracks.reduce((n, t) => n + t.clips.length, 0);
    const after = merged.timeline.tracks.reduce((n, t) => n + t.clips.length, 0);
    console.log(
      `[voidspace-loader] Merged the saved arrangement back over the rebuild — `
      + `kept the user's cut, added ${Math.max(0, after - (pendingSaved.timeline.tracks
          .reduce((n, t) => n + t.clips.length, 0)))} new clip(s). `
      + `(rebuild had ${before})`,
    );
    if (typeof pendingHistory === "string") (merged as any).__historyData = pendingHistory;
    if (deletedTracks.length > 0) (merged as any).deletedTracks = deletedTracks;
    // The merge builds from the SAVED project, so anything stamped on the
    // rebuilt one has to be carried across explicitly.
    if (sourceBoardId) (merged as any).__sourceBoardId = sourceBoardId;
    return merged;
  }

  return project;
}

/**
 * Live subscription wrapper — registers Firestore onSnapshot() listeners on
 * the scene_list doc and the scenes / images / videos / narrations
 * subcollections, debounces them, and re-runs `loadSceneListAsProject` on
 * every change.
 *
 * The studio chat upserts assets (frame, voiceover, clip) one by one as the
 * user approves each step. Without live subscription the editor sees only
 * the snapshot at iframe-mount time and the timeline never refreshes —
 * users had to reload the page to see the next clip land. This wires the
 * editor to receive a fresh `Project` on every Firestore write so the
 * timeline tracks fill in real time.
 *
 * Returns an unsubscribe function that tears down all listeners.
 */
export function subscribeSceneListAsProject(
  userId: string,
  sceneListId: string,
  onProject: (project: Project) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const slRef = doc(db, "users", userId, "scene_lists", sceneListId);
  const scenesCol = collection(db, "users", userId, "scene_lists", sceneListId, "scenes");

  // Coalesce bursts of writes into a single rebuild so we don't reload
  // the whole project on each per-asset upsert (which itself fires 4–6
  // writes back-to-back: scene_text, narration_url, narration_*_ms, etc.).
  let pending: any = null;
  let inFlight = false;
  let needsRerun = false;
  const rebuild = async () => {
    if (inFlight) { needsRerun = true; return; }
    inFlight = true;
    try {
      const project = await loadSceneListAsProject(userId, sceneListId);
      onProject(project);
    } catch (err) {
      console.warn("[voidspace-loader] live rebuild failed:", err);
      onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      inFlight = false;
      if (needsRerun) {
        needsRerun = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(rebuild, 250);
  };

  const unsubscribers: Unsubscribe[] = [];

  // 1. Top-level scene_list doc — captures aspect_ratio / music_url /
  //    title / video_url / status changes.
  unsubscribers.push(
    onSnapshot(slRef, () => schedule(), (err) => onError?.(err))
  );

  // 2. Scenes collection — every per-scene field write (first_frame_url,
  //    narration_url, video_url, status, duration_ms…). Subcollection
  //    snapshots fire when an `addAsset` call lands the new image / video
  //    / narration doc; the per-scene listener registered below on
  //    demand catches those.
  let sceneAssetUnsubs: Unsubscribe[] = [];
  unsubscribers.push(
    onSnapshot(
      query(scenesCol, orderBy("scene_number")),
      (snap) => {
        // Tear down existing per-scene asset listeners.
        for (const u of sceneAssetUnsubs) try { u(); } catch { /* ignore */ }
        sceneAssetUnsubs = [];
        // Register fresh listeners on each scene's images/videos/
        // narrations subcollections so live asset upserts trigger a
        // rebuild without polling.
        for (const sceneDoc of snap.docs) {
          const sceneId = sceneDoc.id;
          for (const kind of ["images", "videos", "narrations", "sfxs"] as const) {
            const sub = collection(
              db, "users", userId, "scene_lists", sceneListId,
              "scenes", sceneId, kind,
            );
            sceneAssetUnsubs.push(
              onSnapshot(sub, () => schedule(), (err) => onError?.(err))
            );
          }
        }
        schedule();
      },
      (err) => onError?.(err),
    )
  );

  // Immediate first load — don't wait for the first snapshot tick.
  schedule();

  return () => {
    if (pending) clearTimeout(pending);
    for (const u of unsubscribers) try { u(); } catch { /* ignore */ }
    for (const u of sceneAssetUnsubs) try { u(); } catch { /* ignore */ }
  };
}
