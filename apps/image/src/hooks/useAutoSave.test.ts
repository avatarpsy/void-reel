/**
 * When a busy document reaches disk.
 *
 * A trailing debounce alone STARVES: its cleanup clears the pending timer on
 * every change, so while edits arrive closer together than the delay the save is
 * rescheduled forever and never runs. Fine for a human typing, catastrophic for
 * an agent, which mutates a document continuously for minutes.
 *
 * Measured before this existed: 17 edits 700ms apart over 12 seconds wrote
 * nothing, and a five-slide deck came back from a reload with its pages intact
 * and every layer gone — the last quiet moment had been before the slides
 * existed. These pin the rule that stops that.
 */
import { describe, it, expect } from 'vitest';
import { saveDelay } from './useAutoSave';

describe('how long a dirty project waits before it is written', () => {
  it('debounces a quick burst, so typing is one write and not thirty', () => {
    // Just saved: the full debounce applies, and a second edit a moment later
    // pushes it out again. That is the behaviour worth keeping.
    expect(saveDelay({ now: 1000, lastSaveAt: 1000 })).toBe(2000);
    expect(saveDelay({ now: 1500, lastSaveAt: 1000 })).toBe(2000);
  });

  it('collapses to an immediate write once the ceiling is near', () => {
    // 9s dirty, ceiling 10s: there is 1s of budget left, so do not wait 2s.
    expect(saveDelay({ now: 9_000, lastSaveAt: 0 })).toBe(1_000);
    // Past the ceiling: write on this edit, not the next quiet moment.
    expect(saveDelay({ now: 10_000, lastSaveAt: 0 })).toBe(0);
    expect(saveDelay({ now: 60_000, lastSaveAt: 0 })).toBe(0);
  });

  /**
   * The property that actually matters, stated as the failure it prevents: an
   * editor under CONTINUOUS edits must still reach disk. Replayed at the same
   * cadence that wrote nothing before.
   */
  it('never lets a continuously-edited project go unsaved indefinitely', () => {
    let lastSaveAt = 0;
    let now = 0;
    let writes = 0;
    let longestGap = 0;

    // 17 edits, 700ms apart — the burst that used to save nothing at all.
    for (let i = 0; i < 17; i++) {
      now += 700;
      const wait = saveDelay({ now, lastSaveAt });
      // The next edit arrives in 700ms; a longer wait than that is cancelled by
      // the effect cleanup, exactly as the real debounce does.
      if (wait <= 700) {
        writes++;
        lastSaveAt = now + wait;
      }
      longestGap = Math.max(longestGap, now - lastSaveAt);
    }

    expect(writes, 'a busy editor still reaches disk').toBeGreaterThan(0);
    expect(longestGap, 'never further from disk than the ceiling')
      .toBeLessThanOrEqual(10_000);
  });

  it('honours an explicit debounce and ceiling', () => {
    expect(saveDelay({ now: 0, lastSaveAt: 0, debounceMs: 500, maxWaitMs: 4000 })).toBe(500);
    expect(saveDelay({ now: 3_800, lastSaveAt: 0, debounceMs: 500, maxWaitMs: 4000 })).toBe(200);
  });

  it('does not return a negative wait when the clock jumps', () => {
    // A machine waking from sleep can hand back a `now` far past the ceiling, and
    // a negative timeout would fire immediately in a loop.
    expect(saveDelay({ now: 1_000_000, lastSaveAt: 0 })).toBe(0);
    // Or one BEHIND the last save, if the clock stepped backwards.
    expect(saveDelay({ now: 0, lastSaveAt: 5_000 })).toBe(2000);
  });
});
