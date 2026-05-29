import React from "react";
import { Play, Pause, SkipBack, SkipForward, ChevronFirst, ChevronLast } from "lucide-react";
import { useTimelineStore } from "../../stores/timeline-store";
import { useProjectStore } from "../../stores/project-store";
import { formatTimecode } from "./timeline/utils";

/**
 * Store-backed playback transport, docked on the timeline toolbar.
 *
 * Reads/writes ONLY useTimelineStore (playbackState / playheadPosition /
 * togglePlayback / seek*) plus the project duration, so it can live
 * anywhere and stays perfectly in sync with the Preview component — which
 * owns the actual RAF + Web-Audio playback loop but merely reacts to the
 * store's playbackState. This keeps transport available even when the
 * video preview is minimized.
 */
export const Transport: React.FC = () => {
  const playbackState = useTimelineStore((s) => s.playbackState);
  const playheadPosition = useTimelineStore((s) => s.playheadPosition);
  const togglePlayback = useTimelineStore((s) => s.togglePlayback);
  const seekRelative = useTimelineStore((s) => s.seekRelative);
  const seekToStart = useTimelineStore((s) => s.seekToStart);
  const seekToEnd = useTimelineStore((s) => s.seekToEnd);
  const duration = useProjectStore((s) => s.project.timeline.duration) || 0;
  const frameRate = useProjectStore((s) => s.project.settings.frameRate) || 30;
  const isPlaying = playbackState === "playing";

  const btn =
    "p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-background-elevated transition-colors";

  return (
    <div className="flex items-center gap-1.5 select-none">
      <button className={btn} onClick={() => seekToStart()} title="Go to start (Home)">
        <ChevronFirst size={16} />
      </button>
      <button className={btn} onClick={() => seekRelative(-5)} title="Back 5s">
        <SkipBack size={15} />
      </button>
      <button
        onClick={() => togglePlayback()}
        title={isPlaying ? "Pause (Space)" : "Play (Space)"}
        className="w-8 h-8 rounded-full bg-primary hover:bg-primary-hover active:bg-primary-active flex items-center justify-center text-white transition-all shadow-[0_0_12px_rgba(34,197,94,0.35)] hover:shadow-[0_0_18px_rgba(34,197,94,0.55)]"
      >
        {isPlaying ? (
          <Pause size={15} fill="currentColor" />
        ) : (
          <Play size={15} fill="currentColor" className="ml-0.5" />
        )}
      </button>
      <button className={btn} onClick={() => seekRelative(5)} title="Forward 5s">
        <SkipForward size={15} />
      </button>
      <button className={btn} onClick={() => seekToEnd(duration)} title="Go to end (End)">
        <ChevronLast size={16} />
      </button>
      <div className="ml-2 font-mono text-xs tabular-nums tracking-wider flex items-center gap-1">
        <span className="text-primary">{formatTimecode(playheadPosition, frameRate)}</span>
        <span className="text-text-tertiary">/</span>
        <span className="text-text-secondary">{formatTimecode(duration, frameRate)}</span>
      </div>
    </div>
  );
};
