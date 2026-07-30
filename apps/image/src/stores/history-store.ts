import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { Command } from '@openreel/image-core/commands';
import type { Project } from '../types/project';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: string;
  timestamp: number;
  description: string;
}

interface CommandRecord {
  id: string;
  timestamp: number;
  command: Command;
}

interface Snapshot {
  id: string;
  name: string;
  timestamp: number;
  /** Serialised project state for this snapshot. */
  state: string;
  thumbnail?: string;
}

interface HistoryState {
  undoStack: CommandRecord[];
  redoStack: CommandRecord[];
  /** Serialised project state captured before the first command was recorded. */
  baseProject: string | null;
  maxSize: number;
  snapshots: Snapshot[];
  /**
   * Coalescing barrier. Any record whose timestamp is at or before this instant
   * refuses to absorb a following command. Set by `breakCoalescing()`; a fresh
   * record always timestamps after it, so ordinary drag-coalescing still works
   * within the next run.
   */
  mergeBarrierAt: number;
  /** Monotonic counter of commands EVICTED by maxSize, so a checkpoint taken
   *  before an eviction can tell "shifted" from "still valid". */
  evictedCount: number;
}

interface HistoryActions {
  /**
   * Record and immediately apply `cmd` to `currentProject`.
   * Returns the updated project that callers must set into the project store.
   */
  execute: (cmd: Command, currentProject: Project) => Project;

  /**
   * Push a command that has ALREADY been applied.
   *
   * `execute` both applies and records; a transaction cannot use it, because its
   * inner steps must apply as they go (each one reads the project the previous
   * one produced) while landing on the stack as a SINGLE entry. So the
   * transaction applies the parts itself and hands the composite here.
   *
   * `projectBeforeCommand` is only used to seed `baseProject` when this is the
   * first command ever recorded, keeping `goToEntry` replay correct.
   *
   * Never coalesces — a recorded command is already a finished, labelled action.
   */
  record: (command: Command, projectBeforeCommand: Project) => void;

  /**
   * Undo the most recent command.  Applies the inverse to `currentProject`
   * and returns the restored project, or `null` when nothing can be undone.
   */
  undo: (currentProject: Project) => Project | null;

  /**
   * Re-apply the most recently undone command to `currentProject`.
   * Returns the restored project or `null` when there is nothing to redo.
   */
  redo: (currentProject: Project) => Project | null;

  canUndo: () => boolean;
  canRedo: () => boolean;

  /**
   * Human-readable description of the command that would be undone next.
   */
  getUndoDescription: () => string | null;

  /**
   * Human-readable description of the command that would be redone next.
   */
  getRedoDescription: () => string | null;

  /**
   * Jump to an arbitrary position in the undo stack (0 = oldest, length-1 = newest).
   * Replays all commands from `baseProject` up to and including `index`.
   * Returns the project at that point or `null` on failure.
   */
  goToEntry: (index: number) => Project | null;

  /**
   * Derived list of entries for the HistoryPanel (newest first when reversed by consumer).
   */
  getEntries: () => HistoryEntry[];

  /** Current position: index of the entry that reflects the present project state. */
  getCurrentIndex: () => number;

  clear: (baseProject?: Project) => void;
  /**
   * Invalidate the redo stack WITHOUT touching undo history. Call after a
   * project-data mutation that bypasses `execute` (e.g. addAsset/removeAsset), so
   * a stale redo can't replay a command onto a now-divergent project.
   */
  invalidateRedo: () => void;
  setMaxSize: (max: number) => void;

  // ── Named snapshots (checkpoint-style) ──────────────────────────────────

  createSnapshot: (name: string, project: Project, thumbnail?: string) => void;
  restoreSnapshot: (id: string) => Project | null;
  deleteSnapshot: (id: string) => void;
  renameSnapshot: (id: string, name: string) => void;
  getSnapshots: () => Snapshot[];

  // ── Agent checkpoints (lightweight undo-stack bookmarks) ────────────────

  /**
   * End the coalescing run, so the NEXT `execute` can never be folded into the
   * previous undo entry.
   *
   * `MERGE_WINDOW_MS` exists for continuous human gestures (a slider drag emits
   * dozens of updates that should be one undo step). Agent tool calls arrive
   * milliseconds apart and are NOT one gesture: two `img_edit_layer` calls on the
   * same layer would otherwise collapse into a single entry, and a checkpoint
   * taken between them could no longer be rewound to. Called at the end of every
   * agent mutation so each tool call is exactly one undo step.
   */
  breakCoalescing: () => void;

  /**
   * Bookmark the current undo-stack position. Cheap — no project serialisation
   * (an image project carries base64 pixels; snapshotting one per chat turn would
   * cost tens of MB).
   *
   * Records BOTH the depth and the id of the command on top of the stack.
   * `stackIndex` alone is not safe: the stack evicts its oldest entry past
   * `maxSize`, which shifts every index down, so a bookmark taken 60 edits ago
   * would silently resolve to the wrong place. `resolveCheckpoint` prefers the
   * id and reports eviction honestly instead of guessing.
   */
  createCheckpoint: (label?: string) => Checkpoint;

  /**
   * Where does this checkpoint sit in the CURRENT stack?
   *  - `{ ok: true, stackIndex }`      → rewind target (undo until depth === stackIndex)
   *  - `{ ok: false, reason: 'evicted' }`  → the command was dropped by maxSize; the
   *                                          caller must say so rather than rewind wrongly
   *  - `{ ok: false, reason: 'stale' }`     → stack was cleared (project closed/reloaded)
   */
  resolveCheckpoint: (cp: Checkpoint) => { ok: true; stackIndex: number } | { ok: false; reason: 'evicted' | 'stale' };

  /** Current undo depth — the value a checkpoint's `stackIndex` is compared to. */
  getUndoDepth: () => number;
}

/**
 * A lightweight undo-stack bookmark. `recordId` is the id of the command that was
 * on top when the checkpoint was taken (`null` = taken on an empty stack, i.e.
 * "rewind to the very beginning").
 */
export interface Checkpoint {
  id: string;
  label: string;
  timestamp: number;
  stackIndex: number;
  recordId: string | null;
  /**
   * The store's `evictedCount` when this checkpoint was taken. A checkpoint that
   * points at "the beginning of the stack" is only meaningful while nothing has
   * been dropped or cleared since — comparing counters is how we know.
   */
  evictedAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const generateId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

// Only consecutive edits within this gap coalesce into a single undo step (a
// slider drag streams many updates). Past it, each edit is its own step.
const MERGE_WINDOW_MS = 600;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useHistoryStore = create<HistoryState & HistoryActions>()(
  subscribeWithSelector((set, get) => ({
    undoStack: [],
    redoStack: [],
    baseProject: null,
    maxSize: 50,
    snapshots: [],
    mergeBarrierAt: 0,
    evictedCount: 0,

    execute: (cmd, currentProject) => {
      const { undoStack, maxSize, baseProject, mergeBarrierAt } = get();

      // Capture base project on first command ever.
      const base = baseProject ?? JSON.stringify(currentProject);

      // Attempt to coalesce with the most recent command via Command.merge.
      // Merge is called on the LAST (older) command with the NEW command as argument.
      // We ONLY coalesce edits that land within MERGE_WINDOW_MS of the previous
      // one — a continuous gesture like dragging a slider. A pause ends the run,
      // so two deliberate edits are two undo steps (Photoshop-like granularity).
      // The command's own merge() additionally refuses to fold DISTINCT actions
      // (crop, mask, flip…) together — so those are always their own step, which
      // is what makes "undo the crop" work as a discrete action.
      if (undoStack.length > 0) {
        const last = undoStack[undoStack.length - 1];
        const withinWindow = Date.now() - last.timestamp <= MERGE_WINDOW_MS;
        // A barrier (see breakCoalescing) closes the run: the record on top is
        // final and cannot absorb this command, even inside the time window.
        const barred = last.timestamp <= mergeBarrierAt;
        const merged = withinWindow && !barred ? (last.command.merge?.(cmd) ?? null) : null;
        if (merged !== null) {
          const newProject = cmd.apply(currentProject);
          const updatedStack = [
            ...undoStack.slice(0, -1),
            // Refresh the timestamp so a long continuous drag keeps coalescing
            // as long as each event stays within the window of the previous.
            { ...last, command: merged, timestamp: Date.now() },
          ];
          set({
            undoStack: updatedStack,
            redoStack: [],
            baseProject: base,
          });
          return newProject;
        }
      }

      const newProject = cmd.apply(currentProject);

      const record: CommandRecord = {
        id: generateId(),
        timestamp: Date.now(),
        command: cmd,
      };

      let newStack = [...undoStack, record];
      if (newStack.length > maxSize) {
        // When we drop the oldest command we need to update baseProject to
        // the state *after* that command would have been applied so that
        // goToEntry remains correct.  We approximate by re-serialising the
        // project state that preceded the second-oldest command (i.e. we
        // compute the new base by applying the dropped command to the old
        // base and serialising that result).
        const dropped = newStack[0];
        let newBase: Project | null = null;
        try {
          const parsed = JSON.parse(base) as Project;
          newBase = dropped.command.apply(parsed);
        } catch {
          newBase = null;
        }
        newStack = newStack.slice(1);
        set({
          undoStack: newStack,
          redoStack: [],
          baseProject: newBase ? JSON.stringify(newBase) : base,
          // Every index in the stack just shifted down by one. Checkpoints
          // resolve by record id, and this counter is how they tell an eviction
          // happened at all.
          evictedCount: get().evictedCount + 1,
        });
      } else {
        set({ undoStack: newStack, redoStack: [], baseProject: base });
      }

      return newProject;
    },

    record: (command, projectBeforeCommand) => {
      const { undoStack, maxSize, baseProject } = get();
      const base = baseProject ?? JSON.stringify(projectBeforeCommand);

      let newStack = [...undoStack, { id: generateId(), timestamp: Date.now(), command }];
      let evicted = 0;
      let nextBase = base;
      if (newStack.length > maxSize) {
        const dropped = newStack[0];
        try {
          nextBase = JSON.stringify(dropped.command.apply(JSON.parse(base) as Project));
        } catch {
          nextBase = base;
        }
        newStack = newStack.slice(1);
        evicted = 1;
      }
      set({
        undoStack: newStack,
        redoStack: [],
        baseProject: nextBase,
        evictedCount: get().evictedCount + evicted,
        // A recorded action closes any open coalescing run.
        mergeBarrierAt: Date.now(),
      });
    },

    undo: (currentProject) => {
      const { undoStack, redoStack } = get();
      if (undoStack.length === 0) return null;

      const record = undoStack[undoStack.length - 1];
      const inverse = record.command.invert();
      const restoredProject = inverse.apply(currentProject);

      set({
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, record],
      });

      return restoredProject;
    },

    redo: (currentProject) => {
      const { undoStack, redoStack } = get();
      if (redoStack.length === 0) return null;

      const record = redoStack[redoStack.length - 1];
      const newProject = record.command.apply(currentProject);

      set({
        undoStack: [...undoStack, record],
        redoStack: redoStack.slice(0, -1),
      });

      return newProject;
    },

    canUndo: () => get().undoStack.length > 0,
    canRedo: () => get().redoStack.length > 0,

    getUndoDescription: () => {
      const { undoStack } = get();
      return undoStack.length > 0 ? undoStack[undoStack.length - 1].command.description : null;
    },

    getRedoDescription: () => {
      const { redoStack } = get();
      return redoStack.length > 0 ? redoStack[redoStack.length - 1].command.description : null;
    },

    goToEntry: (index) => {
      const { undoStack, baseProject } = get();
      if (index < 0 || index >= undoStack.length) return null;
      if (!baseProject) return null;

      try {
        let project = JSON.parse(baseProject) as Project;
        for (let i = 0; i <= index; i++) {
          project = undoStack[i].command.apply(project);
        }
        // Commands past the target index become the redo stack, reversed so that
        // the next command to re-apply (index+1) is at the end (popped first on redo).
        const redoCommands = undoStack.slice(index + 1).reverse();
        set({ undoStack: undoStack.slice(0, index + 1), redoStack: redoCommands });
        return project;
      } catch {
        return null;
      }
    },

    getEntries: () =>
      get().undoStack.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        description: r.command.description,
      })),

    getCurrentIndex: () => get().undoStack.length - 1,

    clear: (baseProject) => {
      set({
        undoStack: [],
        redoStack: [],
        baseProject: baseProject ? JSON.stringify(baseProject) : null,
        // A cleared stack invalidates every outstanding checkpoint. Bumping the
        // eviction counter is what makes `resolveCheckpoint` answer 'stale'
        // instead of matching a coincidentally-equal depth in the new session.
        evictedCount: get().evictedCount + 1,
        mergeBarrierAt: 0,
      });
    },

    invalidateRedo: () => {
      if (get().redoStack.length > 0) set({ redoStack: [] });
    },

    setMaxSize: (max) => set({ maxSize: max }),

    // ── Named snapshots ────────────────────────────────────────────────────

    createSnapshot: (name, project, thumbnail) => {
      const { snapshots } = get();
      const snapshot: Snapshot = {
        id: generateId(),
        name,
        timestamp: Date.now(),
        state: JSON.stringify(project),
        thumbnail,
      };
      set({ snapshots: [...snapshots, snapshot] });
    },

    restoreSnapshot: (id) => {
      const { snapshots } = get();
      const snapshot = snapshots.find((s) => s.id === id);
      if (!snapshot) return null;
      try {
        return JSON.parse(snapshot.state) as Project;
      } catch {
        return null;
      }
    },

    deleteSnapshot: (id) => {
      set({ snapshots: get().snapshots.filter((s) => s.id !== id) });
    },

    renameSnapshot: (id, name) => {
      set({
        snapshots: get().snapshots.map((s) => (s.id === id ? { ...s, name } : s)),
      });
    },

    getSnapshots: () => get().snapshots,

    // ── Agent checkpoints ──────────────────────────────────────────────────

    breakCoalescing: () => set({ mergeBarrierAt: Date.now() }),

    getUndoDepth: () => get().undoStack.length,

    createCheckpoint: (label) => {
      const { undoStack, evictedCount } = get();
      const top = undoStack.length > 0 ? undoStack[undoStack.length - 1] : null;
      // Close the coalescing run as well: whatever happens after this
      // checkpoint must be a NEW undo entry, or the checkpoint would sit inside
      // a record that later grows to include post-checkpoint work — and
      // rewinding to it would undo more than it should.
      set({ mergeBarrierAt: Date.now() });
      return {
        id: generateId(),
        label: label ?? 'Checkpoint',
        timestamp: Date.now(),
        stackIndex: undoStack.length,
        recordId: top?.id ?? null,
        evictedAt: evictedCount,
      };
    },

    resolveCheckpoint: (cp) => {
      const { undoStack, evictedCount } = get();

      // The bookmarked command is still on the stack — the unambiguous case, and
      // true regardless of what was evicted below it. Depth is idx + 1: rewinding
      // to it KEEPS the bookmarked command and drops everything after.
      if (cp.recordId !== null) {
        const idx = undoStack.findIndex((r) => r.id === cp.recordId);
        if (idx >= 0) return { ok: true, stackIndex: idx + 1 };
      } else if (evictedCount === cp.evictedAt) {
        // Taken on an empty stack and nothing has been dropped or cleared since,
        // so index 0 really is the state the checkpoint refers to.
        return { ok: true, stackIndex: 0 };
      }

      // Unresolvable. Say WHICH way it failed — "you closed the project" and
      // "that edit is older than the 50-step history" need different words, and
      // guessing a stack position instead would rewind the wrong work.
      if (undoStack.length === 0) return { ok: false, reason: 'stale' };
      return { ok: false, reason: 'evicted' };
    },
  }))
);
