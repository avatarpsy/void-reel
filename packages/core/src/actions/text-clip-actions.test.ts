import { describe, it, expect, beforeEach } from "vitest";
import { ActionExecutor, type TitleEngineAdapter } from "./action-executor";
import { ActionHistory } from "./action-history";
import type { Action } from "../types/actions";
import type { Project } from "../types/project";
import type { TextClip } from "../text/types";

/**
 * Verifies caption / text-clip mutations round-trip through
 * ActionExecutor → ActionHistory cleanly. Before this wiring landed
 * those mutations bypassed the executor entirely (direct
 * titleEngine.updateTextClip()) and were unreachable from undo() or
 * the chat's snapshot-based rewind.
 */

class FakeTitleEngine implements TitleEngineAdapter {
  private clips = new Map<string, TextClip>();

  load(initial: TextClip[]): void {
    this.clips = new Map(initial.map((c) => [c.id, c]));
  }

  getTextClip(id: string): TextClip | undefined {
    return this.clips.get(id);
  }
  getAllTextClips(): TextClip[] {
    return Array.from(this.clips.values());
  }
  loadTextClips(clips: TextClip[]): void {
    this.clips = new Map(clips.map((c) => [c.id, c]));
  }
  updateTextClip(id: string, updates: any): TextClip | undefined {
    const existing = this.clips.get(id);
    if (!existing) return undefined;
    const updated: TextClip = { ...existing, ...updates };
    this.clips.set(id, updated);
    return updated;
  }
  deleteTextClip(id: string): boolean {
    return this.clips.delete(id);
  }
}

function makeProject(): Project {
  return {
    id: "p1",
    name: "Test",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: [] },
    timeline: { duration: 0, tracks: [], subtitles: [] } as any,
    textClips: [],
  } as Project;
}

function makeTextClip(id: string, overrides: Partial<TextClip> = {}): TextClip {
  return {
    id,
    trackId: "captions",
    startTime: 0,
    duration: 5,
    text: `clip-${id}`,
    style: {} as any,
    transform: {} as any,
    keyframes: [],
    ...overrides,
  } as TextClip;
}

describe("text/* actions through ActionExecutor", () => {
  let engine: FakeTitleEngine;
  let executor: ActionExecutor;
  let history: ActionHistory;
  let project: Project;

  beforeEach(() => {
    engine = new FakeTitleEngine();
    history = new ActionHistory();
    executor = new ActionExecutor(history, { getTitleEngine: () => engine });
    project = makeProject();
  });

  it("text/update applies via the engine and registers in ActionHistory", async () => {
    engine.load([makeTextClip("c1", { text: "hello", duration: 5 })]);
    const action: Action = {
      type: "text/update",
      id: "act-1",
      timestamp: 0,
      params: {
        clipId: "c1",
        updates: { text: "world", duration: 7 },
        previous: { text: "hello", duration: 5 },
      },
    };
    const result = await executor.execute(action, project);
    expect(result.success).toBe(true);
    expect(engine.getTextClip("c1")?.text).toBe("world");
    expect(engine.getTextClip("c1")?.duration).toBe(7);
    expect(history.canUndo()).toBe(true);
  });

  it("text/update is undoable via the executor's undo()", async () => {
    engine.load([makeTextClip("c1", { text: "hello", duration: 5 })]);
    const action: Action = {
      type: "text/update",
      id: "act-1",
      timestamp: 0,
      params: {
        clipId: "c1",
        updates: { text: "world", duration: 7 },
        previous: { text: "hello", duration: 5 },
      },
    };
    await executor.execute(action, project);
    const undoResult = await executor.undo(project);
    expect(undoResult.success).toBe(true);
    expect(engine.getTextClip("c1")?.text).toBe("hello");
    expect(engine.getTextClip("c1")?.duration).toBe(5);
  });

  it("text/update without `previous` is non-undoable but still applies (validator allows, generator returns null)", async () => {
    engine.load([makeTextClip("c1", { text: "hello" })]);
    const action: Action = {
      type: "text/update",
      id: "act-1",
      timestamp: 0,
      params: { clipId: "c1", updates: { text: "world" } }, // no `previous`
    };
    const result = await executor.execute(action, project);
    expect(result.success).toBe(true);
    expect(engine.getTextClip("c1")?.text).toBe("world");
    // Inverse is null → undo() can still pop the entry but applying
    // the inverse no-ops, so engine state stays at "world".
    await executor.undo(project);
    expect(engine.getTextClip("c1")?.text).toBe("world");
  });

  it("text/add followed by undo removes the clip", async () => {
    const newClip = makeTextClip("c1", { text: "fresh" });
    const action: Action = {
      type: "text/add",
      id: "act-1",
      timestamp: 0,
      params: { textClip: newClip },
    };
    await executor.execute(action, project);
    expect(engine.getTextClip("c1")?.text).toBe("fresh");
    await executor.undo(project);
    expect(engine.getTextClip("c1")).toBeUndefined();
  });

  it("text/remove with `previous` is reversible (clip comes back on undo)", async () => {
    const original = makeTextClip("c1", { text: "lorem", duration: 4 });
    engine.load([original]);
    const action: Action = {
      type: "text/remove",
      id: "act-1",
      timestamp: 0,
      params: { clipId: "c1", previous: original },
    };
    await executor.execute(action, project);
    expect(engine.getTextClip("c1")).toBeUndefined();
    await executor.undo(project);
    const restored = engine.getTextClip("c1");
    expect(restored).toBeDefined();
    expect(restored?.text).toBe("lorem");
    expect(restored?.duration).toBe(4);
  });

  it("validator rejects text/update without clipId", async () => {
    const action: Action = {
      type: "text/update",
      id: "act-1",
      timestamp: 0,
      params: { updates: { text: "x" } } as any,
    };
    const result = await executor.execute(action, project);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_PARAMS");
  });

  it("validator rejects text/add without textClip.id", async () => {
    const action: Action = {
      type: "text/add",
      id: "act-1",
      timestamp: 0,
      params: { textClip: { text: "no id" } } as any,
    };
    const result = await executor.execute(action, project);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_PARAMS");
  });

  it("text/* actions land in the same ActionHistory snapshot bookmarking system", async () => {
    engine.load([makeTextClip("c1", { text: "before" })]);
    const checkpoint = history.createSnapshot("before-edits");

    await executor.execute(
      {
        type: "text/update",
        id: "act-1",
        timestamp: 0,
        params: {
          clipId: "c1",
          updates: { text: "after-1" },
          previous: { text: "before" },
        },
      },
      project,
    );
    await executor.execute(
      {
        type: "text/update",
        id: "act-2",
        timestamp: 0,
        params: {
          clipId: "c1",
          updates: { text: "after-2" },
          previous: { text: "after-1" },
        },
      },
      project,
    );

    expect(engine.getTextClip("c1")?.text).toBe("after-2");
    // Walk back to checkpoint — the chat's restoreSnapshot path.
    while (history.getUndoStackSize() > checkpoint.stackIndex) {
      const r = await executor.undo(project);
      if (!r.success) break;
    }
    expect(engine.getTextClip("c1")?.text).toBe("before");
  });

  it("getTitleEngine returning null silently no-ops (test / headless render path)", async () => {
    const headlessExecutor = new ActionExecutor(history, {
      getTitleEngine: () => null,
    });
    engine.load([makeTextClip("c1", { text: "untouched" })]);
    const action: Action = {
      type: "text/update",
      id: "act-1",
      timestamp: 0,
      params: {
        clipId: "c1",
        updates: { text: "would-change" },
        previous: { text: "untouched" },
      },
    };
    const result = await headlessExecutor.execute(action, project);
    expect(result.success).toBe(true);
    // Engine not wired into THIS executor — engine state is unchanged.
    expect(engine.getTextClip("c1")?.text).toBe("untouched");
  });
});
