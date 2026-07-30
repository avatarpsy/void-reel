/**
 * Image editor ↔ Voidspace chat RPC.
 *
 * Same wire contract as the video editor (`apps/web/src/App.tsx`): the parent
 * page posts `{ type: 'voidspace:img-*', requestId, ...args }`, we post one
 * reply back carrying the same `requestId`, and failures come back as
 * `voidspace:error`. Keeping the shape identical means the chat side is the same
 * `rpc()` helper with a different message namespace, not a second protocol.
 *
 * The `img-` prefix is deliberate. The video editor answers bare `voidspace:*`
 * messages; if both editors are ever mounted in one page, a stray `get-state`
 * must not be answered by whichever happens to be listening.
 *
 * THREE RULES THIS FILE ENFORCES, because they are what makes agent editing
 * safe to hand a real user:
 *
 *  1. NO PIXELS OVER THE WIRE. Digests carry names and numbers. Pixels go to
 *     temp storage and come back as a URL.
 *  2. EVERY MUTATION IS ONE UNDO STEP. Mutating handlers run inside
 *     `runTransaction` and end with `breakCoalescing()`, so the user's Ctrl+Z
 *     reverses exactly one agent action — never half of one, never two.
 *  3. THE USER OUTRANKS THE AGENT. A mutation computed from a stale read is
 *     refused (`expectRev`), so hand edits made while the agent was thinking are
 *     never silently overwritten.
 */

import { useProjectStore, getProjectRev } from '../stores/project-store';
import { useHistoryStore } from '../stores/history-store';
import { buildCanvasDigest } from './canvas-digest';

type Reply = (payload: Record<string, unknown>) => void;

/** Refusal shape shared by every handler. `reason` is a stable machine code the
 *  agent can branch on; `message` is what the user would be told. */
function fail(reason: string, message: string) {
  return { ok: false as const, reason, message };
}

/**
 * Guard a mutation against a stale read.
 *
 * The agent reads the canvas, thinks for a few seconds, then writes. In that gap
 * the USER may have moved the very layer it is about to move. Without this the
 * agent's write silently wins and the person's work disappears with no undo
 * entry they'd recognise. With it, the agent is told to re-read and try again —
 * which it can do in one turn, and which is exactly how a careful collaborator
 * behaves.
 *
 * `expectRev` is optional: a first-turn edit with no prior read is allowed
 * through, since there is nothing it could be stale against.
 */
function checkRev(expectRev: unknown): { ok: true } | ReturnType<typeof fail> {
  if (typeof expectRev !== 'number') return { ok: true };
  if (getProjectRev() === expectRev) return { ok: true };
  return fail(
    'canvas_changed',
    'The canvas changed since you last read it (the user may have edited it). Re-read the canvas and redo this edit against the current state.',
  );
}

/**
 * Wrap a mutating handler: concurrency guard → single-undo-step transaction →
 * coalescing barrier → fresh `rev` for the agent's next call.
 *
 * Handlers registered through this can be written as plain functions; they get
 * all three guarantees without repeating them (and without being able to forget
 * one).
 */
function mutation<T extends Record<string, unknown>>(
  label: string,
  fn: (msg: any) => T,
): (msg: any) => Record<string, unknown> {
  return (msg: any) => {
    const gate = checkRev(msg?.expectRev);
    if (!gate.ok) return gate;

    const project = useProjectStore.getState().project;
    if (!project) return fail('no_project', 'No image project is open.');

    let out: T;
    try {
      out = useProjectStore.getState().runTransaction(label, () => fn(msg));
    } finally {
      // Whatever happened, close the coalescing run so the NEXT agent call can
      // never be folded into this one's undo entry.
      useHistoryStore.getState().breakCoalescing();
    }
    return {
      ok: true,
      ...out,
      rev: getProjectRev(),
      undoDepth: useHistoryStore.getState().getUndoDepth(),
    };
  };
}

/** Handlers that only read. No transaction, no barrier, no rev guard. */
const READ_HANDLERS: Record<string, (msg: any) => Record<string, unknown>> = {
  'voidspace:img-get-state': (msg) =>
    buildCanvasDigest({ pageId: msg?.pageId, includeLayers: msg?.includeLayers }) as unknown as Record<string, unknown>,

  /** Undo/redo availability + the labels the History panel is showing, so the
   *  agent can describe what a rewind would actually reverse. */
  'voidspace:img-history': () => {
    const h = useHistoryStore.getState();
    return {
      ok: true,
      undoDepth: h.getUndoDepth(),
      canUndo: h.canUndo(),
      canRedo: h.canRedo(),
      nextUndo: h.getUndoDescription(),
      nextRedo: h.getRedoDescription(),
      // Newest last, capped — the agent needs recent context, not the archive.
      recent: h.getEntries().slice(-12).map((e) => e.description),
    };
  },
};

/**
 * Checkpoint handlers — the per-chat-turn rewind anchor.
 *
 * Mirrors the video editor's `voidspace:snapshot` / `restore-snapshot`, but on
 * the image editor's own history: cheap id+depth bookmarks, and a rewind that
 * replays the SAME `undo()` the Ctrl+Z button calls. No parallel state capture —
 * if an edit doesn't show up in a rewind, the fix is to route that edit through
 * the command stack, never to add a second snapshot mechanism.
 */
const CHECKPOINT_HANDLERS: Record<string, (msg: any) => Record<string, unknown>> = {
  'voidspace:img-checkpoint': (msg) => {
    if (!useProjectStore.getState().project) return fail('no_project', 'No image project is open.');
    return { ok: true, checkpoint: useHistoryStore.getState().createCheckpoint(msg?.label) };
  },

  'voidspace:img-restore-checkpoint': (msg) => {
    const cp = msg?.checkpoint;
    if (!cp?.id) return fail('bad_request', 'checkpoint required');
    if (!useProjectStore.getState().project) return fail('no_project', 'No image project is open.');

    const resolved = useHistoryStore.getState().resolveCheckpoint(cp);
    if (!resolved.ok) {
      // Say which way it failed rather than rewinding to a guessed position.
      return resolved.reason === 'evicted'
        ? fail('checkpoint_evicted', 'That point is older than the editor\'s 50-step history, so it can no longer be undone to.')
        : fail('checkpoint_stale', 'That checkpoint belongs to a project that is no longer open.');
    }

    let undone = 0;
    // Replay real undos — the same path the toolbar button uses.
    while (useHistoryStore.getState().getUndoDepth() > resolved.stackIndex) {
      const before = useHistoryStore.getState().getUndoDepth();
      useProjectStore.getState().undo();
      if (useHistoryStore.getState().getUndoDepth() >= before) break; // refused to move; stop rather than spin
      undone++;
    }
    return {
      ok: true,
      undone,
      rev: getProjectRev(),
      undoDepth: useHistoryStore.getState().getUndoDepth(),
    };
  },

  /** Plain undo/redo, so "undo that" in chat does exactly what Ctrl+Z does. */
  'voidspace:img-undo': () => {
    if (!useHistoryStore.getState().canUndo()) return fail('nothing_to_undo', 'There is nothing to undo.');
    const description = useHistoryStore.getState().getUndoDescription();
    useProjectStore.getState().undo();
    return { ok: true, undone: description, rev: getProjectRev() };
  },

  'voidspace:img-redo': () => {
    if (!useHistoryStore.getState().canRedo()) return fail('nothing_to_redo', 'There is nothing to redo.');
    const description = useHistoryStore.getState().getRedoDescription();
    useProjectStore.getState().redo();
    return { ok: true, redone: description, rev: getProjectRev() };
  },
};

const HANDLERS: Record<string, (msg: any) => Record<string, unknown> | Promise<Record<string, unknown>>> = {
  ...READ_HANDLERS,
  ...CHECKPOINT_HANDLERS,
};

/** Exposed for the mutating tool groups added in later phases. */
export function registerImageRpc(
  type: string,
  handler: (msg: any) => Record<string, unknown> | Promise<Record<string, unknown>>,
) {
  if (HANDLERS[type]) {
    console.warn('[img-rpc] duplicate handler ignored:', type);
    return;
  }
  HANDLERS[type] = handler;
}

/** Register a MUTATING handler — gets the rev guard, the single-undo-step
 *  transaction and the coalescing barrier automatically. */
export function registerImageMutation<T extends Record<string, unknown>>(
  type: string,
  label: string,
  fn: (msg: any) => T,
) {
  registerImageRpc(type, mutation(label, fn));
}

/** True when this message is ours to answer. */
export function isImageRpc(type: string): boolean {
  return type.startsWith('voidspace:img-');
}

/**
 * Handle one message. Returns false when the message isn't an image RPC, so the
 * caller can ignore it silently.
 */
export async function handleImageRpc(msg: any, reply: Reply): Promise<boolean> {
  const type = String(msg?.type ?? '');
  if (!isImageRpc(type)) return false;

  const handler = HANDLERS[type];
  if (!handler) {
    reply({ type: 'voidspace:error', requestId: msg.requestId, error: `unknown image RPC: ${type}` });
    return true;
  }

  try {
    const result = await handler(msg);
    reply({ type: `${type}:result`, requestId: msg.requestId, ...result });
  } catch (err: any) {
    // Never leak a stack trace to the chat; the agent gets a sentence it can act
    // on and the real cause stays in the console.
    console.warn('[img-rpc] handler failed:', type, err);
    reply({
      type: 'voidspace:error',
      requestId: msg.requestId,
      error: err?.message ?? String(err),
    });
  }
  return true;
}

/**
 * Install the listener. Idempotent — React StrictMode double-invokes effects in
 * development, and two listeners would answer every request twice (the chat
 * resolves on the first and the second arrives as an unmatched reply).
 */
let installed = false;
export function installImageRpc(): () => void {
  if (installed) return () => {};
  installed = true;

  // Side-effect import: the vision RPCs register themselves on load. Imported
  // here rather than at module top so a consumer that only wants the digest
  // (tests) doesn't pull in the canvas/export stack.
  void import('./vision-rpc');
  void import('./mutation-rpc');
  void import('./output-rpc');

  const onMessage = async (e: MessageEvent) => {
    const msg = e?.data;
    if (!msg || typeof msg !== 'object') return;
    if (!isImageRpc(String(msg.type ?? ''))) return;
    await handleImageRpc(msg, (payload) => {
      try {
        (e.source as Window | null)?.postMessage(payload, '*');
      } catch {
        /* parent window gone */
      }
    });
  };

  window.addEventListener('message', onMessage);
  return () => {
    window.removeEventListener('message', onMessage);
    installed = false;
  };
}
