/**
 * Safe reads for the two media-item fields the asset browser sorts, filters and
 * keys on.
 *
 * WHY THIS EXISTS
 * A single media item that arrived without a `name` used to take the entire
 * Assets panel down. `item.name.toLowerCase()` (the search filter) and
 * `a.name.localeCompare(b.name)` (the section sort) both throw on undefined,
 * React unmounted the panel, and the user got
 *   "Assets Panel failed to load. Please refresh the page."
 * — advice that could never work, because the offending item is persisted in
 * the project and every reload replayed the same crash.
 *
 * One malformed row must cost the user that row, not their asset browser.
 * Every read of a media name or id in the asset browser goes through here.
 */

/** Display name of a media item — ALWAYS a non-empty string. */
export function mediaName(item: { name?: unknown } | null | undefined): string {
  return typeof item?.name === "string" && item.name ? item.name : "Untitled";
}

/** Id of a media item — ALWAYS a string (empty when it has none). */
export function mediaId(item: { id?: unknown } | null | undefined): string {
  return typeof item?.id === "string" && item.id ? item.id : "";
}
