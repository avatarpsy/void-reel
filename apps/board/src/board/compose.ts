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
/** Body text inside a note, for estimating how tall a card will be. */
const CARD_FONT = 16;
/**
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
const CARD_PAD = 60;
/** Effective advance of a character in note body text, as a fraction of size. */
const CARD_GLYPH_EM = 0.72;
/** A `# heading` line is set larger than the body it sits above. */
const HEADING_LINES = 1.7;
/** Each source line is its own block, and blocks carry a margin. */
const BLOCK_MARGIN = 15;
/** Line height, matching the one `measureLabel` uses for labels. */
const LINE_EM = 1.35;

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

/** Roughly how tall a card of this text will be once AFFiNE has grown it. */
export function cardHeight(text: string, width = CARD_W): number {
  const perLine = Math.max(8, Math.floor((width - 48) / (CARD_FONT * CARD_GLYPH_EM)));
  let lines = 0;
  let blocks = 0;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    blocks++;
    const heading = line.startsWith('#');
    const body = heading ? line.replace(/^#+\s*/, '') : line;
    const wrapped = Math.max(1, Math.ceil(body.length / perLine));
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

  let y = originY + titleBox.h + 40;

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
    y += cardHeight(req.subtitle) + 90;
  }

  // ── Sections ──────────────────────────────────────────────────────────────
  sections.forEach((section, si) => {
    const cards = section.cards ?? [];
    // Per SECTION, not per page: a four-card section beside a six-card one
    // should not inherit an orphan row from it.
    const cols = columnsFor(cards.length, columns);
    const refs: Array<{ ref: string }> = [];
    let rowTop = y;
    let rowTallest = 0;

    cards.forEach((card, ci) => {
      const col = ci % cols;
      if (col === 0 && ci > 0) {
        rowTop += rowTallest + 40;
        rowTallest = 0;
      }
      const ref = `c${si}-${ci}`;
      const useAccent = !!card.accent && spent < budget;
      if (useAccent) spent++;

      elements.push({
        kind: 'note',
        text: card.text,
        x: originX + col * (CARD_W + GUTTER),
        y: rowTop,
        w: CARD_W,
        ...(useAccent ? { color: accent } : {}),
        ref,
      });
      refs.push({ ref });
      rowTallest = Math.max(rowTallest, cardHeight(card.text));
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
      });
    }

    y = rowTop + rowTallest + SECTION_GAP + FRAME_CHROME;
  });

  return { elements, notes };
}
