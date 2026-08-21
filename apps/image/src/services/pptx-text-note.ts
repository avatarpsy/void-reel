/**
 * What honestly happens to a project's TEXT in a .pptx.
 *
 * ── WHY THIS IS NOT A CONSTANT STRING ────────────────────────────────────────
 * The export dialog described PowerPoint as "Every page a slide, still
 * editable". That is true for a slide built from text layers and false for a
 * slide built from a designed block: a block is baked to pixels, so the
 * exporter writes one flat picture and there is no text left to edit.
 *
 * Since the presentation method now tells the agent to prefer designed blocks,
 * the decks this product makes are exactly the ones the promise did not hold
 * for — somebody exporting to restyle against a company template would open six
 * pictures. A promise broken at the moment of export is the expensive kind.
 *
 * So the claim is derived from the document rather than asserted about it.
 *
 * ── WHY IT LIVES ALONE ───────────────────────────────────────────────────────
 * `pptx-export` pulls in pptxgenjs and pdf-lib — some 800 kB, deliberately
 * loaded only when somebody actually exports. The dialog needs this sentence
 * while it is merely OPEN, so putting it there would drag the whole exporter
 * into the main bundle to render one line of text.
 */
import type { ImageLayer, Project } from '../types/project';

export function pptxTextNote(project: Project | null | undefined): string {
  if (!project) return '';
  const pages = project.artboards ?? [];
  let designed = 0;
  let typed = 0;

  for (const ab of pages) {
    let hasBlock = false;
    let hasText = false;
    for (const id of ab.layerIds) {
      const layer = project.layers[id];
      if (!layer || layer.visible === false) continue;
      if ((layer as ImageLayer).composition) hasBlock = true;
      else if (layer.type === 'text') hasText = true;
    }
    if (hasBlock) designed++;
    else if (hasText) typed++;
  }

  if (!designed) return typed ? 'Text stays editable in PowerPoint.' : '';

  if (!typed) {
    return designed === 1
      ? 'This page is a designed block, so it exports as a picture — the text will not be editable in PowerPoint.'
      : `All ${designed} pages are designed blocks, so they export as pictures — the text will not be editable in PowerPoint.`;
  }

  return `${designed} of ${pages.length} pages are designed blocks and export as pictures; `
    + 'text you typed yourself stays editable.';
}
