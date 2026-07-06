/**
 * Speech → script alignment for the teleprompter's voice-follow scroll.
 *
 * The recognizer (whisper-base.en) hands us the trailing few spoken words ~once
 * a second. Those words are NOISY — substitutions, homophones, dropped/added
 * filler ("um"), and ~1s of lag. Naïve exact matching drops below threshold on
 * every ASR slip and the scroll stalls. This module implements the technique
 * real voice teleprompters use (VoicePrompt / promptme-ai / the ML-teleprompter
 * patents):
 *
 *   • Tokens carry a DOUBLE METAPHONE phonetic key, so homophones the ASR swaps
 *     (their/there, to/two/too, right/write) still match.
 *   • Fuzzy word equality: exact > phonetic > Levenshtein-1 (only for words ≥5
 *     chars, so "the"/"then" never collide).
 *   • End-anchored windowed alignment of the recent tail against the script,
 *     allowing small gaps (speech insertions), scored by summed word similarity.
 *   • A LOCALITY factor halves the score every ~20 words of offset from the
 *     current cursor, so a repeated phrase elsewhere in the script can't steal
 *     the position — nearby wins.
 *   • The caller gates on a score threshold (a single stray word can't move it),
 *     advances MONOTONICALLY forward, and RE-ANCHORS with a global scan only
 *     after a streak of misses (a deliberate skip / re-read).
 */
import { doubleMetaphone } from "double-metaphone";

export interface ScriptToken {
  norm: string;
  phon: string;
}

export interface ScriptIndex {
  tokens: ScriptToken[];
}

/** Primary Double Metaphone code for a normalized word ('' when not phonable). */
export function tokenPhon(norm: string): string {
  if (!norm) return "";
  try {
    return doubleMetaphone(norm)[0] || "";
  } catch {
    return "";
  }
}

export function buildScriptIndex(normWords: string[]): ScriptIndex {
  return { tokens: normWords.map((w) => ({ norm: w, phon: tokenPhon(w) })) };
}

/** True iff `a` and `b` are within one edit (sub/insert/delete). Early-outs. */
function within1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    // exactly one substitution: rest must match after the first difference
    let diffs = 0;
    for (let i = 0; i < la; i++) if (a[i] !== b[i]) if (++diffs > 1) return false;
    return true;
  }
  // one insertion/deletion: walk the shorter against the longer, allowing 1 skip
  const s = la < lb ? a : b;
  const l = la < lb ? b : a;
  let si = 0;
  let li = 0;
  let skipped = false;
  while (si < s.length && li < l.length) {
    if (s[si] === l[li]) {
      si++;
      li++;
    } else {
      if (skipped) return false;
      skipped = true;
      li++;
    }
  }
  return true;
}

/** Fuzzy word-equality score 0..1: exact > phonetic > Levenshtein-1 (≥5 chars). */
export function wordScore(a: ScriptToken, bNorm: string, bPhon: string): number {
  if (!a.norm || !bNorm) return 0;
  if (a.norm === bNorm) return 1;
  if (a.phon && bPhon && a.phon === bPhon) return 0.85;
  if (a.norm.length >= 5 && bNorm.length >= 5 && within1(a.norm, bNorm)) return 0.6;
  return 0;
}

/**
 * Information weight of a script word. Stop-word-length tokens ("to", "the",
 * "we") recur everywhere in natural speech, so a handful of them matching is
 * NOT evidence of position — without this, a tail of common words can sum past
 * the accept threshold against the wrong part of the script (a false advance).
 * Length is a cheap, language-safe proxy for information content.
 */
export function wordWeight(norm: string): number {
  const n = norm.length;
  if (n >= 5) return 1;
  if (n === 4) return 0.8;
  if (n === 3) return 0.55;
  return 0.35;
}

/** A match counts as STRONG evidence when it's a content word (≥4 chars). */
function isStrongMatch(scriptNorm: string, sc: number): boolean {
  return sc > 0 && scriptNorm.length >= 4;
}

export interface AlignOpts {
  /** Words to search before the cursor (ignored when global). */
  back: number;
  /** Words to search after the cursor (ignored when global). */
  ahead: number;
  /** Scan the WHOLE script with NO locality bias (re-anchor). */
  global?: boolean;
}

/** What one recognizer tick did to the tracker. */
export type TrackEvent =
  | { kind: "advance"; pos: number }
  | { kind: "reanchor"; pos: number }
  | { kind: "miss" };

export interface AlignResult {
  /** Best end position (the word the speaker is on), or -1. */
  pos: number;
  /** Locality-weighted, information-weighted alignment score. */
  score: number;
  /** How many tail words matched at all (used to gate acceptance). */
  matched: number;
  /** How many matches were content words (≥4 chars) — real positional evidence. */
  strong: number;
}

/**
 * Align the ordered recognized `tail` (recent spoken words, each {norm,phon})
 * against the script, END-anchored. Returns the best end position = where the
 * speaker is. `cursor` is the current read position; a locality factor keeps
 * results near it unless `global`.
 */
export function alignTail(
  tail: { norm: string; phon: string }[],
  index: ScriptIndex,
  cursor: number,
  opts: AlignOpts,
): AlignResult {
  const toks = index.tokens;
  const n = toks.length;
  const cleaned = tail.filter((t) => t.norm);
  if (!cleaned.length || !n) return { pos: -1, score: 0, matched: 0, strong: 0 };

  const from = opts.global ? 0 : Math.max(0, cursor - opts.back);
  const to = opts.global ? n - 1 : Math.min(n - 1, cursor + opts.ahead);
  const last = cleaned[cleaned.length - 1];

  let best: AlignResult = { pos: -1, score: 0, matched: 0, strong: 0 };
  for (let end = from; end <= to; end++) {
    let ti = cleaned.length - 1;
    let si = end;
    let sum = 0;
    let matched = 0;
    let strong = 0;
    let scanned = 0;
    const maxScan = cleaned.length + 5; // allow a few speech-side insertions
    while (ti >= 0 && si >= 0 && scanned < maxScan) {
      const sc = wordScore(toks[si], cleaned[ti].norm, cleaned[ti].phon);
      if (sc > 0) {
        sum += sc * wordWeight(toks[si].norm);
        matched += 1;
        if (isStrongMatch(toks[si].norm, sc)) strong += 1;
        ti--;
        si--;
      } else {
        si--; // skip a script word the speaker didn't say (or ASR dropped)
      }
      scanned++;
    }
    // Anchor bonus when the LAST spoken word lands exactly on `end`.
    const endBonus = wordScore(toks[end], last.norm, last.phon) * wordWeight(toks[end].norm) * 0.5;
    let score = sum + endBonus;
    if (!opts.global) {
      const offset = Math.abs(end - cursor);
      score *= Math.pow(0.5, offset / 20); // halve every ~20 words of offset
    }
    if (score > best.score) best = { pos: end, score, matched, strong };
  }
  return best;
}

// ── Stateful tracker: where is the speaker RIGHT NOW? ────────────────────────
// Owns the confirmed position, miss-streak re-anchoring, and the speaking-rate
// estimate used to speculatively advance between the ~1s recognizer ticks.
// Pure + framework-free so the whole voice-follow behaviour is unit-testable.

const ACCEPT_SCORE = 1.2; // weighted — roughly one content word + support
const ACCEPT_MATCHED = 2;
const ACCEPT_STRONG = 1; // at least one content-word match, always
const BIG_ADVANCE_WORDS = 12; // advances beyond this need extra evidence…
const BIG_ADVANCE_STRONG = 2; // …two content-word matches
const MAX_FORWARD_JUMP = 32; // words per tick a local match may advance
const MISSES_BEFORE_REANCHOR = 4;
const REANCHOR_SCORE = 2.6; // higher bar — a global jump must be unambiguous
const REANCHOR_MATCHED = 3;
const REANCHOR_STRONG = 2;
const REANCHOR_MIN_DISTANCE = 3; // closer than this → the local path handles it
const LOOKAHEAD_CAP_WORDS = 3; // speculative creep never exceeds this
const LOOKAHEAD_RATE_FACTOR = 0.85; // creep at ~85% of measured speaking rate
const LOOKAHEAD_MAX_SECONDS = 2; // stop creeping when speech goes quiet

export class SpeechTracker {
  private index: ScriptIndex;
  /** Last speech-confirmed word index. */
  private confirmed = 0;
  /** performance.now() of the last confirmed match (0 = none yet). */
  private lastMatchTs = 0;
  private lastMatchPos = 0;
  private missStreak = 0;
  /** Smoothed speaking rate, words/sec. */
  private rate: number;

  constructor(index: ScriptIndex, initialRateWps = 2.3) {
    this.index = index;
    this.rate = initialRateWps;
  }

  /** Swap in a new script (keeps nothing — a new script is a new read). */
  setIndex(index: ScriptIndex, initialRateWps?: number) {
    this.index = index;
    this.reset(initialRateWps);
  }

  reset(initialRateWps?: number) {
    this.confirmed = 0;
    this.lastMatchTs = 0;
    this.lastMatchPos = 0;
    this.missStreak = 0;
    if (typeof initialRateWps === "number") this.rate = initialRateWps;
  }

  get confirmedPos(): number {
    return this.confirmed;
  }

  /** Has any speech been matched yet this take? */
  get hasSpoken(): boolean {
    return this.lastMatchTs > 0;
  }

  /** Timestamp (ms) of the last confirmed match — 0 when none yet. Lets the
   *  prompter detect "speaking but nothing matches" and fall back gracefully. */
  get lastMatchAtMs(): number {
    return this.lastMatchTs;
  }

  get ratePerSec(): number {
    return this.rate;
  }

  /**
   * Feed one recognizer tick (the recent spoken tail) at time `now` (ms).
   * Local match past the confidence gate → advance (forward only). A streak of
   * misses → global re-anchor with a higher bar (handles skips AND re-reads,
   * so re-anchoring may move BACKWARD).
   */
  feed(words: string[], now: number, cursor?: number): TrackEvent {
    const tail = words.map((w) => ({ norm: w, phon: tokenPhon(w) }));
    if (!tail.some((t) => t.norm)) return { kind: "miss" };
    const cur = typeof cursor === "number" ? cursor : this.confirmed;

    const r = alignTail(tail, this.index, cur, { back: 6, ahead: 30 });
    const forward = r.pos >= this.confirmed - 1;
    const notWild = r.pos - this.confirmed <= MAX_FORWARD_JUMP;
    // Bigger claimed jumps need more content-word evidence — one accidental
    // "channel" match plus a stop word must never fling the cursor ahead.
    const enoughStrong =
      r.strong >= ACCEPT_STRONG &&
      (r.pos - this.confirmed <= BIG_ADVANCE_WORDS || r.strong >= BIG_ADVANCE_STRONG);
    if (r.pos >= 0 && r.score >= ACCEPT_SCORE && r.matched >= ACCEPT_MATCHED && enoughStrong && forward && notWild) {
      const target = Math.max(this.confirmed, r.pos);
      // Update the speaking-rate estimate from confirmed progress.
      const dPos = target - this.lastMatchPos;
      const dT = (now - this.lastMatchTs) / 1000;
      if (this.lastMatchTs > 0 && dT > 0.25 && dPos > 0 && dPos < 40) {
        const inst = dPos / dT;
        this.rate = Math.max(0.8, Math.min(6, this.rate * 0.6 + inst * 0.4));
      }
      this.confirmed = target;
      this.lastMatchPos = target;
      this.lastMatchTs = now;
      this.missStreak = 0;
      return { kind: "advance", pos: target };
    }

    this.missStreak += 1;
    // Global scan when (a) we've missed for a sustained streak (the speaker
    // skipped / re-read elsewhere), or (b) NOTHING has been confirmed yet this
    // take — with zero evidence the locality prior is meaningless, and a reader
    // starting mid-script should lock on in ONE tick, not after 4 misses.
    if (!this.hasSpoken || this.missStreak >= MISSES_BEFORE_REANCHOR) {
      const g = alignTail(tail, this.index, cur, { back: 0, ahead: 0, global: true });
      if (
        g.pos >= 0 &&
        g.matched >= REANCHOR_MATCHED &&
        g.strong >= REANCHOR_STRONG &&
        g.score >= REANCHOR_SCORE &&
        (!this.hasSpoken || Math.abs(g.pos - cur) > REANCHOR_MIN_DISTANCE)
      ) {
        this.confirmed = g.pos;
        this.lastMatchPos = g.pos;
        this.lastMatchTs = now;
        this.missStreak = 0;
        return { kind: "reanchor", pos: g.pos };
      }
    }
    return { kind: "miss" };
  }

  /**
   * The read position the scroll should target at time `now`: the confirmed
   * word plus a speculative creep at ~85% of the measured speaking rate (capped
   * at +3 words, and stopping once speech has been quiet ~2s) so the highlight
   * tracks the word being spoken NOW — but never runs away.
   */
  targetAt(now: number, maxIndex: number): number {
    if (!this.hasSpoken) return 0;
    const sinceMatch = Math.min(LOOKAHEAD_MAX_SECONDS, Math.max(0, (now - this.lastMatchTs) / 1000));
    const lookahead = Math.min(LOOKAHEAD_CAP_WORDS, this.rate * LOOKAHEAD_RATE_FACTOR * sinceMatch);
    return Math.min(maxIndex, this.confirmed + lookahead);
  }
}
