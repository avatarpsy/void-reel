/**
 * Finishing operations: retouch, adjust, save, publish.
 *
 * Scope is deliberate. Masks and inpainting are NOT here — they are precision
 * retouching tools, and none of them is on the path to a good carousel, poster
 * or image post. What IS here is what that path actually needs: cut a subject
 * out, grade the image, save it back where it came from, and get it published.
 *
 * Cost: background removal and adjustments are LOCAL and free. Only the render
 * for publishing touches the network (an upload, not a model).
 */

import { useProjectStore } from '../stores/project-store';
import { useUIStore } from '../stores/ui-store';
import { registerImageRpc, registerImageMutation } from './rpc';
import { removeLayerBackground } from '../services/background-removal-apply';
import { exportArtboard } from '../services/export-service';
import { settleCompositions as settleAllCompositions } from '../services/composition/bake';
import { uploadReferenceImage } from '../services/generative-fill';
import {
  saveImageToVoidspaceLibrary,
  overwriteEditSource,
  NotSignedInError,
} from '../services/voidspace-storage';
import type { Artboard, Layer, Project } from '../types/project';
import { saveProjectLocally } from '../hooks/useAutoSave';
import { saveProjectDocument } from '../services/project-cloud-sync';
import { settledPage } from '../services/composition/settled-page';

function fail(reason: string, message: string) {
  return { ok: false as const, reason, message };
}

function resolvePage(project: Project, pageId?: string): Artboard | null {
  if (pageId) return project.artboards.find((a) => a.id === pageId) ?? null;
  const id = useProjectStore.getState().selectedArtboardId;
  return project.artboards.find((a) => a.id === id) ?? project.artboards[0] ?? null;
}

// ── Background removal (local, free) ────────────────────────────────────────

registerImageRpc('voidspace:img-remove-background', async (msg: any) => {
  const project = useProjectStore.getState().project;
  if (!project) return fail('no_project', 'No image project is open.');

  // Default to the selected image layer — "remove the background" almost always
  // means the one thing on screen, and making the agent hunt for an id first is
  // a wasted round trip.
  let layerId: string = String(msg?.layerId ?? '');
  if (!layerId) {
    const selected = useProjectStore.getState().selectedLayerIds
      .filter((id) => project.layers[id]?.type === 'image');
    if (selected.length === 1) layerId = selected[0];
  }
  if (!layerId) {
    const page = resolvePage(project);
    const images = (page?.layerIds ?? []).filter((id) => project.layers[id]?.type === 'image');
    if (images.length === 1) layerId = images[0];
  }
  if (!layerId) {
    return fail(
      'layer_required',
      'Which image? Read the canvas and pass the layerId of the image to cut out.',
    );
  }

  const r = await removeLayerBackground(layerId, {
    mode: msg?.mode,
    backgroundColor: msg?.backgroundColor,
    blurAmount: msg?.blurAmount,
  });
  if (!r.ok) return fail(r.reason ?? 'failed', r.message ?? 'Background removal failed.');
  return { ok: true, layerId: r.layerId, assetId: r.assetId };
});

// ── Image adjustments / effects (local, free, undoable) ─────────────────────

/**
 * Named adjustment fields on a layer. These already exist on every layer and are
 * rendered by the canvas and baked into exports — the agent just sets them.
 */
const ADJUSTMENT_KEYS = [
  'brightness', 'contrast', 'saturation', 'exposure',
  'temperature', 'tint', 'hue', 'vibrance', 'sharpness',
] as const;

registerImageMutation('voidspace:img-adjust', 'Adjust image', (msg: any) => {
  const project = useProjectStore.getState().project!;
  const ids: string[] = Array.isArray(msg?.layerIds)
    ? msg.layerIds
    : (msg?.layerId ? [msg.layerId] : useProjectStore.getState().selectedLayerIds);
  if (!ids.length) throw new Error('layerId, layerIds, or a selected layer is required');

  const missing = ids.filter((id) => !project.layers[id]);
  if (missing.length) throw new Error(`unknown layerIds: ${missing.join(', ')}`);

  const touched: string[] = [];
  for (const id of ids) {
    const layer = useProjectStore.getState().project!.layers[id] as Layer;

    // Adjustments live in `filters` on the layer; merge so an unspecified knob
    // keeps whatever it already had.
    const filters: Record<string, unknown> = { ...(layer.filters as any) };
    let changed = false;
    for (const k of ADJUSTMENT_KEYS) {
      if (msg?.[k] !== undefined) { filters[k] = Number(msg[k]); changed = true; }
    }
    if (msg?.blur !== undefined) { filters.blur = Number(msg.blur); changed = true; }
    if (msg?.grayscale !== undefined) { filters.grayscale = Number(msg.grayscale); changed = true; }
    if (msg?.sepia !== undefined) { filters.sepia = Number(msg.sepia); changed = true; }
    if (msg?.invert !== undefined) { filters.invert = Number(msg.invert); changed = true; }

    if (changed) {
      useProjectStore.getState().updateLayer(id, { filters } as any);
      touched.push(id);
    }

    // Drop shadow is its own structure, not a filter.
    if (msg?.shadow && typeof msg.shadow === 'object') {
      const cur = (layer as any).shadow ?? {};
      useProjectStore.getState().updateLayer(id, {
        shadow: { ...cur, enabled: true, ...msg.shadow },
      } as any);
      if (!touched.includes(id)) touched.push(id);
    }
  }

  if (!touched.length) throw new Error('no adjustment values were supplied');
  return { layerIds: touched };
});

// ── Render pages (for publishing / export) ──────────────────────────────────

/**
 * Render every page and upload it, returning public URLs.
 *
 * This is the ONLY thing the publish flow needs from the editor: the pictures.
 * Everything after it — the caption, the platforms, the approval queue — is the
 * SAME `publish` tool the video agent uses, so there is no second publishing
 * implementation to keep in step.
 */
/**
 * EVERY PICTURE MUST EXIST BEFORE ANYTHING READS IT.
 *
 * A placed composition carries no asset until `bakeComposition` renders it on
 * the user's own machine, which takes tens of seconds. `bakePendingCompositions`
 * existed for exactly this and was called in ONE place — project load — so a
 * reopened deck rendered correctly and a freshly built one did not.
 *
 * Measured through MCP: place three slides, export immediately, and the export
 * came back `dropped: ["deck-close"]` at 502KB. The same export moments later
 * was complete at 777KB. The sequence an agent naturally performs — place,
 * place, place, export — produced a deck missing its last slide, and the only
 * signal was a `dropped` list nothing told the caller to act on.
 *
 * So the readers settle first. It is cheap when there is nothing to do: bakes
 * are hash-keyed and de-duplicated, so an already-baked deck pays one map
 * lookup per layer.
 */
async function settleCompositions(): Promise<void> {
  try {
    await settleAllCompositions();
  } catch {
    // A bake that cannot run is reported by the export itself, through the
    // layers it had to drop. Failing the whole call here would turn one missing
    // picture into no file at all.
  }
}

registerImageRpc('voidspace:img-render-pages', async (msg: any) => {
  const project = useProjectStore.getState().project;
  if (!project) return fail('no_project', 'No image project is open.');

  const pages = Array.isArray(msg?.pageIds) && msg.pageIds.length
    ? project.artboards.filter((a) => msg.pageIds.includes(a.id))
    : project.artboards;
  if (!pages.length) return fail('no_pages', 'No pages to render.');

  // Pixels first — see settleCompositions.
  await settleCompositions();

  /**
   * And then RE-READ. The store is immutable: settling produced a new project
   * object, and `project` above is a snapshot from before the pictures existed.
   * Rendering from the stale one produces blank slides for anything that was
   * still being drawn — the same fault that made the PPTX export drop a slide.
   */
  const settled = useProjectStore.getState().project ?? project;
  const settledPages = settled.artboards.filter((a) => pages.some((p) => p.id === a.id));

  try {
    const urls: string[] = [];
    for (let i = 0; i < settledPages.length; i++) {
      const ready = await settledPage(settled.id, settledPages[i].id);
      const blob = await exportArtboard(ready.project, ready.page, {
        format: 'jpg', quality: 'high', scale: 1, background: 'include',
      });
      const file = new File([blob], `slide-${i + 1}.jpg`, { type: 'image/jpeg' });
      urls.push(await uploadReferenceImage(file));
    }
    const first = settledPages[0] ?? pages[0];
    return {
      ok: true,
      urls,
      pageCount: settledPages.length,
      width: first.size.width,
      height: first.size.height,
      isCarousel: settledPages.length > 1,
      note: 'Pass these to publish as image_urls (comma-separated) with content_type "carousel" for several, "image" for one.',
    };
  } catch (e) {
    if (e instanceof NotSignedInError) {
      return fail('not_signed_in', 'Sign in to Voidspace to publish or export.');
    }
    return fail('render_failed', `Could not render the pages: ${(e as any)?.message ?? e}`);
  }
});

// ── Save to the Voidspace library / overwrite the original ──────────────────

registerImageRpc('voidspace:img-save', async (msg: any) => {
  const project = useProjectStore.getState().project;
  if (!project) return fail('no_project', 'No image project is open.');

  if (msg?.mode === 'project') {
    try {
      if (typeof msg.name === 'string' && msg.name.trim()) useProjectStore.getState().setProjectName(msg.name.trim());
      await settleAllCompositions();
      const current = useProjectStore.getState().project!;
      await saveProjectLocally(current);
      const cloudSaved = await saveProjectDocument(current);
      return { ok: true, mode: 'project', projectId: current.id, name: current.name,
        pageCount: current.artboards.length, editable: true, localSaved: true, cloudSaved,
        ...(cloudSaved ? {} : { warning: 'Saved on this device. Cloud backup is unavailable; keep this browser data until backup succeeds.' }) };
    } catch (error) {
      return fail('save_failed', `Could not save the editable project: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const page = resolvePage(project, msg?.pageId);
  if (!page) return fail('page_not_found', `No page with id ${msg?.pageId}`);

  const editSource = useUIStore.getState().editSource;
  const wantsOverwrite = msg?.mode === 'overwrite';
  if (wantsOverwrite && !editSource) {
    return fail(
      'no_source',
      'This project was not opened from an existing file, so there is nothing to overwrite. Save a copy instead.',
    );
  }

  try {
    // PNG for an overwrite (lossless, keeps alpha); the export dialog's own
    // save path makes the same choice.
    const ready = await settledPage(project.id, page.id);
    const blob = await exportArtboard(ready.project, ready.page, {
      format: 'png', quality: 'high', scale: 1,
      background: msg?.transparent ? 'transparent' : 'include',
    });

    if (wantsOverwrite && editSource) {
      // overwriteEditSource already posts the `voidspace-image-edit` broadcast
      // that makes the studio tab re-fetch — the URL does not change, so without
      // that nudge the video editor keeps showing its cached previous version
      // and the edit looks like it did nothing.
      const res = await overwriteEditSource(blob, editSource);
      return { ok: true, mode: 'overwrite', url: res?.url ?? null };
    }

    const name = String(msg?.name || project.name || 'image');
    const saved = await saveImageToVoidspaceLibrary(blob, name, 'png', { overwrite: false });
    return { ok: true, mode: 'copy', url: saved?.url ?? null, name };
  } catch (e) {
    if (e instanceof NotSignedInError) {
      return fail('not_signed_in', 'Sign in to Voidspace to save.');
    }
    return fail('save_failed', `Could not save: ${(e as any)?.message ?? e}`);
  }
});

export {};
