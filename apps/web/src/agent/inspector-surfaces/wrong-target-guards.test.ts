import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { surface as entryExit } from "./transitions";
import { surface as volumeAutomation } from "./volume-automation";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/**
 * Three defects found by applying every surface to a live editor and reading it
 * back. Each one answered `ok`. None of them could be caught by a unit test of
 * the surface's own helpers, because the helpers were all correct — the damage
 * was in what the write reached and what the read looked at.
 */

describe("auto-cut-silence edits the clip it was given", () => {
  const src = read("src/bridges/silence-cut-bridge.ts");

  /**
   * `findClipContainingTime` walked EVERY track and returned the first clip
   * whose time range contained the moment, with no reference to the clip being
   * cut. On any timeline with more than one track — i.e. every real project —
   * "cut the silence out of this narration" split and ripple-deleted whatever
   * sat at that timecode on the first track, normally the PICTURE, and reported
   * success. Measured: a 6.0s speech clip, note "Cut 2 silent gaps, 2.6s of
   * 6.0s", speech clip still 6.03s.
   */
  it("scopes both clip lookups to one track", () => {
    expect(src).toContain("private findClipContainingTime(time: number, trackId: string)");
    expect(src).toContain("private findClipInTimeRange(start: number, end: number, trackId: string)");
    expect(src).not.toMatch(/findClipContainingTime\(\s*absoluteStart\s*\)/);
    expect(src).not.toMatch(/findClipInTimeRange\(\s*absoluteStart,\s*absoluteEnd,\s*\)/);
  });

  it("refuses to cut a clip that is on no track, rather than guessing", () => {
    expect(src).toContain('error: "Clip is not on any track"');
  });
});

describe("volume-automation reads what it writes", () => {
  /**
   * `apply` writes `clip.fade` (via audio/setFade) and volume keyframes on
   * `clip.keyframes`. `read` looked at `clip.automation.volume` — the LEGACY
   * array the same file says playback no longer reads. So the readback could
   * not succeed for any input, while `readable: true` told the agent it could.
   */
  it("reports fades from clip.fade", () => {
    const state = volumeAutomation.read!(
      { id: "c1", kind: "audio", trackId: "t1", raw: { fade: { fadeIn: 0.8, fadeOut: 1.2 } } as never },
      { store: {} as never, project: {} as never },
    );
    expect(state).toEqual({ fadeIn: 0.8, fadeOut: 1.2 });
  });

  it("reports volume keyframes from clip.keyframes, in time order", () => {
    const state = volumeAutomation.read!(
      {
        id: "c1", kind: "audio", trackId: "t1",
        raw: {
          keyframes: [
            { property: "volume", time: 2, value: 0.2 },
            { property: "opacity", time: 0, value: 1 },
            { property: "volume", time: 0, value: 1 },
          ],
        } as never,
      },
      { store: {} as never, project: {} as never },
    );
    expect(state).toEqual({ points: [{ time: 0, value: 1 }, { time: 2, value: 0.2 }] });
  });

  it("says nothing for an untouched clip", () => {
    expect(volumeAutomation.read!(
      { id: "c1", kind: "audio", trackId: "t1", raw: {} as never },
      { store: {} as never, project: {} as never },
    )).toBeNull();
  });
});

describe("entry-exit-transitions does not clear on a typo", () => {
  /**
   * Everything in `apply` reads `config.entry.preset`, defaulting to "none".
   * A caller that guessed `{ entry: { type: "fade", duration: 0.5 } }` — the
   * natural guess, and one this project's own harness made — wiped whatever
   * animation the clip had and was answered `ok: "cleared"`.
   */
  // A real clip always carries a transform; the keyframe compiler reads it.
  const clip = {
    id: "c1", kind: "video" as const, trackId: "t1",
    raw: {
      duration: 3,
      transform: {
        position: { x: 0, y: 0 }, scale: { x: 1, y: 1 },
        rotation: 0, opacity: 1, anchor: { x: 0.5, y: 0.5 },
      },
    } as never,
  };
  const ctx = {
    store: {} as never,
    project: { timeline: { tracks: [{ id: "t1", clips: [] }] } } as never,
  };

  it("rejects a non-empty config that names no preset", async () => {
    const r = await entryExit.apply(clip, { entry: { type: "fade", duration: 0.5 } } as never, ctx);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("preset");
  });

  it("still lets an EXPLICIT clear through the guard", async () => {
    // It goes on to need the real store to write keyframes, which this stub is
    // not — the assertion is only that the GUARD does not stop it.
    const r = await entryExit.apply(clip, { entry: { preset: "none" } } as never, ctx);
    expect(String(r.error ?? "")).not.toContain("no preset given");
  });
});

describe("zero is a legal effect value", () => {
  /**
   * `buildCSSFilter` used `params.value || 1` for contrast and saturation, so
   * `saturation: 0` — black and white, the most-requested grade there is —
   * became `saturate(1)`, a no-op, with no error anywhere.
   */
  it("uses ?? not || when reading effect params", () => {
    const eng = readFileSync(
      join(process.cwd(), "../../packages/core/src/video/video-effects-engine.ts"),
      "utf8",
    );
    const fn = eng.slice(eng.indexOf("private buildCSSFilter"));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    expect(body).not.toMatch(/params\.\w+ \|\| /);
    expect(body).toContain("params.value ?? 1");
  });
});
