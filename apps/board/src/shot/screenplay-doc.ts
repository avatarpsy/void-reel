/**
 * The screenplay — one document, and it is text.
 *
 * ── WHAT THIS REPLACED, AND WHY ──────────────────────────────────────────────
 * This was once a structured object: arrays of sequences and scenes, each with
 * typed fields, edited through form rows. That was wrong twice over.
 *
 * It was wrong for the WRITER, because a screenplay is prose. A person with a
 * story in their head does not fill in `targetSec`; they write "Six people
 * around a table. A laptop open." Form fields produce an outline, and an outline
 * is not a script — the emotion lives in the sentences.
 *
 * And it was wrong for the SYSTEM, because it meant the same film was authored
 * twice: once as structure, once as shots, with nothing reconciling them. A user
 * could edit the panel and the board would quietly disagree.
 *
 * So: ONE Fountain document. The structure is IN the text — `#` acts, `##`
 * sequences, sluglines as scenes — and everything else is derived from it by
 * `parseFountain`. Nothing is authored twice, so nothing can drift.
 *
 * ── WHERE THE BEAT WENT ──────────────────────────────────────────────────────
 * Nowhere in the data, deliberately. Act/Sequence/Scene/Beat is how a writer
 * THINKS; Sequence/Scene/Shot is what gets produced. The beat shapes the prose
 * and then disappears into it — which is exactly what happens in a real script.
 * It is craft guidance in the agent's prompt, never a field. See `fountain.ts`.
 *
 * ── WHERE IT LIVES ───────────────────────────────────────────────────────────
 * A block on the surface, like a shot: same schema shape, same parent, same
 * persistence, same undo. The screenplay is a thing the user reads and edits, so
 * it is a thing they can see, select, move and type into. One per board —
 * `ensureScript` is the only constructor.
 */
import { BlockModel, BlockSchemaExtension, defineBlockSchema } from '@blocksuite/store';
import type { BlockStdScope } from '@blocksuite/std';
import { GfxCompatible, type GfxCommonBlockProps } from '@blocksuite/std/gfx';

import { parseFountain, type ParsedScript } from './fountain';

export interface ScreenplayProps extends GfxCommonBlockProps {
  /**
   * The whole screenplay, as Fountain.
   *
   * ONE STRING. Not paragraphs, not a rich-text tree, not a Y.Text — a script is
   * edited as a document and read as a document, and the two consumers that
   * matter (the agent, and `parseFountain`) both want it whole. A structured
   * representation would have to be flattened for both.
   */
  text: string;
}

/** A page. 8.5in at ~96dpi is 816px; this is that, minus a comfortable margin. */
export const SCREENPLAY_W = 640;
export const SCREENPLAY_H = 860;

export const ScreenplayBlockSchema = defineBlockSchema({
  flavour: 'voidspace:screenplay',
  props: (): ScreenplayProps => ({
    text: '',
    xywh: `[0,0,${SCREENPLAY_W},${SCREENPLAY_H}]`,
    index: 'a0',
    lockedBySelf: false,
    scale: 1,
    rotate: 0,
  }),
  metadata: {
    version: 1,
    role: 'content',
    parent: ['affine:surface'],
    children: [],
  },
  toModel: () => new ScreenplayBlockModel(),
});

export class ScreenplayBlockModel extends GfxCompatible<ScreenplayProps>(BlockModel) {}

export const ScreenplayBlockSchemaExtension = BlockSchemaExtension(ScreenplayBlockSchema);

/** The board's screenplay block, or null when the user has not started one. */
export function screenplayBlock(std: BlockStdScope): ScreenplayBlockModel | null {
  const found = std.store.getBlocksByFlavour('voidspace:screenplay');
  return (found[0]?.model as ScreenplayBlockModel | undefined) ?? null;
}

/** The screenplay text. Always a string, never undefined. */
export function readScript(std: BlockStdScope): string {
  const model = screenplayBlock(std);
  return typeof model?.props.text === 'string' ? model.props.text : '';
}

/** The screenplay, parsed. */
export function readParsed(std: BlockStdScope): ParsedScript {
  return parseFountain(readScript(std));
}

/**
 * The board's screenplay block, created if this board has none.
 *
 * Placed to the LEFT of the filmstrip's origin, so it reads before shot 1 in the
 * direction the board is laid out — the document the shots come from, sitting
 * where a reader would look first.
 */
export function ensureScript(std: BlockStdScope, surfaceId: string): ScreenplayBlockModel {
  const existing = screenplayBlock(std);
  if (existing) return existing;
  const id = std.store.addBlock(
    'voidspace:screenplay',
    { xywh: `[${-(SCREENPLAY_W + 140)},0,${SCREENPLAY_W},${SCREENPLAY_H}]` },
    surfaceId,
  );
  return std.store.getBlock(id)!.model as ScreenplayBlockModel;
}

/**
 * Write the screenplay, as ONE undoable action.
 *
 * Whole-document writes only. There is no "append a scene" verb, because a
 * screenplay is a shape: a tool that could only append would let an agent bolt a
 * fourth sequence onto a three-sequence piece without reconsidering the first
 * three. Rewriting is one Ctrl+Z, so a bad draft costs one gesture.
 */
export function writeScript(std: BlockStdScope, surfaceId: string, text: string): string {
  const model = ensureScript(std, surfaceId);
  const next = typeof text === 'string' ? text : '';
  if (model.props.text !== next) {
    std.store.captureSync();
    std.store.updateBlock(model, { text: next });
  }
  return next;
}
