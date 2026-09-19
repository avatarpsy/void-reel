import React, {
  useCallback,
  useMemo,
  useEffect,
  useState,
  useRef,
} from "react";
import { useProjectStore } from "../../stores/project-store";
import { ChannelStrip } from "./ChannelStrip";
import type { ChannelStripState } from "./types";
import { volumeToDb, formatDb } from "./types";
import { Transport } from "../editor/Transport";
import { getRealtimeAudioGraph } from "@openreel/core";

/** Output rates worth offering: CD, broadcast/DAW standard, and hi-res. */
const SAMPLE_RATES = [44100, 48000, 96000] as const;

export interface AudioMixerProps {
  /** Whether the mixer panel is visible */
  visible?: boolean;
  /** Callback when the mixer is closed */
  onClose?: () => void;
  /**
   * Layout variant.
   *  • "dock"   (default) — a fixed-height strip docked under the workspace
   *    (the classic video-mode toggle panel). Backward compatible.
   *  • "center" — fills the center column in place of the video preview
   *    (music mode). Flexes to the available height; no close button.
   */
  variant?: "dock" | "center";
}

/**
 * Master channel component for overall output control
 */
const MasterChannel: React.FC<{
  volume: number;
  peakLevel: number;
  rmsLevel: number;
  onVolumeChange: (volume: number) => void;
}> = ({ volume, peakLevel, rmsLevel, onVolumeChange }) => {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onVolumeChange(parseFloat(e.target.value));
    },
    [onVolumeChange],
  );

  const dbValue = volumeToDb(volume);
  const levelPercent = Math.min(100, Math.max(0, rmsLevel * 100));
  const peakPercent = Math.min(100, Math.max(0, peakLevel * 100));

  // Master meter: brand pink, red only at true clipping (>90%). Matches the
  // per-channel strips so the whole console reads as one on-brand surface.
  const getColor = (percent: number) => {
    if (percent > 90) return "bg-red-500";
    if (percent > 75) return "bg-pink-300";
    return "bg-pink-500";
  };

  return (
    <div className="flex flex-col items-center gap-2 p-3 bg-background-secondary rounded-lg min-w-[100px] border border-border">
      <div className="text-xs text-text-secondary font-bold">MASTER</div>

      {/* Stereo level meter */}
      <div className="flex gap-1 h-32 w-6">
        <div className="flex-1 bg-background-elevated rounded-sm overflow-hidden relative">
          <div
            className={`absolute bottom-0 left-0 right-0 transition-all duration-75 ${getColor(
              levelPercent,
            )}`}
            style={{ height: `${levelPercent}%` }}
          />
          <div
            className="absolute left-0 right-0 h-0.5 bg-text-primary/70"
            style={{ bottom: `${peakPercent}%` }}
          />
        </div>
        <div className="flex-1 bg-background-elevated rounded-sm overflow-hidden relative">
          <div
            className={`absolute bottom-0 left-0 right-0 transition-all duration-75 ${getColor(
              levelPercent,
            )}`}
            style={{ height: `${levelPercent}%` }}
          />
          <div
            className="absolute left-0 right-0 h-0.5 bg-text-primary/70"
            style={{ bottom: `${peakPercent}%` }}
          />
        </div>
      </div>

      {/* Master fader — brighter pink so the master reads as the primary fader */}
      <div className="flex flex-col items-center gap-1">
        <span className="text-xs text-text-muted font-mono w-12 text-center">
          {formatDb(dbValue)} dB
        </span>
        <input
          type="range"
          min="0"
          max="4"
          step="0.01"
          value={volume}
          onChange={handleChange}
          className="h-24 w-2 appearance-none bg-background-elevated rounded-full cursor-pointer
 [writing-mode:vertical-lr] [direction:rtl]
 [&::-webkit-slider-thumb]:appearance-none
 [&::-webkit-slider-thumb]:w-4
 [&::-webkit-slider-thumb]:h-6
 [&::-webkit-slider-thumb]:bg-pink-600
 [&::-webkit-slider-thumb]:rounded
 [&::-webkit-slider-thumb]:cursor-pointer
 [&::-webkit-slider-thumb]:shadow-md
 [&::-moz-range-thumb]:w-4
 [&::-moz-range-thumb]:h-6
 [&::-moz-range-thumb]:bg-pink-600
 [&::-moz-range-thumb]:rounded
 [&::-moz-range-thumb]:cursor-pointer
 [&::-moz-range-thumb]:border-0"
          aria-label="Master volume fader"
        />
      </div>
    </div>
  );
};

/**
 * AudioMixer component
 *
 * Displays a mixing console with channel strips for each audio track.
 * Implements audio mixing functionality.
 */
export const AudioMixer: React.FC<AudioMixerProps> = ({
  visible = true,
  onClose,
  variant = "dock",
}) => {
  const isCenter = variant === "center";
  const project = useProjectStore((state) => state.project);
  const muteTrack = useProjectStore((state) => state.muteTrack);
  const soloTrack = useProjectStore((state) => state.soloTrack);
  const updateSettings = useProjectStore((state) => state.updateSettings);

  // Use the same graph as playback so mixer volume affects preview/playback
  const audioGraphRef = useRef<ReturnType<typeof getRealtimeAudioGraph> | null>(null);

  // Local state for master volume and levels
  const [masterVolume, setMasterVolume] = useState(1);
  const [masterPeakLevel, setMasterPeakLevel] = useState(0);
  const [masterRmsLevel, setMasterRmsLevel] = useState(0);

  // Local state for track volumes and pans (stored per-track)
  const [trackVolumes, setTrackVolumes] = useState<Record<string, number>>({});
  const [trackPans, setTrackPans] = useState<Record<string, number>>({});
  const [trackLevels, setTrackLevels] = useState<
    Record<string, { peak: number; rms: number }>
  >({});

  // Get audio tracks from the timeline (Requirement 20.1) – safe if project/timeline not ready
  const audioTracks = useMemo(() => {
    const tracks = project?.timeline?.tracks ?? [];
    return tracks.filter(
      (track) => track.type === "audio" || track.type === "video",
    );
  }, [project?.timeline?.tracks]);

  useEffect(() => {
    try {
      audioGraphRef.current = getRealtimeAudioGraph();
    } catch {
      audioGraphRef.current = null;
    }
  }, []);

  // Sync initial volume/pan/master from graph when mixer opens (e.g. after playback)
  useEffect(() => {
    if (!visible || !audioGraphRef.current) return;
    const graph = audioGraphRef.current;
    try {
      if (typeof graph.getMasterVolume === "function") {
        setMasterVolume(graph.getMasterVolume());
      }
      /**
       * THE PROJECT IS THE SOURCE OF TRUTH; THE GRAPH IS THIS SESSION'S COPY.
       *
       * The graph only knows about a track once playback has built it, so on a
       * freshly loaded project it answers unity for everything. Reading it first
       * would therefore show every fader at 0 dB on a mix that is saved at
       * something else — and then the first fader move would write that wrong
       * value back. `Track.volume` is what was saved, so it wins; the graph is
       * consulted only for a track the project has no value for yet.
       */
      setTrackVolumes((prev) => {
        const next = { ...prev };
        audioTracks.forEach((t) => {
          next[t.id] =
            typeof t.volume === "number"
              ? t.volume
              : (typeof graph.getTrackVolume === "function"
                  ? graph.getTrackVolume(t.id)
                  : 1);
        });
        return next;
      });
      setTrackPans((prev) => {
        const next = { ...prev };
        audioTracks.forEach((t) => {
          next[t.id] =
            typeof t.pan === "number"
              ? t.pan
              : (typeof graph.getTrackPan === "function"
                  ? graph.getTrackPan(t.id)
                  : 0);
        });
        return next;
      });
    } catch {
      // Graph not ready yet
    }
  }, [visible, audioTracks]);

  // Check if any track has solo enabled (for Requirement 20.4)
  const hasSoloedTracks = useMemo(() => {
    return audioTracks.some((track) => track.solo);
  }, [audioTracks]);

  // Build channel strip states (Requirement 20.1)
  const channels: ChannelStripState[] = useMemo(() => {
    return audioTracks.map((track) => ({
      trackId: track.id,
      trackName: track.name,
      trackType: track.type,
      volume: trackVolumes[track.id] ?? track.volume ?? 1,
      pan: trackPans[track.id] ?? track.pan ?? 0,
      muted: track.muted,
      solo: track.solo,
      peakLevel: trackLevels[track.id]?.peak ?? 0,
      rmsLevel: trackLevels[track.id]?.rms ?? 0,
    }));
  }, [audioTracks, trackVolumes, trackPans, trackLevels]);

  /**
   * FADER MOVE — heard now, saved with the project, undoable.
   *
   * Three writes, and each is there for a different reason:
   *  - the live graph, so the move is audible on the next buffer rather than
   *    after a re-render;
   *  - local state, so the fader tracks the pointer without waiting on a store
   *    round trip;
   *  - `setTrackVolume`, which goes through the ActionExecutor onto
   *    `Track.volume` — the part that persists and that the export reads.
   *
   * Only the first two existed. A channel strip therefore survived exactly as
   * long as the session: right in the preview, absent from the saved project,
   * absent from the rendered file. Because the preview obeyed it, moving a
   * fader gave every signal that the change had taken.
   */
  const setTrackVolumePersisted = useProjectStore((s) => s.setTrackVolume);
  const setTrackPanPersisted = useProjectStore((s) => s.setTrackPan);

  const handleVolumeChange = useCallback((trackId: string, volume: number) => {
    setTrackVolumes((prev) => ({
      ...prev,
      [trackId]: volume,
    }));
    audioGraphRef.current?.updateTrackVolume(trackId, volume);
    void setTrackVolumePersisted?.(trackId, volume);
  }, [setTrackVolumePersisted]);

  // Handle pan change (Requirement 20.3)
  const handlePanChange = useCallback((trackId: string, pan: number) => {
    setTrackPans((prev) => ({
      ...prev,
      [trackId]: pan,
    }));
    audioGraphRef.current?.updateTrackPan(trackId, pan);
    void setTrackPanPersisted?.(trackId, pan);
  }, [setTrackPanPersisted]);

  // Handle mute toggle (Requirement 20.5)
  const handleMuteToggle = useCallback(
    async (trackId: string) => {
      const track = audioTracks.find((t) => t.id === trackId);
      if (track) {
        await muteTrack(trackId, !track.muted);
      }
    },
    [audioTracks, muteTrack],
  );

  // Handle solo toggle (Requirement 20.4)
  const handleSoloToggle = useCallback(
    async (trackId: string) => {
      const track = audioTracks.find((t) => t.id === trackId);
      if (track) {
        await soloTrack(trackId, !track.solo);
      }
    },
    [audioTracks, soloTrack],
  );

  // Handle master volume change
  const handleMasterVolumeChange = useCallback((volume: number) => {
    setMasterVolume(volume);
    audioGraphRef.current?.setMasterVolume(volume);
  }, []);

  /**
   * LEVEL METERING — read off the audio graph, not inferred from the faders.
   *
   * This used to compute `trackVolume * 0.4` on a timer and call it a level.
   * Every strip therefore showed the same bar whenever the faders matched,
   * whether the track was silent, clipping, or — as was usually the case —
   * not playing at all. A meter that moves with the fader instead of the audio
   * is worse than no meter: it is the one instrument you check to find out
   * whether a mix decision worked, and it was answering from the decision
   * rather than from the sound.
   *
   * `getTrackLevel` taps each track after volume, pan and effects, so what you
   * read here is the track's real contribution to the mix. It covers VIDEO
   * tracks as well as audio ones, and the music editor as well as the video
   * editor, because both drive this same graph — a video clip's audio meters on
   * its own strip exactly like a music bed does.
   *
   * rAF rather than a 100 ms timer: the browser suspends it in a background
   * tab, so a hidden mixer stops polling instead of burning a frame's work
   * forever. Peaks decay rather than snapping to zero, so a transient stays
   * visible long enough to read.
   */
  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    const peakHold: Record<string, number> = {};
    let masterHold = 0;
    const DECAY = 0.92;

    const tick = () => {
      const graph = audioGraphRef.current;
      const next: Record<string, { peak: number; rms: number }> = {};

      audioTracks.forEach((track) => {
        const live = graph?.getTrackLevel?.(track.id) ?? { peak: 0, rms: 0 };
        const held = Math.max(live.peak, (peakHold[track.id] ?? 0) * DECAY);
        peakHold[track.id] = held;
        next[track.id] = { peak: Math.min(1, held), rms: Math.min(1, live.rms) };
      });
      setTrackLevels(next);

      const master = graph?.getMasterLevel?.() ?? { peak: 0, rms: 0 };
      masterHold = Math.max(master.peak, masterHold * DECAY);
      setMasterPeakLevel(Math.min(1, masterHold));
      setMasterRmsLevel(Math.min(1, master.rms));

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [visible, audioTracks]);

  if (!visible) return null;

  return (
    <div
      className={
        isCenter
          ? "flex-1 min-w-0 flex flex-col bg-background-secondary border-l border-r border-border p-4 overflow-hidden"
          : "bg-gray-900 border-t border-gray-700 p-4"
      }
      data-testid="audio-mixer"
      role="region"
      aria-label="Audio Mixing Console"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-text-primary">Audio Mixer</h2>
          {isCenter && (
            <span className="text-[11px] uppercase tracking-wider text-pink-400 font-medium">
              Music mode
            </span>
          )}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors"
            aria-label="Close mixer"
          >
            ✕
          </button>
        )}
      </div>

      {/* Channel strips container */}
      <div
        className={`flex gap-2 overflow-x-auto pb-2 ${
          isCenter ? "flex-1 items-start content-start overflow-y-auto" : ""
        }`}
      >
        {/* Track channel strips (Requirement 20.1) */}
        {channels.length > 0 ? (
          channels.map((channel) => (
            <ChannelStrip
              key={channel.trackId}
              channel={channel}
              onVolumeChange={handleVolumeChange}
              onPanChange={handlePanChange}
              onMuteToggle={handleMuteToggle}
              onSoloToggle={handleSoloToggle}
              hasSoloedTracks={hasSoloedTracks}
            />
          ))
        ) : (
          <div className="text-text-muted text-sm py-8 px-4">
            No audio tracks in timeline. Add audio or video tracks to see
            channel strips.
          </div>
        )}

        {/* Separator */}
        {channels.length > 0 && (
          <div className="w-px bg-border mx-2 self-stretch" />
        )}

        {/* Master channel */}
        <MasterChannel
          volume={masterVolume}
          peakLevel={masterPeakLevel}
          rmsLevel={masterRmsLevel}
          onVolumeChange={handleMasterVolumeChange}
        />
      </div>

      {/* Transport row — deliberately its own row BELOW the channel strips so
          it sits where the video preview's control bar sits. Muscle memory for
          play/scrub should not move when you switch between video and music. */}
      <div className="mt-3 pt-3 border-t border-border flex items-center justify-center shrink-0">
        <Transport />
      </div>

      {/* Status + output configuration */}
      <div className="mt-2 pt-2 border-t border-border flex items-center justify-between text-xs text-text-muted shrink-0">
        <span>
          {channels.length} channel{channels.length !== 1 ? "s" : ""}
          {hasSoloedTracks && (
            <span className="ml-2 text-amber-400">• Solo active</span>
          )}
        </span>
        {/* Output configuration. These were a read-only label; they drive the
            render and every user asking "what am I bouncing at?" had no way to
            change it without leaving the mixer. */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5">
            <span>Sample rate</span>
            <select
              value={project.settings.sampleRate}
              onChange={(e) => updateSettings({ sampleRate: Number(e.target.value) })}
              className="bg-background-secondary border border-border rounded px-1.5 py-0.5 text-text-primary focus:border-primary focus:outline-none"
              aria-label="Output sample rate"
            >
              {SAMPLE_RATES.map((r) => (
                <option key={r} value={r}>{r === 44100 ? "44.1 kHz" : `${r / 1000} kHz`}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span>Channels</span>
            <select
              value={project.settings.channels}
              onChange={(e) => updateSettings({ channels: Number(e.target.value) })}
              className="bg-background-secondary border border-border rounded px-1.5 py-0.5 text-text-primary focus:border-primary focus:outline-none"
              aria-label="Output channel count"
            >
              <option value={1}>Mono</option>
              <option value={2}>Stereo</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  );
};

export default AudioMixer;
