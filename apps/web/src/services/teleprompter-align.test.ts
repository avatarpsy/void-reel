/**
 * Voice-follow alignment tests — simulate the noisy Whisper tails the
 * teleprompter actually receives and assert the tracker follows the speaker:
 * advances on speech (through homophones, filler, and ASR slips), HOLDS on
 * silence/garbage, prefers the nearby occurrence of a repeated phrase, and
 * re-anchors (forward or backward) only on a sustained, unambiguous jump.
 */
import { describe, it, expect } from "vitest";
import { buildScriptIndex, alignTail, tokenPhon, SpeechTracker } from "./teleprompter-align";

const SCRIPT =
  "welcome back to the channel today i want to show you how we built the new " +
  "voidspace studio recording pipeline from scratch first we capture your webcam " +
  "take right inside the editor then the agent transcribes every word you said " +
  "and cleans up the bad takes after that it splits the footage into scenes and " +
  "each scene can be regenerated with ai while keeping your real voice finally " +
  "we publish the finished reel straight to your channel welcome back to the " +
  "channel is how every episode starts so make it count thanks for watching";

const WORDS = SCRIPT.split(/\s+/);
const INDEX = buildScriptIndex(WORDS);

/** The spoken tail the recognizer would emit at script position `end`. */
function tailAt(end: number, len = 8): string[] {
  return WORDS.slice(Math.max(0, end - len + 1), end + 1);
}

describe("alignTail", () => {
  it("finds the exact position of a clean tail", () => {
    const r = alignTail(
      tailAt(20).map((w) => ({ norm: w, phon: tokenPhon(w) })),
      INDEX,
      18,
      { back: 6, ahead: 30 },
    );
    expect(r.pos).toBe(20);
    expect(r.matched).toBeGreaterThanOrEqual(6);
  });

  it("prefers the occurrence NEAR the cursor for a repeated phrase", () => {
    // "welcome back to the channel" appears at 0-4 AND near the end (~103+).
    const probe = ["welcome", "back", "to", "the", "channel"].map((w) => ({
      norm: w,
      phon: tokenPhon(w),
    }));
    const early = alignTail(probe, INDEX, 4, { back: 6, ahead: 30 });
    expect(early.pos).toBe(4); // stays at the start, not the later duplicate
    const late = alignTail(probe, INDEX, 80, { back: 6, ahead: 30 });
    expect(late.pos).toBeGreaterThan(70); // and vice versa near the end
  });
});

describe("SpeechTracker — voice follow", () => {
  it("advances through a clean read and tracks the speaking rate", () => {
    const t = new SpeechTracker(INDEX, 2.3);
    let now = 0;
    for (let pos = 6; pos <= 30; pos += 3) {
      now += 1000; // 3 words/sec
      const ev = t.feed(tailAt(pos), now);
      expect(ev.kind).toBe("advance");
    }
    expect(t.confirmedPos).toBe(30);
    expect(t.ratePerSec).toBeGreaterThan(2.3); // adapted upward toward 3 w/s
  });

  it("advances despite homophones, dropped words, and filler", () => {
    const t = new SpeechTracker(INDEX, 2.3);
    t.feed(tailAt(8), 1000);
    // Speaker at 16: "...how we built the new voidspace studio recording".
    // ASR mangles it: homophone (knew/new), a dropped word, filler, and an
    // inflection slip (recordings) — Levenshtein-1 on a ≥5-char word.
    const noisy = ["how", "we", "built", "the", "knew", "um", "voidspace", "studio", "recordings"];
    const ev = t.feed(noisy, 2000);
    expect(ev.kind).toBe("advance");
    expect(t.confirmedPos).toBeGreaterThanOrEqual(15);
    expect(t.confirmedPos).toBeLessThanOrEqual(18);
  });

  it("HOLDS on garbage (a single stray word can't move it)", () => {
    const t = new SpeechTracker(INDEX, 2.3);
    t.feed(tailAt(12), 1000);
    const before = t.confirmedPos;
    for (let i = 0; i < 3; i++) {
      const ev = t.feed(["basically", "banana", "xylophone"], 2000 + i * 1000);
      expect(ev.kind).toBe("miss");
    }
    expect(t.confirmedPos).toBe(before);
  });

  it("re-anchors FORWARD after a sustained skip", () => {
    const t = new SpeechTracker(INDEX, 2.3);
    t.feed(tailAt(10), 1000);
    // Speaker jumps ~60 words ahead — far outside the local window.
    let ev = t.feed(tailAt(70), 2000);
    let ticks = 1;
    while (ev.kind === "miss" && ticks < 8) {
      ev = t.feed(tailAt(70 + ticks), 2000 + ticks * 1000);
      ticks++;
    }
    expect(ev.kind).toBe("reanchor");
    expect(ev.kind === "reanchor" && ev.pos).toBeGreaterThan(60);
  });

  it("re-anchors BACKWARD when the speaker re-reads an earlier passage", () => {
    const t = new SpeechTracker(INDEX, 2.3);
    t.feed(tailAt(60), 1000);
    let ev = t.feed(tailAt(15), 2000);
    let ticks = 1;
    while (ev.kind === "miss" && ticks < 8) {
      ev = t.feed(tailAt(15 + ticks), 2000 + ticks * 1000);
      ticks++;
    }
    expect(ev.kind).toBe("reanchor");
    expect(ev.kind === "reanchor" && ev.pos).toBeLessThan(30);
  });

  it("never accepts a wild forward teleport from one noisy tick", () => {
    const t = new SpeechTracker(INDEX, 2.3);
    t.feed(tailAt(8), 1000);
    // One tick that happens to resemble a distant part of the script must NOT
    // move the cursor (single-tick jumps are capped; re-anchor needs a streak).
    const ev = t.feed(tailAt(100), 2000);
    expect(ev.kind).toBe("miss");
    expect(t.confirmedPos).toBeLessThan(20);
  });

  it("targetAt drifts with VOICED time, holds through silence, and stays bounded", () => {
    const t = new SpeechTracker(INDEX, 3);
    t.feed(tailAt(10), 1000);
    const confirmed = t.confirmedPos;

    // Silence after the anchor accrues no voiced time → the target must HOLD
    // exactly on the confirmed word. This is the core invariant: scroll ⇔ speech.
    expect(t.targetAt(0, WORDS.length - 1)).toBe(confirmed);

    // 1s of VOICE at ~3 w/s advances roughly a rate-proportional amount, and
    // always slightly under the true rate so it can't outrun the speaker.
    const after1s = t.targetAt(1, WORDS.length - 1);
    expect(after1s).toBeGreaterThan(confirmed);
    expect(after1s).toBeLessThan(confirmed + 3);

    // Drift must bridge a slow recognizer tick — several seconds of speech has
    // to keep moving, not freeze at a tiny cap (the old +3 clamp is what made
    // the prompter stall between ticks).
    expect(t.targetAt(3, WORDS.length - 1)).toBeGreaterThan(confirmed + 6);

    // …but a recognizer that has gone silent for a long time must not run away.
    const runaway = t.targetAt(600, WORDS.length - 1);
    expect(runaway).toBeLessThanOrEqual(confirmed + 24);
    expect(t.targetAt(6000, WORDS.length - 1)).toBe(runaway);
  });

  it("is silent-start safe: target stays at 0 until the first real match", () => {
    const t = new SpeechTracker(INDEX, 2.3);
    expect(t.hasSpoken).toBe(false);
    expect(t.targetAt(5, WORDS.length - 1)).toBe(0);
  });

  it("locks on in ONE tick when the reader starts mid-script", () => {
    const t = new SpeechTracker(INDEX, 2.3);
    const ev = t.feed(tailAt(60), 1000); // first-ever feed, far from the top
    expect(ev.kind).toBe("reanchor");
    expect(ev.kind === "reanchor" && ev.pos).toBe(60);
    expect(t.confirmedPos).toBe(60);
  });

  it("does NOT lock on to garbage at take start", () => {
    const t = new SpeechTracker(INDEX, 2.3);
    const ev = t.feed(["basically", "banana", "xylophone", "quantum"], 1000);
    expect(ev.kind).toBe("miss");
    expect(t.hasSpoken).toBe(false);
  });
});
