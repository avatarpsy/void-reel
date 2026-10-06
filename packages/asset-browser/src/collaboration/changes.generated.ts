/** Small, conditional document edits. Stable entity IDs keep a clip or layer's
 * address independent of its array position. Conflicts are explicit: a stale
 * edit must never silently replace another person's work.
 */
export type Segment = string | { id: string };
export interface Change { path: Segment[]; before?: unknown; after?: unknown; remove?: boolean; insert?: boolean; sequence?: boolean }
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const entities = (items: unknown[]): items is Array<Record<string, unknown> & { id: string }> =>
  items.every(item => object(item) && typeof item.id === 'string' && item.id.length > 0)
  && new Set(items.map(item => (item as { id: string }).id)).size === items.length;

export function validateJson(value: unknown, depth = 0): void {
  if (depth > 64) throw new Error('Document is nested too deeply.');
  if (Array.isArray(value)) { for (const item of value) validateJson(item, depth + 1); return; }
  if (object(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (unsafe.has(key)) throw new Error('Unsafe document property.');
      validateJson(item, depth + 1);
    }
    return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  throw new Error('Invalid document value.');
}

export function changesBetween(before: unknown, after: unknown, path: Segment[] = []): Change[] {
  if (same(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after) && [...before, ...after].every(item => typeof item === 'string')
    && new Set(before).size === before.length && new Set(after).size === after.length) {
    return [{ path, before, after, sequence: true }];
  }
  if (Array.isArray(before) && Array.isArray(after) && entities(before) && entities(after)) {
    const old = new Map(before.map(item => [item.id, item])); const next = new Map(after.map(item => [item.id, item]));
    // Reordering is one conditional change. A simultaneous structural change is
    // reported as a conflict; retrying never guesses which ordering was intended.
    const commonBefore = before.filter(item => next.has(item.id)).map(item => item.id);
    const commonAfter = after.filter(item => old.has(item.id)).map(item => item.id);
    if (!same(commonBefore, commonAfter)) return [{ path, before, after }];
    const result: Change[] = [];
    for (const item of before) if (!next.has(item.id)) result.push({ path: [...path, { id: item.id }], before: item, remove: true });
    for (let i = 0; i < after.length; i++) {
      const item = after[i];
      // Appends merge independently. Insertion between entities needs an exact
      // order precondition and remains a single atomic structural edit.
      if (!old.has(item.id) && after.slice(i + 1).some(other => old.has(other.id))) return [{ path, before, after }];
      if (!old.has(item.id)) result.push({ path: [...path, { id: item.id }], after: item, insert: true });
      else result.push(...changesBetween(old.get(item.id), item, [...path, { id: item.id }]));
    }
    return result;
  }
  if (object(before) && object(after)) {
    const result: Change[] = [];
    for (const key of Object.keys(before)) if (!own(after, key)) result.push({ path: [...path, key], before: before[key], remove: true });
    for (const [key, value] of Object.entries(after)) {
      if (!own(before, key)) result.push({ path: [...path, key], after: value, insert: true });
      else result.push(...changesBetween(before[key], value, [...path, key]));
    }
    return result;
  }
  return [{ path, before, after }];
}

export class EditConflict extends Error {
  constructor(public readonly path: Segment[]) { super('This part of the project was changed by someone else.'); }
}

export function applyChanges<T>(document: T, changes: Change[], conditional = true): T {
  if (!Array.isArray(changes) || changes.length > 10000) throw new Error('Too many changes.');
  let result: unknown = structuredClone(document);
  for (const change of changes) {
    if (!Array.isArray(change.path) || change.path.length > 64 || change.insert && change.remove) throw new Error('Invalid change.');
    for (const segment of change.path) {
      if (typeof segment === 'string') { if (unsafe.has(segment)) throw new Error('Unsafe document property.'); }
      else if (!object(segment) || typeof segment.id !== 'string' || !segment.id || Object.keys(segment).length !== 1) throw new Error('Invalid entity address.');
    }
    if (!change.remove) validateJson(change.after);
    if (!change.insert) validateJson(change.before);
    if (!change.path.length) {
      if (change.remove || change.insert) throw new Error('Cannot remove or insert a document root.');
      if (conditional && !same(result, change.before)) throw new EditConflict([]);
      result = structuredClone(change.after); continue;
    }
    let parent: any = result;
    for (const segment of change.path.slice(0, -1)) {
      if (typeof segment === 'string') parent = object(parent) && own(parent, segment) ? parent[segment] : undefined;
      else parent = Array.isArray(parent) ? parent.find(item => item?.id === segment.id) : undefined;
      if (parent === undefined) throw new EditConflict(change.path);
    }
    const last = change.path[change.path.length - 1];
    let key: string | number; let exists: boolean;
    if (typeof last === 'string') {
      if (!object(parent)) throw new EditConflict(change.path);
      key = last; exists = own(parent, last);
    } else {
      if (!Array.isArray(parent)) throw new EditConflict(change.path);
      key = parent.findIndex((item: any) => item?.id === last.id); exists = key >= 0;
      if (change.insert && (!object(change.after) || change.after.id !== last.id)) throw new Error('Entity ID mismatch.');
    }
    if (change.sequence) {
      if (!Array.isArray((parent as any)[key]) || !Array.isArray(change.before) || !Array.isArray(change.after)
        || ![...(parent as any)[key], ...change.before, ...change.after].every(value => typeof value === 'string')) throw new Error('Invalid sequence change.');
      const old = change.before as string[]; const next = change.after as string[]; const current = (parent as any)[key] as string[];
      if (new Set(old).size !== old.length || new Set(next).size !== next.length) throw new Error('Duplicate sequence entries.');
      const oldCommon = old.filter(value => next.includes(value)); const nextCommon = next.filter(value => old.includes(value));
      if (!same(oldCommon, nextCommon)) {
        if (conditional && !same(current.filter(value => old.includes(value)), old)) throw new EditConflict(change.path);
        const extra = current.filter(value => !old.includes(value) && !next.includes(value));
        (parent as any)[key] = [...next, ...extra];
      } else {
        const merged = current.filter(value => !old.includes(value) || next.includes(value));
        for (let i = 0; i < next.length; i++) {
          const value = next[i]; if (old.includes(value) || merged.includes(value)) continue;
          const following = next.slice(i + 1).find(candidate => merged.includes(candidate));
          merged.splice(following === undefined ? merged.length : merged.indexOf(following), 0, value);
        }
        (parent as any)[key] = merged;
      }
      continue;
    }
    if (conditional && (change.insert ? exists : !exists || !same((parent as any)[key], change.before))) throw new EditConflict(change.path);
    if (change.remove) { if (Array.isArray(parent)) parent.splice(key as number, 1); else delete (parent as any)[key]; }
    else if (change.insert && Array.isArray(parent)) parent.push(structuredClone(change.after));
    else (parent as any)[key] = structuredClone(change.after);
  }
  return result as T;
}

export function invertChanges(changes: Change[]): Change[] {
  return [...changes].reverse().map(change => ({ path: change.path,
    ...(change.sequence ? { sequence: true } : {}),
    ...(change.insert ? { before: change.after, remove: true } : change.remove ? { after: change.before, insert: true } : { before: change.after, after: change.before }) }));
}
