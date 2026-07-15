// image-import.ts
// -----------------------------------------------------------------------------
// Turn a dropped/selected image File into a self-contained MediaAsset (base64
// dataUrl + real pixel dimensions), ready for addAsset()/addImageLayer(). Shared
// so every entry point (canvas drop, uploads panel) builds the exact same asset
// shape — the renderer keys off `dataUrl`, so we always populate it.
// -----------------------------------------------------------------------------

import type { MediaAsset } from '../types/project';

/** True for the raster/vector image types the editor can place as a layer. */
export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

/**
 * Read an image File into a MediaAsset. Returns null for non-images. `width`/
 * `height` are the image's natural pixel dimensions (0 if it couldn't decode —
 * callers should skip those rather than place a zero-sized layer).
 */
export async function fileToImageAsset(file: File): Promise<MediaAsset | null> {
  if (!isImageFile(file)) return null;

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });

  const { width, height } = await new Promise<{ width: number; height: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: file.name || 'Image',
    type: file.type === 'image/svg+xml' ? 'svg' : 'image',
    mimeType: file.type,
    size: file.size,
    width,
    height,
    thumbnailUrl: dataUrl,
    dataUrl,
  };
}
