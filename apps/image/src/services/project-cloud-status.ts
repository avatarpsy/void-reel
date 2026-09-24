export type CloudSaveStatus = { state: 'saving' | 'saved' | 'error'; message: string; updatedAt: number };
const states = new Map<string, CloudSaveStatus>();
const listeners = new Set<() => void>();
export function cloudSaveStatus(id: string): CloudSaveStatus | null { return states.get(id) || null; }
export function subscribeCloudSave(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function setCloudSaveStatus(id: string, status: CloudSaveStatus): void {
  const previous = states.get(id);
  if (previous && previous.updatedAt > status.updatedAt) return;
  states.set(id, status);
  listeners.forEach(listener => listener());
}
