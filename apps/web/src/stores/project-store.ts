import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type {
  Project,
  ProjectSettings,
  MediaItem,
  Track,
  Clip,
  Action,
  ActionResult,
  TextClip,
  TextStyle,
  TextAnimation,
  CaptionAnimationStyle,
  TextAnimationPreset,
  TextAnimationParams,
  ShapeClip,
  ShapeType,
  ShapeStyle,
  SVGClip,
  StickerClip,
  PhotoProject,
  CreateLayerOptions,
  PhotoBlendMode,
  Effect,
  Keyframe,
  Transform,
} from "@openreel/core";
import {
  ActionExecutor,
  ActionHistory,
  textAnimationEngine,
} from "@openreel/core";
import { v4 as uuidv4 } from "uuid";
import type {
  VideoEffect,
  VideoEffectType,
  ColorGradingSettings,
} from "../bridges/effects-bridge";
import { getEffectsBridge } from "../bridges/effects-bridge";
import {
  autoSaveManager,
  initializeAutoSave,
  type AutoSaveMetadata,
} from "../services/auto-save";
import { useEngineStore } from "./engine-store";
import { getMediaBridge, initializeMediaBridge } from "../bridges/media-bridge";
import {
  createEmptyProject,
  calculateTimelineDuration,
  type ClipHistoryEntry,
} from "./project/index";
import {
  saveMediaBlob,
  deleteMediaBlob,
  loadProjectMedia,
  loadFileHandle,
  loadDirectoryHandle,
} from "../services/media-storage";
import { restoreMediaItem } from "../utils/media-recovery";
import { collectFolder, buildRelinkPlan, type RelinkableItem } from "../services/media-relink";
import { projectManager } from "../services/project-manager";

/**
 * ProjectState - Complete state interface for project management
 *
 * Provides comprehensive API for:
 * - Project CRUD operations
 * - Media library management
 * - Track and clip manipulation
 * - Text clip and animation handling
 * - Graphics (shapes, SVG, stickers) management
 * - Video and audio effects
 * - Subtitle handling
 * - Photo editing
 * - Undo/redo functionality
 *
 * All async methods return ActionResult with success status and error details.
 */
export interface ProjectState {
  // Project data
  project: Project;

  // Photo projects
  photoProjects: Map<string, PhotoProject>;

  // Action system
  actionExecutor: ActionExecutor;
  actionHistory: ActionHistory;

  // Clip history for graphics/text clips (outside main timeline)
  clipUndoStack: ClipHistoryEntry[];
  clipRedoStack: ClipHistoryEntry[];

  // Loading state
  isLoading: boolean;
  error: string | null;

  createNewProject: (
    name?: string,
    settings?: Partial<ProjectSettings>,
  ) => void;
  loadProject: (project: Project) => void;
  renameProject: (name: string) => Promise<ActionResult>;
  updateSettings: (settings: Partial<ProjectSettings>) => Promise<ActionResult>;

  // Media library actions
  importMedia: (file: File) => Promise<ActionResult>;
  deleteMedia: (mediaId: string) => Promise<ActionResult>;
  replaceMediaAsset: (mediaId: string, file: File, sourceFolder?: string) => Promise<ActionResult>;
  renameMedia: (mediaId: string, name: string) => Promise<ActionResult>;
  getMediaItem: (mediaId: string) => MediaItem | undefined;
  /** Patch lazily-generated waveform peaks onto a media item. Runtime
   *  only — the serializer strips waveformData, so this drives timeline
   *  rendering without persisting peaks into the project blob, and must
   *  NOT bump modifiedAt (no autosave churn). */
  setMediaWaveform: (mediaId: string, peaks: Float32Array) => void;
  /** Attach lazily-generated filmstrip thumbnails (runtime-only patch). */
  setMediaFilmstrip: (mediaId: string, thumbs: import("@openreel/core").FilmstripThumbnail[]) => void;
  /** Cache resolved bytes onto a media item (runtime-only patch). */
  setMediaBlob: (mediaId: string, blob: Blob) => void;
  /** Correct a media item's recorded duration (and extend a full-take
   *  audio clip) when decode reveals the stored duration was wrong. */
  healClipDurationFromMedia: (clipId: string, mediaId: string, realDuration: number) => void;
  /** Add a pending placeholder for a background KieAI task */
  addPlaceholderMedia: (item: MediaItem) => void;
  /** Replace a pending placeholder with the actual result blob */
  replacePlaceholderMedia: (mediaId: string, blob: Blob, name: string) => Promise<void>;
  /** Flip isPending / kieaiError flags on a placeholder without full replacement */
  setKieAIItemState: (mediaId: string, isPending: boolean, kieaiError: boolean) => void;

  // Track actions
  addTrack: (
    trackType: "video" | "audio" | "image" | "text" | "graphics",
    position?: number,
  ) => Promise<ActionResult>;
  removeTrack: (trackId: string) => Promise<ActionResult>;
  reorderTrack: (trackId: string, newPosition: number) => Promise<ActionResult>;
  lockTrack: (trackId: string, locked: boolean) => Promise<ActionResult>;
  hideTrack: (trackId: string, hidden: boolean) => Promise<ActionResult>;
  muteTrack: (trackId: string, muted: boolean) => Promise<ActionResult>;
  soloTrack: (trackId: string, solo: boolean) => Promise<ActionResult>;
  renameTrack: (trackId: string, name: string) => void;
  getTrack: (trackId: string) => Track | undefined;

  // Clip actions
  addClip: (
    trackId: string,
    mediaId: string,
    startTime: number,
    duration?: number,
    opts?: {
      transform?: Partial<Transform>;
      keyframes?: Keyframe[];
      blendMode?: import("@openreel/core").BlendMode;
    },
  ) => Promise<ActionResult>;
  addClipToNewTrack: (
    mediaId: string,
    startTime?: number,
  ) => Promise<ActionResult>;
  removeClip: (clipId: string) => Promise<ActionResult>;
  moveClip: (
    clipId: string,
    startTime: number,
    trackId?: string,
  ) => Promise<ActionResult>;
  trimClip: (
    clipId: string,
    inPoint?: number,
    outPoint?: number,
    startTime?: number,
  ) => Promise<ActionResult>;
  splitClip: (clipId: string, time: number) => Promise<ActionResult>;
  rippleDeleteClip: (clipId: string) => Promise<ActionResult>;
  slipClip: (clipId: string, delta: number) => Promise<ActionResult>;
  slideClip: (clipId: string, delta: number) => Promise<ActionResult>;
  rollEdit: (
    leftClipId: string,
    rightClipId: string,
    delta: number,
  ) => Promise<ActionResult>;
  trimToPlayhead: (
    clipId: string,
    playheadTime: number,
    trimStart: boolean,
  ) => Promise<ActionResult>;
  getClip: (clipId: string) => Clip | undefined;
  /**
   * Text-clip mutations through ActionExecutor — call these instead of
   * `useEngineStore.getState().getTitleEngine().updateTextClip(...)` so
   * the change enters ActionHistory and is undoable.
   */
  updateTextClip: (
    clipId: string,
    updates: Record<string, unknown>,
  ) => Promise<ActionResult>;
  addTextClip: (textClip: any) => Promise<ActionResult>;
  removeTextClip: (clipId: string) => Promise<ActionResult>;
  separateAudio: (clipId: string) => Promise<ActionResult>;
  updateClipTransform: (
    clipId: string,
    transform: Partial<Transform>,
  ) => boolean;
  updateClipBlendMode: (
    clipId: string,
    blendMode: import("@openreel/core").BlendMode,
  ) => boolean;
  updateClipBlendOpacity: (clipId: string, opacity: number) => boolean;
  updateClipRotate3D: (
    clipId: string,
    rotate3d: { x: number; y: number; z: number },
  ) => boolean;
  updateClipPerspective: (clipId: string, perspective: number) => boolean;
  updateClipTransformStyle: (
    clipId: string,
    transformStyle: "flat" | "preserve-3d",
  ) => boolean;
  updateClipEmphasisAnimation: (
    clipId: string,
    emphasisAnimation: import("@openreel/core").EmphasisAnimation,
  ) => boolean;

  // Clipboard actions
  clipboard: Clip[];
  copyClips: (clipIds: string[]) => void;
  pasteClips: (trackId: string, startTime: number) => Promise<ActionResult[]>;
  duplicateClip: (clipId: string) => Promise<ActionResult>;
  copyEffects: (clipId: string) => void;
  pasteEffects: (clipId: string) => Promise<ActionResult>;
  copiedEffects: Effect[];

  // Text clip actions
  createTextClip: (
    trackId: string,
    startTime: number,
    text: string,
    duration?: number,
    style?: Partial<TextStyle>,
  ) => TextClip | null;
  updateTextContent: (clipId: string, text: string) => TextClip | null;
  updateTextStyle: (
    clipId: string,
    style: Partial<TextStyle>,
  ) => TextClip | null;
  updateTextAnimation: (
    clipId: string,
    animation: TextAnimation,
  ) => TextClip | null;
  updateTextTransform: (
    clipId: string,
    transform: Partial<Transform>,
  ) => TextClip | null;
  updateCaptionFields: (
    clipId: string,
    fields: {
      captionHighlight?: boolean;
      captionHighlightColor?: string;
      captionAnimation?: CaptionAnimationStyle;
    },
  ) => TextClip | null;
  getTextClip: (clipId: string) => TextClip | undefined;
  getAllTextClips: () => TextClip[];
  updateTextClipKeyframes: (
    clipId: string,
    keyframes: Keyframe[],
  ) => TextClip | null;

  // Text animation actions
  applyTextAnimationPreset: (
    clipId: string,
    preset: TextAnimationPreset,
    inDuration?: number,
    outDuration?: number,
    params?: Partial<TextAnimationParams>,
  ) => TextClip | null;
  getAvailableAnimationPresets: () => TextAnimationPreset[];

  // Subtitle actions - subtitles are created as text clips on a Captions track
  addSubtitle: (subtitle: import("@openreel/core").Subtitle) => Promise<void>;
  removeSubtitle: (subtitleId: string) => void;
  updateSubtitle: (
    subtitleId: string,
    updates: Partial<import("@openreel/core").Subtitle>,
  ) => void;
  getSubtitle: (
    subtitleId: string,
  ) => import("@openreel/core").Subtitle | undefined;
  importSRT: (
    srtContent: string
  ) => Promise<{ success: boolean; errors: string[] }>;
  exportSRT: () => Promise<string>;
  applySubtitleStylePreset: (presetName: string) => Promise<boolean>;
  getSubtitleStylePresets: () => Promise<string[]>;

  // Marker actions
  addMarker: (time: number, label?: string, color?: string) => void;
  removeMarker: (markerId: string) => void;
  updateMarker: (
    markerId: string,
    updates: Partial<import("@openreel/core").Marker>,
  ) => void;
  getMarker: (markerId: string) => import("@openreel/core").Marker | undefined;
  getMarkers: () => import("@openreel/core").Marker[];

  // Graphics actions
  createShapeClip: (
    trackId: string,
    startTime: number,
    shapeType: ShapeType,
    duration?: number,
    style?: Partial<ShapeStyle>,
  ) => ShapeClip | null;
  updateShapeStyle: (
    clipId: string,
    style: Partial<ShapeStyle>,
  ) => ShapeClip | null;
  updateShapeTransform: (
    clipId: string,
    transform: Partial<Transform>,
  ) => ShapeClip | SVGClip | StickerClip | null;
  importSVG: (
    svgContent: string,
    trackId: string,
    startTime: number,
    duration?: number,
  ) => SVGClip | null;
  getShapeClip: (clipId: string) => ShapeClip | undefined;
  deleteShapeClip: (clipId: string) => boolean;
  getSVGClip: (clipId: string) => SVGClip | undefined;
  getSVGClipById: (clipId: string) => SVGClip | undefined;
  updateSVGClip: (
    clipId: string,
    updates: {
      startTime?: number;
      duration?: number;
      transform?: Partial<Transform>;
      entryAnimation?: import("@openreel/core").GraphicAnimation;
      exitAnimation?: import("@openreel/core").GraphicAnimation;
      colorStyle?: import("@openreel/core").SVGColorStyle;
    },
  ) => SVGClip | null;
  deleteSVGClip: (clipId: string) => boolean;
  createStickerClip: (clip: StickerClip) => StickerClip | null;
  getStickerClip: (clipId: string) => StickerClip | undefined;
  deleteStickerClip: (clipId: string) => boolean;
  deleteTextClip: (clipId: string) => boolean;

  // Photo editing actions
  createPhotoProject: (
    width?: number,
    height?: number,
    name?: string,
  ) => PhotoProject | null;
  importPhotoForEditing: (
    image: ImageBitmap,
    name?: string,
  ) => PhotoProject | null;
  addPhotoLayer: (
    projectId: string,
    options?: CreateLayerOptions,
  ) => PhotoProject | null;
  removePhotoLayer: (projectId: string, layerId: string) => PhotoProject | null;
  reorderPhotoLayers: (
    projectId: string,
    fromIndex: number,
    toIndex: number,
  ) => PhotoProject | null;
  setPhotoLayerVisibility: (
    projectId: string,
    layerId: string,
    visible?: boolean,
  ) => PhotoProject | null;
  setPhotoLayerOpacity: (
    projectId: string,
    layerId: string,
    opacity: number,
  ) => PhotoProject | null;
  setPhotoLayerBlendMode: (
    projectId: string,
    layerId: string,
    blendMode: PhotoBlendMode,
  ) => PhotoProject | null;
  getPhotoProject: (projectId: string) => PhotoProject | null;

  // Video effects actions
  addVideoEffect: (
    clipId: string,
    effectType: VideoEffectType,
    params?: Record<string, unknown>,
  ) => VideoEffect | null;
  updateVideoEffect: (
    clipId: string,
    effectId: string,
    params: Record<string, unknown>,
  ) => VideoEffect | null;
  removeVideoEffect: (clipId: string, effectId: string) => boolean;
  reorderVideoEffects: (clipId: string, effectIds: string[]) => boolean;
  toggleVideoEffect: (
    clipId: string,
    effectId: string,
    enabled: boolean,
  ) => VideoEffect | null;
  getVideoEffects: (clipId: string) => VideoEffect[];
  getVideoEffect: (clipId: string, effectId: string) => VideoEffect | undefined;

  // Color grading actions
  updateColorGrading: (
    clipId: string,
    settings: Partial<ColorGradingSettings>,
  ) => boolean;
  getColorGrading: (clipId: string) => ColorGradingSettings;
  resetColorGrading: (clipId: string) => boolean;

  // Audio effects actions
  addAudioEffect: (clipId: string, effect: Effect) => boolean;
  updateAudioEffect: (
    clipId: string,
    effectId: string,
    params: Record<string, unknown>,
  ) => boolean;
  removeAudioEffect: (clipId: string, effectId: string) => boolean;
  toggleAudioEffect: (
    clipId: string,
    effectId: string,
    enabled: boolean,
  ) => boolean;
  getAudioEffects: (clipId: string) => Effect[];

  // Keyframe actions
  updateClipKeyframes: (clipId: string, keyframes: Keyframe[]) => boolean;

  // Undo/Redo
  undo: () => Promise<ActionResult>;
  redo: () => Promise<ActionResult>;
  canUndo: () => boolean;
  canRedo: () => boolean;
  // Snapshot restore — walks undo/redo stack until undoStack.length matches
  // snapshot.stackIndex, replaying inverse actions to bring the project
  // back to the state it had when the snapshot was taken.
  restoreToSnapshot: (snapshotId: string) => Promise<ActionResult>;

  // Execute arbitrary action
  executeAction: (action: Action) => Promise<ActionResult>;

  // Computed values
  getTimelineDuration: () => number;

  // Auto-save
  initializeAutoSave: () => Promise<void>;
  checkForRecovery: () => Promise<AutoSaveMetadata[]>;
  recoverFromAutoSave: (saveId: string) => Promise<boolean>;
  forceSave: () => Promise<void>;
}

/**
 * Create the project store
 */
export const useProjectStore = create<ProjectState>()(
  subscribeWithSelector((set, get) => {
    const actionHistory = new ActionHistory();
    // Inject the live TitleEngine accessor so text/* actions
    // (caption add / remove / update) route through ActionExecutor
    // and enter ActionHistory — without this, caption mutations were
    // bypassing undo entirely (executor would silent-no-op text/*).
    const actionExecutor = new ActionExecutor(actionHistory, {
      getTitleEngine: () => useEngineStore.getState().getTitleEngine() ?? null,
    });

    return {
      // Initial state - create empty project (Requirement 1.1)
      project: createEmptyProject(),
      photoProjects: new Map(),
      actionExecutor,
      actionHistory,
      clipUndoStack: [] as ClipHistoryEntry[],
      clipRedoStack: [] as ClipHistoryEntry[],
      isLoading: false,
      error: null,
      clipboard: [] as Clip[],
      copiedEffects: [] as Effect[],

      createNewProject: (
        name?: string,
        settings?: Partial<ProjectSettings>,
      ) => {
        const newHistory = new ActionHistory();
        const newExecutor = new ActionExecutor(newHistory, {
          getTitleEngine: () => useEngineStore.getState().getTitleEngine() ?? null,
        });
        set({
          project: createEmptyProject(name, settings),
          actionHistory: newHistory,
          actionExecutor: newExecutor,
          clipUndoStack: [],
          clipRedoStack: [],
          error: null,
        });
      },

      loadProject: (project: Project) => {
        const titleEngine = useEngineStore.getState().getTitleEngine();
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();

        // Restore video effects + color grading captured by the autosave
        // (project.effectsState → EffectsBridge maps). Pre-init loads are
        // buffered inside the bridge and flushed when it initializes.
        try {
          const effectsState = (project as any).effectsState;
          console.log(`[loadProject] effectsState: ${effectsState ? Object.keys(effectsState).length + ' clip(s)' : 'ABSENT'}`);
          if (effectsState) getEffectsBridge().restoreAllEffects(effectsState);
        } catch (e) {
          console.warn('[loadProject] effects restore failed:', e);
        }

        if (titleEngine && project.textClips) {
          titleEngine.loadTextClips(project.textClips);
        }
        if (graphicsEngine) {
          if (project.shapeClips) {
            graphicsEngine.loadShapeClips(project.shapeClips);
          }
          if (project.svgClips) {
            graphicsEngine.loadSVGClips(project.svgClips);
          }
          if (project.stickerClips) {
            graphicsEngine.loadStickerClips(project.stickerClips);
          }
        }

        const newHistory = new ActionHistory();
        const newExecutor = new ActionExecutor(newHistory, {
          getTitleEngine: () => useEngineStore.getState().getTitleEngine() ?? null,
        });

        // Fix legacy projects where timeline.duration was never persisted
        const computedDuration = project.timeline.tracks.reduce((max, track) =>
          track.clips.reduce((m, c) => Math.max(m, c.startTime + c.duration), max), 0);
        const fixedProject = computedDuration > 0 && project.timeline.duration === 0
          ? { ...project, timeline: { ...project.timeline, duration: computedDuration } }
          : project;

        set({
          project: fixedProject,
          actionHistory: newHistory,
          actionExecutor: newExecutor,
          clipUndoStack: [],
          clipRedoStack: [],
          error: null,
        });

        // Auto-restore placeholder assets from saved FileSystemFileHandles
        // (same machine). Includes items WITHOUT sourceFile — Voidspace
        // scene media carries only originalUrl/sceneNumber/role, and the
        // Tier-2 matcher relinks those from the saved folder.
        const placeholders = fixedProject.mediaLibrary.items.filter(
          (item) => item.isPlaceholder,
        );
        if (placeholders.length > 0 && "FileSystemFileHandle" in window) {
          (async () => {
            let restored = 0;
            const stillMissing: typeof placeholders = [];

            // Tier 1: try individual file handles (follow file across folder
            // moves). Only items that recorded a sourceFile have a handle key.
            for (const item of placeholders) {
              if (!item.sourceFile) { stillMissing.push(item); continue; }
              try {
                const handle = await loadFileHandle(item.sourceFile.name, item.sourceFile.size);
                if (!handle) { stillMissing.push(item); continue; }
                const file = await handle.getFile();
                await get().replaceMediaAsset(item.id, file, item.sourceFile.folder);
                restored++;
              } catch {
                stillMissing.push(item); // stale handle
              }
            }

            // Tier 2: recursively scan the stored relink folder with the
            // manifest-aware matcher (same logic as the Assets panel's
            // "Relink from Folder"). Handles subfolder layouts and
            // sourceFile-less Voidspace scene media.
            if (stillMissing.length > 0) {
              try {
                const dirInfo = await loadDirectoryHandle(fixedProject.id);
                if (dirInfo) {
                  const { files, manifests } = await collectFolder(dirInfo.handle);
                  if (files.length > 0) {
                    const relinkable: RelinkableItem[] = stillMissing.map((item) => ({
                      id: item.id,
                      name: item.name,
                      type: item.type,
                      originalUrl: item.originalUrl,
                      category: item.category,
                      sceneNumber: item.sceneNumber,
                      role: item.role,
                      fileSize: item.metadata?.fileSize,
                      sourceFile: item.sourceFile,
                    }));
                    const plan = buildRelinkPlan(relinkable, files, manifests, {
                      currentProjectId: fixedProject.id,
                    });
                    for (const match of plan.matches) {
                      try {
                        await get().replaceMediaAsset(match.itemId, match.file.file, dirInfo.folderName);
                        restored++;
                      } catch { /* skip */ }
                    }
                  }
                }
              } catch { /* dir handle stale or unavailable */ }
            }

            if (restored > 0) {
              console.info(`[ProjectStore] Auto-restored ${restored} asset(s) from saved folder/handles`);
            }
          })();
        }
      },

      // Rename project
      renameProject: async (name: string) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "project/rename",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { name },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      // Update project settings
      updateSettings: async (settings: Partial<ProjectSettings>) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "project/updateSettings",
          id: uuidv4(),
          timestamp: Date.now(),
          params: settings,
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      // Media library actions
      importMedia: async (file: File) => {
        const { project } = get();

        try {
          const mediaBridge = getMediaBridge();
          if (!mediaBridge.isInitialized()) {
            await initializeMediaBridge();
          }

          const isLargeFile = file.size > 50 * 1024 * 1024;
          const importResult = await mediaBridge.importFile(file, true, isLargeFile);

          if (!importResult.success || !importResult.media) {
            return {
              success: false,
              error: {
                code: "DECODE_ERROR" as const,
                message: importResult.error || "Failed to import media",
              },
            };
          }

          // Create a MediaItem from the processed media
          const processedMedia = importResult.media;

          // Get thumbnail URL from the first thumbnail if available
          // Also collect all thumbnails for filmstrip display
          let thumbnailUrl: string | null = null;
          const filmstripThumbnails: { timestamp: number; url: string }[] = [];

          if (
            processedMedia.thumbnails &&
            processedMedia.thumbnails.length > 0
          ) {
            // Process all thumbnails for filmstrip display
            for (const thumb of processedMedia.thumbnails) {
              let thumbUrl: string | null = null;

              // Check if dataUrl already exists
              if (thumb.dataUrl) {
                thumbUrl = thumb.dataUrl;
              } else if (thumb.canvas) {
                // Convert canvas to a DATA url (not a blob: object URL). Object
                // URLs are scoped to the current document and become dead the
                // moment the page reloads — that's why a recording's thumbnail
                // turned into a broken image in Assets after refresh. A data:
                // URL is self-contained, serializes into project_state, and
                // survives reloads with no re-hydration needed.
                try {
                  if (thumb.canvas instanceof OffscreenCanvas) {
                    const blob = await thumb.canvas.convertToBlob({
                      type: "image/jpeg",
                      quality: 0.7,
                    });
                    thumbUrl = await new Promise<string>((resolve, reject) => {
                      const fr = new FileReader();
                      fr.onload = () => resolve(fr.result as string);
                      fr.onerror = () => reject(fr.error);
                      fr.readAsDataURL(blob);
                    });
                  } else if (thumb.canvas instanceof HTMLCanvasElement) {
                    thumbUrl = thumb.canvas.toDataURL("image/jpeg", 0.7);
                  }
                } catch (e) {
                  console.warn("Failed to convert thumbnail canvas to URL:", e);
                }
              }

              if (thumbUrl) {
                filmstripThumbnails.push({
                  timestamp: thumb.timestamp,
                  url: thumbUrl,
                });
              }
            }

            // Use first thumbnail as the main thumbnail
            if (filmstripThumbnails.length > 0) {
              thumbnailUrl = filmstripThumbnails[0].url;
            }
          }

          // Determine media type - check file MIME type first for images
          let mediaType: "video" | "audio" | "image";
          if (file.type.startsWith("image/")) {
            mediaType = "image";
          } else if (processedMedia.metadata.hasVideo) {
            mediaType = "video";
          } else if (processedMedia.metadata.hasAudio) {
            mediaType = "audio";
          } else {
            mediaType = "image";
          }

          const newMediaItem: MediaItem = {
            id: uuidv4(),
            name: file.name,
            type: mediaType,
            fileHandle: null,
            blob: file,
            metadata: {
              // Images have no inherent duration (like graphics), duration is set on the clip
              duration: processedMedia.metadata.duration || 0,
              width: processedMedia.metadata.width || 0,
              height: processedMedia.metadata.height || 0,
              frameRate: processedMedia.metadata.frameRate || 0,
              codec: processedMedia.metadata.codec || "",
              sampleRate: processedMedia.metadata.sampleRate || 0,
              channels: processedMedia.metadata.channels || 0,
              fileSize: file.size,
            },
            thumbnailUrl,
            waveformData: processedMedia.waveformData?.peaks || null,
            filmstripThumbnails:
              filmstripThumbnails.length > 0 ? filmstripThumbnails : undefined,
            sourceFile: { name: file.name, size: file.size, lastModified: file.lastModified },
          };

          const updatedProject = {
            ...project,
            mediaLibrary: {
              ...project.mediaLibrary,
              items: [...project.mediaLibrary.items, newMediaItem],
            },
            modifiedAt: Date.now(),
          };

          set({ project: updatedProject });

          try {
            await saveMediaBlob(
              updatedProject.id,
              newMediaItem.id,
              file,
              newMediaItem.metadata,
            );
          } catch (err) {
            console.error("[ProjectStore] Failed to persist media blob:", err);
          }

          if (isLargeFile && !thumbnailUrl) {
            setTimeout(async () => {
              try {
                const thumbs = await mediaBridge.generateThumbnailsForMedia(
                  file,
                  mediaType,
                );
                if (thumbs.length > 0) {
                  const currentProject = get().project;
                  const mediaIndex = currentProject.mediaLibrary.items.findIndex(
                    (m) => m.id === newMediaItem.id,
                  );
                  if (mediaIndex !== -1) {
                    const updatedItems = [...currentProject.mediaLibrary.items];
                    updatedItems[mediaIndex] = {
                      ...updatedItems[mediaIndex],
                      thumbnailUrl: thumbs[0].dataUrl,
                      filmstripThumbnails: thumbs.map((t) => ({
                        timestamp: t.timestamp,
                        url: t.dataUrl,
                      })),
                    };
                    set({
                      project: {
                        ...currentProject,
                        mediaLibrary: {
                          ...currentProject.mediaLibrary,
                          items: updatedItems,
                        },
                      },
                    });
                  }
                }
              } catch {
                // Background thumbnail generation is best-effort
              }
            }, 100);
          }

          return {
            success: true,
            actionId: newMediaItem.id,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: "DECODE_ERROR" as const,
              message:
                error instanceof Error ? error.message : "Unknown import error",
            },
          };
        }
      },

      deleteMedia: async (mediaId: string) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "media/delete",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { mediaId },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
          deleteMediaBlob(mediaId).catch((err) =>
            console.warn("[ProjectStore] Failed to delete media blob:", err),
          );
        }
        return result;
      },

      replaceMediaAsset: async (mediaId: string, file: File, sourceFolder?: string) => {
        const { project } = get();

        try {
          const mediaBridge = getMediaBridge();
          if (!mediaBridge.isInitialized()) {
            await initializeMediaBridge();
          }

          const importResult = await mediaBridge.importFile(file, true);

          if (!importResult.success || !importResult.media) {
            return {
              success: false,
              error: {
                code: "DECODE_ERROR" as const,
                message: importResult.error || "Failed to import media",
              },
            };
          }

          const processedMedia = importResult.media;

          let thumbnailUrl: string | null = null;
          const filmstripThumbnails: { timestamp: number; url: string }[] = [];

          if (
            processedMedia.thumbnails &&
            processedMedia.thumbnails.length > 0
          ) {
            for (const thumb of processedMedia.thumbnails) {
              let thumbUrl: string | null = null;

              if (thumb.dataUrl) {
                thumbUrl = thumb.dataUrl;
              } else if (thumb.canvas) {
                try {
                  if (thumb.canvas instanceof OffscreenCanvas) {
                    const blob = await thumb.canvas.convertToBlob({
                      type: "image/jpeg",
                      quality: 0.7,
                    });
                    thumbUrl = URL.createObjectURL(blob);
                  } else if (thumb.canvas instanceof HTMLCanvasElement) {
                    thumbUrl = thumb.canvas.toDataURL("image/jpeg", 0.7);
                  }
                } catch (e) {
                  console.warn("Failed to convert thumbnail canvas to URL:", e);
                }
              }

              if (thumbUrl) {
                filmstripThumbnails.push({
                  timestamp: thumb.timestamp,
                  url: thumbUrl,
                });
              }
            }

            if (filmstripThumbnails.length > 0) {
              thumbnailUrl = filmstripThumbnails[0].url;
            }
          }

          const updatedItem: MediaItem = {
            id: mediaId,
            name: file.name,
            type: processedMedia.metadata.hasVideo
              ? "video"
              : processedMedia.metadata.hasAudio
                ? "audio"
                : "image",
            fileHandle: null,
            blob: file,
            metadata: {
              duration: processedMedia.metadata.duration || 0,
              width: processedMedia.metadata.width || 0,
              height: processedMedia.metadata.height || 0,
              frameRate: processedMedia.metadata.frameRate || 0,
              codec: processedMedia.metadata.codec || "",
              sampleRate: processedMedia.metadata.sampleRate || 0,
              channels: processedMedia.metadata.channels || 0,
              fileSize: file.size,
            },
            thumbnailUrl,
            waveformData: processedMedia.waveformData?.peaks || null,
            filmstripThumbnails:
              filmstripThumbnails.length > 0 ? filmstripThumbnails : undefined,
            isPlaceholder: false,
            sourceFile: { name: file.name, size: file.size, lastModified: file.lastModified, folder: sourceFolder },
          };

          const updatedItems = project.mediaLibrary.items.map((item) =>
            item.id === mediaId ? updatedItem : item,
          );

          set({
            project: {
              ...project,
              mediaLibrary: {
                items: updatedItems,
              },
              modifiedAt: Date.now(),
            },
          });

          return {
            success: true,
            actionId: uuidv4(),
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: "DECODE_ERROR" as const,
              message:
                error instanceof Error ? error.message : "Unknown import error",
            },
          };
        }
      },

      renameMedia: async (mediaId: string, name: string) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "media/rename",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { mediaId, name },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      getMediaItem: (mediaId: string) => {
        const { project } = get();
        return project.mediaLibrary.items.find((item) => item.id === mediaId);
      },

      setMediaWaveform: (mediaId: string, peaks: Float32Array) => {
        const { project } = get();
        if (!peaks || peaks.length === 0) return; // never cache an empty waveform
        const index = project.mediaLibrary.items.findIndex(
          (item) => item.id === mediaId,
        );
        if (index === -1 || (project.mediaLibrary.items[index].waveformData?.length ?? 0) > 0) {
          return;
        }
        const items = [...project.mediaLibrary.items];
        items[index] = { ...items[index], waveformData: peaks };
        // No modifiedAt bump: waveformData is runtime-only (stripped by
        // the serializer) so patching it must not trigger an autosave.
        set({
          project: {
            ...project,
            mediaLibrary: { ...project.mediaLibrary, items },
          },
        });
      },

      setMediaBlob: (mediaId: string, blob: Blob) => {
        const { project } = get();
        const index = project.mediaLibrary.items.findIndex(
          (item) => item.id === mediaId,
        );
        if (index === -1 || project.mediaLibrary.items[index].blob instanceof Blob) {
          return; // already has bytes — don't clobber
        }
        const items = [...project.mediaLibrary.items];
        items[index] = { ...items[index], blob };
        // Runtime-only, no modifiedAt bump (blobs are stripped on save).
        // Flipping item.blob null→Blob is what retriggers the lazy waveform/
        // filmstrip effects (their dep arrays watch !!mediaItem.blob) and
        // feeds playback, instead of every consumer re-fetching the bytes.
        set({
          project: {
            ...project,
            mediaLibrary: { ...project.mediaLibrary, items },
          },
        });
      },

      healClipDurationFromMedia: (clipId, mediaId, realDuration) => {
        if (!(realDuration > 0)) return;
        const { project } = get();
        const item = project.mediaLibrary.items.find((m) => m.id === mediaId);
        if (!item || item.type !== "audio") return;
        let target: any = null;
        let ownerTrack: any = null;
        for (const t of project.timeline.tracks) {
          const c = t.clips.find((cl) => cl.id === clipId);
          if (c) { target = c; ownerTrack = t; break; }
        }
        if (!target || !ownerTrack) return;
        const recorded = item.metadata?.duration ?? 0;
        const inP = target.inPoint ?? 0;
        const outP = target.outPoint ?? inP + target.duration;
        // Full untrimmed take = starts at source 0 and spans exactly its
        // (wrong) recorded length. Only then do we auto-extend — a user's
        // deliberate trim window is left alone.
        const isFullTake =
          inP <= 0.05 &&
          Math.abs(outP - inP - target.duration) < 0.05 &&
          Math.abs(target.duration - recorded) < 0.3;
        // Guard against noise: only heal an EGREGIOUS shortfall (e.g. 11s
        // saved as 1s), never a rounding difference.
        const tooShort =
          realDuration > target.duration + 1 && realDuration > target.duration * 1.5;
        const metaWrong = Math.abs(recorded - realDuration) > 0.5;
        if (!metaWrong && !(isFullTake && tooShort)) return;
        // Extend a full take up to the real length, but never past the next
        // clip on this track (no overlap, no ripple).
        const nextStart = ownerTrack.clips
          .filter((c: any) => c.id !== clipId && c.startTime > target.startTime)
          .reduce((m: number, c: any) => Math.min(m, c.startTime), Infinity);
        const room = Number.isFinite(nextStart) ? nextStart - target.startTime : realDuration;
        const newDur =
          isFullTake && tooShort
            ? Math.max(target.duration, Math.min(realDuration, room))
            : target.duration;
        set({
          project: {
            ...project,
            mediaLibrary: {
              ...project.mediaLibrary,
              items: project.mediaLibrary.items.map((m) =>
                m.id === mediaId
                  ? { ...m, metadata: { ...m.metadata, duration: realDuration } }
                  : m,
              ),
            },
            timeline: {
              ...project.timeline,
              tracks: project.timeline.tracks.map((t) => ({
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId ? { ...c, duration: newDur, outPoint: inP + newDur } : c,
                ),
              })),
            },
            modifiedAt: Date.now(),
          },
        });
      },

      setMediaFilmstrip: (mediaId, thumbs) => {
        const { project } = get();
        const index = project.mediaLibrary.items.findIndex(
          (item) => item.id === mediaId,
        );
        if (
          index === -1 ||
          (project.mediaLibrary.items[index].filmstripThumbnails?.length ?? 0) > 0
        ) {
          return;
        }
        const items = [...project.mediaLibrary.items];
        items[index] = { ...items[index], filmstripThumbnails: thumbs };
        // Mirrors setMediaWaveform: runtime-only patch, no modifiedAt bump
        // (blob: thumb URLs are session-scoped; recovery strips dead ones
        // and this regenerates lazily).
        set({
          project: {
            ...project,
            mediaLibrary: { ...project.mediaLibrary, items },
          },
        });
      },

      addPlaceholderMedia: (item: MediaItem) => {
        const { project } = get();
        set({
          project: {
            ...project,
            mediaLibrary: {
              ...project.mediaLibrary,
              items: [...project.mediaLibrary.items, item],
            },
            modifiedAt: Date.now(),
          },
        });
      },

      setKieAIItemState: (mediaId: string, isPending: boolean, kieaiError: boolean) => {
        const { project } = get();
        const updatedItems = project.mediaLibrary.items.map((item) =>
          item.id === mediaId ? { ...item, isPending, kieaiError } : item,
        );
        set({
          project: {
            ...project,
            mediaLibrary: { ...project.mediaLibrary, items: updatedItems },
            modifiedAt: Date.now(),
          },
        });
      },

      replacePlaceholderMedia: async (mediaId: string, blob: Blob, name: string) => {
        const { project } = get();

        // For images use createImageBitmap (no mediaBridge dependency).
        // This avoids WASM initialisation races and works immediately in any context.
        let thumbnailUrl: string | null = null;
        let width = 0;
        let height = 0;

        if (blob.size > 0 && blob.type.startsWith("image/")) {
          try {
            const bitmap = await createImageBitmap(blob);
            width = bitmap.width;
            height = bitmap.height;

            const THUMB_SIZE = 320;
            const scale = Math.min(THUMB_SIZE / bitmap.width, THUMB_SIZE / bitmap.height, 1);
            const tw = Math.round(bitmap.width * scale);
            const th = Math.round(bitmap.height * scale);

            const canvas = new OffscreenCanvas(tw, th);
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(bitmap, 0, 0, tw, th);
            bitmap.close();

            const thumbBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });
            thumbnailUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(thumbBlob);
            });
          } catch (thumbErr) {
            console.warn("[ProjectStore] KieAI thumbnail generation failed:", thumbErr);
          }
        }

        const file = new File([blob], name, { type: blob.type || "image/png" });

        const updatedItem: MediaItem = {
          id: mediaId,
          name,
          type: "image",
          fileHandle: null,
          blob: file,
          metadata: {
            duration: 0,
            width,
            height,
            frameRate: 0,
            codec: "",
            sampleRate: 0,
            channels: 0,
            fileSize: file.size,
          },
          thumbnailUrl,
          waveformData: null,
          isPlaceholder: false,
          isPending: false,
        };

        const updatedItems = project.mediaLibrary.items.map((item) =>
          item.id === mediaId ? updatedItem : item,
        );

        set({
          project: {
            ...project,
            mediaLibrary: { ...project.mediaLibrary, items: updatedItems },
            modifiedAt: Date.now(),
          },
        });

        try {
          await saveMediaBlob(project.id, mediaId, file, updatedItem.metadata);
        } catch (err) {
          console.error("[ProjectStore] Failed to persist KieAI result blob:", err);
        }
      },

      // Track actions
      addTrack: async (
        trackType: "video" | "audio" | "image" | "text" | "graphics",
        position?: number,
      ) => {
        const { project, actionExecutor } = get();

        // FOUNDATION FIX (F5): apply in place (no pre-clone) so concurrent
        // callers can't clone the same stale base and drop one another's edit;
        // the executor serializes execute() and F4 rolls back on failure.
        const action: Action = {
          type: "track/add",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { trackType, position },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project, modifiedAt: Date.now() } });
        }
        return result;
      },

      removeTrack: async (trackId: string) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "track/remove",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { trackId },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({
            project: {
              ...project,
              timeline: { ...project.timeline },
              modifiedAt: Date.now(),
            },
          });
        }
        return result;
      },

      renameTrack: (trackId: string, name: string) => {
        const { project } = get();
        const trimmed = name.trim();
        if (!trimmed) return;
        set({
          project: {
            ...project,
            timeline: {
              ...project.timeline,
              tracks: project.timeline.tracks.map((t) =>
                t.id === trackId ? { ...t, name: trimmed } : t
              ),
            },
            modifiedAt: Date.now(),
          },
        });
      },

      reorderTrack: async (trackId: string, newPosition: number) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "track/reorder",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { trackId, newPosition },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project, modifiedAt: Date.now() } });
        }
        return result;
      },

      lockTrack: async (trackId: string, locked: boolean) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "track/lock",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { trackId, locked },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      hideTrack: async (trackId: string, hidden: boolean) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "track/hide",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { trackId, hidden },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      muteTrack: async (trackId: string, muted: boolean) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "track/mute",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { trackId, muted },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      soloTrack: async (trackId: string, solo: boolean) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "track/solo",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { trackId, solo },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      getTrack: (trackId: string) => {
        const { project } = get();
        return project.timeline.tracks.find((track) => track.id === trackId);
      },

      // Clip actions
      addClip: async (
        trackId: string,
        mediaId: string,
        startTime: number,
        duration?: number,
        opts?: {
          transform?: Partial<Transform>;
          keyframes?: Keyframe[];
          blendMode?: import("@openreel/core").BlendMode;
        },
      ) => {
        const { project, actionExecutor } = get();

        // FOUNDATION FIX (F5): apply in place (no pre-clone) so concurrent adds
        // can't clone the same stale base and drop one another's clip; the
        // executor serializes execute() and F4 rolls back on failure.
        const action: Action = {
          type: "clip/add",
          id: uuidv4(),
          timestamp: Date.now(),
          params: {
            trackId,
            mediaId,
            startTime,
            // clip/add honours an explicit duration (images/graphics
            // default to 5s otherwise) — used for lyric-timed stills.
            ...(typeof duration === "number" && duration > 0 ? { duration } : {}),
            // Optional initial transform / keyframes / blend so the clip is
            // placed WITH its motion in ONE undoable action.
            ...(opts?.transform ? { transform: opts.transform } : {}),
            ...(opts?.keyframes ? { keyframes: opts.keyframes } : {}),
            ...(opts?.blendMode ? { blendMode: opts.blendMode } : {}),
          },
        };

        const result = await actionExecutor.execute(action, project);

        if (result.success) {
          set({ project: { ...project, modifiedAt: Date.now() } });
        }
        return result;
      },

      addClipToNewTrack: async (mediaId: string, startTime?: number) => {
        const { project, addTrack, getMediaItem } = get();

        const mediaItem = getMediaItem(mediaId);
        if (!mediaItem) {
          return {
            success: false,
            error: {
              code: "MEDIA_NOT_FOUND" as const,
              message: "Media item not found",
            },
          };
        }

        let trackType: "video" | "audio" | "image" | "text" | "graphics";
        if (mediaItem.type === "video") {
          trackType = "video";
        } else if (mediaItem.type === "audio") {
          trackType = "audio";
        } else if (mediaItem.type === "image") {
          trackType = "image";
        } else {
          trackType = "video";
        }

        const clipStartTime =
          startTime !== undefined
            ? startTime
            : calculateTimelineDuration(project);

        const trackResult = await addTrack(trackType);
        if (!trackResult.success) {
          return trackResult;
        }

        const { project: updatedProject, actionExecutor: exec } = get();
        const newTrack = updatedProject.timeline.tracks.find(
          (t) => t.clips.length === 0 && t.type === trackType,
        );

        if (!newTrack) {
          return {
            success: false,
            error: {
              code: "TRACK_NOT_FOUND" as const,
              message: "Could not find newly created track",
            },
          };
        }

        const projectCopy = structuredClone(updatedProject);
        const action: Action = {
          type: "clip/add",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { trackId: newTrack.id, mediaId, startTime: clipStartTime },
        };

        const result = await exec.execute(action, projectCopy);

        if (result.success) {
          const finalProject: Project = {
            ...projectCopy,
            modifiedAt: Date.now(),
          };
          set({ project: finalProject });
        }
        return result;
      },

      separateAudio: async (clipId: string) => {
        const { project, actionExecutor } = get();

        const videoClip = project.timeline.tracks
          .flatMap((t) => t.clips)
          .find((c) => c.id === clipId);

        if (!videoClip) {
          return {
            success: false,
            error: { code: "CLIP_NOT_FOUND" as const, message: "Clip not found" },
          };
        }

        const mediaItem = project.mediaLibrary.items.find(
          (m) => m.id === videoClip.mediaId,
        );

        if (
          !mediaItem ||
          mediaItem.type !== "video" ||
          !mediaItem.metadata?.channels ||
          mediaItem.metadata.channels === 0
        ) {
          return {
            success: false,
            error: {
              code: "MEDIA_NOT_FOUND" as const,
              message: "Media has no audio to separate",
            },
          };
        }

        // Determine how many audio tracks to separate
        const audioTrackCount = mediaItem.metadata.audioTrackCount ?? 1;

        // Apply all track/add and clip/add actions on a single project copy to
        // avoid race conditions from multiple store updates.
        const projectCopy = structuredClone(project);

        // Add new audio timeline tracks as needed (reuse existing ones)
        const existingAudioCount = projectCopy.timeline.tracks.filter(
          (t) => t.type === "audio",
        ).length;

        const newTrackIds: string[] = [];
        for (let i = existingAudioCount; i < audioTrackCount; i++) {
          const newTrackId = uuidv4();
          newTrackIds.push(newTrackId);
          const trackAction: Action = {
            type: "track/add",
            id: uuidv4(),
            timestamp: Date.now(),
            params: { trackType: "audio", trackId: newTrackId },
          };
          const trackResult = await actionExecutor.execute(trackAction, projectCopy);
          if (!trackResult.success) {
            return {
              success: false,
              error: {
                code: "TRACK_NOT_FOUND" as const,
                message: "Failed to create audio track",
              },
            };
          }
        }

        // Capture audio track IDs from the (now-updated) projectCopy
        const audioTimelineTracks = projectCopy.timeline.tracks.filter(
          (t) => t.type === "audio",
        );

        if (audioTimelineTracks.length === 0) {
          return {
            success: false,
            error: {
              code: "TRACK_NOT_FOUND" as const,
              message: "Could not find or create audio track",
            },
          };
        }

        // Add one clip per audio track in the source file
        let lastResult: ActionResult = {
          success: true,
        };

        for (let trackIdx = 0; trackIdx < audioTrackCount; trackIdx++) {
          const targetTrack = audioTimelineTracks[trackIdx];
          if (!targetTrack) break;

          const action: Action = {
            type: "clip/add",
            id: uuidv4(),
            timestamp: Date.now(),
            params: {
              trackId: targetTrack.id,
              mediaId: videoClip.mediaId,
              startTime: videoClip.startTime,
              audioTrackIndex: trackIdx,
            },
          };

          lastResult = await actionExecutor.execute(action, projectCopy);

          if (!lastResult.success) {
            break;
          }
        }

        if (lastResult.success) {
          const finalProject: Project = {
            ...projectCopy,
            modifiedAt: Date.now(),
          };
          set({ project: finalProject });
        }

        return lastResult;
      },

      removeClip: async (clipId: string) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "clip/remove",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { clipId },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      moveClip: async (clipId: string, startTime: number, trackId?: string) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "clip/move",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { clipId, startTime, trackId },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      trimClip: async (clipId: string, inPoint?: number, outPoint?: number, startTime?: number) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "clip/trim",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { clipId, inPoint, outPoint, ...(startTime !== undefined ? { startTime } : {}) },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      splitClip: async (clipId: string, time: number) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "clip/split",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { clipId, time },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      rippleDeleteClip: async (clipId: string) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "clip/rippleDelete",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { clipId },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      slipClip: async (clipId: string, delta: number) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "clip/slip",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { clipId, delta },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      slideClip: async (clipId: string, delta: number) => {
        const { project, actionExecutor, getClip } = get();
        const clip = getClip(clipId);
        if (!clip) {
          return {
            success: false,
            error: {
              code: "INVALID_PARAMS" as const,
              message: "Clip not found",
            },
          };
        }

        const track = project.timeline.tracks.find((t) =>
          t.clips.some((c) => c.id === clipId),
        );
        if (!track) {
          return {
            success: false,
            error: {
              code: "INVALID_PARAMS" as const,
              message: "Track not found",
            },
          };
        }

        const sortedClips = [...track.clips].sort(
          (a, b) => a.startTime - b.startTime,
        );
        const clipIndex = sortedClips.findIndex((c) => c.id === clipId);
        const prevClip = clipIndex > 0 ? sortedClips[clipIndex - 1] : undefined;
        const nextClip =
          clipIndex < sortedClips.length - 1
            ? sortedClips[clipIndex + 1]
            : undefined;

        const action: Action = {
          type: "clip/slide",
          id: uuidv4(),
          timestamp: Date.now(),
          params: {
            clipId,
            delta,
            prevClipId: prevClip?.id,
            nextClipId: nextClip?.id,
          },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      rollEdit: async (
        leftClipId: string,
        rightClipId: string,
        delta: number,
      ) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "clip/roll",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { leftClipId, rightClipId, delta },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      trimToPlayhead: async (
        clipId: string,
        playheadTime: number,
        trimStart: boolean,
      ) => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "clip/trimToPlayhead",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { clipId, playheadTime, trimStart },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      getClip: (clipId: string) => {
        const { project } = get();
        for (const track of project.timeline.tracks) {
          const clip = track.clips.find((c) => c.id === clipId);
          if (clip) return clip;
        }
        return undefined;
      },

      /**
       * Update a text-clip (caption / title overlay) through ActionExecutor
       * so the change enters ActionHistory and is undoable. Captures the
       * current values BEFORE the action runs so the inverse-generator
       * has the data it needs — without `previous`, undo treats the
       * entry as no-op.
       *
       * Use this from EVERY caption mutation site (UI panels, voidspace
       * postMessage bridge, agent tools). Calling titleEngine.updateTextClip
       * directly bypasses history and breaks both manual undo AND the
       * chat's per-message snapshot revert.
       */
      updateTextClip: async (
        clipId: string,
        updates: Record<string, unknown>,
      ): Promise<ActionResult> => {
        const { project, actionExecutor } = get();
        const engine = useEngineStore.getState().getTitleEngine();
        if (!engine) {
          return {
            success: false,
            error: { code: "INVALID_PARAMS", message: "title engine not mounted" },
          };
        }
        const before = engine.getTextClip(clipId);
        if (!before) {
          return {
            success: false,
            error: { code: "CLIP_NOT_FOUND", message: `no text clip ${clipId}` },
          };
        }
        // Capture only the fields being changed — keeps the inverse
        // payload tight and avoids accidental "restore field that
        // wasn't touched" undo behaviour.
        const previous: Record<string, unknown> = {};
        for (const k of Object.keys(updates)) {
          previous[k] = (before as unknown as Record<string, unknown>)[k];
        }
        const action: Action = {
          type: "text/update",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { clipId, updates, previous },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project, modifiedAt: Date.now() } });
        }
        return result;
      },

      /**
       * Add a text-clip through ActionExecutor. Caller passes the
       * fully-formed TextClip (engine.createTextClip already gives
       * one — pass its result here to register history). Inverse is
       * text/remove(clipId).
       */
      addTextClip: async (textClip: any): Promise<ActionResult> => {
        const { project, actionExecutor } = get();
        const action: Action = {
          type: "text/add",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { textClip },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project, modifiedAt: Date.now() } });
        }
        return result;
      },

      /**
       * Remove a text-clip through ActionExecutor. Captures the full
       * clip data into `previous` so undo can fully reconstruct it.
       */
      removeTextClip: async (clipId: string): Promise<ActionResult> => {
        const { project, actionExecutor } = get();
        const engine = useEngineStore.getState().getTitleEngine();
        const previous = engine?.getTextClip(clipId);
        if (!previous) {
          return {
            success: false,
            error: { code: "CLIP_NOT_FOUND", message: `no text clip ${clipId}` },
          };
        }
        const action: Action = {
          type: "text/remove",
          id: uuidv4(),
          timestamp: Date.now(),
          // Deep-clone previous so engine-side mutations after this
          // call (extremely unlikely on an already-removed clip but
          // cheap insurance) can't taint the inverse payload.
          params: { clipId, previous: JSON.parse(JSON.stringify(previous)) },
        };
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project, modifiedAt: Date.now() } });
        }
        return result;
      },

      copyClips: (clipIds: string[]) => {
        const { getClip } = get();
        const clips = clipIds
          .map(getClip)
          .filter((c): c is Clip => c !== undefined);
        const copiedClips = clips.map((clip) => ({
          ...JSON.parse(JSON.stringify(clip)),
        }));
        set({ clipboard: copiedClips });
      },

      pasteClips: async (trackId: string, startTime: number) => {
        const { clipboard, project, actionExecutor } = get();
        const results: ActionResult[] = [];

        if (clipboard.length === 0) {
          return [
            {
              success: false,
              error: {
                code: "INVALID_PARAMS" as const,
                message: "Clipboard is empty",
              },
            },
          ];
        }

        const minStartTime = Math.min(...clipboard.map((c) => c.startTime));

        for (const clip of clipboard) {
          const offset = clip.startTime - minStartTime;
          const newStartTime = startTime + offset;

          const action: Action = {
            type: "clip/add",
            id: uuidv4(),
            timestamp: Date.now(),
            params: {
              trackId,
              mediaId: clip.mediaId,
              startTime: newStartTime,
              duration: clip.duration,
              inPoint: clip.inPoint,
              outPoint: clip.outPoint,
              volume: clip.volume,
              effects: clip.effects,
            },
          };
          const result = await actionExecutor.execute(action, project);
          results.push(result);
        }

        set({ project: { ...project } });
        return results;
      },

      duplicateClip: async (clipId: string) => {
        const { getClip, project, addTrack } = get();
        const clip = getClip(clipId);
        if (!clip) {
          return {
            success: false,
            error: {
              code: "INVALID_PARAMS" as const,
              message: "Clip not found",
            },
          };
        }

        const track = project.timeline.tracks.find((t) =>
          t.clips.some((c) => c.id === clipId),
        );
        if (!track) {
          return {
            success: false,
            error: {
              code: "INVALID_PARAMS" as const,
              message: "Track not found",
            },
          };
        }

        const trackResult = await addTrack(track.type);
        if (!trackResult.success) {
          return trackResult;
        }

        const { project: updatedProject, actionExecutor } = get();
        const newTrack = updatedProject.timeline.tracks.find(
          (t) => t.clips.length === 0 && t.type === track.type,
        );

        if (!newTrack) {
          return {
            success: false,
            error: {
              code: "TRACK_NOT_FOUND" as const,
              message: "Could not find newly created track",
            },
          };
        }

        const projectCopy = structuredClone(updatedProject);
        const action: Action = {
          type: "clip/add",
          id: uuidv4(),
          timestamp: Date.now(),
          params: {
            trackId: newTrack.id,
            mediaId: clip.mediaId,
            startTime: clip.startTime,
            duration: clip.duration,
            inPoint: clip.inPoint,
            outPoint: clip.outPoint,
            volume: clip.volume,
            effects: structuredClone(clip.effects),
            keyframes: clip.keyframes ? structuredClone(clip.keyframes) : undefined,
            transform: clip.transform ? structuredClone(clip.transform) : undefined,
          },
        };

        const result = await actionExecutor.execute(action, projectCopy);
        if (result.success) {
          const finalProject: Project = {
            ...projectCopy,
            modifiedAt: Date.now(),
          };
          set({ project: finalProject });
        }
        return result;
      },

      copyEffects: (clipId: string) => {
        const { getClip } = get();
        const clip = getClip(clipId);
        if (clip) {
          const copiedEffects = JSON.parse(JSON.stringify(clip.effects));
          set({ copiedEffects });
        }
      },

      pasteEffects: async (clipId: string) => {
        const { copiedEffects, project, actionExecutor } = get();
        if (copiedEffects.length === 0) {
          return {
            success: false,
            error: {
              code: "INVALID_PARAMS" as const,
              message: "No effects in clipboard",
            },
          };
        }

        const results: ActionResult[] = [];
        for (const effect of copiedEffects) {
          const action: Action = {
            type: "effect/add",
            id: uuidv4(),
            timestamp: Date.now(),
            params: {
              clipId,
              effectType: effect.type,
              params: effect.params,
            },
          };
          const result = await actionExecutor.execute(action, project);
          results.push(result);
        }

        set({ project: { ...project } });
        return (
          results[0] || {
            success: false,
            error: { code: "UNKNOWN" as const, message: "No results" },
          }
        );
      },

      updateClipTransform: (
        clipId: string,
        transformUpdate: Partial<Transform>,
      ) => {
        const { project } = get();

        // Try timeline clips first
        let found = false;
        const newTracks = project.timeline.tracks.map((track) => {
          const clipIndex = track.clips.findIndex((c) => c.id === clipId);
          if (clipIndex === -1) return track;

          found = true;
          const clip = track.clips[clipIndex];
          const newTransform = {
            ...clip.transform,
            ...transformUpdate,
            position: {
              ...clip.transform.position,
              ...(transformUpdate.position || {}),
            },
            scale: {
              ...clip.transform.scale,
              ...(transformUpdate.scale || {}),
            },
            anchor: {
              ...clip.transform.anchor,
              ...(transformUpdate.anchor || {}),
            },
          };

          const newClips = [...track.clips];
          newClips[clipIndex] = { ...clip, transform: newTransform };

          return { ...track, clips: newClips };
        });

        if (found) {
          set({
            project: {
              ...project,
              timeline: { ...project.timeline, tracks: newTracks },
              modifiedAt: Date.now(),
            },
          });
          return true;
        }

        // Try text clips
        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (titleEngine) {
          const textClip = titleEngine.getTextClip(clipId);
          if (textClip) {
            const newTransform = {
              ...textClip.transform,
              ...transformUpdate,
              position: {
                ...textClip.transform.position,
                ...(transformUpdate.position || {}),
              },
              scale: {
                ...textClip.transform.scale,
                ...(transformUpdate.scale || {}),
              },
              anchor: {
                ...textClip.transform.anchor,
                ...(transformUpdate.anchor || {}),
              },
            };
            titleEngine.updateTextClip(clipId, { transform: newTransform });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }
        }

        // Try shape/SVG clips
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (graphicsEngine) {
          const shapeClip = graphicsEngine.getShapeClip(clipId);
          if (shapeClip) {
            const newTransform = {
              ...shapeClip.transform,
              ...transformUpdate,
              position: {
                ...shapeClip.transform.position,
                ...(transformUpdate.position || {}),
              },
              scale: {
                ...shapeClip.transform.scale,
                ...(transformUpdate.scale || {}),
              },
              anchor: {
                ...shapeClip.transform.anchor,
                ...(transformUpdate.anchor || {}),
              },
            };
            graphicsEngine.updateShapeClip(clipId, { transform: newTransform });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }

          const svgClip = graphicsEngine.getSVGClip(clipId);
          if (svgClip) {
            const newTransform = {
              ...svgClip.transform,
              ...transformUpdate,
              position: {
                ...svgClip.transform.position,
                ...(transformUpdate.position || {}),
              },
              scale: {
                ...svgClip.transform.scale,
                ...(transformUpdate.scale || {}),
              },
              anchor: {
                ...svgClip.transform.anchor,
                ...(transformUpdate.anchor || {}),
              },
            };
            graphicsEngine.updateSVGClip(clipId, { transform: newTransform });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }
        }

        return false;
      },

      updateClipBlendMode: (clipId: string, blendMode) => {
        const { project } = get();

        // Try regular timeline clips first
        let found = false;
        const newTracks = project.timeline.tracks.map((track) => {
          const clipIndex = track.clips.findIndex((c) => c.id === clipId);
          if (clipIndex === -1) return track;

          found = true;
          const clip = track.clips[clipIndex];
          const newClips = [...track.clips];
          newClips[clipIndex] = { ...clip, blendMode };

          return { ...track, clips: newClips };
        });

        if (found) {
          set({
            project: {
              ...project,
              timeline: { ...project.timeline, tracks: newTracks },
              modifiedAt: Date.now(),
            },
          });
          return true;
        }

        // Try text clips
        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (titleEngine) {
          const textClip = titleEngine.getTextClip(clipId);
          if (textClip) {
            titleEngine.updateTextClip(clipId, { blendMode });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }
        }

        // Try graphics clips
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (graphicsEngine) {
          const shapeClip = graphicsEngine.getShapeClip(clipId);
          if (shapeClip) {
            graphicsEngine.updateShapeClip(clipId, { blendMode });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }
          const svgClip = graphicsEngine.getSVGClip(clipId);
          if (svgClip) {
            graphicsEngine.updateSVGClip(clipId, { blendMode });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }
        }

        return false;
      },

      updateClipBlendOpacity: (clipId: string, opacity: number) => {
        const { project } = get();

        if (opacity < 0 || opacity > 100) {
          console.error("Blend opacity must be between 0 and 100");
          return false;
        }

        let found = false;
        const newTracks = project.timeline.tracks.map((track) => {
          const clipIndex = track.clips.findIndex((c) => c.id === clipId);
          if (clipIndex === -1) return track;

          found = true;
          const clip = track.clips[clipIndex];
          const newClips = [...track.clips];
          newClips[clipIndex] = { ...clip, blendOpacity: opacity };

          return { ...track, clips: newClips };
        });

        if (found) {
          set({
            project: {
              ...project,
              timeline: { ...project.timeline, tracks: newTracks },
              modifiedAt: Date.now(),
            },
          });
          return true;
        }

        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (titleEngine) {
          const textClip = titleEngine.getTextClip(clipId);
          if (textClip) {
            titleEngine.updateTextClip(clipId, { blendOpacity: opacity });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }
        }

        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (graphicsEngine) {
          const shapeClip = graphicsEngine.getShapeClip(clipId);
          if (shapeClip) {
            graphicsEngine.updateShapeClip(clipId, { blendOpacity: opacity });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }

          const svgClip = graphicsEngine.getSVGClip(clipId);
          if (svgClip) {
            graphicsEngine.updateSVGClip(clipId, { blendOpacity: opacity });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }
        }

        return false;
      },

      updateClipEmphasisAnimation: (clipId: string, emphasisAnimation) => {
        const { project } = get();

        let found = false;
        const newTracks = project.timeline.tracks.map((track) => {
          const clipIndex = track.clips.findIndex((c) => c.id === clipId);
          if (clipIndex === -1) return track;

          found = true;
          const clip = track.clips[clipIndex];
          const newClips = [...track.clips];
          newClips[clipIndex] = { ...clip, emphasisAnimation };

          return { ...track, clips: newClips };
        });

        if (found) {
          set({
            project: {
              ...project,
              timeline: { ...project.timeline, tracks: newTracks },
              modifiedAt: Date.now(),
            },
          });
          return true;
        }

        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (titleEngine) {
          const textClip = titleEngine.getTextClip(clipId);
          if (textClip) {
            titleEngine.updateTextClip(clipId, { emphasisAnimation });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }
        }

        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (graphicsEngine) {
          const shapeClip = graphicsEngine.getShapeClip(clipId);
          if (shapeClip) {
            graphicsEngine.updateShapeClip(clipId, { emphasisAnimation });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }

          const svgClip = graphicsEngine.getSVGClip(clipId);
          if (svgClip) {
            graphicsEngine.updateSVGClip(clipId, { emphasisAnimation });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }

          const stickerClip = graphicsEngine.getStickerClip(clipId);
          if (stickerClip) {
            graphicsEngine.updateStickerClip(clipId, { emphasisAnimation });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }
        }

        return false;
      },

      updateClipRotate3D: (
        clipId: string,
        rotate3d: { x: number; y: number; z: number },
      ) => {
        const { project } = get();

        let found = false;
        const newTracks = project.timeline.tracks.map((track) => {
          const clipIndex = track.clips.findIndex((c) => c.id === clipId);
          if (clipIndex === -1) return track;

          found = true;
          const clip = track.clips[clipIndex];
          const newClips = [...track.clips];
          newClips[clipIndex] = {
            ...clip,
            transform: { ...clip.transform, rotate3d },
          };

          return { ...track, clips: newClips };
        });

        if (found) {
          set({
            project: {
              ...project,
              timeline: { ...project.timeline, tracks: newTracks },
              modifiedAt: Date.now(),
            },
          });
          return true;
        }

        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (titleEngine) {
          const textClip = titleEngine.getTextClip(clipId);
          if (textClip) {
            titleEngine.updateTextClip(clipId, {
              transform: { ...textClip.transform, rotate3d },
            });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }
        }

        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (graphicsEngine) {
          const shapeClip = graphicsEngine.getShapeClip(clipId);
          if (shapeClip) {
            graphicsEngine.updateShapeClip(clipId, {
              transform: { ...shapeClip.transform, rotate3d },
            });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }

          const svgClip = graphicsEngine.getSVGClip(clipId);
          if (svgClip) {
            graphicsEngine.updateSVGClip(clipId, {
              transform: { ...svgClip.transform, rotate3d },
            });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }
        }

        return false;
      },

      updateClipPerspective: (clipId: string, perspective: number) => {
        const { project } = get();

        if (perspective < 0) {
          console.error("Perspective must be non-negative");
          return false;
        }

        let found = false;
        const newTracks = project.timeline.tracks.map((track) => {
          const clipIndex = track.clips.findIndex((c) => c.id === clipId);
          if (clipIndex === -1) return track;

          found = true;
          const clip = track.clips[clipIndex];
          const newClips = [...track.clips];
          newClips[clipIndex] = {
            ...clip,
            transform: { ...clip.transform, perspective },
          };

          return { ...track, clips: newClips };
        });

        if (found) {
          set({
            project: {
              ...project,
              timeline: { ...project.timeline, tracks: newTracks },
              modifiedAt: Date.now(),
            },
          });
          return true;
        }

        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (titleEngine) {
          const textClip = titleEngine.getTextClip(clipId);
          if (textClip) {
            titleEngine.updateTextClip(clipId, {
              transform: { ...textClip.transform, perspective },
            });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }
        }

        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (graphicsEngine) {
          const shapeClip = graphicsEngine.getShapeClip(clipId);
          if (shapeClip) {
            graphicsEngine.updateShapeClip(clipId, {
              transform: { ...shapeClip.transform, perspective },
            });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }

          const svgClip = graphicsEngine.getSVGClip(clipId);
          if (svgClip) {
            graphicsEngine.updateSVGClip(clipId, {
              transform: { ...svgClip.transform, perspective },
            });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }
        }

        return false;
      },

      updateClipTransformStyle: (
        clipId: string,
        transformStyle: "flat" | "preserve-3d",
      ) => {
        const { project } = get();

        let found = false;
        const newTracks = project.timeline.tracks.map((track) => {
          const clipIndex = track.clips.findIndex((c) => c.id === clipId);
          if (clipIndex === -1) return track;

          found = true;
          const clip = track.clips[clipIndex];
          const newClips = [...track.clips];
          newClips[clipIndex] = {
            ...clip,
            transform: { ...clip.transform, transformStyle },
          };

          return { ...track, clips: newClips };
        });

        if (found) {
          set({
            project: {
              ...project,
              timeline: { ...project.timeline, tracks: newTracks },
              modifiedAt: Date.now(),
            },
          });
          return true;
        }

        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (titleEngine) {
          const textClip = titleEngine.getTextClip(clipId);
          if (textClip) {
            titleEngine.updateTextClip(clipId, {
              transform: { ...textClip.transform, transformStyle },
            });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }
        }

        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (graphicsEngine) {
          const shapeClip = graphicsEngine.getShapeClip(clipId);
          if (shapeClip) {
            graphicsEngine.updateShapeClip(clipId, {
              transform: { ...shapeClip.transform, transformStyle },
            });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }

          const svgClip = graphicsEngine.getSVGClip(clipId);
          if (svgClip) {
            graphicsEngine.updateSVGClip(clipId, {
              transform: { ...svgClip.transform, transformStyle },
            });
            set({ project: { ...project, modifiedAt: Date.now() } });
            return true;
          }
        }

        return false;
      },

      // Undo/Redo
      undo: async () => {
        const { project, actionExecutor, actionHistory, clipUndoStack, clipRedoStack } = get();

        // Dual-stack undo/redo system: clipUndoStack handles graphics/text/svg/sticker clips created outside the main timeline
        // This prevents those creations from being mixed with ActionHistory which handles timeline operations.
        // TEMPORAL INTERLEAVE: take the clip-creation stack only when it is at
        // least as recent as the newest ActionHistory entry (moves/trims/etc.).
        // Otherwise a move made AFTER creating a caption would be shadowed —
        // Ctrl+Z would delete the caption instead of undoing the move. Defensive:
        // if either timestamp is missing, keep the legacy "clip stack first".
        const clipUndoTop = clipUndoStack[clipUndoStack.length - 1];
        const execUndoTs = actionHistory.peekUndoTimestamp();
        const takeClipUndo =
          clipUndoStack.length > 0 &&
          (execUndoTs == null ||
            clipUndoTop?.timestamp == null ||
            clipUndoTop.timestamp >= execUndoTs);
        if (takeClipUndo) {
          const entry = clipUndoStack[clipUndoStack.length - 1];
          let deleted = false;

          // Dispatch to appropriate engine based on clip type, then remove from engines' internal state
          if (entry.type === "shape") {
            const graphicsEngine = useEngineStore
              .getState()
              .getGraphicsEngine();
            if (graphicsEngine) {
              deleted = graphicsEngine.deleteShapeClip(entry.clipId);
            }
          } else if (entry.type === "text") {
            const titleEngine = useEngineStore.getState().getTitleEngine();
            if (titleEngine) {
              deleted = titleEngine.deleteTextClip(entry.clipId);
            }
          } else if (entry.type === "svg") {
            const graphicsEngine = useEngineStore
              .getState()
              .getGraphicsEngine();
            if (graphicsEngine) {
              deleted = graphicsEngine.deleteSVGClip(entry.clipId);
            }
          } else if (entry.type === "sticker") {
            const graphicsEngine = useEngineStore
              .getState()
              .getGraphicsEngine();
            if (graphicsEngine) {
              deleted = graphicsEngine.deleteStickerClip(entry.clipId);
            }
          }

          if (deleted) {
            // Move entry from undo to redo stack for redo support, pop from undo
            set({
              project: { ...project, modifiedAt: Date.now() },
              clipUndoStack: clipUndoStack.slice(0, -1),
              clipRedoStack: [...clipRedoStack, { ...entry, hadEmptyTrackUndo: false }],
            });

            // Check if the track is now empty and should also be undone
            const trackId = entry.trackId;
            const updatedProject = get().project;
            const track = updatedProject.timeline.tracks.find(t => t.id === trackId);

            if (track) {
              // Check if track has any remaining clips based on track type
              let trackHasClips = false;

              if (track.type === "text") {
                const titleEngine = useEngineStore.getState().getTitleEngine();
                const textClips = titleEngine?.getAllTextClips() || [];
                trackHasClips = textClips.some(c => c.trackId === trackId);
              } else if (track.type === "graphics") {
                const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
                const shapeClips = graphicsEngine?.getAllShapeClips() || [];
                const svgClips = graphicsEngine?.getAllSVGClips() || [];
                const stickerClips = graphicsEngine?.getAllStickerClips() || [];
                trackHasClips = [...shapeClips, ...svgClips, ...stickerClips].some(c => c.trackId === trackId);
              } else if (track.type === "video" || track.type === "audio" || track.type === "image") {
                // For video/audio/image tracks, check clips array directly
                trackHasClips = track.clips.length > 0;
              }

              // If track is empty, check if previous action was creating this track
              if (!trackHasClips) {
                const { actionHistory } = get();
                const lastEntry = actionHistory.peekUndo();
                const lastAction = lastEntry?.action;

                // Map clip entry type to track type
                type TrackType = "video" | "audio" | "image" | "text" | "graphics";
                const clipTypeToTrackType: Record<string, TrackType> = {
                  text: "text",
                  shape: "graphics",
                  svg: "graphics",
                  sticker: "graphics",
                };
                const expectedTrackType: TrackType = clipTypeToTrackType[entry.type] || (track.type as TrackType);
                const actionTrackType = lastAction?.params?.trackType as string | undefined;

                if (lastAction &&
                    lastAction.type === "track/add" &&
                    actionTrackType === expectedTrackType) {
                  // Also undo the track creation
                  const trackUndoResult = await actionExecutor.undo(get().project);
                  if (trackUndoResult.success) {
                    // Update the redo entry to indicate track was also undone
                    const updatedRedoStack = get().clipRedoStack;
                    if (updatedRedoStack.length > 0) {
                      const lastRedoEntry = updatedRedoStack[updatedRedoStack.length - 1];
                      set({
                        project: { ...get().project },
                        clipRedoStack: [
                          ...updatedRedoStack.slice(0, -1),
                          { ...lastRedoEntry, hadEmptyTrackUndo: true, trackType: expectedTrackType },
                        ],
                      });
                    }
                  }
                }
              }
            }

            return { success: true };
          }
        }

        // Fall back to action executor for timeline operations, track changes, media operations, etc.
        const result = await actionExecutor.undo(project);
        if (result.success) {
          // Bump modifiedAt so the hash-gated autosave persists the undone
          // state — previously an undo that changed no clip/track COUNT
          // (moves, effect tweaks, clip/applyState) was never written.
          set({ project: { ...project, modifiedAt: Date.now() } });
        }
        return result;
      },

      redo: async () => {
        const { project, actionExecutor, actionHistory, clipUndoStack, clipRedoStack } = get();

        // Inverse of undo: restore clip from redo stack by recreating it with saved clipData.
        // TEMPORAL INTERLEAVE (mirror of undo): redo re-applies undone actions
        // OLDEST-first, so take the clip-redo stack only when its top is at least
        // as OLD as the ActionHistory redo top. Defensive fallback to legacy
        // "clip stack first" when a timestamp is missing.
        const clipRedoTop = clipRedoStack[clipRedoStack.length - 1];
        const execRedoTs = actionHistory.peekRedoTimestamp();
        const takeClipRedo =
          clipRedoStack.length > 0 &&
          (execRedoTs == null ||
            clipRedoTop?.timestamp == null ||
            clipRedoTop.timestamp <= execRedoTs);
        if (takeClipRedo) {
          const entry = clipRedoStack[clipRedoStack.length - 1];
          let restored = false;
          let newTrackId: string | undefined;

          // If the track was also undone, redo the track creation first
          if (entry.hadEmptyTrackUndo && entry.trackType) {
            const trackRedoResult = await actionExecutor.redo(get().project);
            if (!trackRedoResult.success) {
              return trackRedoResult;
            }
            // Find the newly created track (most recent track of the same type)
            const updatedProject = get().project;
            const tracksOfType = updatedProject.timeline.tracks.filter(
              t => t.type === entry.trackType
            );
            if (tracksOfType.length > 0) {
              // The last track of this type should be the newly created one
              newTrackId = tracksOfType[tracksOfType.length - 1].id;
            }
            set({ project: { ...updatedProject } });
          }

          // Use the new track ID if track was recreated, otherwise use original
          const targetTrackId = newTrackId || entry.trackId;

          // Recreate the clip in the appropriate engine using saved clipData
          // Must use same parameters as original creation to ensure consistency
          if (entry.type === "shape") {
            const graphicsEngine = useEngineStore
              .getState()
              .getGraphicsEngine();
            if (graphicsEngine) {
              const shapeData = entry.clipData as ShapeClip;
              graphicsEngine.createShape(
                {
                  shapeType: shapeData.shapeType,
                  width: 200,
                  height: 200,
                  style: shapeData.style,
                },
                targetTrackId,
                shapeData.startTime,
                shapeData.duration,
              );
              restored = true;
            }
          } else if (entry.type === "text") {
            const titleEngine = useEngineStore.getState().getTitleEngine();
            if (titleEngine) {
              const textData = entry.clipData as TextClip;
              titleEngine.createTextClip({
                trackId: targetTrackId,
                startTime: textData.startTime,
                text: textData.text,
                duration: textData.duration,
                style: textData.style,
              });
              restored = true;
            }
          } else if (entry.type === "svg") {
            const graphicsEngine = useEngineStore
              .getState()
              .getGraphicsEngine();
            if (graphicsEngine) {
              const svgData = entry.clipData as SVGClip;
              graphicsEngine.importSVG(
                svgData.svgContent,
                targetTrackId,
                svgData.startTime,
                svgData.duration,
              );
              restored = true;
            }
          } else if (entry.type === "sticker") {
            const graphicsEngine = useEngineStore
              .getState()
              .getGraphicsEngine();
            if (graphicsEngine) {
              const stickerData = entry.clipData as StickerClip;
              graphicsEngine.addStickerClip({ ...stickerData, trackId: targetTrackId });
              restored = true;
            }
          }

          if (restored) {
            // Update the entry with new track ID for future undo/redo
            const updatedEntry = newTrackId
              ? { ...entry, trackId: newTrackId, clipData: { ...entry.clipData, trackId: newTrackId } }
              : entry;

            // Move entry from redo back to undo stack, pop from redo
            set({
              project: { ...get().project, modifiedAt: Date.now() },
              clipUndoStack: [...clipUndoStack, updatedEntry],
              clipRedoStack: clipRedoStack.slice(0, -1),
            });
            return { success: true };
          }
        }

        // Fall back to action executor for timeline operations
        const result = await actionExecutor.redo(project);
        if (result.success) {
          // Same rationale as undo(): make the redone state autosave-eligible.
          set({ project: { ...project, modifiedAt: Date.now() } });
        }
        return result;
      },

      canUndo: () => {
        const { actionHistory, clipUndoStack } = get();
        // Check both undo sources: clip-specific stack takes precedence, then global action history
        return clipUndoStack.length > 0 || actionHistory.canUndo();
      },

      canRedo: () => {
        const { actionHistory, clipRedoStack } = get();
        // Check both redo sources: clip-specific stack takes precedence, then global action history
        return clipRedoStack.length > 0 || actionHistory.canRedo();
      },

      restoreToSnapshot: async (snapshotId: string) => {
        const { actionHistory, actionExecutor } = get();
        const snap = actionHistory.getSnapshots().find((s) => s.id === snapshotId);
        if (!snap) {
          return { success: false, error: { code: "INVALID_PARAMS", message: "Snapshot not found" } };
        }
        const target = snap.stackIndex;
        let guard = 0;
        const MAX_STEPS = 5000;
        // Walk backwards: replay inverseActions until undoStack length matches.
        // undoGroup() may pop multiple entries when an auto-grouped sequence
        // exists, so re-read the size after each step instead of decrementing.
        while (actionHistory.getUndoStackSize() > target && guard++ < MAX_STEPS) {
          const r = await actionExecutor.undo(get().project);
          if (!r.success) break;
        }
        // Walk forward (when restoring to a snapshot ahead of current).
        while (actionHistory.getUndoStackSize() < target && guard++ < MAX_STEPS) {
          const r = await actionExecutor.redo(get().project);
          if (!r.success) break;
        }
        // Tick modifiedAt to push subscribers (autosave) and fan out a fresh project ref.
        set({ project: { ...get().project, modifiedAt: Date.now() } });
        return { success: true };
      },

      // Execute arbitrary action
      executeAction: async (action: Action) => {
        const { project, actionExecutor } = get();
        const result = await actionExecutor.execute(action, project);
        if (result.success) {
          set({ project: { ...project } });
        }
        return result;
      },

      // Computed values
      getTimelineDuration: () => {
        const { project } = get();
        return calculateTimelineDuration(project);
      },

      // Auto-save methods
      initializeAutoSave: async () => {
        await initializeAutoSave();
        autoSaveManager.start(
          () => {
            const { project } = get();
            const titleEngine = useEngineStore.getState().getTitleEngine();
            const graphicsEngine = useEngineStore.getState().getGraphicsEngine();

            // Video effects + color grading live in the EffectsBridge's
            // in-memory maps, NOT on the clips — without embedding them
            // here every agent/inspector-applied effect silently vanished
            // on reload while the autosave "succeeded".
            let effectsState: Record<string, unknown> | undefined;
            try {
              const eb = getEffectsBridge();
              const all = eb.serializeAllEffects();
              if (Object.keys(all).length > 0) effectsState = all;
            } catch { /* bridge unavailable — save proceeds without */ }

            return {
              ...project,
              textClips: titleEngine?.getAllTextClips() || [],
              shapeClips: graphicsEngine?.getAllShapeClips() || [],
              svgClips: graphicsEngine?.getAllSVGClips() || [],
              stickerClips: graphicsEngine?.getAllStickerClips() || [],
              ...(effectsState ? { effectsState } : {}),
            } as Project;
          },
          // Capture serialised ActionHistory alongside every autosave
          // so undo/redo + named snapshots survive page reloads. Without
          // this the chat's per-message rewind bookmarks become dangling
          // pointers the moment the tab closes — the bookmark holds a
          // stackIndex but the stack has been wiped.
          () => {
            try {
              const { actionHistory } = get();
              return JSON.stringify(actionHistory.serialize());
            } catch {
              return null;
            }
          },
        );

        // Subscribe to project state changes to mark as dirty for auto-save
        // Uses Zustand's subscribeWithSelector middleware to detect changes to project object only
        // Trigger auto-save when any project field changes (timeline, media, settings, etc.)
        useProjectStore.subscribe(
          (state) => state.project,
          () => {
            autoSaveManager.markDirty();
          },
        );
        // Also re-mark dirty when the actionHistory's stacks change —
        // pure undo/redo (without a project mutation between) doesn't
        // bump `project`, but the history itself differs and we want
        // it persisted. The history's notify fires on every push /
        // undo / redo / snapshot mutation.
        try {
          const { actionHistory } = get();
          actionHistory.subscribe(() => autoSaveManager.markDirty());
        } catch {
          /* older builds without subscribe — no-op */
        }
      },

      checkForRecovery: async () => {
        const { project } = get();
        return autoSaveManager.checkForRecovery(project.id);
      },

      recoverFromAutoSave: async (saveId: string) => {
        // Use the with-history variant so a reload restores undo/redo
        // + named snapshots alongside the project. Old autosaves
        // (no historyData) still recover with a fresh history — same
        // behaviour as before this change.
        const recovered = await autoSaveManager.recoverWithHistory(saveId);
        const recoveredProject = recovered?.project ?? null;
        const persistedHistory = recovered?.historyData ?? null;
        if (recoveredProject) {
          const storedMedia = await loadProjectMedia(recoveredProject.id);
          const blobMap = new Map(storedMedia.map((m) => [m.id, m.blob]));

          const restoredItems = await Promise.all(
            recoveredProject.mediaLibrary.items.map((item) =>
              restoreMediaItem(item, blobMap.get(item.id)),
            ),
          );

          const projectWithMedia: Project = {
            ...recoveredProject,
            mediaLibrary: {
              ...recoveredProject.mediaLibrary,
              items: restoredItems,
            },
          };

          const titleEngine = useEngineStore.getState().getTitleEngine();
          const graphicsEngine = useEngineStore.getState().getGraphicsEngine();

          // Local-recovery is the COMMON reopen path (it wins over the
          // Firestore blob and skips loadProject entirely) — restore video
          // effects + color grading here too or they only survive reloads
          // that happen to cold-load from Firestore.
          try {
            const effectsState = (recoveredProject as any).effectsState;
            console.log(`[recoverFromAutoSave] effectsState: ${effectsState ? Object.keys(effectsState).length + ' clip(s)' : 'ABSENT'}`);
            if (effectsState) getEffectsBridge().restoreAllEffects(effectsState);
          } catch (e) {
            console.warn('[recoverFromAutoSave] effects restore failed:', e);
          }

          if (titleEngine && recoveredProject.textClips) {
            titleEngine.loadTextClips(recoveredProject.textClips);
          }
          if (graphicsEngine) {
            if (recoveredProject.shapeClips) {
              graphicsEngine.loadShapeClips(recoveredProject.shapeClips);
            }
            if (recoveredProject.svgClips) {
              graphicsEngine.loadSVGClips(recoveredProject.svgClips);
            }
            if (recoveredProject.stickerClips) {
              graphicsEngine.loadStickerClips(recoveredProject.stickerClips);
            }
          }

          const newHistory = new ActionHistory();
          // Rehydrate undo/redo + named snapshots from the autosave
          // record. Older autosaves (no historyData) leave history
          // empty — same behaviour as before this change.
          if (persistedHistory) {
            try {
              newHistory.restore(JSON.parse(persistedHistory));
            } catch (e) {
              console.warn("[recover] history restore failed, starting fresh:", e);
            }
          }
          const newExecutor = new ActionExecutor(newHistory, {
            getTitleEngine: () => useEngineStore.getState().getTitleEngine() ?? null,
          });
          set({
            project: projectWithMedia,
            actionHistory: newHistory,
            actionExecutor: newExecutor,
            clipUndoStack: [],
            clipRedoStack: [],
            error: null,
          });

          await projectManager.addToRecent(projectWithMedia);
          return true;
        }
        return false;
      },

      forceSave: async () => {
        const { project } = get();
        const titleEngine = useEngineStore.getState().getTitleEngine();
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();

        const fullProject: Project = {
          ...project,
          textClips: titleEngine?.getAllTextClips() || [],
          shapeClips: graphicsEngine?.getAllShapeClips() || [],
          svgClips: graphicsEngine?.getAllSVGClips() || [],
          stickerClips: graphicsEngine?.getAllStickerClips() || [],
        };
        await autoSaveManager.forceSave(fullProject);
      },

      getFullProject: (): Project => {
        const { project } = get();
        const titleEngine = useEngineStore.getState().getTitleEngine();
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();

        return {
          ...project,
          textClips: titleEngine?.getAllTextClips() || [],
          shapeClips: graphicsEngine?.getAllShapeClips() || [],
          svgClips: graphicsEngine?.getAllSVGClips() || [],
          stickerClips: graphicsEngine?.getAllStickerClips() || [],
        };
      },

      // Text clip actions

      /**
       * Create a new text clip with default styling
       * Create text clips using TitleEngine with default styling
       */
      createTextClip: (
        trackId: string,
        startTime: number,
        text: string,
        duration: number = 5,
        style?: Partial<TextStyle>,
      ) => {
        const titleEngine = useEngineStore.getState().titleEngine;
        if (!titleEngine) {
          console.error("TitleEngine not available yet");
          return null;
        }

        const { project } = get();
        const track = project.timeline.tracks.find((t) => t.id === trackId);
        if (!track) {
          console.error(`Track ${trackId} not found`);
          return null;
        }

        const textClip = titleEngine.createTextClip({
          trackId,
          startTime,
          text,
          duration,
          style,
        });

        // Push to undo stack for undo support (separate from main timeline undo/redo)
        // This prevents text clip creation from being conflated with timeline operations
        const { clipUndoStack } = get();
        const historyEntry: ClipHistoryEntry = {
          type: "text",
          clipId: textClip.id,
          trackId,
          clipData: { ...textClip }, // Store full clip data for redo reconstruction
          timestamp: Date.now(),
        };

        set({
          project: {
            ...project,
            // Snapshot sync — project.textClips is the persisted SSOT the
            // loader rebuilds the engine from; without this, every remote
            // tick wipes clips that existed only inside the title engine.
            textClips: titleEngine.getAllTextClips(),
            modifiedAt: Date.now(), // Mark project as modified
          },
          clipUndoStack: [...clipUndoStack, historyEntry], // Push entry to undo stack
          clipRedoStack: [], // Clear redo stack since new action clears future history
        });

        return textClip;
      },

      /**
       * Update text content in real-time
       * Update text content and style
       */
      updateTextContent: (clipId: string, text: string) => {
        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (!titleEngine) {
          console.error("TitleEngine not initialized");
          return null;
        }

        const updatedClip = titleEngine.updateText(clipId, text);
        if (updatedClip) {
          // Mirror the engine's clips back into project.textClips — the
          // title engine is the live source of truth, but autosave +
          // project_state serialization + reload all read project.textClips.
          // Without this, the edit lives only in the engine and is lost on
          // refresh (stale snapshot serialized) and reset on any rebuild that
          // re-hydrates the engine from the snapshot. (Fixes caption edits
          // not persisting.)
          set({ project: { ...get().project, textClips: titleEngine.getAllTextClips(), modifiedAt: Date.now() } });
        }
        return updatedClip || null;
      },

      /**
       * Update text style
       * Update text content and style
       */
      updateTextStyle: (clipId: string, style: Partial<TextStyle>) => {
        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (!titleEngine) {
          console.error("TitleEngine not initialized");
          return null;
        }

        const updatedClip = titleEngine.updateStyle(clipId, style);
        if (updatedClip) {
          // Sync engine → project.textClips so style edits (font, size,
          // colour) persist across autosave / reload. See updateTextContent.
          set({ project: { ...get().project, textClips: titleEngine.getAllTextClips(), modifiedAt: Date.now() } });
        }
        return updatedClip || null;
      },

      /**
       * Update text animation preset
       * Apply text animation presets
       */
      updateTextAnimation: (clipId: string, animation: TextAnimation) => {
        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (!titleEngine) {
          console.error("TitleEngine not initialized");
          return null;
        }

        const updatedClip = titleEngine.updateTextClip(clipId, { animation });
        if (updatedClip) {
          // Sync engine → project.textClips so the change persists. See updateTextContent.
          set({ project: { ...get().project, textClips: titleEngine.getAllTextClips(), modifiedAt: Date.now() } });
        }
        return updatedClip || null;
      },

      /**
       * Update kinetic-caption fields (word highlight on/off + active colour).
       */
      updateCaptionFields: (
        clipId: string,
        fields: {
          captionHighlight?: boolean;
          captionHighlightColor?: string;
          captionAnimation?: CaptionAnimationStyle;
        },
      ) => {
        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (!titleEngine) {
          console.error("TitleEngine not initialized");
          return null;
        }
        const updatedClip = titleEngine.updateTextClip(clipId, fields);
        if (updatedClip) {
          // Sync engine → project.textClips so the highlight colour / word-
          // highlight toggle persists across autosave / reload. See updateTextContent.
          set({ project: { ...get().project, textClips: titleEngine.getAllTextClips(), modifiedAt: Date.now() } });
        }
        return updatedClip || null;
      },

      /**
       * Update text clip transform (position, scale, rotation)
       * Text Overlay System
       */
      updateTextTransform: (clipId: string, transform: Partial<Transform>) => {
        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (!titleEngine) {
          console.error("TitleEngine not initialized");
          return null;
        }

        const updatedClip = titleEngine.updateTextClip(clipId, { transform });
        if (updatedClip) {
          // Sync engine → project.textClips so dragging/scaling a caption
          // persists across autosave / reload. See updateTextContent.
          set({ project: { ...get().project, textClips: titleEngine.getAllTextClips(), modifiedAt: Date.now() } });
        }
        return updatedClip || null;
      },

      /**
       * Get a text clip by ID
       */
      getTextClip: (clipId: string) => {
        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (!titleEngine) {
          return undefined;
        }
        return titleEngine.getTextClip(clipId);
      },

      /**
       * Get all text clips
       */
      getAllTextClips: () => {
        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (!titleEngine) {
          return [];
        }
        return titleEngine.getAllTextClips();
      },

      /**
       * Update text clip keyframes for entry/exit transitions
       */
      updateTextClipKeyframes: (clipId: string, keyframes: Keyframe[]) => {
        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (!titleEngine) {
          console.error("TitleEngine not initialized");
          return null;
        }

        const updatedClip = titleEngine.updateTextClip(clipId, { keyframes });
        if (updatedClip) {
          // Sync engine → project.textClips so caption keyframes persist across
          // autosave / reload / cloud render (see updateStyle).
          set({ project: { ...get().project, textClips: titleEngine.getAllTextClips(), modifiedAt: Date.now() } });
        }
        return updatedClip || null;
      },

      // Text animation actions

      /**
       * Apply text animation preset to a text clip
       * Apply text animation presets (typewriter, fade, slide, bounce, scale, rotate, wave)
       */
      applyTextAnimationPreset: (
        clipId: string,
        preset: TextAnimationPreset,
        inDuration: number = 0.5,
        outDuration: number = 0.5,
        params?: Partial<TextAnimationParams>,
      ) => {
        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (!titleEngine) {
          return null;
        }

        const animation = textAnimationEngine.createAnimationPreset(
          preset,
          inDuration,
          outDuration,
          params,
        );

        const updatedClip = titleEngine.updateTextClip(clipId, { animation });

        if (updatedClip) {
          const { project } = get();
          // Sync engine → project.textClips so the animation preset persists
          // across autosave / reload / cloud render (see updateStyle).
          set({ project: { ...project, textClips: titleEngine.getAllTextClips(), modifiedAt: Date.now() } });
        }
        return updatedClip || null;
      },

      /**
       * Get available animation presets
       * Text animation presets
       */
      getAvailableAnimationPresets: () => {
        return textAnimationEngine.getAvailablePresets();
      },

      // Subtitle actions - subtitles are now created as text clips on a "Captions" track

      /**
       * Add a subtitle as a text clip on a Captions track
       */
      addSubtitle: async (subtitle) => {
        const { createTextClip } = get();

        // Find-or-create the SINGLE canonical captions track. Reuse the avatar
        // pipeline's "track-captions" id so BOTH caption entry points share ONE
        // track (consistent), and create it SYNCHRONOUSLY (no async addTrack +
        // rename) so a burst of phrases can't race into duplicate "Captions" /
        // "Text N" tracks — the rename used to be reverted by the live merge.
        let captionsTrack =
          get().project.timeline.tracks.find((t) => t.id === "track-captions") ??
          get().project.timeline.tracks.find(
            (t) => t.type === "text" && t.name === "Captions",
          );

        if (!captionsTrack) {
          const newTrack: Track = {
            id: "track-captions",
            type: "text",
            name: "Captions",
            clips: [],
            transitions: [],
            locked: false,
            hidden: false,
            muted: false,
            solo: false,
          };
          captionsTrack = newTrack;
          set((state) => ({
            project: {
              ...state.project,
              timeline: {
                ...state.project.timeline,
                tracks: [newTrack, ...state.project.timeline.tracks],
              },
            },
          }));
        }

        const duration = subtitle.endTime - subtitle.startTime;

        // Produce the SAME viral caption look the avatar pipeline
        // (voidspace-loader) makes: large (proportional to comp height), bold
        // Anton, outlined + shadowed, with kinetic word-pop.
        const compHeight = get().project.settings?.height || 1080;
        const fontSize = Math.round(compHeight * 0.072);
        const viralStyle: Partial<TextStyle> = {
          fontFamily: "Anton",
          fontSize,
          fontWeight: "bold",
          color: "#FFFFFF",
          textAlign: "center",
          strokeColor: "#000000",
          strokeWidth: Math.max(4, Math.round(fontSize * 0.09)),
          shadowColor: "rgba(0,0,0,0.9)",
          shadowBlur: Math.round(fontSize * 0.18),
          shadowOffsetX: 0,
          shadowOffsetY: Math.round(fontSize * 0.06),
        };

        const created = createTextClip(
          captionsTrack.id,
          subtitle.startTime,
          subtitle.text,
          duration,
          viralStyle,
        );

        if (created) {
          // Per-word timing (clip-relative) drives the kinetic word highlight;
          // bottom-centre placement matches the pipeline captions.
          const clipWords = (subtitle.words ?? [])
            .filter((w) => w && typeof w.text === "string")
            .map((w) => ({
              text: w.text,
              start: Math.max(0, w.startTime - subtitle.startTime),
              end: Math.max(0, w.endTime - subtitle.startTime),
            }));
          const titleEngine = useEngineStore.getState().getTitleEngine();
          titleEngine?.updateTextClip(created.id, {
            transform: { position: { x: 0.5, y: 0.85 } },
            ...(clipWords.length > 0
              ? {
                  captionWords: clipWords,
                  captionHighlight: subtitle.animationStyle !== "none",
                  captionHighlightColor: "#FFE600",
                  captionAnimation: subtitle.animationStyle ?? "word-highlight",
                }
              : {}),
          });
          // Snapshot sync (same reason as createTextClip): persist the
          // engine's captions into project.textClips or the next loader
          // tick rebuilds the engine without them.
          set({ project: { ...get().project, textClips: titleEngine?.getAllTextClips() ?? get().project.textClips, modifiedAt: Date.now() } });
        }
      },

      /**
       * Remove a subtitle from the timeline
       */
      removeSubtitle: (subtitleId) => {
        set((state) => ({
          project: {
            ...state.project,
            timeline: {
              ...state.project.timeline,
              subtitles: state.project.timeline.subtitles.filter(
                (s) => s.id !== subtitleId,
              ),
            },
          },
        }));
      },

      /**
       * Update a subtitle
       */
      updateSubtitle: (subtitleId, updates) => {
        set((state) => ({
          project: {
            ...state.project,
            timeline: {
              ...state.project.timeline,
              subtitles: state.project.timeline.subtitles.map((s) =>
                s.id === subtitleId ? { ...s, ...updates } : s,
              ),
            },
            // Autosave is hash-gated on modifiedAt — without the bump a
            // subtitle edit was never persisted until some LATER edit
            // happened to change the hash.
            modifiedAt: Date.now(),
          },
        }));
      },

      /**
       * Get a subtitle by ID
       */
      getSubtitle: (subtitleId) => {
        return get().project.timeline.subtitles.find(
          (s) => s.id === subtitleId,
        );
      },

      importSRT: async (srtContent: string) => {
        const subtitleEngine = await useEngineStore
          .getState()
          .getSubtitleEngine();

        const { project } = get();
        const { timeline, result } = subtitleEngine.importSRT(
          project.timeline,
          srtContent,
        );

        if (result.success) {
          set({
            project: {
              ...project,
              timeline,
              modifiedAt: Date.now(),
            },
          });
          return { success: true, errors: [] };
        } else {
          const errorMessages = result.errors.map(
            (err: { line: number; message: string }) =>
              `Line ${err.line}: ${err.message}`,
          );
          return { success: false, errors: errorMessages };
        }
      },

      exportSRT: async () => {
        const subtitleEngine = await useEngineStore
          .getState()
          .getSubtitleEngine();
        const { project } = get();
        return subtitleEngine.exportSRT(project.timeline);
      },

      applySubtitleStylePreset: async (presetName: string) => {
        const subtitleEngine = await useEngineStore
          .getState()
          .getSubtitleEngine();

        const { project } = get();
        const result = subtitleEngine.applyStylePreset(
          project.timeline,
          presetName,
        );

        if ("error" in result) {
          console.error(result.error);
          return false;
        }

        set({
          project: {
            ...project,
            timeline: result.timeline,
            modifiedAt: Date.now(),
          },
        });
        return true;
      },

      getSubtitleStylePresets: async () => {
        const subtitleEngine = await useEngineStore
          .getState()
          .getSubtitleEngine();
        return subtitleEngine.getStylePresets();
      },

      // Marker actions

      addMarker: (time, label = "Marker", color = "#3b82f6") => {
        const newMarker: import("@openreel/core").Marker = {
          id: `marker-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
          time,
          label,
          color,
        };
        set((state) => ({
          project: {
            ...state.project,
            timeline: {
              ...state.project.timeline,
              markers: [...state.project.timeline.markers, newMarker],
            },
          },
        }));
      },

      removeMarker: (markerId) => {
        set((state) => ({
          project: {
            ...state.project,
            timeline: {
              ...state.project.timeline,
              markers: state.project.timeline.markers.filter(
                (m) => m.id !== markerId,
              ),
            },
          },
        }));
      },

      updateMarker: (markerId, updates) => {
        set((state) => ({
          project: {
            ...state.project,
            timeline: {
              ...state.project.timeline,
              markers: state.project.timeline.markers.map((m) =>
                m.id === markerId ? { ...m, ...updates } : m,
              ),
            },
          },
        }));
      },

      getMarker: (markerId) => {
        const state = get();
        return state.project.timeline.markers.find((m) => m.id === markerId);
      },

      getMarkers: () => {
        const state = get();
        return state.project.timeline.markers;
      },

      // Graphics actions

      /**
       * Create a shape clip
       * Create shape clips using GraphicsEngine
       */
      createShapeClip: (
        trackId: string,
        startTime: number,
        shapeType: ShapeType,
        duration: number = 5,
        style?: Partial<ShapeStyle>,
      ) => {
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (!graphicsEngine) {
          console.error("GraphicsEngine not initialized");
          return null;
        }

        // Verify track exists
        const { project } = get();
        const track = project.timeline.tracks.find((t) => t.id === trackId);
        if (!track) {
          console.error(`Track ${trackId} not found`);
          return null;
        }

        // Create shape clip using GraphicsEngine
        // The GraphicsEngine stores the clip internally in its own state
        const shapeClip = graphicsEngine.createShape(
          {
            shapeType,
            width: 200,
            height: 200,
            style,
          },
          trackId,
          startTime,
          duration,
        );

        // Push to clip-specific undo stack (separate from timeline undo/redo)
        // This keeps graphics operations isolated from timeline operations in history
        const { clipUndoStack } = get();
        const historyEntry: ClipHistoryEntry = {
          type: "shape",
          clipId: shapeClip.id,
          trackId,
          clipData: { ...shapeClip }, // Store full clip data for redo reconstruction
          timestamp: Date.now(),
        };

        // Trigger re-render by updating project state
        // Zustand subscribers will react to project object reference change
        set({
          project: {
            ...project,
            modifiedAt: Date.now(),
          },
          clipUndoStack: [...clipUndoStack, historyEntry], // Add to undo stack
          clipRedoStack: [], // Clear redo stack since new action clears future history
        });

        return shapeClip;
      },

      /**
       * Update shape style properties
       * Update shape properties
       */
      updateShapeStyle: (clipId: string, style: Partial<ShapeStyle>) => {
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (!graphicsEngine) {
          console.error("GraphicsEngine not initialized");
          return null;
        }

        // Get the shape clip from GraphicsEngine
        const shapeClip = graphicsEngine.getShapeClip(clipId);
        if (!shapeClip) {
          console.error(`Shape clip ${clipId} not found`);
          return null;
        }

        // Update the shape style in GraphicsEngine's internal state
        const updatedClip = graphicsEngine.updateShapeStyle(shapeClip, style);

        // Trigger re-render by updating project state reference (doesn't need full project clone)
        // This notifies Zustand subscribers that state has changed via modifiedAt timestamp change
        const { project } = get();
        set({
          project: {
            ...project,
            modifiedAt: Date.now(), // Cheap way to signal change without modifying project content
          },
        });

        return updatedClip;
      },

      updateShapeTransform: (clipId: string, transform: Partial<Transform>) => {
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (!graphicsEngine) {
          console.error("GraphicsEngine not initialized");
          return null;
        }

        const shapeClip = graphicsEngine.getShapeClip(clipId);
        if (shapeClip) {
          const updatedClip = graphicsEngine.updateShapeClip(clipId, {
            transform,
          });
          const { project } = get();
          set({
            project: {
              ...project,
              modifiedAt: Date.now(),
            },
          });
          return updatedClip || null;
        }

        const svgClip = graphicsEngine.getSVGClip(clipId);
        if (svgClip) {
          const updatedClip = graphicsEngine.updateSVGClip(clipId, {
            transform,
          });
          const { project } = get();
          set({
            project: {
              ...project,
              modifiedAt: Date.now(),
            },
          });
          return updatedClip || null;
        }

        const stickerClip = graphicsEngine.getStickerClip(clipId);
        if (stickerClip) {
          const updatedClip = graphicsEngine.updateStickerClip(clipId, {
            transform,
          });
          const { project } = get();
          set({
            project: {
              ...project,
              modifiedAt: Date.now(),
            },
          });
          return updatedClip || null;
        }

        console.error(`Graphic clip ${clipId} not found`);
        return null;
      },

      /**
       * Import SVG and create SVG clip
       * Parse and render SVG content
       */
      importSVG: (
        svgContent: string,
        trackId: string,
        startTime: number,
        duration: number = 5,
      ) => {
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (!graphicsEngine) {
          console.error("GraphicsEngine not initialized");
          return null;
        }

        // Verify track exists
        const { project } = get();
        const track = project.timeline.tracks.find((t) => t.id === trackId);
        if (!track) {
          console.error(`Track ${trackId} not found`);
          return null;
        }

        try {
          // Import SVG using GraphicsEngine
          // The GraphicsEngine parses SVG content and stores the clip internally
          const svgClip = graphicsEngine.importSVG(
            svgContent,
            trackId,
            startTime,
            duration,
          );

          // Push to clip-specific undo stack for separate undo/redo handling
          const { clipUndoStack } = get();
          const historyEntry: ClipHistoryEntry = {
            type: "svg",
            clipId: svgClip.id,
            trackId,
            clipData: { ...svgClip }, // Store full SVG clip including svgContent for redo
            timestamp: Date.now(),
          };

          // Trigger re-render by updating project state
          // Update project reference to notify subscribers of change
          set({
            project: {
              ...project,
              modifiedAt: Date.now(),
            },
            clipUndoStack: [...clipUndoStack, historyEntry], // Add to undo stack
            clipRedoStack: [], // Clear redo when new action occurs
          });

          return svgClip;
        } catch (error) {
          console.error("Failed to import SVG:", error);
          return null;
        }
      },

      /**
       * Get a shape clip by ID
       */
      getShapeClip: (clipId: string) => {
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (!graphicsEngine) {
          return undefined;
        }
        return graphicsEngine.getShapeClip(clipId);
      },

      /**
       * Get an SVG clip by ID
       */
      getSVGClip: (clipId: string) => {
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (!graphicsEngine) {
          return undefined;
        }
        return graphicsEngine.getSVGClip(clipId);
      },

      getSVGClipById: (clipId: string) => {
        return get().getSVGClip(clipId);
      },

      updateSVGClip: (clipId: string, updates) => {
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (!graphicsEngine) {
          console.error("[ProjectStore] GraphicsEngine not initialized");
          return null;
        }

        const updatedClip = graphicsEngine.updateSVGClip(clipId, updates);
        if (updatedClip) {
          const { project } = get();
          set({
            project: {
              ...project,
              modifiedAt: Date.now(),
            },
          });
        } else {
          console.error(`[ProjectStore] Failed to update SVG clip ${clipId}`);
        }
        return updatedClip || null;
      },

      createStickerClip: (clip: StickerClip) => {
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (!graphicsEngine) {
          console.error("GraphicsEngine not initialized");
          return null;
        }

        const { project } = get();
        const track = project.timeline.tracks.find(
          (t) => t.id === clip.trackId,
        );
        if (!track) {
          console.error(`Track ${clip.trackId} not found`);
          return null;
        }

        graphicsEngine.addStickerClip(clip);

        set({
          project: {
            ...project,
            modifiedAt: Date.now(),
          },
        });

        return clip;
      },

      getStickerClip: (clipId: string) => {
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (!graphicsEngine) {
          return undefined;
        }
        return graphicsEngine.getStickerClip(clipId);
      },

      deleteShapeClip: (clipId: string) => {
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (!graphicsEngine) {
          return false;
        }
        const deleted = graphicsEngine.deleteShapeClip(clipId);
        if (deleted) {
          const { project } = get();
          set({
            project: {
              ...project,
              modifiedAt: Date.now(),
            },
          });
        }
        return deleted;
      },

      deleteSVGClip: (clipId: string) => {
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (!graphicsEngine) {
          return false;
        }
        const deleted = graphicsEngine.deleteSVGClip(clipId);
        if (deleted) {
          const { project } = get();
          set({
            project: {
              ...project,
              modifiedAt: Date.now(),
            },
          });
        }
        return deleted;
      },

      deleteStickerClip: (clipId: string) => {
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();
        if (!graphicsEngine) {
          return false;
        }
        const deleted = graphicsEngine.deleteStickerClip(clipId);
        if (deleted) {
          const { project } = get();
          set({
            project: {
              ...project,
              modifiedAt: Date.now(),
            },
          });
        }
        return deleted;
      },

      deleteTextClip: (clipId: string) => {
        const titleEngine = useEngineStore.getState().getTitleEngine();
        if (!titleEngine) {
          return false;
        }
        const deleted = titleEngine.deleteTextClip(clipId);
        if (deleted) {
          const { project } = get();
          // Sync engine → project.textClips so the deletion PERSISTS. Without
          // this, the engine drops the caption (the live preview looks right)
          // but the stale project.textClips snapshot still carries it — and
          // that snapshot is what gets serialized to autosave / Firestore, read
          // by the cloud render, and reloaded via loadTextClips (which rebuilds
          // the engine FROM the snapshot, resurrecting the deleted caption).
          // Mirrors updateText / updateStyle / updateTextTransform etc.
          set({
            project: {
              ...project,
              textClips: titleEngine.getAllTextClips(),
              modifiedAt: Date.now(),
            },
          });
        }
        return deleted;
      },

      // Photo editing actions

      /**
       * Create a new photo project
       * Create PhotoProject with base layer using PhotoEngine
       */
      createPhotoProject: (width?: number, height?: number, name?: string) => {
        const photoEngine = useEngineStore.getState().getPhotoEngine();
        if (!photoEngine) {
          console.error("PhotoEngine not initialized");
          return null;
        }

        const photoProject = photoEngine.createProject(width, height, name);
        const { photoProjects } = get();
        photoProjects.set(photoProject.id, photoProject);

        // Create new Map instance to trigger Zustand reactivity (Maps don't trigger on set operations)
        // This ensures subscribers are notified of photo project changes
        set({ photoProjects: new Map(photoProjects) });
        return photoProject;
      },

      /**
       * Import a photo and create a base layer
       * Create PhotoProject with base layer
       */
      importPhotoForEditing: (image: ImageBitmap, name?: string) => {
        const photoEngine = useEngineStore.getState().getPhotoEngine();
        if (!photoEngine) {
          console.error("PhotoEngine not initialized");
          return null;
        }

        // Create a new project with image dimensions
        const photoProject = photoEngine.createProject(
          image.width,
          image.height,
          name || "Photo Edit",
        );

        // Import the photo as base layer in the project
        const updatedProject = photoEngine.importPhoto(
          photoProject,
          image,
          name,
        );

        const { photoProjects } = get();
        photoProjects.set(updatedProject.id, updatedProject);

        // Create new Map to notify Zustand subscribers (mutation on existing Map won't trigger)
        set({ photoProjects: new Map(photoProjects) });
        return updatedProject;
      },

      /**
       * Add a new layer to a photo project
       * Insert layer above current layer in stack
       */
      addPhotoLayer: (projectId: string, options?: CreateLayerOptions) => {
        const photoEngine = useEngineStore.getState().getPhotoEngine();
        if (!photoEngine) {
          console.error("PhotoEngine not initialized");
          return null;
        }

        const { photoProjects } = get();
        const photoProject = photoProjects.get(projectId);
        if (!photoProject) {
          console.error(`Photo project ${projectId} not found`);
          return null;
        }

        // PhotoEngine.addLayer returns updated project with new layer
        const updatedProject = photoEngine.addLayer(photoProject, options);
        photoProjects.set(projectId, updatedProject); // Update Map with new project state

        // Create new Map to notify Zustand and all subscribers of the change
        set({ photoProjects: new Map(photoProjects) });
        return updatedProject;
      },

      /**
       * Remove a layer from a photo project
       */
      removePhotoLayer: (projectId: string, layerId: string) => {
        const photoEngine = useEngineStore.getState().getPhotoEngine();
        if (!photoEngine) {
          console.error("PhotoEngine not initialized");
          return null;
        }

        const { photoProjects } = get();
        const photoProject = photoProjects.get(projectId);
        if (!photoProject) {
          console.error(`Photo project ${projectId} not found`);
          return null;
        }

        const updatedProject = photoEngine.removeLayer(photoProject, layerId);
        photoProjects.set(projectId, updatedProject);

        set({ photoProjects: new Map(photoProjects) });
        return updatedProject;
      },

      /**
       * Reorder layers in a photo project
       * Reorder layers and update composite order
       */
      reorderPhotoLayers: (
        projectId: string,
        fromIndex: number,
        toIndex: number,
      ) => {
        const photoEngine = useEngineStore.getState().getPhotoEngine();
        if (!photoEngine) {
          console.error("PhotoEngine not initialized");
          return null;
        }

        const { photoProjects } = get();
        const photoProject = photoProjects.get(projectId);
        if (!photoProject) {
          console.error(`Photo project ${projectId} not found`);
          return null;
        }

        const result = photoEngine.reorderLayers(
          photoProject,
          fromIndex,
          toIndex,
        );
        if (!result.success) {
          console.error(`Failed to reorder layers: ${result.error}`);
          return null;
        }

        const updatedProject = {
          ...photoProject,
          layers: result.layers,
        };
        photoProjects.set(projectId, updatedProject);

        set({ photoProjects: new Map(photoProjects) });
        return updatedProject;
      },

      /**
       * Toggle layer visibility
       * Toggle layer visibility
       */
      setPhotoLayerVisibility: (
        projectId: string,
        layerId: string,
        visible?: boolean,
      ) => {
        const photoEngine = useEngineStore.getState().getPhotoEngine();
        if (!photoEngine) {
          console.error("PhotoEngine not initialized");
          return null;
        }

        const { photoProjects } = get();
        const photoProject = photoProjects.get(projectId);
        if (!photoProject) {
          console.error(`Photo project ${projectId} not found`);
          return null;
        }

        const updatedProject = photoEngine.setLayerVisibility(
          photoProject,
          layerId,
          visible,
        );
        photoProjects.set(projectId, updatedProject);

        set({ photoProjects: new Map(photoProjects) });
        return updatedProject;
      },

      /**
       * Set layer opacity
       * Adjust layer opacity
       */
      setPhotoLayerOpacity: (
        projectId: string,
        layerId: string,
        opacity: number,
      ) => {
        const photoEngine = useEngineStore.getState().getPhotoEngine();
        if (!photoEngine) {
          console.error("PhotoEngine not initialized");
          return null;
        }

        const { photoProjects } = get();
        const photoProject = photoProjects.get(projectId);
        if (!photoProject) {
          console.error(`Photo project ${projectId} not found`);
          return null;
        }

        const updatedProject = photoEngine.setLayerOpacity(
          photoProject,
          layerId,
          opacity,
        );
        photoProjects.set(projectId, updatedProject);

        set({ photoProjects: new Map(photoProjects) });
        return updatedProject;
      },

      /**
       * Set layer blend mode
       * Adjust layer blend mode
       */
      setPhotoLayerBlendMode: (
        projectId: string,
        layerId: string,
        blendMode: PhotoBlendMode,
      ) => {
        const photoEngine = useEngineStore.getState().getPhotoEngine();
        if (!photoEngine) {
          console.error("PhotoEngine not initialized");
          return null;
        }

        const { photoProjects } = get();
        const photoProject = photoProjects.get(projectId);
        if (!photoProject) {
          console.error(`Photo project ${projectId} not found`);
          return null;
        }

        const updatedProject = photoEngine.setLayerBlendMode(
          photoProject,
          layerId,
          blendMode,
        );
        photoProjects.set(projectId, updatedProject);

        set({ photoProjects: new Map(photoProjects) });
        return updatedProject;
      },

      /**
       * Get a photo project by ID
       */
      getPhotoProject: (projectId: string) => {
        const { photoProjects } = get();
        return photoProjects.get(projectId) || null;
      },

      // Video effects actions

      /**
       * Add a video effect to a clip
       * Apply video effect within 200ms
       */
      addVideoEffect: (
        clipId: string,
        effectType: VideoEffectType,
        params?: Record<string, unknown>,
      ) => {
        const effectsBridge = getEffectsBridge();
        if (!effectsBridge.isInitialized()) {
          console.error("EffectsBridge not initialized");
          return null;
        }

        const result = effectsBridge.applyVideoEffect(
          clipId,
          effectType,
          params,
        );
        if (!result.success || !result.effectId) {
          console.error("Failed to add video effect:", result.error);
          return null;
        }

        const effect = effectsBridge.getEffect(clipId, result.effectId);
        if (effect) {
          // Trigger re-render by updating project state
          set({ project: { ...get().project, modifiedAt: Date.now() } });
        }
        return effect || null;
      },

      /**
       * Update a video effect's parameters
       * Apply changes within 200ms
       */
      updateVideoEffect: (
        clipId: string,
        effectId: string,
        params: Record<string, unknown>,
      ) => {
        const effectsBridge = getEffectsBridge();
        if (!effectsBridge.isInitialized()) {
          console.error("EffectsBridge not initialized");
          return null;
        }

        const result = effectsBridge.updateVideoEffect(
          clipId,
          effectId,
          params,
        );
        if (!result.success) {
          console.error("Failed to update video effect:", result.error);
          return null;
        }

        const effect = effectsBridge.getEffect(clipId, effectId);
        if (effect) {
          const { project } = get();
          const updatedTracks = project.timeline.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((clip) => {
              if (clip.id === clipId) {
                const updatedEffects = clip.effects.map((e) =>
                  e.id === effectId
                    ? { ...e, params: { ...e.params, ...params } }
                    : e,
                );
                return { ...clip, effects: updatedEffects };
              }
              return clip;
            }),
          }));

          set({
            project: {
              ...project,
              timeline: { ...project.timeline, tracks: updatedTracks },
              modifiedAt: Date.now(),
            },
          });
        }
        return effect || null;
      },

      /**
       * Remove a video effect from a clip
       * Restore clip to previous state when effect removed
       */
      removeVideoEffect: (clipId: string, effectId: string) => {
        const effectsBridge = getEffectsBridge();
        if (!effectsBridge.isInitialized()) {
          console.error("EffectsBridge not initialized");
          return false;
        }

        const result = effectsBridge.removeVideoEffect(clipId, effectId);
        if (!result.success) {
          console.error("Failed to remove video effect:", result.error);
          return false;
        }

        // Trigger re-render by updating project state
        set({ project: { ...get().project, modifiedAt: Date.now() } });
        return true;
      },

      /**
       * Reorder video effects in the processing chain
       * Update effect order in clip's effect list
       */
      reorderVideoEffects: (clipId: string, effectIds: string[]) => {
        const effectsBridge = getEffectsBridge();
        if (!effectsBridge.isInitialized()) {
          console.error("EffectsBridge not initialized");
          return false;
        }

        const result = effectsBridge.reorderEffects(clipId, effectIds);
        if (!result.success) {
          console.error("Failed to reorder video effects:", result.error);
          return false;
        }

        // Trigger re-render by updating project state
        set({ project: { ...get().project, modifiedAt: Date.now() } });
        return true;
      },

      /**
       * Toggle a video effect's enabled state
       * Toggle effect enabled state
       */
      toggleVideoEffect: (
        clipId: string,
        effectId: string,
        enabled: boolean,
      ) => {
        const effectsBridge = getEffectsBridge();
        if (!effectsBridge.isInitialized()) {
          console.error("EffectsBridge not initialized");
          return null;
        }

        const result = effectsBridge.toggleEffect(clipId, effectId, enabled);
        if (!result.success) {
          console.error("Failed to toggle video effect:", result.error);
          return null;
        }

        const effect = effectsBridge.getEffect(clipId, effectId);
        if (effect) {
          // Trigger re-render by updating project state
          set({ project: { ...get().project, modifiedAt: Date.now() } });
        }
        return effect || null;
      },

      /**
       * Get all video effects for a clip
       */
      getVideoEffects: (clipId: string) => {
        const effectsBridge = getEffectsBridge();
        if (!effectsBridge.isInitialized()) {
          return [];
        }
        return effectsBridge.getEffects(clipId);
      },

      /**
       * Get a specific video effect by ID
       */
      getVideoEffect: (clipId: string, effectId: string) => {
        const effectsBridge = getEffectsBridge();
        if (!effectsBridge.isInitialized()) {
          return undefined;
        }
        return effectsBridge.getEffect(clipId, effectId);
      },

      // Color grading actions

      /**
       * Update color grading settings for a clip
       * Apply color grading adjustments
       */
      updateColorGrading: (
        clipId: string,
        settings: Partial<ColorGradingSettings>,
      ) => {
        const effectsBridge = getEffectsBridge();
        if (!effectsBridge.isInitialized()) {
          console.error("EffectsBridge not initialized");
          return false;
        }

        // Apply each setting type
        if (settings.colorWheels) {
          const result = effectsBridge.applyColorWheels(
            clipId,
            settings.colorWheels,
          );
          if (!result.success) {
            console.error("Failed to apply color wheels:", result.error);
            return false;
          }
        }

        if (settings.curves) {
          const result = effectsBridge.applyCurves(clipId, settings.curves);
          if (!result.success) {
            console.error("Failed to apply curves:", result.error);
            return false;
          }
        }

        if (settings.lut) {
          const result = effectsBridge.applyLUT(clipId, settings.lut);
          if (!result.success) {
            console.error("Failed to apply LUT:", result.error);
            return false;
          }
        }

        if (settings.hsl) {
          const result = effectsBridge.applyHSL(clipId, settings.hsl);
          if (!result.success) {
            console.error("Failed to apply HSL:", result.error);
            return false;
          }
        }

        // Trigger re-render by updating project state
        set({ project: { ...get().project, modifiedAt: Date.now() } });
        return true;
      },

      /**
       * Get color grading settings for a clip
       */
      getColorGrading: (clipId: string) => {
        const effectsBridge = getEffectsBridge();
        if (!effectsBridge.isInitialized()) {
          return {};
        }
        return effectsBridge.getColorGrading(clipId);
      },

      /**
       * Reset color grading to defaults for a clip
       */
      resetColorGrading: (clipId: string) => {
        const effectsBridge = getEffectsBridge();
        if (!effectsBridge.isInitialized()) {
          console.error("EffectsBridge not initialized");
          return false;
        }

        const result = effectsBridge.resetColorGrading(clipId);
        if (!result.success) {
          console.error("Failed to reset color grading:", result.error);
          return false;
        }

        // Trigger re-render by updating project state
        set({ project: { ...get().project, modifiedAt: Date.now() } });
        return true;
      },

      // Audio effects actions

      /**
       * Add an audio effect to a clip
       * Apply audio effects
       */
      addAudioEffect: (clipId: string, effect: Effect) => {
        const { project } = get();

        for (const track of project.timeline.tracks) {
          const clipIndex = track.clips.findIndex((c) => c.id === clipId);
          if (clipIndex !== -1) {
            const clip = track.clips[clipIndex];
            const currentAudioEffects = clip.audioEffects || [];
            const updatedAudioEffects = [...currentAudioEffects, effect];
            const updatedClip = { ...clip, audioEffects: updatedAudioEffects };
            const updatedClips = [...track.clips];
            updatedClips[clipIndex] = updatedClip;
            const updatedTrack = { ...track, clips: updatedClips };
            const updatedTracks = project.timeline.tracks.map((t) =>
              t.id === track.id ? updatedTrack : t,
            );
            const updatedProject = {
              ...project,
              timeline: { ...project.timeline, tracks: updatedTracks },
              modifiedAt: Date.now(),
            };
            set({ project: updatedProject });
            return true;
          }
        }
        return false;
      },

      /**
       * Update an audio effect on a clip
       * Update audio effect parameters
       */
      updateAudioEffect: (
        clipId: string,
        effectId: string,
        params: Record<string, unknown>,
      ) => {
        const { project } = get();

        for (const track of project.timeline.tracks) {
          const clipIndex = track.clips.findIndex((c) => c.id === clipId);
          if (clipIndex !== -1) {
            const clip = track.clips[clipIndex];
            const audioEffects = clip.audioEffects || [];
            const effectIndex = audioEffects.findIndex(
              (e) => e.id === effectId,
            );
            if (effectIndex !== -1) {
              const effect = audioEffects[effectIndex];
              const updatedEffect = {
                ...effect,
                params: { ...effect.params, ...params },
              };
              const updatedAudioEffects = [...audioEffects];
              updatedAudioEffects[effectIndex] = updatedEffect;
              const updatedClip = {
                ...clip,
                audioEffects: updatedAudioEffects,
              };
              const updatedClips = [...track.clips];
              updatedClips[clipIndex] = updatedClip;
              const updatedTrack = { ...track, clips: updatedClips };
              const updatedTracks = project.timeline.tracks.map((t) =>
                t.id === track.id ? updatedTrack : t,
              );
              const updatedProject = {
                ...project,
                timeline: { ...project.timeline, tracks: updatedTracks },
                modifiedAt: Date.now(),
              };
              set({ project: updatedProject });
              return true;
            }
          }
        }
        return false;
      },

      /**
       * Remove an audio effect from a clip
       */
      removeAudioEffect: (clipId: string, effectId: string) => {
        const { project } = get();

        for (const track of project.timeline.tracks) {
          const clipIndex = track.clips.findIndex((c) => c.id === clipId);
          if (clipIndex !== -1) {
            const clip = track.clips[clipIndex];
            const audioEffects = clip.audioEffects || [];
            const updatedAudioEffects = audioEffects.filter(
              (e) => e.id !== effectId,
            );
            const updatedClip = { ...clip, audioEffects: updatedAudioEffects };
            const updatedClips = [...track.clips];
            updatedClips[clipIndex] = updatedClip;
            const updatedTrack = { ...track, clips: updatedClips };
            const updatedTracks = project.timeline.tracks.map((t) =>
              t.id === track.id ? updatedTrack : t,
            );
            const updatedProject = {
              ...project,
              timeline: { ...project.timeline, tracks: updatedTracks },
              modifiedAt: Date.now(),
            };
            set({ project: updatedProject });
            return true;
          }
        }
        return false;
      },

      /**
       * Toggle an audio effect's enabled state
       */
      toggleAudioEffect: (
        clipId: string,
        effectId: string,
        enabled: boolean,
      ) => {
        const { project } = get();

        for (const track of project.timeline.tracks) {
          const clipIndex = track.clips.findIndex((c) => c.id === clipId);
          if (clipIndex !== -1) {
            const clip = track.clips[clipIndex];
            const audioEffects = clip.audioEffects || [];
            const effectIndex = audioEffects.findIndex(
              (e) => e.id === effectId,
            );
            if (effectIndex !== -1) {
              const effect = audioEffects[effectIndex];
              const updatedEffect = { ...effect, enabled };
              const updatedAudioEffects = [...audioEffects];
              updatedAudioEffects[effectIndex] = updatedEffect;
              const updatedClip = {
                ...clip,
                audioEffects: updatedAudioEffects,
              };
              const updatedClips = [...track.clips];
              updatedClips[clipIndex] = updatedClip;
              const updatedTrack = { ...track, clips: updatedClips };
              const updatedTracks = project.timeline.tracks.map((t) =>
                t.id === track.id ? updatedTrack : t,
              );
              const updatedProject = {
                ...project,
                timeline: { ...project.timeline, tracks: updatedTracks },
                modifiedAt: Date.now(),
              };
              set({ project: updatedProject });
              return true;
            }
          }
        }
        return false;
      },

      /**
       * Get all audio effects for a clip
       */
      getAudioEffects: (clipId: string) => {
        const { project } = get();

        for (const track of project.timeline.tracks) {
          const clip = track.clips.find((c) => c.id === clipId);
          if (clip) {
            return clip.audioEffects || [];
          }
        }
        return [];
      },

      /**
       * Update keyframes for a clip
       * Keyframe animation support
       */
      updateClipKeyframes: (clipId: string, keyframes: Keyframe[]) => {
        const { project } = get();

        for (const track of project.timeline.tracks) {
          const clipIndex = track.clips.findIndex((c) => c.id === clipId);
          if (clipIndex !== -1) {
            const clip = track.clips[clipIndex];
            const updatedClip = { ...clip, keyframes };
            const updatedClips = [...track.clips];
            updatedClips[clipIndex] = updatedClip;
            const updatedTrack = { ...track, clips: updatedClips };
            const updatedTracks = project.timeline.tracks.map((t) =>
              t.id === track.id ? updatedTrack : t,
            );
            const updatedProject = {
              ...project,
              timeline: { ...project.timeline, tracks: updatedTracks },
              modifiedAt: Date.now(),
            };
            set({ project: updatedProject });
            return true;
          }
        }
        return false;
      },
    };
  }),
);
