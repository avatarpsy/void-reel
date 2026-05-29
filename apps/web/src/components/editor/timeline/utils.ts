import { Film, Volume2, Image, Type, Shapes, Layers } from "lucide-react";
import type { Track } from "@openreel/core";
import type {
  SnapPoint,
  SnapResult,
  SnapSettings,
  ClipStyle,
  TrackInfo,
} from "./types";

export const calculateSnap = (
  rawTime: number,
  clipId: string,
  tracks: Track[],
  playheadPosition: number,
  snapSettings: SnapSettings,
  pixelsPerSecond: number,
  clipDuration?: number,
): SnapResult => {
  if (!snapSettings.enabled) {
    return { time: rawTime, snapped: false };
  }

  const thresholdSeconds = snapSettings.snapThreshold / pixelsPerSecond;
  const snapPoints: SnapPoint[] = [];

  if (snapSettings.snapToClips) {
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (clip.id === clipId) continue;
        snapPoints.push({ time: clip.startTime, type: "clip-start" });
        snapPoints.push({
          time: clip.startTime + clip.duration,
          type: "clip-end",
        });
      }
    }
  }

  if (snapSettings.snapToPlayhead) {
    snapPoints.push({ time: playheadPosition, type: "playhead" });
  }

  if (snapSettings.snapToGrid) {
    const nearestGrid =
      Math.round(rawTime / snapSettings.gridSize) * snapSettings.gridSize;
    snapPoints.push({ time: nearestGrid, type: "grid" });
    if (clipDuration) {
      const endTime = rawTime + clipDuration;
      const nearestEndGrid =
        Math.round(endTime / snapSettings.gridSize) * snapSettings.gridSize;
      snapPoints.push({ time: nearestEndGrid, type: "grid" });
    }
  }

  const priorityOrder: Record<string, number> = {
    "clip-start": 0,
    "clip-end": 0,
    "playhead": 1,
    "grid": 2,
  };

  let closestPoint: SnapPoint | undefined;
  let closestDistance = Infinity;
  let closestPriority = Infinity;
  let snapFromEnd = false;

  for (const point of snapPoints) {
    const pointPriority = priorityOrder[point.type] ?? 2;

    const startDistance = Math.abs(point.time - rawTime);
    if (startDistance < thresholdSeconds) {
      const isBetter =
        pointPriority < closestPriority ||
        (pointPriority === closestPriority && startDistance < closestDistance);
      if (isBetter) {
        closestDistance = startDistance;
        closestPriority = pointPriority;
        closestPoint = point;
        snapFromEnd = false;
      }
    }

    if (clipDuration) {
      const clipEndTime = rawTime + clipDuration;
      const endDistance = Math.abs(point.time - clipEndTime);
      if (endDistance < thresholdSeconds) {
        const isBetter =
          pointPriority < closestPriority ||
          (pointPriority === closestPriority && endDistance < closestDistance);
        if (isBetter) {
          closestDistance = endDistance;
          closestPriority = pointPriority;
          closestPoint = point;
          snapFromEnd = true;
        }
      }
    }
  }

  if (closestPoint) {
    const snappedTime = snapFromEnd
      ? closestPoint.time - (clipDuration ?? 0)
      : closestPoint.time;
    return {
      time: Math.max(0, snappedTime),
      snapped: true,
      snapPoint: { ...closestPoint, time: closestPoint.time },
    };
  }

  return { time: rawTime, snapped: false };
};

export const generateWaveformPath = (
  waveformData: Float32Array | number[],
  width: number,
): string => {
  if (!waveformData || waveformData.length === 0) {
    return "M0,20 L100,20";
  }

  const samples = Array.from(waveformData);
  const step = Math.max(1, Math.floor(samples.length / width));
  const points: string[] = [];

  for (let i = 0; i < width; i++) {
    const sampleIndex = Math.min(i * step, samples.length - 1);
    const value = Math.abs(samples[sampleIndex] || 0);
    const y = 20 - value * 18;
    points.push(`${i === 0 ? "M" : "L"}${i},${y}`);
  }

  return points.join(" ");
};

/**
 * Build a closed SVG path for a mirrored, filled waveform envelope.
 *
 * Drawn into a normalized `0 0 <bars> 100` viewBox (render the <svg>
 * with preserveAspectRatio="none" so it fills the clip box). Each bar is
 * the max amplitude of its source bucket, mirrored around the centre
 * line — far more legible than a single polyline, and resolution-aware:
 * `bars` scales with the clip's pixel width (capped) so wide clips stay
 * crisp while narrow clips stay cheap.
 *
 * `startFrac`/`endFrac` slice the source peaks to the clip's trimmed
 * [inPoint, outPoint] window so the drawn waveform matches what plays.
 */
export const generateWaveformEnvelope = (
  peaks: Float32Array | number[],
  bars: number,
  startFrac = 0,
  endFrac = 1,
): string => {
  if (!peaks || peaks.length === 0 || bars <= 0) return "";

  const len = peaks.length;
  const s0 = Math.max(0, Math.min(1, startFrac));
  const e0 = Math.max(s0, Math.min(1, endFrac));
  const startIdx = Math.floor(s0 * len);
  const endIdx = Math.max(startIdx + 1, Math.floor(e0 * len));
  const per = (endIdx - startIdx) / bars;

  const CENTER = 50;
  const HALF = 48;

  const tops = new Array<number>(bars);
  for (let i = 0; i < bars; i++) {
    const from = startIdx + Math.floor(i * per);
    const to = Math.min(endIdx, startIdx + Math.floor((i + 1) * per));
    let max = 0;
    for (let j = from; j < to; j++) {
      const v = Math.abs(peaks[j] || 0);
      if (v > max) max = v;
    }
    tops[i] = Math.min(1, max);
  }

  const top: string[] = [];
  for (let i = 0; i < bars; i++) {
    const y = CENTER - tops[i] * HALF;
    top.push(`${i === 0 ? "M" : "L"}${i},${y.toFixed(2)}`);
  }
  const bottom: string[] = [];
  for (let i = bars - 1; i >= 0; i--) {
    const y = CENTER + tops[i] * HALF;
    bottom.push(`L${i},${y.toFixed(2)}`);
  }

  return `${top.join(" ")} ${bottom.join(" ")} Z`;
};

export const formatTimecode = (
  timeInSeconds: number,
  frameRate: number = 30,
): string => {
  if (!isFinite(timeInSeconds) || isNaN(timeInSeconds) || timeInSeconds < 0) {
    return "00:00:00:00";
  }
  const hours = Math.floor(timeInSeconds / 3600);
  const minutes = Math.floor((timeInSeconds % 3600) / 60);
  const seconds = Math.floor(timeInSeconds % 60);
  const frames = Math.floor((timeInSeconds % 1) * frameRate);
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}:${frames
    .toString()
    .padStart(2, "0")}`;
};

export const getTrackInfo = (track: Track, index: number): TrackInfo => {
  switch (track.type) {
    case "video":
      return {
        label: `V${index + 1}`,
        icon: Film,
        color: "bg-primary",
        textColor: "text-primary",
        bgLight: "bg-primary/20",
      };
    case "audio":
      return {
        label: `A${index + 1}`,
        icon: Volume2,
        color: "bg-blue-500",
        textColor: "text-blue-700 dark:text-blue-400",
        bgLight: "bg-blue-500/20",
      };
    case "image":
      return {
        label: `I${index + 1}`,
        icon: Image,
        color: "bg-purple-500",
        textColor: "text-purple-700 dark:text-purple-400",
        bgLight: "bg-purple-500/20",
      };
    case "text":
      return {
        label: `T${index + 1}`,
        icon: Type,
        color: "bg-amber-500",
        textColor: "text-amber-700 dark:text-amber-400",
        bgLight: "bg-amber-500/20",
      };
    case "graphics":
      return {
        label: `G${index + 1}`,
        icon: Shapes,
        color: "bg-green-500",
        textColor: "text-green-700 dark:text-green-400",
        bgLight: "bg-green-500/20",
      };
    default:
      return {
        label: `?${index + 1}`,
        icon: Layers,
        color: "bg-gray-500",
        textColor: "text-gray-700 dark:text-gray-400",
        bgLight: "bg-gray-500/20",
      };
  }
};

export const getClipStyle = (trackType: string): ClipStyle => {
  switch (trackType) {
    case "video":
      return {
        bg: "bg-primary/10",
        border: "border-primary/30",
        text: "text-gray-800 dark:text-white/90",
        selectedText: "text-gray-900 dark:text-white",
      };
    case "audio":
      return {
        bg: "bg-blue-500/10",
        border: "border-blue-500/30",
        text: "text-text-secondary",
        selectedText: "text-blue-700 dark:text-blue-400",
      };
    case "image":
      return {
        bg: "bg-purple-500/10",
        border: "border-purple-500/30",
        text: "text-purple-700 dark:text-purple-300",
        selectedText: "text-purple-800 dark:text-purple-400",
      };
    default:
      return {
        bg: "bg-gray-500/10",
        border: "border-gray-500/30",
        text: "text-text-secondary",
        selectedText: "text-text-primary",
      };
  }
};
