/**
 * The HyperFrames block library, as the board sees it.
 *
 * RECEIVED FROM THE PARENT, like the model catalogue and for the same reason:
 * the blocks live on the user's machine under `~/Voidspace/.hyperframes/blocks`
 * and are listed by `POST /api/studio/blocks` (device-first, disk fallback).
 * The board is an iframe with no filesystem and no session; it is a consumer.
 *
 * WHAT A BLOCK IS, because it shapes everything below. Each one is a folder
 * holding `block.html` and a `block.json`:
 *
 *   name, description, category, tags[]   what it is and how it is found
 *   tier: 'user' | 'starter'              a user's own block SHADOWS a starter
 *                                         of the same name — they are created,
 *                                         shared and reused, so the library
 *                                         grows under a board that already
 *                                         references one by name
 *   fill: 'slots' | 'adapt'               'slots' can be filled as designed;
 *                                         'adapt' bakes its content in and
 *                                         wants its HTML edited first
 *   slots{}                               key → { sel, kind, sample }
 *   variables[]                           bare names, older declaration style
 *   aspects[], nativeSize                 what it was designed at
 *   overlay                               runs OVER a scene, not AS one
 *
 * A shot stores the NAME and the values it puts in the slots. Nothing here is
 * copied into the document — see `ShotProps.composition`.
 */

/**
 * THE SHAPE AND THE PARSER MOVED TO `@openreel/asset-browser`.
 *
 * They were only ever here because the board was the only surface that browsed
 * blocks. The video editor browses them now too — a block can be dragged
 * straight onto the timeline — and the two declaration styles in the library
 * (`slots{}` with a selector vs bare `variables[]`) are exactly the kind of
 * detail that gets implemented once and forgotten the second time. One parser,
 * shared, is the same decision this file's asset panel already makes.
 *
 * Re-exported so every board module keeps importing block types from here.
 */
import { normalizeBlocks, mediaSlots, valueSlots, type BlockInfo } from '@openreel/asset-browser';

export type { SlotKind, BlockSlot, BlockInfo } from '@openreel/asset-browser';
export { mediaSlots, valueSlots } from '@openreel/asset-browser';

let catalogue: BlockInfo[] = [];
const listeners = new Set<() => void>();

/** Repaint anything that reads the library — it arrives after first paint. */
export function onBlockCatalogue(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Replace the library.
 *
 * `slots` and `variables` are BOTH normalised into one list here, once. A block
 * may declare either — 102 of the 128 starter blocks are `fill: "slots"` and
 * only three carry `variables` — and every consumer downstream wants the same
 * answer to "what can I fill in". Two shapes handled in three places is three
 * chances to support one and silently ignore the other.
 */
export function setBlockCatalogue(raw: unknown[]): void {
  catalogue = normalizeBlocks(raw);
  listeners.forEach(fn => {
    try { fn(); } catch { /* one bad listener must not stop the rest */ }
  });
}

export function allBlocks(): BlockInfo[] {
  return catalogue;
}

export function findBlock(name: string | undefined | null): BlockInfo | null {
  if (!name) return null;
  return catalogue.find(b => b.name === name) ?? null;
}

/**
 * What is wrong with this graphic, given the block it uses.
 *
 * Same contract as `checkShot`: warnings, never refusals. A board is for
 * thinking, and the failure these prevent is the quiet one — a block whose
 * content is baked in, used as if it were a template, rendering somebody
 * else's words in the finished video.
 */
export function checkComposition(
  shot: {
    composition: string;
    compositionVars?: Record<string, string>;
    /** Roles already filled by media on the shot, so a well that HAS a picture
     *  is not reported as missing one. */
    filledMedia?: string[];
  },
): string[] {
  if (!shot.composition) return [];
  const block = findBlock(shot.composition);
  if (!block) {
    // The library is loaded but this name is not in it — a block that was
    // renamed, deleted, or belongs to a machine this board was not made on.
    return catalogue.length
      ? [`"${shot.composition}" is not in the block library on this machine. `
         + 'It may have been renamed, or it belongs to another device.']
      : [];
  }

  const out: string[] = [];
  const filled = Object.keys(shot.compositionVars ?? {}).filter(
    k => String(shot.compositionVars?.[k] ?? '').trim(),
  );

  if (block.fill === 'adapt') {
    out.push(
      `${block.name} bakes its content in — it is a starting design, not a template. `
      + 'It needs its HTML adapted with this shot\'s words before it renders, '
      + 'or it will show the designer\'s copy.',
    );
  } else {
    /**
     * SAY WHAT IS STILL EMPTY, BY NAME.
     *
     * "Fill in the slots" is not actionable on a block with nine of them. The
     * media ones matter most and are called out separately: an unfilled
     * `screenshot` renders the designer's demo screenshot in the user's video,
     * which is the failure that survives all the way to a published post.
     */
    const media = mediaSlots(block);
    const held = new Set(shot.filledMedia ?? []);
    const emptyMedia = media.filter(m => !held.has(m.key));
    if (emptyMedia.length) {
      out.push(
        `${block.name} still wants ${emptyMedia.map(m => `${m.key} (${m.kind})`).join(', ')} — `
        + 'drop media on the shot and tag it, or it renders the designer’s own.',
      );
    }

    const words = valueSlots(block).filter(v => !filled.includes(v.key));
    if (words.length && !filled.length) {
      out.push(
        `${block.name} has ${words.length} value${words.length === 1 ? '' : 's'} to fill `
        + `(${words.slice(0, 4).map(v => v.key).join(', ')}${words.length > 4 ? '…' : ''}) `
        + 'and none are set — it will render its sample content.',
      );
    }
  }

  if (block.overlay) {
    out.push(
      `${block.name} is an OVERLAY — it is designed to run over another shot rather than `
      + 'as a scene of its own.',
    );
  }
  return out;
}

/**
 * Find a block from a description, not from its name.
 *
 * WHY THIS IS NOT JUST `includes`. A substring match over the whole query only
 * fires when the words happen to be adjacent in that order: "big number" finds
 * stat-card because its description reads "One big number…", but "number stat"
 * and "stat that lands" find nothing at all. People describe what they want in
 * their own order, and a search that punishes them for it teaches them to stop
 * searching.
 *
 * Every word must appear SOMEWHERE (an AND, so more words narrow rather than
 * widen), and where it appears decides the rank: a name match beats a tag,
 * which beats prose. That ordering matters because 128 blocks share a lot of
 * prose — 37 of them say "code" — and the tags are what the author chose as
 * this block's own words.
 *
 * This is deliberately NOT a semantic search. Blocks have no embeddings yet
 * (`ACCEPTED_RECIPES` has image and audio lanes only) and giving them one is a
 * real piece of infrastructure — see BLOCK_SHARING_BUILD_PLAN §5.1. Until then
 * this is what closes most of the gap, for nothing.
 */
export function searchBlocks(query: string, from: BlockInfo[] = catalogue): BlockInfo[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return from;

  const scored = from.map(b => {
    const name = b.name.toLowerCase();
    const tags = b.tags.join(' ').toLowerCase();
    const cat = (b.category ?? '').toLowerCase();
    const prose = (b.description ?? '').toLowerCase();
    const slots = b.slots.map(sl => sl.key).join(' ').toLowerCase();

    let score = 0;
    for (const w of words) {
      // Where it matched is the rank; that it matched at all is the filter.
      if (name.includes(w)) score += 8;
      else if (tags.includes(w)) score += 5;
      else if (cat.includes(w)) score += 4;
      else if (slots.includes(w)) score += 3;
      else if (prose.includes(w)) score += 2;
      else return { b, score: -1 };
    }
    // A user's own block wins a tie — it is the strongest signal of their taste
    // that exists, which is the same reason the catalogue sorts them first.
    if (b.tier === 'user') score += 1;
    return { b, score };
  });

  return scored
    .filter(x => x.score >= 0)
    .sort((a, x) => x.score - a.score)
    .map(x => x.b);
}
