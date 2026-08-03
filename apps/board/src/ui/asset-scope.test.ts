/**
 * The seam between the tab names and what gets written into a board.
 *
 * ── WHY THIS TEST IS THE IMPORTANT ONE IN THIS CHANGE ────────────────────────
 * The asset panel's tabs were renamed because they disagreed with the video
 * editor's: this panel called AI generations "My files" and the on-disk media
 * library "Library", while the video editor called generations "Generated" and
 * the media library "My files". Same words, different sources, depending on
 * which editor you had open.
 *
 * Renaming a tab is cosmetic. Renaming the value STORED on a media ref is not —
 * it says which library an id belongs to, boards already on disk carry it, and
 * compile reads it. Move its meaning and every board ever saved silently
 * re-attributes its media to a library it never came from, with nothing on
 * screen to show it happened.
 *
 * So the UI vocabulary moved and the stored vocabulary did not, and this is what
 * holds those two apart.
 */
import { describe, expect, it } from 'vitest';

import { persistedScope } from './asset-panel';

describe('what gets written into a board', () => {
  /**
   * The tab is called "Generated" now and was called "My files" before. Both
   * read `/api/studio/library`, and that id space has always been stored as
   * `mine` — so that is what must still be written.
   */
  it('stores generations as `mine`, the name they have always had on disk', () => {
    expect(persistedScope('generated')).toBe('mine');
  });

  /**
   * The tab is called "My files" now and was called "Library" before. Both read
   * the media library, whose id space has always been stored as `shared`.
   */
  it('stores the media library as `shared`, whatever the tab is called', () => {
    expect(persistedScope('mine')).toBe('shared');
  });

  /**
   * A published asset IS a media-library asset — same ids, same URLs — just one
   * somebody else owns. So the new Shared tab needs no new stored value, which
   * is why adding it required no migration.
   */
  it('stores another creator’s asset in the same space as the media library', () => {
    expect(persistedScope('shared')).toBe('shared');
  });

  it('leaves the browser scope alone', () => {
    expect(persistedScope('device')).toBe('device');
  });

  /**
   * ANYTHING UNRECOGNISED FALLS TO THE GENERATIONS SPACE, which is where a board
   * saved before any of this would have pointed. Failing to a scope means a
   * lookup in the wrong id space; failing to the historical default means an old
   * board keeps resolving exactly as it did.
   */
  it('treats an unknown or missing scope as the historical default', () => {
    expect(persistedScope(undefined)).toBe('mine');
    expect(persistedScope('project')).toBe('mine');
    expect(persistedScope('something-from-the-future')).toBe('mine');
  });

  /** The stored vocabulary is exactly three values, and this is the whole set. */
  it('never writes a value outside what boards already understand', () => {
    const allowed = new Set(['mine', 'shared', 'device']);
    for (const ui of ['project', 'generated', 'mine', 'shared', 'device', '', undefined]) {
      expect(allowed.has(persistedScope(ui as string)), `${ui} produced an unstorable scope`).toBe(true);
    }
  });
});
