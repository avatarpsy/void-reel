export {
  TrackManager,
  createTrack,
  cloneTrack,
  getTrackClips,
  canAcceptMediaType,
  type TrackManagerOptions,
  type CreateTrackParams,
  type TrackOperationResult,
} from "./track-manager";

export {
  ClipManager,
  createClip,
  cloneClip,
  getClipEndTime,
  clipsOverlap,
  getGapBetweenClips,
  type ClipManagerOptions,
  type AddClipParams,
  type MoveClipParams,
  type ClipOperationResult,
  type SnapResult,
} from "./clip-manager";

export {
  NestedSequenceEngine,
  getNestedSequenceEngine,
  resetNestedSequenceEngine,
  type CompoundClip,
  type CompoundClipContent,
  type CompoundClipInstance,
  type CreateCompoundClipOptions,
  type FlattenResult,
} from "./nested-sequence-engine";

// Nested sequences, the two pieces that are ours rather than upstream's:
// screenplay sequences → compound clips (board → editor), and the audio
// flattener that stops a nested sequence playing silent.
export { buildSequenceCompounds, type SequenceSpan } from "./sequence-compounds";
export { flattenCompoundAudio } from "./flatten-compounds";
