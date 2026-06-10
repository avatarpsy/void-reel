import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRecorderStore } from "../../stores/recorder-store";

/**
 * Recording stage shown INSIDE the editor's player window (the project-aspect
 * framed overlay container) instead of as a fullscreen overlay. Handles BOTH:
 *   • the 3-2-1 countdown, and
 *   • the live webcam preview while recording,
 * so the user frames their shot exactly as it will look on the timeline — same
 * box, same aspect, same crop. Absolutely fills its positioned parent (the
 * overlay container in Preview.tsx is `position: relative`).
 *
 * Webcam-bearing modes (camera / both) show the live feed; screen / audio modes
 * show a clean dark stage with the countdown / a recording label. Audio-only and
 * screen captures have no in-player webcam to mirror.
 */
export const InlineRecordingPreview: React.FC = () => {
  const status = useRecorderStore((s) => s.status);
  const options = useRecorderStore((s) => s.options);
  const screenStream = useRecorderStore((s) => s.screenStream);
  const webcamStream = useRecorderStore((s) => s.webcamStream);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const active = status === "countdown" || status === "recording" || status === "paused";
  const mode = options.mode ?? "screen";
  // What to mirror in the player: camera → the webcam (primary stream); both →
  // the secondary webcam feed; screen/audio → nothing (no talking-head feed).
  const stream =
    mode === "camera" ? screenStream : mode === "both" ? webcamStream : null;

  // Bind via a callback ref so the stream attaches the instant the <video> node
  // mounts — a plain effect can fire before the node exists (the box mounts the
  // same tick the stream becomes available), leaving srcObject unset = black.
  const bind = useCallback(
    (el: HTMLVideoElement | null) => {
      videoRef.current = el;
      if (el && stream && el.srcObject !== stream) {
        el.srcObject = stream;
        el.play().catch(() => {/* autoplay race — muted so it resolves */});
      }
    },
    [stream],
  );

  useEffect(() => {
    const el = videoRef.current;
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream;
      el.play().catch(() => {/* muted, resolves */});
    }
  }, [stream]);

  // Countdown 3→2→1, mirrors the 3s delay in recorder-store.startRecording().
  const [count, setCount] = useState(3);
  useEffect(() => {
    if (status !== "countdown") {
      setCount(3);
      return;
    }
    if (count > 0) {
      const t = setTimeout(() => setCount((c) => c - 1), 1000);
      return () => clearTimeout(t);
    }
  }, [status, count]);

  if (!active) return null;

  const counting = status === "countdown";

  return (
    <div className="absolute inset-0 z-40 bg-black overflow-hidden flex items-center justify-center">
      {stream ? (
        <video
          ref={bind}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover"
          style={{ transform: "scaleX(-1)" }} // mirror — natural for a talking-head preview
        />
      ) : (
        // Screen / audio modes: no webcam to mirror in the player.
        <div className="text-text-muted text-sm font-medium">
          {mode === "audio" ? "Recording audio…" : "Recording your screen…"}
        </div>
      )}

      {counting && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
          <span
            key={count}
            className="vs-rec-count font-bold text-white leading-none"
            style={{
              fontSize: "clamp(64px, 28%, 200px)",
              textShadow:
                "0 0 40px rgba(239,68,68,0.85), 0 0 80px rgba(239,68,68,0.4)",
            }}
          >
            {count > 0 ? count : ""}
          </span>
        </div>
      )}

      {!counting && stream && (
        <div className="absolute top-3 left-3 flex items-center gap-2 px-2.5 py-1 rounded-full bg-black/55 backdrop-blur-sm">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
          <span className="text-xs font-semibold text-white tracking-wide">REC</span>
        </div>
      )}

      <style>{`
        @keyframes vsRecCount {
          0% { transform: scale(0.6); opacity: 0; }
          25% { transform: scale(1.12); opacity: 1; }
          45% { transform: scale(1); }
          100% { transform: scale(0.85); opacity: 0; }
        }
        .vs-rec-count { animation: vsRecCount 1s ease-out forwards; }
      `}</style>
    </div>
  );
};
