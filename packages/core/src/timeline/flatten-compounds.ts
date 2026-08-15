import type { Project, Timeline, Track, Clip } from "../types";
import { compoundIdOfClip } from "../types/timeline";

/**
 * A timeline with every nested sequence replaced by the clips inside it.
 *
 * ── WHY THIS EXISTS: SOUND ──────────────────────────────────────────────────
 * The picture of a nested sequence is rendered by recursion — the compound's
 * tracks go through a whole `renderFrame` on a nested engine, so a sequence
 * looks right and can contain anything, including more sequences.
 *
 * Audio has no equivalent. `renderAudio` walks `timeline.tracks` and reads
 * clips off them; a compound instance is one clip whose `mediaId` names a
 * sequence rather than a file, so the mixer finds no media and contributes
 * silence. **A nested sequence would render with a picture and no sound.**
 * Upstream has this gap too — `git grep compound` over their audio package
 * returns nothing.
 *
 * Rather than teach the mixer about sequences, this hands it a timeline that
 * has none: the inner clips, offset to where the instance sits, on tracks it
 * already understands. The mixer stays a mixer.
 *
 * ── WHAT IS PRESERVED, AND WHY EACH MATTERS ────────────────────────────────
 *  • OFFSET — an inner clip at 2s inside an instance placed at 30s plays at
 *    32s. Get this wrong and the dialogue is in the wrong scene.
 *  • TRIM — an instance trimmed to its middle three seconds contributes only
 *    the inner audio inside that window, clipped at both ends. Otherwise
 *    trimming a sequence would shorten the picture and not the sound.
 *  • VOLUME — the instance's own volume multiplies what is inside it, the way
 *    a group fader does. Muting an instance silences the sequence.
 *  • DEPTH — a sequence inside a sequence flattens all the way down.
 *
 * ── WHY 8, AND WHAT HAPPENS PAST IT ────────────────────────────────────────
 * The picture has no matching number: `renderCompoundFrame` bounds itself
 * STRUCTURALLY, by dropping the current compound from the project it hands
 * down, so it can recurse at most once per compound that exists. This is a flat
 * cap instead, and past it a sequence renders its picture with no sound — the
 * same divergence this file exists to close.
 *
 * That needs a burlesque of nesting to reach: eight sequences inside one
 * another, which no cut of a film has. It is a backstop against a malformed
 * document, not a limit anyone edits into. If it is ever raised, raise it
 * knowing the two paths disagree above it.
 *
 * Returns the timeline UNCHANGED when there is nothing nested, so the ordinary
 * project pays nothing for this.
 */
export function flattenCompoundAudio(project: Project, depthLimit = 8): Timeline {
  const compounds = project.compoundClips ?? [];
  if (!compounds.length) return project.timeline;

  const byId = new Map(compounds.map((c) => [c.id, c]));
  const hasNested = project.timeline.tracks.some((t) =>
    t.clips.some((c) => {
      const id = compoundIdOfClip(c);
      return !!id && byId.has(id);
    }),
  );
  if (!hasNested) return project.timeline;

  /**
   * Expand one instance into the audible clips inside it.
   *
   * `seen` is the cycle guard, and it is per-branch rather than global: a
   * sequence may legitimately appear twice side by side, and a global set would
   * silence the second one. What is illegal is a sequence containing ITSELF,
   * which is the same id already on the current path.
   */
  function expand(instance: Clip, depth: number, seen: ReadonlySet<string>): Clip[] {
    const compoundId = compoundIdOfClip(instance);
    if (!compoundId) return [instance];

    const compound = byId.get(compoundId);
    // An instance pointing at a sequence that no longer exists contributes
    // nothing — the same as its picture, which renders as nothing.
    if (!compound) return [];
    if (depth >= depthLimit || seen.has(compoundId)) return [];

    const nextSeen = new Set(seen).add(compoundId);
    const windowStart = instance.inPoint ?? 0;
    const windowEnd = windowStart + instance.duration;
    const out: Clip[] = [];

    for (const track of compound.content.tracks) {
      // Only what can make a sound. A compound's image tracks are the picture,
      // and the picture is handled by the renderer.
      if (track.type !== "audio" && track.type !== "video") continue;
      if (track.muted) continue;

      for (const inner of track.clips) {
        for (const piece of expand(inner, depth + 1, nextSeen)) {
          const innerStart = piece.startTime;
          const innerEnd = innerStart + piece.duration;
          // Outside the part of the sequence this instance actually plays.
          if (innerEnd <= windowStart || innerStart >= windowEnd) continue;

          // Clip it to the instance's window, then move it to where the
          // instance sits on the parent timeline.
          const head = Math.max(0, windowStart - innerStart);
          const tail = Math.max(0, innerEnd - windowEnd);
          const duration = piece.duration - head - tail;
          if (duration <= 0) continue;

          out.push({
            ...piece,
            id: `${instance.id}::${piece.id}`,
            startTime: instance.startTime + (innerStart + head - windowStart),
            duration,
            // Source-crop moves with the head trim, so the audio still starts
            // at the right point in its own file.
            inPoint: (piece.inPoint ?? 0) + head,
            outPoint: (piece.inPoint ?? 0) + head + duration,
            // The instance acts as a group fader over everything inside it.
            volume: (piece.volume ?? 1) * (instance.volume ?? 1),
            muted: piece.muted || instance.muted,
          });
        }
      }
    }
    return out;
  }

  const tracks: Track[] = project.timeline.tracks.map((track) => {
    let changed = false;
    const clips: Clip[] = [];
    for (const clip of track.clips) {
      const id = compoundIdOfClip(clip);
      if (!id || !byId.has(id)) { clips.push(clip); continue; }
      changed = true;
      // The expanded audio rides on the track the INSTANCE was on, so track
      // mute and solo keep applying to it as a whole.
      for (const piece of expand(clip, 0, new Set())) {
        clips.push({ ...piece, trackId: track.id });
      }
    }
    return changed ? { ...track, clips } : track;
  });

  return { ...project.timeline, tracks };
}
