/**
 * Lightweight bridge that lets the TimeRuler read the RAM cache state
 * from the Preview component without prop drilling or store overhead.
 */

type Listener = () => void;

let cachedFrames: number[] = [];
let totalFrames = 0;
const listeners = new Set<Listener>();

export function setRamCacheState(frames: number[], total: number) {
  cachedFrames = frames;
  totalFrames = total;
  for (const fn of listeners) fn();
}

export function getRamCacheState() {
  return { cachedFrames, totalFrames };
}

export function subscribeRamCache(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
