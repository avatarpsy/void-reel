/**
 * Deterministic, collision-free id generation for the action executor.
 *
 * FOUNDATION FIX (F1, F6): add handlers used to mint ids as
 * `${prefix}-${Date.now()}`. Two adds in the same millisecond collided on id
 * (duplicate clip/effect/subtitle ids corrupt the render bridge's Map<id> and
 * turn the preview black), and `Date.now()`/`Math.random()` made the whole
 * action stream non-reproducible (no determinism test possible).
 *
 * The generator is INJECTED into the executor so tests can supply a seeded,
 * fully deterministic sequence, while the runtime default stays globally unique
 * across sessions (a per-instance base) AND collision-free within a session (a
 * monotonic counter — never Date.now).
 */
export type IdGenerator = (prefix: string) => string;

/**
 * Runtime default: `${prefix}-${base36counter}` under a per-instance base so
 * ids can't collide with ids already present in a reloaded project, and the
 * counter guarantees no same-millisecond collision.
 *
 * @param base Optional fixed base — pass a constant for a fully deterministic
 *   sequence (tests); omit for a session-unique random base (runtime).
 */
export function createIdGenerator(base?: string): IdGenerator {
  const b =
    base ??
    // Per-instance entropy so a fresh session's counter (which restarts at 0)
    // cannot reproduce ids from a previously-saved project. Not on the
    // determinism-sensitive path — tests pass an explicit base instead.
    Math.random().toString(36).slice(2, 9);
  let n = 0;
  return (prefix: string) => `${prefix}-${b}-${(n++).toString(36)}`;
}

/** Fully deterministic generator for tests: `${prefix}-${seed}-${n}`. */
export function createSeededIdGenerator(seed = "seed"): IdGenerator {
  return createIdGenerator(seed);
}
