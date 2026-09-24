import type { Project, Artboard, ImageLayer } from '../../types/project';
import { needsRerender } from './hash';

/** Visible compositions whose pixels are missing or belong to an older edit. */
export function pendingCompositionLayers(project: Project, page: Artboard): ImageLayer[] {
  const pending = [...page.layerIds];
  const seen = new Set<string>();
  const missing: ImageLayer[] = [];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const layer = project.layers[id];
    if (!layer || !layer.visible || layer.transform.opacity === 0) continue;
    if (layer.type === 'group') pending.push(...layer.childIds);
    if (layer.type === 'image' && layer.composition
      && (needsRerender(layer.composition) || !project.assets[layer.sourceId])) missing.push(layer);
  }
  return missing;
}
