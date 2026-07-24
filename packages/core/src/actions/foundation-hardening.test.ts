import { describe, it, expect, vi } from "vitest";
import { ActionExecutor } from "./action-executor";
import { ActionHistory } from "./action-history";
import { createSeededIdGenerator } from "./id-generator";
import type { Action } from "../types/actions";
import type { Project } from "../types/project";
import type { Clip, Track } from "../types/timeline";

/**
 * FOUNDATION AUDIT — demonstration tests (see FOUNDATION_AUDIT.md).
 *
 * These prove the base-layer defects that are invisible under human use but
 * fatal under agent use. They are EXPECTED TO FAIL against the current core;
 * Phase F fixes make them pass. Do not "fix" the tests — fix the core.
 */

let actionSeq = 0;
const act = (type: string, params: Record<string, unknown>): Action => ({
  type,
  id: `test-action-${actionSeq++}`,
  timestamp: 0,
  params,
});

function makeClip(id: string, over: Partial<Clip> = {}): Clip {
  return {
    id,
    mediaId: "m1",
    trackId: "t1",
    startTime: 0,
    duration: 5,
    inPoint: 0,
    outPoint: 5,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
    ...over,
  } as Clip;
}

function makeProject(clips: Clip[] = []): Project {
  const track: Track = {
    id: "t1",
    type: "video",
    name: "V1",
    clips,
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  };
  return {
    id: "p1",
    name: "Test",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: {
      items: [
        {
          id: "m1",
          name: "m1",
          type: "video",
          fileHandle: null,
          blob: null,
          metadata: { duration: 5, fileSize: 0, sampleRate: 48000, channels: 2 },
          thumbnailUrl: null,
          waveformData: null,
        },
      ],
    },
    timeline: { duration: 5, tracks: [track], subtitles: [] },
    textClips: [],
  } as unknown as Project;
}

describe("FOUNDATION AUDIT — expected failures until Phase F", () => {
  it("F1: two fast adds under a frozen clock must NOT collide on id", async () => {
    const spy = vi.spyOn(Date, "now").mockReturnValue(5000);
    try {
      const project = makeProject();
      const executor = new ActionExecutor(new ActionHistory());
      await executor.execute(act("subtitle/add", { text: "a", startTime: 0, endTime: 1 }), project);
      await executor.execute(act("subtitle/add", { text: "b", startTime: 1, endTime: 2 }), project);
      const ids = project.timeline.subtitles.map((s) => s.id);
      // Today both mint `subtitle-5000` → Set size 1. Should be 2.
      expect(new Set(ids).size).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("F2: undoing a batched pair of adds must remove BOTH (not the last one twice)", async () => {
    let clock = 1000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock++);
    try {
      const project = makeProject();
      const executor = new ActionExecutor(new ActionHistory());
      await executor.execute(act("subtitle/add", { text: "one", startTime: 0, endTime: 1 }), project);
      await executor.execute(act("subtitle/add", { text: "two", startTime: 1, endTime: 2 }), project);
      expect(project.timeline.subtitles).toHaveLength(2);
      // Both adds auto-group (fast) → a single undo should remove both.
      await executor.undo(project);
      // Today: __LAST_ADDED__ resolves both inverses to the LAST id → one remains.
      expect(project.timeline.subtitles).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("F3: delete→undo must preserve ALL clip fields", async () => {
    const clip = makeClip("c1", {
      blendMode: "screen" as Clip["blendMode"],
      blendOpacity: 0.5,
      speed: 2,
      reversed: true,
      muted: true,
      audioTrackIndex: 1,
      emphasisAnimation: { type: "pulse" } as unknown as Clip["emphasisAnimation"],
      audioEffects: [{ id: "ae1", type: "reverb", params: {}, enabled: true }],
    });
    const project = makeProject([clip]);
    const executor = new ActionExecutor(new ActionHistory());

    await executor.execute(act("clip/remove", { clipId: "c1" }), project);
    expect(project.timeline.tracks[0].clips).toHaveLength(0);

    await executor.undo(project);
    const restored = project.timeline.tracks[0].clips[0];
    expect(restored).toBeDefined();
    // cloneClip() omits these — undo silently loses them today.
    expect(restored.blendMode).toBe("screen");
    expect(restored.speed).toBe(2);
    expect(restored.reversed).toBe(true);
    expect(restored.muted).toBe(true);
    expect(restored.audioTrackIndex).toBe(1);
    expect(restored.emphasisAnimation).toEqual({ type: "pulse" });
    expect(restored.audioEffects).toHaveLength(1);
  });

  it("F11: clip/slip must generate a real inverse (be undoable)", async () => {
    const project = makeProject([makeClip("c1", { inPoint: 2, outPoint: 7 })]);
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);

    await executor.execute(act("clip/slip", { clipId: "c1", delta: 1 }), project);
    const entry = history.peekUndo();
    // Today generateClipInverse has no slip case → inverseAction is null → not undoable.
    expect(entry?.inverseAction).not.toBeNull();

    // and it actually restores the prior in/out points
    await executor.undo(project);
    const c = project.timeline.tracks[0].clips[0];
    expect(c.inPoint).toBe(2);
    expect(c.outPoint).toBe(7);
  });

  it("redo of an add reuses the SAME id (captured __addedId → stable redo)", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await executor.execute(act("clip/add", { trackId: "t1", mediaId: "m1", startTime: 0 }), project);
    const id1 = project.timeline.tracks[0].clips[0].id;

    await executor.undo(project);
    expect(project.timeline.tracks[0].clips).toHaveLength(0);
    await executor.redo(project);
    const id2 = project.timeline.tracks[0].clips[0].id;
    expect(id2).toBe(id1); // same id — not a fresh Date.now() one

    // the recorded inverse still matches after redo
    await executor.undo(project);
    expect(project.timeline.tracks[0].clips).toHaveLength(0);
  });

  it("F4: a mid-apply throw rolls back to the pre-apply state (atomicity)", async () => {
    const project = makeProject([makeClip("c1", { volume: 1 })]);
    // An engine whose update throws — clip/applyState processes its `clips`
    // (mutating the timeline) BEFORE its `textClips` (which hits the engine),
    // so without rollback the timeline is left partially mutated.
    const throwingEngine = {
      getTextClip: () => undefined,
      getAllTextClips: () => [],
      loadTextClips: () => {},
      updateTextClip: () => {
        throw new Error("engine boom");
      },
      deleteTextClip: () => false,
    };
    const executor = new ActionExecutor(new ActionHistory(), {
      getTitleEngine: () => throwingEngine as never,
    });

    const before = JSON.stringify(project.timeline);
    const res = await executor.execute(
      act("clip/applyState", {
        label: "batch edit",
        clips: [{ clipId: "c1", state: { ...makeClip("c1"), volume: 0.2 } }],
        textClips: [{ clipId: "t1", state: { id: "t1", text: "x" } }],
      }),
      project,
    );

    expect(res.success).toBe(false);
    // Timeline was mutated (c1.volume 1 → 0.2) then rolled back to volume 1.
    expect(JSON.stringify(project.timeline)).toBe(before);
    expect(project.timeline.tracks[0].clips[0].volume).toBe(1);
  });

  it("F6: a seeded id generator makes the action stream reproducible", async () => {
    const run = async () => {
      const project = makeProject();
      const executor = new ActionExecutor(new ActionHistory(), {
        idGenerator: createSeededIdGenerator("t"),
      });
      await executor.execute(act("clip/add", { trackId: "t1", mediaId: "m1", startTime: 0 }), project);
      await executor.execute(act("subtitle/add", { text: "x", startTime: 0, endTime: 1 }), project);
      return {
        clip: project.timeline.tracks[0].clips[0].id,
        sub: project.timeline.subtitles[0].id,
      };
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(a.clip).toBe("clip-t-0");
    expect(a.sub).toBe("subtitle-t-1");
  });

  it("F10: setMaxHistorySize remaps snapshot indices when trimming", () => {
    const h = new ActionHistory();
    for (let i = 0; i < 5; i++) {
      h.push({ type: "clip/move", id: `a${i}`, timestamp: 0, params: {} } as Action, null);
    }
    const snap = h.createSnapshot("mark");
    expect(snap.stackIndex).toBe(5);
    h.setMaxHistorySize(2); // trims the 3 oldest
    expect(h.getUndoStackSize()).toBe(2);
    expect(h.getSnapshots()[0].stackIndex).toBe(2); // 5 - 3
  });

  it("F8-subtitle: undo of setStyle restores each subtitle's own prior style", async () => {
    const project = {
      id: "p",
      name: "t",
      createdAt: 0,
      modifiedAt: 0,
      settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
      mediaLibrary: { items: [] },
      timeline: {
        duration: 0,
        tracks: [],
        subtitles: [
          { id: "s1", text: "a", startTime: 0, endTime: 1, style: { color: "red" } },
          { id: "s2", text: "b", startTime: 1, endTime: 2, style: { color: "blue" } },
        ],
      },
      textClips: [],
    } as unknown as Project;
    const executor = new ActionExecutor(new ActionHistory());

    await executor.execute(act("subtitle/setStyle", { style: { color: "green" } }), project);
    expect(
      project.timeline.subtitles.every((s: any) => s.style?.color === "green"),
    ).toBe(true);

    await executor.undo(project);
    const byId: Record<string, string> = Object.fromEntries(
      project.timeline.subtitles.map((s: any) => [s.id, s.style?.color]),
    );
    expect(byId.s1).toBe("red");
    expect(byId.s2).toBe("blue");
  });
});
