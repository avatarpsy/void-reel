import type { Project } from '../types/project';

/** Undo retains old assets in memory. A saved document only needs the assets
 * referenced by its layers; copying them must not modify the live undo state. */
export function compactProjectDocument(project: Project): Project {
  const used = new Set(Object.values(project.layers)
    .flatMap(layer => layer.type === 'image' ? [layer.sourceId] : []));
  const assets = Object.fromEntries(Object.entries(project.assets).filter(([id]) => used.has(id)));
  return { ...project, assets };
}
