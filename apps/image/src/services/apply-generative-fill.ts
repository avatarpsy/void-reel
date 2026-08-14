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

/**
 * CROP AND STITCH — the reason a small selection comes back with sane proportions.
 *
 * ── THE PROBLEM WITH SENDING THE WHOLE FRAME ────────────────────────────────
 * A latent model spends a fixed detail budget across whatever canvas it is given.
 * Send it a 1154×866 composite with a 200×200 face masked out, and that face gets
 * about 3% of the latent area — so the model renders it crudely and, worse, at the
 * wrong internal scale. The result is anatomy that is individually plausible and
 * proportionally wrong: a head too large for its body, features that do not sit
 * where the surrounding image implies they should.
 *
 * That is not a model defect and no prompt fixes it. It is the frame being wrong.
 *
 * ── WHAT THIS DOES INSTEAD ──────────────────────────────────────────────────
 * Crop a padded window around the selection, scale THAT to the model's native
 * resolution, generate, then scale back and stitch into place. The masked region
 * now occupies most of a native-size frame, which is the condition every one of
 * these models was trained under. It is what ComfyUI's own "Inpaint Crop and
 * Stitch" nodes do, and it is standard practice for a reason.
 *
 * ── WHY THE PADDING MATTERS ─────────────────────────────────────────────────
 * Inpainting is conditioned on what surrounds the hole. Crop tight to the
 * selection and the model has no context — it invents something unrelated to the
 * picture. The padding is what lets it match lighting, perspective and style, so
 * it is generous by default and always includes real pixels where they exist.
 */
/**
 * The model's native training resolution, as a pixel budget.
 *
 * ── THIS MUST COME FROM THE RECIPE, NOT A CONSTANT ──────────────────────────
 * SDXL is trained at ~1024², SD 1.5 at 512², and running either far outside its
 * range produces incoherent output — SD 1.5 at 1024² famously duplicates
 * features and invents letterforms out of noise. Measured exactly that here: the
 * same window that came back as garbage at 1024 was coherent at 512.
 *
 * So 1024² is the DEFAULT, not the rule. A recipe declares `resolutions` and the
 * first entry wins, which is why `sd15-inpaint` says "512x512" and gets it.
 * Hardcoding this was a real bug and it is the kind that looks like a bad model
 * rather than a bad caller.
 */
const DEFAULT_NATIVE_PIXELS = 1_024 * 1_024;

/** `"512x512"` → 262144. Returns null for anything unparseable, so a recipe with
 *  a free-text resolution falls back rather than producing a nonsense budget. */
export function nativePixelsFrom(resolutions?: string[]): number | null {
  const first = resolutions?.[0];
  if (typeof first !== 'string') return null;
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(first.trim());
  if (!m) return null;
  const px = Number(m[1]) * Number(m[2]);
  return Number.isFinite(px) && px > 0 ? px : null;
}
/** How much context to include around the selection, as a share of its size.
 *  0.6 means a 200px selection is sent inside a ~520px window. */
const CONTEXT_PAD_RATIO = 0.6;
/** Latents work in 8-pixel blocks; a non-multiple is either rejected or silently
 *  rounded, and a silent round is how a fill comes back very slightly offset. */
const LATENT_BLOCK = 8;

const snap = (n: number) => Math.max(LATENT_BLOCK, Math.round(n / LATENT_BLOCK) * LATENT_BLOCK);

/**
 * The window to send, in ARTBOARD coordinates, plus the size to send it at.
 *
 * Never larger than the artboard: a window that runs off the edge would be padded
 * with nothing, and the model would treat that void as part of the picture.
 */
export function planFillWindow(
  region: { x: number; y: number; width: number; height: number },
  W: number,
  H: number,
  /** The model's native pixel budget. See `nativePixelsFrom` — a recipe that
   *  declares 512x512 must be driven at 512x512. */
  nativePixels: number = DEFAULT_NATIVE_PIXELS,
): { sx: number; sy: number; sw: number; sh: number; tw: number; th: number; upscaled: boolean } {
  const pad = Math.round(Math.max(region.width, region.height) * CONTEXT_PAD_RATIO);
  let sx = Math.max(0, Math.floor(region.x - pad));
  let sy = Math.max(0, Math.floor(region.y - pad));
  let sw = Math.min(W - sx, Math.ceil(region.width + pad * 2));
  let sh = Math.min(H - sy, Math.ceil(region.height + pad * 2));
  // Clamp back if the pad pushed the far edge past the artboard.
  sw = Math.max(1, Math.min(sw, W - sx));
  sh = Math.max(1, Math.min(sh, H - sy));

  // Scale the window to the model's native budget — UP for a small selection
  // (that is the whole point) and down for one larger than native.
  const factor = Math.sqrt(nativePixels / (sw * sh));
  const tw = snap(sw * factor);
  const th = snap(sh * factor);
  return { sx, sy, sw, sh, tw, th, upscaled: factor > 1 };
}

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

/**
 * The mask for a crop-and-stitch window — WHITE = regenerate, BLACK = keep.
 *
 * Same convention and same feathering as `buildFalMask`; what differs is the
 * coordinate transform. The selection path is in ARTBOARD space and the window is
 * a sub-rectangle of it rendered at a different size, so each point maps as
 * `(p - windowOrigin) * (targetSize / windowSize)`. Getting that wrong does not
 * produce an error — it produces a fill in the wrong place, which is why the
 * transform is written once here rather than inline at the call site.
 */
function buildWindowMask(
  selection: Selection,
  win: { sx: number; sy: number; sw: number; sh: number; tw: number; th: number },
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = win.tw; c.height = win.th;
  const x = c.getContext('2d')!;
  const kx = win.tw / win.sw;
  const ky = win.th / win.sh;

  x.fillStyle = selection.inverted ? 'white' : 'black';
  x.fillRect(0, 0, win.tw, win.th);
  // Feather relative to the WINDOW, not the artboard: the window is upscaled, so
  // a fixed artboard-pixel feather would come out proportionally tiny here.
  const feather = Math.max(2, Math.round(Math.min(win.tw, win.th) * 0.012));
  x.filter = `blur(${feather}px)`;
  x.fillStyle = selection.inverted ? 'black' : 'white';
  x.beginPath();
  x.moveTo((selection.path[0].x - win.sx) * kx, (selection.path[0].y - win.sy) * ky);
  for (let i = 1; i < selection.path.length; i++) {
    x.lineTo((selection.path[i].x - win.sx) * kx, (selection.path[i].y - win.sy) * ky);
  }
  x.closePath();
  x.fill();
  return c;
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
export async function applyGenerativeFill(
  prompt: string,
  model?: FillModelId,
  referenceUrl?: string,
  /** The chosen model's native pixel budget, from its recipe. Only meaningful for
   *  a local model; the cloud engines size their own requests. */
  nativePixels?: number | null,
): Promise<string> {
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
    /**
     * The user's own GPU, via CROP AND STITCH — see `planFillWindow`.
     *
     * A padded window around the selection is scaled to the model's native
     * resolution, generated there, and the result is expanded back onto a
     * full-artboard canvas so everything downstream is unchanged: the placement,
     * the bbox crop and the layer mask all still work in artboard coordinates and
     * did not need to learn about this.
     *
     * PNG throughout, not JPEG. The fal path sends JPEG because it uploads over
     * the internet where a megabyte matters; these bytes go to a process on the
     * same machine, so paying nothing for them buys a source with no block
     * artefacts for the model to reproduce inside the selection.
     */
    const region = selection.inverted && selection.canvasBounds
      ? selection.canvasBounds : selection.bounds;
    // The recipe's own native size decides the window. Falls back to the SDXL
    // default when a recipe does not say — never to a guess that could be an
    // octave out, which is what produced letterforms instead of brickwork.
    const win = planFillWindow(region, W, H, nativePixels ?? undefined);

    // The window, at native resolution, drawn from the FULL-RESOLUTION composite
    // so upscaling a small selection samples real pixels rather than the
    // already-downscaled 1 MP copy.
    const winC = document.createElement('canvas');
    winC.width = win.tw; winC.height = win.th;
    winC.getContext('2d')!.drawImage(
      compImg,
      win.sx, win.sy, win.sw, win.sh,
      0, 0, win.tw, win.th,
    );

    // The mask, built in the same window space. `buildFalMask` works in scaled
    // artboard coordinates, so it is given a transform that maps the window onto
    // the target: translate by the window origin, then scale to the target size.
    const maskC = buildWindowMask(selection, win);

    const filledWindow = await runLocalFill({
      imageBlob: await canvasToBlob(winC, 'image/png'),
      maskBlob: await canvasToBlob(maskC, 'image/png'),
      prompt,
      model: model!,
    });

    // Expand back to a full-artboard-shaped image. Everything after this point
    // expects "the result represents the whole artboard", and honouring that
    // contract is what keeps placeFillResult and the layer mask untouched.
    const winImg = await dataUrlToImage(filledWindow);
    const full = document.createElement('canvas');
    full.width = tw; full.height = th;
    const fx = full.getContext('2d')!;
    // The original underneath, so anything outside the window is the real image
    // rather than transparent — the bbox crop can legitimately reach a pixel or
    // two beyond the window because of its own feather padding.
    fx.drawImage(sc, 0, 0);
    fx.drawImage(
      winImg,
      0, 0, winImg.naturalWidth, winImg.naturalHeight,
      win.sx * scale, win.sy * scale, win.sw * scale, win.sh * scale,
    );
    resultDataUrl = full.toDataURL('image/png');
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
