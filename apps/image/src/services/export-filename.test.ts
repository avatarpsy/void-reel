/**
 * One name, two callers.
 *
 * The toolbar's Export and the agent's `img_export` both turn the same project
 * into the same deck. Each had its own sanitiser — different character classes,
 * different fallbacks ("presentation" vs "deck") — so the same project left the
 * editor under two different names depending on who asked. Nobody notices that
 * until they cannot find the file they just made.
 */
import { describe, it, expect } from 'vitest';

import { exportFileName } from './pptx-export';

describe('exportFileName', () => {
  it('keeps a normal name and adds the extension', () => {
    expect(exportFileName('Q3 Review', 'pptx')).toBe('Q3 Review.pptx');
    expect(exportFileName('Q3 Review', 'pdf')).toBe('Q3 Review.pdf');
  });

  it('keeps the characters a person actually types', () => {
    expect(exportFileName('Avatar Psy - Deck v2.1', 'pptx')).toBe('Avatar Psy - Deck v2.1.pptx');
  });

  /** Anything that would break a path on some OS is dropped, not escaped. */
  it('strips characters that are unsafe in a filename', () => {
    expect(exportFileName('Q3/Q4: "review" <draft>', 'pdf')).toBe('Q3Q4 review draft.pdf');
    expect(exportFileName('a\\b|c?d*e', 'pdf')).toBe('abcde.pdf');
  });

  it('falls back to one name, never two', () => {
    for (const empty of ['', '   ', undefined, '///', '???']) {
      expect(exportFileName(empty as any, 'pptx')).toBe('presentation.pptx');
    }
  });

  it('does not leave leading or trailing space before the extension', () => {
    expect(exportFileName('  Spaced  ', 'pdf')).toBe('Spaced.pdf');
  });
});
