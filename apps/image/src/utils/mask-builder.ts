import { createMaskFromSelection } from '../types/mask';
import type { Layer } from '../types/project';
import type { Selection } from '../types/selection';

/**
 * Build a layer-mask bitmap (a data URL whose alpha reveals/hides the layer).
 * With an active selection the mask is opaque inside the selection (mapped from
 * artboard space to the layer's local space); otherwise it's a solid
 * reveal-all (white) or hide-all (transparent) mask to paint on later.
 *
 * Shared by the Layers panel "Add mask" button and the inspector MaskSection so
 * both produce identical masks.
 */
export async function buildMaskData(
  layer: Layer,
  selection: Selection | null,
  reveal: boolean,
): Promise<string> {
  const t = layer.transform;
  const w = Math.max(1, Math.round(t.width));
  const h = Math.max(1, Math.round(t.height));

  if (selection && selection.path.length > 2) {
    const localPath = selection.path.map((p) => ({ x: p.x - t.x, y: p.y - t.y }));
    if (selection.inverted) {
      // Inverted selection: reveal the layer EXCEPT the shape — paint white,
      // then cut the shape out (destination-out) so its region stays hidden.
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'destination-out';
      if (selection.feather > 0) ctx.filter = `blur(${selection.feather}px)`;
      ctx.beginPath();
      ctx.moveTo(localPath[0].x, localPath[0].y);
      for (let i = 1; i < localPath.length; i++) ctx.lineTo(localPath[i].x, localPath[i].y);
      ctx.closePath();
      ctx.fill();
      const blob = await canvas.convertToBlob();
      return new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(blob);
      });
    }
    return createMaskFromSelection(localPath, w, h, selection.feather);
  }

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  if (reveal) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  } // hide-all => leave fully transparent
  const blob = await canvas.convertToBlob();
  return new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(blob);
  });
}
