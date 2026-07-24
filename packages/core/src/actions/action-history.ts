import type { Action } from "../types/actions";

export interface HistoryEntry {
  readonly action: Action;
  readonly inverseAction: Action | null;
  readonly timestamp: number;
  readonly description: string;
  readonly groupId?: string;
}

export interface ActionGroup {
  id: string;
  description: string;
  actions: HistoryEntry[];
  timestamp: number;
}

export interface HistorySnapshot {
  id: string;
  name: string;
  timestamp: number;
  stackIndex: number;
}

const ACTION_DESCRIPTIONS: Record<
  string,
  (params: Record<string, unknown>) => string
> = {
  "clip/add": () => "Add clip",
  "clip/remove": () => "Delete clip",
  "clip/move": () => "Move clip",
  "clip/trim": () => "Trim clip",
  "clip/split": () => "Split clip",
  "clip/rippleDelete": () => "Ripple delete",
  "clip/duplicate": () => "Duplicate clip",
  "clip/applyState": (params) => String(params.label || "Apply effect"),
  "track/add": (params) => `Add ${params.trackType} track`,
  "track/remove": () => "Remove track",
  "effect/add": (params) => `Add ${params.effectType} effect`,
  "effect/remove": () => "Remove effect",
  "effect/update": () => "Update effect",
  "transform/update": () => "Transform clip",
  "keyframe/add": (params) => `Add ${params.property} keyframe`,
  "keyframe/remove": () => "Remove keyframe",
  "transition/add": (params) => `Add ${params.transitionType} transition`,
  "transition/remove": () => "Remove transition",
  "audio/setVolume": () => "Adjust volume",
  "audio/setMuted": (params) => params.muted ? "Mute clip" : "Unmute clip",
  "audio/setFade": () => "Adjust fade",
  "subtitle/add": () => "Add subtitle",
  "subtitle/remove": () => "Remove subtitle",
  "text/add": () => "Add text",
  "text/remove": () => "Remove text",
  "text/update": (params) => {
    const u = (params.updates ?? {}) as Record<string, unknown>;
    if (typeof u.text === "string") return "Edit text";
    if (typeof u.startTime === "number" || typeof u.duration === "number") return "Move/trim text";
    if (u.style) return "Style text";
    if (u.transform) return "Transform text";
    return "Update text";
  },
  "project/rename": () => "Rename project",
  "project/updateSettings": () => "Update settings",
  "media/import": () => "Import media",
  "media/delete": () => "Delete media",
};

function getActionDescription(action: Action): string {
  const descFn = ACTION_DESCRIPTIONS[action.type];
  if (descFn) {
    return descFn(action.params as Record<string, unknown>);
  }
  const parts = action.type.split("/");
  return `${parts[0]}: ${parts[1] || "action"}`;
}

export class ActionHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private maxHistorySize: number;
  private currentGroupId: string | null = null;
  private snapshots: HistorySnapshot[] = [];
  private listeners: Set<() => void> = new Set();
  private lastActionTime: number = 0;
  private autoGroupWindow: number = 100;

  constructor(maxHistorySize: number = 1000) {
    this.maxHistorySize = maxHistorySize;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  push(action: Action, inverseAction: Action | null = null): void {
    const now = Date.now();
    const timeSinceLastAction = now - this.lastActionTime;
    this.lastActionTime = now;

    const shouldAutoGroup =
      timeSinceLastAction < this.autoGroupWindow &&
      this.undoStack.length > 0 &&
      this.undoStack[this.undoStack.length - 1].action.type === action.type;

    let groupId = this.currentGroupId;
    if (shouldAutoGroup && !groupId) {
      groupId = `auto-${now}`;
      const lastEntry = this.undoStack[this.undoStack.length - 1];
      if (!lastEntry.groupId) {
        this.undoStack[this.undoStack.length - 1] = { ...lastEntry, groupId };
      }
    }

    const entry: HistoryEntry = {
      action,
      inverseAction,
      timestamp: now,
      description: getActionDescription(action),
      groupId: groupId || undefined,
    };

    this.undoStack.push(entry);
    this.redoStack = [];

    this.snapshots = this.snapshots.filter(
      (s) => s.stackIndex <= this.undoStack.length,
    );

    if (this.undoStack.length > this.maxHistorySize) {
      this.undoStack.shift();
      this.snapshots = this.snapshots
        .map((s) => ({ ...s, stackIndex: s.stackIndex - 1 }))
        .filter((s) => s.stackIndex >= 0);
    }

    this.notify();
  }

  beginGroup(_description?: string): string {
    this.currentGroupId = `group-${Date.now()}`;
    return this.currentGroupId;
  }

  endGroup(): void {
    this.currentGroupId = null;
    this.notify();
  }

  setAutoGroupWindow(ms: number): void {
    this.autoGroupWindow = ms;
  }

  /** Timestamp of the newest undoable entry (null if none). Used to interleave
   *  this stack with the store's separate clip-creation undo stack in the right
   *  temporal order. */
  peekUndoTimestamp(): number | null {
    const e = this.undoStack[this.undoStack.length - 1];
    return e ? e.timestamp : null;
  }

  /** Timestamp of the entry that a redo would re-apply (null if none). */
  peekRedoTimestamp(): number | null {
    const e = this.redoStack[this.redoStack.length - 1];
    return e ? e.timestamp : null;
  }

  undo(): Action | null {
    const entry = this.undoStack.pop();
    if (entry) {
      this.redoStack.push(entry);
      this.notify();
      return entry.inverseAction;
    }
    return null;
  }

  undoGroup(): Action[] {
    if (this.undoStack.length === 0) return [];

    const lastEntry = this.undoStack[this.undoStack.length - 1];
    const groupId = lastEntry.groupId;

    if (!groupId) {
      const action = this.undo();
      return action ? [action] : [];
    }

    const inverseActions: Action[] = [];
    while (
      this.undoStack.length > 0 &&
      this.undoStack[this.undoStack.length - 1].groupId === groupId
    ) {
      const action = this.undo();
      if (action) inverseActions.push(action);
    }
    return inverseActions;
  }

  redo(): Action | null {
    const entry = this.redoStack.pop();
    if (entry) {
      this.undoStack.push(entry);
      this.notify();
      return entry.action;
    }
    return null;
  }

  redoGroup(): Action[] {
    if (this.redoStack.length === 0) return [];

    const nextEntry = this.redoStack[this.redoStack.length - 1];
    const groupId = nextEntry.groupId;

    if (!groupId) {
      const action = this.redo();
      return action ? [action] : [];
    }

    const actions: Action[] = [];
    while (
      this.redoStack.length > 0 &&
      this.redoStack[this.redoStack.length - 1].groupId === groupId
    ) {
      const action = this.redo();
      if (action) actions.push(action);
    }
    return actions;
  }

  createSnapshot(name: string): HistorySnapshot {
    const snapshot: HistorySnapshot = {
      id: `snapshot-${Date.now()}`,
      name,
      timestamp: Date.now(),
      stackIndex: this.undoStack.length,
    };
    this.snapshots.push(snapshot);
    this.notify();
    return snapshot;
  }

  getSnapshots(): HistorySnapshot[] {
    return [...this.snapshots];
  }

  deleteSnapshot(id: string): boolean {
    const index = this.snapshots.findIndex((s) => s.id === id);
    if (index !== -1) {
      this.snapshots.splice(index, 1);
      this.notify();
      return true;
    }
    return false;
  }

  getDisplayHistory(): Array<{ entry: HistoryEntry; isCurrent: boolean }> {
    const result: Array<{ entry: HistoryEntry; isCurrent: boolean }> = [];
    const seen = new Set<string>();

    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      const entry = this.undoStack[i];
      if (entry.groupId) {
        if (!seen.has(entry.groupId)) {
          seen.add(entry.groupId);
          result.push({ entry, isCurrent: i === this.undoStack.length - 1 });
        }
      } else {
        result.push({ entry, isCurrent: i === this.undoStack.length - 1 });
      }
    }
    return result.reverse();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  getHistory(): Action[] {
    return this.undoStack.map((entry) => entry.action);
  }

  getHistoryEntries(): HistoryEntry[] {
    return [...this.undoStack];
  }

  getRedoEntries(): HistoryEntry[] {
    return [...this.redoStack];
  }

  /**
   * Serialise the live undo/redo stacks + named snapshots into a
   * JSON-safe payload. Use this when persisting alongside the project
   * (e.g. autosave to IndexedDB, manual save to .oreel) so history
   * survives a page reload — without persistence, every snapshot
   * bookmark held by an external system (chat per-message rewind,
   * "Restore checkpoint" button) becomes a dangling pointer the
   * moment the tab closes.
   *
   * Action params are JSON-cloned defensively in case a caller
   * shoves non-serialisable junk (DOM nodes, FileSystemHandle) in;
   * a single bad entry shouldn't poison the whole history.
   */
  serialize(): {
    undoStack: HistoryEntry[];
    redoStack: HistoryEntry[];
    snapshots: HistorySnapshot[];
    version: 1;
  } {
    const cloneEntry = (e: HistoryEntry): HistoryEntry => {
      try {
        return {
          action: JSON.parse(JSON.stringify(e.action)),
          inverseAction: e.inverseAction
            ? JSON.parse(JSON.stringify(e.inverseAction))
            : null,
          timestamp: e.timestamp,
          description: e.description,
          groupId: e.groupId,
        };
      } catch {
        // Non-serialisable entry — skip the action body, keep
        // metadata so the stack length stays correct (snapshot
        // stackIndex bookmarks rely on it). Action will silent-no-op
        // on undo, which is the same behaviour as a missing inverse.
        return {
          action: { type: e.action.type, id: e.action.id, timestamp: e.action.timestamp, params: {} },
          inverseAction: null,
          timestamp: e.timestamp,
          description: e.description,
          groupId: e.groupId,
        };
      }
    };
    return {
      version: 1,
      undoStack: this.undoStack.map(cloneEntry),
      redoStack: this.redoStack.map(cloneEntry),
      snapshots: [...this.snapshots],
    };
  }

  /**
   * Hydrate from a previously-serialised payload. Replaces all
   * stacks + snapshots — caller is responsible for ensuring the
   * project state matches what the history claims to undo.
   *
   * Tolerates partially-corrupt payloads (missing fields, version
   * mismatch): clears history rather than throwing, so a bad
   * autosave never blocks the editor from opening.
   */
  restore(data: unknown): void {
    if (!data || typeof data !== "object") {
      this.clear();
      return;
    }
    const d = data as Partial<ReturnType<ActionHistory["serialize"]>>;
    if (d.version !== 1) {
      this.clear();
      return;
    }
    this.undoStack = Array.isArray(d.undoStack) ? d.undoStack : [];
    this.redoStack = Array.isArray(d.redoStack) ? d.redoStack : [];
    this.snapshots = Array.isArray(d.snapshots) ? d.snapshots : [];
    this.currentGroupId = null;
    this.lastActionTime = 0;
    this.notify();
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.snapshots = [];
    this.currentGroupId = null;
    this.notify();
  }

  getUndoStackSize(): number {
    return this.undoStack.length;
  }

  getRedoStackSize(): number {
    return this.redoStack.length;
  }

  peekUndo(): HistoryEntry | null {
    return this.undoStack.length > 0
      ? this.undoStack[this.undoStack.length - 1]
      : null;
  }

  peekRedo(): HistoryEntry | null {
    return this.redoStack.length > 0
      ? this.redoStack[this.redoStack.length - 1]
      : null;
  }

  getMaxHistorySize(): number {
    return this.maxHistorySize;
  }

  setMaxHistorySize(size: number): void {
    this.maxHistorySize = size;
    // Trim if necessary. FOUNDATION FIX (F10): shift() removes the OLDEST
    // entries, so every snapshot's stackIndex must slide down by the number
    // trimmed (mirrors push()'s trim) — otherwise snapshot bookmarks point at
    // the wrong position after a shrink.
    let shifted = 0;
    while (this.undoStack.length > this.maxHistorySize) {
      this.undoStack.shift();
      shifted++;
    }
    if (shifted > 0) {
      this.snapshots = this.snapshots
        .map((s) => ({ ...s, stackIndex: s.stackIndex - shifted }))
        .filter((s) => s.stackIndex >= 0);
    }
  }
}
