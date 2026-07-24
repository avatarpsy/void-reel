import type {
  Action,
  TimelineAction,
  TrackAction,
  ClipAction,
  EffectAction,
  TransformAction,
  KeyframeAction,
  TransitionAction,
  AudioAction,
  SubtitleAction,
  MediaAction,
  ProjectAction,
} from "../types/actions";
import type { Project, MediaItem } from "../types/project";
import type { Track, Clip, Transition } from "../types/timeline";

export class InverseActionGenerator {
  generate(action: Action, projectBefore: Project): Action | null {
    const type = (action as TimelineAction).type;

    if (type.startsWith("project/")) {
      return this.generateProjectInverse(
        action as ProjectAction & Action,
        projectBefore,
      );
    } else if (type.startsWith("media/")) {
      return this.generateMediaInverse(
        action as MediaAction & Action,
        projectBefore,
      );
    } else if (type.startsWith("track/")) {
      return this.generateTrackInverse(
        action as TrackAction & Action,
        projectBefore,
      );
    } else if (type.startsWith("clip/")) {
      return this.generateClipInverse(
        action as ClipAction & Action,
        projectBefore,
      );
    } else if (type.startsWith("effect/")) {
      return this.generateEffectInverse(
        action as EffectAction & Action,
        projectBefore,
      );
    } else if (type.startsWith("transform/")) {
      return this.generateTransformInverse(
        action as TransformAction & Action,
        projectBefore,
      );
    } else if (type.startsWith("keyframe/")) {
      return this.generateKeyframeInverse(
        action as KeyframeAction & Action,
        projectBefore,
      );
    } else if (type.startsWith("transition/")) {
      return this.generateTransitionInverse(
        action as TransitionAction & Action,
        projectBefore,
      );
    } else if (type.startsWith("audio/")) {
      return this.generateAudioInverse(
        action as AudioAction & Action,
        projectBefore,
      );
    } else if (type.startsWith("subtitle/")) {
      return this.generateSubtitleInverse(
        action as SubtitleAction & Action,
        projectBefore,
      );
    } else if (type.startsWith("text/")) {
      return this.generateTextClipInverse(action as Action);
    }

    return null;
  }

  /**
   * Inverse for text/* actions.
   *
   *   text/add     → text/remove(clipId)
   *   text/remove  → text/add(textClip)  (relies on `previous` payload)
   *   text/update  → text/update(clipId, updates: previous)
   *
   * For update + remove the project-store wrapper MUST capture the
   * pre-mutation state into `params.previous` (or `params.previous`
   * for remove) before calling execute() — the engine's Map can't be
   * round-tripped from a JSON project snapshot. Without `previous`
   * we return null, which makes ActionHistory treat the entry as a
   * non-undoable leaf.
   */
  private generateTextClipInverse(action: Action): Action | null {
    const type = action.type;
    if (type === "text/add") {
      const params = action.params as { textClip: { id: string } };
      return this.createInverseAction(action, "text/remove", {
        clipId: params.textClip.id,
      });
    }
    if (type === "text/remove") {
      const params = action.params as { clipId: string; previous?: unknown };
      if (!params.previous) return null;
      return this.createInverseAction(action, "text/add", {
        textClip: params.previous,
      });
    }
    if (type === "text/update") {
      const params = action.params as {
        clipId: string;
        updates: Record<string, unknown>;
        previous?: Record<string, unknown>;
      };
      if (!params.previous) return null;
      return this.createInverseAction(action, "text/update", {
        clipId: params.clipId,
        updates: params.previous,
      });
    }
    return null;
  }

  private createInverseAction(
    originalAction: Action,
    type: string,
    params: Record<string, unknown>,
  ): Action {
    return {
      type,
      id: `inverse-${originalAction.id}`,
      timestamp: Date.now(),
      params,
    };
  }

  private generateProjectInverse(
    action: ProjectAction & Action,
    projectBefore: Project,
  ): Action | null {
    switch (action.type) {
      case "project/rename":
        return this.createInverseAction(action, "project/rename", {
          name: projectBefore.name,
        });

      case "project/updateSettings":
        return this.createInverseAction(action, "project/updateSettings", {
          ...projectBefore.settings,
        });

      case "project/create":
        // Cannot undo project creation in a meaningful way
        return null;
    }
  }

  private generateMediaInverse(
    action: MediaAction & Action,
    projectBefore: Project,
  ): Action | null {
    switch (action.type) {
      case "media/import":
        // To undo import, we need to delete the media that was added
        return this.createInverseAction(action, "media/delete", {
          mediaId: "__LAST_IMPORTED__", // Special marker to be resolved
        });

      case "media/delete": {
        const deletedMedia = projectBefore.mediaLibrary.items.find(
          (item) => item.id === action.params.mediaId,
        );
        if (!deletedMedia) return null;
        return this.createInverseAction(action, "media/restore", {
          mediaItem: this.cloneMediaItem(deletedMedia),
        });
      }

      case "media/rename": {
        const media = projectBefore.mediaLibrary.items.find(
          (item) => item.id === action.params.mediaId,
        );
        if (!media) return null;

        return this.createInverseAction(action, "media/rename", {
          mediaId: action.params.mediaId,
          name: media.name,
        });
      }
    }
  }

  private generateTrackInverse(
    action: TrackAction & Action,
    projectBefore: Project,
  ): Action | null {
    const timeline = projectBefore.timeline;

    switch (action.type) {
      case "track/add":
        // To undo add, we need to remove the track that was added
        return this.createInverseAction(action, "track/remove", {
          trackId: "__LAST_ADDED__", // Special marker to be resolved
        });

      case "track/remove": {
        const removedTrack = timeline.tracks.find(
          (t) => t.id === action.params.trackId,
        );
        if (!removedTrack) return null;

        const position = timeline.tracks.findIndex(
          (t) => t.id === action.params.trackId,
        );

        return this.createInverseAction(action, "track/restore", {
          track: this.cloneTrack(removedTrack),
          position,
        });
      }

      case "track/reorder": {
        const currentPosition = timeline.tracks.findIndex(
          (t) => t.id === action.params.trackId,
        );
        if (currentPosition === -1) return null;

        return this.createInverseAction(action, "track/reorder", {
          trackId: action.params.trackId,
          newPosition: currentPosition,
        });
      }

      case "track/lock": {
        const track = timeline.tracks.find(
          (t) => t.id === action.params.trackId,
        );
        if (!track) return null;

        return this.createInverseAction(action, "track/lock", {
          trackId: action.params.trackId,
          locked: track.locked,
        });
      }

      case "track/hide": {
        const track = timeline.tracks.find(
          (t) => t.id === action.params.trackId,
        );
        if (!track) return null;

        return this.createInverseAction(action, "track/hide", {
          trackId: action.params.trackId,
          hidden: track.hidden,
        });
      }

      case "track/mute": {
        const track = timeline.tracks.find(
          (t) => t.id === action.params.trackId,
        );
        if (!track) return null;

        return this.createInverseAction(action, "track/mute", {
          trackId: action.params.trackId,
          muted: track.muted,
        });
      }

      case "track/solo": {
        const track = timeline.tracks.find(
          (t) => t.id === action.params.trackId,
        );
        if (!track) return null;

        return this.createInverseAction(action, "track/solo", {
          trackId: action.params.trackId,
          solo: track.solo,
        });
      }
    }
  }

  private generateClipInverse(
    action: ClipAction & Action,
    projectBefore: Project,
  ): Action | null {
    const timeline = projectBefore.timeline;

    // FOUNDATION FIX (F11): clip/slip, clip/slide, clip/roll and
    // clip/trimToPlayhead have apply handlers in the executor but were NOT in
    // the ClipAction union nor this switch — so generate() returned null and
    // the op was silently NON-UNDOABLE (a broken Ctrl+Z on any advanced trim).
    // Capture the full prior state of every clip the op can touch and restore
    // it via clip/applyState (robust to the executor's clamps, which a naive
    // inverse-delta would not reverse). Redo replays the forward op.
    const ADVANCED_TRIM = new Set([
      "clip/slip",
      "clip/slide",
      "clip/roll",
      "clip/trimToPlayhead",
    ]);
    if (ADVANCED_TRIM.has((action as { type: string }).type)) {
      const p = action.params as Record<string, unknown>;
      const affectedIds = [
        "clipId",
        "prevClipId",
        "nextClipId",
        "leftClipId",
        "rightClipId",
      ]
        .map((k) => p[k])
        .filter((v): v is string => typeof v === "string");
      const clips = affectedIds
        .map((id) => this.findClip(timeline, id))
        .filter((c): c is Clip => c !== null)
        .map((c) => ({ clipId: c.id, state: this.cloneClip(c) }));
      if (clips.length === 0) return null;
      return this.createInverseAction(action, "clip/applyState", {
        label: "Undo trim",
        clips,
      });
    }

    switch (action.type) {
      case "clip/add":
        return this.createInverseAction(action, "clip/remove", {
          clipId: "__LAST_ADDED__",
        });

      case "clip/remove": {
        const clip = this.findClip(timeline, action.params.clipId);
        if (!clip) return null;

        return this.createInverseAction(action, "clip/restore", {
          clip: this.cloneClip(clip),
        });
      }

      case "clip/move": {
        const clip = this.findClip(timeline, action.params.clipId);
        if (!clip) return null;

        return this.createInverseAction(action, "clip/move", {
          clipId: action.params.clipId,
          startTime: clip.startTime,
          trackId: clip.trackId,
        });
      }

      case "clip/trim": {
        const clip = this.findClip(timeline, action.params.clipId);
        if (!clip) return null;

        return this.createInverseAction(action, "clip/trim", {
          clipId: action.params.clipId,
          inPoint: clip.inPoint,
          outPoint: clip.outPoint,
          // Left-edge trims move the clip — restore its position on undo.
          startTime: clip.startTime,
        });
      }

      case "clip/split": {
        // To undo split, we need to merge the two clips back
        const clip = this.findClip(timeline, action.params.clipId);
        if (!clip) return null;

        return this.createInverseAction(action, "clip/merge", {
          clipId: action.params.clipId,
          originalClip: this.cloneClip(clip),
        });
      }

      case "clip/rippleDelete": {
        const clip = this.findClip(timeline, action.params.clipId);
        if (!clip) return null;
        const track = timeline.tracks.find((t) => t.id === clip.trackId);
        const affectedClips =
          track?.clips
            .filter((c) => c.startTime > clip.startTime)
            .map((c) => ({ id: c.id, originalStartTime: c.startTime })) || [];

        return this.createInverseAction(action, "clip/rippleRestore", {
          clip: this.cloneClip(clip),
          affectedClips,
        });
      }
    }
  }

  private generateEffectInverse(
    action: EffectAction & Action,
    projectBefore: Project,
  ): Action | null {
    const timeline = projectBefore.timeline;
    const clip = this.findClip(timeline, action.params.clipId);
    if (!clip) return null;

    switch (action.type) {
      case "effect/add":
        return this.createInverseAction(action, "effect/remove", {
          clipId: action.params.clipId,
          effectId: "__LAST_ADDED__",
        });

      case "effect/remove": {
        const effect = clip.effects.find(
          (e) => e.id === action.params.effectId,
        );
        if (!effect) return null;

        const index = clip.effects.findIndex(
          (e) => e.id === action.params.effectId,
        );

        return this.createInverseAction(action, "effect/restore", {
          clipId: action.params.clipId,
          effect: { ...effect },
          index,
        });
      }

      case "effect/update": {
        const effect = clip.effects.find(
          (e) => e.id === action.params.effectId,
        );
        if (!effect) return null;

        return this.createInverseAction(action, "effect/update", {
          clipId: action.params.clipId,
          effectId: action.params.effectId,
          params: { ...effect.params },
        });
      }

      case "effect/reorder": {
        const currentIndex = clip.effects.findIndex(
          (e) => e.id === action.params.effectId,
        );
        if (currentIndex === -1) return null;

        return this.createInverseAction(action, "effect/reorder", {
          clipId: action.params.clipId,
          effectId: action.params.effectId,
          newIndex: currentIndex,
        });
      }
    }
  }

  private generateTransformInverse(
    action: TransformAction & Action,
    projectBefore: Project,
  ): Action | null {
    const clip = this.findClip(projectBefore.timeline, action.params.clipId);
    if (!clip) return null;

    return this.createInverseAction(action, "transform/update", {
      clipId: action.params.clipId,
      transform: { ...clip.transform },
    });
  }

  private generateKeyframeInverse(
    action: KeyframeAction & Action,
    projectBefore: Project,
  ): Action | null {
    const clip = this.findClip(projectBefore.timeline, action.params.clipId);
    if (!clip) return null;

    switch (action.type) {
      case "keyframe/add":
        return this.createInverseAction(action, "keyframe/remove", {
          clipId: action.params.clipId,
          property: action.params.property,
          time: action.params.time,
        });

      case "keyframe/remove": {
        const keyframe = clip.keyframes.find(
          (kf) =>
            kf.property === action.params.property &&
            kf.time === action.params.time,
        );
        if (!keyframe) return null;

        return this.createInverseAction(action, "keyframe/add", {
          clipId: action.params.clipId,
          property: keyframe.property,
          time: keyframe.time,
          value: keyframe.value,
        });
      }

      case "keyframe/update": {
        const keyframe = clip.keyframes.find(
          (kf) =>
            kf.property === action.params.property &&
            kf.time === action.params.time,
        );
        if (!keyframe) return null;

        return this.createInverseAction(action, "keyframe/update", {
          clipId: action.params.clipId,
          property: keyframe.property,
          time: keyframe.time,
          value: keyframe.value,
          easing: keyframe.easing,
        });
      }
    }
  }

  private generateTransitionInverse(
    action: TransitionAction & Action,
    projectBefore: Project,
  ): Action | null {
    const timeline = projectBefore.timeline;

    switch (action.type) {
      case "transition/add":
        return this.createInverseAction(action, "transition/remove", {
          transitionId: "__LAST_ADDED__",
        });

      case "transition/remove": {
        const transition = this.findTransition(
          timeline,
          action.params.transitionId,
        );
        if (!transition) return null;

        return this.createInverseAction(action, "transition/restore", {
          transition: { ...transition },
        });
      }

      case "transition/update": {
        const transition = this.findTransition(
          timeline,
          action.params.transitionId,
        );
        if (!transition) return null;

        return this.createInverseAction(action, "transition/update", {
          transitionId: action.params.transitionId,
          duration: transition.duration,
          params: { ...transition.params },
        });
      }
    }
  }

  private generateAudioInverse(
    action: AudioAction & Action,
    projectBefore: Project,
  ): Action | null {
    const clip = this.findClip(projectBefore.timeline, action.params.clipId);
    if (!clip) return null;

    switch (action.type) {
      case "audio/setVolume":
        return this.createInverseAction(action, "audio/setVolume", {
          clipId: action.params.clipId,
          volume: clip.volume,
        });

      case "audio/setMuted":
        return this.createInverseAction(action, "audio/setMuted", {
          clipId: action.params.clipId,
          muted: clip.muted ?? false,
        });

      case "audio/setFade":
        return this.createInverseAction(action, "audio/setFade", {
          clipId: action.params.clipId,
          fadeIn: clip.fade?.fadeIn ?? 0,
          fadeOut: clip.fade?.fadeOut ?? 0,
        });

      case "audio/addAutomation":
        return this.createInverseAction(action, "audio/addAutomation", {
          clipId: action.params.clipId,
          points: clip.automation?.volume ?? [],
        });
    }
  }

  private generateSubtitleInverse(
    action: SubtitleAction & Action,
    projectBefore: Project,
  ): Action | null {
    const timeline = projectBefore.timeline;

    switch (action.type) {
      case "subtitle/import":
        return this.createInverseAction(action, "subtitle/restoreAll", {
          subtitles: timeline.subtitles.map((s) => ({ ...s })),
        });

      case "subtitle/add":
        return this.createInverseAction(action, "subtitle/remove", {
          subtitleId: "__LAST_ADDED__",
        });

      case "subtitle/remove": {
        const subtitle = timeline.subtitles.find(
          (s) => s.id === action.params.subtitleId,
        );
        if (!subtitle) return null;

        return this.createInverseAction(action, "subtitle/restore", {
          subtitle: { ...subtitle },
        });
      }

      case "subtitle/update": {
        const subtitle = timeline.subtitles.find(
          (s) => s.id === action.params.subtitleId,
        );
        if (!subtitle) return null;

        return this.createInverseAction(action, "subtitle/update", {
          subtitleId: action.params.subtitleId,
          text: subtitle.text,
          startTime: subtitle.startTime,
          endTime: subtitle.endTime,
        });
      }

      case "subtitle/setStyle": {
        // FOUNDATION FIX (F8-subtitle): apply homogenizes EVERY subtitle to one
        // style, so capturing only subtitles[0].style loses each subtitle's own
        // prior style on undo. Restore the full prior array (styles intact).
        return this.createInverseAction(action, "subtitle/restoreAll", {
          subtitles: timeline.subtitles.map((s) => ({ ...s })),
        });
      }
    }
  }

  private findClip(timeline: { tracks: Track[] }, clipId: string): Clip | null {
    for (const track of timeline.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return clip;
    }
    return null;
  }

  private findTransition(
    timeline: { tracks: Track[] },
    transitionId: string,
  ): Transition | null {
    for (const track of timeline.tracks) {
      const transition = track.transitions?.find((t) => t.id === transitionId);
      if (transition) return transition;
    }
    return null;
  }

  private cloneMediaItem(item: MediaItem): Record<string, unknown> {
    return {
      id: item.id,
      name: item.name,
      type: item.type,
      fileHandle: item.fileHandle,
      blob: item.blob,
      metadata: { ...item.metadata },
      thumbnailUrl: item.thumbnailUrl,
      waveformData: item.waveformData
        ? new Float32Array(item.waveformData)
        : null,
    };
  }

  private cloneTrack(track: Track): Record<string, unknown> {
    return {
      id: track.id,
      type: track.type,
      name: track.name,
      clips: track.clips.map((c) => this.cloneClip(c)),
      transitions: track.transitions?.map((t) => ({ ...t })) ?? [],
      locked: track.locked,
      hidden: track.hidden,
      muted: track.muted,
      solo: track.solo,
    };
  }

  private cloneClip(clip: Clip): Record<string, unknown> {
    // FOUNDATION FIX (F3): the previous hand-picked clone silently DROPPED
    // audioEffects, blendMode, blendOpacity, muted, speed, reversed,
    // emphasisAnimation and audioTrackIndex — so undo of a delete/split/ripple
    // restored a clip stripped of those fields. A full structural clone copies
    // every field; Clip is JSON-safe (no blobs/functions/Dates live on a clip —
    // those are on MediaItem), so this is complete and lossless.
    return JSON.parse(JSON.stringify(clip)) as Record<string, unknown>;
  }
}
