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
 * What a column costs BEYOND the width it is given.
 *
 * BlockSuite draws each cell 4px wider than its column's `width` and the
 * table 8px wider than its columns — borders, and they are outside the
 * number. Spending the whole content width on the widths themselves
 * therefore overflowed the page and CLIPPED the last column, which is worse
 * than the default it replaced.
 *
 * Measured rather than derived: asking 100, 150 and 200 per column on a
 * three-column table gave tables of 320, 470 and 620 — a constant 20 over,
 * every time.
 */
const COLUMN_BORDER = 4;
const TABLE_BORDER = 8;

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

  const content = contentWidth(note, noteId);
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
    // What is left for the widths once the borders have been paid for.
    const budget = Math.max(
      ids.length * 48,
      content - ids.length * COLUMN_BORDER - TABLE_BORDER,
    );
    try {
      board.store.updateBlock(table, () => {
        ids.forEach((id, c) => {
          table.props.columns[id].width = Math.max(48, Math.round((budget * w[c]!) / total));
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
 * The same, once there is something to measure.
 *
 * A note is inserted before it is laid out, so a synchronous call finds no
 * element and falls back to the page margin — which is the number that made
 * the table overflow in the first place. This waits for the paragraph that
 * gives the text column its width, and gives up after a handful of frames
 * rather than spinning: a table sized from the fallback is slightly wide, a
 * loop that never ends is a hung tab.
 */
export function applyTableWidthsWhenReady(
  board: any,
  noteId: string,
  weights: Array<number[] | null>,
  frames = 20,
): void {
  if (!weights.some(Boolean)) return;
  const tick = (left: number) => {
    const el = typeof document !== 'undefined'
      ? document.querySelector(`affine-edgeless-note[data-block-id="${noteId}"]`)
      : null;
    const ready = !!el?.querySelector('.affine-paragraph-rich-text-wrapper');
    if (ready || left <= 0) {
      applyTableWidths(board, noteId, weights);
      return;
    }
    requestAnimationFrame(() => tick(left - 1));
  };
  tick(frames);
}

/**
 * The room a table has, in the note's own layout units.
 *
 * MEASURED off a paragraph, not computed from the page margin. The margin in
 * `document-view.css` is 64px a side, which gives 672 on an 800-wide note —
 * but the text column is 624, because BlockSuite insets the rich text inside
 * the block as well. A table built to 672 aligned with the block and ran 47px
 * past the words beside it, clipping its last column against the edge of the
 * page. In the PDF the table spans the TEXT width, so it must here too.
 *
 * The ratio of two screen measurements cancels the canvas zoom, so nothing
 * here has to know what the viewport is doing. If the note has not been laid
 * out yet there is nothing to measure and the page margin is the fallback,
 * which is close and never clips by much.
 */
function contentWidth(note: any, noteId: string): number {
  const xywh = String(note?.props?.xywh ?? '');
  const parts = xywh.replace(/[[\]]/g, '').split(',').map((n) => Number(n.trim()));
  const width = Number.isFinite(parts[2]) && parts[2]! > 0 ? parts[2]! : 752;

  const el = typeof document !== 'undefined'
    ? document.querySelector(`affine-edgeless-note[data-block-id="${noteId}"]`)
    : null;
  const text = el?.querySelector('.affine-paragraph-rich-text-wrapper');
  const noteBox = el?.getBoundingClientRect().width ?? 0;
  const textBox = text?.getBoundingClientRect().width ?? 0;
  if (noteBox > 0 && textBox > 0) {
    return Math.max(160, Math.round(width * (textBox / noteBox)));
  }
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
