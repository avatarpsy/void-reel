/**
 * ══════════════════════════════════════════════════════════════════════════
 * A TABLE'S COLUMN WIDTHS, WHICH USED TO SURVIVE ONLY ONE WAY
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `<!-- columns: 3,1,1 -->` before a table gives the first column three times
 * the room — an invoice's description against its quantity and its amount, and
 * the difference between a table that reads and one that wraps every line.
 *
 * The PDF and Word writers have always honoured it. The BOARD did not, and the
 * comment is dropped by the markdown adapter on the way in, so the moment a
 * document lived on a note the widths were gone: the canvas drew BlockSuite's
 * own 2:1:1 and the export drew 1:1:1. Three different answers for one
 * document, and no error anywhere.
 *
 * ── WHY NOT ANOTHER INVISIBLE MARK ────────────────────────────────────────
 * Alignment, deliberate space and page breaks all ride on the canvas as word
 * joiners in a paragraph's text, because a paragraph has nowhere else to keep
 * them (see `align-marks.ts`). A table does — `TableColumn.width` is a real
 * prop, it reaches the renderer, and it is what BlockSuite itself writes when
 * somebody drags a column edge.
 *
 * So the widths live there. That is strictly better than a carrier: the canvas
 * SHOWS the ratio the file will use, and a column the user drags on the board
 * reaches the PDF, which a comment nobody updates never could.
 *
 * Measured before it was built: writing the three widths took a table from
 * 279/142/142 to the asked-for 3:1:1, and widened it from 571px to the full
 * content column.
 */
import { parseMarkdown } from './blocks';

/** The page margin `document-view.css` puts on the note, both sides. */
const PAGE_MARGIN = 64;

/**
 * The column weights of every table in a document, in the order they appear.
 *
 * Parsed with the document parser rather than a regex of its own, so the
 * comment has exactly one definition and a table that gains a feature does not
 * need this file to be taught about it. A table with no hint yields `null` and
 * is left alone rather than being forced to equal columns — BlockSuite's own
 * default is reasonable, and overruling it would make every table the agent
 * ever wrote look edited.
 */
export function tableWeights(markdown: string): Array<number[] | null> {
  const out: Array<number[] | null> = [];
  for (const block of parseMarkdown(String(markdown ?? ''))) {
    if (block.kind !== 'table') continue;
    const widths = block.widths;
    out.push(widths?.length ? widths.slice() : null);
  }
  return out;
}

/**
 * Give each table in the note the widths its document asked for.
 *
 * Runs once, when a document is placed. Returns how many tables it sized, for
 * the caller's log.
 */
export function applyTableWidths(
  board: any,
  noteId: string,
  weights: Array<number[] | null>,
): number {
  if (!weights.some(Boolean)) return 0;
  const note = board?.store?.getBlock?.(noteId)?.model;
  const tables = (note?.children ?? []).filter((c: any) => c?.flavour === 'affine:table');
  if (!tables.length) return 0;

  const content = contentWidth(note);
  let sized = 0;
  tables.forEach((table: any, i: number) => {
    const asked = weights[i];
    if (!asked?.length) return;
    const ids = Object.keys(table.props?.columns ?? {});
    if (!ids.length) return;
    /**
     * A short `widths` is padded with 1s and a long one is ignored past the
     * last column — the same rule `pdf.ts` uses, so `columns: 3` on a
     * three-column table means "first one wide" on the board too.
     */
    const w = ids.map((_, c) => {
      const n = Number(asked[c]);
      return Number.isFinite(n) && n > 0 ? n : 1;
    });
    const total = w.reduce((a, b) => a + b, 0);
    try {
      board.store.updateBlock(table, () => {
        ids.forEach((id, c) => {
          table.props.columns[id].width = Math.max(48, Math.round((content * w[c]!) / total));
        });
      });
      sized += 1;
    } catch {
      // A table that will not take a width is not a reason to lose the import.
    }
  });
  return sized;
}

/**
 * The room a table has, in the note's own layout pixels.
 *
 * Read from the model rather than the DOM on purpose: the edgeless canvas is
 * under a transform, so every `getBoundingClientRect` comes back multiplied by
 * the zoom, and a width measured at 1.14× and then stored would grow a little
 * every time a document was opened at a different zoom.
 */
function contentWidth(note: any): number {
  const xywh = String(note?.props?.xywh ?? '');
  const parts = xywh.replace(/[[\]]/g, '').split(',').map((n) => Number(n.trim()));
  const width = Number.isFinite(parts[2]) && parts[2]! > 0 ? parts[2]! : 752;
  return Math.max(160, Math.round(width - PAGE_MARGIN * 2));
}

/**
 * The widths a note's tables are actually drawn at, as relative weights.
 *
 * Normalised against the narrowest column so a `.md` the user opens says
 * `3,1,1` rather than `439,146,146`, which is the same instruction written in
 * a way nobody could edit by hand. Equal columns return `null`: they are the
 * default, and writing the comment for every table would put a line of
 * machinery above tables the author never touched.
 */
export function weightsOfNote(board: any, noteId: string): Array<number[] | null> {
  const note = board?.store?.getBlock?.(noteId)?.model;
  const tables = (note?.children ?? []).filter((c: any) => c?.flavour === 'affine:table');
  return tables.map((table: any) => {
    const widths = Object.values(table.props?.columns ?? {})
      .map((c: any) => Number(c?.width))
      .filter((n) => Number.isFinite(n) && n > 0);
    const ids = Object.keys(table.props?.columns ?? {}).length;
    // Every column must have one, or the ratio would be a guess.
    if (!ids || widths.length !== ids) return null;
    const min = Math.min(...widths);
    const weights = widths.map((w) => Math.round((w / min) * 100) / 100);
    return weights.every((w) => w === 1) ? null : weights;
  });
}

/** The line `serialise.ts` writes, so the two spell it the same way. */
export function columnsComment(weights: number[]): string {
  return `<!-- columns: ${weights.join(',')} -->`;
}

/**
 * Put each table's `columns` comment back into markdown the adapter produced.
 *
 * The adapter writes tables in document order and so does `weightsOfNote`, so
 * the Nth markdown table takes the Nth set of weights. Fenced code is skipped:
 * a line starting `|` inside a fence is not a table, and treating it as one
 * would insert a comment into somebody's code sample.
 */
export function withColumnComments(markdown: string, weights: Array<number[] | null>): string {
  if (!weights.some(Boolean)) return String(markdown ?? '');
  const lines = String(markdown ?? '').split('\n');
  const out: string[] = [];
  let fence = '';
  let table = 0;
  let inTable = false;

  for (const line of lines) {
    const open = /^[ \t]{0,3}(```|~~~)/.exec(line);
    if (fence) {
      if (open && line.trim().startsWith(fence)) fence = '';
      out.push(line);
      continue;
    }
    if (open) { fence = open[1]!; inTable = false; out.push(line); continue; }

    const isRow = /^[ \t]{0,3}\|/.test(line);
    if (isRow && !inTable) {
      inTable = true;
      const w = weights[table];
      table += 1;
      if (w?.length) out.push(columnsComment(w));
    } else if (!isRow) {
      inTable = false;
    }
    out.push(line);
  }
  return out.join('\n');
}
