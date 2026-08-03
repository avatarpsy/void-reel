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
 * WHAT A BLOCK ASKS FOR. Measured across the shipped kit: text ×371, colour
 * ×48, image ×25, video ×1 — so most of a block's surface is words, and the
 * media it wants is specific and named ("screenshot", not "background").
 */
export type SlotKind = 'text' | 'image' | 'video' | 'color';

export interface BlockSlot {
  key: string;
  kind: SlotKind;
  /** The block's own example value. The best possible placeholder: it is what
   *  the designer put there, so it shows the shape AND the tone expected. */
  sample?: string;
  /**
   * HOW THE HOST FILLS IT, and the reason a preview can show a shot's own
   * content at all.
   *
   * There are two mechanisms in the library and they are easy to miss. Three
   * blocks declare `variables[]` and read `getVariables()` THEMSELVES. The
   * other 102 declare `slots{}` with a `sel` (a selector to patch) or a `var`
   * (a CSS custom property to set) and expect the HOST to do it — the block's
   * own code never looks at the values. A preview that only implements the
   * first mechanism renders 102 blocks with their authored placeholder content
   * no matter what the user typed.
   */
  sel?: string;
  cssVar?: string;
}

/** The slots a shot fills with MEDIA — these become drop wells on the card. */
export function mediaSlots(block: BlockInfo | null): BlockSlot[] {
  return (block?.slots ?? []).filter(s => s.kind === 'image' || s.kind === 'video');
}

/** The slots a shot fills by TYPING — words and colours. */
export function valueSlots(block: BlockInfo | null): BlockSlot[] {
  return (block?.slots ?? []).filter(s => s.kind === 'text' || s.kind === 'color');
}

export interface BlockInfo {
  name: string;
  description?: string;
  category?: string;
  tags: string[];
  /**
   * `shared` is a block ADOPTED from another creator's published one. It was
   * added when sharing gained its read half — before that a block could only be
   * yours or shipped, and anything adopted had nowhere to live.
   */
  tier: 'user' | 'shared' | 'starter';
  /** Who published it, for an adopted block. A handle, never a uid. */
  credit?: string;
  fill: 'slots' | 'adapt';
  overlay: boolean;
  aspects: string[];
  slots: BlockSlot[];
}

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
  catalogue = (Array.isArray(raw) ? raw : [])
    .map((b): BlockInfo | null => {
      const o = b as Record<string, any>;
      const name = String(o?.name ?? '').trim();
      if (!name) return null;

      const asKind = (raw: unknown): SlotKind => {
        const k = String(raw ?? 'text').toLowerCase();
        return k === 'image' || k === 'video' || k === 'color' ? k : 'text';
      };
      const fromSlots: BlockSlot[] = o.slots && typeof o.slots === 'object'
        ? Object.entries(o.slots as Record<string, any>).map(([key, v]) => ({
            key,
            kind: asKind(v?.kind),
            sample: typeof v?.sample === 'string' ? v.sample : undefined,
            // Kept VERBATIM — these are how the value reaches the composition.
            sel: typeof v?.sel === 'string' ? v.sel : undefined,
            cssVar: typeof v?.var === 'string' ? v.var : undefined,
          }))
        : [];
      const fromVars: BlockSlot[] = Array.isArray(o.variables)
        ? o.variables.map((v: unknown) => ({ key: String(v), kind: 'text' as SlotKind }))
        : [];
      // Slots win on key collision: they carry a selector and a sample, which
      // a bare variable name does not.
      const seen = new Set(fromSlots.map(s => s.key));

      return {
        name,
        description: typeof o.description === 'string' ? o.description : undefined,
        category: typeof o.category === 'string' ? o.category : undefined,
        tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
        tier: o.tier === 'user' ? 'user' : 'starter',
        fill: o.fill === 'adapt' ? 'adapt' : 'slots',
        overlay: !!o.overlay,
        aspects: Array.isArray(o.aspects) ? o.aspects.map(String) : [],
        slots: [...fromSlots, ...fromVars.filter(v => !seen.has(v.key))],
      };
    })
    .filter((b): b is BlockInfo => b !== null)
    /**
     * USER BLOCKS FIRST, and a user block SHADOWS a starter of the same name.
     * That is the rule the server already applies when reading a block
     * (`get_block` walks `['user', 'starter']` and takes the first hit), so a
     * library listing that showed both — or preferred the starter — would offer
     * the user a block that is not the one they would get.
     */
    .sort((a, b) => (a.tier === b.tier ? a.name.localeCompare(b.name) : a.tier === 'user' ? -1 : 1))
    .filter((b, i, all) => all.findIndex(x => x.name === b.name) === i);

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
