/**
 * ── A MIX MUST BE UNDOABLE, ALL OF IT ───────────────────────────────────────
 *
 * This surface writes two different things and used to write them two different
 * ways: fades through the action executor (undoable) and the volume curve
 * through `updateClipKeyframes`, a bare `set()` on the store with no history
 * entry. So one Ctrl+Z took back the fade and left the curve, and the surface's
 * own description said "Undoable", which made it worse — a person who trusted
 * that got a mix in a state nobody had ever chosen.
 *
 * Nothing caught it because nothing looked. These tests look at the ACTIONS the
 * surface emits, which is the only place the difference is visible.
 */
import { describe, it, expect, vi } from "vitest";

import { surface } from "./volume-automation";

type Act = { type: string; params: Record<string, unknown> };

/** A store whose executor records what it was asked to do. */
function harness(existingKeyframes: Array<Record<string, unknown>> = []) {
  const actions: Act[] = [];
  const store = {
    project: { timeline: { tracks: [] }, modifiedAt: 0 },
    actionExecutor: {
      execute: async (a: Act) => {
        actions.push({ type: a.type, params: a.params });
        return { success: true };
      },
    },
  };
  const clip = {
    id: "clip-1",
    raw: { keyframes: existingKeyframes, fade: { fadeIn: 0, fadeOut: 0 } },
  };
  return { actions, store, clip };
}

const apply = (h: ReturnType<typeof harness>, config: Record<string, unknown>) =>
  (surface.apply as any)(h.clip, config, { store: h.store });

describe("volume automation goes through the undoable path", () => {
  it("writes the curve as keyframe actions, not a silent store mutation", async () => {
    const h = harness();
    const r = await apply(h, { automationPoints: [{ time: 0, value: 1 }, { time: 2, value: 0.3 }] });
    expect(r.ok).toBe(true);
    const adds = h.actions.filter((a) => a.type === "keyframe/add");
    expect(adds).toHaveLength(2);
    expect(adds[0].params).toMatchObject({ clipId: "clip-1", property: "volume", time: 0, value: 1 });
    expect(adds[1].params).toMatchObject({ time: 2, value: 0.3 });
  });

  /** THE REGRESSION. A bare store write leaves nothing on the undo stack. */
  it("never reaches updateClipKeyframes", async () => {
    const mod = await import("../../stores/project-store");
    const spy = vi.spyOn(mod.useProjectStore.getState(), "updateClipKeyframes");
    const h = harness();
    await apply(h, { automationPoints: [{ time: 0, value: 1 }] });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("replaces the old curve rather than stacking a second one", async () => {
    const h = harness([
      { id: "k1", property: "volume", time: 0, value: 1 },
      { id: "k2", property: "volume", time: 5, value: 0.2 },
    ]);
    await apply(h, { automationPoints: [{ time: 1, value: 0.5 }] });
    const removes = h.actions.filter((a) => a.type === "keyframe/remove");
    expect(removes.map((a) => a.params.time)).toEqual([0, 5]);
    expect(removes.every((a) => a.params.property === "volume")).toBe(true);
  });

  /**
   * A clip can carry an opacity or scale curve at the same time. A volume edit
   * that wiped those would destroy work the user did somewhere else entirely.
   */
  it("leaves keyframes for other properties alone", async () => {
    const h = harness([
      { id: "k1", property: "volume", time: 0, value: 1 },
      { id: "k2", property: "opacity", time: 3, value: 0.5 },
    ]);
    await apply(h, { automationPoints: [] });
    const removed = h.actions.filter((a) => a.type === "keyframe/remove");
    expect(removed).toHaveLength(1);
    expect(removed[0].params.property).toBe("volume");
  });

  /** Clearing is a real edit, and must be undoable like any other. */
  it("treats an empty array as a clear, and reports it as a change", async () => {
    const h = harness([{ id: "k1", property: "volume", time: 0, value: 1 }]);
    const r = await apply(h, { automationPoints: [] });
    expect(r.ok).toBe(true);
    expect(h.actions.filter((a) => a.type === "keyframe/add")).toHaveLength(0);
    expect(h.actions.filter((a) => a.type === "keyframe/remove")).toHaveLength(1);
  });

  /** Fades were always undoable; they must stay on the same path. */
  it("still sets fades through audio/setFade", async () => {
    const h = harness();
    await apply(h, { fadeIn: 1.5, fadeOut: 3 });
    const fade = h.actions.find((a) => a.type === "audio/setFade");
    expect(fade?.params).toMatchObject({ clipId: "clip-1", fadeIn: 1.5, fadeOut: 3 });
  });

  /** Both halves in one call must both land, and both be undoable. */
  it("does fades and the curve together", async () => {
    const h = harness();
    await apply(h, { fadeIn: 0.5, automationPoints: [{ time: 0, value: 0.8 }] });
    expect(h.actions.map((a) => a.type)).toEqual(["audio/setFade", "keyframe/add"]);
  });

  it("clamps gain into the range the engine accepts", async () => {
    const h = harness();
    await apply(h, { automationPoints: [{ time: 0, value: 9 }, { time: 1, value: -4 }] });
    const adds = h.actions.filter((a) => a.type === "keyframe/add");
    expect(adds[0].params.value).toBe(2);
    expect(adds[1].params.value).toBe(0);
  });

  it("sorts points by time, so a curve written out of order still reads forwards", async () => {
    const h = harness();
    await apply(h, { automationPoints: [{ time: 4, value: 1 }, { time: 1, value: 0.2 }] });
    const adds = h.actions.filter((a) => a.type === "keyframe/add");
    expect(adds.map((a) => a.params.time)).toEqual([1, 4]);
  });
});
