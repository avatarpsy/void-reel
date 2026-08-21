/**
 * Which control a text slot deserves.
 *
 * ── WHY THIS IS NOT "JUST USE AN INPUT" ──────────────────────────────────────
 * A single-line `<input>` does not merely fail to SHOW a newline — it strips it
 * and joins the words either side. A real deck's title slot held
 * "Your ideas deserve\na face and a voice" and the panel displayed
 * "Your ideas deservea face and a voice". Typing a single character into that
 * field would have written the joined version back, losing the line break and a
 * space, on the largest line of the deck, with nothing to say it had happened.
 *
 * Decided from the block's own SAMPLE as well as the current value so the
 * control cannot change shape while somebody is typing: an input is incapable
 * of accepting a newline, so a field that starts single-line never needs to
 * become multi-line later.
 */

/** Longer than this, a designer's sample is prose and wants room. */
const LONG_SAMPLE = 45;

export function isMultilineSlot(value: string, placeholder: string): boolean {
  return /\n/.test(value ?? '')
    || /\n/.test(placeholder ?? '')
    || String(placeholder ?? '').length > LONG_SAMPLE;
}
