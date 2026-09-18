/**
 * FRAME TITLES THAT SCALE WITH THE BOARD.
 *
 * ── THE BUG, AS THE USER DESCRIBED IT ────────────────────────────────────────
 * "frame title pills must zoom accordingly, its always shown at same size which
 * is appearing as if its colliding."
 *
 * Exactly right, and better diagnosed than the spacing fix that was reached for
 * first. BlockSuite positions a frame's title in SCREEN space — it tracks the
 * frame's corner, but its font size and pill height are constants that never
 * change with zoom (`_updateStyle` sets transform, maxWidth, transformOrigin
 * and colour inline, and nothing else).
 *
 * So the pill is the same number of screen pixels at every zoom, while the
 * frame it labels is not. Fitting a tall board to the window puts the viewport
 * near 0.35, where a 700-unit frame draws 245px tall and the title still draws
 * ~22px — proportionally three times larger than it was designed to look, and
 * sitting on top of whatever is above it. Adding gaps between sections does not
 * fix that, because the overlap is a function of ZOOM and the gaps are fixed in
 * model space. At some zoom it always collides again.
 *
 * ── WHY IT IS CLAMPED AND NOT SIMPLY MULTIPLIED ──────────────────────────────
 * Pure scaling makes the title 7px at fit-zoom, which is the reason BlockSuite
 * pinned it in the first place: a label nobody can read is worse than one that
 * is slightly too big. So it scales with the viewport and stops at a floor that
 * is still legible, and at a ceiling so a zoomed-in frame does not get a banner.
 *
 * Applied as inline styles on the title element because the widget lives in a
 * shadow root — a page stylesheet cannot reach it — and because the properties
 * touched here are precisely the ones the widget never sets itself, so nothing
 * is being fought over.
 */
import type { BlockStdScope } from '@blocksuite/std';
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';

/** BlockSuite's own constants, which are what we are scaling away from. */
const BASE_FONT = 14;
const BASE_HEIGHT = 22;

/**
 * Below this the title stops being readable, which is the failure the fixed
 * size was avoiding. Above it, a zoomed-in frame would wear a banner.
 */
const MIN_SCALE = 0.45;
const MAX_SCALE = 1.4;

export function frameTitleScale(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, zoom));
}

/** Every frame title currently on screen, across all widget shadow roots. */
function titles(): HTMLElement[] {
  const out: HTMLElement[] = [];
  document.querySelectorAll('affine-frame-title-widget').forEach(widget => {
    widget.shadowRoot?.querySelectorAll('affine-frame-title')
      .forEach(el => out.push(el as HTMLElement));
  });
  return out;
}

export function applyFrameTitleScale(zoom: number): number {
  const scale = frameTitleScale(zoom);
  const els = titles();
  for (const el of els) {
    el.style.fontSize = `${(BASE_FONT * scale).toFixed(1)}px`;
    el.style.height = `${(BASE_HEIGHT * scale).toFixed(1)}px`;
    el.style.lineHeight = `${(BASE_HEIGHT * scale).toFixed(1)}px`;
    // The pill's padding has to come down with it or a small title sits in a
    // box the old size.
    el.style.padding = `0 ${(8 * scale).toFixed(1)}px`;
    el.style.borderRadius = `${(4 * scale).toFixed(1)}px`;
  }
  return els.length;
}

/**
 * Keep them in step with the viewport for the life of the board.
 *
 * Also runs on block changes: a frame drawn after the last zoom event would
 * otherwise mount at the unscaled size and stay there until someone scrolled.
 */
export function installFrameTitleScale(std: BlockStdScope): () => void {
  const gfx = std.get(GfxControllerIdentifier);
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      try { applyFrameTitleScale(gfx.viewport.zoom); } catch { /* never break the board over a label */ }
    });
  };

  const subs = [
    gfx.viewport.viewportUpdated.subscribe(schedule),
    std.store.slots.blockUpdated.subscribe(schedule),
  ];
  schedule();

  return () => {
    if (raf) cancelAnimationFrame(raf);
    for (const s of subs) {
      try { (s as unknown as { unsubscribe?: () => void }).unsubscribe?.(); } catch { /* ignore */ }
    }
  };
}
