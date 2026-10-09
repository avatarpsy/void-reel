import React, { useEffect, useMemo, useRef } from "react";
import { AudioLines } from "lucide-react";
import { useProjectStore } from "../../stores/project-store";
import { useEditMonitorStore, type MonitorFrame } from "../../stores/edit-monitor-store";
import { formatTimecode } from "./timeline/utils";

/**
 * The two-up viewer shown DURING a slip or roll drag (DaVinci's trim view).
 *
 * A slip changes which frames a clip shows without moving it, so the only way
 * to aim it is to see where it now starts and ends. A roll moves a cut, so you
 * need the last frame out and the first frame in. Both are two SOURCE frames;
 * each panel seeks its own <video> to exactly that time, so the readout is
 * frame-true even while the compositor is busy.
 */

// One object URL per blob, for the life of the page — the same media is
// usually slipped many times, and revoking mid-drag would blank the panel.
const blobUrls = new WeakMap<Blob, string>();
function mediaSrc(blob: Blob | null | undefined, originalUrl?: string): string | null {
  if (blob) {
    let u = blobUrls.get(blob);
    if (!u) {
      u = URL.createObjectURL(blob);
      blobUrls.set(blob, u);
    }
    return u;
  }
  return originalUrl || null;
}

const FramePanel: React.FC<{ frame: MonitorFrame; fps: number }> = ({ frame, fps }) => {
  const item = useProjectStore((s) =>
    s.project.mediaLibrary.items.find((m) => m.id === frame.mediaId),
  );
  const src = useMemo(
    () => (item?.type === "video" ? mediaSrc(item.blob, item.originalUrl) : null),
    [item?.type, item?.blob, item?.originalUrl],
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const seeking = useRef(false);
  const pending = useRef<number | null>(null);

  // Seek without queueing a backlog: while a seek is in flight, remember only
  // the LATEST requested time and apply it when the current one lands.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const t = Math.max(0, frame.time);
    if (seeking.current) {
      pending.current = t;
      return;
    }
    seeking.current = true;
    v.currentTime = t;
  }, [frame.time, src]);

  const onSeeked = () => {
    const v = videoRef.current;
    seeking.current = false;
    if (v && pending.current !== null) {
      const t = pending.current;
      pending.current = null;
      seeking.current = true;
      v.currentTime = t;
    }
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-1">
      <div className="relative flex-1 min-h-0 bg-black rounded-md overflow-hidden ring-1 ring-white/10">
        {src ? (
          <video
            ref={videoRef}
            src={src}
            muted
            playsInline
            preload="auto"
            onSeeked={onSeeked}
            onLoadedMetadata={() => {
              // First seek may have fired before metadata — redo it.
              const v = videoRef.current;
              if (v) {
                seeking.current = true;
                v.currentTime = Math.max(0, frame.time);
              }
            }}
            className="w-full h-full object-contain"
            data-monitor-frame={frame.label}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white/40">
            <AudioLines size={28} />
          </div>
        )}
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono text-white/80 px-0.5">
        <span className="uppercase tracking-wider text-white/50">{frame.label}</span>
        <span data-monitor-time>{formatTimecode(frame.time, fps)}</span>
      </div>
    </div>
  );
};

export const EditMonitorOverlay: React.FC = () => {
  const monitor = useEditMonitorStore((s) => s.monitor);
  const fps = useProjectStore((s) => s.project.settings.frameRate) || 30;
  if (!monitor) return null;
  return (
    <div
      className="absolute inset-0 z-40 bg-black/90 flex flex-col p-2 gap-1.5 pointer-events-none"
      data-edit-monitor={monitor.title}
    >
      <div className="flex items-center justify-between text-[11px] text-white/90">
        <span className="font-medium">{monitor.title}</span>
        {monitor.badge && (
          <span className="font-mono px-1.5 py-0.5 rounded bg-primary/80 text-white" data-monitor-badge>
            {monitor.badge}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 flex gap-2">
        <FramePanel frame={monitor.frames[0]} fps={fps} />
        <FramePanel frame={monitor.frames[1]} fps={fps} />
      </div>
    </div>
  );
};
