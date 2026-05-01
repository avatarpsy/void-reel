import type { Timeline } from "./timeline";
import type { TextClip } from "../text/types";
import type { ShapeClip, SVGClip, StickerClip } from "../graphics/types";

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
   * Category tag used by the AssetsPanel to group items into named
   * sections — e.g. "Scene Videos", "Narrations", "Frames", "Music".
   * When unset, the panel falls back to the flat list keyed off
   * `type`. Voidspace-loader stamps this so chat-generated assets
   * land in tidy buckets the moment they appear.
   */
  readonly category?: string;
  /** Scene number this asset belongs to (1-indexed). Voidspace only. */
  readonly sceneNumber?: number;
  /** Sub-role within the scene: 'primary'|'first_frame'|'narration'|'music'|… */
  readonly role?: string;
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
}
