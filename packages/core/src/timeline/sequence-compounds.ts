import type { Clip, Track } from "../types/timeline";
import type { CompoundClip } from "./nested-sequence-engine";

/** A stretch of the film that belongs to one screenplay sequence. */
export interface SequenceSpan {
  /** The sequence heading, as written: "The chase". Used as the clip's name. */
  readonly name: string;
  /** Absolute timeline seconds, `endTime` exclusive. */
  readonly startTime: number;
  readonly endTime: number;
}

export interface SequenceCompoundResult {
  readonly compounds: CompoundClip[];
  readonly tracks: Track[];
}

/**
 * Turn each screenplay SEQUENCE into a nested sequence on the timeline.
 *
 * ── WHY THIS NEEDS NO CHANGE TO COMPILE ─────────────────────────────────────
 * `compile.post.ts` has written `board_sequence` on every scene since the
 * structure work; nothing read it. So the whole board→editor integration is a
 * read on this side, and the wire format does not move. That is the smallest
 * correct version of the feature, and it means an existing project gains
 * sequences the next time it loads rather than needing a recompile.
 *
 * ── WHAT GOES INSIDE, AND WHAT DELIBERATELY DOES NOT ────────────────────────
 * Everything that belongs to those SHOTS: their picture, their narration, their
 * effects, their alternate takes. Move a sequence and its voiceover moves with
 * it, because they are inside the same container.
 *
 * The project's MUSIC does not, and neither do CAPTIONS. A score runs under the
 * whole film and a caption sits over it; both span sequences, so folding either
 * into one would cut it at the sequence boundary. They stay on the outer
 * timeline where they already are.
 *
 * ── THE RULES, EACH CHOSEN RATHER THAN INHERITED ────────────────────────────
 *  • CONSECUTIVE runs only. Two separated stretches of the same sequence name
 *    are two places in the film, not one sequence used twice — the user (or
 *    the editor) put something between them, and merging them would move it.
 *  • A run of ONE shot is left flat. Wrapping a single clip in a container adds
 *    a layer to open with nothing inside it worth opening.
 *  • Clips are normalised to start at zero inside the compound, so the sequence
 *    is N seconds long rather than N seconds preceded by an hour of nothing.
 *  • Anything not covered by a span is untouched.
 *
 * Returns the tracks unchanged when no span qualifies, so a film without
 * sequences — every short, every reel — pays nothing.
 */
export function buildSequenceCompounds(
  tracks: readonly Track[],
  spans: readonly SequenceSpan[],
  options: {
    /** Tracks whose clips move inside. Others stay on the outer timeline. */
    readonly includeTrackId?: (trackId: string) => boolean;
    /** Ids are injected so a caller can make them deterministic — a loader that
     *  rebuilds on every Firestore tick must not mint a new id each time, or
     *  every rebuild looks like a different sequence to the additive merge. */
    readonly idFor?: (span: SequenceSpan, index: number) => string;
  } = {},
): SequenceCompoundResult {
  const include = options.includeTrackId
    ?? ((id: string) => id !== "track-music" && !id.startsWith("track-caption"));
  const idFor = options.idFor
    ?? ((s: SequenceSpan, i: number) => `seq-${i}-${s.startTime}`);

  const usable = spans.filter((s) => s.endTime > s.startTime);
  if (!usable.length) return { compounds: [], tracks: [...tracks] };

  const compounds: CompoundClip[] = [];
  /** Instance clips to add to the outer timeline, by the track they sit on. */
  const instancesByTrack = new Map<string, Clip[]>();
  /** Clip ids that moved inside a compound and must leave the outer timeline. */
  const consumed = new Set<string>();

  usable.forEach((span, index) => {
    const inner: Clip[] = [];
    const innerTracks: Track[] = [];

    for (const track of tracks) {
      if (!include(track.id)) continue;
      const mine = track.clips.filter(
        (c) => c.startTime >= span.startTime - 0.001
          && c.startTime < span.endTime - 0.001,
      );
      if (!mine.length) continue;
      const shifted = mine.map((c) => ({ ...c, startTime: c.startTime - span.startTime }));
      for (const c of mine) consumed.add(c.id);
      inner.push(...shifted);
      innerTracks.push({
        ...track,
        clips: shifted,
        // A transition whose other end stayed outside would poison the
        // renderer's transition map — the same rule the engine applies when a
        // compound is built from a selection.
        transitions: track.transitions.filter((t) => {
          const ids = new Set(shifted.map((c) => c.id));
          return ids.has(t.clipAId) && (!t.clipBId || ids.has(t.clipBId));
        }),
      });
    }

    // Nothing of ours in this span, or only one shot — leave it flat.
    if (!innerTracks.length) return;
    const distinctStarts = new Set(inner.map((c) => Math.round(c.startTime * 100)));
    if (distinctStarts.size < 2) {
      for (const c of inner) consumed.delete(c.id);
      return;
    }

    const id = idFor(span, index);
    const duration = span.endTime - span.startTime;
    compounds.push({
      id,
      name: span.name || `Sequence ${index + 1}`,
      content: { clips: inner, tracks: innerTracks, duration },
      createdAt: 0,
      modifiedAt: 0,
      color: "#8b5cf6",
    });

    /**
     * The instance rides on the track the sequence's PICTURE was on, so it
     * behaves like the footage it replaces — same z-order, same track controls.
     */
    const host = innerTracks.find((t) => t.type === "video")?.id
      ?? innerTracks[0]!.id;
    const list = instancesByTrack.get(host) ?? [];
    list.push({
      id: `inst-${id}`,
      // Both spellings the renderer accepts, so a consumer reading only
      // `mediaId` still knows what this is. See `compoundIdOfClip`.
      mediaId: `compound:${id}`,
      metadata: { compoundClipId: id },
      trackId: host,
      startTime: span.startTime,
      duration,
      inPoint: 0,
      outPoint: duration,
      effects: [],
      audioEffects: [],
      transform: {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      volume: 1,
      keyframes: [],
    });
    instancesByTrack.set(host, list);
  });

  if (!compounds.length) return { compounds: [], tracks: [...tracks] };

  const out: Track[] = tracks.map((track) => {
    const added = instancesByTrack.get(track.id) ?? [];
    const kept = track.clips.filter((c) => !consumed.has(c.id));
    if (!added.length && kept.length === track.clips.length) return track;
    return {
      ...track,
      clips: [...kept, ...added].sort((a, b) => a.startTime - b.startTime),
      // Transitions that referenced a clip now living inside a compound have
      // lost an endpoint; keeping them would point the renderer at nothing.
      transitions: track.transitions.filter(
        (t) => !consumed.has(t.clipAId) && (!t.clipBId || !consumed.has(t.clipBId)),
      ),
    };
  });

  return { compounds, tracks: out };
}
