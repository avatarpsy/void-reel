/**
 * The HyperFrames block library, normalised once for everything that browses it.
 *
 * ── WHAT A BLOCK IS ─────────────────────────────────────────────────────────
 * A folder on the user's machine under `~/Voidspace/.hyperframes/blocks`, with
 * a `block.html` and a `block.json`. `POST /api/studio/blocks {action:'list'}`
 * returns them (device-first, disk fallback). Nothing here fetches: the board is
 * an iframe with no session and receives its copy from the parent, while the
 * editor asks for its own. Both hand the raw rows to `normalizeBlocks`.
 *
 * ── WHY THE PARSER LIVES IN THE SHARED PACKAGE ──────────────────────────────
 * There are TWO declaration styles in the shipped kit and it is easy to
 * implement one and silently ignore the other: 102 of the 128 starters declare
 * `slots{}` with a `sel` (a selector the HOST patches) or a `var` (a CSS custom
 * property the HOST sets), while a handful declare bare `variables[]` and read
 * them themselves. A browser that understands only `variables` shows 102 blocks
 * with the designer's placeholder text no matter what the user typed.
 *
 * That trap is worth solving exactly once. The board had the only copy; the
 * video editor needed the same answers to the same questions, and a second
 * parser would have been a second chance to get the two mechanisms wrong. Same
 * reason the recency/paging rules in this package are shared.
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
  /** A selector on the block's own markup for the host to patch. */
  sel?: string;
  /** A CSS custom property for the host to set. */
  cssVar?: string;
}

export interface BlockInfo {
  name: string;
  description?: string;
  category?: string;
  tags: string[];
  /**
   * `shared` is a block ADOPTED from another creator's published one. `user`
   * blocks SHADOW a starter of the same name — the same rule the server applies
   * when reading a block, so a listing that showed both would offer a block
   * that is not the one you would get.
   */
  tier: 'user' | 'shared' | 'starter';
  /** Who published it, for an adopted block. A handle, never a uid. */
  credit?: string;
  /** `slots` can be filled as designed; `adapt` bakes its content in and wants
   *  its HTML edited first. */
  fill: 'slots' | 'adapt';
  /** Designed to run OVER a picture rather than as a full frame of its own. */
  overlay: boolean;
  aspects: string[];
  slots: BlockSlot[];
}

/** The slots filled with MEDIA — these become drop wells. */
export function mediaSlots(block: BlockInfo | null | undefined): BlockSlot[] {
  return (block?.slots ?? []).filter((s) => s.kind === 'image' || s.kind === 'video');
}

/** The slots filled by TYPING — words and colours. */
export function valueSlots(block: BlockInfo | null | undefined): BlockSlot[] {
  return (block?.slots ?? []).filter((s) => s.kind === 'text' || s.kind === 'color');
}

/**
 * Raw listing rows → one catalogue.
 *
 * `slots` and `variables` are BOTH folded into a single list here, once, because
 * every consumer downstream wants the same answer to "what can I fill in".
 * Slots win on a key collision: they carry a selector and a sample, which a bare
 * variable name does not.
 */
export function normalizeBlocks(raw: unknown[]): BlockInfo[] {
  return (Array.isArray(raw) ? raw : [])
    .map((b): BlockInfo | null => {
      const o = b as Record<string, any>;
      const name = String(o?.name ?? '').trim();
      if (!name) return null;

      const asKind = (v: unknown): SlotKind => {
        const k = String(v ?? 'text').toLowerCase();
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
      const seen = new Set(fromSlots.map((s) => s.key));

      return {
        name,
        description: typeof o.description === 'string' ? o.description : undefined,
        category: typeof o.category === 'string' ? o.category : undefined,
        tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
        tier: o.tier === 'user' ? 'user' : o.tier === 'shared' ? 'shared' : 'starter',
        credit: typeof o.credit === 'string' ? o.credit : undefined,
        fill: o.fill === 'adapt' ? 'adapt' : 'slots',
        overlay: !!o.overlay,
        aspects: Array.isArray(o.aspects) ? o.aspects.map(String) : [],
        slots: [...fromSlots, ...fromVars.filter((v) => !seen.has(v.key))],
      };
    })
    .filter((b): b is BlockInfo => b !== null)
    /** User blocks first, and a user block shadows a starter of the same name. */
    .sort((a, b) => (a.tier === b.tier ? a.name.localeCompare(b.name) : a.tier === 'user' ? -1 : 1))
    .filter((b, i, all) => all.findIndex((x) => x.name === b.name) === i);
}

/**
 * Free-text search over a catalogue — name, description, category, tags.
 *
 * Deliberately plain substring matching on a lowercased haystack. The library is
 * ~130 rows held in memory; anything cleverer would be a ranking model nobody
 * asked for, and the user is typing "lower" to find lower thirds.
 */
export function searchBlocks(blocks: BlockInfo[], query: string): BlockInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return blocks;
  const terms = q.split(/\s+/).filter(Boolean);
  return blocks.filter((b) => {
    const hay = [b.name, b.description ?? '', b.category ?? '', ...b.tags]
      .join(' ')
      .toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/**
 * WHAT A SCOPE PILL MEANS FOR A BLOCK.
 *
 * The pills are the same five words in both panels, so they have to mean the
 * same five things. They did not until this moved here: the board decided it
 * inline, and the video editor — which now shows the same library — would have
 * been a second opinion about whose blocks are "mine".
 *
 *   project    the blocks this document already uses (the host supplies the
 *              set; a panel with no such notion passes none and gets nothing).
 *   mine       blocks the user AUTHORED. Never the shipped ones: filing 128
 *              designs they never touched under "My files" would be the real
 *              lie in either direction.
 *   shared     every design they did not author — the starters that ship with
 *              Voidspace and anything adopted from another creator. Splitting
 *              those would need a sixth pill for one kind, and the distinction
 *              people actually care about (who made this) is on the tile.
 *   generated  honestly EMPTY. A block is authored or installed, never
 *              generated, and showing everything here would misdescribe where
 *              they came from.
 *   device     has no block meaning, so it shows everything rather than
 *              pretending to a filter it cannot apply.
 */
export function blocksForScope(
  blocks: BlockInfo[],
  scope: 'project' | 'mine' | 'shared' | 'generated' | 'device',
  usedNames?: ReadonlySet<string>,
): BlockInfo[] {
  switch (scope) {
    case 'project': return usedNames ? blocks.filter((b) => usedNames.has(b.name)) : [];
    case 'generated': return [];
    case 'mine': return blocks.filter((b) => b.tier === 'user');
    case 'shared': return blocks.filter((b) => b.tier === 'starter' || b.tier === 'shared');
    default: return blocks;
  }
}
