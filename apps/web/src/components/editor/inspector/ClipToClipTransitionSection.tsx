import React, { useCallback, useMemo, useState } from "react";
import { ArrowLeftRight, X } from "lucide-react";
import { TRANSITION_TYPES } from "@openreel/core";
import type { Track, Transition } from "@openreel/core";
import { useProjectStore } from "../../../stores/project-store";
import {
  surface as clipTransitionSurface,
  neighbourOf,
  maxTransitionDuration,
} from "../../../agent/inspector-surfaces/clip-transitions";

/**
 * A real transition between THIS clip and the one next to it.
 *
 * ── WHY A SECOND TRANSITION SECTION ─────────────────────────────────────────
 * "Entry/Exit Transitions" next door animates ONE clip against the background:
 * it compiles a preset into opacity/transform keyframes at the head and tail of
 * a single shot. That is the right tool for the first and last shot of a film,
 * or for an overlay appearing — and the wrong one between two shots, where it
 * fades A out to black and B up from it. A dip through black is the thing
 * everyone recognises as "not a dissolve".
 *
 * This one writes `track.transitions[]`, which the renderer now blends: both
 * shots on screen at once, one function of progress. Until the TransitionEngine
 * was wired into `video-engine.renderFrame` nothing rendered that array at all,
 * which is why the control did not exist.
 *
 * ── THE SAME CODE THE AGENT RUNS ────────────────────────────────────────────
 * Everything here goes through the `clip-transitions` surface, so the button
 * and the chat request cannot drift — including the duration ceiling, which is
 * the rule most easily got wrong by hand.
 */

/** Grouped so the picker reads as choices rather than a wall of 24 names. */
const GROUPS: Array<{ label: string; types: string[] }> = [
  { label: "Dissolve", types: ["crossfade", "dipToBlack", "dipToWhite", "flash", "blur"] },
  { label: "Motion", types: ["slide", "push", "whipPan", "zoom", "spin", "flip"] },
  { label: "Wipe", types: ["wipe", "radialWipe", "blinds", "splitReveal"] },
  { label: "Shape", types: ["circleReveal", "diamondReveal"] },
  { label: "Stylised", types: ["glitch", "pixelate", "mosaic", "filmBurn", "ripple", "pageTurn", "colorSplit"] },
];

const LABELS: Record<string, string> = {
  crossfade: "Cross dissolve", dipToBlack: "Dip to black", dipToWhite: "Dip to white",
  whipPan: "Whip pan", radialWipe: "Radial wipe", circleReveal: "Circle", diamondReveal: "Diamond",
  splitReveal: "Split", filmBurn: "Film burn", pageTurn: "Page turn", colorSplit: "Colour split",
};
const label = (t: string) => LABELS[t] ?? t.charAt(0).toUpperCase() + t.slice(1);

export const ClipToClipTransitionSection: React.FC<{ clipId: string }> = ({ clipId }) => {
  const project = useProjectStore((s) => s.project);
  const [at, setAt] = useState<"end" | "start">("end");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const track: Track | undefined = useMemo(
    () => project.timeline.tracks.find((t) => (t.clips ?? []).some((c) => c.id === clipId)),
    [project.timeline.tracks, clipId],
  );

  const pair = useMemo(
    () => (track ? neighbourOf(track, clipId, at) : null),
    [track, clipId, at],
  );

  const existing: Transition | undefined = useMemo(() => {
    if (!track || !pair) return undefined;
    return (track.transitions ?? []).find(
      (t) => t.clipAId === pair.a.id && t.clipBId === pair.b.id,
    );
  }, [track, pair, project.modifiedAt]);

  const ceiling = pair ? maxTransitionDuration(pair.a, pair.b) : 0;
  const [duration, setDuration] = useState(0.5);

  const run = useCallback(
    async (config: Record<string, unknown>) => {
      if (!track) return;
      setBusy(true);
      setError(null);
      try {
        const store = useProjectStore.getState();
        const raw = (track.clips ?? []).find((c) => c.id === clipId);
        if (!raw) { setError("clip not found"); return; }
        const res = await clipTransitionSurface.apply(
          { id: clipId, kind: "video", trackId: track.id, raw: raw as never },
          { at, ...config },
          { project: store.project, store: store as unknown as Record<string, unknown> },
        );
        if (!res.ok) setError(res.error ?? "could not apply the transition");
      } finally {
        setBusy(false);
      }
    },
    [track, clipId, at],
  );

  if (!track) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 p-2 bg-primary/10 rounded-lg border border-primary/30">
        <ArrowLeftRight size={16} className="text-primary" />
        <div className="flex-1">
          <span className="text-[11px] font-medium text-text-primary">Transition to neighbour</span>
          <p className="text-[9px] text-text-muted">
            Blends both shots together — unlike Entry/Exit, which fades one against the background.
          </p>
        </div>
      </div>

      {/* Which edge */}
      <div className="grid grid-cols-2 gap-2">
        {(["start", "end"] as const).map((edge) => (
          <button
            key={edge}
            onClick={() => setAt(edge)}
            className={`px-2 py-1.5 rounded-lg text-[10px] transition-colors ${
              at === edge
                ? "bg-primary text-white"
                : "bg-background-tertiary text-text-muted hover:text-text-primary"
            }`}
          >
            {edge === "start" ? "← Previous clip" : "Next clip →"}
          </button>
        ))}
      </div>

      {!pair ? (
        <p className="text-[10px] text-text-muted px-1">
          {at === "end" ? "Nothing after this clip on its track." : "Nothing before this clip on its track."}
        </p>
      ) : (
        <>
          {existing && (
            <div className="flex items-center gap-2 p-2 bg-green-500/10 border border-green-500/20 rounded-lg">
              <span className="flex-1 text-[10px] text-green-400">
                {label(existing.type)} · {existing.duration}s
              </span>
              <button
                onClick={() => run({ remove: true })}
                disabled={busy}
                className="p-1 rounded text-text-muted hover:text-text-primary"
                title="Remove this transition"
              >
                <X size={12} />
              </button>
            </div>
          )}

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-text-secondary">Duration</span>
              <span className="text-[10px] font-mono text-text-primary bg-background-tertiary px-1.5 py-0.5 rounded border border-border">
                {Math.min(duration, ceiling).toFixed(2)}s
              </span>
            </div>
            <input
              type="range"
              min={0.1}
              // The ceiling is half the SHORTER clip: a transition eats the tail
              // of one shot and the head of the next, and longer than this it has
              // consumed the shot.
              max={Math.max(0.1, ceiling)}
              step={0.05}
              value={Math.min(duration, ceiling)}
              onChange={(e) => setDuration(parseFloat(e.target.value))}
              className="w-full"
            />
            <p className="text-[8px] text-text-muted">
              Up to {ceiling.toFixed(2)}s here — half the shorter clip.
            </p>
          </div>

          {GROUPS.map((g) => (
            <div key={g.label} className="space-y-1">
              <span className="text-[9px] uppercase tracking-wide text-text-muted">{g.label}</span>
              <div className="flex flex-wrap gap-1">
                {g.types
                  .filter((t) => (TRANSITION_TYPES as readonly string[]).includes(t))
                  .map((t) => (
                    <button
                      key={t}
                      disabled={busy}
                      onClick={() => run({ type: t, durationSec: Math.min(duration, ceiling) })}
                      className={`px-2 py-1 rounded text-[9px] transition-colors ${
                        existing?.type === t
                          ? "bg-primary text-white"
                          : "bg-background-tertiary text-text-muted hover:text-text-primary"
                      }`}
                    >
                      {label(t)}
                    </button>
                  ))}
              </div>
            </div>
          ))}

          {error && (
            <div className="p-2 bg-red-500/10 border border-red-500/20 rounded-lg">
              <span className="text-[10px] text-red-400">{error}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default ClipToClipTransitionSection;
