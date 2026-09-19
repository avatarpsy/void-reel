/**
 * The regression this exists for: `apply_inspector_tool` was called sixteen
 * times with the surface config under `params` instead of `config`. Every call
 * answered `{ ok: true, clipsTouched: 1 }`. Nothing was written. These tests
 * pin the door shut.
 */
import { describe, it, expect } from "vitest";

import { validateSurfaceConfig } from "./validate-config";
import { surface as volumeAutomation } from "./volume-automation";

const ok = (r: string | null) => expect(r).toBeNull();
const fails = (r: string | null) => {
  expect(r).toBeTypeOf("string");
  return r as string;
};

describe("validateSurfaceConfig", () => {
  it("REJECTS a missing config — the params/config mix-up that started this", () => {
    const msg = fails(validateSurfaceConfig(volumeAutomation, undefined));
    // The error has to name the fix, because the caller is usually a model.
    expect(msg).toContain("config");
    expect(msg).toContain("params");
  });

  it("rejects an empty config and lists what the surface accepts", () => {
    const msg = fails(validateSurfaceConfig(volumeAutomation, {}));
    expect(msg).toContain("automationPoints");
  });

  it("rejects a config that is not an object", () => {
    fails(validateSurfaceConfig(volumeAutomation, [1, 2, 3]));
    fails(validateSurfaceConfig(volumeAutomation, "fadeIn"));
    fails(validateSurfaceConfig(volumeAutomation, 3));
  });

  it("rejects unknown keys, because surfaces declare additionalProperties:false", () => {
    const msg = fails(
      validateSurfaceConfig(volumeAutomation, { automationPoint: [] }),
    );
    expect(msg).toContain("automationPoint");
    expect(msg).toContain("automationPoints");
  });

  it("rejects a config satisfying none of the anyOf combinations", () => {
    const s = {
      name: "x",
      schema: {
        properties: { a: {}, b: {}, c: {} },
        additionalProperties: false,
        anyOf: [{ required: ["a"] }, { required: ["b"] }],
      },
    };
    // `c` is a legal key but satisfies neither combination.
    const msg = fails(validateSurfaceConfig(s, { c: 1 }));
    expect(msg).toContain("a | b");
  });

  it("treats a key set to undefined as absent, not present", () => {
    const s = {
      name: "x",
      schema: {
        properties: { a: {}, b: {} },
        additionalProperties: false,
        anyOf: [{ required: ["a"] }, { required: ["b"] }],
      },
    };
    // A caller that spread an optional field it never set must get the same
    // answer as one that omitted it — `undefined` does not survive JSON.
    fails(validateSurfaceConfig(s, { a: undefined }));
    ok(validateSurfaceConfig(s, { a: 1 }));
  });

  it("rejects a config missing a top-level required key", () => {
    const s = {
      name: "x",
      schema: {
        properties: { a: {}, b: {} },
        additionalProperties: false,
        required: ["a"],
      },
    };
    const msg = fails(validateSurfaceConfig(s, { b: 1 }));
    expect(msg).toContain("a");
  });

  // ── and the calls that must still go through ──────────────────────────────

  it("accepts the real volume curve", () => {
    ok(
      validateSurfaceConfig(volumeAutomation, {
        automationPoints: [
          { time: 0, value: 0 },
          { time: 1.2, value: 0.142 },
        ],
      }),
    );
  });

  it("accepts a fade-only partial edit", () => {
    ok(validateSurfaceConfig(volumeAutomation, { fadeOut: 3 }));
  });

  it("accepts fades and a curve together", () => {
    ok(
      validateSurfaceConfig(volumeAutomation, {
        fadeIn: 0.05,
        fadeOut: 0.3,
        automationPoints: [{ time: 0, value: 0.69 }],
      }),
    );
  });

  it("accepts an empty automationPoints array — clearing a curve is a real edit", () => {
    ok(validateSurfaceConfig(volumeAutomation, { automationPoints: [] }));
  });

  it("does not block a surface that publishes no schema", () => {
    ok(validateSurfaceConfig({ name: "legacy" }, { anything: 1 }));
  });
});

/**
 * Every registered surface must be protected by this, so a surface added later
 * cannot reintroduce the silent no-op simply by existing.
 */
describe("every surface rejects an empty config", () => {
  it("holds across the whole registry", async () => {
    const { listSurfaces } = await import("./index");
    const surfaces = (listSurfaces as () => Array<{ name: string; schema?: unknown }>)();
    expect(surfaces.length).toBeGreaterThan(0);
    const leaky = surfaces
      .filter((s) => validateSurfaceConfig(s, {}) === null)
      .map((s) => s.name);
    expect(leaky).toEqual([]);
  });
});
