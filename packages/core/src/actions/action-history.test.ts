import { describe, it, expect, beforeEach } from "vitest";
import { ActionHistory } from "./action-history";
import type { Action } from "../types/actions";

/**
 * Tests the persistence layer that lets the studio-ai chat's
 * per-message rewind bookmarks survive a page reload. If
 * `serialize()` / `restore()` lose snapshots or stack indices, the
 * rewind feature breaks silently — the bookmark is still on the chat
 * doc but it points into an empty stack.
 */
describe("ActionHistory.serialize / restore", () => {
  let history: ActionHistory;

  beforeEach(() => {
    history = new ActionHistory();
  });

  function pushClipAction(id: string): void {
    const action: Action = {
      type: "clip/move",
      id,
      timestamp: Date.now(),
      params: { clipId: id, startTime: 5 },
    };
    const inverseAction: Action = {
      type: "clip/move",
      id: `inv-${id}`,
      timestamp: Date.now(),
      params: { clipId: id, startTime: 0 },
    };
    history.push(action, inverseAction);
  }

  it("round-trips an empty history", () => {
    const data = history.serialize();
    const fresh = new ActionHistory();
    fresh.restore(data);
    expect(fresh.canUndo()).toBe(false);
    expect(fresh.canRedo()).toBe(false);
    expect(fresh.getSnapshots()).toHaveLength(0);
  });

  it("preserves undoStack length so snapshot stackIndex bookmarks remain valid", () => {
    pushClipAction("a");
    pushClipAction("b");
    pushClipAction("c");
    const beforeLen = history.getUndoStackSize();
    const data = history.serialize();
    const fresh = new ActionHistory();
    fresh.restore(data);
    expect(fresh.getUndoStackSize()).toBe(beforeLen);
  });

  it("preserves snapshot stackIndex so chat rewind bookmarks resolve to the same point", () => {
    pushClipAction("a");
    const checkpoint = history.createSnapshot("agent-checkpoint-1");
    pushClipAction("b");
    pushClipAction("c");

    const data = history.serialize();
    const fresh = new ActionHistory();
    fresh.restore(data);

    const snaps = fresh.getSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].id).toBe(checkpoint.id);
    expect(snaps[0].stackIndex).toBe(checkpoint.stackIndex);
    expect(snaps[0].name).toBe("agent-checkpoint-1");
    // After restore the stack is at length 3; rewind walks 2 undos
    // back to index 1 (the snapshot point).
    expect(fresh.getUndoStackSize()).toBe(3);
  });

  it("preserves inverse actions so undo() works after a restore", () => {
    pushClipAction("a");
    pushClipAction("b");
    const data = history.serialize();
    const fresh = new ActionHistory();
    fresh.restore(data);
    const inverse = fresh.undo();
    expect(inverse).not.toBeNull();
    expect(inverse?.type).toBe("clip/move");
    expect((inverse?.params as { clipId: string }).clipId).toBe("b");
  });

  it("clears state when restore() receives a version mismatch", () => {
    pushClipAction("a");
    const checkpoint = history.createSnapshot("cp");
    history.restore({ version: 999, undoStack: [], redoStack: [], snapshots: [] });
    expect(history.getUndoStackSize()).toBe(0);
    expect(history.getSnapshots()).toHaveLength(0);
    void checkpoint; // referenced for clarity
  });

  it("clears state when restore() receives non-object junk (corrupt autosave)", () => {
    pushClipAction("a");
    history.restore(null);
    expect(history.getUndoStackSize()).toBe(0);
    history.restore(undefined);
    expect(history.getUndoStackSize()).toBe(0);
    history.restore("not-an-object" as unknown);
    expect(history.getUndoStackSize()).toBe(0);
  });

  it("survives a JSON round-trip (the actual persistence path)", () => {
    pushClipAction("a");
    pushClipAction("b");
    history.createSnapshot("turn-1");
    pushClipAction("c");

    const blob = JSON.stringify(history.serialize());
    const restored = new ActionHistory();
    restored.restore(JSON.parse(blob));

    expect(restored.getUndoStackSize()).toBe(3);
    expect(restored.getSnapshots()).toHaveLength(1);
    expect(restored.getSnapshots()[0].name).toBe("turn-1");
  });

  it("survives an entry whose action params contain non-serialisable values", () => {
    // Simulate a caller stuffing a DOM-ish object into params (the
    // serialize() path JSON-clones defensively so this shouldn't crash).
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    history.push(
      { type: "clip/move", id: "circ", timestamp: 0, params: { ref: circular } },
      null,
    );
    pushClipAction("ok");
    // Should not throw.
    const data = history.serialize();
    expect(data.undoStack).toHaveLength(2);
    // The bad entry's params get blanked but the entry stays so
    // stack-length bookkeeping survives.
    expect(data.undoStack[0].action.type).toBe("clip/move");
    expect(data.undoStack[1].action.params).toEqual({
      clipId: "ok",
      startTime: 5,
    });
  });
});
