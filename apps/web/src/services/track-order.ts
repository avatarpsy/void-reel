/**
 * Where a newly-derived track belongs in an existing timeline.
 *
 * Track order IS z-order. The shared compositor paints pixel tracks by
 * DESCENDING index, so a lower index draws later and therefore sits on top.
 * That makes "just append it" wrong in a way nothing reports: a track appended
 * to the end lands at the BOTTOM of the stack, so an overlay derived into a
 * project that already had a saved timeline composites behind the footage and
 * is simply never seen. Only a brand-new project — where the loader's own
 * ordering survives untouched — looks correct.
 *
 * The rule: put the incoming track immediately before the first existing track
 * that follows it in the freshly-derived order. That reproduces the loader's
 * intended layering while leaving any ordering the user arranged themselves
 * alone, because it only ever positions relative to tracks both sides agree on.
 */
export function freshTrackInsertIndex(
  mergedTrackIds: readonly string[],
  freshTrackIds: readonly string[],
  trackId: string,
): number {
  const freshIdx = freshTrackIds.indexOf(trackId);
  // Not in the fresh order at all — nothing to anchor against, so append.
  if (freshIdx < 0) return mergedTrackIds.length;

  const following = new Set(freshTrackIds.slice(freshIdx + 1));
  const at = mergedTrackIds.findIndex((id) => following.has(id));
  return at < 0 ? mergedTrackIds.length : at;
}
