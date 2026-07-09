// layer-separation.ts
// -----------------------------------------------------------------------------
// Seedream 5.0 Pro "separate into layers": flatten the current artboard to one
// composite, send it to the model, and import each returned image as an
// independent, stacked editor layer (background → foreground). The original
// layers are hidden (non-destructive), so the user gets an editable, layered
// version of what was a flat image.
// -----------------------------------------------------------------------------

import { useProjectStore } from '../stores/project-store';
import { exportArtboard } from './export-service';
import { uploadReferenceImage } from './generative-fill';
import { separateLayers, sizeToAspectRatio } from './image-generation';
import type { MediaAsset } from '../types/project';

// Seedream 5 Pro's supported aspect ratios (no `auto`); the layer output must
// use one of these, so we snap the artboard's shape to the nearest.
const SEEDREAM_ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2'];

/** Route remote result URLs through the same-origin CORS proxy so the editor
 *  can fetch their bytes without a taint/CORS failure. */
function proxied(url: string): string {
  if (/^https?:\/\//i.test(url) && !url.startsWith(window.location.origin)) {
    return `/api/studio/media-proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function imageDims(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

async function urlToLayerAsset(url: string, index: number): Promise<MediaAsset> {
  const res = await fetch(proxied(url));
  if (!res.ok) throw new Error(`fetch layer ${res.status}`);
  const blob = await res.blob();
  const dataUrl = await blobToDataUrl(blob);
  const { width, height } = await imageDims(dataUrl);
  return {
    id: `layer-sep-${Date.now()}-${index}`,
    name: `Layer ${index + 1}`,
    type: 'image',
    mimeType: blob.type || 'image/png',
    size: blob.size,
    width: width || 0,
    height: height || 0,
    thumbnailUrl: dataUrl,
    dataUrl,
  };
}

/**
 * Separate the current artboard into layers. Returns the number of layers
 * imported. Throws on failure (caller shows the error / credits popup).
 */
export async function separateArtboardIntoLayers(opts: { prompt?: string; resolution?: string } = {}): Promise<number> {
  const P = useProjectStore.getState();
  const project = P.project;
  if (!project) throw new Error('No project open');
  const artboardId = P.selectedArtboardId ?? project.artboards[0]?.id ?? null;
  const artboard = project.artboards.find((a) => a.id === artboardId);
  if (!artboard) throw new Error('No page selected');
  if (!artboard.layerIds.length) throw new Error('This page is empty — add an image first');

  // Flatten what the user sees to a single PNG, upload it to a public URL.
  const blob = await exportArtboard(project, artboard, { scale: 1, format: 'png', quality: 'high', background: 'include' });
  const file = new File([blob], 'composite.png', { type: 'image/png' });
  const publicUrl = await uploadReferenceImage(file);

  const aspectRatio = sizeToAspectRatio(artboard.size.width, artboard.size.height, SEEDREAM_ASPECTS);
  const urls = await separateLayers({ imageUrl: publicUrl, prompt: opts.prompt, resolution: opts.resolution, aspectRatio });

  // Hide the source layers (non-destructive) so the separated layers are shown.
  const originalIds = [...artboard.layerIds];
  for (const lid of originalIds) P.updateLayer(lid, { visible: false });

  // Import each returned image full-bleed, stacked (returned order preserved).
  for (let i = 0; i < urls.length; i++) {
    const asset = await urlToLayerAsset(urls[i], i);
    P.addAsset(asset);
    P.addImageLayer(asset.id, { x: 0, y: 0, width: artboard.size.width, height: artboard.size.height });
  }
  return urls.length;
}
