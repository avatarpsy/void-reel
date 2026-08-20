/**
 * What a shot actually puts into its block.
 *
 * ONE RESOLVER, because everything downstream has to agree: the live preview on
 * the card, the wells the user drops onto, the warnings, and what compile
 * finally writes. When those disagree you get the worst kind of bug — the card
 * shows one thing and the render produces another, and nobody can tell which
 * one lied.
 *
 * THE MODEL, in one paragraph. A block declares its own slots — `browser-mockup`
 * wants a `screenshot`, a `url`, a `headline` and four colours; `stat-card`
 * wants a `stat` and a `caption`. Media slots are filled by DROPPING a
 * reference on the shot and tagging it with that slot's name, which is the same
 * gesture as tagging a clip's first frame — a graphic's slot key simply IS its
 * media role. Text and colour slots are filled by TYPING, and live in
 * `compositionVars`. So a shot has two inputs and the block has one list, and
 * this is where the two are married.
 */
import { findBlock, mediaSlots, valueSlots, type BlockInfo, type BlockSlot } from './blocks';
import type { ShotMedia } from './model';

/** One slot, with whatever the shot currently has for it. */
export interface ResolvedSlot {
  slot: BlockSlot;
  /** The media filling it, for image/video slots. */
  media?: ShotMedia;
  /** The typed value, for text/colour slots. */
  value?: string;
  /** True when the shot has given this slot nothing and the block will fall
   *  back to whatever its designer left in it. */
  empty: boolean;
}

export interface ShotSlotView {
  block: BlockInfo | null;
  media: ResolvedSlot[];
  values: ResolvedSlot[];
  /** Every slot, in the block's own declared order. */
  all: ResolvedSlot[];
  filled: number;
  total: number;
}

interface SlotShot {
  composition?: string;
  compositionVars?: Record<string, string>;
  media?: ShotMedia[];
}

/**
 * Marry a shot to its block.
 *
 * A shot whose block is not installed, or which has no block yet, resolves to
 * an empty view rather than throwing — the card still has to render, and
 * "nothing is known about this block" is a real state a board reaches when it
 * was made on another machine.
 */
export function resolveSlots(shot: SlotShot): ShotSlotView {
  const block = findBlock(shot.composition ?? '');
  const vars = shot.compositionVars ?? {};
  const held = shot.media ?? [];

  const media: ResolvedSlot[] = mediaSlots(block).map(slot => {
    // A GRAPHIC'S SLOT KEY IS ITS MEDIA ROLE. That is the whole trick: it means
    // dropping a picture on a `screenshot` well and tagging a reference as
    // `screenshot` are the same operation, and the clip path's role machinery —
    // exclusivity, the inspector's dropdown, compile — all work unchanged.
    const hit = held.find(m => m.role === slot.key);
    return { slot, media: hit, empty: !hit };
  });

  const values: ResolvedSlot[] = valueSlots(block).map(slot => {
    const v = (vars[slot.key] ?? '').trim();
    return { slot, value: v || undefined, empty: !v };
  });

  const all = (block?.slots ?? []).map(slot =>
    media.find(m => m.slot.key === slot.key) ?? values.find(v => v.slot.key === slot.key)!,
  ).filter(Boolean);

  return {
    block,
    media,
    values,
    all,
    filled: all.filter(s => !s.empty).length,
    total: all.length,
  };
}

/**
 * A GRAPHIC LAYER'S SLOTS, resolved from ONE flat map.
 *
 * ── WHY A LAYER FILLS ITS SLOTS DIFFERENTLY FROM THE BED ─────────────────────
 * The shot's own graphic fills media slots by ROLE: you drop a picture on the
 * card, it becomes a `ShotMedia` with `role: 'screenshot'`, and `resolveSlots`
 * marries the two. That works because a shot has exactly one composition, so a
 * role can name a slot without ambiguity.
 *
 * A shot can have SEVERAL layers, and two of them can be built from the same
 * block. `role: 'logo'` would then name two different holes, and there would be
 * no way to say which. So a layer holds its media url directly, keyed by slot —
 * one map for pictures and words alike, which is also exactly the shape the
 * render route's `slots` parameter takes.
 *
 * The return shape is the same `ShotSlotView` the bed produces, so the card
 * draws one kind of well and one kind of field either way.
 */
export function resolveLayerSlots(
  blockName: string,
  values: Record<string, string> | undefined,
): ShotSlotView {
  const block = findBlock(blockName ?? '');
  const vals = values ?? {};

  const media: ResolvedSlot[] = mediaSlots(block).map(slot => {
    const url = (vals[slot.key] ?? '').trim();
    return { slot, value: url || undefined, empty: !url };
  });
  const valueRows: ResolvedSlot[] = valueSlots(block).map(slot => {
    const v = (vals[slot.key] ?? '').trim();
    return { slot, value: v || undefined, empty: !v };
  });

  const all = (block?.slots ?? []).map(slot =>
    media.find(m => m.slot.key === slot.key) ?? valueRows.find(v => v.slot.key === slot.key)!,
  ).filter(Boolean);

  return {
    block,
    media,
    values: valueRows,
    all,
    filled: all.filter(s => !s.empty).length,
    total: all.length,
  };
}

/**
 * A layer's fills, ready for the preview and for the render route.
 *
 * The flat-map twin of `slotFills`. Same output shape, so the preview shim and
 * the render both take one kind of thing however the values were gathered.
 */
export function layerFills(
  blockName: string,
  values: Record<string, string> | undefined,
): SlotFillInput[] {
  const view = resolveLayerSlots(blockName, values);
  const out: SlotFillInput[] = [];
  for (const r of view.all) {
    if (!r.value) continue;
    out.push({
      key: r.slot.key,
      kind: r.slot.kind as SlotFillInput['kind'],
      value: r.value,
      sel: r.slot.sel,
      cssVar: r.slot.cssVar,
    });
  }
  return out;
}

/** One resolved slot, in the shape the renderer patches with. */
export interface SlotFillInput {
  key: string;
  kind: 'text' | 'image' | 'video' | 'color';
  value: string;
  sel?: string;
  cssVar?: string;
}

/**
 * What to hand the preview — and, with a different url resolver, what compile
 * writes. Empty slots are OMITTED rather than sent as '': a blank value would
 * blank the designer's placeholder, and an empty frame teaches the user less
 * about the block than the sample does.
 */
export function slotFills(
  shot: SlotShot,
  urlFor: (m: ShotMedia) => string = m => m.url || m.src,
): SlotFillInput[] {
  const view = resolveSlots(shot);
  const out: SlotFillInput[] = [];

  for (const r of view.media) {
    if (!r.media) continue;
    const url = urlFor(r.media);
    if (!url) continue;
    out.push({
      key: r.slot.key,
      kind: r.slot.kind as 'image' | 'video',
      value: url,
      sel: r.slot.sel,
      cssVar: r.slot.cssVar,
    });
  }
  for (const r of view.values) {
    if (!r.value) continue;
    out.push({
      key: r.slot.key,
      kind: r.slot.kind as 'text' | 'color',
      value: r.value,
      sel: r.slot.sel,
      cssVar: r.slot.cssVar,
    });
  }
  return out;
}
