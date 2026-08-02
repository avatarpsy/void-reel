/**
 * The block draft — a design on the canvas, before it is anyone's.
 *
 * ── WHY A CARD ON THE BOARD AND NOT A CHAT BUBBLE ────────────────────────────
 * Judging a design needs SIZE. A thumbnail in a chat transcript answers "did
 * something get made"; it does not answer "is the headline too tight", "does the
 * scrim eat the face", "would I use this". Those are the only questions worth
 * asking before a block enters someone's library, and they need the thing drawn
 * big, next to the shots it will sit among.
 *
 * The canvas is already where the user is looking, already scrollable, already
 * zoomable. So a draft is a block on it — the scratch pad, in the literal sense.
 *
 * ── WHY IT IS NOT SAVED YET, AND WHY THAT IS THE POINT ───────────────────────
 * A block is reusable, shareable, and shadows a starter of the same name. That
 * makes saving one a commitment, and a commitment made on the user's behalf
 * without them seeing it is the thing to avoid. So composing produces a DRAFT:
 * visible, editable, and inert. It reaches the library only when a person says
 * so, and that is the moment the embedding is computed.
 *
 * Iteration happens in place. "Make the headline bigger" rewrites the same
 * draft rather than piling up a second card, because a scratch pad with six
 * near-identical versions on it is a scratch pad nobody can read.
 *
 * ── WHY IT PERSISTS WITH THE BOARD ───────────────────────────────────────────
 * It is an ordinary block, so it saves, undoes and syncs like everything else.
 * Someone who drafts a design, closes the tab and comes back tomorrow finds it
 * where they left it. A draft that evaporated on reload would teach people to
 * save prematurely, which is the exact habit this is meant to remove.
 */
import { GfxCompatible, type GfxCommonBlockProps } from '@blocksuite/std/gfx';
import { BlockModel, BlockSchemaExtension, defineBlockSchema } from '@blocksuite/store';

export interface DraftProps extends GfxCommonBlockProps {
  /** The name it will take in the library. Editable before saving. */
  name: string;
  /** The whole self-contained document, as authored. */
  html: string;
  /**
   * Everything else the library needs, as JSON.
   *
   * One string rather than a dozen props: this is a payload passed through to
   * the save endpoint, not something the canvas reasons about. Splitting it into
   * typed props would mean re-flattening it on the way out, and adding a field
   * to a block would mean a schema migration for a draft.
   */
  meta: string;
  /** `draft` while it is being worked on; `saved` once it is in the library. */
  status: 'draft' | 'saved';
  /** What the library said when it was saved — shown on the card. */
  note: string;
}

/** 9:16 at a size you can actually judge, plus room for the header and slots. */
export const DRAFT_W = 460;
export const DRAFT_H = 900;

export const DraftBlockSchema = defineBlockSchema({
  flavour: 'voidspace:blockdraft',
  props: (): DraftProps => ({
    name: '',
    html: '',
    meta: '{}',
    status: 'draft',
    note: '',
    xywh: `[0,0,${DRAFT_W},${DRAFT_H}]`,
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
  toModel: () => new DraftBlockModel(),
});

export class DraftBlockModel extends GfxCompatible<DraftProps>(BlockModel) {}

export const DraftBlockSchemaExtension = BlockSchemaExtension(DraftBlockSchema);

/** The slot manifest a draft carries, parsed. Never throws on bad JSON. */
export function draftMeta(model: DraftBlockModel): Record<string, unknown> {
  try {
    const v = JSON.parse(model.props.meta || '{}');
    return v && typeof v === 'object' ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
