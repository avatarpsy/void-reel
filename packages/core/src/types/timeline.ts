import type { TransitionType } from "./effects";
import type { EmphasisAnimation } from "../graphics/types";

export interface Timeline {
  readonly tracks: Track[];
  readonly subtitles: Subtitle[];
  readonly duration: number;
  readonly markers: Marker[];
  readonly beatMarkers?: TimelineBeatMarker[];
  readonly beatAnalysis?: TimelineBeatAnalysis;
}

export interface TimelineBeatMarker {
  readonly time: number;
  readonly strength: number;
  readonly index: number;
  readonly isDownbeat: boolean;
}

export interface TimelineBeatAnalysis {
  readonly bpm: number;
  readonly confidence: number;
  readonly sourceClipId?: string;
  readonly analyzedAt: number;
}

export interface Track {
  readonly id: string;
  readonly type: "video" | "audio" | "image" | "text" | "graphics";
  readonly name: string;
  readonly clips: Clip[];
  readonly transitions: Transition[];
  readonly locked: boolean;
  readonly hidden: boolean;
  readonly muted: boolean;
  readonly solo: boolean;
}

/**
 * Free-form data riding on a clip.
 *
 * ── SHAPED TO MATCH UPSTREAM, DELIBERATELY ──────────────────────────────────
 * Upstream carries editing-template fields here too (`templateSource`,
 * `appliedTemplates`, …). We do not have that feature, so they are absent — but
 * the INDEX SIGNATURE is upstream's, which means their fields type-check
 * against this the day the branches merge. Diverging on the shape of the one
 * field a nested sequence is identified by would turn a clean merge into a
 * conflict in the renderer.
 */
export interface ClipMetadata {
  /**
   * THE CLIP IS AN INSTANCE OF A COMPOUND (a nested sequence).
   *
   * Its picture is not a media file — it is the compound's own timeline,
   * rendered. See `Project.compoundClips`.
   */
  readonly compoundClipId?: string;
  readonly [key: string]: unknown;
}

/**
 * Is this clip an instance of a nested sequence, and which one?
 *
 * ── ONE ANSWER, SHARED ──────────────────────────────────────────────────────
 * Three places need it — the export renderer, the preview's frame provider and
 * the timeline UI — and if they ever disagree, a sequence renders in one and
 * not the others. That is the exact failure mode this codebase has already been
 * bitten by with captions.
 *
 * TWO SPELLINGS, both upstream's, both supported: `metadata.compoundClipId` is
 * what the editor writes, and a `compound:`-prefixed `mediaId` is what carries
 * the identity through code that only ever looks at `mediaId` — which is most
 * of the older timeline surface.
 */
export function compoundIdOfClip(
  clip: { mediaId?: string; metadata?: { compoundClipId?: unknown } },
): string | null {
  const fromMeta = clip.metadata?.compoundClipId;
  if (typeof fromMeta === "string" && fromMeta) return fromMeta;
  const mediaId = clip.mediaId ?? "";
  return mediaId.startsWith("compound:") ? mediaId.slice("compound:".length) : null;
}

export interface Clip {
  readonly id: string;
  readonly mediaId: string;
  readonly trackId: string;
  readonly startTime: number;
  readonly duration: number;
  readonly inPoint: number;
  readonly outPoint: number;
  readonly effects: Effect[];
  readonly audioEffects: Effect[];
  readonly transform: Transform;
  readonly blendMode?: import("../video/types").BlendMode;
  readonly blendOpacity?: number;
  readonly volume: number;
  /** Audio mute toggle, distinct from `volume === 0`. The action
   *  executor's `audio/setMuted` writes this; inverse-action-generator
   *  reads it to capture undo state. Optional for back-compat with
   *  older saved projects that pre-date the field. */
  readonly muted?: boolean;
  readonly fade?: { fadeIn: number; fadeOut: number };
  readonly automation?: {
    volume?: AutomationPoint[];
    pan?: AutomationPoint[];
  };
  readonly keyframes: Keyframe[];
  readonly speed?: number;
  readonly reversed?: boolean;
  readonly emphasisAnimation?: EmphasisAnimation;
  /** Zero-based index of the audio track within the source media file to use for this clip.
   * Undefined or 0 means the primary/first audio track. */
  readonly audioTrackIndex?: number;
  /**
   * WHERE THIS CLIP CAME FROM, on the storyboard.
   *
   * `shotId` is the board shot; `takeId` is which generation of it. A clip
   * carried neither, so nothing on the timeline could say what it was OF — the
   * agent had to guess from position, and position is exactly what an edit
   * changes. With both, "recut scene 3 using more of take 2" is a lookup rather
   * than an inference, and cutting several takes of one shot together stays
   * legible after the pieces have been moved around.
   *
   * Optional and purely informational: nothing about playback or rendering reads
   * them, and a clip the user dragged in from their own disk has neither.
   */
  readonly shotId?: string;
  readonly takeId?: string;
  /**
   * Extra data, including whether this clip IS a nested sequence.
   *
   * A compound instance is an ORDINARY CLIP with `metadata.compoundClipId` set
   * — not a separate kind of object. That is the decision the whole feature
   * rests on: it moves, trims, splits and selects with every tool the timeline
   * already has, and nesting is then just the same thing one level down.
   */
  readonly metadata?: ClipMetadata;
}

export interface Effect {
  readonly id: string;
  readonly type: string;
  readonly params: Record<string, unknown>;
  readonly enabled: boolean;
}

export type FitMode = "contain" | "cover" | "stretch" | "none";

export interface Transform {
  readonly position: { x: number; y: number };
  readonly scale: { x: number; y: number };
  readonly rotation: number;
  readonly anchor: { x: number; y: number };
  readonly opacity: number;
  readonly borderRadius?: number;
  readonly fitMode?: FitMode;
  readonly rotate3d?: { x: number; y: number; z: number };
  readonly perspective?: number;
  readonly transformStyle?: "flat" | "preserve-3d";
  readonly crop?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface Keyframe {
  readonly id: string;
  readonly time: number;
  readonly property: string;
  readonly value: unknown;
  readonly easing: EasingType;
}

export type EasingType =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "bezier"
  | "easeInQuad"
  | "easeOutQuad"
  | "easeInOutQuad"
  | "easeInCubic"
  | "easeOutCubic"
  | "easeInOutCubic"
  | "easeInQuart"
  | "easeOutQuart"
  | "easeInOutQuart"
  | "easeInQuint"
  | "easeOutQuint"
  | "easeInOutQuint"
  | "easeInSine"
  | "easeOutSine"
  | "easeInOutSine"
  | "easeInExpo"
  | "easeOutExpo"
  | "easeInOutExpo"
  | "easeInCirc"
  | "easeOutCirc"
  | "easeInOutCirc"
  | "easeInBack"
  | "easeOutBack"
  | "easeInOutBack"
  | "easeInElastic"
  | "easeOutElastic"
  | "easeInOutElastic"
  | "easeInBounce"
  | "easeOutBounce"
  | "easeInOutBounce";

export interface Marker {
  readonly id: string;
  readonly time: number;
  readonly label: string;
  readonly color: string;
}

export interface Transition {
  readonly id: string;
  readonly clipAId: string;
  readonly clipBId: string;
  readonly type: TransitionType;
  readonly duration: number;
  readonly params: Record<string, unknown>;
}

export type CaptionAnimationStyle =
  | "none"
  | "word-highlight"
  | "word-by-word"
  | "karaoke"
  | "bounce"
  | "typewriter";

export interface SubtitleWord {
  readonly text: string;
  readonly startTime: number;
  readonly endTime: number;
}

export interface Subtitle {
  readonly id: string;
  readonly text: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly style?: SubtitleStyle;
  readonly words?: SubtitleWord[];
  readonly animationStyle?: CaptionAnimationStyle;
}

export interface SubtitleStyle {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly color: string;
  readonly backgroundColor: string;
  readonly position: "top" | "center" | "bottom";
  readonly highlightColor?: string;
  readonly upcomingColor?: string;
}

export interface AutomationPoint {
  readonly time: number;
  readonly value: number;
}
