import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SURFACES, listSurfaces, getSurface } from "./index";

/**
 * Guards on the registry itself, not on any one surface.
 *
 * The registry is a vite glob — a new surface appears simply by existing, with
 * no registration step. That is the right design and it has one failure mode:
 * a file that half-implements the contract still loads, and the agent then
 * discovers a tool that misbehaves at call time rather than at build time.
 * These assert the contract across every surface at once, so the next one
 * anyone adds is checked for free.
 */
describe("inspector surface registry", () => {
  const all = Object.values(SURFACES);

  it("discovers the surfaces", () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it("gives every surface the fields the agent contract promises", () => {
    for (const s of all) {
      expect(typeof s.name, `${s.name}: name`).toBe("string");
      expect(s.name, "kebab-case name").toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(s.description.length, `${s.name}: description`).toBeGreaterThan(10);
      expect(Array.isArray(s.appliesTo) && s.appliesTo.length > 0, `${s.name}: appliesTo`).toBe(true);
      expect(typeof s.apply, `${s.name}: apply`).toBe("function");
      expect(s.schema, `${s.name}: schema`).toBeTruthy();
      expect((s.schema as any).type, `${s.name}: schema.type`).toBe("object");
    }
  });

  it("names are unique — a collision would silently drop one surface", () => {
    const names = all.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * The write-only gap, as a test. Every surface that SETS state should be
   * able to report it; `auto-cut-silence` is the deliberate exception because
   * it performs a cut rather than holding a setting.
   */
  const READ_EXEMPT = new Set(["auto-cut-silence"]);

  it("every stateful surface is readable", () => {
    const missing = all
      .filter((s) => !READ_EXEMPT.has(s.name) && typeof s.read !== "function")
      .map((s) => s.name);
    expect(missing, "surfaces that can be set but not read").toEqual([]);
  });

  it("reports readability in discovery, so the agent knows before it asks", () => {
    const listed = listSurfaces();
    expect(listed.length).toBe(all.length);
    for (const row of listed) {
      expect(row.readable).toBe(typeof getSurface(row.name)?.read === "function");
    }
    expect(listed.find((r) => r.name === "auto-cut-silence")?.readable).toBe(false);
    expect(listed.find((r) => r.name === "video-effects")?.readable).toBe(true);
  });

  it("is sorted, so the agent sees a stable list turn to turn", () => {
    const names = listSurfaces().map((r) => r.name);
    expect(names).toEqual([...names].sort());
  });

  /**
   * THE NO-OP GUARD.
   *
   * Each of these was a registered surface that reported success and changed
   * nothing the user would ever see. They are the most expensive kind of bug
   * here, because the agent believes it did the work and says so.
   *
   * Re-adding one is legitimate — but only together with the rendering that
   * makes it true. This test is the place to delete the entry when that
   * happens, which is exactly the review conversation that should occur.
   */
  const WITHDRAWN: Record<string, string> = {
    "perspective":
      "preview-only: video-engine.getAnimatedTransform does not carry it and drawFrameToContext never applies it, so the export drops it",
    "transform-style":
      "preview-only, same as perspective — use nothing, or teach the export 3D first",
    "subtitle":
      "unreachable: updateSubtitle keys off timeline.subtitles, which resolveTargetClips never yields; use text-content / text-style",
  };

  it("does not re-expose a surface that was withdrawn for doing nothing", () => {
    for (const [name, why] of Object.entries(WITHDRAWN)) {
      expect(SURFACES[name], `"${name}" is back — ${why}`).toBeUndefined();
    }
  });

  /**
   * `blendOpacity` is a PERCENTAGE everywhere that matters: the store rejects
   * anything outside 0–100, the Inspector slider is 0–100 with a "%" unit, and
   * the renderer divides by 100. The surface once declared 0–1, which meant no
   * value an agent could send produced a visible result.
   */
  it("states blend-opacity in the units the store actually accepts", () => {
    const schema = SURFACES["blend-opacity"].schema as any;
    expect(schema.properties.opacity.maximum).toBe(100);
  });

  it("keeps blend-opacity off the clip kinds that ignore it", () => {
    // Only threejs-layer-renderer reads blendOpacity, and only for these four.
    expect([...SURFACES["blend-opacity"].appliesTo].sort())
      .toEqual(["shape", "sticker", "svg", "text"]);
  });
});

/**
 * THE BATCH CONTRACT, PINNED TO THE DISPATCHER'S SOURCE.
 *
 * `applyAll` is N sequential mutations and each one REPLACES the project object
 * graph. The dispatcher used to build `ctx = { project, store }` once above the
 * loop, so targets 2..N were handed the pre-edit project — an object the store
 * no longer references. Measured symptom: "dissolve every cut" over three shots
 * reported three successes (two dissolves + one legitimate "nothing after this
 * clip" skip) and left ONE transition on the track; the second cut exported as
 * a hard cut.
 *
 * This is source-pinned rather than behavioural because the bug lives in the
 * postMessage handler inside App.tsx, which needs a whole editor to run. A
 * grep-level guard that costs nothing beats a proof that never gets written.
 */
describe("inspector batch dispatch", () => {
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
  const handler = app.slice(app.indexOf('case "voidspace:apply-inspector-tool"'));
  const loop = handler.slice(0, handler.indexOf("FOUNDATION FIX (F8)"));

  it("re-reads live store state for EVERY target, not once for the batch", () => {
    // The apply loop must take its project/store from getState() INSIDE the
    // `for (const t of targets)` body.
    const body = loop.slice(loop.indexOf("for (const t of targets)"));
    expect(body).toContain("useProjectStore.getState()");
    expect(body).toContain("surface.apply(t,");
  });

  it("does not hoist a single ctx above the apply loop", () => {
    const beforeLoop = loop.slice(0, loop.indexOf("for (const t of targets)"));
    expect(beforeLoop).not.toMatch(/const\s+ctx\s*=/);
  });

  /**
   * The autosave is hash-gated on {id, modifiedAt, trackCount, clipCount,
   * mediaCount}. A transition added, an effect toggled, a param nudged changes
   * none of them — so without a `modifiedAt` bump the edit lives in memory
   * until the next reload and then evaporates. This shipped three times.
   * The dispatcher now bumps it once per successful batch so no individual
   * surface has to remember.
   */
  it("bumps modifiedAt once after a successful batch, in the dispatcher", () => {
    const success = handler.slice(handler.indexOf("const okCount"));
    const beforeReply = success.slice(0, success.indexOf("voidspace:inspector-tool-applied"));
    expect(beforeReply).toContain("if (okCount > 0)");
    expect(beforeReply).toContain("modifiedAt: Date.now()");
  });
});
