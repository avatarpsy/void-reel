/**
 * Remove a layer's background — the shared implementation.
 *
 * This logic used to live inline in `BackgroundRemovalSection.tsx`, which meant
 * the agent had no way to reach it without writing a second copy. A second copy
 * is how the button and the assistant end up producing subtly different results
 * from the same request, so it moved here and the section calls it too.
 *
 * Runs ON DEVICE (@imgly, WASM). No credits, no network, no upload — the pixels
 * never leave the browser.
 */

import { useProjectStore } from '../stores/project-store';
import { getBackgroundRemovalService, type BackgroundMode } from './background-removal-service';
import type { ImageLayer } from '../types/project';

export interface RemoveBackgroundOptions {
  mode?: BackgroundMode;
  backgroundColor?: string;
  blurAmount?: number;
  onProgress?: (pct: number) => void;
}

export interface RemoveBackgroundResult {
  ok: boolean;
  reason?: string;
  message?: string;
  layerId?: string;
  assetId?: string;
}

/**
 * Replace `layerId`'s image with a background-removed copy.
 *
 * The new pixels land as a NEW asset and the layer is repointed at it, so the
 * original bytes survive in the project and undo is a plain layer patch rather
 * than an attempt to reverse a destructive pixel edit.
 *
 * Registration + repoint happen in ONE transaction: undo must not leave the
 * cut-out asset orphaned in the Assets panel.
 */
export async function removeLayerBackground(
  layerId: string,
  opts: RemoveBackgroundOptions = {},
): Promise<RemoveBackgroundResult> {
  const project = useProjectStore.getState().project;
  if (!project) return { ok: false, reason: 'no_project', message: 'No image project is open.' };

  const layer = project.layers[layerId] as ImageLayer | undefined;
  if (!layer) return { ok: false, reason: 'layer_not_found', message: `No layer with id ${layerId}` };
  if (layer.type !== 'image') {
    return {
      ok: false,
      reason: 'wrong_layer_type',
      message: `Background removal needs an IMAGE layer; "${layer.name}" is a ${layer.type} layer.`,
    };
  }

  const asset = project.assets[layer.sourceId];
  const source = asset?.dataUrl || asset?.thumbnailUrl;
  if (!source) {
    return { ok: false, reason: 'no_pixels', message: 'That layer has no image data to process.' };
  }

  let resultDataUrl: string;
  try {
    // The heavy part, deliberately OUTSIDE the transaction: a transaction must
    // stay synchronous to commit as one atomic step, and model inference has no
    // business inside an undo entry.
    resultDataUrl = await getBackgroundRemovalService().removeBackground(
      source,
      {
        mode: opts.mode ?? 'transparent',
        backgroundColor: opts.backgroundColor,
        blurAmount: opts.blurAmount,
      },
      opts.onProgress,
    );
  } catch (e: any) {
    return {
      ok: false,
      reason: 'processing_failed',
      message: e?.message ? `Background removal failed: ${e.message}` : 'Background removal failed.',
    };
  }

  const newAssetId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  useProjectStore.getState().runTransaction(`Remove background — ${layer.name}`, () => {
    useProjectStore.getState().addAsset({
      id: newAssetId,
      name: `${asset.name} (no bg)`,
      type: 'image',
      mimeType: 'image/png',
      size: resultDataUrl.length,
      width: asset.width,
      height: asset.height,
      thumbnailUrl: resultDataUrl,
      dataUrl: resultDataUrl,
    });
    useProjectStore.getState().updateLayer<ImageLayer>(layerId, { sourceId: newAssetId });
  });

  return { ok: true, layerId, assetId: newAssetId };
}
