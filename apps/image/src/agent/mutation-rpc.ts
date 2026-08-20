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
import { registerImageMutation, registerImageRpc, registerImageAsyncMutation } from './rpc';
import { getPopularFonts, loadGoogleFont } from '../services/fonts-service';
import { libraryImageToAsset, getVoidspaceIdToken } from '../services/voidspace-storage';
import { createTextDocument, layoutText } from '../tools/text/text-engine';
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

/**
 * TEXT BOXES ARE SIZED BY MEASURING, NOT BY COUNTING NEWLINES.
 *
 * Both text paths used to derive the box height from `content.split('\n').length`
 * — the number of newlines the agent TYPED. That is not the number of lines that
 * render. A 150px headline in an 86%-wide box wraps, and every wrapped line past
 * the estimate fell outside the box and was clipped away.
 *
 * The deck that prompted this shipped a slide reading "A DIGITAL YOU" whose layer
 * actually said "A DIGITAL YOU\nTHAT NEVER CLOCKS OFF", and one reading "THE
 * PRESENCE THAT NEVER". Half the sentence was simply gone. That looks like an
 * agent that cannot write a headline; it was a box that could not measure one.
 *
 * Measured with the SAME engine that draws it, so the two cannot disagree.
 */
let sharedMeasureCtx: CanvasRenderingContext2D | null | undefined;
function measuringContext(): CanvasRenderingContext2D | null {
  if (sharedMeasureCtx !== undefined) return sharedMeasureCtx;
  try {
    sharedMeasureCtx = document.createElement('canvas').getContext('2d');
  } catch {
    sharedMeasureCtx = null;
  }
  return sharedMeasureCtx;
}


/**
 * Fit text to its box: choose the WIDTH (a layout decision), then hard-wrap the
 * words to it and give the box the height those lines need.
 *
 * WHY WE WRAP THE CONTENT RATHER THAN LEAVING IT TO THE RENDERER: the canvas
 * renderer and the exporter both draw text with `content.split('\n')` — they honour
 * typed line breaks and nothing else. There is a full wrapping engine in
 * tools/text, but it is not what paints a layer. So a headline longer than its
 * box does not wrap; it runs straight past the artboard edge and is cut there,
 * which is how a slide came to read "HAT NEVER CLOCKS OF".
 *
 * Baking the breaks into the text is what makes canvas, PDF and PPTX agree,
 * because all three read the same newlines. It also means a later width change
 * keeps these breaks — the tradeoff we want, since the alternative is losing
 * words silently.
 *
 * A single word too long for the box cannot be wrapped, only shrunk, so the
 * font steps down until the longest line fits.
 */
function fitTextToBox(
  page: Artboard,
  opts: { x?: number; y?: number; width?: number; height?: number; align?: string; margin?: number },
  content: string,
  style: { fontSize: number; lineHeight: number; [k: string]: unknown },
): { x: number; y: number; width: number; height: number; text: string; fontSize: number; note: string | null } {
  const width = Math.max(1, Math.round(Number(opts.width) || Math.round(page.size.width * 0.86)));
  const ctx = measuringContext();
  let fontSize = style.fontSize;
  let text = content;
  let note: string | null = null;

  if (ctx) {
    // Up to three passes: wrap, and if a word still overhangs, shrink and re-wrap.
    for (let pass = 0; pass < 3; pass++) {
      const measured = measureWrap(ctx, content, { ...style, fontSize }, width);
      if (!measured) break;
      text = measured.lines.join('\n');
      if (measured.widest <= width || fontSize <= 8) break;
      // Overhang is a single unbreakable word. Step down to what fits, with a
      // little margin so rounding does not leave one pixel over.
      const next = Math.max(8, Math.floor(fontSize * (width / measured.widest) * 0.98));
      if (next >= fontSize) break;
      note = `a word was too wide for ${width}px, so the type stepped down from ${style.fontSize}px to ${next}px`;
      fontSize = next;
    }
  }

  const lines = text.split('\n').length;
  const needed = Math.ceil(fontSize * style.lineHeight * lines);
  const height = Math.max(Math.round(Number(opts.height) || 0), needed);
  const box = resolveBox(page, { ...opts, width, height }, { width, height });
  return { ...box, text, fontSize, note };
}

/** Wrapped lines and the widest of them, using the engine that knows fonts. */
function measureWrap(
  ctx: CanvasRenderingContext2D,
  content: string,
  style: Record<string, unknown>,
  width: number,
): { lines: string[]; widest: number } | null {
  try {
    // defined() matters: createTextDocument SPREADS this over the engine defaults,
    // so an explicit `letterSpacing: undefined` replaces the default 0 and every
    // width becomes NaN — which fails silently as "cannot measure".
    const doc = createTextDocument(content, defined(style) as any, { width, height: 0 });
    const m = layoutText(ctx, doc);
    if (!m.lines.length) return null;
    return {
      lines: m.lines.map((l) => l.text),
      widest: Math.ceil(Math.max(...m.lines.map((l) => l.width))),
    };
  } catch {
    return null;
  }
}

/** Text layers whose boxes intersect, described so the caller can move one. */
function overlappingText(layerIds: string[]): string[] {
  const project = useProjectStore.getState().project;
  if (!project) return [];
  const boxes = layerIds
    .map((id) => project.layers[id])
    .filter((l): l is TextLayer => !!l && l.type === 'text')
    .map((l) => ({ id: l.id, t: l.transform, label: String(l.content ?? '').split('\n')[0].slice(0, 24) }));

  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].t;
      const b = boxes[j].t;
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (overlapX <= 0 || overlapY <= 0) continue;
      out.push(
        `"${boxes[i].label}" and "${boxes[j].label}" overlap by ${Math.round(overlapY)}px vertically. `
        + 'Text wraps to fit its box, so a headline can be taller than you assumed — '
        + 'move the lower one down or give it a y below the other box.',
      );
    }
  }
  return out.slice(0, 3);
}
/** Fonts must be LOADED before measuring: metrics taken against a fallback face
 *  size the box for the wrong typeface. Bounded, because a slow font CDN must
 *  not hold up a slide — a slightly stale metric beats a hung tool call. */
async function fontsReady(families: Array<unknown>, budgetMs = 4000): Promise<void> {
  const names = [...new Set(families.map((f) => (typeof f === 'string' ? f.trim() : '')).filter(Boolean))];
  if (!names.length) return;
  const loads = names.map((n) => loadGoogleFont(n).catch(() => {}));
  const ready = (globalThis as any).document?.fonts?.ready;
  await Promise.race([
    Promise.all([...loads, ready].filter(Boolean)),
    new Promise((r) => setTimeout(r, budgetMs)),
  ]);
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
  const lineHeight = Number(msg?.lineHeight) || 1.2;
  // Wrapped to the box, not just split on typed newlines — see fitTextToBox.
  const box = fitTextToBox(page, msg ?? {}, content, {
    fontSize,
    lineHeight,
    fontFamily: msg?.fontFamily,
    fontWeight: msg?.fontWeight,
    fontStyle: msg?.fontStyle,
    letterSpacing: msg?.letterSpacing,
    textAlign: msg?.textAlign,
  });

  const id = useProjectStore.getState().addTextLayer(box.text, {
    x: box.x, y: box.y, width: box.width, height: box.height,
    ...(msg?.rotation !== undefined ? { rotation: Number(msg.rotation) } : {}),
    ...(msg?.opacity !== undefined ? { opacity: Number(msg.opacity) } : {}),
  });

  // Style in the SAME transaction, so "add a headline" is one undo step rather
  // than an unstyled layer followed by a separate restyle.
  const layer = useProjectStore.getState().project!.layers[id] as TextLayer;
  const style = defined({
    fontFamily: msg?.fontFamily,
    fontSize: box.fontSize,
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

/**
 * Resolve one image source to an asset, fetching it if it is a url.
 *
 * Shared by `img-place-image` and `img-compose-slide` — the second was written
 * afterwards, and a slide that acquires its picture differently from a single
 * placement is a slide whose picture can be subtly different. Returns a refusal
 * rather than throwing, so a caller composing several images can report exactly
 * which one failed.
 */
async function resolveImageAsset(
  project: Project,
  spec: { assetId?: unknown; url?: unknown; name?: unknown },
): Promise<MediaAsset | ReturnType<typeof fail>> {
  const assetId = typeof spec?.assetId === 'string' ? spec.assetId : '';
  if (assetId) {
    const found = project.assets[assetId] ?? null;
    return found ?? fail('asset_not_found', `No asset with id ${assetId}`);
  }
  if (typeof spec?.url === 'string' && spec.url) {
    let asset: MediaAsset | null = null;
    try {
      const token = await getVoidspaceIdToken();
      asset = await libraryImageToAsset({ url: spec.url, name: spec?.name } as any, token);
    } catch (e: any) {
      return fail('fetch_failed', `Could not load that image: ${e?.message ?? e}`);
    }
    return asset ?? fail('fetch_failed', 'Could not load that image.');
  }
  return fail('bad_request', 'Pass assetId (already in the project) or url.');
}

registerImageAsyncMutation(
  'voidspace:img-place-image',
  'Place image',
  async (msg: any) => {
    const project = useProjectStore.getState().project!;
    const page = resolvePage(project, msg?.pageId);
    if (!page) return fail('page_not_found', `No page with id ${msg?.pageId}`);

    // The FETCH happens outside the transaction — a transaction must stay
    // synchronous so its commands commit as one atomic step, and network time
    // has no business inside an undo entry.
    const asset = await resolveImageAsset(project, msg ?? {});
    if ((asset as any).ok === false) return asset as ReturnType<typeof fail>;

    return { page, asset: asset as MediaAsset };
  },
  (msg: any, { page, asset }) => {
    const box = resolveBox(page, msg ?? {}, { width: page.size.width, height: page.size.height });
    const fit = (msg?.fit === 'contain' || msg?.fit === 'stretch') ? msg.fit : 'cover';
    const placed = fitBox({ width: asset.width, height: asset.height }, box, fit);

    const store = useProjectStore.getState();
    if (page.id !== store.selectedArtboardId) store.selectArtboard(page.id);
    // Registering the asset is itself undoable, so undo removes BOTH and leaves
    // no orphan in the Assets panel.
    if (!store.project!.assets[asset.id]) useProjectStore.getState().addAsset(asset);
    const layerId = useProjectStore.getState().addImageLayer(asset.id, placed);

    return { layerId, assetId: asset.id, pageId: page.id, bounds: placed };
  },
);

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

// ── Compose a whole slide in one call ───────────────────────────────────────

/**
 * ONE SLIDE, ONE CALL, ONE UNDO STEP.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * A slide is a page, a background, a headline, some body copy, usually a picture
 * and often a rule or a scrim. Built one tool call at a time that is six or seven
 * round trips, six or seven undo entries, and — on a ten-slide deck — the better
 * part of a hundred calls. Three separate costs, and the third is the one that
 * actually shows:
 *
 *   • MONEY. Every round trip is a full model call carrying the whole context.
 *     The slide's CONTENT is decided once; paying to re-establish it seven times
 *     is paying for nothing.
 *   • TIME, and worse, VISIBLE time — the user watches the slide assemble itself
 *     one layer at a time, which looks like the tool struggling rather than
 *     working.
 *   • UNDO. Seven entries means "undo that slide" is seven Ctrl+Zs, and the
 *     first six leave a half-built slide on screen. One entry means one press.
 *
 * `board_draw` already established the shape on the board surface for the same
 * reasons — send the whole picture, get one undoable action — and this is
 * deliberately its counterpart rather than a second idea.
 *
 * ── WHY IT DOES NOT REPLACE THE SINGLE-LAYER TOOLS ──────────────────────────
 * Composing is not editing. "Move the headline up a bit" must stay one small,
 * cheap, individually-undoable change; routing that through a whole-slide call
 * would rebuild the slide to nudge one layer. This is for BUILDING a slide;
 * `img_add_text` and `img_edit_layer` remain right for changing one.
 *
 * ── ORDER IS Z-ORDER ────────────────────────────────────────────────────────
 * Elements are added in the order given, so later ones sit on top. That makes
 * the natural way to write a slide — background first, then the scrim, then the
 * type — also the correct way, with no separate arrange step.
 */
/** One member PER kind, not `'text' | 'shape'` on a shared member: a union whose
 *  discriminant is itself a union does not narrow away, so the image branch would
 *  still be seen as possibly-text and `asset` unreachable. */
type PreparedElement =
  | { kind: 'text'; spec: any }
  | { kind: 'shape'; spec: any }
  | { kind: 'image'; spec: any; asset: MediaAsset };

registerImageAsyncMutation(
  'voidspace:img-compose-slide',
  'Compose slide',
  async (msg: any) => {
    const project = useProjectStore.getState().project!;

    const elements = Array.isArray(msg?.elements) ? msg.elements : [];
    if (!elements.length) {
      return fail('bad_request', 'elements is required — send the whole slide in one call.');
    }
    if (elements.length > 24) {
      return fail(
        'too_many',
        `${elements.length} elements on one slide. A slide that needs more than about a dozen `
        + 'is not a slide — split it, or you are building something the audience cannot read.',
      );
    }

    // A page that already exists must be resolvable BEFORE anything is fetched,
    // so a typo'd pageId costs nothing.
    const newPage = msg?.newPage === true;
    let page: Artboard | null = null;
    if (!newPage) {
      page = resolvePage(project, msg?.pageId);
      if (!page) return fail('page_not_found', `No page with id ${msg?.pageId}`);
    }

    /**
     * FETCH EVERY PICTURE FIRST, and refuse the whole slide if one fails.
     *
     * All-or-nothing on purpose. A slide committed with two of its three images
     * looks finished and is not, and the agent — which got an `ok` — has no
     * reason to look. Refusing names the element that failed so it can fix that
     * one and resend, which is both cheaper and more honest than a partial
     * success it has to detect.
     */
    const prepared: PreparedElement[] = [];
    for (let i = 0; i < elements.length; i++) {
      const spec = elements[i] ?? {};
      const kind = String(spec.kind ?? '');
      if (kind === 'text' || kind === 'shape') {
        prepared.push({ kind, spec });
        continue;
      }
      if (kind !== 'image') {
        return fail('bad_request', `element ${i}: unknown kind "${kind}". One of: text, shape, image.`);
      }
      const asset = await resolveImageAsset(project, spec);
      if ((asset as any).ok === false) {
        const r = asset as ReturnType<typeof fail>;
        return fail(r.reason, `element ${i} (image): ${r.message}`);
      }
      prepared.push({ kind: 'image', spec, asset: asset as MediaAsset });
    }

    // Fonts BEFORE the commit measures anything. The commit phase is synchronous,
    // so this is the only place that can await them — and a text box measured
    // against a fallback face is sized for a typeface the slide will not use.
    await fontsReady(prepared.filter((e) => e.kind === 'text').map((e) => (e as any).spec?.fontFamily));

    return { page, newPage, prepared };
  },
  (msg: any, { page, newPage, prepared }) => {
    const store = useProjectStore.getState();
    const project = store.project!;

    // A deck keeps ONE page size. Inheriting the first page's dimensions rather
    // than asking for them is what stops slide 7 being a different shape because
    // the agent forgot to repeat them.
    let target: Artboard;
    if (newPage) {
      const first = project.artboards[0];
      const size = {
        width: Math.max(1, Math.round(Number(msg?.width) || first?.size.width || 1920)),
        height: Math.max(1, Math.round(Number(msg?.height) || first?.size.height || 1080)),
      };
      const name = String(msg?.name || `Page ${project.artboards.length + 1}`);
      const id = useProjectStore.getState().addArtboard(name, size);
      useProjectStore.getState().selectArtboard(id);
      target = useProjectStore.getState().project!.artboards.find((a) => a.id === id)!;
    } else {
      target = page!;
      if (target.id !== store.selectedArtboardId) useProjectStore.getState().selectArtboard(target.id);
    }

    if (typeof msg?.background === 'string' && msg.background) {
      useProjectStore.getState().updateArtboard(target.id, {
        background: { type: 'color', color: msg.background },
      } as any);
    }

    const layerIds: string[] = [];
    const warnings: string[] = [];

    for (const el of prepared) {
      const spec = el.spec ?? {};

      if (el.kind === 'text') {
        const content = String(spec.text ?? '').trim();
        // Skipped rather than fatal: one empty string should not lose a slide's
        // worth of work that is otherwise fine. Reported so it is not silent.
        if (!content) { warnings.push('an empty text element was skipped'); continue; }

        const fontSize = Number(spec.fontSize) || Math.round(target.size.width * 0.08);
        const lineHeight = Number(spec.lineHeight) || 1.2;
        // Fonts for this slide were awaited in prepare, so this measures the
        // typeface that will actually render rather than a fallback.
        const box = fitTextToBox(target, spec, content, {
          fontSize,
          lineHeight,
          fontFamily: spec.fontFamily,
          fontWeight: spec.fontWeight,
          fontStyle: spec.fontStyle,
          letterSpacing: spec.letterSpacing,
          textAlign: spec.textAlign,
        });
        if (box.note) warnings.push(`"${content.slice(0, 28)}": ${box.note}.`);

        const id = useProjectStore.getState().addTextLayer(box.text, {
          x: box.x, y: box.y, width: box.width, height: box.height,
          ...(spec.rotation !== undefined ? { rotation: Number(spec.rotation) } : {}),
          ...(spec.opacity !== undefined ? { opacity: Number(spec.opacity) } : {}),
        });

        const layer = useProjectStore.getState().project!.layers[id] as TextLayer;
        const style = defined({
          fontFamily: spec.fontFamily,
          fontSize: box.fontSize,
          fontWeight: spec.fontWeight,
          fontStyle: spec.fontStyle,
          textAlign: spec.textAlign,
          verticalAlign: spec.verticalAlign,
          lineHeight,
          letterSpacing: spec.letterSpacing,
          color: spec.color,
          strokeColor: spec.strokeColor,
          strokeWidth: spec.strokeWidth,
          backgroundColor: spec.backgroundColor,
          backgroundPadding: spec.backgroundPadding,
          backgroundRadius: spec.backgroundRadius,
          textDecoration: spec.textDecoration,
        });
        if (Object.keys(style).length) {
          useProjectStore.getState().updateLayer<TextLayer>(id, {
            style: { ...layer.style, ...style } as TextLayer['style'],
          });
        }
        const fontWarning = requestFont(spec.fontFamily);
        if (fontWarning) warnings.push(fontWarning);
        layerIds.push(id);
        continue;
      }

      if (el.kind === 'shape') {
        const shapeType = String(spec.shapeType ?? 'rectangle') as ShapeLayer['shapeType'];
        const box = resolveBox(target, spec, {
          width: Math.round(target.size.width * 0.4),
          height: Math.round(target.size.width * 0.4),
        });
        const id = useProjectStore.getState().addShapeLayer(shapeType, {
          x: box.x, y: box.y, width: box.width, height: box.height,
          ...(spec.rotation !== undefined ? { rotation: Number(spec.rotation) } : {}),
          ...(spec.opacity !== undefined ? { opacity: Number(spec.opacity) } : {}),
        });
        const layer = useProjectStore.getState().project!.layers[id] as ShapeLayer;
        const shapeStyle = defined({
          fill: spec.fill,
          fillOpacity: spec.fillOpacity,
          stroke: spec.stroke,
          strokeWidth: spec.strokeWidth,
          cornerRadius: spec.cornerRadius,
        });
        if (Object.keys(shapeStyle).length) {
          useProjectStore.getState().updateLayer<ShapeLayer>(id, {
            shapeStyle: { ...layer.shapeStyle, ...shapeStyle } as ShapeLayer['shapeStyle'],
          });
        }
        layerIds.push(id);
        continue;
      }

      // image — the asset is already in hand (fetched in `prepare`).
      const { asset } = el;
      const box = resolveBox(target, spec, {
        width: target.size.width, height: target.size.height,
      });
      const fit = (spec.fit === 'contain' || spec.fit === 'stretch') ? spec.fit : 'cover';
      const placed = fitBox({ width: asset.width, height: asset.height }, box, fit);
      if (!useProjectStore.getState().project!.assets[asset.id]) {
        useProjectStore.getState().addAsset(asset);
      }
      layerIds.push(useProjectStore.getState().addImageLayer(asset.id, placed));
    }

    // COLLISION CHECK — the one thing the caller cannot predict.
    // Text boxes are positioned before anyone knows how tall the type will be:
    // a headline written as one line may wrap to three, and the subline placed
    // beneath "it" then lands on top of it. The caller chose those coordinates
    // in good faith and has no way to know, so tell it rather than let it ship
    // a slide with two sentences printed over each other.
    for (const warning of overlappingText(layerIds)) warnings.push(warning);

    return {
      pageId: target.id,
      pageName: target.name,
      size: target.size,
      layerIds,
      created: layerIds.length,
      ...(warnings.length ? { warnings } : {}),
    };
  },
);

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
