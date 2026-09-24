import { useProjectStore } from '../../stores/project-store';
import { settleCompositions } from './bake';
import { pendingCompositionLayers } from './readiness';

/** Pixel readers must wait for the render and use the resulting immutable
 * document. A missing render is an actionable failure, never a blank success. */
export async function settledPage(projectId: string, pageId: string) {
  await settleCompositions();
  const project = useProjectStore.getState().project;
  if (!project || project.id !== projectId) throw new Error('The open project changed. Read the current canvas before continuing.');
  const page = project.artboards.find(p => p.id === pageId);
  if (!page) throw new Error('The requested page no longer exists. Read the current canvas.');
  const missing = pendingCompositionLayers(project, page);
  if (missing.length) {
    throw new Error(`The render for "${missing[0].name}" is unavailable. Keep the composition; check the connected desktop renderer and retry viewing after it is ready. Do not rebuild the design to fix missing pixels.`);
  }
  return { project, page };
}
