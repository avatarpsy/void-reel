/**
 * Asset browser — the pluggable contract.
 *
 * WHY THIS PACKAGE EXISTS
 * `apps/web/src/components/editor/LibraryPanel.tsx` is 2,033 lines that already
 * solve the hard parts of browsing a user's media: five sources, semantic search
 * over embeddings, type filters, recency bucketing, pagination, authenticated
 * thumbnail caching. The board needs all of it. Copying any of it would create a
 * second implementation that drifts the first time a source changes.
 *
 * But that file cannot be reused as-is, and it is worth being precise about why:
 * it is React, and it is bound to the video editor's project model — its "add"
 * action means "copy bytes into THIS openreel project and place them on the
 * timeline". Neither of those is true for the board.
 *
 * SO WE EXTRACT THE DATA LAYER, NOT THE JSX.
 * The JSX is React-specific and genuinely cannot be reused "anywhere". The
 * sources, search, filtering and auth ARE the duplicated value, they are plain
 * TypeScript, and every host can render them however it likes. That is what
 * makes this pluggable in a Lit app, a React app, or a Vue page.
 *
 * THE HOST OWNS THREE THINGS, and nothing else is assumed:
 *   1. how to get an auth token,
 *   2. what "add this asset" means,
 *   3. which assets it already has (so tiles can show a tick).
 *
 * Everything a host does NOT provide simply disappears from the UI rather than
 * erroring — a host with no `addAsset` shows no + button, a host with no
 * `browserSource` shows no "This browser" scope.
 */

/**
 * What the browser can show. Mirrors the Library's coarse types, plus `block`.
 *
 * A BLOCK IS NOT MEDIA and the difference is load-bearing. The other five are
 * files with a url that a player can open; a block is a HyperFrames composition
 * — HTML, CSS and motion — that renders on demand and has no bytes to place.
 * It is a `kind` rather than a scope because a user thinks "I want a lower
 * third" the same way they think "I want a clip", and because the scopes already
 * mean "mine vs everyone's", which for blocks maps cleanly onto user vs starter
 * tier. Making it a tab would repeat the mistake the removed Cloud tab made.
 */
export type AssetKind = 'video' | 'image' | 'music' | 'sfx' | 'voice' | 'block';

/**
 * Where assets are read from. A SCOPE, deliberately not a tab.
 *
 * ── NAMED FOR WHAT THEY FETCH, WHICH THEY WERE NOT ───────────────────────────
 * These names were inverted against the video editor's, and both were user
 * facing. `mine` read `/api/studio/library` — AI generations and renders — and
 * the board labelled it "My files", while the video editor labelled that same
 * source "Generated" and used "My files" for the on-disk media library. So the
 * same words named different sources in two editors, and the one place a user
 * could reach other creators' work was called "Shared" in one editor and did
 * not exist in the other.
 *
 * Fixed by naming each scope after the thing it actually reads:
 *
 *   generated  /api/studio/library                what YOU made here
 *   mine       /api/media-library/search-text     what YOU have on disk
 *   shared     /api/media-library/shared/search   what OTHER PEOPLE published
 *
 * The video editor's vocabulary was the correct one, so this moves toward it
 * rather than inventing a third.
 */
export type AssetScope =
  /**
   * WHAT IS ALREADY IN THIS PROJECT. Only if `projectSource` is given.
   *
   * The most reached-for scope and the reason it is first: the thing a person
   * wants next is usually the thing they used last. One backing track across
   * six shots means finding that track six times, and searching a whole library
   * for something you already chose is the kind of friction that makes people
   * re-upload a duplicate instead.
   */
  | 'project'
  /** AI generations and renders from the user's projects (`/api/studio/library`). */
  | 'generated'
  /** The user's own media library on disk — sfx, music, footage, stills, fonts. */
  | 'mine'
  /** Assets OTHER creators have published. Free to use, credited to them. */
  | 'shared'
  /** Media inside the HOST's other local projects. Only if `browserSource` is given. */
  | 'device';

/**
 * ONE SET OF WORDS FOR ALL THREE EDITORS.
 *
 * Exported rather than written per app, because three copies is exactly how the
 * board came to call generations "My files" while the video editor called the
 * media library "My files". A label is part of the contract.
 *
 * `project` is the one that varies by host — "In this board" reads better on a
 * board than "In this project" — so hosts may override that single entry.
 */
export const SCOPE_LABEL: Record<AssetScope, string> = {
  project: 'In this project',
  generated: 'Generated',
  mine: 'My files',
  shared: 'Shared',
  device: 'This browser',
};

/**
 * ONE SET OF WORDS FOR THE TYPE FILTER, for the same reason as SCOPE_LABEL.
 *
 * The board's pills said "Video" where the video editor's said "Videos" — one
 * character, on the control a user hits most, on two panels that are supposed
 * to be the same panel. `block` is board-only (the video editor has no
 * composition blocks) and simply never appears in a host that does not offer it.
 */
export const KIND_LABEL: Record<AssetKind | 'all', string> = {
  all: 'All',
  video: 'Videos',
  image: 'Images',
  music: 'Music',
  sfx: 'SFX',
  voice: 'Voice',
  block: 'Blocks',
};

/**
 * The order the type pills appear in, so neither host can re-sort them.
 *
 * `block` is deliberately LAST: the five before it are the user's own media,
 * blocks are designs they pick from, and leading with templates would suggest
 * the surface is for assembling stock rather than for their own material.
 */
export const KIND_ORDER: Array<AssetKind | 'all'> = [
  'all', 'video', 'image', 'music', 'sfx', 'voice', 'block',
];

/** One line saying what a scope holds, for a tooltip or an empty state. */
export const SCOPE_HINT: Record<AssetScope, string> = {
  project: 'Media already used in this project',
  generated: 'AI generations and renders from your projects',
  mine: 'Your media library on this machine — sfx, music, footage, stills, fonts',
  shared: 'Assets other creators have shared — free to use, credited to them',
  device: 'Media in other projects saved in this browser',
};

/** One asset, normalised across every source. */
export interface AssetItem {
  id: string;
  url: string;
  kind: AssetKind;
  label: string;
  scope: AssetScope;
  /**
   * A server-generated preview, ALREADY SIZED. On-disk library items carry one
   * (`/api/media-library/thumb?id=…&w=360`); cloud items generally do not.
   *
   * Prefer this over resizing the master: the server rasterises once, caches on
   * disk, and serves every consumer — the grid, the agent, the Flutter app. The
   * board previously ignored this field and pushed the ORIGINAL through the
   * remote-image proxy, which meant re-reading a multi-hundred-megabyte master
   * to paint a 96px tile.
   */
  thumbnailUrl?: string;
  /**
   * A 720p transcoded proxy for video, or null for kinds that have none.
   *
   * This is the answer to "play video at lower resolution" — the server already
   * builds it and it doubles as the fallback for masters no browser can decode
   * (ProRes/DNxHD .mov, common in stock packs). Responds 202 until ready.
   */
  proxyUrl?: string | null;
  /**
   * False when a thumbnail would only be a placeholder SVG (audio, 3D, fonts).
   * Hosts render their own kind icon instead, which reads as intentional rather
   * than as a broken image.
   */
  hasRasterPreview?: boolean;
  durationSec?: number;
  bytes?: number;
  createdAt?: string;
  /**
   * Who published it, when it came from another creator. A handle, never a uid.
   *
   * On the ITEM rather than only in the browsing UI, because credit that lives
   * in a tile disappears the moment somebody drags the asset onto a timeline —
   * which is exactly when attribution starts to matter.
   */
  credit?: string;
  /** Stable identity for "do I already have this?" — source URL, not id. */
  key: string;
  /**
   * Free-text detail the tile shows under the name — "8 slots · needs adapting"
   * for a block, and unused by media kinds today.
   *
   * Deliberately a rendered string rather than structured fields: what is worth
   * saying differs per kind, and a schema that tried to cover all of them would
   * be mostly nulls.
   */
  detail?: string;
}

export interface AssetQuery {
  scope: AssetScope;
  /** Quick filter, applied SERVER-side. Only meaningful for the `mine` scope. */
  quick?: QuickFilter;
  /** Free text. Routed to the SEMANTIC lane when the source supports it, so
   *  "rain on a window" finds footage nobody tagged. */
  q?: string;
  kind?: AssetKind | 'all';
  limit?: number;
  offset?: number;
}

export interface AssetPage {
  items: AssetItem[];
  total: number;
  /** True when the results came back from the embedding lane rather than
   *  substring matching — hosts surface this so a user knows why an untagged
   *  clip matched. */
  semantic: boolean;
}

/**
 * What a host must supply. Only `getIdToken` is required.
 *
 * Deliberately small: every additional required member is a reason a future host
 * cannot use this, and the point of the package is that the board, the video
 * editor and anything after them all fit.
 */
export interface AssetBrowserHost {
  /** Voidspace auth. Return null when signed out; sources degrade to empty. */
  getIdToken(): Promise<string | null>;

  /** Origin for the Voidspace API. Defaults to the current page's origin. */
  apiBase?(): string;

  /**
   * What "add this" means here. The video editor copies bytes into its project
   * and places them on the timeline; the board places a block on the canvas.
   * Omit and the browser is read-only.
   */
  addAsset?(item: AssetItem): Promise<void> | void;

  /** Keys the host already holds, so tiles can show a tick. */
  hasAsset?(key: string): boolean;

  /** Optional local-project scope ("This browser"). Omit to hide it. */
  browserSource?: {
    list(): Promise<AssetItem[]>;
  };

  /**
   * What is already in the OPEN project — the `project` scope. Omit to hide it.
   *
   * Synchronous on purpose, unlike the others: the host already has this in
   * memory (it is the document being edited), and making it a promise would put
   * a loading state in front of data that is right there.
   */
  projectSource?: {
    list(): AssetItem[];
  };

  /**
   * HyperFrames composition blocks — the `block` kind. Omit to hide the pill.
   *
   * Its own source rather than a branch inside the library reader, because
   * blocks do not come from `/api/studio/library` at all: they are files in the
   * user's Voidspace folder, and the host already holds the catalogue in memory
   * (the board is handed it on mount). Synchronous for the same reason
   * `projectSource` is — putting a spinner in front of data that is already here
   * is worse than no spinner.
   *
   * Receives the QUERY, unlike the other local sources, so the host can decide
   * what a scope means for a block: "My files" is the user's own blocks, the
   * shared library is the shipped starters.
   */
  blockSource?: {
    list(q: AssetQuery): AssetItem[];
  };
}

/**
 * Quick filters — the answer to "never open on everything".
 *
 * Shared for the same reason the scope labels are: these are a promise about
 * what a control DOES. The video editor shipped them; the board had none, so
 * the same library offered two different ways to narrow it depending on which
 * editor you opened.
 *
 * They only apply to the media-library scope. The generations store and the
 * browser's own projects carry neither personal signals nor server-side sorts,
 * so offering the chips there would be offering controls that cannot narrow.
 */
export type QuickFilter = 'none' | 'favourites' | 'used' | 'recent';

export const QUICK_FILTERS: { id: Exclude<QuickFilter, 'none'>; label: string; hint: string }[] = [
  { id: 'favourites', label: '★ Favourites', hint: 'Assets you starred' },
  { id: 'used', label: 'Most used', hint: 'What you keep coming back to — counted automatically' },
  { id: 'recent', label: 'Newest', hint: 'Most recent first, by capture date where known' },
];

/** Personal signals the server counts for the current user. */
export interface PersonalCounts { favorite: number; rated: number; used: number }

/**
 * The QUERY PARAMS a quick filter maps to.
 *
 * Server-side, never client-side: filtering a page after it arrives silently
 * drops results and yields short pages. Kept here so both panels send the same
 * thing — the video editor's mapping, verbatim.
 */
export function quickFilterParams(quick: QuickFilter): Record<string, string> {
  if (quick === 'favourites') return { favourites: '1' };
  if (quick === 'used') return { used: '1', sort: 'used' };
  if (quick === 'recent') return { sort: 'newest' };
  return {};
}
