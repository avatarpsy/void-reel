/**
 * COMPOSED REGIONS — a designed page, from content alone.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `board_draw` is a drawing primitive: it takes coordinates and draws what it
 * is told. That is the right shape for a diagram, and the wrong shape for a
 * brainstorm, because it puts every layout decision in the hands of the caller
 * — and the caller is a language model choosing numbers.
 *
 * Measured, on a real board: seventeen cards at four different widths, fourteen
 * of them coloured, seven frames that wrapped nothing, and a title in a box a
 * third the size of its own text. Every one of those is a decision that has one
 * right answer and no reason to be made per call. The user's verdict was "this
 * is ugly, old, looks so bad", and they were right.
 *
 * So this takes CONTENT — a title, sections, cards — and owns the geometry: one
 * grid, one pitch, one type scale, frames that fit, and a hard cap on how much
 * colour may be spent. The caller cannot produce a misaligned board through
 * this door, because it is never asked for a coordinate.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 * Diagrams. A flow with arrows, a mind map, a timeline with meaning in its x
 * axis — those have a shape the content cannot imply, and `board_draw` stays
 * the tool for them. This is for the thing people actually ask for most: a
 * structured page of thinking, laid out well.
 */
import type { ElementSpec } from './canvas';
import { measureLabel } from './canvas';

/** One card. `accent` asks for the board's single emphasis colour. */
export interface ComposeCard {
  text: string;
  accent?: boolean;
}

export interface ComposeSection {
  title: string;
  cards: ComposeCard[];
  /**
   * HOW THIS SECTION'S CARDS RELATE TO EACH OTHER.
   *
   *   grid      (default) an unordered SET. Wraps into columns, and the count
   *             is chosen to fill the last row.
   *   sequence  an ordered RUN — beats of an episode, steps of a process,
   *             stages of a funnel. One row, left to right, never wrapped,
   *             and numbered, because in a sequence the order is information
   *             and in a grid it is an accident of typing.
   *
   * This is the whole of what makes a board hold a long-running series: a
   * season is sections stacked down the page and an episode is one run across
   * it, which is also a funnel, a timeline or a checklist. Nothing here knows
   * the word "episode", and it should not.
   */
  layout?: 'grid' | 'sequence';
}

export interface ComposeRequest {
  title: string;
  /** One line under the title. Optional, and usually worth having. */
  subtitle?: string;
  sections: ComposeSection[];
  /** 2-4. Three is right for almost everything. */
  columns?: number;
  /** The one colour this board spends on emphasis. */
  accent?: string;
  /** Where the region starts. Omitted, the caller places it. */
  x?: number;
  y?: number;
}

export interface ComposePlan {
  elements: ElementSpec[];
  notes: string[];
  /**
   * The page's STRUCTURE, by `ref`: which cards share a row, which rows make a
   * section, and which frame wraps it. The coordinates in `elements` are only a
   * first guess — a note's real height exists after AFFiNE renders it — and
   * this is what lets `reflowComposed` re-stack the page from measured boxes.
   */
  layout: ComposeLayout;
}

export interface ComposeLayout {
  title: string;
  subtitle?: string;
  sections: Array<{ frame: string; rows: string[][] }>;
}

// ── The grid. One pitch, everywhere. ─────────────────────────────────────────

/** A card is 400 wide because a sentence at ~16px wants 45-75 characters. */
export const CARD_W = 400;
/** Gutter between columns. */
export const GUTTER = 70;
/**
 * Clear space under a section before the next one's title bar.
 *
 * FRAME_CHROME is added on top of this, so the real gap between the last card
 * of one section and the first of the next is the sum. At 190 that came to 265
 * measured on a live board — a screen of nothing between every section.
 */
export const SECTION_GAP = 76;
/** A frame's title bar is drawn ABOVE its box; `fitFramesToMembers` pads for it. */
const FRAME_CHROME = 104;
/** Clear space between the header (title, or subtitle) and the first frame. */
const HEADER_GAP = 40;
/** Clear space between two rows of cards inside one section. */
const ROW_GAP = 40;
/** Body text inside a note, for estimating how tall a card will be. */
const CARD_FONT = 16;
/**
 * ONLY A FIRST GUESS. `reflowComposed` re-stacks the page from the heights
 * AFFiNE really gave the cards, so this decides the initial placement and
 * nothing that survives it.
 *
 * CALIBRATED AGAINST REAL CARDS, because the first guess overlapped.
 *
 * Measured on a live board, cards at w=400:
 *
 *   "SEVEN" (heading + 135 chars)        predicted 135   actual 194
 *   "The one rule" (heading + 2 shorts)  predicted 135   actual 180
 *   "Why one building" (165 chars)       predicted 135   actual 164
 *
 * Under by up to 31%, and under is what put a card 19px on top of the one
 * above it — the exact defect this whole pass exists to remove.
 *
 * RE-MEASURED 2026-10-05 on the current theme, which pads notes far more: a
 * one-word card is 201 tall, and narrow sequence cards are where it hurts —
 *
 *   w=248  heading + 117 chars           old estimate ~390   actual 637
 *   w=203  same text                                          actual 928
 *   w=400  "short"                                            actual 201
 *   w=400  70 chars, one line                                 actual 248
 *
 * so the vertical chrome, line height and glyph width below are fitted to
 * those, and the text is wrapped at word boundaries inside the 80px insets.
 *
 * Three things the first estimate missed, all visible in those numbers:
 *   • a note's inner width is much narrower than the box, so ~30 characters
 *     fit on a 400px line and not the ~41 a title-tuned measure predicts;
 *   • a "# heading" line is set larger, so it costs about 1.7 lines;
 *   • every source line is its own BLOCK with a margin, so three short lines
 *     are taller than one line of the same total length.
 *
 * Every constant here is deliberately rounded UP. Over-estimating costs
 * whitespace, which the frame then absorbs; under-estimating costs a
 * collision.
 */
const CARD_PAD = 195;
/**
 * A NOTE'S TEXT IS INSET ~80px EACH SIDE, which is nothing at w=400 and most of
 * the card at w=248. Measured on a composed page: a 248-wide sequence card with
 * ~140 characters wrapped at 9-11 characters a line and grew to 629px, against
 * an estimate of ~390 from a formula that assumed a 48px total inset.
 */
const NOTE_INSET = 80;
/** Effective advance of a character in note body text, as a fraction of size. */
const CARD_GLYPH_EM = 0.6;
/** A heading's glyphs are wider by about this much, so fewer fit a line. */
const HEADING_SCALE = 1.3;
/** A `# heading` line is set larger than the body it sits above. */
const HEADING_LINES = 1.7;
/** Each source line is its own block, and blocks carry a margin. */
const BLOCK_MARGIN = 6;
/** Line height of note body text, fitted to the 2026-10-05 measurements. */
const LINE_EM = 1.5;

const TITLE_SIZE = 56;

/**
 * HOW MUCH COLOUR A BOARD MAY SPEND.
 *
 * Past about a third, no card is emphasised because they all are — this is the
 * "bag of sweets" a real board turned into. Enforced rather than advised,
 * because advice did not work: the guidance already said "uncoloured is fine
 * and usually better" and the board that prompted this had 14 of 17 coloured.
 */
export const ACCENT_MAX_RATIO = 1 / 3;

/**
 * HOW MANY COLUMNS THIS SECTION SHOULD ACTUALLY USE.
 *
 * Four cards in three columns leaves a row of one and two empty slots beside
 * it — half a screen of nothing, which is what the first composed board looked
 * like. The same four in two columns is a filled 2x2 block.
 *
 * So the requested count is a CEILING, not an instruction: pick whatever fills
 * the last row best, and keep the request on a tie so an even grid is never
 * broken for no reason. A section is allowed to be narrower than the one above
 * it — a filled block reads as deliberate, an orphan row reads as a mistake.
 */
export function columnsFor(count: number, requested: number): number {
  if (count <= 1) return Math.max(2, requested);
  let best = requested;
  let bestFill = -1;
  // Widest first, so the request wins ties and wider layouts beat narrower ones
  // at equal fill.
  for (let c = Math.min(requested, count); c >= 2; c--) {
    const lastRow = count % c === 0 ? c : count % c;
    const fill = lastRow / c;
    if (fill > bestFill + 1e-9) { bestFill = fill; best = c; }
  }
  return best;
}

/** Gutter inside a sequence run — tighter than between grid columns, because
 *  a run reads as one object and a grid reads as separate ones. */
const SEQ_GUTTER = 24;
/** Below this a beat card stops being readable, so a long run overflows the
 *  page width rather than shrinking into unreadable slivers. */
const SEQ_MIN_W = 220;

/**
 * A sequence spans the SAME width as the page grid, divided evenly.
 *
 * That is what keeps a board with runs and grids on it looking like one
 * document: every section starts on the same left edge and ends on the same
 * right edge, whatever it holds. Five beats across a three-column page is five
 * cards of 249, not five of 400 spilling 900px past everything else.
 */
export function sequenceWidth(count: number, pageColumns: number): number {
  const pageW = pageColumns * CARD_W + (pageColumns - 1) * GUTTER;
  const n = Math.max(1, count);
  return Math.max(SEQ_MIN_W, Math.floor((pageW - (n - 1) * SEQ_GUTTER) / n));
}

/**
 * Number a card in a run.
 *
 * Order is real information in a sequence, so saying it is honest — the same
 * reason a grid is NOT numbered, where order is an accident of typing. Folded
 * into the card's own heading rather than drawn as a separate element, so a
 * run is still one card per beat and not two.
 */
export function numberCard(text: string, n: number): string {
  const body = String(text ?? '');
  const nl = body.indexOf('\n');
  const first = nl === -1 ? body : body.slice(0, nl);
  const rest = nl === -1 ? '' : body.slice(nl);
  const heading = first.match(/^(#+)\s*(.*)$/);
  return heading
    ? `${heading[1]} ${n} · ${heading[2]}${rest}`
    : `**${n}** ${body}`;
}

/**
 * Lines a paragraph takes when wrapped at WORD boundaries.
 *
 * Dividing characters by line width assumes every line is filled to the last
 * column. At 9-11 characters a line a single word routinely leaves a third of
 * a line empty, which is where most of a narrow card's height comes from.
 */
function wrappedLines(body: string, perLine: number): number {
  let lines = 1;
  let used = 0;
  for (const word of body.split(/\s+/).filter(Boolean)) {
    let len = word.length;
    if (used > 0 && used + 1 + len <= perLine) { used += 1 + len; continue; }
    if (used > 0) lines++;
    // A word longer than the line breaks mid-word.
    while (len > perLine) { lines++; len -= perLine; }
    used = len;
  }
  return lines;
}

/** Roughly how tall a card of this text will be once AFFiNE has grown it. */
export function cardHeight(text: string, width = CARD_W): number {
  const inner = Math.max(48, width - 2 * NOTE_INSET);
  const perLine = Math.max(4, Math.floor(inner / (CARD_FONT * CARD_GLYPH_EM)));
  let lines = 0;
  let blocks = 0;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    blocks++;
    const heading = line.startsWith('#');
    // Markdown emphasis marks are not drawn, so they take no width.
    const body = (heading ? line.replace(/^#+\s*/, '') : line).replace(/\*\*|[*`]/g, '');
    const wrapped = heading
      ? wrappedLines(body, Math.max(3, Math.floor(perLine / HEADING_SCALE)))
      : wrappedLines(body, perLine);
    lines += heading ? wrapped * HEADING_LINES : wrapped;
  }
  const text_h = Math.ceil(lines * CARD_FONT * LINE_EM) + blocks * BLOCK_MARGIN;
  return Math.max(96, text_h + CARD_PAD);
}

/**
 * Turn content into a laid-out region.
 *
 * Returns SPECS rather than drawing, so the whole page is still one
 * `drawOnCanvas` call — one transaction, one Ctrl+Z — and so this is testable
 * without a document.
 */
export function composeRegion(req: ComposeRequest): ComposePlan {
  const notes: string[] = [];
  const columns = Math.min(4, Math.max(2, Math.round(req.columns ?? 3)));
  const originX = req.x ?? 0;
  const originY = req.y ?? 0;
  const accent = req.accent || 'orange';

  const sections = (req.sections ?? []).filter(s => s && (s.cards?.length || s.title));

  /**
   * THE ACCENT BUDGET, spent on the FIRST cards that asked for it.
   *
   * Earlier asks win rather than "best" ones, because there is no way to rank
   * them and a stable rule is one the caller can reason about: put the card
   * that matters first.
   */
  const asked = sections.reduce(
    (n, s) => n + (s.cards ?? []).filter(c => c.accent).length, 0,
  );
  const total = sections.reduce((n, s) => n + (s.cards ?? []).length, 0);
  const budget = Math.max(1, Math.floor(total * ACCENT_MAX_RATIO));
  if (asked > budget) {
    notes.push(
      `${asked} of ${total} cards asked for the accent; ${budget} kept. Past a third, colour `
      + 'stops meaning anything — the rest are drawn plain.',
    );
  }
  let spent = 0;

  const elements: ElementSpec[] = [];

  // ── Title band ────────────────────────────────────────────────────────────
  const titleBox = measureLabel(req.title || 'Untitled', TITLE_SIZE);
  elements.push({
    kind: 'text',
    text: req.title || 'Untitled',
    fontSize: TITLE_SIZE,
    x: originX,
    y: originY,
    ref: 'compose-title',
  });

  /** Top of whatever comes next — a FRAME's top, title bar included. */
  let y = originY + titleBox.h + HEADER_GAP;

  if (req.subtitle?.trim()) {
    const gridW = columns * CARD_W + (columns - 1) * GUTTER;
    elements.push({
      kind: 'note',
      text: req.subtitle.trim(),
      x: originX,
      y,
      // Full grid width: a lead line that stops at one column reads as a card.
      w: Math.min(gridW, CARD_W * 2 + GUTTER),
      ref: 'compose-sub',
    });
    y += cardHeight(req.subtitle, Math.min(gridW, CARD_W * 2 + GUTTER)) + HEADER_GAP;
  }

  const layout: ComposeLayout = {
    title: 'compose-title',
    ...(req.subtitle?.trim() ? { subtitle: 'compose-sub' } : {}),
    sections: [],
  };

  // ── Sections ──────────────────────────────────────────────────────────────
  sections.forEach((section, si) => {
    const cards = section.cards ?? [];
    // Per SECTION, not per page: a four-card section beside a six-card one
    // should not inherit an orphan row from it.
    // A RUN never wraps: its order is the point, and a beat that falls onto a
    // second line stops being the fourth beat and becomes the first of a new
    // row. A SET wraps and picks the count that fills.
    const run = section.layout === 'sequence';
    const cols = run ? Math.max(1, cards.length) : columnsFor(cards.length, columns);
    const cardW = run ? sequenceWidth(cards.length, columns) : CARD_W;
    const gutter = run ? SEQ_GUTTER : GUTTER;

    const refs: Array<{ ref: string }> = [];
    const rows: string[][] = [];
    // The frame's title bar is drawn ABOVE its box, so the cards start a title
    // bar's height below where the frame does. Without this the first frame
    // sat on top of the page title.
    let rowTop = y + FRAME_CHROME;
    let rowTallest = 0;

    cards.forEach((card, ci) => {
      const col = ci % cols;
      if (col === 0 && ci > 0) {
        rowTop += rowTallest + ROW_GAP;
        rowTallest = 0;
      }
      if (col === 0) rows.push([]);
      const ref = `c${si}-${ci}`;
      const useAccent = !!card.accent && spent < budget;
      if (useAccent) spent++;
      const text = run ? numberCard(card.text, ci + 1) : card.text;

      elements.push({
        kind: 'note',
        text,
        x: originX + col * (cardW + gutter),
        y: rowTop,
        w: cardW,
        ...(useAccent ? { color: accent } : {}),
        ref,
      });
      refs.push({ ref });
      rows[rows.length - 1].push(ref);
      rowTallest = Math.max(rowTallest, cardHeight(text, cardW));
    });

    /**
     * NO BOX ON THE FRAME. `fitFramesToMembers` wraps it around these cards
     * once they have really sized — which is the only moment their bounds
     * exist, and the reason a frame given coordinates here would be wrong.
     */
    if (refs.length) {
      elements.push({
        kind: 'frame',
        title: section.title || `Section ${si + 1}`,
        contains: refs,
        ref: `f${si}`,
      });
      layout.sections.push({ frame: `f${si}`, rows });
    }

    y = rowTop + rowTallest + SECTION_GAP;
  });

  return { elements, notes, layout };
}

export interface ComposeBox { x: number; y: number; w: number; h: number }

/**
 * ── RE-STACK A COMPOSED PAGE FROM THE SIZES IT REALLY CAME OUT AT ────────────
 *
 * THE FAILURE THIS FIXES, measured on a live board: 35 overlapping pairs on one
 * composed page. Every card had been placed against `cardHeight`, a guess, and
 * on narrow sequence cards the guess was off by more than half (390 estimated,
 * 629 rendered). Cards overran their rows, frames — fitted to their members —
 * grew into the section below, and the page was unreadable.
 *
 * No constant fixes that, because the height is decided by the renderer. So
 * after the page is drawn and the notes have stopped growing, this walks it top
 * to bottom with the MEASURED boxes and puts every row at the previous row's
 * real bottom, and every section below the previous one's real frame:
 *
 *   header        title (left where it is), subtitle HEADER_GAP below it
 *   section       frame top = header/previous bottom + gap; cards FRAME_CHROME lower
 *   row           top = previous row's real bottom + ROW_GAP
 *   next section  previous section's last real bottom + SECTION_GAP
 *
 * The title is the anchor, so a batch translated as a whole after drawing
 * (clear of the storyboard strip) keeps that offset. Only `y` changes: columns
 * are the grid, and nothing is ever moved sideways.
 *
 * PURE. Returns the target `y` of every element that is not already there;
 * frames are not in it, because they are refitted around their members after
 * the moves (`fitFramesToMembers`).
 */
export function reflowComposed(
  layout: ComposeLayout,
  boxes: Readonly<Record<string, ComposeBox | undefined>>,
): Array<{ ref: string; y: number }> {
  const moves: Array<{ ref: string; y: number }> = [];
  const place = (ref: string, y: number) => {
    const b = boxes[ref];
    if (b && Math.abs(b.y - y) >= 0.5) moves.push({ ref, y: Math.round(y) });
  };

  const title = boxes[layout.title];
  let cursor: number | null = title ? title.y + title.h + HEADER_GAP : null;

  const sub = layout.subtitle ? boxes[layout.subtitle] : undefined;
  if (sub) {
    const top = cursor ?? sub.y;
    place(layout.subtitle!, top);
    cursor = top + sub.h + HEADER_GAP;
  }

  for (const section of layout.sections) {
    let rowTop: number | null = null;
    let bottom: number | null = null;
    for (const row of section.rows) {
      const present = row.filter(ref => boxes[ref]);
      if (!present.length) continue;
      if (rowTop === null) {
        // No header measured: the section stays where its first card already is.
        rowTop = cursor !== null
          ? cursor + FRAME_CHROME
          : Math.min(...present.map(ref => boxes[ref]!.y));
      } else {
        rowTop = bottom! + ROW_GAP;
      }
      for (const ref of present) place(ref, rowTop);
      bottom = rowTop + Math.max(...present.map(ref => boxes[ref]!.h));
    }
    if (bottom !== null) cursor = bottom + SECTION_GAP;
  }

  return moves;
}
