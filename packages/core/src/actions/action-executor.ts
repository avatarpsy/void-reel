import type {
  Action,
  ActionResult,
  TimelineAction,
  TrackAction,
  ClipAction,
  EffectAction,
  TransformAction,
  KeyframeAction,
  TransitionAction,
  AudioAction,
  SubtitleAction,
  TextClipAction,
  MediaAction,
  ProjectAction,
} from "../types/actions";
import type {
  Project,
  Track,
  Clip,
  Effect,
  Keyframe,
  EasingType,
  Transition,
  Subtitle,
  SubtitleStyle,
  MediaItem,
  TransitionType,
} from "../types";
import type {
  MutableTimeline,
  MutableTrack,
  MutableClip,
} from "../utils/immutable-updates";
import type { TextClip } from "../text/types";
import type { UpdateTextClipOptions } from "../text/title-engine";
import { ActionValidator } from "./action-validator";
import { ActionHistory } from "./action-history";
import { InverseActionGenerator } from "./inverse-action-generator";

/**
 * Minimal interface the executor needs to apply text/* actions. The
 * editor app's engine-store provides this — keeping it as an
 * interface (rather than importing TitleEngine directly) means core
 * stays decoupled from the engine's runtime instance lifecycle.
 */
export interface TitleEngineAdapter {
  getTextClip(id: string): TextClip | undefined;
  getAllTextClips(): TextClip[];
  loadTextClips(clips: TextClip[]): void;
  // Use TitleEngine's exact UpdateTextClipOptions so the editor's
  // engine instance satisfies this adapter under strict structural
  // typing — function params are contravariant, so a wider declared
  // shape would reject TitleEngine's narrower implementation.
  updateTextClip(
    id: string,
    updates: UpdateTextClipOptions,
  ): TextClip | undefined;
  deleteTextClip(id: string): boolean;
  // Optional. The editor app may wire this to engine.loadTextClips
  // with the existing list + the restored clip if a strict insert
  // path is needed for text/add inverses.
  insertTextClip?(clip: TextClip): void;
}

export interface ActionExecutorOptions {
  /** Lazily resolved so the engine can be (re-)mounted after the
   *  executor is constructed — common in the editor where the engine
   *  initialises after the project store. */
  getTitleEngine?: () => TitleEngineAdapter | null;
}

export class ActionExecutor {
  private validator: ActionValidator;
  private history: ActionHistory;
  private inverseGenerator: InverseActionGenerator;
  private lastAddedIds: Map<string, string> = new Map();
  private getTitleEngine: () => TitleEngineAdapter | null;

  constructor(history?: ActionHistory, options?: ActionExecutorOptions) {
    this.validator = new ActionValidator();
    this.history = history || new ActionHistory();
    this.inverseGenerator = new InverseActionGenerator();
    this.getTitleEngine = options?.getTitleEngine ?? (() => null);
  }

  async execute(action: Action, project: Project): Promise<ActionResult> {
    const validationResult = this.validator.validate(action, project);

    if (!validationResult.valid) {
      return {
        success: false,
        error: {
          code: "INVALID_PARAMS",
          message: validationResult.errors.map((e) => e.message).join("; "),
          details: { errors: validationResult.errors },
        },
      };
    }
    const projectSnapshot = JSON.parse(JSON.stringify(project));
    const inverseAction = this.inverseGenerator.generate(
      action,
      projectSnapshot,
    );
    try {
      await this.applyAction(action as TimelineAction, project);
      this.history.push(action, inverseAction);

      return {
        success: true,
        actionId: action.id,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "INVALID_PARAMS",
          message:
            error instanceof Error ? error.message : "Unknown error occurred",
        },
      };
    }
  }

  async executeMany(
    actions: Action[],
    project: Project,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];

    for (const action of actions) {
      const result = await this.execute(action, project);
      results.push(result);
      if (!result.success) {
        break;
      }
    }

    return results;
  }

  async undo(project: Project): Promise<ActionResult> {
    if (!this.history.canUndo()) {
      return {
        success: false,
        error: {
          code: "INVALID_PARAMS",
          message: "Nothing to undo",
        },
      };
    }

    const inverseActions = this.history.undoGroup();
    if (inverseActions.length === 0) {
      return {
        success: false,
        error: {
          code: "INVALID_PARAMS",
          message: "No inverse action available",
        },
      };
    }

    try {
      for (const inverseAction of inverseActions) {
        const resolvedAction = this.resolveSpecialMarkers(inverseAction);
        await this.applyAction(resolvedAction as TimelineAction, project);
      }
      return { success: true, actionId: inverseActions[0].id };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "INVALID_PARAMS",
          message: error instanceof Error ? error.message : "Undo failed",
        },
      };
    }
  }

  async redo(project: Project): Promise<ActionResult> {
    if (!this.history.canRedo()) {
      return {
        success: false,
        error: {
          code: "INVALID_PARAMS",
          message: "Nothing to redo",
        },
      };
    }

    const actions = this.history.redoGroup();
    if (actions.length === 0) {
      return {
        success: false,
        error: {
          code: "INVALID_PARAMS",
          message: "No action to redo",
        },
      };
    }

    try {
      for (const action of actions) {
        await this.applyAction(action as TimelineAction, project);
      }
      return { success: true, actionId: actions[0].id };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "INVALID_PARAMS",
          message: error instanceof Error ? error.message : "Redo failed",
        },
      };
    }
  }

  getHistory(): ActionHistory {
    return this.history;
  }

  private resolveSpecialMarkers(action: Action): Action {
    const params = { ...action.params } as Record<string, unknown>;

    for (const [key, value] of Object.entries(params)) {
      if (value === "__LAST_ADDED__") {
        const lastId = this.lastAddedIds.get(action.type.split("/")[0]);
        if (lastId) {
          params[key] = lastId;
        }
      }
    }

    return { ...action, params };
  }

  private async applyAction(
    action: TimelineAction,
    project: Project,
  ): Promise<void> {
    const type = action.type;

    // Generic state patch — must be intercepted BEFORE the `clip/` prefix
    // dispatch below (applyClipAction doesn't know this type).
    if (type === "clip/applyState") {
      this.applyClipStateAction(action as import("../types/actions").ClipStateAction, project);
      this.recalculateTimelineDuration(project);
      return;
    }

    if (type.startsWith("project/")) {
      this.applyProjectAction(action as ProjectAction, project);
    } else if (type.startsWith("media/")) {
      await this.applyMediaAction(action as MediaAction, project);
    } else if (type.startsWith("track/")) {
      this.applyTrackAction(action as TrackAction, project);
    } else if (type.startsWith("clip/")) {
      this.applyClipAction(action as ClipAction, project);
    } else if (type.startsWith("effect/")) {
      this.applyEffectAction(action as EffectAction, project);
    } else if (type.startsWith("transform/")) {
      this.applyTransformAction(action as TransformAction, project);
    } else if (type.startsWith("keyframe/")) {
      this.applyKeyframeAction(action as KeyframeAction, project);
    } else if (type.startsWith("transition/")) {
      this.applyTransitionAction(action as TransitionAction, project);
    } else if (type.startsWith("audio/")) {
      this.applyAudioAction(action as AudioAction, project);
    } else if (type.startsWith("subtitle/")) {
      this.applySubtitleAction(action as SubtitleAction, project);
    } else if (type.startsWith("text/")) {
      this.applyTextClipAction(action as TextClipAction, project);
    }

    // Recompute timeline duration from clips after any action that may affect it
    this.recalculateTimelineDuration(project);
  }

  /** Install full clip states (media clips by array replacement; text clips
   *  through the title engine so the render path sees them, mirrored onto
   *  project.textClips which is the load SSOT). Both the action and its
   *  inverse are this same type with before/after swapped, so undo and redo
   *  are symmetric replacements. */
  private applyClipStateAction(
    action: import("../types/actions").ClipStateAction,
    project: Project,
  ): void {
    for (const { clipId, state } of action.params.clips ?? []) {
      for (const track of project.timeline.tracks) {
        const clips = track.clips as unknown as Record<string, unknown>[];
        const idx = clips.findIndex((c) => (c as { id?: string }).id === clipId);
        if (idx >= 0) {
          clips[idx] = state;
          break;
        }
      }
    }
    const textStates = action.params.textClips ?? [];
    if (textStates.length > 0) {
      const engine = this.getTitleEngine();
      for (const { clipId, state } of textStates) {
        if (engine) {
          engine.updateTextClip(clipId, state as never);
        }
        const mirror = (project as unknown as { textClips?: Record<string, unknown>[] }).textClips;
        if (Array.isArray(mirror)) {
          const i = mirror.findIndex((t) => (t as { id?: string })?.id === clipId);
          if (i >= 0) mirror[i] = state;
        }
      }
    }
    (project as unknown as { modifiedAt: number }).modifiedAt = Date.now();
  }

  private recalculateTimelineDuration(project: Project): void {
    let maxEnd = 0;
    for (const track of project.timeline.tracks) {
      for (const clip of track.clips) {
        const end = clip.startTime + clip.duration;
        if (end > maxEnd) maxEnd = end;
      }
    }
    (project.timeline as MutableTimeline).duration = maxEnd;
  }

  private applyProjectAction(action: ProjectAction, project: Project): void {
    switch (action.type) {
      case "project/rename":
        (project as any).name = action.params.name;
        (project as any).modifiedAt = Date.now();
        break;

      case "project/updateSettings":
        (project as any).settings = {
          ...project.settings,
          ...action.params,
        };
        (project as any).modifiedAt = Date.now();
        break;

      case "project/create":
        (project as any).name = action.params.name;
        (project as any).settings = action.params.settings;
        (project as any).modifiedAt = Date.now();
        break;
    }
  }

  private async applyMediaAction(
    action: MediaAction | { type: string; params: Record<string, unknown> },
    project: Project,
  ): Promise<void> {
    const mediaLibrary = project.mediaLibrary as any;

    switch (action.type) {
      case "media/import": {
        const params = action.params as { file: File };
        const newMediaItem = {
          id: `media-${Date.now()}`,
          name: params.file.name,
          type: this.inferMediaType(params.file),
          fileHandle: null,
          blob: params.file,
          metadata: {
            duration: 0,
            width: 0,
            height: 0,
            frameRate: 0,
            codec: "",
            sampleRate: 0,
            channels: 0,
            fileSize: params.file.size,
          },
          thumbnailUrl: null,
          waveformData: null,
        };
        mediaLibrary.items = [...mediaLibrary.items, newMediaItem];
        this.lastAddedIds.set("media", newMediaItem.id);
        break;
      }

      case "media/delete": {
        const params = action.params as { mediaId: string };
        mediaLibrary.items = mediaLibrary.items.filter(
          (item: MediaItem) => item.id !== params.mediaId,
        );
        break;
      }

      case "media/rename": {
        const params = action.params as { mediaId: string; name: string };
        mediaLibrary.items = mediaLibrary.items.map((item: MediaItem) =>
          item.id === params.mediaId ? { ...item, name: params.name } : item,
        );
        break;
      }

      case "media/restore": {
        const params = action.params as { mediaItem: MediaItem };
        mediaLibrary.items = [...mediaLibrary.items, params.mediaItem];
        break;
      }
    }
  }

  private inferMediaType(file: File): "video" | "audio" | "image" {
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("audio/")) return "audio";
    if (file.type.startsWith("image/")) return "image";
    return "video";
  }

  private applyTrackAction(
    action: TrackAction | { type: string; params: Record<string, unknown> },
    project: Project,
  ): void {
    const timeline = project.timeline as MutableTimeline;

    switch (action.type) {
      case "track/add": {
        const params = action.params as {
          trackType: string;
          position?: number;
          trackId?: string;
        };
        const trackNames: Record<string, string> = {
          video: "Video",
          audio: "Audio",
          image: "Image",
          text: "Text",
          graphics: "Graphics",
        };
        const trackCount =
          timeline.tracks.filter(
            (t: MutableTrack) => t.type === params.trackType,
          ).length + 1;
        const newTrack: MutableTrack = {
          id: params.trackId ?? `track-${Date.now()}`,
          type: params.trackType as Track["type"],
          name: `${trackNames[params.trackType] || params.trackType} ${trackCount}`,
          clips: [],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        };

        const position =
          params.position !== undefined
            ? params.position
            : timeline.tracks.length;

        timeline.tracks = [
          ...timeline.tracks.slice(0, position),
          newTrack,
          ...timeline.tracks.slice(position),
        ];
        this.lastAddedIds.set("track", newTrack.id);
        break;
      }

      case "track/remove": {
        const params = action.params as { trackId: string };
        timeline.tracks = timeline.tracks.filter(
          (t: MutableTrack) => t.id !== params.trackId,
        );
        break;
      }

      case "track/restore": {
        const params = action.params as { track: Track; position: number };
        timeline.tracks = [
          ...timeline.tracks.slice(0, params.position),
          params.track,
          ...timeline.tracks.slice(params.position),
        ];
        break;
      }

      case "track/reorder": {
        const params = action.params as {
          trackId: string;
          newPosition: number;
        };
        const trackIndex = timeline.tracks.findIndex(
          (t: MutableTrack) => t.id === params.trackId,
        );
        if (trackIndex !== -1) {
          const [track] = timeline.tracks.splice(trackIndex, 1);
          timeline.tracks.splice(params.newPosition, 0, track);
        }
        break;
      }

      case "track/lock": {
        const params = action.params as { trackId: string; locked: boolean };
        timeline.tracks = timeline.tracks.map((t: MutableTrack) =>
          t.id === params.trackId ? { ...t, locked: params.locked } : t,
        );
        break;
      }

      case "track/hide": {
        const params = action.params as { trackId: string; hidden: boolean };
        timeline.tracks = timeline.tracks.map((t: MutableTrack) =>
          t.id === params.trackId ? { ...t, hidden: params.hidden } : t,
        );
        break;
      }

      case "track/mute": {
        const params = action.params as { trackId: string; muted: boolean };
        timeline.tracks = timeline.tracks.map((t: MutableTrack) =>
          t.id === params.trackId ? { ...t, muted: params.muted } : t,
        );
        break;
      }

      case "track/solo": {
        const params = action.params as { trackId: string; solo: boolean };
        timeline.tracks = timeline.tracks.map((t: MutableTrack) =>
          t.id === params.trackId ? { ...t, solo: params.solo } : t,
        );
        break;
      }
    }
  }

  private applyClipAction(
    action: ClipAction | { type: string; params: Record<string, unknown> },
    project: Project,
  ): void {
    const timeline = project.timeline as MutableTimeline;

    switch (action.type) {
      case "clip/add": {
        const params = action.params as {
          trackId: string;
          mediaId: string;
          startTime: number;
          duration?: number;
          audioTrackIndex?: number;
        };
        const track = timeline.tracks.find(
          (t: MutableTrack) => t.id === params.trackId,
        );
        if (track) {
          const mediaItem = project.mediaLibrary.items.find(
            (item) => item.id === params.mediaId,
          );
          // Use provided duration, or fall back to media duration (if > 0), or default to 5
          // Images and graphics have duration: 0, so we use the 5-second default for them
          const clipDuration =
            params.duration ??
            (mediaItem?.metadata.duration && mediaItem.metadata.duration > 0
              ? mediaItem.metadata.duration
              : 5);
          const newClip = {
            id: `clip-${Date.now()}`,
            mediaId: params.mediaId,
            trackId: params.trackId,
            startTime: params.startTime,
            duration: clipDuration,
            inPoint: 0,
            outPoint: clipDuration,
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
            ...(params.audioTrackIndex !== undefined
              ? { audioTrackIndex: params.audioTrackIndex }
              : {}),
          };
          track.clips = [...track.clips, newClip];
          this.lastAddedIds.set("clip", newClip.id);
        }
        break;
      }

      case "clip/remove": {
        const params = action.params as { clipId: string };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.filter((c: MutableClip) => c.id !== params.clipId),
        }));
        break;
      }

      case "clip/restore": {
        const params = action.params as { clip: Clip };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) =>
          track.id === params.clip.trackId
            ? { ...track, clips: [...track.clips, params.clip] }
            : track,
        );
        break;
      }

      case "clip/move": {
        const params = action.params as {
          clipId: string;
          startTime: number;
          trackId?: string;
        };
        const clip = this.findClip(timeline, params.clipId);
        if (clip) {
          timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
            ...track,
            clips: track.clips.filter(
              (c: MutableClip) => c.id !== params.clipId,
            ),
          }));
          const targetTrackId = params.trackId || clip.trackId;
          timeline.tracks = timeline.tracks.map((track: MutableTrack) =>
            track.id === targetTrackId
              ? {
                  ...track,
                  clips: [
                    ...track.clips,
                    {
                      ...clip,
                      startTime: params.startTime,
                      trackId: targetTrackId,
                    },
                  ],
                }
              : track,
          );
        }
        break;
      }

      case "clip/trim": {
        const params = action.params as {
          clipId: string;
          inPoint?: number;
          outPoint?: number;
        };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.map((clip: MutableClip) => {
            if (clip.id === params.clipId) {
              const updates: Partial<MutableClip> = {};
              if (params.inPoint !== undefined) {
                updates.inPoint = params.inPoint;
                updates.duration = clip.outPoint - params.inPoint;
              }
              if (params.outPoint !== undefined) {
                updates.outPoint = params.outPoint;
                updates.duration = params.outPoint - clip.inPoint;
              }
              return { ...clip, ...updates };
            }
            return clip;
          }),
        }));
        break;
      }

      case "clip/split": {
        const params = action.params as { clipId: string; time: number };
        const clip = this.findClip(timeline, params.clipId);
        if (clip) {
          const splitTime = params.time;
          const splitOffset = splitTime - clip.startTime;

          const clip1 = {
            ...clip,
            duration: splitOffset,
            outPoint: clip.inPoint + splitOffset,
          };

          const clip2 = {
            ...clip,
            id: `clip-${Date.now()}`,
            startTime: splitTime,
            duration: clip.duration - splitOffset,
            inPoint: clip.inPoint + splitOffset,
          };

          timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
            ...track,
            clips: track.clips.flatMap((c: MutableClip) =>
              c.id === params.clipId ? [clip1, clip2] : [c],
            ),
          }));

          this.lastAddedIds.set("clip", clip2.id);
        }
        break;
      }

      case "clip/merge": {
        const params = action.params as { clipId: string; originalClip: Clip };
        const origStart = params.originalClip.startTime;
        const origEnd = origStart + params.originalClip.duration;
        const origMediaId = params.originalClip.mediaId;
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => {
          if (track.id === params.originalClip.trackId) {
            const filteredClips = track.clips.filter((c: MutableClip) => {
              if (c.id === params.clipId) return false;
              if (c.mediaId === origMediaId) {
                const clipEnd = c.startTime + c.duration;
                if (c.startTime >= origStart && clipEnd <= origEnd) {
                  return false;
                }
              }
              return true;
            });
            return { ...track, clips: [...filteredClips, params.originalClip] };
          }
          return track;
        });
        break;
      }

      case "clip/rippleDelete": {
        const params = action.params as { clipId: string };
        const clip = this.findClip(timeline, params.clipId);
        if (clip) {
          const deletedDuration = clip.duration;
          const deletedStartTime = clip.startTime;

          timeline.tracks = timeline.tracks.map((track: MutableTrack) => {
            if (track.id === clip.trackId) {
              return {
                ...track,
                clips: track.clips
                  .filter((c: MutableClip) => c.id !== params.clipId)
                  .map((c: MutableClip) =>
                    c.startTime > deletedStartTime
                      ? { ...c, startTime: c.startTime - deletedDuration }
                      : c,
                  ),
              };
            }
            return track;
          });
        }
        break;
      }

      case "clip/rippleRestore": {
        const params = action.params as {
          clip: Clip;
          affectedClips: Array<{ id: string; originalStartTime: number }>;
        };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => {
          if (track.id === params.clip.trackId) {
            const restoredClips = track.clips.map((c: MutableClip) => {
              const affected = params.affectedClips.find(
                (ac) => ac.id === c.id,
              );
              return affected
                ? { ...c, startTime: affected.originalStartTime }
                : c;
            });
            return { ...track, clips: [...restoredClips, params.clip] };
          }
          return track;
        });
        break;
      }

      case "clip/slip": {
        const params = action.params as {
          clipId: string;
          delta: number;
        };
        const clip = this.findClip(timeline, params.clipId);
        if (clip) {
          const newInPoint = Math.max(0, clip.inPoint + params.delta);
          const newOutPoint = newInPoint + clip.duration;
          timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
            ...track,
            clips: track.clips.map((c: MutableClip) =>
              c.id === params.clipId
                ? { ...c, inPoint: newInPoint, outPoint: newOutPoint }
                : c,
            ),
          }));
        }
        break;
      }

      case "clip/slide": {
        const params = action.params as {
          clipId: string;
          delta: number;
          prevClipId?: string;
          nextClipId?: string;
        };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.map((c: MutableClip) => {
            if (c.id === params.clipId) {
              return {
                ...c,
                startTime: Math.max(0, c.startTime + params.delta),
              };
            }
            if (c.id === params.prevClipId && params.delta > 0) {
              return { ...c, duration: c.duration + params.delta };
            }
            if (c.id === params.nextClipId && params.delta < 0) {
              return {
                ...c,
                startTime: c.startTime + params.delta,
                inPoint: c.inPoint - params.delta,
                duration: c.duration - params.delta,
              };
            }
            return c;
          }),
        }));
        break;
      }

      case "clip/roll": {
        const params = action.params as {
          leftClipId: string;
          rightClipId: string;
          delta: number;
        };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.map((c: MutableClip) => {
            if (c.id === params.leftClipId) {
              return {
                ...c,
                duration: c.duration + params.delta,
                outPoint: c.outPoint + params.delta,
              };
            }
            if (c.id === params.rightClipId) {
              return {
                ...c,
                startTime: c.startTime + params.delta,
                inPoint: c.inPoint + params.delta,
                duration: c.duration - params.delta,
              };
            }
            return c;
          }),
        }));
        break;
      }

      case "clip/trimToPlayhead": {
        const params = action.params as {
          clipId: string;
          playheadTime: number;
          trimStart: boolean;
        };
        const clip = this.findClip(timeline, params.clipId);
        if (clip) {
          timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
            ...track,
            clips: track.clips.map((c: MutableClip) => {
              if (c.id !== params.clipId) return c;
              if (params.trimStart) {
                const delta = params.playheadTime - c.startTime;
                return {
                  ...c,
                  startTime: params.playheadTime,
                  inPoint: c.inPoint + delta,
                  duration: c.duration - delta,
                };
              } else {
                return {
                  ...c,
                  duration: params.playheadTime - c.startTime,
                  outPoint: c.inPoint + (params.playheadTime - c.startTime),
                };
              }
            }),
          }));
        }
        break;
      }
    }
  }

  private applyEffectAction(
    action: EffectAction | { type: string; params: Record<string, unknown> },
    project: Project,
  ): void {
    const timeline = project.timeline as MutableTimeline;

    switch (action.type) {
      case "effect/add": {
        const params = action.params as {
          clipId: string;
          effectType: string;
          params?: Record<string, unknown>;
        };
        const newEffect = {
          id: `effect-${Date.now()}`,
          type: params.effectType,
          params: params.params || {},
          enabled: true,
        };

        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.map((clip: MutableClip) =>
            clip.id === params.clipId
              ? { ...clip, effects: [...clip.effects, newEffect] }
              : clip,
          ),
        }));
        this.lastAddedIds.set("effect", newEffect.id);
        break;
      }

      case "effect/remove": {
        const params = action.params as { clipId: string; effectId: string };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.map((clip: MutableClip) =>
            clip.id === params.clipId
              ? {
                  ...clip,
                  effects: clip.effects.filter(
                    (e: Effect) => e.id !== params.effectId,
                  ),
                }
              : clip,
          ),
        }));
        break;
      }

      case "effect/restore": {
        const params = action.params as {
          clipId: string;
          effect: Effect;
          index: number;
        };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.map((clip: MutableClip) => {
            if (clip.id === params.clipId) {
              const effects = [...clip.effects];
              effects.splice(params.index, 0, params.effect);
              return { ...clip, effects };
            }
            return clip;
          }),
        }));
        break;
      }

      case "effect/update": {
        const params = action.params as {
          clipId: string;
          effectId: string;
          params: Record<string, unknown>;
        };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.map((clip: MutableClip) =>
            clip.id === params.clipId
              ? {
                  ...clip,
                  effects: clip.effects.map((e: Effect) =>
                    e.id === params.effectId
                      ? { ...e, params: { ...e.params, ...params.params } }
                      : e,
                  ),
                }
              : clip,
          ),
        }));
        break;
      }

      case "effect/reorder": {
        const params = action.params as {
          clipId: string;
          effectId: string;
          newIndex: number;
        };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.map((clip: MutableClip) => {
            if (clip.id === params.clipId) {
              const effects = [...clip.effects];
              const effectIndex = effects.findIndex(
                (e: Effect) => e.id === params.effectId,
              );
              if (effectIndex !== -1) {
                const [effect] = effects.splice(effectIndex, 1);
                effects.splice(params.newIndex, 0, effect);
              }
              return { ...clip, effects };
            }
            return clip;
          }),
        }));
        break;
      }
    }
  }

  private applyTransformAction(
    action: TransformAction,
    project: Project,
  ): void {
    const timeline = project.timeline as MutableTimeline;

    timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
      ...track,
      clips: track.clips.map((clip: MutableClip) =>
        clip.id === action.params.clipId
          ? {
              ...clip,
              transform: { ...clip.transform, ...action.params.transform },
            }
          : clip,
      ),
    }));
  }

  private applyKeyframeAction(
    action: KeyframeAction | { type: string; params: Record<string, unknown> },
    project: Project,
  ): void {
    const timeline = project.timeline as MutableTimeline;

    switch (action.type) {
      case "keyframe/add": {
        const params = action.params as {
          clipId: string;
          time: number;
          property: string;
          value: unknown;
        };
        // Same id-collision lesson as transition/add: a wrapper that adds
        // many keyframes in a tight loop (e.g. fade-in/out across N clips =
        // 4*N keyframes/ms) needs jitter or every keyframe in the same
        // millisecond shares an id and the keyframe-engine reads back the
        // wrong value.
        const newKeyframe = {
          id: `keyframe-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 11)}`,
          time: params.time,
          property: params.property,
          value: params.value,
          easing: "linear" as const,
        };

        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.map((clip: MutableClip) =>
            clip.id === params.clipId
              ? { ...clip, keyframes: [...clip.keyframes, newKeyframe] }
              : clip,
          ),
        }));
        this.lastAddedIds.set("keyframe", newKeyframe.id);
        break;
      }

      case "keyframe/remove": {
        const params = action.params as {
          clipId: string;
          property: string;
          time: number;
        };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.map((clip: MutableClip) =>
            clip.id === params.clipId
              ? {
                  ...clip,
                  keyframes: clip.keyframes.filter(
                    (kf: Keyframe) =>
                      !(
                        kf.property === params.property &&
                        kf.time === params.time
                      ),
                  ),
                }
              : clip,
          ),
        }));
        break;
      }

      case "keyframe/update": {
        const params = action.params as {
          clipId: string;
          property: string;
          time: number;
          value?: unknown;
          easing?: EasingType;
        };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.map((clip: MutableClip) =>
            clip.id === params.clipId
              ? {
                  ...clip,
                  keyframes: clip.keyframes.map((kf: Keyframe) =>
                    kf.property === params.property && kf.time === params.time
                      ? {
                          ...kf,
                          ...(params.value !== undefined && {
                            value: params.value,
                          }),
                          ...(params.easing !== undefined && {
                            easing: params.easing,
                          }),
                        }
                      : kf,
                  ),
                }
              : clip,
          ),
        }));
        break;
      }
    }
  }

  private applyTransitionAction(
    action:
      | TransitionAction
      | { type: string; params: Record<string, unknown> },
    project: Project,
  ): void {
    const timeline = project.timeline as MutableTimeline;

    switch (action.type) {
      case "transition/add": {
        const params = action.params as {
          clipAId: string;
          clipBId: string;
          transitionType: TransitionType;
          duration: number;
        };
        const clipA = this.findClip(timeline, params.clipAId);
        if (clipA) {
          const track = timeline.tracks.find(
            (t: MutableTrack) => t.id === clipA.trackId,
          );
          if (track) {
            // ID must include random jitter. Without it, a tight loop of
            // transition/add actions (e.g. agent applying transitions to N
            // adjacent clip pairs in <1ms) all land in the same Date.now()
            // tick and collide on id. Duplicate ids corrupt the bridge's
            // Map<id, transition> on register, and the renderer then draws
            // a broken/black frame for the entire video while still setting
            // hasRenderedFrame=true (so the fallback clip render never
            // runs) — i.e. the whole preview goes black until the dupes are
            // stripped from the saved blob.
            const newTransition: Transition = {
              id: `transition-${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 11)}`,
              clipAId: params.clipAId,
              clipBId: params.clipBId,
              type: params.transitionType,
              duration: params.duration,
              params: {},
            };
            track.transitions = [...(track.transitions || []), newTransition];
            this.lastAddedIds.set("transition", newTransition.id);
          }
        }
        break;
      }

      case "transition/remove": {
        const params = action.params as { transitionId: string };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          transitions: (track.transitions || []).filter(
            (t: Transition) => t.id !== params.transitionId,
          ),
        }));
        break;
      }

      case "transition/restore": {
        const params = action.params as { transition: Transition };
        const clipA = this.findClip(timeline, params.transition.clipAId);
        if (clipA) {
          timeline.tracks = timeline.tracks.map((track: MutableTrack) =>
            track.id === clipA.trackId
              ? {
                  ...track,
                  transitions: [
                    ...(track.transitions || []),
                    params.transition,
                  ],
                }
              : track,
          );
        }
        break;
      }

      case "transition/update": {
        const params = action.params as {
          transitionId: string;
          duration?: number;
          params?: Record<string, unknown>;
        };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          transitions: (track.transitions || []).map((t: Transition) =>
            t.id === params.transitionId
              ? {
                  ...t,
                  ...(params.duration !== undefined && {
                    duration: params.duration,
                  }),
                  ...(params.params !== undefined && {
                    params: { ...t.params, ...params.params },
                  }),
                }
              : t,
          ),
        }));
        break;
      }
    }
  }

  private applyAudioAction(
    action: AudioAction | { type: string; params: Record<string, unknown> },
    project: Project,
  ): void {
    const timeline = project.timeline as MutableTimeline;

    switch (action.type) {
      case "audio/setVolume": {
        const params = action.params as { clipId: string; volume: number };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.map((clip: MutableClip) =>
            clip.id === params.clipId
              ? { ...clip, volume: params.volume }
              : clip,
          ),
        }));
        break;
      }

      case "audio/setMuted": {
        const params = action.params as { clipId: string; muted: boolean };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.map((clip: MutableClip) =>
            clip.id === params.clipId
              ? { ...clip, muted: params.muted }
              : clip,
          ),
        }));
        break;
      }

      case "audio/setFade": {
        const params = action.params as {
          clipId: string;
          fadeIn?: number;
          fadeOut?: number;
        };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.map((clip: MutableClip) =>
            clip.id === params.clipId
              ? {
                  ...clip,
                  fade: {
                    fadeIn:
                      params.fadeIn !== undefined
                        ? params.fadeIn
                        : clip.fade?.fadeIn || 0,
                    fadeOut:
                      params.fadeOut !== undefined
                        ? params.fadeOut
                        : clip.fade?.fadeOut || 0,
                  },
                }
              : clip,
          ),
        }));
        break;
      }

      case "audio/addAutomation": {
        const params = action.params as {
          clipId: string;
          points: Array<{ time: number; value: number }>;
        };
        timeline.tracks = timeline.tracks.map((track: MutableTrack) => ({
          ...track,
          clips: track.clips.map((clip: MutableClip) =>
            clip.id === params.clipId
              ? {
                  ...clip,
                  automation: {
                    ...clip.automation,
                    volume: params.points,
                  },
                }
              : clip,
          ),
        }));
        break;
      }
    }
  }

  private applySubtitleAction(
    action: SubtitleAction | { type: string; params: Record<string, unknown> },
    project: Project,
  ): void {
    const timeline = project.timeline as MutableTimeline;

    switch (action.type) {
      case "subtitle/add": {
        const params = action.params as {
          text: string;
          startTime: number;
          endTime: number;
        };
        const newSubtitle = {
          id: `subtitle-${Date.now()}`,
          text: params.text,
          startTime: params.startTime,
          endTime: params.endTime,
        };
        timeline.subtitles = [...(timeline.subtitles || []), newSubtitle];
        this.lastAddedIds.set("subtitle", newSubtitle.id);
        break;
      }

      case "subtitle/remove": {
        const params = action.params as { subtitleId: string };
        timeline.subtitles = (timeline.subtitles || []).filter(
          (s: Subtitle) => s.id !== params.subtitleId,
        );
        break;
      }

      case "subtitle/restore": {
        const params = action.params as { subtitle: Subtitle };
        timeline.subtitles = [...(timeline.subtitles || []), params.subtitle];
        break;
      }

      case "subtitle/restoreAll": {
        const params = action.params as { subtitles: Subtitle[] };
        timeline.subtitles = params.subtitles;
        break;
      }

      case "subtitle/update": {
        const params = action.params as {
          subtitleId: string;
          text?: string;
          startTime?: number;
          endTime?: number;
        };
        timeline.subtitles = (timeline.subtitles || []).map((s: Subtitle) =>
          s.id === params.subtitleId
            ? {
                ...s,
                ...(params.text !== undefined && { text: params.text }),
                ...(params.startTime !== undefined && {
                  startTime: params.startTime,
                }),
                ...(params.endTime !== undefined && {
                  endTime: params.endTime,
                }),
              }
            : s,
        );
        break;
      }

      case "subtitle/setStyle": {
        const params = action.params as { style: SubtitleStyle };
        timeline.subtitles = (timeline.subtitles || []).map((s: Subtitle) => ({
          ...s,
          style: params.style,
        }));
        break;
      }

      case "subtitle/import": {
        const params = action.params as { srtContent: string };
        const srtRegex =
          /(\d+)\n(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\n([\s\S]*?)(?=\n\n|\n*$)/g;
        let match;
        const newSubtitles = [];

        while ((match = srtRegex.exec(params.srtContent)) !== null) {
          const startTime = this.parseSrtTime(match[2]);
          const endTime = this.parseSrtTime(match[3]);
          const text = match[4].trim();

          newSubtitles.push({
            id: `subtitle-${Date.now()}-${match[1]}`,
            text,
            startTime,
            endTime,
          });
        }

        if (newSubtitles.length > 0) {
          timeline.subtitles = [...(timeline.subtitles || []), ...newSubtitles];
        }
        break;
      }
    }
  }

  /**
   * Apply text-clip (caption / title) actions through the live
   * TitleEngine. The engine owns the canonical Map<id, TextClip>
   * — we mirror the change into project.textClips so saves carry
   * the latest state, but the engine instance is the source of
   * truth for renderers.
   *
   * Inverse: relies on `previous` being captured by the project-
   * store wrapper before calling execute() (see InverseActionGenerator
   * `text/*` cases). Without `previous` text/update has no
   * symmetric undo and the InverseActionGenerator returns null —
   * which means undo() will treat the entry as no-op.
   */
  private applyTextClipAction(action: TextClipAction, project: Project): void {
    const engine = this.getTitleEngine();
    if (!engine) {
      // No engine wired — silently no-op. The validator already
      // rejected the action when an engine was required, so we only
      // hit this in test environments / headless renders.
      return;
    }
    const type = action.type;
    // Project.textClips is `readonly` at the type level but mutated
    // in-place across the executor (same pattern as MutableTimeline).
    const mProject = project as unknown as { textClips?: TextClip[] };
    if (type === "text/add") {
      const params = action.params;
      if (engine.insertTextClip) {
        engine.insertTextClip(params.textClip);
      } else {
        engine.loadTextClips([...engine.getAllTextClips(), params.textClip]);
      }
      mProject.textClips = [
        ...(mProject.textClips ?? []).filter((c) => c.id !== params.textClip.id),
        params.textClip,
      ];
      this.lastAddedIds.set("text", params.textClip.id);
    } else if (type === "text/remove") {
      const params = action.params;
      engine.deleteTextClip(params.clipId);
      mProject.textClips = (mProject.textClips ?? []).filter(
        (c) => c.id !== params.clipId,
      );
    } else if (type === "text/update") {
      const params = action.params;
      const updated = engine.updateTextClip(
        params.clipId,
        params.updates as UpdateTextClipOptions,
      );
      if (updated) {
        mProject.textClips = (mProject.textClips ?? []).map((c) =>
          c.id === params.clipId ? updated : c,
        );
      }
    }
  }

  private parseSrtTime(timeString: string): number {
    const [time, ms] = timeString.split(",");
    const [hours, minutes, seconds] = time.split(":").map(Number);
    return hours * 3600 + minutes * 60 + seconds + Number(ms) / 1000;
  }

  private findClip(
    timeline: MutableTimeline,
    clipId: string,
  ): MutableClip | null {
    for (const track of timeline.tracks) {
      const clip = track.clips.find((c: MutableClip) => c.id === clipId);
      if (clip) return clip;
    }
    return null;
  }
}
