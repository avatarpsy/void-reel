/**
 * HOW BIG A CARD IS. One module, because there were four answers.
 *
 * ── THE BUG THIS EXISTS TO CLOSE ─────────────────────────────────────────────
 * Media reached the canvas down three paths that each decided its own size, and
 * a fourth drew the placeholder that stood in for it:
 *
 *   image      `addImages(…, { maxWidth: 960 })`     → min(natural, 960) × aspect
 *   clip/track `resize(…, 360, 360 * 9/16)`          → 360 × ≤420
 *   spinner    `CARD_W/CARD_H`                       → 300 × 400
 *   shot card  `SHOT_W`/`SHOT_H`                     → 640 × 1020
 *
 * `addImages` caps WIDTH only — `width = min(width, maxWidth); height = width *
 * ratio` — so nothing bounded an image's height. And every library image now
 * arrives as a `w=1024` proxy variant (`agent-tools/media-display-url.ts`), so
 * in practice every image the agent placed was exactly 960 wide:
 *
 *   16:9 → 960 × 540      1:1 → 960 × 960      9:16 → 960 × 1707
 *
 * That last one is the reported bug. Against the things it sits beside it is
 * 2.5× the AREA of the shot card it is a reference FOR, 10.8× the clip placed by
 * the same call in the same batch, and 13.6× the spinner it replaces — so the
 * card visibly detonated when a generation landed. A reference is semantically
 * subordinate to a shot and was drawn two and a half times larger than one.
 *
 * ── WHY 360 AND NOT A NEW NUMBER ─────────────────────────────────────────────
 * 360 × 420 is the CLIP path's existing pair, and it was not picked casually:
 * 360 is the width at which a media card's play badge is big enough to hit and
 * its name strip is big enough to read (measured against the card's own CSS in
 * `media-block.ts`), and 420 is the height at which a 9:16 clip reads as a
 * phone-shaped card rather than a wall. Adopting those as the shared box makes
 * the IMAGE path the entire diff and risks nothing that already ships.
 *
 * ── AND WHY A BYTE BUDGET IS NOT A BOX ───────────────────────────────────────
 * `MAX_CANVAS_IMAGE_WIDTH` (960) stays in `asset-media.ts`, but only as the
 * DOWNLOAD hint — the most detail worth fetching for a card someone may open or
 * zoom. Conflating "how much to fetch" with "how big to draw" is exactly how the
 * box got to 960 in the first place, so the two are now separate by
 * construction.
 */
export interface Size {
  w: number;
  h: number;
}

/**
 * A REFERENCE — the default, and what nearly everything is.
 *
 * Smaller than a shot card in both dimensions, always, because that is the
 * semantic truth: a reference is a thing a shot points at.
 */
export const REF_W = 360;
export const REF_MAX_H = 420;

/**
 * A HERO — one result, on its own, that the user is judging.
 *
 * Exactly one shot card wide, and capped below a shot card's height, so a
 * generated picture reads as a big picture BESIDE the storyboard rather than as
 * something that has escaped it. Chosen explicitly; never a default.
 */
export const HERO_W = 640;
export const HERO_MAX_H = 840;

/** Between cards. `SHOT_GAP` is 56 and is deliberately the same number, so a row
 *  of references lines up with the pitch of the filmstrip above it. */
export const CARD_GAP = 56;

/**
 * The shape to assume before the real one is known.
 *
 * A clip's dimensions are read over the network AFTER the card exists (see
 * `probeVideo`), so for up to six seconds the card is whatever this says. 16:9
 * is the safe guess: guessing portrait and being wrong leaves a tall slab, and
 * guessing landscape and being wrong leaves a short card that then grows.
 */
export const DEFAULT_RATIO = 9 / 16;

export type CardSize = 'ref' | 'hero';

const BOX: Record<CardSize, { w: number; maxH: number }> = {
  ref: { w: REF_W, maxH: REF_MAX_H },
  hero: { w: HERO_W, maxH: HERO_MAX_H },
};

/**
 * CONTAIN, never stretch and never squash.
 *
 * Fill the box's width, and if the aspect then makes it taller than the cap,
 * take the cap and narrow instead. The result always has the media's own aspect
 * to within a pixel of rounding — which matters, because a box that does not
 * match its contents is the other half of the "why is my video squashed" report
 * (`media-block.ts` draws the picture at the block's own box, so the box IS the
 * crop).
 *
 * `natural` may be null: nothing has read the file yet, and `DEFAULT_RATIO` is
 * the honest stand-in.
 */
export function fit(natural: Size | null | undefined, size: CardSize = 'ref'): Size {
  const { w: boxW, maxH } = BOX[size];
  const ratio = natural && natural.w > 0 && natural.h > 0
    ? natural.h / natural.w
    : DEFAULT_RATIO;

  let w = boxW;
  let h = Math.round(boxW * ratio);
  if (h > maxH) {
    h = maxH;
    w = Math.round(maxH / ratio);
  }
  return { w, h: Math.max(1, h) };
}

/**
 * A TRACK has no picture, so it has no aspect to honour.
 *
 * It is a name, a waveform and a play button, and it gets the landscape box the
 * default ratio describes — which is what the clip path has always given it.
 * Separate from `fit` so nobody is tempted to feed a song's "dimensions" in.
 */
export function audioBox(size: CardSize = 'ref'): Size {
  const { w } = BOX[size];
  return { w, h: Math.round(w * DEFAULT_RATIO) };
}

/** The box a card of this kind should occupy. The one door: every write path
 *  calls this, so a size cannot be decided in four places again. */
export function cardBox(
  kind: 'image' | 'video' | 'audio',
  natural?: Size | null,
  size: CardSize = 'ref',
): Size {
  return kind === 'audio' ? audioBox(size) : fit(natural, size);
}

/** Is this box bigger than a shot card? The signal `canvasDigest` reports as
 *  `oversize`, so the agent can notice its own mess rather than being the last
 *  to know. Kept here because the threshold is a size decision. */
export function isOversize(box: Size, shotW: number, shotH: number): boolean {
  return box.w > shotW || box.h > shotH;
}
