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
/** Clear space under a section before the next one's title bar. */
export const SECTION_GAP = 190;
/** A frame's title bar is drawn ABOVE its box; `fitFramesToMembers` pads for it. */
const FRAME_CHROME = 104;
/** Body text inside a note, for estimating how tall a card will be. */
const CARD_FONT = 16;
const CARD_PAD = 48;

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

/** Roughly how tall a card of this text will be once AFFiNE has grown it. */
function cardHeight(text: string): number {
  const m = measureLabel(text, CARD_FONT, CARD_W - 32);
  return Math.max(96, m.h + CARD_PAD);
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
    const refs: Array<{ ref: string }> = [];
    let rowTop = y;
    let rowTallest = 0;

    cards.forEach((card, ci) => {
      const col = ci % columns;
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
