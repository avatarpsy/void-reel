/**
 * `voidspace:sheet` — a spreadsheet on the board.
 *
 * A block on the surface, like the shot card and the screenplay: same parent,
 * same persistence, same undo, same sharing. The cells live in this block's own
 * Y.Map — see `sheet-data.ts` for the exact layout, which is a contract with
 * the server (SHEETS_PLAN.md).
 *
 * ── NOT FLAT DATA, ON PURPOSE ────────────────────────────────────────────────
 * `affine:table` is a flat-data block. Its proxy copies the WHOLE cell map into
 * a fresh object on every single write, so pasting 9,000 cells is 9,000 copies
 * of a growing object — quadratic. Here each prop is a nested Y.Map and the
 * sheet code reads and writes those maps directly (`ops.ts`), one key per cell,
 * so concurrent edits still merge per cell, last write wins, like Google Sheets.
 */
import { BlockModel, BlockSchemaExtension, defineBlockSchema } from '@blocksuite/store';
import { GfxCompatible, type GfxCommonBlockProps } from '@blocksuite/std/gfx';

export interface SheetProps extends GfxCommonBlockProps {
  title: string;
  tabs: Record<string, unknown>;
  columns: Record<string, unknown>;
  rows: Record<string, unknown>;
  cells: Record<string, unknown>;
}

/** The canvas card: a clean-document width, a preview's height. `board/metrics.ts`. */
export { SHEET_W, SHEET_H } from '../board/metrics';
import { SHEET_W, SHEET_H } from '../board/metrics';

export const SheetBlockSchema = defineBlockSchema({
  flavour: 'voidspace:sheet',
  props: (): SheetProps => ({
    title: 'Untitled sheet',
    tabs: {},
    columns: {},
    rows: {},
    cells: {},
    xywh: `[0,0,${SHEET_W},${SHEET_H}]`,
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
  toModel: () => new SheetBlockModel(),
});

export class SheetBlockModel extends GfxCompatible<SheetProps>(BlockModel) {}

export const SheetBlockSchemaExtension = BlockSchemaExtension(SheetBlockSchema);
