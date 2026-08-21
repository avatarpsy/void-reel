/**
 * The structural digest the agent reads before it touches anything.
 *
 * This is the image-surface counterpart of the video editor's `read_timeline`.
 * A timeline describes itself in numbers; a picture does not — so the agent gets
 * TWO senses, and they are deliberately separate:
 *
 *   • this digest  — free, exact, structural. What layers exist, where they sit,
 *                    what the text says, what is masked. No pixels.
 *   • img_view + inspect_media — costs credits, shows what it actually LOOKS like.
 *
 * Keeping them apart is what stops the agent burning a vision call to answer
 * "how many layers are there", and stops it claiming a picture looks right when
 * all it ever read was a layer list.
 *
 * HARD RULE: never put pixel data in here. Assets carry base64 dataUrls that run
 * to megabytes; a digest that inlined them would blow the tool-result budget and
 * the chat transcript with it. Names, ids and dimensions only.
 */

import type { Layer, Project, Artboard } from '../types/project';
import { useProjectStore, getProjectRev } from '../stores/project-store';
import { useSelectionStore } from '../stores/selection-store';
import { useHistoryStore } from '../stores/history-store';
import { useUIStore } from '../stores/ui-store';

export interface LayerDigest {
  id: string;
  name: string;
  type: Layer['type'];
  /** Artboard-space bounds in PIXELS, origin top-left. The one coordinate
   *  convention for this whole surface — see the tool schemas. */
  bounds: { x: number; y: number; width: number; height: number };
  rotation: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  blendMode?: string;
  hasMask: boolean;
  maskEnabled?: boolean;
  clippingMask: boolean;
  /** Nesting depth inside groups (0 = top level), so the agent can read the tree. */
  depth: number;
  parentId: string | null;
  /** Text layers only — the copy itself plus the few style fields that decide
   *  whether it reads on the page. */
  text?: { content: string; fontFamily: string; fontSize: number; color: string; align?: string; weight?: string | number };
  /** Image layers only. */
  image?: { assetId: string; assetName?: string; naturalWidth?: number; naturalHeight?: number };
  /**
   * Present when this layer is a placed DESIGN rather than a photograph.
   *
   * `img_place_composition` tells the agent that "a placed composition reports
   * its block back through img_read_canvas" — and it did not. All the agent saw
   * was an image layer with an empty assetId, which reads as a broken picture,
   * so it had no way to tell a designed slide from a failed one, to fill a slot
   * it had left empty, or to avoid placing the same block twice.
   */
  composition?: { block?: string; authored?: boolean; slots: string[]; unfilled?: string[] };
  /** Shape layers only. */
  shape?: { shapeType: string; fill?: string };
  /** Group layers only. */
  children?: number;
}

export interface PageDigest {
  id: string;
  name: string;
  width: number;
  height: number;
  background?: string;
  layerCount: number;
  layers?: LayerDigest[];
}

export interface CanvasDigest {
  ok: true;
  projectId: string;
  projectName: string;
  /**
   * Optimistic-concurrency token — a MONOTONIC counter, not a timestamp. Mutation
   * tools echo it back as `expectRev`, so an edit computed from a stale read is
   * refused instead of silently overwriting whatever the USER changed in the
   * meantime. This is what lets a person keep working while the agent works.
   */
  rev: number;
  pageCount: number;
  activePageId: string | null;
  pages: PageDigest[];
  selectedLayerIds: string[];
  /** Active pixel selection (from marquee/lasso/wand), if any. */
  selection: { active: boolean; bounds?: { x: number; y: number; width: number; height: number }; inverted?: boolean };
  assets: Array<{ id: string; name: string; width: number; height: number; type: string }>;
  undoDepth: number;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * FALSE when this project was rebuilt from flattened cloud thumbnails because
   * the layered original lives in another browser's IndexedDB. The agent must
   * read this before promising any layer-level edit — otherwise it confidently
   * offers to "move the headline" on a project that has no headline layer.
   */
  layered: boolean;
  /** Set when the editor was opened to edit an existing file in place
   *  (Studio "Edit this image"). Tells the agent that saving can overwrite the
   *  original rather than only making a copy. */
  editSource: { projectId: string; kind: string; filename: string; ext: string } | null;
}

export interface NoProjectDigest {
  ok: false;
  reason: 'no_project';
  message: string;
}

function boundsOf(layer: Layer): LayerDigest['bounds'] {
  const t = layer.transform;
  return {
    x: Math.round(t.x),
    y: Math.round(t.y),
    width: Math.round(t.width),
    height: Math.round(t.height),
  };
}

function digestLayer(project: Project, layer: Layer, depth: number): LayerDigest {
  const d: LayerDigest = {
    id: layer.id,
    name: layer.name,
    type: layer.type,
    bounds: boundsOf(layer),
    rotation: layer.transform.rotation ?? 0,
    opacity: layer.transform.opacity ?? 1,
    visible: layer.visible,
    locked: layer.locked,
    blendMode: (layer.blendMode as any)?.mode,
    hasMask: !!layer.mask,
    maskEnabled: layer.mask ? (layer.mask as any).enabled !== false : undefined,
    clippingMask: !!layer.clippingMask,
    depth,
    parentId: layer.parentId ?? null,
  };

  if (layer.type === 'text') {
    const tl = layer as any;
    d.text = {
      content: String(tl.content ?? ''),
      fontFamily: tl.style?.fontFamily,
      fontSize: tl.style?.fontSize,
      color: tl.style?.color,
      align: tl.style?.textAlign,
      weight: tl.style?.fontWeight,
    };
  } else if (layer.type === 'image') {
    const il = layer as any;
    const asset = project.assets[il.sourceId];
    d.image = {
      assetId: il.sourceId,
      assetName: asset?.name,
      naturalWidth: asset?.width,
      naturalHeight: asset?.height,
    };
    // A composition layer carries no asset — its pixels come from a render — so
    // without this it is indistinguishable from an image whose file went missing.
    if (il.composition) {
      const slots = Object.keys(il.composition.slots ?? {});
      d.composition = {
        ...(il.composition.block ? { block: String(il.composition.block) } : {}),
        ...(il.composition.inlineHtml ? { authored: true } : {}),
        slots,
      };
    }
  } else if (layer.type === 'shape') {
    const sl = layer as any;
    d.shape = { shapeType: sl.shapeType, fill: sl.style?.fill?.color ?? sl.style?.fillColor };
  } else if (layer.type === 'group') {
    d.children = ((layer as any).childIds ?? []).length;
  }

  return d;
}

/** Walk a page's layer tree depth-first so the digest reads top-to-bottom in the
 *  same order the Layers panel shows — the agent and the user describe the same
 *  stack the same way. */
function digestPageLayers(project: Project, artboard: Artboard): LayerDigest[] {
  const out: LayerDigest[] = [];
  const walk = (ids: string[], depth: number) => {
    for (const id of ids) {
      const layer = project.layers[id];
      if (!layer) continue;
      out.push(digestLayer(project, layer, depth));
      if (layer.type === 'group') {
        walk(((layer as any).childIds ?? []) as string[], depth + 1);
      }
    }
  };
  walk(artboard.layerIds, 0);
  return out;
}

/**
 * Build the digest.
 *
 * `pageId` limits the (potentially large) layer detail to one page; without it
 * every page's layers are included. `includeLayers: false` returns page headers
 * only — enough for "how many slides does this carousel have?" without shipping
 * a 200-layer tree.
 */
export function buildCanvasDigest(opts: { pageId?: string; includeLayers?: boolean } = {}): CanvasDigest | NoProjectDigest {
  const { project, selectedArtboardId, selectedLayerIds } = useProjectStore.getState();
  if (!project) {
    return {
      ok: false,
      reason: 'no_project',
      message: 'No image project is open. Create one first, or open an existing one from the Studio Images tab.',
    };
  }

  const includeLayers = opts.includeLayers !== false;
  const pages: PageDigest[] = project.artboards.map((ab) => {
    const wanted = includeLayers && (!opts.pageId || opts.pageId === ab.id);
    return {
      id: ab.id,
      name: ab.name,
      width: Math.round(ab.size.width),
      height: Math.round(ab.size.height),
      background: (ab.background as any)?.color,
      layerCount: ab.layerIds.length,
      ...(wanted ? { layers: digestPageLayers(project, ab) } : {}),
    };
  });

  const sel = useSelectionStore.getState().active;
  const history = useHistoryStore.getState();
  const ui = useUIStore.getState() as any;

  return {
    ok: true,
    projectId: project.id,
    projectName: project.name,
    rev: getProjectRev(),
    pageCount: project.artboards.length,
    activePageId: selectedArtboardId,
    pages,
    selectedLayerIds: [...selectedLayerIds],
    selection: sel
      ? {
          active: true,
          bounds: sel.bounds
            ? {
                x: Math.round(sel.bounds.x),
                y: Math.round(sel.bounds.y),
                width: Math.round(sel.bounds.width),
                height: Math.round(sel.bounds.height),
              }
            : undefined,
          inverted: (sel as any).inverted === true,
        }
      : { active: false },
    assets: Object.values(project.assets).map((a) => ({
      id: a.id, name: a.name, width: a.width, height: a.height, type: a.type,
    })),
    undoDepth: history.getUndoDepth(),
    canUndo: history.canUndo(),
    canRedo: history.canRedo(),
    // A flattened cloud rebuild has one image layer per page and none of the
    // original structure. Matched by project id, so opening anything else here
    // reports layered again without any flag to reset.
    layered: ui?.flattenedProjectId !== project.id,
    editSource: ui?.editSource ?? null,
  };
}
