// apply-generative-fill.ts
// -----------------------------------------------------------------------------
// Orchestrates Photoshop-style Generative Fill end to end:
//   1. render the current composite + a black-on-white mask of the selection
//      at matching dimensions (Kie: black = region to regenerate);
//   2. run the masked edit (runGenerativeFill);
//   3. drop the result on a NEW image layer at full-artboard size, masked to the
//      selection — so the original layers are untouched (non-destructive).
// -----------------------------------------------------------------------------

import { useProjectStore } from '../stores/project-store';
import { useSelectionStore } from '../stores/selection-store';
import { exportArtboard } from './export-service';
import { runGenerativeFill, type FillModelId } from './generative-fill';
import { buildMaskData } from '../utils/mask-builder';
import type { MediaAsset } from '../types/project';

// fal bills per megapixel (rounded up); cap the canvas at ~1MP so a fill costs
// one MP. The result is placed back over the full artboard (slight upscale).
const MAX_PIXELS = 1_000_000;

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type);
  });
}

/**
 * Run generative fill for the active selection. Returns the new layer id.
 * Throws on no-selection or generation failure (caller shows the error).
 */
export async function applyGenerativeFill(prompt: string, model?: FillModelId, referenceUrl?: string): Promise<string> {
  const projStore = useProjectStore.getState();
  const { project, selectedArtboardId } = projStore;
  const selection = useSelectionStore.getState().active;
  const artboard = project?.artboards.find((a) => a.id === selectedArtboardId);
  if (!project || !artboard || !selection || selection.path.length < 3) {
    throw new Error('Make a selection first');
  }

  const W = Math.max(1, Math.round(artboard.size.width));
  const H = Math.max(1, Math.round(artboard.size.height));
  // Cap at ~1MP for the fal bill; both source + mask share these dimensions so
  // the model's mask aligns to the image.
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (W * H)));
  const tw = Math.max(1, Math.round(W * scale));
  const th = Math.max(1, Math.round(H * scale));

  // 1) Full composite (flattened visible artboard) at the target size.
  const compBlob = await exportArtboard(project, artboard, {
    format: 'png', quality: 'high', scale: 1, background: 'include',
  });
  const compImg = await blobToImage(compBlob);
  const sc = document.createElement('canvas');
  sc.width = tw; sc.height = th;
  sc.getContext('2d')!.drawImage(compImg, 0, 0, tw, th);
  const sourceBlob = await canvasToBlob(sc, 'image/jpeg');

  // 2) Mask — BLACK = keep, WHITE = inpaint the selection (FLUX Fill convention).
  const mc = document.createElement('canvas');
  mc.width = tw; mc.height = th;
  const mx = mc.getContext('2d')!;
  mx.fillStyle = 'black';
  mx.fillRect(0, 0, tw, th);
  mx.fillStyle = 'white';
  mx.beginPath();
  mx.moveTo(selection.path[0].x * scale, selection.path[0].y * scale);
  for (let i = 1; i < selection.path.length; i++) {
    mx.lineTo(selection.path[i].x * scale, selection.path[i].y * scale);
  }
  mx.closePath();
  mx.fill();
  const maskBlob = await canvasToBlob(mc, 'image/png');

  // 3) True masked inpaint (full image + mask → only the selection regenerates).
  const resultDataUrl = await runGenerativeFill({ imageBlob: sourceBlob, maskBlob, prompt, model, referenceUrl });

  const resImg = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = resultDataUrl;
  });

  // 4) Place as a NEW full-artboard layer, masked to the selection — the result
  //    already preserves everything outside the mask; the layer mask keeps the
  //    original pixel-perfect and makes it non-destructive.
  const assetId = `genfill-${Date.now()}`;
  const asset: MediaAsset = {
    id: assetId,
    name: prompt.slice(0, 40) || 'Generative fill',
    type: 'image',
    mimeType: 'image/png',
    size: resultDataUrl.length,
    width: resImg.naturalWidth,
    height: resImg.naturalHeight,
    thumbnailUrl: resultDataUrl,
    dataUrl: resultDataUrl,
  };
  projStore.addAsset(asset);
  const layerId = projStore.addImageLayer(assetId, { x: 0, y: 0, width: W, height: H });

  // Mask the new layer to the selection so only the filled region shows.
  const layer = useProjectStore.getState().project?.layers[layerId];
  if (layer) {
    const maskData = await buildMaskData(layer, selection, true);
    projStore.updateLayer(layerId, {
      name: prompt.slice(0, 40) || 'Generative fill',
      mask: {
        id: `mask-${Date.now()}`, type: 'pixel', enabled: true, linked: true,
        density: 100, feather: 0, invert: false, data: maskData,
        vectorPath: [...selection.path],
      },
    });
  }

  useSelectionStore.getState().clearSelection();
  return layerId;
}
