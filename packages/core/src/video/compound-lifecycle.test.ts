// @vitest-environment happy-dom
//
// The engine's module graph reaches `parallel-frame-decoder`, which touches the
// worker global `self` while it is being evaluated. This package runs on `node`
// by default, where that throws before a single test is collected — so the file
// asks for a DOM rather than mocking the engine, because a mocked engine cannot
// prove anything about the real `dispose`.

/**
 * The two leaks a nested sequence opened, and why neither shows up in a heap
 * profile.
 *
 * An `ImageBitmap` is native memory with an explicit `close()`. Drop the handle
 * without closing and the JS heap looks fine while the tab's real footprint
 * climbs — so these are the failures you meet as "the editor died after a
 * minute of playback", with nothing in the profiler pointing at them.
 *
 * Both are invisible today because `NEST_SEQUENCES` is off and no project has a
 * compound. They are exactly the kind of thing that ships dormant and then
 * lands on whoever flips the flag.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { VideoEngine } from "./video-engine";

/** Minimal ImageBitmap stand-in that records whether it was closed. */
function fakeBitmap() {
  return { close: vi.fn(), width: 16, height: 9 } as unknown as ImageBitmap;
}

describe("VideoEngine.dispose · the nested engines go too", () => {
  let engine: VideoEngine;

  beforeEach(() => { engine = new VideoEngine(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("disposes every per-compound engine it created", () => {
    // `renderCompoundFrame` builds a whole VideoEngine per compound and keeps
    // it in `compoundEngines` — each holding its own frame cache, video
    // elements, decode canvas and mediabunny instance. Disposing only the
    // outer engine stranded all of them.
    const inner = { dispose: vi.fn() };
    const other = { dispose: vi.fn() };
    const map = (engine as unknown as { compoundEngines: Map<string, unknown> })
      .compoundEngines;
    map.set("seq-a", inner);
    map.set("seq-b", other);

    engine.dispose();

    expect(inner.dispose).toHaveBeenCalledTimes(1);
    expect(other.dispose).toHaveBeenCalledTimes(1);
    expect(map.size).toBe(0);
  });

  it("one bad nested engine does not strand the rest", () => {
    // A throw partway through would leave the engines after it alive, which is
    // the failure mode that turns one bug into a leak.
    const bad = { dispose: vi.fn(() => { throw new Error("boom"); }) };
    const good = { dispose: vi.fn() };
    const map = (engine as unknown as { compoundEngines: Map<string, unknown> })
      .compoundEngines;
    map.set("bad", bad);
    map.set("good", good);

    expect(() => engine.dispose()).not.toThrow();
    expect(good.dispose).toHaveBeenCalledTimes(1);
    expect(map.size).toBe(0);
  });

  it("clears the in-flight compound guard, so a reused engine is not deaf", () => {
    // `renderingCompounds` short-circuits re-entry. Left populated across a
    // dispose, the id would be permanently treated as already rendering and
    // that sequence would silently render as nothing.
    const guard = (engine as unknown as { renderingCompounds: Set<string> })
      .renderingCompounds;
    guard.add("seq-a");

    engine.dispose();

    expect(guard.size).toBe(0);
  });

  it("disposing twice is safe", () => {
    expect(() => { engine.dispose(); engine.dispose(); }).not.toThrow();
  });
});

/**
 * The store owns `currentFrame`, so replacing it must close what it replaces.
 * Mirrors `engine-store.setCurrentFrame` — the store itself lives in the web
 * app, but the CONTRACT is what matters and it belongs next to the engine that
 * mints the bitmaps.
 */
describe("currentFrame hand-off · replacing closes the outgoing bitmap", () => {
  function makeSlot() {
    let current: { image: ImageBitmap } | null = null;
    return {
      get: () => current,
      set(frame: { image: ImageBitmap } | null) {
        const previous = current;
        if (previous && previous !== frame) {
          try { previous.image.close(); } catch { /* already closed */ }
        }
        current = frame;
      },
    };
  }

  it("closes the frame it replaces", () => {
    // ~8 MB at 1080p, at preview frame rate, for as long as a sequence is on
    // screen. This was the expensive one.
    const slot = makeSlot();
    const first = { image: fakeBitmap() };
    const second = { image: fakeBitmap() };

    slot.set(first);
    slot.set(second);

    expect(first.image.close).toHaveBeenCalledTimes(1);
    expect(second.image.close).not.toHaveBeenCalled();
    expect(slot.get()).toBe(second);
  });

  it("does NOT close a frame being re-set as itself", () => {
    // Closing the incoming frame would blank the preview — a black flash that
    // reads as a decode failure rather than a lifecycle bug.
    const slot = makeSlot();
    const only = { image: fakeBitmap() };

    slot.set(only);
    slot.set(only);

    expect(only.image.close).not.toHaveBeenCalled();
    expect(slot.get()).toBe(only);
  });

  it("survives a bitmap that is already closed", () => {
    const slot = makeSlot();
    const stale = {
      image: { close: vi.fn(() => { throw new Error("closed"); }) } as unknown as ImageBitmap,
    };

    slot.set(stale);
    expect(() => slot.set({ image: fakeBitmap() })).not.toThrow();
  });

  it("clearing to null still closes the outgoing frame", () => {
    const slot = makeSlot();
    const frame = { image: fakeBitmap() };

    slot.set(frame);
    slot.set(null);

    expect(frame.image.close).toHaveBeenCalledTimes(1);
  });
});
