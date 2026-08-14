// apply-generative-fill.ts
// -----------------------------------------------------------------------------
// Orchestrates Photoshop-style Generative Fill end to end. Two engines:
//   • fal  (FLUX Fill)  — TRUE masked inpainting: send full composite + a mask;
//                         only the masked pixels regenerate.
//   • kie  (nano-banana / gpt-image-2) — mask-free editors that regenerate the
//                         whole frame, so we send the composite with the
//                         selection OUTLINED and composite only the selection
//                         region of the result back (outside stays untouched).
// Either way the result is placed on a NEW layer cropped to the selection bbox
// and masked to the selection shape — non-destructive, and we store only the
// region, not the whole frame (Photoshop keeps generative layers selection-sized).
// -----------------------------------------------------------------------------

import { useProjectStore } from '../stores/project-store';
import { useSelectionStore } from '../stores/selection-store';
import { exportArtboard } from './export-service';
import { runGenerativeFill, runKieEditFill, runLocalFill, fillEngine, type FillModelId } from './generative-fill';
import { buildMaskData } from '../utils/mask-builder';
import type { MediaAsset } from '../types/project';
import type { Selection } from '../types/selection';

// Cap the canvas at ~1MP — keeps the fal bill at one MP and the Kie request at 1K.
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

function dataUrlToImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/** Mask for the fal FLUX Fill request — BLACK = keep, WHITE = inpaint. An
 *  inverted selection inpaints the canvas MINUS the shape, so flood white and
 *  cut the shape out in black; otherwise the reverse. */
function buildFalMask(selection: Selection, tw: number, th: number, scale: number): HTMLCanvasElement {
  const mc = document.createElement('canvas');
  mc.width = tw; mc.height = th;
  const mx = mc.getContext('2d')!;
  mx.fillStyle = selection.inverted ? 'white' : 'black';
  mx.fillRect(0, 0, tw, th);
  // Softly blur the mask edge so FLUX inpaints with a feathered boundary and
  // blends into the surroundings rather than along a hard line (ComfyUI grows +
  // blurs the inpaint mask for the same reason). Modest — the soft composite in
  // placeFillResult does the heavier blend.
  const featherPx = Math.max(2, Math.round(Math.min(tw, th) * 0.01));
  mx.filter = `blur(${featherPx}px)`;
  mx.fillStyle = selection.inverted ? 'black' : 'white';
  mx.beginPath();
  mx.moveTo(selection.path[0].x * scale, selection.path[0].y * scale);
  for (let i = 1; i < selection.path.length; i++) {
    mx.lineTo(selection.path[i].x * scale, selection.path[i].y * scale);
  }
  mx.closePath();
  mx.fill();
  mx.filter = 'none';
  return mc;
}

/** Bake a bright magenta outline of the selection onto a copy of the composite,
 *  so the mask-free Kie models know exactly which region to edit. */
function bakeSelectionOutline(composite: HTMLCanvasElement, selection: Selection, scale: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = composite.width; out.height = composite.height;
  const o = out.getContext('2d')!;
  o.drawImage(composite, 0, 0);
  o.strokeStyle = '#ff00ff';
  o.lineWidth = Math.max(3, Math.round(Math.min(out.width, out.height) * 0.006));
  o.lineJoin = 'round';
  o.beginPath();
  o.moveTo(selection.path[0].x * scale, selection.path[0].y * scale);
  for (let i = 1; i < selection.path.length; i++) {
    o.lineTo(selection.path[i].x * scale, selection.path[i].y * scale);
  }
  o.closePath();
  o.stroke();
  return out;
}

/**
 * Place the model result on a new layer, cropped to the selection's bounding box
 * (the whole canvas if the selection is inverted) and masked to the selection
 * shape. Storing only the region — not the full frame — keeps assets small.
 */
async function placeFillResult(resImg: HTMLImageElement, selection: Selection, W: number, H: number, name: string): Promise<string> {
  const projStore = useProjectStore.getState();

  const region = selection.inverted && selection.canvasBounds ? selection.canvasBounds : selection.bounds;
  // Blend feather — soften the mask edge so the fill fades into the original
  // instead of leaving a hard rectangular seam (the same idea as ComfyUI's
  // "Crop & Stitch" blend_pixels / a feathered inpaint mask). Scales with the
  // selection, honours a larger user feather. Critical for the mask-free Kie
  // models, which regenerate the whole frame so their region edge won't match.
  const minDim = Math.min(region.width, region.height);
  const blendFeather = Math.max(selection.feather || 0, Math.min(32, Math.max(8, Math.round(minDim * 0.06))));
  const fpad = Math.ceil(blendFeather) + 2;
  const bx = Math.max(0, Math.floor(region.x - fpad));
  const by = Math.max(0, Math.floor(region.y - fpad));
  const bw = Math.max(1, Math.min(W - bx, Math.ceil(region.width + fpad * 2)));
  const bh = Math.max(1, Math.min(H - by, Math.ceil(region.height + fpad * 2)));

  // Crop the (artboard-space) result to the bbox. The result represents the full
  // artboard, so map artboard coords → result pixels.
  const rw = resImg.naturalWidth || W;
  const rh = resImg.naturalHeight || H;
  const crop = document.createElement('canvas');
  crop.width = bw; crop.height = bh;
  crop.getContext('2d')!.drawImage(
    resImg,
    bx * (rw / W), by * (rh / H), bw * (rw / W), bh * (rh / H),
    0, 0, bw, bh,
  );
  const dataUrl = crop.toDataURL('image/png');

  const assetId = `genfill-${Date.now()}`;
  const asset: MediaAsset = {
    id: assetId, name, type: 'image', mimeType: 'image/png',
    size: dataUrl.length, width: bw, height: bh,
    thumbnailUrl: dataUrl, dataUrl,
  };
  projStore.addAsset(asset);
  const layerId = projStore.addImageLayer(assetId, { x: bx, y: by, width: bw, height: bh });

  // Mask the new layer to the selection so only the filled region shows (the
  // layer is bbox-local, so buildMaskData maps the selection into its space).
  const layer = useProjectStore.getState().project?.layers[layerId];
  if (layer) {
    // Feathered mask = soft-edged stitch (no hard seam).
    const maskData = await buildMaskData(layer, { ...selection, feather: blendFeather }, true);
    projStore.updateLayer(layerId, {
      name,
      mask: {
        id: `mask-${Date.now()}`, type: 'pixel', enabled: true, linked: true,
        density: 100, feather: blendFeather, invert: false, data: maskData,
        vectorPath: [...selection.path],
      },
    });
  }
  return layerId;
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

  const engine = model ? fillEngine(model) : 'fal';
  const name = prompt.slice(0, 40) || 'Generative fill';

  let resultDataUrl: string;
  if (engine === 'kie') {
    // Mask-free editor: outline the selection on the composite, send it (+ any
    // reference) and composite only the selection region of the result back.
    const marked = bakeSelectionOutline(sc, selection, scale);
    const markedBlob = await canvasToBlob(marked, 'image/png');
    resultDataUrl = await runKieEditFill({
      markedBlob,
      referenceUrls: referenceUrl ? [referenceUrl] : [],
      prompt,
      model: model!,
      aspectRatio: 'auto',
      inverted: selection.inverted === true,
    });
  } else if (engine === 'local') {
    // The user's own GPU. Same two artefacts as the fal path — full composite and
    // a white-is-the-hole mask — because a local inpaint node wants exactly what
    // FLUX Fill wants. Only the transport differs, so the mask maths, the
    // feathering and the placement below are shared rather than reimplemented.
    //
    // PNG, not JPEG. The fal path sends JPEG because it is uploading over the
    // internet and a megabyte matters there; here the bytes travel to a process
    // on the same machine, so paying nothing for them buys a source image with no
    // block artefacts for the model to reproduce inside the selection.
    const sourceBlob = await canvasToBlob(sc, 'image/png');
    const maskBlob = await canvasToBlob(buildFalMask(selection, tw, th, scale), 'image/png');
    resultDataUrl = await runLocalFill({ imageBlob: sourceBlob, maskBlob, prompt, model: model! });
  } else {
    // True masked inpaint: full composite + mask.
    const sourceBlob = await canvasToBlob(sc, 'image/jpeg');
    const maskBlob = await canvasToBlob(buildFalMask(selection, tw, th, scale), 'image/png');
    resultDataUrl = await runGenerativeFill({ imageBlob: sourceBlob, maskBlob, prompt, model, referenceUrl });
  }

  const resImg = await dataUrlToImage(resultDataUrl);
  const layerId = await placeFillResult(resImg, selection, W, H, name);

  useSelectionStore.getState().clearSelection();
  return layerId;
}
