import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { renderLayersToDataURL } from '../services/export-service';
import {
  createProjectDocument,
  deserializeProject,
  duplicateLayerInProject,
} from '@openreel/image-core/operations';
import {
  type Command,
  AddArtboardCommand,
  AddAssetCommand,
  AddLayerCommand,
  CompositeCommand,
  DuplicateLayerCommand,
  GroupLayersCommand,
  PasteLayersCommand,
  RemoveArtboardCommand,
  RemoveAssetCommand,
  RemoveLayerCommand,
  ReorderLayerCommand,
  SetProjectNameCommand,
  UngroupLayersCommand,
  UpdateArtboardCommand,
  UpdateAssetCommand,
  UpdateLayerStyleCommand,
  UpdateLayerTransformCommand,
  UpdateTextCommand,
} from '@openreel/image-core/commands';
import {
  Project,
  Layer,
  ImageLayer,
  TextLayer,
  ShapeLayer,
  GroupLayer,
  Artboard,
  MediaAsset,
  Transform,
  DEFAULT_TRANSFORM,
  DEFAULT_BLEND_MODE,
  DEFAULT_SHADOW,
  DEFAULT_INNER_SHADOW,
  DEFAULT_STROKE,
  DEFAULT_GLOW,
  DEFAULT_FILTER,
  DEFAULT_TEXT_STYLE,
  DEFAULT_SHAPE_STYLE,
  DEFAULT_LEVELS,
  DEFAULT_CURVES,
  DEFAULT_COLOR_BALANCE,
  DEFAULT_SELECTIVE_COLOR,
  DEFAULT_BLACK_WHITE,
  DEFAULT_PHOTO_FILTER,
  DEFAULT_CHANNEL_MIXER,
  DEFAULT_GRADIENT_MAP,
  DEFAULT_POSTERIZE,
  DEFAULT_THRESHOLD,
  CanvasSize,
  CanvasBackground,
} from '../types/project';
import { useHistoryStore } from './history-store';

interface LayerStyle {
  blendMode: Layer['blendMode'];
  shadow: Layer['shadow'];
  innerShadow: Layer['innerShadow'];
  stroke: Layer['stroke'];
  glow: Layer['glow'];
  filters: Layer['filters'];
}

interface ProjectState {
  project: Project | null;
  selectedLayerIds: string[];
  selectedArtboardId: string | null;
  copiedLayers: Layer[];
  copiedStyle: LayerStyle | null;
  isDirty: boolean;
}

interface ProjectActions {
  createProject: (name: string, size: CanvasSize, background?: CanvasBackground) => void;
  loadProject: (project: Project) => void;
  closeProject: () => void;
  setProjectName: (name: string) => void;

  // Convenience undo/redo that delegate to the history store.
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  /**
   * Run several mutations as ONE undo step.
   *
   * A single action the user (or the agent) asked for is often several primitive
   * commands — "place this image" is register-asset + add-layer; "add a headline"
   * is add-layer + set-style. Run individually they became N undo entries, so one
   * Ctrl+Z tore the action in half.
   *
   * Inside `fn`, call the normal store methods. They apply as they go (each sees
   * the state the last one produced) but record nothing; on return, everything is
   * committed as one labelled `CompositeCommand`.
   *
   * ALL-OR-NOTHING: if `fn` throws, the project is restored to its pre-transaction
   * state and NOTHING is recorded — no torn, un-undoable half-edit. The error is
   * re-thrown so the caller can report it.
   *
   * Nesting is safe (inner calls join the outer transaction). Returns whatever
   * `fn` returns, so callers can hand back new layer ids.
   */
  runTransaction: <T>(label: string, fn: () => T) => T;

  addArtboard: (name: string, size: CanvasSize, position?: { x: number; y: number }) => string;
  removeArtboard: (artboardId: string) => void;
  updateArtboard: (artboardId: string, updates: Partial<Artboard>) => void;
  selectArtboard: (artboardId: string | null) => void;

  addImageLayer: (sourceId: string, transform?: Partial<Transform>) => string;
  addTextLayer: (content: string, transform?: Partial<Transform>) => string;
  addShapeLayer: (shapeType: ShapeLayer['shapeType'], transform?: Partial<Transform>) => string;
  addPathLayer: (points: { x: number; y: number }[], strokeColor: string, strokeWidth: number) => string;
  addGroupLayer: (childIds: string[]) => string;
  removeLayer: (layerId: string) => void;
  removeLayers: (layerIds: string[]) => void;
  updateLayer: <T extends Layer>(layerId: string, updates: Partial<T>) => void;
  updateLayerTransform: (layerId: string, transform: Partial<Transform>) => void;
  duplicateLayer: (layerId: string) => string | null;
  duplicateLayers: (layerIds: string[]) => string[];

  selectLayer: (layerId: string, addToSelection?: boolean) => void;
  selectLayers: (layerIds: string[]) => void;
  deselectLayer: (layerId: string) => void;
  deselectAllLayers: () => void;
  selectAllLayers: () => void;

  moveLayerUp: (layerId: string) => void;
  moveLayerDown: (layerId: string) => void;
  moveLayerToTop: (layerId: string) => void;
  moveLayerToBottom: (layerId: string) => void;
  reorderLayers: (layerIds: string[]) => void;

  copyLayers: () => void;
  cutLayers: () => void;
  pasteLayers: () => void;

  copyLayerStyle: () => void;
  pasteLayerStyle: () => void;

  groupLayers: (layerIds: string[]) => string | null;
  ungroupLayers: (groupId: string) => void;
  mergeDown: (layerId: string) => Promise<void>;
  flattenImage: () => Promise<void>;

  addAsset: (asset: MediaAsset) => void;
  /** Replace an asset's pixels via an UNDOABLE command (brush/eraser/retouch/
   *  bucket commit). Snapshots the prior asset so Ctrl+Z restores it. */
  commitRasterEdit: (assetId: string, newAsset: MediaAsset, description?: string) => void;
  removeAsset: (assetId: string) => void;

  markDirty: () => void;
  markClean: () => void;
}

const generateId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

/**
 * Monotonic revision counter for optimistic concurrency.
 *
 * The agent reads the canvas, thinks, then writes; `rev` is how a write proves it
 * was computed from the state that is still there. `project.updatedAt` CANNOT do
 * this job: it is `Date.now()` in milliseconds, so two edits inside the same
 * millisecond carry the same value and a stale write sails through the guard —
 * and a clock adjustment can even move it backwards.
 *
 * A counter has neither problem. It is bumped from a subscription (below) rather
 * than by hand at each mutation, so every path that changes the project — the
 * ones written here, and the ones added later — is covered without anyone having
 * to remember.
 */
let projectRev = 0;

/** Current revision. Echoed to the agent on reads and checked on writes. */
export function getProjectRev(): number {
  return projectRev;
}

/**
 * Open transaction, if any (see `runTransaction`).
 *
 * While one is open, `execCmd` still APPLIES each command — inner store methods
 * read the project the previous step produced, so they must see real state — but
 * it records nothing. The commands accumulate here and are committed as one
 * `CompositeCommand`, so a multi-part action is a single undo step.
 *
 * Module-level (not store state) because it is per-call-stack bookkeeping, not
 * something any component should re-render on.
 */
let openTx: { depth: number; commands: Command[]; projectBefore: Project | null } | null = null;

// Helper to apply a command and update the project in one shot.
function execCmd(project: Project, command: Command): Project {
  if (openTx) {
    openTx.commands.push(command);
    return command.apply(project);
  }
  return useHistoryStore.getState().execute(command, project);
}

/** A fresh image layer (all defaults) at the artboard origin — used by
 *  merge/flatten. Mirrors the layer object built by addImageLayer. */
function buildMergedImageLayer(name: string, sourceId: string, width: number, height: number): ImageLayer {
  return {
    id: generateId(),
    name,
    type: 'image',
    visible: true,
    locked: false,
    transform: { ...DEFAULT_TRANSFORM, width, height, x: 0, y: 0 },
    blendMode: DEFAULT_BLEND_MODE,
    shadow: DEFAULT_SHADOW,
    innerShadow: DEFAULT_INNER_SHADOW,
    stroke: DEFAULT_STROKE,
    glow: DEFAULT_GLOW,
    filters: DEFAULT_FILTER,
    parentId: null,
    sourceId,
    cropRect: null,
    flipHorizontal: false,
    flipVertical: false,
    mask: null,
    clippingMask: false,
    levels: { ...DEFAULT_LEVELS },
    curves: { ...DEFAULT_CURVES },
    colorBalance: { ...DEFAULT_COLOR_BALANCE },
    selectiveColor: { ...DEFAULT_SELECTIVE_COLOR },
    blackWhite: { ...DEFAULT_BLACK_WHITE },
    photoFilter: { ...DEFAULT_PHOTO_FILTER },
    channelMixer: { ...DEFAULT_CHANNEL_MIXER },
    gradientMap: { ...DEFAULT_GRADIENT_MAP },
    posterize: { ...DEFAULT_POSTERIZE },
    threshold: { ...DEFAULT_THRESHOLD },
  };
}

export const useProjectStore = create<ProjectState & ProjectActions>()(
  subscribeWithSelector(
    immer((set, get) => ({
      project: null,
      selectedLayerIds: [],
      selectedArtboardId: null,
      copiedLayers: [],
      copiedStyle: null,
      isDirty: false,

      // ── Project lifecycle ────────────────────────────────────────────────

      createProject: (name, size, background) => {
        const artboardId = generateId();
        const project = createProjectDocument({
          id: generateId(),
          artboardId,
          name,
          size,
          background,
        });
        useHistoryStore.getState().clear(project);
        set({ project, selectedLayerIds: [], selectedArtboardId: artboardId, isDirty: true });
      },

      loadProject: (project) => {
        const parsed = deserializeProject(project as unknown as Record<string, unknown>);
        if (!parsed.success) {
          console.error('[project-store] Invalid project:', parsed.error);
          return;
        }
        const validated = parsed.data;
        // Reset history to THIS project — otherwise the previous project's
        // undo/redo stacks survive and the first Ctrl+Z applies an inverse from
        // the old project onto this one (cross-project corruption).
        useHistoryStore.getState().clear(validated);
        set({
          project: validated,
          selectedLayerIds: [],
          selectedArtboardId: validated.activeArtboardId,
          isDirty: false,
        });
      },

      closeProject: () => {
        useHistoryStore.getState().clear();
        set({ project: null, selectedLayerIds: [], selectedArtboardId: null, isDirty: false });
      },

      setProjectName: (name) => {
        const { project } = get();
        if (!project) return;
        const cmd = new SetProjectNameCommand(name, project.name);
        const newProject = execCmd(project, cmd);
        set({ project: newProject, isDirty: true });
      },

      // ── Transactions ────────────────────────────────────────────────────

      runTransaction: (label, fn) => {
        const before = get().project;
        if (!before) return fn();

        // Nested call — join the transaction already in flight. Only the
        // outermost one commits, so the whole nest is one undo step.
        if (openTx) {
          openTx.depth += 1;
          try {
            return fn();
          } finally {
            openTx.depth -= 1;
          }
        }

        openTx = { depth: 1, commands: [], projectBefore: before };
        let result: ReturnType<typeof fn>;
        try {
          result = fn();
        } catch (err) {
          // All-or-nothing: put the document back exactly as it was and record
          // nothing. A half-applied action with no undo entry is the one outcome
          // we must never leave behind.
          const tx = openTx;
          openTx = null;
          if (tx.commands.length > 0) {
            set({
              project: tx.projectBefore,
              selectedLayerIds: [],
              selectedArtboardId: tx.projectBefore?.activeArtboardId ?? null,
            });
          }
          throw err;
        }

        const tx = openTx;
        openTx = null;
        if (!tx || tx.commands.length === 0) return result;

        // Already applied by the inner calls — hand history the composite so the
        // whole thing is one entry with one inverse.
        const composite = tx.commands.length === 1 && label === ''
          ? tx.commands[0]
          : new CompositeCommand(tx.commands, label || 'Edit');
        useHistoryStore.getState().record(composite, before);
        set({ isDirty: true });
        return result;
      },

      // ── Undo / Redo ─────────────────────────────────────────────────────

      undo: () => {
        const { project } = get();
        if (!project) return;
        const newProject = useHistoryStore.getState().undo(project);
        if (newProject) {
          set({
            project: newProject,
            selectedLayerIds: [],
            selectedArtboardId: newProject.activeArtboardId,
            isDirty: true,
          });
        }
      },

      redo: () => {
        const { project } = get();
        if (!project) return;
        const newProject = useHistoryStore.getState().redo(project);
        if (newProject) {
          set({
            project: newProject,
            selectedLayerIds: [],
            selectedArtboardId: newProject.activeArtboardId,
            isDirty: true,
          });
        }
      },

      canUndo: () => useHistoryStore.getState().canUndo(),
      canRedo: () => useHistoryStore.getState().canRedo(),

      // ── Artboard operations ──────────────────────────────────────────────

      addArtboard: (name, size, position) => {
        const { project } = get();
        if (!project) return '';
        const id = generateId();
        const artboard: Artboard = {
          id,
          name,
          size,
          background: { type: 'color', color: '#ffffff' },
          layerIds: [],
          position: position ?? {
            x: (project.artboards.length % 3) * (size.width + 100),
            y: Math.floor(project.artboards.length / 3) * (size.height + 100),
          },
        };
        const insertIndex = project.artboards.length;
        const cmd = new AddArtboardCommand(artboard, insertIndex);
        const newProject = execCmd(project, cmd);
        set({ project: newProject, isDirty: true });
        return id;
      },

      removeArtboard: (artboardId) => {
        const { project } = get();
        if (!project || project.artboards.length <= 1) return;
        const artboard = project.artboards.find((a) => a.id === artboardId);
        if (!artboard) return;
        const removedLayers: Record<string, Layer> = {};
        artboard.layerIds.forEach((id) => {
          if (project.layers[id]) removedLayers[id] = project.layers[id];
        });
        const originalIndex = project.artboards.findIndex((a) => a.id === artboardId);
        const cmd = new RemoveArtboardCommand(artboardId, artboard, removedLayers, originalIndex);
        const newProject = execCmd(project, cmd);
        const { selectedArtboardId } = get();
        const nextSelectedArtboard =
          selectedArtboardId === artboardId
            ? newProject.artboards[0]?.id ?? null
            : selectedArtboardId;
        set({ project: newProject, selectedArtboardId: nextSelectedArtboard, isDirty: true });
      },

      updateArtboard: (artboardId, updates) => {
        const { project } = get();
        if (!project) return;
        const artboard = project.artboards.find((a) => a.id === artboardId);
        if (!artboard) return;
        const prevValues: Partial<Artboard> = {};
        (Object.keys(updates) as (keyof Artboard)[]).forEach((k) => {
          (prevValues as Record<string, unknown>)[k] = artboard[k];
        });
        const cmd = new UpdateArtboardCommand(artboardId, updates, prevValues);
        const newProject = execCmd(project, cmd);
        set({ project: newProject, isDirty: true });
      },

      selectArtboard: (artboardId) => {
        set({ selectedArtboardId: artboardId, selectedLayerIds: [] });
      },

      // ── Layer add helpers ────────────────────────────────────────────────

      addImageLayer: (sourceId, transform) => {
        const id = generateId();
        const { project, selectedArtboardId } = get();
        if (!project || !selectedArtboardId) return id;
        const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
        if (!artboard) return id;
        const asset = project.assets[sourceId];
        const layer: ImageLayer = {
          id,
          name: asset?.name ?? 'Image',
          type: 'image',
          visible: true,
          locked: false,
          transform: {
            ...DEFAULT_TRANSFORM,
            width: asset?.width ?? 200,
            height: asset?.height ?? 200,
            x: (artboard.size.width - (asset?.width ?? 200)) / 2,
            y: (artboard.size.height - (asset?.height ?? 200)) / 2,
            ...transform,
          },
          blendMode: DEFAULT_BLEND_MODE,
          shadow: DEFAULT_SHADOW,
          innerShadow: DEFAULT_INNER_SHADOW,
          stroke: DEFAULT_STROKE,
          glow: DEFAULT_GLOW,
          filters: DEFAULT_FILTER,
          parentId: null,
          sourceId,
          cropRect: null,
          flipHorizontal: false,
          flipVertical: false,
          mask: null,
          clippingMask: false,
          levels: { ...DEFAULT_LEVELS },
          curves: { ...DEFAULT_CURVES },
          colorBalance: { ...DEFAULT_COLOR_BALANCE },
          selectiveColor: { ...DEFAULT_SELECTIVE_COLOR },
          blackWhite: { ...DEFAULT_BLACK_WHITE },
          photoFilter: { ...DEFAULT_PHOTO_FILTER },
          channelMixer: { ...DEFAULT_CHANNEL_MIXER },
          gradientMap: { ...DEFAULT_GRADIENT_MAP },
          posterize: { ...DEFAULT_POSTERIZE },
          threshold: { ...DEFAULT_THRESHOLD },
        };
        const cmd = new AddLayerCommand(selectedArtboardId, layer, 0);
        const newProject = execCmd(project, cmd);
        set({ project: newProject, selectedLayerIds: [id], isDirty: true });
        return id;
      },

      addTextLayer: (content, transform) => {
        const id = generateId();
        const { project, selectedArtboardId } = get();
        if (!project || !selectedArtboardId) return id;
        const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
        if (!artboard) return id;
        const layer: TextLayer = {
          id,
          // Single-line label. Multi-line copy used to put its raw newlines in
          // the layer name, so a headline showed as "Design\nat the speed\n" in
          // the Layers panel and in every agent read of the canvas.
          name: content.replace(/\s+/g, ' ').trim().slice(0, 24) || 'Text',
          type: 'text',
          visible: true,
          locked: false,
          transform: {
            ...DEFAULT_TRANSFORM,
            width: 200,
            height: 50,
            x: (artboard.size.width - 200) / 2,
            y: (artboard.size.height - 50) / 2,
            ...transform,
          },
          blendMode: DEFAULT_BLEND_MODE,
          shadow: DEFAULT_SHADOW,
          innerShadow: DEFAULT_INNER_SHADOW,
          stroke: DEFAULT_STROKE,
          glow: DEFAULT_GLOW,
          filters: DEFAULT_FILTER,
          parentId: null,
          flipHorizontal: false,
          flipVertical: false,
          content,
          style: DEFAULT_TEXT_STYLE,
          autoSize: true,
          mask: null,
          clippingMask: false,
          levels: { ...DEFAULT_LEVELS },
          curves: { ...DEFAULT_CURVES },
          colorBalance: { ...DEFAULT_COLOR_BALANCE },
          selectiveColor: { ...DEFAULT_SELECTIVE_COLOR },
          blackWhite: { ...DEFAULT_BLACK_WHITE },
          photoFilter: { ...DEFAULT_PHOTO_FILTER },
          channelMixer: { ...DEFAULT_CHANNEL_MIXER },
          gradientMap: { ...DEFAULT_GRADIENT_MAP },
          posterize: { ...DEFAULT_POSTERIZE },
          threshold: { ...DEFAULT_THRESHOLD },
        };
        const cmd = new AddLayerCommand(selectedArtboardId, layer, 0);
        const newProject = execCmd(project, cmd);
        set({ project: newProject, selectedLayerIds: [id], isDirty: true });
        return id;
      },

      addShapeLayer: (shapeType, transform) => {
        const id = generateId();
        const { project, selectedArtboardId } = get();
        if (!project || !selectedArtboardId) return id;
        const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
        if (!artboard) return id;
        const layer: ShapeLayer = {
          id,
          name: shapeType.charAt(0).toUpperCase() + shapeType.slice(1),
          type: 'shape',
          visible: true,
          locked: false,
          transform: {
            ...DEFAULT_TRANSFORM,
            width: 100,
            height: 100,
            x: (artboard.size.width - 100) / 2,
            y: (artboard.size.height - 100) / 2,
            ...transform,
          },
          blendMode: DEFAULT_BLEND_MODE,
          shadow: DEFAULT_SHADOW,
          innerShadow: DEFAULT_INNER_SHADOW,
          stroke: DEFAULT_STROKE,
          glow: DEFAULT_GLOW,
          filters: DEFAULT_FILTER,
          parentId: null,
          flipHorizontal: false,
          flipVertical: false,
          shapeType,
          shapeStyle: DEFAULT_SHAPE_STYLE,
          mask: null,
          clippingMask: false,
          levels: { ...DEFAULT_LEVELS },
          curves: { ...DEFAULT_CURVES },
          colorBalance: { ...DEFAULT_COLOR_BALANCE },
          selectiveColor: { ...DEFAULT_SELECTIVE_COLOR },
          blackWhite: { ...DEFAULT_BLACK_WHITE },
          photoFilter: { ...DEFAULT_PHOTO_FILTER },
          channelMixer: { ...DEFAULT_CHANNEL_MIXER },
          gradientMap: { ...DEFAULT_GRADIENT_MAP },
          posterize: { ...DEFAULT_POSTERIZE },
          threshold: { ...DEFAULT_THRESHOLD },
        };
        const cmd = new AddLayerCommand(selectedArtboardId, layer, 0);
        const newProject = execCmd(project, cmd);
        set({ project: newProject, selectedLayerIds: [id], isDirty: true });
        return id;
      },

      addPathLayer: (points, strokeColor, strokeWidth) => {
        const id = generateId();
        const { project, selectedArtboardId } = get();
        if (!project || !selectedArtboardId || points.length <= 1) return id;
        const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
        if (!artboard) return id;
        // Pad the bounds by half the stroke width (+ a hair for round caps and
        // antialiasing). The stroke extends strokeWidth/2 beyond the point centres
        // on every side, so a box fitted to the raw points clipped the stroke's
        // edges and caps — the "cropped drawing" bug.
        const pad = Math.ceil(strokeWidth / 2) + 2;
        const minX = Math.min(...points.map((p) => p.x)) - pad;
        const minY = Math.min(...points.map((p) => p.y)) - pad;
        const maxX = Math.max(...points.map((p) => p.x)) + pad;
        const maxY = Math.max(...points.map((p) => p.y)) + pad;
        const width = Math.max(maxX - minX, 1);
        const height = Math.max(maxY - minY, 1);
        const normalizedPoints = points.map((p) => ({ x: p.x - minX, y: p.y - minY }));
        const layer: ShapeLayer = {
          id,
          name: 'Drawing',
          type: 'shape',
          visible: true,
          locked: false,
          transform: { ...DEFAULT_TRANSFORM, x: minX, y: minY, width, height },
          blendMode: DEFAULT_BLEND_MODE,
          shadow: DEFAULT_SHADOW,
          innerShadow: DEFAULT_INNER_SHADOW,
          stroke: DEFAULT_STROKE,
          glow: DEFAULT_GLOW,
          filters: DEFAULT_FILTER,
          parentId: null,
          flipHorizontal: false,
          flipVertical: false,
          shapeType: 'path',
          shapeStyle: { ...DEFAULT_SHAPE_STYLE, fill: null, stroke: strokeColor, strokeWidth },
          points: normalizedPoints,
          mask: null,
          clippingMask: false,
          levels: { ...DEFAULT_LEVELS },
          curves: { ...DEFAULT_CURVES },
          colorBalance: { ...DEFAULT_COLOR_BALANCE },
          selectiveColor: { ...DEFAULT_SELECTIVE_COLOR },
          blackWhite: { ...DEFAULT_BLACK_WHITE },
          photoFilter: { ...DEFAULT_PHOTO_FILTER },
          channelMixer: { ...DEFAULT_CHANNEL_MIXER },
          gradientMap: { ...DEFAULT_GRADIENT_MAP },
          posterize: { ...DEFAULT_POSTERIZE },
          threshold: { ...DEFAULT_THRESHOLD },
        };
        const cmd = new AddLayerCommand(selectedArtboardId, layer, 0, 'Draw path');
        const newProject = execCmd(project, cmd);
        set({ project: newProject, selectedLayerIds: [id], isDirty: true });
        return id;
      },

      addGroupLayer: (childIds) => {
        const id = generateId();
        const { project, selectedArtboardId } = get();
        if (!project || !selectedArtboardId || childIds.length === 0) return id;
        const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
        if (!artboard) return id;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        childIds.forEach((childId) => {
          const child = project.layers[childId];
          if (child) {
            const { x, y, width, height } = child.transform;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + width);
            maxY = Math.max(maxY, y + height);
          }
        });

        const groupX = minX;
        const groupY = minY;
        const groupWidth = maxX - minX;
        const groupHeight = maxY - minY;

        // Capture children before state (with adjusted coordinates) for the group.
        const childLayersBefore: Record<string, Layer> = {};
        const adjustedChildren: Record<string, Layer> = {};
        childIds.forEach((childId) => {
          const child = project.layers[childId];
          if (child) {
            childLayersBefore[childId] = JSON.parse(JSON.stringify(child));
            adjustedChildren[childId] = {
              ...JSON.parse(JSON.stringify(child)),
              transform: { ...child.transform, x: child.transform.x - groupX, y: child.transform.y - groupY },
              parentId: id,
            };
          }
        });

        const groupLayer: GroupLayer = {
          id,
          name: 'Group',
          type: 'group',
          visible: true,
          locked: false,
          transform: { ...DEFAULT_TRANSFORM, x: groupX, y: groupY, width: groupWidth, height: groupHeight },
          blendMode: DEFAULT_BLEND_MODE,
          shadow: DEFAULT_SHADOW,
          innerShadow: DEFAULT_INNER_SHADOW,
          stroke: DEFAULT_STROKE,
          glow: DEFAULT_GLOW,
          filters: DEFAULT_FILTER,
          parentId: null,
          flipHorizontal: false,
          flipVertical: false,
          childIds,
          expanded: true,
          mask: null,
          clippingMask: false,
          levels: { ...DEFAULT_LEVELS },
          curves: { ...DEFAULT_CURVES },
          colorBalance: { ...DEFAULT_COLOR_BALANCE },
          selectiveColor: { ...DEFAULT_SELECTIVE_COLOR },
          blackWhite: { ...DEFAULT_BLACK_WHITE },
          photoFilter: { ...DEFAULT_PHOTO_FILTER },
          channelMixer: { ...DEFAULT_CHANNEL_MIXER },
          gradientMap: { ...DEFAULT_GRADIENT_MAP },
          posterize: { ...DEFAULT_POSTERIZE },
          threshold: { ...DEFAULT_THRESHOLD },
        };

        const firstChildIndex = artboard.layerIds.findIndex((lid) => childIds.includes(lid));
        const prevArtboardLayerIds = [...artboard.layerIds];
        const cmd = new GroupLayersCommand(
          selectedArtboardId,
          groupLayer,
          Math.max(firstChildIndex, 0),
          prevArtboardLayerIds,
          adjustedChildren,
        );
        const newProject = execCmd(project, cmd);
        set({ project: newProject, selectedLayerIds: [id], isDirty: true });
        return id;
      },

      removeLayer: (layerId) => {
        const { project, selectedArtboardId } = get();
        if (!project || !project.layers[layerId]) return;
        const layer = project.layers[layerId];
        // Find which artboard owns this layer.
        const ownerArtboard = project.artboards.find(
          (a) => a.layerIds.includes(layerId) || Object.values(project.layers).some(
            (l) => l.type === 'group' && (l as GroupLayer).childIds.includes(layerId) && a.layerIds.includes(l.id)
          )
        ) ?? project.artboards.find((a) => a.id === selectedArtboardId);
        const artboardId = ownerArtboard?.id ?? selectedArtboardId ?? project.artboards[0]?.id ?? '';
        const originalIndex = ownerArtboard?.layerIds.indexOf(layerId) ?? 0;
        const cmd = new RemoveLayerCommand(layerId, artboardId, layer, Math.max(originalIndex, 0));
        const newProject = execCmd(project, cmd);
        set({
          project: newProject,
          selectedLayerIds: get().selectedLayerIds.filter((id) => id !== layerId),
          isDirty: true,
        });
      },

      removeLayers: (layerIds) => {
        layerIds.forEach((id) => get().removeLayer(id));
      },

      updateLayer: (layerId, updates) => {
        const { project } = get();
        if (!project || !project.layers[layerId]) return;
        const layer = project.layers[layerId];
        // Build prevValues capturing only the keys being updated.
        const prevValues: Partial<Layer> = {};
        (Object.keys(updates) as (keyof Layer)[]).forEach((k) => {
          (prevValues as Record<string, unknown>)[k] = layer[k];
        });
        let cmd;
        const textLayer = layer as TextLayer;
        const updatesTyped = updates as Record<string, unknown>;
        if (layer.type === 'text' && ('content' in updates || 'style' in updates)) {
          cmd = new UpdateTextCommand(
            layerId,
            (updatesTyped.content as string | undefined) ?? textLayer.content,
            textLayer.content,
            (updatesTyped.style as TextLayer['style'] | undefined) ?? null,
            (updatesTyped.style !== undefined) ? textLayer.style : null,
          );
        } else {
          cmd = new UpdateLayerStyleCommand(layerId, updates as Partial<Layer>, prevValues);
        }
        const newProject = execCmd(project, cmd);
        set({ project: newProject, isDirty: true });
      },

      updateLayerTransform: (layerId, transform) => {
        const { project } = get();
        if (!project || !project.layers[layerId]) return;
        const layer = project.layers[layerId];
        const prevTransform: Partial<Transform> = {};
        (Object.keys(transform) as (keyof Transform)[]).forEach((k) => {
          (prevTransform as Record<string, unknown>)[k] = layer.transform[k];
        });
        const cmd = new UpdateLayerTransformCommand(layerId, transform, prevTransform);
        const newProject = execCmd(project, cmd);
        set({ project: newProject, isDirty: true });
      },

      duplicateLayer: (layerId) => {
        const { project, selectedArtboardId } = get();
        if (!project || !selectedArtboardId) return null;
        const newId = generateId();
        // Duplicate IN PLACE (Photoshop Ctrl+J) — same position, stacked directly
        // on top. A non-zero offset made the copy jump, which the user never wants.
        const duplicated = duplicateLayerInProject(project, selectedArtboardId, layerId, newId, { x: 0, y: 0 });
        if (!duplicated) return null;
        const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
        const originalIndex = artboard?.layerIds.indexOf(layerId) ?? 0;
        const cmd = new DuplicateLayerCommand(
          selectedArtboardId,
          duplicated.project.layers[newId],
          Math.max(originalIndex, 0),
        );
        const newProject = execCmd(project, cmd);
        set({ project: newProject, selectedLayerIds: [newId], isDirty: true });
        return newId;
      },

      duplicateLayers: (layerIds) =>
        layerIds.map((id) => get().duplicateLayer(id)).filter((id): id is string => id !== null),

      // ── Selection (no commands needed, pure UI state) ────────────────────

      selectLayer: (layerId, addToSelection = false) => {
        set((state) => {
          if (addToSelection) {
            if (!state.selectedLayerIds.includes(layerId)) {
              state.selectedLayerIds.push(layerId);
            }
          } else {
            state.selectedLayerIds = [layerId];
          }
        });
      },

      selectLayers: (layerIds) => set({ selectedLayerIds: layerIds }),

      deselectLayer: (layerId) => {
        set((state) => {
          state.selectedLayerIds = state.selectedLayerIds.filter((id) => id !== layerId);
        });
      },

      deselectAllLayers: () => set({ selectedLayerIds: [] }),

      selectAllLayers: () => {
        const { project, selectedArtboardId } = get();
        if (project && selectedArtboardId) {
          const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
          if (artboard) set({ selectedLayerIds: [...artboard.layerIds] });
        }
      },

      // ── Layer reorder operations ─────────────────────────────────────────

      moveLayerUp: (layerId) => {
        const { project, selectedArtboardId } = get();
        if (!project || !selectedArtboardId) return;
        const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
        if (!artboard) return;
        const index = artboard.layerIds.indexOf(layerId);
        if (index <= 0) return;
        const newIds = [...artboard.layerIds];
        [newIds[index - 1], newIds[index]] = [newIds[index], newIds[index - 1]];
        const cmd = new ReorderLayerCommand(selectedArtboardId, newIds, artboard.layerIds, 'Move layer up');
        const newProject = execCmd(project, cmd);
        set({ project: newProject, isDirty: true });
      },

      moveLayerDown: (layerId) => {
        const { project, selectedArtboardId } = get();
        if (!project || !selectedArtboardId) return;
        const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
        if (!artboard) return;
        const index = artboard.layerIds.indexOf(layerId);
        if (index >= artboard.layerIds.length - 1) return;
        const newIds = [...artboard.layerIds];
        [newIds[index], newIds[index + 1]] = [newIds[index + 1], newIds[index]];
        const cmd = new ReorderLayerCommand(selectedArtboardId, newIds, artboard.layerIds, 'Move layer down');
        const newProject = execCmd(project, cmd);
        set({ project: newProject, isDirty: true });
      },

      moveLayerToTop: (layerId) => {
        const { project, selectedArtboardId } = get();
        if (!project || !selectedArtboardId) return;
        const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
        if (!artboard) return;
        const newIds = [layerId, ...artboard.layerIds.filter((id) => id !== layerId)];
        const cmd = new ReorderLayerCommand(selectedArtboardId, newIds, artboard.layerIds, 'Move layer to top');
        const newProject = execCmd(project, cmd);
        set({ project: newProject, isDirty: true });
      },

      moveLayerToBottom: (layerId) => {
        const { project, selectedArtboardId } = get();
        if (!project || !selectedArtboardId) return;
        const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
        if (!artboard) return;
        const newIds = [...artboard.layerIds.filter((id) => id !== layerId), layerId];
        const cmd = new ReorderLayerCommand(selectedArtboardId, newIds, artboard.layerIds, 'Move layer to bottom');
        const newProject = execCmd(project, cmd);
        set({ project: newProject, isDirty: true });
      },

      reorderLayers: (layerIds) => {
        const { project, selectedArtboardId } = get();
        if (!project || !selectedArtboardId) return;
        const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
        if (!artboard) return;
        const cmd = new ReorderLayerCommand(selectedArtboardId, layerIds, artboard.layerIds);
        const newProject = execCmd(project, cmd);
        set({ project: newProject, isDirty: true });
      },

      // ── Copy / paste ─────────────────────────────────────────────────────

      copyLayers: () => {
        const { project, selectedLayerIds } = get();
        if (project && selectedLayerIds.length > 0) {
          const layers = selectedLayerIds.map((id) => project.layers[id]).filter(Boolean);
          set({ copiedLayers: JSON.parse(JSON.stringify(layers)) });
        }
      },

      cutLayers: () => {
        get().copyLayers();
        get().removeLayers(get().selectedLayerIds);
      },

      pasteLayers: () => {
        const { copiedLayers, selectedArtboardId, project } = get();
        if (!copiedLayers.length || !selectedArtboardId || !project) return;
        const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
        if (!artboard) return;
        const pastedLayers: Layer[] = copiedLayers.map((layer) => ({
          ...JSON.parse(JSON.stringify(layer)),
          id: generateId(),
          name: `${layer.name} copy`,
          transform: { ...layer.transform, x: layer.transform.x + 20, y: layer.transform.y + 20 },
        }));
        const cmd = new PasteLayersCommand(selectedArtboardId, pastedLayers, artboard.layerIds);
        const newProject = execCmd(project, cmd);
        set({
          project: newProject,
          selectedLayerIds: pastedLayers.map((l) => l.id),
          isDirty: true,
        });
      },

      // ── Style copy/paste (pure UI state + one UpdateLayerStyleCommand) ──

      copyLayerStyle: () => {
        const { project, selectedLayerIds } = get();
        if (project && selectedLayerIds.length === 1) {
          const layer = project.layers[selectedLayerIds[0]];
          if (layer) {
            set({
              copiedStyle: {
                blendMode: layer.blendMode ? JSON.parse(JSON.stringify(layer.blendMode)) : DEFAULT_BLEND_MODE,
                shadow: layer.shadow ? JSON.parse(JSON.stringify(layer.shadow)) : DEFAULT_SHADOW,
                innerShadow: layer.innerShadow ? JSON.parse(JSON.stringify(layer.innerShadow)) : DEFAULT_INNER_SHADOW,
                stroke: layer.stroke ? JSON.parse(JSON.stringify(layer.stroke)) : DEFAULT_STROKE,
                glow: layer.glow ? JSON.parse(JSON.stringify(layer.glow)) : DEFAULT_GLOW,
                filters: layer.filters ? JSON.parse(JSON.stringify(layer.filters)) : DEFAULT_FILTER,
              },
            });
          }
        }
      },

      pasteLayerStyle: () => {
        const { copiedStyle, selectedLayerIds } = get();
        let currentProject = get().project;
        if (!copiedStyle || !selectedLayerIds.length || !currentProject) return;

        for (const layerId of selectedLayerIds) {
          // Read from currentProject (updated after each command) to get fresh prevValues.
          const layer = currentProject.layers[layerId];
          if (!layer) continue;
          const styleUpdates: Partial<Layer> = {
            blendMode: structuredClone(copiedStyle.blendMode ?? DEFAULT_BLEND_MODE),
            shadow: structuredClone(copiedStyle.shadow ?? DEFAULT_SHADOW),
            innerShadow: structuredClone(copiedStyle.innerShadow ?? DEFAULT_INNER_SHADOW),
            stroke: structuredClone(copiedStyle.stroke ?? DEFAULT_STROKE),
            glow: structuredClone(copiedStyle.glow ?? DEFAULT_GLOW),
            filters: structuredClone(copiedStyle.filters ?? DEFAULT_FILTER),
          };
          const prevValues: Partial<Layer> = {
            blendMode: layer.blendMode,
            shadow: layer.shadow,
            innerShadow: layer.innerShadow,
            stroke: layer.stroke,
            glow: layer.glow,
            filters: layer.filters,
          };
          const cmd = new UpdateLayerStyleCommand(layerId, styleUpdates, prevValues, 'Paste layer style');
          currentProject = execCmd(currentProject, cmd);
        }
        set({ project: currentProject, isDirty: true });
      },

      // ── Group / ungroup ──────────────────────────────────────────────────

      groupLayers: (layerIds) => {
        if (layerIds.length < 2) return null;
        return get().addGroupLayer(layerIds);
      },

      ungroupLayers: (groupId) => {
        const { project, selectedArtboardId } = get();
        if (!project || !selectedArtboardId) return;
        const group = project.layers[groupId] as GroupLayer;
        if (!group || group.type !== 'group') return;
        const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
        if (!artboard) return;
        const prevArtboardLayerIds = [...artboard.layerIds];
        const childLayersBefore: Record<string, Layer> = {};
        group.childIds.forEach((childId) => {
          if (project.layers[childId]) {
            childLayersBefore[childId] = JSON.parse(JSON.stringify(project.layers[childId]));
          }
        });
        const cmd = new UngroupLayersCommand(
          selectedArtboardId,
          groupId,
          JSON.parse(JSON.stringify(group)),
          prevArtboardLayerIds,
          childLayersBefore,
        );
        const newProject = execCmd(project, cmd);
        set({ project: newProject, selectedLayerIds: group.childIds, isDirty: true });
      },

      mergeDown: async (layerId) => {
        const { project, selectedArtboardId } = get();
        if (!project) return;
        const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
        if (!artboard) return;
        const idx = artboard.layerIds.indexOf(layerId);
        if (idx < 0 || idx >= artboard.layerIds.length - 1) return; // nothing below
        const belowId = artboard.layerIds[idx + 1];
        const target = project.layers[layerId];
        const below = project.layers[belowId];
        if (!target || !below) return;
        const W = artboard.size.width, H = artboard.size.height;
        // Composite below (bottom) then target (top) using the export render path.
        const dataUrl = await renderLayersToDataURL(project, [belowId, layerId], W, H);

        const cur = get().project; // re-read after the async render
        if (!cur) return;
        const ab = cur.artboards.find((a) => a.id === artboard.id);
        if (!ab) return;
        const assetId = generateId();
        const mergedAsset: MediaAsset = {
          id: assetId, name: target.name, type: 'image', mimeType: 'image/png',
          size: dataUrl.length, width: Math.round(W), height: Math.round(H),
          thumbnailUrl: dataUrl, dataUrl,
        };
        const merged = buildMergedImageLayer(target.name, assetId, W, H);
        // ONE undo step for one action. This used to be three separate entries
        // AND the merged asset was spliced in outside the command stack — so
        // undoing a merge took three Ctrl+Z presses and orphaned the asset.
        // The async render is deliberately outside the transaction: only the
        // synchronous command sequence belongs inside it.
        get().runTransaction(`Merge "${target.name}" down`, () => {
          let p: Project = execCmd(cur, new AddAssetCommand(mergedAsset, 'Merged pixels'));
          p = execCmd(p, new AddLayerCommand(artboard.id, merged, Math.max(ab.layerIds.indexOf(belowId), 0)));
          let t = p.artboards.find((a) => a.id === artboard.id)!;
          p = execCmd(p, new RemoveLayerCommand(layerId, artboard.id, target, t.layerIds.indexOf(layerId)));
          t = p.artboards.find((a) => a.id === artboard.id)!;
          p = execCmd(p, new RemoveLayerCommand(belowId, artboard.id, below, t.layerIds.indexOf(belowId)));
          set({ project: p, selectedLayerIds: [merged.id], isDirty: true });
        });
      },

      flattenImage: async () => {
        const { project, selectedArtboardId } = get();
        if (!project) return;
        const artboard = project.artboards.find((a) => a.id === selectedArtboardId);
        if (!artboard || artboard.layerIds.length === 0) return;
        const W = artboard.size.width, H = artboard.size.height;
        const bottomToTop = [...artboard.layerIds].reverse();
        const dataUrl = await renderLayersToDataURL(project, bottomToTop, W, H);

        const cur = get().project;
        if (!cur) return;
        const ab = cur.artboards.find((a) => a.id === artboard.id);
        if (!ab) return;
        const assetId = generateId();
        const mergedAsset: MediaAsset = {
          id: assetId, name: 'Flattened', type: 'image', mimeType: 'image/png',
          size: dataUrl.length, width: Math.round(W), height: Math.round(H),
          thumbnailUrl: dataUrl, dataUrl,
        };
        const merged = buildMergedImageLayer('Flattened', assetId, W, H);
        // One undo step — flattening a 12-layer poster used to cost 13 presses
        // to reverse, and the flattened asset was never on the command stack.
        get().runTransaction('Flatten image', () => {
          let p: Project = execCmd(cur, new AddAssetCommand(mergedAsset, 'Flattened pixels'));
          p = execCmd(p, new AddLayerCommand(artboard.id, merged, ab.layerIds.length));
          for (const id of [...ab.layerIds]) {
            const lyr = p.layers[id];
            if (!lyr) continue;
            const t = p.artboards.find((a) => a.id === artboard.id)!;
            p = execCmd(p, new RemoveLayerCommand(id, artboard.id, lyr, t.layerIds.indexOf(id)));
          }
          set({ project: p, selectedLayerIds: [merged.id], isDirty: true });
        });
      },

      // ── Assets (undoable — see AddAssetCommand) ──────────────────────────

      addAsset: (asset) => {
        const { project } = get();
        if (!project) return;
        // Asset registration used to bypass the command stack and then wipe the
        // redo stack to stay safe. That made every composite half-undoable:
        // "place an image" left an orphan asset behind after one Ctrl+Z, and redo
        // was already gone. It is now a real command, so a transaction can bind
        // it to the layer that uses it and undo removes both together.
        const newProject = execCmd(project, new AddAssetCommand(asset));
        set({ project: newProject, isDirty: true });
      },

      commitRasterEdit: (assetId, newAsset, description) => {
        const { project } = get();
        if (!project) return;
        const before = project.assets[assetId];
        if (!before) { get().addAsset(newAsset); return; } // no prior pixels → plain add
        const cmd = new UpdateAssetCommand(
          assetId,
          JSON.stringify(newAsset),
          JSON.stringify(before),
          description ?? 'Edit pixels',
        );
        const newProject = execCmd(project, cmd);
        set({ project: newProject, isDirty: true });
      },

      removeAsset: (assetId) => {
        const { project } = get();
        if (!project) return;
        const existing = project.assets[assetId];
        if (!existing) return;
        // Carries the whole asset so the inverse can restore the bytes.
        const newProject = execCmd(project, new RemoveAssetCommand(existing));
        set({ project: newProject, isDirty: true });
      },

      markDirty: () => set({ isDirty: true }),
      markClean: () => set({ isDirty: false }),
    }))
  )
);

// Bump the revision on EVERY change to the project object, whatever caused it —
// a store action, a hand edit on the canvas, an agent RPC, or a mutation added
// later by someone who never reads this file. One subscription is what makes the
// concurrency guard complete instead of best-effort.
useProjectStore.subscribe(
  (s) => s.project,
  () => { projectRev += 1; },
);
