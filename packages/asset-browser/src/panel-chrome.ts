/**
 * PANEL CHROME — one description of how a side panel opens and closes, for
 * every editor.
 *
 * WHY THIS FILE EXISTS
 * Four surfaces grew a side panel independently and each invented its own way
 * to hide it:
 *
 *   • the board  — a ◂ text glyph inside the "Assets" title, collapsing to a
 *                  38px rail;
 *   • the image editor — two lucide buttons in the TOP TOOLBAR, unmounting the
 *                  panel entirely (so the only way back was the toolbar);
 *   • the video editor — nothing at all; the control was deleted as "always in
 *                  the way", which left the Assets and Inspector columns
 *                  permanently fixed;
 *   • the studio shell — the agent chat could hide the EDITOR but never itself.
 *
 * Same gesture, four answers, three of them in a different place on screen.
 * That is the thing a user actually notices moving between editors — long
 * before they notice a font.
 *
 * So the RULE lives here, once:
 *
 *   1. The collapse control is the LAST item in the panel's own top row, on the
 *      panel's outer edge. Not in the toolbar — the control belongs to the
 *      thing it closes.
 *   2. Collapsing NEVER unmounts. The panel becomes a `PANEL_RAIL_PX` rail
 *      carrying the same button, mirrored. A panel you cannot see must still be
 *      a panel you can find.
 *   3. The glyph is lucide's panel-left/right-close/open, at 16px. Directional,
 *      so the icon says which way the panel goes.
 *   4. The choice is remembered per panel, across sessions and surfaces.
 *
 * WHY THE MARKUP IS HERE AND NOT ONLY IN REACT
 * The board is plain DOM (it lives inside BlockSuite and must not join a React
 * render cycle), so it cannot import the React button. It gets the same icon
 * from `PANEL_GLYPH` below — the same lucide path data the React components
 * render — rather than an approximation drawn by hand. `packages/ui`'s
 * `panel-chrome.tsx` is the React half; the two are pinned together by
 * `panel-chrome.test.ts`, which reads that file and fails if the rail width or
 * the icon set drifts.
 */

/**
 * Width of a collapsed panel, in px.
 *
 * Wide enough for a 28px button with 8px of breathing room either side, narrow
 * enough that nobody would mistake the rail for content. Every surface uses this
 * number for both sides, so the editor canvas starts and ends in the same place
 * whichever editor you are in.
 */
export const PANEL_RAIL_PX = 44;

/** Which edge a panel is docked to. Decides which glyph points which way. */
export type PanelSide = 'left' | 'right';

/**
 * The four states of the control, keyed the way lucide names them.
 *
 * A LEFT panel that is open shows `left-close` (chevron pointing left, "push it
 * away"); collapsed it shows `left-open` (chevron pointing right, "bring it
 * back"). The mirror image on the right. The icon therefore always points in
 * the direction the panel is about to move, which is the only version of this
 * control people read correctly without a tooltip.
 */
export type PanelGlyph =
  | 'left-close' | 'left-open'
  | 'right-close' | 'right-open';

/** The glyph a panel on `side` should show given its current state. */
export function panelGlyph(side: PanelSide, collapsed: boolean): PanelGlyph {
  return `${side}-${collapsed ? 'open' : 'close'}` as PanelGlyph;
}

/**
 * lucide 0.555 path data, inlined for hosts that cannot import lucide-react.
 *
 * Copied verbatim from `lucide-react/dist/esm/icons/panel-*.js` (ISC). Rendered
 * with lucide's own default attributes — 24×24 viewBox, no fill, 2px round
 * stroke — so a board button and a video-editor button are the same pixels.
 */
const PANEL_PATHS: Record<PanelGlyph, string> = {
  'left-close': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
  'left-open': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>',
  'right-close': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/>',
  'right-open': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m10 15-3-3 3-3"/>',
};

/** Complete `<svg>` markup for a glyph, at `size` px. For non-React hosts. */
export function panelIconSvg(glyph: PanelGlyph, size = 16): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PANEL_PATHS[glyph]}</svg>`;
}

/** Every glyph as ready-to-use markup — convenient for template literals. */
export const PANEL_GLYPH: Record<PanelGlyph, string> = {
  'left-close': panelIconSvg('left-close'),
  'left-open': panelIconSvg('left-open'),
  'right-close': panelIconSvg('right-close'),
  'right-open': panelIconSvg('right-open'),
};

/**
 * The tooltip, worded the same everywhere.
 *
 * Names the PANEL rather than the direction ("Hide Assets", not "Collapse left
 * panel"), because a user knows what they want gone, not which side it is on.
 */
export function panelToggleTitle(name: string, collapsed: boolean): string {
  return collapsed ? `Show ${name}` : `Hide ${name}`;
}

/** Tooltip for the one control that closes or opens every panel at once. */
export function allPanelsToggleTitle(anyOpen: boolean): string {
  return anyOpen ? 'Hide all panels (Tab)' : 'Show all panels (Tab)';
}

/**
 * Whether a keystroke should be allowed to move panels.
 *
 * Tab is the Photoshop/Figma gesture for "get the panels out of my way", and it
 * is also how you indent a list item and how you leave a text field. Anything
 * typed INTO something is off limits — including BlockSuite's contenteditable
 * blocks on the board, which is why this checks `isContentEditable` and not
 * just the tag name.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el !== 'object' || !('tagName' in el)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Remembered collapse state, keyed per panel.
 *
 * One namespace, and the id names the panel's ROLE rather than the surface —
 * `assets`, `agent` — so two surfaces showing the same panel share the
 * preference instead of each forgetting the other's. A panel that is genuinely
 * particular to one editor gets its own id.
 *
 * The video editor is the exception: its panel state (visible / width /
 * collapsed) already lives in a persisted zustand store, so it keeps that as
 * its source of truth rather than holding the same flag in two places. What it
 * shares with the others is the CONTROL and the behaviour, which is the part a
 * user sees.
 */
const COLLAPSE_KEY = (id: string) => `voidspace.panels.${id}.collapsed`;

export function loadPanelCollapsed(id: string, fallback = false): boolean {
  try {
    const v = localStorage.getItem(COLLAPSE_KEY(id));
    return v === null ? fallback : v === '1';
  } catch {
    return fallback; // private mode / no storage — the session still works
  }
}

export function savePanelCollapsed(id: string, collapsed: boolean): void {
  try { localStorage.setItem(COLLAPSE_KEY(id), collapsed ? '1' : '0'); } catch { /* non-fatal */ }
}
