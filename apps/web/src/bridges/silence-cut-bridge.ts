import { getAudioEngine } from "@openreel/core";
import { useProjectStore } from "../stores/project-store";

export interface SilenceSettings {
  threshold: number;
  minSilenceDuration: number;
  paddingBefore: number;
  paddingAfter: number;
}

export interface SilentRegion {
  start: number;
  end: number;
  duration: number;
}

export interface SilenceAnalysisResult {
  silentRegions: SilentRegion[];
  totalSilenceDuration: number;
  clipDuration: number;
}

export const DEFAULT_SILENCE_SETTINGS: SilenceSettings = {
  threshold: -40,
  minSilenceDuration: 0.5,
  paddingBefore: 0.1,
  paddingAfter: 0.1,
};

export type SilenceProgressCallback = (
  progress: number,
  message: string,
) => void;

export class SilenceCutBridge {
  private audioContext: AudioContext | null = null;

  private getAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  async analyzeClip(
    clipId: string,
    settings: SilenceSettings,
    onProgress?: SilenceProgressCallback,
  ): Promise<SilenceAnalysisResult> {
    const store = useProjectStore.getState();
    const clip = store.getClip(clipId);

    if (!clip) {
      throw new Error("Clip not found");
    }

    const mediaItem = store.getMediaItem(clip.mediaId);
    if (!mediaItem?.blob) {
      throw new Error("Media blob not found");
    }

    onProgress?.(10, "Loading audio...");

    const audioContext = this.getAudioContext();
    const arrayBuffer = await mediaItem.blob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    onProgress?.(30, "Detecting silence...");

    const audioEngine = getAudioEngine();
    const rawSilentRanges = audioEngine.detectSilence(
      audioBuffer,
      settings.threshold,
    );

    onProgress?.(60, "Processing results...");

    const inPoint = clip.inPoint ?? 0;
    const outPoint = clip.outPoint ?? audioBuffer.duration;
    const clipDuration = outPoint - inPoint;

    const filteredRegions = rawSilentRanges
      .map((range) => {
        const relativeStart = range.start - inPoint;
        const relativeEnd = range.end - inPoint;

        const adjustedStart = Math.max(
          0,
          relativeStart + settings.paddingBefore,
        );
        const adjustedEnd = Math.min(
          clipDuration,
          relativeEnd - settings.paddingAfter,
        );

        return {
          start: adjustedStart,
          end: adjustedEnd,
          duration: adjustedEnd - adjustedStart,
        };
      })
      .filter(
        (region) =>
          region.duration >= settings.minSilenceDuration &&
          region.start >= 0 &&
          region.end <= clipDuration &&
          region.start < region.end,
      );

    onProgress?.(90, "Finalizing...");

    const totalSilenceDuration = filteredRegions.reduce(
      (sum, region) => sum + region.duration,
      0,
    );

    onProgress?.(100, "Complete");

    return {
      silentRegions: filteredRegions,
      totalSilenceDuration,
      clipDuration,
    };
  }

  async cutSilence(
    clipId: string,
    silentRegions: SilentRegion[],
    onProgress?: SilenceProgressCallback,
  ): Promise<{ success: boolean; error?: string }> {
    if (silentRegions.length === 0) {
      return { success: true };
    }

    const store = useProjectStore.getState();
    const initialClip = store.getClip(clipId);

    if (!initialClip) {
      return { success: false, error: "Clip not found" };
    }

    // Every lookup below is scoped to THIS clip's track — see the comment on
    // `findClipContainingTime`. Without it the cuts land on whatever clip
    // happens to share the timecode on another track.
    const trackId = store.project.timeline.tracks
      .find((t) => t.clips.some((c) => c.id === clipId))?.id;
    if (!trackId) {
      return { success: false, error: "Clip is not on any track" };
    }

    const clipStartTime = initialClip.startTime;
    const sortedRegions = [...silentRegions].sort((a, b) => b.start - a.start);

    onProgress?.(0, "Preparing cuts...");

    const actionHistory = store.actionHistory;
    actionHistory.beginGroup("Cut silence");

    try {
      for (let i = 0; i < sortedRegions.length; i++) {
        const region = sortedRegions[i];
        const progress = Math.round(((i + 1) / sortedRegions.length) * 100);
        onProgress?.(progress, `Cutting section ${i + 1}/${sortedRegions.length}`);

        const absoluteStart = clipStartTime + region.start;
        const absoluteEnd = clipStartTime + region.end;

        const currentClip = this.findClipContainingTime(absoluteStart, trackId);
        if (!currentClip) {
          continue;
        }

        const clipRelativeEnd = absoluteEnd - currentClip.startTime;

        if (clipRelativeEnd < currentClip.duration) {
          const splitResult = await store.splitClip(
            currentClip.id,
            clipRelativeEnd,
          );
          if (!splitResult.success) {
            continue;
          }
        }

        const clipAfterFirstSplit = this.findClipContainingTime(absoluteStart, trackId);
        if (!clipAfterFirstSplit) {
          continue;
        }

        const newRelativeStart = absoluteStart - clipAfterFirstSplit.startTime;

        if (newRelativeStart > 0) {
          const splitResult = await store.splitClip(
            clipAfterFirstSplit.id,
            newRelativeStart,
          );
          if (!splitResult.success) {
            continue;
          }
        }

        const silentClip = this.findClipInTimeRange(
          absoluteStart,
          absoluteEnd,
          trackId,
        );
        if (silentClip) {
          await store.rippleDeleteClip(silentClip.id);
        }
      }

      onProgress?.(100, "Complete");
      return { success: true };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return { success: false, error: message };
    } finally {
      actionHistory.endGroup();
    }
  }

  /**
   * ── THESE TWO LOOKUPS MUST BE SCOPED TO ONE TRACK ──────────────────────────
   *
   * Both used to walk EVERY track and return the FIRST clip whose time range
   * matched, with no reference to the clip being cut. On a one-track timeline
   * that is the right answer by luck. On any real project it is not: "cut the
   * silence out of this narration" would find whatever clip sits at that moment
   * on the first track — normally the PICTURE — then split it twice and ripple
   * delete the middle, and report success.
   *
   * So the failure was not "nothing happened". It was silently editing a
   * different clip than the one named, destructively, and answering `ok`.
   * Measured on a live editor: a 6.0s speech clip, note "Cut 2 silent gaps,
   * 2.6s of 6.0s", speech clip still 6.03s — the cuts had landed elsewhere.
   *
   * `trackId` is now required. A lookup that cannot be scoped is a bug, not a
   * convenience.
   */
  private findClipContainingTime(time: number, trackId: string) {
    const { project } = useProjectStore.getState();
    const track = project.timeline.tracks.find((t) => t.id === trackId);
    if (!track) return null;
    for (const clip of track.clips) {
      const clipEnd = clip.startTime + clip.duration;
      if (time >= clip.startTime && time < clipEnd) {
        return clip;
      }
    }
    return null;
  }

  private findClipInTimeRange(start: number, end: number, trackId: string) {
    const { project } = useProjectStore.getState();
    const track = project.timeline.tracks.find((t) => t.id === trackId);
    if (!track) return null;
    for (const clip of track.clips) {
      const clipMidpoint = clip.startTime + clip.duration / 2;
      if (clipMidpoint >= start && clipMidpoint < end) {
        return clip;
      }
    }
    return null;
  }

  dispose(): void {
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}

let bridgeInstance: SilenceCutBridge | null = null;

export function getSilenceCutBridge(): SilenceCutBridge {
  if (!bridgeInstance) {
    bridgeInstance = new SilenceCutBridge();
  }
  return bridgeInstance;
}

export function disposeSilenceCutBridge(): void {
  if (bridgeInstance) {
    bridgeInstance.dispose();
    bridgeInstance = null;
  }
}
