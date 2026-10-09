/**
 * Live-swap authority (URL-keyed) — see the long note above its use in App.tsx.
 *
 * A clip whose media was swapped in this session (by the chat's
 * replace-clip-media, the BGM approve, or the person's own Alt+drop) must not
 * be flipped back by a project rebuild that still carries the OLD media. The
 * swap records the URL it chose; the rebuild merge refuses to point the clip at
 * a different URL until a durable source catches up or the TTL ends.
 *
 * Lives in its own module so the timeline can record a swap too — a take
 * replaced by hand on a board-linked clip used to revert on the next rebuild.
 */
export const liveSwapAuthority = new Map<string, { url: string; at: number }>();
export const LIVE_SWAP_AUTHORITY_TTL_MS = 120_000;
export const normSwapUrl = (u: unknown): string => String(u || "").split(/[?#]/)[0];
export function recordLiveSwap(clipId: string, url: string): void {
  if (!clipId || !url) return;
  liveSwapAuthority.set(clipId, { url: normSwapUrl(url), at: Date.now() });
}
