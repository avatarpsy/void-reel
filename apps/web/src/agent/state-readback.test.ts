import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WHAT `get-state` TELLS THE AGENT MUST MATCH WHAT IT SHOWS.
 *
 * `timeline.duration` is a stored scalar. It is written when a clip is ADDED,
 * and repaired on load only when it is zero — nothing recomputes it when a clip
 * is trimmed, retimed, split or deleted. So a project the agent had just
 * shortened kept reporting its old length: three 2s shots joined to 6.00s, the
 * last retimed to 1.5x, and `read_timeline` still said 7.00s.
 *
 * That is not cosmetic. The agent does arithmetic with this number — "put the
 * outro at the end", "this cut is 30s over for the platform" — and it repeats
 * it to the user as a fact. The exporter never trusted it (see
 * `ExportEngine.calculateTimelineDuration`, which takes the max clip end), so
 * the file and the report disagreed.
 *
 * Source-pinned: the value is produced inside the postMessage handler in
 * App.tsx, which needs a whole editor to exercise.
 */
describe("get-state duration", () => {
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");

  it("derives the duration from the clips it is handing back", () => {
    expect(app).toContain("derivedDuration");
    expect(app).toContain("duration: derivedDuration");
  });

  it("no longer reports the stale stored scalar", () => {
    // The only `duration:` in the state reply must be the derived one.
    expect(app).not.toContain("duration: proj.timeline?.duration ?? 0,\n                tracks:");
  });

  it("computes it over the SAME track list the reply carries", () => {
    // If the two ever diverge, the agent is told about clips it cannot see (or
    // the reverse), which is worse than a stale number.
    expect(app).toContain("const allTracksForState = [");
    expect(app).toContain("tracks: allTracksForState,");
  });
});
