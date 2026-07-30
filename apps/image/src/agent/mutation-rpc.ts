/**
 * Everything the agent can CHANGE on the canvas.
 *
 * Every handler here is registered through `registerImageMutation`, which gives
 * it three guarantees it cannot opt out of by forgetting:
 *
 *   1. the stale-read guard (`expectRev`) — a hand edit made while the agent was
 *      thinking is never silently overwritten;
 *   2. `runTransaction` — the whole handler is ONE undo entry, labelled with the
 *      action the user asked for ("Place image", not "Add asset" + "Add layer"),
 *      and all-or-nothing if it throws;
 *   3. `breakCoalescing` — two agent calls never fold into one undo step.
 *
 * So a handler is written as a plain function and is correct by construction.
 *
 * REUSE, DON'T REIMPLEMENT: these call the same project-store methods the
 * Inspector's own controls call. A bug fixed in the store is fixed for both, and
 * the agent can never produce a layer shaped differently from a hand-made one.
 *
 * COORDINATES: artboard pixels, origin top-left. One convention for the whole
 * surface — see the tool schemas.
 */

import { useProjectStore } from '../stores/project-store';
import { useUIStore } from '../stores/ui-store';
import { registerImageMutation, registerImageRpc } from './rpc';
import { getPopularFonts, loadGoogleFont } from '../services/fonts-service';
import { libraryImageToAsset, getVoidspaceIdToken } from '../services/voidspace-storage';
import type { Layer, Project, Artboard, MediaAsset, TextLayer, ShapeLayer } from '../types/project';

// ── helpers ─────────────────────────────────────────────────────────────────

function activeArtboard(project: Project): Artboard | null {
  const id = useProjectStore.getState().selectedArtboardId;
  return project.artboards.find((a) => a.id === id) ?? project.artboards[0] ?? null;
}

function resolvePage(project: Project, pageId?: string): Artboard | null {
  if (pageId) return project.artboards.find((a) => a.id === pageId) ?? null;
  return activeArtboard(project);
}

function fail(reason: string, message: string) {
  return { ok: false as const, reason, message };
}

/**
 * Turn the agent's placement into a concrete box.
 *
 * Named anchors exist because "centre it" is what people actually ask for, and
 * making the model compute `(pageWidth - width) / 2` every time is both wasteful
 * and a reliable source of off-by-a-few placement.
 */
function resolveBox(
  page: Artboard,
  opts: {
    x?: number; y?: number; width?: number; height?: number;
    align?: string; margin?: number;
  },
  fallback: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const W = page.size.width;
  const H = page.size.height;
  const width = Math.max(1, Math.round(opts.width ?? fallback.width));
  const height = Math.max(1, Math.round(opts.height ?? fallback.height));
  const m = opts.margin ?? Math.round(Math.min(W, H) * 0.07); // ~7% safe margin

  let x = opts.x;
  let y = opts.y;

  if (opts.align) {
    const a = String(opts.align);
    if (a.includes('left')) x = m;
    else if (a.includes('right')) x = W - width - m;
    else x = Math.round((W - width) / 2);

    if (a.includes('top')) y = m;
    else if (a.includes('bottom')) y = H - height - m;
    else y = Math.round((H - height) / 2);
  }

  return {
    x: Math.round(x ?? Math.round((W - width) / 2)),
    y: Math.round(y ?? Math.round((H - height) / 2)),
    width,
    height,
  };
}

/** Drop undefined keys so a patch never clobbers a field the caller omitted. */
function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/** Families this editor can actually fetch. Anything else falls back silently,
 *  which is why the tools warn rather than pretend. */
function knownFontFamilies(): Set<string> {
  return new Set(getPopularFonts().map((f) => f.family));
}

/** Kick off the webfont fetch and report whether the family is even loadable.
 *  The canvas repaints itself when the font lands (Canvas listens for
 *  `document.fonts` loadingdone), so this never has to block the mutation. */
function requestFont(family: unknown): string | null {
  const name = typeof family === 'string' ? family.trim() : '';
  if (!name) return null;
  void loadGoogleFont(name).catch(() => {});
  if (!knownFontFamilies().has(name)) {
    return `"${name}" is not in this editor's font list, so it will fall back to a default typeface. Call img_list_fonts and pick from there.`;
  }
  return null;
}

// ── Fonts (read) ────────────────────────────────────────────────────────────

registerImageRpc('voidspace:img-list-fonts', () => {
  // The SAME list the font picker shows, grouped by the category each font
  // declares — so what the agent can offer and what the user sees never differ.
  const byCategory: Record<string, string[]> = {};
  for (const f of getPopularFonts()) {
    (byCategory[f.category] ??= []).push(f.family);
  }
  return {
    ok: true,
    categories: Object.entries(byCategory).map(([category, fonts]) => ({ category, fonts })),
    note: 'Pass any of these as fontFamily. They are Google Fonts, fetched on demand; a family outside this list may not render.',
  };
});

// ── Text ────────────────────────────────────────────────────────────────────

registerImageMutation('voidspace:img-add-text', 'Add text', (msg: any) => {
  const store = useProjectStore.getState();
  const project = store.project!;
  const page = resolvePage(project, msg?.pageId);
  if (!page) throw new Error(`No page with id ${msg?.pageId}`);
  if (page.id !== store.selectedArtboardId) store.selectArtboard(page.id);

  const content = String(msg?.text ?? '').trim();
  if (!content) throw new Error('text is required');

  const fontSize = Number(msg?.fontSize) || Math.round(page.size.width * 0.08);
  // Height from the real line count so a multi-line block is not clipped.
  const lines = content.split('\n').length;
  const lineHeight = Number(msg?.lineHeight) || 1.2;
  const box = resolveBox(page, msg ?? {}, {
    width: Math.round(page.size.width * 0.86),
    height: Math.ceil(fontSize * lineHeight * lines),
  });

  const id = useProjectStore.getState().addTextLayer(content, {
    x: box.x, y: box.y, width: box.width, height: box.height,
    ...(msg?.rotation !== undefined ? { rotation: Number(msg.rotation) } : {}),
    ...(msg?.opacity !== undefined ? { opacity: Number(msg.opacity) } : {}),
  });

  // Style in the SAME transaction, so "add a headline" is one undo step rather
  // than an unstyled layer followed by a separate restyle.
  const layer = useProjectStore.getState().project!.layers[id] as TextLayer;
  const style = defined({
    fontFamily: msg?.fontFamily,
    fontSize,
    fontWeight: msg?.fontWeight,
    fontStyle: msg?.fontStyle,
    textAlign: msg?.textAlign,
    verticalAlign: msg?.verticalAlign,
    lineHeight,
    letterSpacing: msg?.letterSpacing,
    color: msg?.color,
    strokeColor: msg?.strokeColor,
    strokeWidth: msg?.strokeWidth,
    backgroundColor: msg?.backgroundColor,
    backgroundPadding: msg?.backgroundPadding,
    backgroundRadius: msg?.backgroundRadius,
    textDecoration: msg?.textDecoration,
  });
  if (Object.keys(style).length) {
    useProjectStore.getState().updateLayer<TextLayer>(id, {
      style: { ...layer.style, ...style } as TextLayer['style'],
    });
  }

  const fontWarning = requestFont(msg?.fontFamily);

  return {
    layerId: id,
    pageId: page.id,
    bounds: box,
    ...(fontWarning ? { warning: fontWarning } : {}),
  };
});

// ── Shapes ──────────────────────────────────────────────────────────────────

registerImageMutation('voidspace:img-add-shape', 'Add shape', (msg: any) => {
  const store = useProjectStore.getState();
  const project = store.project!;
  const page = resolvePage(project, msg?.pageId);
  if (!page) throw new Error(`No page with id ${msg?.pageId}`);
  if (page.id !== store.selectedArtboardId) store.selectArtboard(page.id);

  const shapeType = String(msg?.shapeType ?? 'rectangle') as ShapeLayer['shapeType'];
  const box = resolveBox(page, msg ?? {}, {
    width: Math.round(page.size.width * 0.4),
    height: Math.round(page.size.width * 0.4),
  });

  const id = useProjectStore.getState().addShapeLayer(shapeType, {
    x: box.x, y: box.y, width: box.width, height: box.height,
    ...(msg?.rotation !== undefined ? { rotation: Number(msg.rotation) } : {}),
    ...(msg?.opacity !== undefined ? { opacity: Number(msg.opacity) } : {}),
  });

  const layer = useProjectStore.getState().project!.layers[id] as ShapeLayer;
  const shapeStyle = defined({
    fill: msg?.fill,
    fillOpacity: msg?.fillOpacity,
    stroke: msg?.stroke,
    strokeWidth: msg?.strokeWidth,
    cornerRadius: msg?.cornerRadius,
  });
  if (Object.keys(shapeStyle).length) {
    useProjectStore.getState().updateLayer<ShapeLayer>(id, {
      shapeStyle: { ...layer.shapeStyle, ...shapeStyle } as ShapeLayer['shapeStyle'],
    });
  }

  return { layerId: id, pageId: page.id, bounds: box };
});

// ── Images ──────────────────────────────────────────────────────────────────

/**
 * Fit a source into a box, preserving aspect.
 *  cover   — fill the box, cropping overflow (default for backgrounds)
 *  contain — fit entirely inside, letterboxed
 */
function fitBox(
  src: { width: number; height: number },
  box: { x: number; y: number; width: number; height: number },
  mode: 'cover' | 'contain' | 'stretch',
) {
  if (mode === 'stretch' || !src.width || !src.height) return box;
  const scale = mode === 'cover'
    ? Math.max(box.width / src.width, box.height / src.height)
    : Math.min(box.width / src.width, box.height / src.height);
  const width = Math.round(src.width * scale);
  const height = Math.round(src.height * scale);
  return {
    x: Math.round(box.x + (box.width - width) / 2),
    y: Math.round(box.y + (box.height - height) / 2),
    width,
    height,
  };
}

registerImageRpc('voidspace:img-place-image', async (msg: any) => {
  const store = useProjectStore.getState();
  const project = store.project;
  if (!project) return fail('no_project', 'No image project is open.');

  const page = resolvePage(project, msg?.pageId);
  if (!page) return fail('page_not_found', `No page with id ${msg?.pageId}`);

  // The FETCH happens outside the transaction — a transaction must stay
  // synchronous so its commands commit as one atomic step, and network time has
  // no business inside an undo entry.
  let asset: MediaAsset | null = null;
  const assetId = typeof msg?.assetId === 'string' ? msg.assetId : '';
  if (assetId) {
    asset = project.assets[assetId] ?? null;
    if (!asset) return fail('asset_not_found', `No asset with id ${assetId}`);
  } else if (typeof msg?.url === 'string' && msg.url) {
    try {
      const token = await getVoidspaceIdToken();
      asset = await libraryImageToAsset({ url: msg.url, name: msg?.name } as any, token);
    } catch (e: any) {
      return fail('fetch_failed', `Could not load that image: ${e?.message ?? e}`);
    }
    if (!asset) return fail('fetch_failed', 'Could not load that image.');
  } else {
    return fail('bad_request', 'Pass assetId (already in the project) or url.');
  }

  const box = resolveBox(page, msg ?? {}, { width: page.size.width, height: page.size.height });
  const fit = (msg?.fit === 'contain' || msg?.fit === 'stretch') ? msg.fit : 'cover';
  const placed = fitBox({ width: asset.width, height: asset.height }, box, fit);

  const existing = !!project.assets[asset.id];
  const layerId = useProjectStore.getState().runTransaction('Place image', () => {
    if (page.id !== useProjectStore.getState().selectedArtboardId) {
      useProjectStore.getState().selectArtboard(page.id);
    }
    // Registering the asset is itself undoable, so undo removes BOTH and leaves
    // no orphan in the Assets panel.
    if (!existing) useProjectStore.getState().addAsset(asset!);
    return useProjectStore.getState().addImageLayer(asset!.id, placed);
  });

  return {
    ok: true,
    layerId,
    assetId: asset.id,
    pageId: page.id,
    bounds: placed,
    rev: useProjectStore.getState().project?.updatedAt,
  };
});

// ── Generic layer edit ──────────────────────────────────────────────────────

registerImageMutation('voidspace:img-edit-layer', 'Edit layer', (msg: any) => {
  const store = useProjectStore.getState();
  const project = store.project!;
  const ids: string[] = Array.isArray(msg?.layerIds)
    ? msg.layerIds
    : (msg?.layerId ? [msg.layerId] : []);
  if (!ids.length) throw new Error('layerId or layerIds is required');

  const missing = ids.filter((id) => !project.layers[id]);
  if (missing.length) throw new Error(`unknown layerIds: ${missing.join(', ')}`);

  const touched: string[] = [];
  const warnings: string[] = [];
  for (const id of ids) {
    // Read FRESH each iteration. `project` was captured before the loop, and a
    // previous iteration may already have changed this layer — merging a style
    // onto a stale copy would silently drop the earlier change.
    const layer = useProjectStore.getState().project!.layers[id] as Layer;

    const transform = defined({
      x: msg?.x, y: msg?.y, width: msg?.width, height: msg?.height,
      rotation: msg?.rotation, opacity: msg?.opacity,
    });
    if (Object.keys(transform).length) {
      useProjectStore.getState().updateLayerTransform(id, transform as any);
    }

    const base = defined({
      name: msg?.name,
      visible: msg?.visible,
      locked: msg?.locked,
    });
    if (msg?.blendMode !== undefined) {
      (base as any).blendMode = { ...(layer.blendMode as any), mode: msg.blendMode };
    }
    if (Object.keys(base).length) useProjectStore.getState().updateLayer(id, base as any);

    if (layer.type === 'text') {
      const tl = useProjectStore.getState().project!.layers[id] as TextLayer;
      const patch: Partial<TextLayer> = {};
      if (typeof msg?.text === 'string') (patch as any).content = msg.text;
      const style = defined({
        fontFamily: msg?.fontFamily, fontSize: msg?.fontSize, fontWeight: msg?.fontWeight,
        fontStyle: msg?.fontStyle, textAlign: msg?.textAlign, verticalAlign: msg?.verticalAlign,
        lineHeight: msg?.lineHeight, letterSpacing: msg?.letterSpacing, color: msg?.color,
        strokeColor: msg?.strokeColor, strokeWidth: msg?.strokeWidth,
        backgroundColor: msg?.backgroundColor, backgroundPadding: msg?.backgroundPadding,
        backgroundRadius: msg?.backgroundRadius, textDecoration: msg?.textDecoration,
      });
      if (Object.keys(style).length) patch.style = { ...tl.style, ...style } as TextLayer['style'];
      if (Object.keys(patch).length) useProjectStore.getState().updateLayer<TextLayer>(id, patch);
      const w = requestFont(msg?.fontFamily);
      if (w) warnings.push(w);
    }

    if (layer.type === 'shape') {
      const sl = useProjectStore.getState().project!.layers[id] as ShapeLayer;
      const shapeStyle = defined({
        fill: msg?.fill, fillOpacity: msg?.fillOpacity, stroke: msg?.stroke,
        strokeWidth: msg?.strokeWidth, cornerRadius: msg?.cornerRadius,
      });
      if (Object.keys(shapeStyle).length) {
        useProjectStore.getState().updateLayer<ShapeLayer>(id, {
          shapeStyle: { ...sl.shapeStyle, ...shapeStyle } as ShapeLayer['shapeStyle'],
        });
      }
    }

    touched.push(id);
  }
  return { layerIds: touched, ...(warnings.length ? { warning: warnings[0] } : {}) };
});

// ── Arrange ─────────────────────────────────────────────────────────────────

registerImageMutation('voidspace:img-arrange', 'Arrange layers', (msg: any) => {
  const store = useProjectStore.getState();
  const project = store.project!;
  const action = String(msg?.action ?? '');
  const ids: string[] = Array.isArray(msg?.layerIds) ? msg.layerIds : (msg?.layerId ? [msg.layerId] : []);
  const page = activeArtboard(project);
  if (!page) throw new Error('no active page');

  const requireIds = () => {
    if (!ids.length) throw new Error(`${action} needs layerId or layerIds`);
    const missing = ids.filter((id) => !project.layers[id]);
    if (missing.length) throw new Error(`unknown layerIds: ${missing.join(', ')}`);
  };

  switch (action) {
    case 'delete':
      requireIds();
      useProjectStore.getState().removeLayers(ids);
      return { removed: ids };

    case 'duplicate': {
      requireIds();
      const copies = useProjectStore.getState().duplicateLayers(ids);
      return { layerIds: copies };
    }

    case 'group': {
      requireIds();
      if (ids.length < 2) throw new Error('group needs at least two layers');
      const groupId = useProjectStore.getState().groupLayers(ids);
      return { groupId };
    }

    case 'ungroup':
      requireIds();
      for (const id of ids) useProjectStore.getState().ungroupLayers(id);
      return { ungrouped: ids };

    case 'bring_to_front':
      requireIds();
      for (const id of ids) useProjectStore.getState().moveLayerToTop(id);
      return { layerIds: ids };

    case 'send_to_back':
      requireIds();
      for (const id of ids) useProjectStore.getState().moveLayerToBottom(id);
      return { layerIds: ids };

    case 'bring_forward':
      requireIds();
      for (const id of ids) useProjectStore.getState().moveLayerUp(id);
      return { layerIds: ids };

    case 'send_backward':
      requireIds();
      for (const id of ids) useProjectStore.getState().moveLayerDown(id);
      return { layerIds: ids };

    case 'align': {
      requireIds();
      // Aligned against the PAGE — the common intent ("centre the headline").
      const how = String(msg?.align ?? 'center');
      const W = page.size.width;
      const H = page.size.height;
      for (const id of ids) {
        const t = useProjectStore.getState().project!.layers[id].transform;
        const patch: Record<string, number> = {};
        if (how.includes('left')) patch.x = 0;
        else if (how.includes('right')) patch.x = W - t.width;
        else if (how.includes('center') || how.includes('centre')) patch.x = Math.round((W - t.width) / 2);
        if (how.includes('top')) patch.y = 0;
        else if (how.includes('bottom')) patch.y = H - t.height;
        else if (how.includes('middle')) patch.y = Math.round((H - t.height) / 2);
        if (Object.keys(patch).length) {
          useProjectStore.getState().updateLayerTransform(id, patch as any);
        }
      }
      return { layerIds: ids, align: how };
    }

    default:
      throw new Error(`unknown arrange action: ${action}`);
  }
});

// ── Pages (artboards) ───────────────────────────────────────────────────────

registerImageMutation('voidspace:img-page', 'Edit pages', (msg: any) => {
  const store = useProjectStore.getState();
  const project = store.project!;
  const action = String(msg?.action ?? '');

  switch (action) {
    case 'add': {
      const first = project.artboards[0];
      const size = {
        width: Math.max(1, Math.round(Number(msg?.width) || first?.size.width || 1080)),
        height: Math.max(1, Math.round(Number(msg?.height) || first?.size.height || 1080)),
      };
      const name = String(msg?.name || `Page ${project.artboards.length + 1}`);
      const id = useProjectStore.getState().addArtboard(name, size);
      if (msg?.select !== false) useProjectStore.getState().selectArtboard(id);
      return { pageId: id, name, size };
    }

    case 'remove': {
      const id = String(msg?.pageId ?? '');
      if (!project.artboards.some((a) => a.id === id)) throw new Error(`no page with id ${id}`);
      if (project.artboards.length <= 1) throw new Error('cannot remove the only page');
      useProjectStore.getState().removeArtboard(id);
      return { removed: id };
    }

    case 'select': {
      const id = String(msg?.pageId ?? '');
      if (!project.artboards.some((a) => a.id === id)) throw new Error(`no page with id ${id}`);
      useProjectStore.getState().selectArtboard(id);
      return { pageId: id };
    }

    case 'resize': {
      const id = String(msg?.pageId || store.selectedArtboardId || '');
      const ab = project.artboards.find((a) => a.id === id);
      if (!ab) throw new Error(`no page with id ${id}`);
      const size = {
        width: Math.max(1, Math.round(Number(msg?.width) || ab.size.width)),
        height: Math.max(1, Math.round(Number(msg?.height) || ab.size.height)),
      };
      useProjectStore.getState().updateArtboard(id, { size } as any);
      return { pageId: id, size };
    }

    case 'rename': {
      const id = String(msg?.pageId || store.selectedArtboardId || '');
      if (!project.artboards.some((a) => a.id === id)) throw new Error(`no page with id ${id}`);
      useProjectStore.getState().updateArtboard(id, { name: String(msg?.name ?? '') } as any);
      return { pageId: id, name: msg?.name };
    }

    case 'set_background': {
      const id = String(msg?.pageId || store.selectedArtboardId || '');
      if (!project.artboards.some((a) => a.id === id)) throw new Error(`no page with id ${id}`);
      useProjectStore.getState().updateArtboard(id, {
        background: { type: 'color', color: String(msg?.color ?? '#ffffff') },
      } as any);
      return { pageId: id, color: msg?.color };
    }

    default:
      throw new Error(`unknown page action: ${action}`);
  }
});

// ── New project ─────────────────────────────────────────────────────────────

registerImageRpc('voidspace:img-new-project', (msg: any) => {
  const width = Math.max(1, Math.round(Number(msg?.width) || 1080));
  const height = Math.max(1, Math.round(Number(msg?.height) || 1080));
  const name = String(msg?.name || 'Untitled');
  useProjectStore.getState().createProject(name, { width, height }, {
    type: 'color',
    color: String(msg?.background ?? '#ffffff'),
  } as any);
  useUIStore.getState().setCurrentView('editor');
  const project = useProjectStore.getState().project!;
  return {
    ok: true,
    projectId: project.id,
    projectName: project.name,
    pageId: project.artboards[0]?.id,
    size: { width, height },
  };
});

export {};
