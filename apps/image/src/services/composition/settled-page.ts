import { useProjectStore } from '../../stores/project-store';
import { lastBakeFailure, settleCompositions } from './bake';
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
    // SAY WHY, AND SAY IT IS FINAL FOR THIS TURN. "Retry viewing after it is
    // ready" read as an instruction to retry now, and an agent called the same
    // failing measure a dozen times in one turn.
    const why = lastBakeFailure(missing[0].id);
    const reason = why?.reason === 'device_unavailable'
      ? 'The Voidspace desktop app is not connected, and it is what renders compositions.'
      : why?.message
        ? `The renderer could not draw it: ${why.message}`
        : 'Its render did not finish.';
    throw new Error(`The render for "${missing[0].name}" is unavailable. ${reason} `
      + 'Keep the composition and do not rebuild the design. Do not call img_view or img_measure for this page again in this turn: '
      + 'finish the rest of the work and tell the user plainly that the visual check is still pending.');
  }
  return { project, page };
}
