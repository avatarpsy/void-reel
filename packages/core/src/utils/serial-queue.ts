/**
 * Single-flight serial queue (FOUNDATION FIX F5).
 *
 * Every enqueued task runs only after all previously-enqueued tasks have
 * settled, so concurrent callers can't interleave. The editor store uses this to
 * serialize its edit critical section — `structuredClone(project) → execute →
 * set({project})`. Without it, two concurrent edits (the agent issues tool calls
 * in parallel) each clone the SAME base project and the second `set` silently
 * overwrites the first → a lost update. Serializing means edit B clones AFTER
 * edit A has committed, so it sees A's change.
 *
 * A task that rejects does NOT wedge the queue: the chain continues to the next
 * task, and the rejection propagates only to that task's own caller.
 */
export type EnqueueFn = <T>(task: () => Promise<T> | T) => Promise<T>;

export function createSerialQueue(): EnqueueFn {
  let tail: Promise<unknown> = Promise.resolve();

  return function enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    // Run after the current tail settles (success OR failure), so one failing
    // task can't break the chain for the next.
    const run = tail.then(
      () => task(),
      () => task(),
    );
    // Advance the tail but swallow the result so a rejection here doesn't become
    // an unhandled rejection or poison the chain; the real result still reaches
    // the caller via `run`.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
