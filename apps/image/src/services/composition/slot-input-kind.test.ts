/**
 * A single-line input silently destroys line breaks.
 *
 * Found on a real deck: the title slot held "Your ideas deserve\na face and a
 * voice" and the panel rendered "Your ideas deservea face and a voice" — the
 * newline gone AND the words either side joined. One keystroke in that field
 * would have committed the joined version back to the largest line of the deck.
 */
import { describe, it, expect } from 'vitest';
import { isMultilineSlot } from './slot-input-kind';

describe('isMultilineSlot', () => {
  it('is true when the VALUE already holds a line break', () => {
    expect(isMultilineSlot('Your ideas deserve\na face and a voice', 'A digital you')).toBe(true);
  });

  it('is true when the block SAMPLE holds one, before anything is typed', () => {
    // Decided from the sample too, so an empty slot on a block whose design
    // wraps still gets a box that can hold the wrap.
    expect(isMultilineSlot('', 'Two lines\nlike this')).toBe(true);
  });

  it('is true for a long sample, which is prose and wants room', () => {
    expect(isMultilineSlot('', 'How one avatar answers, posts and sells while you sleep')).toBe(true);
  });

  it('is false for the short fields that should stay one line', () => {
    for (const [value, sample] of [
      ['Nihar', 'Nihar'],
      ['Aug 2026', 'August 2026'],
      ['', 'WHAT IT IS'],
      ['4', '11'],
      ['voidspace.ai/start', 'voidspace.ai/start'],
    ]) {
      expect(isMultilineSlot(value, sample), `${value}|${sample}`).toBe(false);
    }
  });

  it('cannot change its mind while somebody types', () => {
    // The rule reads the sample and the value, and an <input> is incapable of
    // accepting a newline — so a field that starts single-line can never grow
    // a newline mid-edit and swap control type under the cursor.
    const sample = 'WHAT IT IS';
    expect(isMultilineSlot('', sample)).toBe(false);
    expect(isMultilineSlot('ANYTHING TYPED HERE', sample)).toBe(false);
  });

  it('survives missing values without throwing', () => {
    expect(isMultilineSlot(undefined as unknown as string, undefined as unknown as string)).toBe(false);
  });
});
