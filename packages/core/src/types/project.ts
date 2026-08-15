import type { Timeline } from "./timeline";
import type { TextClip } from "../text/types";
import type { ShapeClip, SVGClip, StickerClip } from "../graphics/types";
import type {
  CompoundClip,
  CompoundClipInstance,
} from "../timeline/nested-sequence-engine";

export interface ProjectSettings {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly sampleRate: number;
  readonly channels: number;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly settings: ProjectSettings;
  readonly mediaLibrary: MediaLibrary;
  readonly timeline: Timeline;
  readonly textClips?: TextClip[];
  readonly shapeClips?: ShapeClip[];
  readonly svgClips?: SVGClip[];
  readonly stickerClips?: StickerClip[];
  /**
   * Deletion tombstones. Voidspace re-derives timeline tracks from the
   * scene_lists tree on load and additively merges them into the live
   * project ("only add what's new"). A user's track DELETION is only an
   * ABSENCE in the saved blob — which a purely-additive union cannot
   * express — so without a tombstone the re-derivation resurrects deleted
   * tracks on every reload. `track/remove` records one; `track/restore`
   * (undo) clears it; the merge + scene rebuild skip tombstoned tracks and
   * their clip ids. Rides the project JSON like every other field.
   */
  readonly deletedTracks?: ReadonlyArray<{
    id: string;
    clipIds: readonly string[];
    at: number;
  }>;
  /**
   * NESTED SEQUENCES — the content, stored ONCE.
   *
   * A compound clip is a timeline in its own right: its own tracks, its own
   * clips, its own duration. It lives here, on the project, and the timeline
   * holds INSTANCES of it — ordinary clips carrying
   * `metadata.compoundClipId`.
   *
   * ── THAT SPLIT IS WHY AN EDIT PROPAGATES ────────────────────────────────
   * The content exists in exactly one place, so opening a sequence, trimming a
   * clip inside it and closing again changes every instance of it on every
   * timeline — because they were never copies, only references. Storing the
   * content on each instance would make "edit the sequence" mean "edit this
   * one copy of it", which is not what a sequence is.
   *
   * Nesting needs no extra machinery: a compound's own tracks may contain a
   * clip that is itself an instance of another compound. The renderer recurses
   * and guards against a cycle.
   *
   * Name and shape are upstream's, so the eventual merge converges rather than
   * conflicts.
   */
  readonly compoundClips?: CompoundClip[];
  /**
   * Instances, for anything that needs them without walking every track.
   *
   * The timeline is still the source of truth for WHERE an instance sits — it
   * is a clip like any other. This is the index, and it is optional.
   */
  readonly nestedInstances?: CompoundClipInstance[];
}

export interface MediaLibrary {
  readonly items: MediaItem[];
}

export interface MediaItem {
  readonly id: string;
  readonly name: string;
  readonly type: "video" | "audio" | "image";
  readonly fileHandle: FileSystemFileHandle | null;
  readonly blob: Blob | null;
  readonly metadata: MediaMetadata;
  readonly thumbnailUrl: string | null;
  readonly waveformData: Float32Array | null;
  readonly filmstripThumbnails?: FilmstripThumbnail[];
  readonly isPlaceholder?: boolean;
  readonly originalUrl?: string;
  /** File hint stored in JSON for cross-session/cross-machine asset matching */
  readonly sourceFile?: { name: string; size: number; lastModified: number; folder?: string };
  /** True while a background KieAI generation task is in progress */
  readonly isPending?: boolean;
  /** True when polling exhausted all retries — shows manual retry button */
  readonly kieaiError?: boolean;
  /** KieAI task ID used to poll for completion */
  readonly kieaiTaskId?: string;
  /**
   * Suno (Kie) generation lineage — stamped on audio produced by the
   * inspector's AI audio ops. Together `sunoTaskId` + `sunoAudioId`
   * identify the source track for Suno-native follow-ups (separate
   * stems, WAV export, timestamped lyrics, native extend). Persisted in
   * project JSON so the chain survives save/reload.
   */
  readonly sunoTaskId?: string;
  readonly sunoAudioId?: string;
  /**
   * Category tag used by the AssetsPanel to group items into named
   * sections — e.g. "Scene Videos", "Narrations", "Frames", "Music".
   * When unset, the panel falls back to the flat list keyed off
   * `type`. Voidspace-loader stamps this so chat-generated assets
   * land in tidy buckets the moment they appear.
   */
  readonly category?: string;
  /** Scene number this asset belongs to (1-indexed). Voidspace only. */
  readonly sceneNumber?: number;
  /**
   * The BOARD SHOT this asset was made for — `source_shot_id` on the scene.
   *
   * `sceneNumber` is a position and positions move: reorder the storyboard and
   * scene 3 is a different shot, while the asset is still the same asset. So a
   * question as basic as "which shot is this clip from?" was unanswerable from
   * the timeline, and anything that wanted to know had to infer it from an index
   * that had already changed underneath.
   *
   * Stable for the life of the shot, so it is also what lets several takes of
   * one shot be recognised as siblings rather than as unrelated files.
   */
  readonly shotId?: string;
  /** Sub-role within the scene: 'primary'|'first_frame'|'narration'|'music'|… */
  readonly role?: string;
  /**
   * Generation metadata so the AGENT can understand what an asset is without
   * re-deriving it — the prompt it was generated from, its mood/genre, and a
   * human title. Stamped by the loader / Cloud tab / Library from the durable
   * generation record. Persisted in project JSON.
   */
  readonly prompt?: string;
  readonly mood?: string;
  readonly title?: string;
}

/** Thumbnail for filmstrip display in timeline */
export interface FilmstripThumbnail {
  readonly timestamp: number;
  readonly url: string;
}

export interface MediaMetadata {
  readonly duration: number; // In seconds
  readonly width: number; // For video/image
  readonly height: number; // For video/image
  readonly frameRate: number; // For video
  readonly codec: string;
  readonly sampleRate: number; // For audio
  readonly channels: number; // For audio
  readonly fileSize: number;
  /** Number of audio tracks in the file (may be > 1 for multi-track video/audio files) */
  readonly audioTrackCount?: number;
}
