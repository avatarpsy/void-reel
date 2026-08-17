/**
 * The board's asset panel — a view over `@openreel/asset-browser`.
 *
 * INSIDE the board app, not the Nuxt page. That is the whole point: a panel in
 * the same document as the canvas gets native drag-and-drop onto it, whereas a
 * panel in the parent page would have to marshal every drop across an iframe
 * boundary. It also means one library implementation serves both editors —
 * the core owns sources, semantic search and auth; this file owns only pixels.
 *
 * Plain DOM rather than Lit, matching `board-ui.ts`: this is chrome sitting over
 * the editor, it holds no document state, and it must not join BlockSuite's
 * render cycle.
 */
import {
  PAGE_SIZE, SCOPE_LABEL as SHARED_SCOPE_LABEL, TILE_GAP_PX, TILE_MIN_PX,
  VIEW_MODES, KIND_LABEL, KIND_ORDER, QUICK_FILTERS, availableScopes, fetchPersonalCounts, searchPlaceholder, setAssetFavourite, uploadToLibrary,
  clampPanelWidth, fetchAssetsCached, groupByRecency, hasMore, invalidateAssetCache, isAuthError,
  loadPanelWidth, loadThumbInto, loadViewMode, mergePage,
  mediaSrc, nextOffset, savePanelWidth, saveViewMode, tileSrc, videoPreviewSrc,
  PANEL_GLYPH, isTypingTarget, loadPanelCollapsed, panelToggleTitle, savePanelCollapsed,
  type AssetBrowserHost, type AssetItem, type AssetKind, type AssetPage, type AssetScope,
  type PersonalCounts, type QuickFilter, type ViewMode,
} from '@openreel/asset-browser';

import type { DragPayload } from '@blocksuite/std';
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';

import { placeAsset } from '../board/asset-media';
import { getParentToken, onParentToken } from '../board/parent-auth';
import type { MediaRole } from '../shot/model';
import { boardMedia } from './media-inspector';
import { allBlocks, onBlockCatalogue, type BlockInfo } from '../shot/blocks';
import { addMedia, readShot, readShots, setShotFields } from '../shot/shots';
import {
  ASSET_DRAG_TYPE, BLOCK_DRAG_TYPE, dropZoneAt, handleAssetDrop, handleBlockDrop,
  type AssetDragEntity, type BlockDragEntity,
} from '../shot/drop';
import { lazyBlockPreview, mountBlockPreview, type PreviewHandle } from './block-preview';
import { pendingToast, toast } from './toast';
import type { MountedBoard } from '../blocksuite/editor';

/**
 * The type pills. Labels and ORDER both come from the core so this panel and
 * the video editor's Library cannot say "Video" where the other says "Videos",
 * or sort the same six filters differently.
 */
const KINDS: Array<{ id: AssetKind | 'all'; label: string }> =
  KIND_ORDER.map(id => ({ id, label: KIND_LABEL[id] }));

/** View-mode glyphs, matching the video editor's grid / compact-grid / list. */
const VIEW_ICON: Record<ViewMode, string> = {
  grid: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1"/><rect x="9" y="9" width="5.5" height="5.5" rx="1"/></svg>',
  compact: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><rect x="1" y="1" width="3.6" height="3.6" rx=".8"/><rect x="6.2" y="1" width="3.6" height="3.6" rx=".8"/><rect x="11.4" y="1" width="3.6" height="3.6" rx=".8"/><rect x="1" y="6.2" width="3.6" height="3.6" rx=".8"/><rect x="6.2" y="6.2" width="3.6" height="3.6" rx=".8"/><rect x="11.4" y="6.2" width="3.6" height="3.6" rx=".8"/><rect x="1" y="11.4" width="3.6" height="3.6" rx=".8"/><rect x="6.2" y="11.4" width="3.6" height="3.6" rx=".8"/><rect x="11.4" y="11.4" width="3.6" height="3.6" rx=".8"/></svg>',
  list: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><rect x="1.5" y="2.5" width="3" height="3" rx=".7"/><rect x="6" y="3.4" width="8.5" height="1.4" rx=".7"/><rect x="1.5" y="6.5" width="3" height="3" rx=".7"/><rect x="6" y="7.4" width="8.5" height="1.4" rx=".7"/><rect x="1.5" y="10.5" width="3" height="3" rx=".7"/><rect x="6" y="11.4" width="8.5" height="1.4" rx=".7"/></svg>',
};
/** Attribute-safe text. Module scope: both `shell()` and `tile()` need it. */
const esc = (t: string) => String(t ?? '').replace(/"/g, '&quot;');

const ICON_UPLOAD = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const ICON_REFRESH = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';

const VIEW_TITLE: Record<ViewMode, string> = {
  grid: 'Grid', compact: 'Small grid', list: 'List',
};

/**
 * ONE VOCABULARY, from the package, with a single deliberate override.
 *
 * These labels were written here and drifted from the video editor's until the
 * same words named different sources: this panel called AI generations "My
 * files" and the on-disk media library "Library", while the video editor called
 * generations "Generated" and the media library "My files". A user moving
 * between the two editors saw the same tab name backed by different content.
 *
 * `project` is overridden because "In this board" reads better here than "In
 * this project" — the one place a host-specific word is worth the divergence.
 */
const SCOPE_LABEL: Record<AssetScope, string> = {
  ...SHARED_SCOPE_LABEL,
  project: 'In this board',
};

/**
 * What the CANVAS should load for an asset, versus what compile must keep.
 *
 * The split is the whole reason a big board stays snappy. A storyboard tile is a
 * hundred pixels wide, so it takes the server's already-generated thumbnail or
 * its 720p proxy; the master is recorded as `url` and only the final render ever
 * reads it. Getting this backwards is what made dropping a 4K still feel like a
 * hang.
 *
 * ONE SHAPE FOR BOTH DESTINATIONS. This is exactly a `ShotMedia` minus the bits
 * a shot assigns itself (`id`, `role`), so the same object is what rides on the
 * drag, what is appended to a shot, and what canvas placement is derived from.
 * Two payload shapes would be two chances to describe the same asset differently.
 */
/**
 * One block, as a browsable asset.
 *
 * `url` is `block:<tier>/<name>` — not fetchable, and deliberately so. Every
 * AssetItem needs a stable identity for "do I already have this", and this is
 * the id `BLOCK_SHARING_BUILD_PLAN.md` §6.1 already specifies for when blocks
 * join the Library proper. Using it now means that day is a rename of nothing.
 *
 * `detail` carries what actually decides whether a block fits: how many holes it
 * has to fill, and whether it is a template at all. 26 of the 128 starters bake
 * their content in — their own manifest calls them "a starting design, not a
 * template" — and a user who picks one expecting to fill it gets the designer's
 * words in their video. That is worth three words on a tile.
 */
/**
 * A block as a browsable asset.
 *
 * CREDIT IS SET HERE so the Shared pill is readable: it holds both the designs
 * that ship with Voidspace and the ones adopted from other people, and without a
 * source on the tile those are indistinguishable.
 */
function blockAsset(b: BlockInfo, scope: AssetScope): AssetItem {
  const id = `block:${b.tier}/${b.name}`;
  const detail = [
    b.category,
    b.slots.length ? `${b.slots.length} slot${b.slots.length === 1 ? '' : 's'}` : 'no slots',
    b.fill === 'adapt' ? 'needs adapting' : '',
    b.overlay ? 'overlay' : '',
    ...b.tags.slice(0, 3),
  ].filter(Boolean).join(' · ');
  return {
    id,
    url: id,
    key: id,
    kind: 'block',
    label: b.name,
    detail,
    scope,
    // Who made it — the only thing separating a Voidspace design from one
    // somebody published, now that both sit under the same pill.
    credit: b.tier === 'starter' ? 'Voidspace' : b.credit,
    // Nothing to rasterise: the tile draws a live render instead. Saying so
    // stops the thumbnail machinery reaching for a url that is not one.
    hasRasterPreview: false,
  };
}

function mediaFor(host: AssetBrowserHost, item: AssetItem): AssetDragEntity['media'] {
  const kind: 'image' | 'video' | 'audio' =
    item.kind === 'image' ? 'image' : item.kind === 'video' ? 'video' : 'audio';
  return {
    kind,
    src: kind === 'image'
      // 960 = the widest an image is placed at on the open canvas
      // (`MAX_CANVAS_IMAGE_WIDTH`), so there is enough detail and not a byte more.
      ? tileSrc(host, item, 960) || item.url
      : kind === 'video' ? videoPreviewSrc(item) : item.url,
    url: item.url,
    poster: item.thumbnailUrl,
    name: item.label || kind,
    mediaId: item.id,
    scope: item.scope,
    bytes: item.bytes,
  };
}

/**
 * Put an asset on the OPEN CANVAS, with feedback at both ends.
 *
 * Slow placements announce themselves and failures are named. Between them these
 * remove the two ways a drop could look like nothing happened — which is what
 * made users drop again and end up with duplicates.
 *
 * Dropping onto a SHOT does not come through here: that is a list append and it
 * is instant, so there is nothing to announce.
 */
/**
 * UI scope → the scope PERSISTED on a media ref.
 *
 * ── TWO VOCABULARIES ON PURPOSE, AND THIS IS THE SEAM ────────────────────────
 * The stored value names an ID SPACE, not a tab: "which library does this id
 * belong to", which compile carries into the project. Boards already on disk use
 * it, so its meaning cannot move — renaming the tabs must not silently
 * re-attribute media in every board ever saved.
 *
 *   UI 'generated'  →  'mine'    ids from /api/studio/library
 *   UI 'mine'       →  'shared'  ids from the media library
 *   UI 'shared'     →  'shared'  same id space — a published asset is a media
 *                                library asset, just one somebody else owns
 *   UI 'device'     →  'device'
 *   UI 'project'    →  whatever the asset already carried
 *
 * So the tabs were renamed to match the video editor and NOT ONE BYTE of stored
 * board data changed meaning.
 */
export function persistedScope(uiScope: string | undefined): 'mine' | 'shared' | 'device' {
  if (uiScope === 'device') return 'device';
  if (uiScope === 'mine' || uiScope === 'shared') return 'shared';
  // 'generated', 'project', or an older board's value — the generations space.
  return 'mine';
}

async function placeOnCanvas(
  board: MountedBoard,
  media: AssetDragEntity['media'],
  clientPoint?: [number, number],
): Promise<void> {
  const done = pendingToast(`Adding ${media.name || 'media'}…`);
  try {
    const result = await placeAsset(board.std, {
      displayUrl: media.src,
      originalUrl: media.url,
      kind: media.kind,
      mediaId: media.mediaId,
      scope: persistedScope(media.scope),
      name: media.name,
      posterUrl: media.poster,
      bytes: media.bytes,
      clientPoint,
    });
    if (!result.ok) toast(result.message);
  } finally {
    done();
  }
}

export function installAssetPanel(board: MountedBoard, container: HTMLElement): () => void {
  const gfx = board.std.get(GfxControllerIdentifier);

  /**
   * The + button and the preview's "Add to board".
   *
   * IT FOLLOWS THE SELECTION. With a shot selected the asset joins that shot,
   * which is what someone building a scene means by "add"; with nothing selected
   * it lands on the open canvas. The alternative — always the canvas — meant
   * every keyboard-driven add had to be dragged into place afterwards, and
   * dragging is the thing this rewrite exists to stop requiring.
   */
  function addToSelectionOrCanvas(item: AssetItem): void {
    const selected = gfx.selection.selectedIds
      .find(id => board.store.getBlock(id)?.flavour === 'voidspace:shot');

    /**
     * A BLOCK NEEDS A SHOT. There is no canvas fallback for it — a composition
     * with nothing to compose is not a thing the board can hold — so with
     * nothing selected the answer is to say what to do, not to invent a shot.
     */
    if (item.kind === 'block') {
      if (!selected) {
        toast('Select a shot first, or drag the block onto one.');
        return;
      }
      const shot = readShot(board.std, selected);
      setShotFields(board.std, selected, {
        kind: 'hyperframes',
        composition: item.label,
        ...(shot?.composition && shot.composition !== item.label ? { compositionVars: {} } : {}),
      });
      toast(`${item.label} → ${shot?.title || 'the shot'}`, 'info');
      return;
    }

    const media = mediaFor(host, item);
    if (selected) {
      const role: MediaRole = media.kind === 'audio' ? 'sfx' : 'reference';
      addMedia(board.std, selected, { ...media, role });
      toast(`Added to ${readShot(board.std, selected)?.title || 'the shot'}`, 'info');
      return;
    }
    void placeOnCanvas(board, media);
  }

  /** The board places media; it never copies bytes into a project. */
  const host: AssetBrowserHost = {
    // Auth is the parent's. `parent-auth` owns the asking, the retry and the
    // cache, so the panel, the blob source and the drop path cannot end up with
    // three different answers to "are we signed in".
    getIdToken: () => getParentToken(),
    addAsset: item => addToSelectionOrCanvas(item),

    /**
     * WHAT IS ALREADY ON THIS BOARD.
     *
     * The scope people reach for most, and the one this panel was missing: one
     * backing track across six shots meant finding that track in the library six
     * times. Read straight out of the shots — the board IS the source, so there
     * is nothing to fetch and nothing that can be stale.
     *
     * Deduped by url, because the same track attached to four shots is ONE
     * thing to reuse, not four rows of the same name. Which shots it is already
     * in becomes the label, which is the useful fact when you are deciding
     * whether to add it again.
     */
    projectSource: {
      list: () => {
        const byUrl = new Map<string, AssetItem & { shots: Set<string> }>();
        for (const m of boardMedia(board)) {
          const key = m.url || m.src;
          if (!key) continue;
          const seen = byUrl.get(key);
          if (seen) { seen.shots.add(m.shotTitle || 'untitled'); continue; }
          byUrl.set(key, {
            id: m.mediaId || m.id,
            url: m.url || m.src,
            key,
            kind: m.kind === 'image' ? 'image' : m.kind === 'video' ? 'video' : 'music',
            label: m.tag || m.name,
            scope: 'project',
            thumbnailUrl: m.kind === 'image' ? m.src : m.poster,
            durationSec: m.durationSec,
            bytes: m.bytes,
            shots: new Set([m.shotTitle || 'untitled']),
          });
        }
        return [...byUrl.values()].map(({ shots, ...item }) => ({
          ...item,
          label: shots.size > 1
            ? `${item.label} · in ${shots.size} shots`
            : item.label,
        }));
      },
    },

    /**
     * THE HYPERFRAMES BLOCK LIBRARY, as browsable assets.
     *
     * Read straight out of the catalogue the parent page pushed in on mount —
     * no fetch, no loading state, and it cannot disagree with the picker on a
     * shot card because both read `allBlocks()`.
     *
     * THE SCOPE MEANS SOMETHING HERE. It is the same distinction the pills
     * already make everywhere else, and blocks happen to have exactly two tiers:
     *
     *   In this board — blocks the shots on this board already use
     *   My files      — the user's own, authored or bought (tier: 'user')
     *   Library       — the shipped starters
     *
     * A scope with no blocks says so rather than falling back to everything:
     * "you have not made any blocks yet" is a true and useful answer, where
     * quietly showing 128 starters under "My files" is a false one.
     */
    blockSource: {
      list: (q) => {
        const used = new Set(
          readShots(board.std)
            .filter(sh => sh.kind === 'hyperframes' && sh.composition)
            .map(sh => sh.composition),
        );
        const wanted = allBlocks().filter(b => {
          if (q.scope === 'project') return used.has(b.name);
          // A block is never a GENERATION — it is authored or installed, so that
          // scope is honestly empty rather than quietly showing everything.
          if (q.scope === 'generated') return false;
          if (q.scope === 'mine') return b.tier === 'user';
          /**
           * "Shared" for blocks means EVERY DESIGN YOU DID NOT AUTHOR — the 128
           * that ship with Voidspace and the ones adopted from other creators.
           *
           * Splitting them would need a fourth pill that exists for one kind, and
           * the distinction people actually care about — who made this — is on the
           * tile as a credit line. Mixing them under "My files" would be the real
           * lie: it would claim authorship of 128 designs the user never touched.
           */
          if (q.scope === 'shared') return b.tier === 'starter' || b.tier === 'shared';
          return true; // 'device' has no block meaning; show everything
        });
        return wanted.map(b => blockAsset(b, q.scope));
      },
    },
  };
  const scopes = availableScopes(host);

  /**
   * OPENS ON GENERATIONS, which is what it always showed.
   *
   * Before the rename this defaulted to `mine`, and `mine` WAS
   * `/api/studio/library`. Leaving the literal unchanged would have silently
   * moved every user's default tab to a different library on upgrade.
   */
  let scope: AssetScope = 'generated';
  let kind: AssetKind | 'all' = 'all';
  let query = '';
  // Remembered, like the width beside it. The board was the only surface that
  // reopened the panel on every load no matter how the user had left it.
  let collapsed = loadPanelCollapsed('assets');
  // Both come from the CORE, so the preference follows the user between the
  // board and the video editor rather than being re-chosen on each surface.
  let viewMode: ViewMode = loadViewMode();
  let width = loadPanelWidth();

  const el = document.createElement('aside');
  el.className = 'vs-assets';
  container.append(el);

  /**
   * The narrowing row. Each chip appears ONLY when it can actually change the
   * result — Favourites once something is starred, Most-used once something has
   * been used. A filter that cannot narrow is worse than no filter, because the
   * user still has to read it. Same rule, same wording as the video editor.
   */
  function quickRow(): string {
    if (scope !== 'mine') return '';
    const chips = QUICK_FILTERS.filter(({ id }) => {
      if (id === 'favourites') return personal.favorite > 0 || quick === 'favourites';
      if (id === 'used') return personal.used > 0 || quick === 'used';
      return true;
    });
    if (!chips.length) return '';
    return `<div class="vs-assets__quick">${chips.map(({ id, label, hint }) => {
      const n = id === 'favourites' ? personal.favorite : id === 'used' ? personal.used : 0;
      return `<button type="button" data-a="quick" data-v="${id}" title="${esc(hint)}"
        class="vs-assets__chip${quick === id ? ' is-on' : ''}">${esc(label)}${n ? ` (${n})` : ''}</button>`;
    }).join('')}${quick !== 'none'
      ? '<button type="button" data-a="quick" data-v="none" class="vs-assets__chip vs-assets__chip--clear">Clear</button>'
      : ''}</div>`;
  }

  /**
   * The collapse control — the SAME button the React editors render.
   *
   * Not a look-alike: the markup comes from `PANEL_GLYPH` in the shared
   * `panel-chrome` module, which holds the lucide path data both halves draw,
   * and `panelToggleTitle` writes the tooltip both halves say. This panel used
   * to hide behind a ◂ character wedged into the title, which was the one
   * collapse control in the product that was a piece of TEXT.
   */
  function toggleBtn(): string {
    return `<button type="button" class="vs-panel-toggle" data-a="toggle"
              title="${panelToggleTitle('Assets', collapsed)}"
              aria-label="${panelToggleTitle('Assets', collapsed)}"
              aria-expanded="${!collapsed}"
            >${collapsed ? PANEL_GLYPH['left-open'] : PANEL_GLYPH['left-close']}</button>`;
  }

  function shell(): string {
    // Collapsed: a rail carrying the mirrored button and the panel's name
    // written down it, so a shut panel is still visibly a panel. The whole rail
    // is the target, not just the 28px button.
    if (collapsed) {
      return `
        <div class="vs-assets__rail">
          ${toggleBtn()}
          <button type="button" class="vs-assets__rail-label" data-a="toggle" tabindex="-1" aria-hidden="true">Assets</button>
        </div>`;
    }
    return `
      <div class="vs-assets__bar">
        <img class="vs-assets__logo" src="/images/logo/logo.png" alt="Voidspace" />
        <a class="vs-assets__back" href="/studio/projects?tab=boards" target="_top">Back to Projects</a>
      </div>
      <div class="vs-assets__head">
        <span class="vs-assets__title">Assets</span>
        ${toggleBtn()}
      </div>
      <div class="vs-assets__body">
        <div class="vs-assets__scopes">
          ${scopes.map(s => `<button type="button" data-a="scope" data-v="${s}"
              class="vs-assets__scope${s === scope ? ' is-on' : ''}">${SCOPE_LABEL[s]}</button>`).join('')}
        </div>
        <label class="vs-assets__search">
          <input class="vs-assets__q" data-a="q" type="search" value="${esc(query)}"
                 placeholder="${esc(searchPlaceholder(scope, { kind, semantic: true }))}" />
        </label>
        <div class="vs-assets__kinds">
          ${KINDS.map(k => `<button type="button" data-a="kind" data-v="${k.id}"
              class="vs-assets__kind${k.id === kind ? ' is-on' : ''}">${k.label}</button>`).join('')}
        </div>
        <!-- Add · views · refresh — the editor's toolbar row, same order.
             Add was missing entirely, so the board could browse the library and
             never put anything INTO it; refresh was missing, so a file added
             from another surface needed a full reload to appear. -->
        <div class="vs-assets__tools">
          <button type="button" class="vs-assets__add" data-a="add-media" title="Add a file to your library">
            ${ICON_UPLOAD}<span>Add</span>
          </button>
          <span class="vs-assets__tools-gap"></span>
          <div class="vs-assets__views">
            ${VIEW_MODES.map(m => `<button type="button" data-a="view" data-v="${m}"
                class="vs-assets__view${m === viewMode ? ' is-on' : ''}"
                title="${VIEW_TITLE[m]}">${VIEW_ICON[m]}</button>`).join('')}
          </div>
          <button type="button" class="vs-assets__refresh" data-a="refresh" title="Refresh library">${ICON_REFRESH}</button>
        </div>
        ${quickRow()}
        <div class="vs-assets__list vs-assets__list--${viewMode}" data-a="list"
             style="--vs-tile-min:${TILE_MIN_PX[viewMode]}px;--vs-tile-gap:${TILE_GAP_PX[viewMode]}px"><p class="vs-assets__muted">Loading…</p></div>
      </div>
      <div class="vs-assets__grip" data-a="grip" title="Drag to resize"></div>`;
  }

  function tile(a: AssetItem): string {
    const isBlock = a.kind === 'block';
    const glyph = isBlock ? '◫' : a.kind === 'video' ? '🎬' : a.kind === 'image' ? '🖼' : '🔊';
    // CLICK PREVIEWS, the + ADDS — the same split the video editor uses. Clicking
    // a tile to silently drop it on the canvas made it impossible to check what
    // something was before committing to it.
    const hint = isBlock
      ? 'click to see it render, drag onto a shot'
      : 'click to preview, drag onto the board';
    return `<div class="vs-assets__item${isBlock ? ' vs-assets__item--block' : ''}"
      data-a="item" data-id="${a.id}"
      title="${esc(a.label || a.kind)}${a.detail ? ` — ${esc(a.detail)}` : ''} — ${hint}">
      <span class="vs-assets__thumb" data-thumb="${a.id}">${glyph}</span>
      <span class="vs-assets__names">
        <span class="vs-assets__name">${a.label || a.kind}</span>
        ${a.detail ? `<span class="vs-assets__detail">${esc(a.detail)}</span>` : ''}
      </span>
      ${scope === 'mine' ? `<button type="button" class="vs-assets__star${favourites.has(a.id) ? ' is-on' : ''}"
              data-a="star" data-id="${a.id}"
              title="${favourites.has(a.id) ? 'Remove from Favourites' : 'Add to Favourites'}"
              aria-pressed="${favourites.has(a.id)}">${favourites.has(a.id) ? '★' : '☆'}</button>` : ''}
      <button type="button" class="vs-assets__place" data-a="add" data-id="${a.id}"
              title="${isBlock ? 'Use on the selected shot' : 'Add to the board'}">+</button>
    </div>`;
  }

  /** Object-URL and drag-registration disposers for the tiles on screen. */
  let thumbCleanups: Array<() => void> = [];
  function hydrateThumbs() {
    thumbCleanups.forEach(fn => fn());
    thumbCleanups = [];

    /**
     * Register each tile with BLOCKSUITE'S drag system, not the browser's.
     *
     * `std.dnd` is a wrapper over pragmatic-drag-and-drop, and it is the same
     * system the editor itself drags with (`UIEventDispatcher` monitors it —
     * `event/control/pointer.ts:373`). The panel previously used raw HTML5
     * `dragstart`/`drop`, which meant two drag systems ran at once over the same
     * canvas: the browser painted its own drag ghost while BlockSuite painted
     * its preview, which is the "two copies while dragging" artefact.
     *
     * Registration is per render because the grid is rebuilt on every search;
     * the disposers ride along with the thumbnail ones.
     */
    for (const a of results) {
      const tile = el.querySelector<HTMLElement>(`[data-a="item"][data-id="${a.id}"]`);
      if (tile) {
        const dragId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        thumbCleanups.push(board.std.dnd.draggable<AssetDragEntity | BlockDragEntity>({
          element: tile,
          // The payload is the MEDIA, resolved once at drag start — not the raw
          // library row. Whatever receives it, shot or canvas, is looking at the
          // same description of the same asset.
          //
          // A BLOCK carries its own entity: it has no url and no bytes, and what
          // dropping it means is "this shot is now a graphic built from this",
          // not "append this to the media list".
          setDragData: () => (a.kind === 'block'
            ? { type: BLOCK_DRAG_TYPE, name: a.label, label: a.label, dragId: dragId() }
            : { type: ASSET_DRAG_TYPE, media: mediaFor(host, a), dragId: dragId() }),
        }));
      }
    }

    for (const a of results) {
      // The CORE picks the source: a server-generated thumbnail when the asset
      // has one (already sized, disk-cached), the resized master only when it
      // does not, and '' for kinds whose thumb would be a placeholder.
      const src = tileSrc(host, a);
      const holder = el.querySelector<HTMLElement>(`[data-thumb="${a.id}"]`);
      if (!holder) continue;

      /**
       * A CLIP WITH NO POSTER STILL HAS A FIRST FRAME.
       *
       * `tileSrc` returns '' for a video without a server-generated thumbnail,
       * and the grid then shows a 🎬 glyph — which is what "no preview for
       * media" looked like. But a browser will happily paint frame one from
       * `preload="metadata"`, which fetches the container header and nothing
       * else. So the fallback is a real frame at roughly the cost of the icon.
       *
       * Muted and controls-free: this is a thumbnail, not a player. Playback
       * belongs in the inspector, where the trim window applies.
       */
      /**
       * A BLOCK TILE RENDERS THE BLOCK.
       *
       * There are no preview images on disk, so the alternative is the ◫ glyph
       * — and a wall of identical glyphs is a list of 128 names, which is not a
       * library you can browse. The composition is a self-contained document
       * that renders in milliseconds, so the tile runs it, lazily and inside
       * the board-wide budget (see `lazyBlockPreview`): only tiles actually on
       * screen hold a slot, and scrolling hands them back.
       *
       * THUMBNAIL-FIRST VIEWS ONLY. The list view's thumb is 38x28, where a
       * composition is an unreadable smudge and the glyph is genuinely the
       * better answer.
       */
      if (a.kind === 'block') {
        if (viewMode === 'list') continue;
        holder.textContent = '';
        const lazy = lazyBlockPreview(holder, { priority: 'tile' });
        lazy.set(a.label);
        // HOVER TO PLAY. The composition settles on its finished frame, which
        // is the most useful single frame it has; pointing at it replays the
        // motion. That keeps a grid of 128 templates to one animation at a
        // time instead of twenty-two running forever.
        const row = holder.closest<HTMLElement>('[data-a="item"]');
        const on = () => lazy.setLoop(true);
        const off = () => lazy.setLoop(false);
        row?.addEventListener('pointerenter', on);
        row?.addEventListener('pointerleave', off);
        thumbCleanups.push(() => {
          row?.removeEventListener('pointerenter', on);
          row?.removeEventListener('pointerleave', off);
          lazy.destroy();
        });
        continue;
      }

      if (!src) {
        if (a.kind !== 'video') continue;
        const vid = document.createElement('video');
        vid.muted = true;
        vid.playsInline = true;
        vid.preload = 'metadata';
        vid.draggable = false;   // see the note on `img.draggable` below
        void mediaSrc(host, videoPreviewSrc(a)).then(url => { vid.src = url; });
        vid.addEventListener('error', () => vid.remove(), { once: true });
        holder.textContent = '';
        holder.append(vid);
        thumbCleanups.push(() => {
          vid.removeAttribute('src');
          vid.load();
          vid.remove();
        });
        continue;
      }
      const img = document.createElement('img');
      img.alt = '';
      /**
       * `draggable = false`, AND THIS IS LOAD-BEARING.
       *
       * An `<img>` is draggable by DEFAULT. The browser makes the nearest
       * draggable element the drag source, so grabbing a tile by its picture —
       * which is where everyone grabs it — started a NATIVE IMAGE drag with the
       * `<img>` as `event.target`. Pragmatic looks the target up in its registry
       * by exact element (`element-adapter.js:72`, no `closest()`), found
       * nothing, and bailed: our payload was never attached and the drop did
       * nothing at all. Worse, that native drag still carries `text/uri-list`,
       * which AFFiNE's own drop handling will happily turn into a block — two
       * drag systems acting on one gesture, which is what a duplicate looks like.
       *
       * Turning it off makes the TILE the only drag source, always.
       */
      img.draggable = false;
      // Authenticated fetch + Cache API — a bare <img src> 401s on a signed URL.
      thumbCleanups.push(loadThumbInto(host, img, src, () => img.remove()));
      holder.textContent = '';
      holder.append(img);
    }
  }

  /**
   * Click-to-preview, matching the video editor's overlay.
   *
   * Video prefers the server's 720p proxy — skimming a library must not pull a
   * 4K master — and falls back to the original when there is none. Both video
   * and audio srcs are resolved through `mediaSrc`, which absolutises the URL
   * and appends the `?t=` token: an element `src` cannot send an Authorization
   * header, and without this they simply 404.
   */
  function openPreview(startAt: AssetItem) {
    // Navigate the CURRENT result set, so ← / → walk exactly what the user is
    // looking at — the same filter, the same order, no surprises.
    let idx = Math.max(0, results.findIndex(r => r.id === startAt.id));
    const prev = document.createElement('div');
    prev.className = 'vs-preview';
    // The full-size image needs the SAME authenticated fetch as the thumbnails.
    // A bare <img src> on a signed library URL 401s — which showed up as a
    // preview that opened correctly and then displayed nothing.
    let thumbDispose: (() => void) | null = null;
    /** The live block render, when the current item is a block. */
    let blockPreview: PreviewHandle | null = null;

    // The src is attached after mount, not inlined: resolving it needs a fresh
    // auth token, which is async.
    function bodyFor(a: AssetItem): string {
      // A BLOCK IS RUN, NOT PLAYED. There is no file to open — the preview is
      // the composition rendering, which is also the only honest way to show
      // something whose whole point is motion and layout.
      if (a.kind === 'block') return `<div class="vs-blockprev" data-preview-block></div>`;
      return a.kind === 'image'
        ? `<img data-preview-img alt="" />`
        : a.kind === 'video'
          ? `<video data-preview-media controls autoplay playsinline></video>`
          : `<audio data-preview-media controls autoplay></audio>`;
    }

    /** Paint index `idx`. Re-rendering only the box keeps the backdrop stable. */
    function paint() {
      const a = results[idx];
      if (!a) return;
      thumbDispose?.();
      thumbDispose = null;
      // Paging off a block must stop its iframe: a left-running composition
      // keeps animating behind the next asset, which is both a wasted frame
      // budget and, for a block with audio-reactive motion, visibly wrong.
      blockPreview?.destroy();
      blockPreview = null;
      prev.innerHTML = `<div class="vs-preview__box" role="dialog" aria-label="Preview">
          <div class="vs-preview__head">
            <span>${(a.label || a.kind)}</span>
            <span class="vs-preview__count">${idx + 1} / ${results.length}</span>
            <button type="button" data-a="prev-add">${a.kind === 'block' ? 'Use on the selected shot' : 'Add to board'}</button>
            <button type="button" data-a="prev-close" aria-label="Close">✕</button>
          </div>
          <div class="vs-preview__body">
            <button type="button" class="vs-preview__nav vs-preview__nav--l" data-a="prev-back"
                    aria-label="Previous" ${idx === 0 ? 'disabled' : ''}>‹</button>
            ${bodyFor(a)}
            <button type="button" class="vs-preview__nav vs-preview__nav--r" data-a="prev-next"
                    aria-label="Next" ${idx >= results.length - 1 ? 'disabled' : ''}>›</button>
          </div>
        </div>`;

      // Video/audio: 720p proxy when one exists, then token-resolved.
      const pmedia = prev.querySelector<HTMLMediaElement>('[data-preview-media]');
      if (pmedia) {
        const wanted = a.id;
        void mediaSrc(host, videoPreviewSrc(a)).then(src => {
          // The user may have paged on with ← / → while the token resolved;
          // assigning then would play the wrong asset.
          if (results[idx]?.id !== wanted) return;
          pmedia.src = src;
        });
        pmedia.addEventListener('error', () => {
          pmedia.replaceWith(Object.assign(document.createElement('p'), {
            className: 'vs-preview__fail',
            textContent: 'Preview unavailable — this asset is missing from storage.',
          }));
        }, { once: true });
      }

      const pblock = prev.querySelector<HTMLElement>('[data-preview-block]');
      if (pblock) {
        // Its DEFAULTS, deliberately: the panel is where you decide whether a
        // design fits, and the designer's demo content is what shows the design.
        // Filled values belong on the shot card, where they are this scene's.
        blockPreview = mountBlockPreview(pblock, a.label);
      }

      const pimg = prev.querySelector<HTMLImageElement>('[data-preview-img]');
      if (pimg) {
        // width 0 = the original: the overlay is where the user inspects detail.
        thumbDispose = loadThumbInto(host, pimg, a.url, () => {
          pimg.replaceWith(Object.assign(document.createElement('p'), {
            className: 'vs-preview__fail',
            textContent: 'Preview unavailable — the asset link may have expired.',
          }));
        }, 0);
      }
    }

    const step = (d: number) => {
      const next = idx + d;
      if (next < 0 || next >= results.length) return;
      idx = next;
      paint();
    };
    const close = () => {
      thumbDispose?.();
      blockPreview?.destroy();
      blockPreview = null;
      prev.remove();
      document.removeEventListener('keydown', onKey);
    };
    // Arrow keys as well as the buttons: flicking through a shortlist is the
    // whole point, and reaching for the mouse each time defeats it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    };
    document.addEventListener('keydown', onKey);

    prev.addEventListener('click', e => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
      const act = t?.dataset.a;
      if (act === 'prev-add') { host.addAsset?.(results[idx]); close(); return; }
      if (act === 'prev-back') { step(-1); return; }
      if (act === 'prev-next') { step(1); return; }
      if (act === 'prev-close' || e.target === prev) close();
    });

    paint();
    container.append(prev);
  }

  let results: AssetItem[] = [];
  let total = 0;
  let seq = 0;
  let authRetried = false;
  /** Quick filter + the personal signals that decide which chips are worth
   *  showing. Only meaningful for the media-library scope. */
  let quick: QuickFilter = 'none';
  let personal: PersonalCounts = { favorite: 0, rated: 0, used: 0 };
  let uploading = false;
  /** Starred ids, held locally so a tick flips instantly and reverts if the
   *  write fails. Only the media-library scope has personal signals. */
  const favourites = new Set<string>();
  /** Subscribed to `onParentToken` after an auth failure — see the catch below. */
  let authWaiting = false;
  let stopAuthWait: (() => void) | null = null;

  /**
   * Draw the current results.
   *
   * Extracted so the FIRST paint and a background revalidation render through
   * exactly the same path. When they were separate, a refreshed page could be
   * drawn slightly differently from the one it replaced — the kind of difference
   * nobody notices until a tile stops being draggable.
   */
  function paint(listEl: HTMLElement, semantic: boolean): void {
    if (!results.length) {
      // NAME THE REASON. "Nothing here yet" under Blocks · My files is true
      // and useless — the 128 shipped blocks are one pill away.
      const why = kind === 'block'
        ? (scope === 'generated' || scope === 'mine'
          ? `You haven’t made any blocks yet. Try ${SCOPE_LABEL.shared} for the ones that ship with Voidspace.`
          : scope === 'project'
            ? 'No shot on this board uses a block yet.'
            : 'No blocks found. They live in ~/Voidspace/.hyperframes/blocks.')
        : 'Nothing here yet.';
      listEl.innerHTML = `<p class="vs-assets__muted">${why}</p>`;
      return;
    }
    // Recency sections come from the CORE, so the board, video and image
    // editors bucket identically — change it once, it lands in all three.
    const sections = groupByRecency(results);
    listEl.innerHTML =
      (semantic ? '<p class="vs-assets__note">Matched by meaning</p>' : '') +
      sections.map(sec =>
        `<p class="vs-assets__section">${sec.bucket}<span class="vs-assets__count">(${sec.items.length})</span></p>` + sec.items.map(tile).join(''),
      ).join('') +
      (hasMore(results.length, total)
        ? `<button type="button" class="vs-assets__more" data-a="more">Load more (${results.length} of ${total})</button>`
        : '');
    hydrateThumbs();
  }

  async function load(opts?: { append?: boolean }) {
    const listEl = el.querySelector<HTMLElement>('[data-a="list"]');
    if (!listEl) return;
    const mine = ++seq;
    const append = opts?.append === true;
    // A spinner only when there is genuinely nothing to look at. Blanking a list
    // that is about to be replaced by the same list is the flicker being fixed.
    if (!append && !results.length) {
      listEl.innerHTML = '<p class="vs-assets__muted">Searching…</p>';
    }
    try {
      const q = {
        scope, kind, q: query, quick, limit: PAGE_SIZE,
        offset: append ? nextOffset(results.length) : 0,
      };

      /**
       * CACHED, AND ONLY BLANK THE LIST WHEN THERE IS NOTHING TO SHOW.
       *
       * This used to clear straight to "Searching…" and go to the network on
       * every scope switch, every type pill and every reopen of the panel —
       * including for a list it had just rendered. On a large library that is a
       * visible stall on an action taken dozens of times an hour, and it reads
       * as the app being slow rather than as a missing cache.
       *
       * The spinner now appears only when nothing can be drawn instead of it.
       * `onFresh` fires solely when the revalidated page actually DIFFERS, so a
       * repeat visit does not repaint an identical grid and throw away the
       * user's scroll position.
       */
      const cached = await fetchAssetsCached(host, q, (fresh: AssetPage) => {
        if (mine !== seq) return;          // superseded while revalidating
        results = append ? mergePage(results, fresh.items) : fresh.items;
        total = fresh.total;
        paint(listEl, fresh.semantic === true);
      });
      const page = cached.page;
      if (mine !== seq) return; // a newer search superseded this one
      // mergePage dedupes by source URL — the same file legitimately appears
      // through more than one source, and showing it twice looks like a bug.
      results = append ? mergePage(results, page.items) : page.items;
      total = page.total;

      paint(listEl, page.semantic === true);
    } catch (e) {
      if (mine !== seq) return;
      const msg = (e as Error).message;

      // AUTH RACE, retried once. The panel renders as soon as the board mounts,
      // which can be BEFORE the parent page has registered its token handler —
      // so the first ask times out, we send no Authorization header, and the
      // library answers 401. That is a startup ordering artefact, not a signed-out
      // user, and showing it as a hard failure makes a working library look broken.
      // The 1.2 s retry below is a GUESS at how long the parent needs, and the
      // guess loses whenever restoring the Firebase session is slower than that
      // — the common case on a cold load. So we also wait for the token ITSELF:
      // `onParentToken` fires the instant one arrives (asked for or pushed),
      // which is a fact rather than an estimate.
      if (isAuthError(msg)) {
        listEl.innerHTML = '<p class="vs-assets__muted">Connecting…</p>';
        if (!authWaiting) {
          authWaiting = true;
          stopAuthWait = onParentToken(() => {
            stopAuthWait?.();
            stopAuthWait = null;
            authWaiting = false;
            void load();
          });
        }
        if (!authRetried) {
          authRetried = true;
          setTimeout(() => { void load(); }, 1200);
        }
        return;
      }

      // Otherwise say it FAILED. "No results" for a failed request is
      // indistinguishable from an empty library — the worst thing to show.
      listEl.innerHTML = `<p class="vs-assets__muted">Couldn’t load — ${msg}</p>`;
    }
  }

  /**
   * ADD A FILE TO THE LIBRARY.
   *
   * The board could browse the library and never put anything into it, so the
   * only way in from this surface was to leave and use another one. Posts to
   * the same `/api/media-library/upload` the video editor's Add uses — one
   * ingest path, one dedupe, one ownership rule — then lands the user on the
   * scope the file went to so they can SEE it arrive.
   */
  async function addMediaFromDisk(): Promise<void> {
    if (uploading) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,video/*,audio/*';
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return;
      uploading = true;
      const listEl = el.querySelector('[data-a="list"]') as HTMLElement | null;
      if (listEl) listEl.innerHTML = `<p class="vs-assets__muted">Adding ${files.length} file${files.length === 1 ? '' : 's'}…</p>`;
      // ONE ingest path, shared with the video editor: same dedupe, same
      // ownership rule, same per-file isolation so a bad file loses only itself.
      const { ok, failed } = await uploadToLibrary(host, files, (done, total, name) => {
        if (listEl) listEl.innerHTML = `<p class="vs-assets__muted">Adding ${done + 1}/${total} — ${esc(name)}…</p>`;
      });
      for (const name of failed) toast(`Could not add ${name}`, 'error');
      uploading = false;
      if (ok) {
        toast(`Added ${ok} file${ok === 1 ? '' : 's'} to your library`, 'info');
        // The upload lands in the media library, so show that scope — telling
        // someone it worked while they stare at an unchanged grid is not
        // telling them it worked.
        scope = 'mine';
        invalidateAssetCache();
        void refreshPersonal();
      }
      render();
    };
    input.click();
  }

  /** Personal signals, refreshed so the chips appear the moment they mean
   *  something (a first star, a first use) rather than on the next reload. */
  async function refreshPersonal(): Promise<void> {
    const next = await fetchPersonalCounts(host);
    const changed = next.favorite !== personal.favorite || next.used !== personal.used;
    personal = next;
    if (changed) render();
  }

  function render() {
    el.classList.toggle('is-collapsed', collapsed);
    // Collapsed width is fixed by CSS; expanded honours the user's drag.
    el.style.width = collapsed ? '' : `${width}px`;
    el.innerHTML = shell();
    if (!collapsed) void load();
  }

  /**
   * The one way the panel opens or shuts, whatever asked.
   *
   * IT DOES NOT TOUCH THE VIEWPORT, and that is the point.
   *
   * This used to call `fitBoard()`, on the theory that the storyboard should
   * re-frame itself to clear the panel's new width. In use that is the wrong
   * trade every time: putting a panel away is a chrome gesture, and answering
   * it by re-zooming and re-panning the whole board throws away the framing the
   * user had chosen — you close a panel to see more of the shot you were
   * looking at, and the shot is gone. The same applied to the resize grip
   * below, where every drag ended in a jump.
   *
   * Nothing needs to move: this panel is `position: absolute` OVER the canvas
   * (see `.vs-assets`), so collapsing it changes no layout the editor can see.
   * The canvas is exactly as it was and 276 more pixels of it are simply
   * visible. Content that was under the panel comes out from under it — which
   * is what "I closed the panel" means.
   *
   * Re-framing that responds to CONTENT — the agent drafting a storyboard,
   * `Fit`, a new shot — is untouched and still lives in `viewport.ts`.
   */
  function setCollapsed(next: boolean) {
    if (next === collapsed) return;
    collapsed = next;
    savePanelCollapsed('assets', collapsed);
    render();
  }

  /**
   * Tab — the same "clear the panels away" gesture the video and image editors
   * bind, on the surface that has exactly one panel to clear.
   *
   * CAPTURE PHASE, and that is not a style choice. BlockSuite's
   * `UIEventDispatcher` binds keydown on `editor-host` and stops propagation,
   * so with the canvas focused — which is nearly always, on a board — a
   * bubble-phase listener on `window` is never reached and the key silently
   * does nothing. Capture runs before the host sees the event at all.
   *
   * The guard is therefore doing real work: capture would otherwise steal Tab
   * from every field on the surface. BlockSuite notes are contenteditable and
   * Tab indents a list item inside one; a card title and the panel's own search
   * box are ordinary inputs. `isTypingTarget` is the shared predicate, so all
   * three editors agree on what "the user is typing" means, and we do NOT
   * preventDefault when it trips — focus still moves and lists still indent the
   * way they always did.
   */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    setCollapsed(!collapsed);
  };
  window.addEventListener('keydown', onKeyDown, true);

  /**
   * Drag the right edge to resize.
   *
   * Pointer events (not mouse) so a trackpad or pen works, and the pointer is
   * CAPTURED — without capture a fast drag outside the 6px grip drops the
   * gesture and the panel sticks at whatever width the cursor last crossed.
   * The width is clamped in the core, so a drag can never produce an unusable
   * panel or one that eats the canvas.
   */
  el.addEventListener('pointerdown', e => {
    const t = e.target as HTMLElement;
    if (t.dataset?.a !== 'grip' || collapsed) return;
    e.preventDefault();
    t.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => {
      width = clampPanelWidth(startW + (ev.clientX - startX));
      el.style.width = `${width}px`;
    };
    const onUp = () => {
      t.releasePointerCapture(e.pointerId);
      t.removeEventListener('pointermove', onMove);
      t.removeEventListener('pointerup', onUp);
      savePanelWidth(width);
      // NO RE-FIT. Dragging a panel edge used to end in the whole storyboard
      // zooming and panning to a new framing — a jump at the end of every
      // drag, and the framing the user had was lost. See `setCollapsed`: the
      // panel floats over the canvas, so its width changes nothing the canvas
      // has to react to.
    };
    t.addEventListener('pointermove', onMove);
    t.addEventListener('pointerup', onUp);
  });

  el.addEventListener('click', e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
    if (!t) return;
    const a = t.dataset.a;
    if (a === 'toggle') { setCollapsed(!collapsed); }
    else if (a === 'scope') { scope = t.dataset.v as AssetScope; render(); }
    else if (a === 'kind') {
      kind = t.dataset.v as AssetKind | 'all';
      /**
       * LAND THE USER WHERE THE BLOCKS ARE.
       *
       * The panel opens on "My files", and almost nobody has authored a block
       * yet — so clicking Blocks showed an empty list and read as "this feature
       * is broken" on an install with 128 of them. Move to the first scope that
       * actually holds some, once, and leave the pills alone after that so a
       * deliberate choice of an empty scope still sticks.
       */
      if (kind === 'block' && !host.blockSource?.list({ scope, kind }).length) {
        const found = (['mine', 'shared'] as const)
          .find(sc => host.blockSource?.list({ scope: sc, kind: 'block' }).length);
        if (found) scope = found;
      }
      render();
    }
    else if (a === 'view') {
      viewMode = t.dataset.v as ViewMode;
      saveViewMode(viewMode);
      render();
    }
    else if (a === 'star') {
      e.stopPropagation();
      const id = t.dataset.id || '';
      const next = !favourites.has(id);
      // Flip first: a star that waits for a round trip feels broken. Reverted
      // below if the write is refused.
      if (next) favourites.add(id); else favourites.delete(id);
      personal = { ...personal, favorite: Math.max(0, personal.favorite + (next ? 1 : -1)) };
      render();
      void setAssetFavourite(host, id, next).then(ok => {
        if (ok) return;
        if (next) favourites.delete(id); else favourites.add(id);
        personal = { ...personal, favorite: Math.max(0, personal.favorite + (next ? -1 : 1)) };
        toast('Could not save that star', 'error');
        render();
      });
    }
    else if (a === 'quick') {
      const next = (t.dataset.v || 'none') as QuickFilter;
      quick = next === quick ? 'none' : next;
      render();
    }
    else if (a === 'refresh') {
      // Drop the cached page as well as refetching — a plain reload would be
      // served straight back out of the cache the refresh exists to bypass.
      invalidateAssetCache();
      void refreshPersonal();
      render();
    }
    else if (a === 'add-media') { void addMediaFromDisk(); }
    else if (a === 'more') { void load({ append: true }); }
    else if (a === 'add') {
      e.stopPropagation();
      const item = results.find(r => r.id === t.dataset.id);
      if (item) host.addAsset?.(item);
    }
    else if (a === 'item') {
      const item = results.find(r => r.id === t.dataset.id);
      if (item) openPreview(item);
    }
  });

  el.addEventListener('keyup', e => {
    const t = e.target as HTMLElement;
    if (t.dataset?.a !== 'q') return;
    if ((e as KeyboardEvent).key !== 'Enter') return;
    query = (t as HTMLInputElement).value;
    void load();
  });

  /**
   * ONE DROP TARGET FOR THE WHOLE BOARD.
   *
   * Registered on the viewport, and where the pointer landed decides what
   * happens: onto a shot it joins that shot's media, onto open canvas it becomes
   * an ordinary block. `shot/drop.ts` makes that decision, and it is the ONLY
   * place that does — a second target registered per shot would mean two
   * handlers racing for one gesture, which is the exact shape of the duplication
   * bug this rewrite removes.
   *
   * Through BlockSuite's own DnD, not raw HTML5 `drop`. The earlier build
   * listened for a native `drop` on `.affine-edgeless-viewport` — an ANCESTOR of
   * the editor host — while BlockSuite bound its own `_nativeDrop` on the host
   * (`event/control/pointer.ts:386`). Two drag systems over one canvas is why
   * there were two drag previews and, sometimes, two blocks.
   */
  /** Gestures already handled. Bounded, because a long session drags a lot. */
  const handledDrags = new Set<string>();
  /** The shot currently lit up, so the highlight can be cleared when the pointer
   *  leaves it — a highlight that outlives the drag reads as a stuck panel. */
  let litShot: string | null = null;

  function lightShot(shotId: string | null, zone: string | null): void {
    if (litShot && litShot !== shotId) {
      (board.std.view.getBlock(litShot) as { setDropTarget?: (z: string | null) => void } | null)
        ?.setDropTarget?.(null);
    }
    litShot = shotId;
    if (!shotId) return;
    (board.std.view.getBlock(shotId) as { setDropTarget?: (z: string | null) => void } | null)
      ?.setDropTarget?.(zone);
  }

  const canvasEl = container.querySelector<HTMLElement>('.affine-edgeless-viewport');
  const disposeDrop = canvasEl
    ? board.std.dnd.dropTarget<AssetDragEntity | BlockDragEntity>({
        element: canvasEl,
        canDrop: ({ source }) => {
          const t = (source.data as DragPayload<AssetDragEntity | BlockDragEntity>).bsEntity?.type;
          return t === ASSET_DRAG_TYPE || t === BLOCK_DRAG_TYPE;
        },

        /**
         * SHOW WHERE IT WILL LAND, BEFORE IT LANDS.
         *
         * Computed by the same function that performs the drop, so the zone that
         * lit up is provably the zone that receives it. A highlight derived
         * separately is worse than none: it teaches the user a rule the drop does
         * not follow.
         */
        onDrag: ({ source, location }) => {
          const { clientX, clientY } = location.current.input;
          const hit = dropZoneAt(board.std, clientX, clientY);
          // A BLOCK has no slot — it replaces what the whole shot IS — so the
          // card lights up as one target rather than highlighting a media well
          // the drop will not use.
          const isBlock =
            (source.data as DragPayload<AssetDragEntity | BlockDragEntity>).bsEntity?.type
              === BLOCK_DRAG_TYPE;
          lightShot(hit?.shotId ?? null, isBlock ? null : (hit?.zone ?? null));
        },

        /**
         * ONE INSERT PER GESTURE — see `AssetDragEntity.dragId`.
         *
         * `setDragData` runs exactly once per drag, so the id identifies a
         * GESTURE rather than a moment. A redelivery of the same drop carries the
         * same id and is provably a duplicate. This is deliberately not the
         * "ignore anything within 400 ms" guard that was tried and removed: that
         * one could swallow a genuine second drop, and it hid the real cause for
         * several sessions.
         */
        onDrop: ({ source, location }) => {
          lightShot(null, null);
          const raw = (source.data as DragPayload<AssetDragEntity | BlockDragEntity>).bsEntity;
          if (!raw) return;
          if (raw.dragId && handledDrags.has(raw.dragId)) return;
          if (raw.dragId) handledDrags.add(raw.dragId);
          const { clientX: bx, clientY: by } = location.current.input;

          /**
           * A BLOCK CHANGES WHAT THE SHOT IS, so it never reaches the media
           * path. Synchronous — there is nothing to fetch and nothing to place,
           * only two props to write — so unlike a media drop it needs no
           * progress toast, just the confirmation.
           */
          if (raw.type === BLOCK_DRAG_TYPE) {
            const out = handleBlockDrop(board.std, raw, { clientX: bx, clientY: by });
            toast(
              out.target === 'shot'
                ? `${raw.label || raw.name} → ${out.title}`
                : out.reason,
              out.target === 'shot' ? 'info' : 'error',
            );
            return;
          }

          const entity = raw;
          if (!entity.media) return;
          const { clientX, clientY } = location.current.input;
          void handleAssetDrop(
            board.std,
            entity,
            { clientX, clientY },
            // Hand AFFiNE the SCREEN point — `addImages` converts it itself.
            // Converting here too would double-transform and land it elsewhere.
            (media, point) => placeOnCanvas(board, media, point),
          ).then(outcome => {
            if (outcome.target === 'shot') {
              toast(`Added to ${readShot(board.std, outcome.shotId!)?.title || 'the shot'}`, 'info');
            }
          });
        },
      })
    : () => {};

  render();
  // Personal signals decide which quick-filter chips exist, so ask once on
  // mount rather than waiting for the user to hit refresh.
  void refreshPersonal();

  /**
   * Keep "In this board" live.
   *
   * It is derived from the shots, so it goes stale the instant one gains or
   * loses media — and a reuse list that does not show what you just added is
   * worse than no list, because you go and find the thing in the library again.
   * Only while that scope is showing, and debounced: `blockUpdated` fires on
   * every pointermove of a drag.
   */
  let projectRefresh: ReturnType<typeof setTimeout> | null = null;
  const sub = board.store.slots.blockUpdated.subscribe(() => {
    if (scope !== 'project' || collapsed) return;
    if (projectRefresh) clearTimeout(projectRefresh);
    projectRefresh = setTimeout(() => { projectRefresh = null; void load(); }, 250);
  });

  /**
   * The block library arrives AFTER first paint — the parent page fetches it
   * and pushes it in — so a user who reaches the Blocks pill inside that window
   * would be told, wrongly, that they have none. Reload when it lands, and only
   * when it is what is on screen.
   */
  const disposeBlocks = onBlockCatalogue(() => {
    /**
     * THE CATALOGUE CHANGING IS A LIBRARY MUTATION, so the cache must forget it.
     *
     * The board never writes to the library itself, but the agent does — saving
     * a block, adopting one, deleting one — and the catalogue push is how that
     * arrives here. Reloading without dropping the cached page would re-render
     * the list from before the change and make the user's own action look like
     * it did not happen, which is worse than a slow list.
     */
    invalidateAssetCache();
    if (kind === 'block' && !collapsed) void load();
  });

  return () => {
    disposeDrop();
    lightShot(null, null);
    sub.unsubscribe?.();
    disposeBlocks();
    window.removeEventListener('keydown', onKeyDown, true);
    // A panel torn down while still waiting for a token must not reload into a
    // detached DOM when one finally arrives.
    stopAuthWait?.();
    stopAuthWait = null;
    if (projectRefresh) clearTimeout(projectRefresh);
    thumbCleanups.forEach(fn => fn());
    el.remove();
  };
}
