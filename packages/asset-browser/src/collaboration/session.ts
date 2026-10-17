import { applyChanges, changesBetween, type Change } from './changes.generated';

export const sharedProjectId = () => new URLSearchParams(location.search).get('shared');
export function installSharePreparation(prepare: () => Promise<{ kind: string; sourceId: string }>) {
  const listener = async (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== location.origin || event.data?.type !== 'voidspace:prepare-sharing') return;
    try { const result = await prepare(); window.parent.postMessage({ type: 'voidspace:prepare-sharing:done', requestId: event.data.requestId, ...result }, location.origin); }
    catch(error) { window.parent.postMessage({ type: 'voidspace:prepare-sharing:done', requestId: event.data.requestId, error: error instanceof Error ? error.message : 'Save this project before sharing.' }, location.origin); }
  };
  window.addEventListener('message', listener); return () => window.removeEventListener('message', listener);
}
export function installSharedTheme(onChange?: (mode: 'light' | 'dark') => void) {
  const apply = (mode: 'light' | 'dark') => { onChange?.(mode); document.documentElement.dataset.theme = mode; document.documentElement.classList.toggle('dark', mode !== 'light'); window.dispatchEvent(new Event('resize')); };
  apply(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark');
  const listener = (event: MessageEvent) => { if (event.source === window.parent && event.origin === location.origin && event.data?.type === 'voidspace:theme') apply(event.data.mode === 'light' ? 'light' : 'dark'); };
  window.addEventListener('message', listener); return () => window.removeEventListener('message', listener);
}
export async function uploadSharedMedia(projectId: string, blob: Blob): Promise<string> {
  const token = await parentToken(); if (!token) throw new SharedError('Sign in to add media.', 401);
  const response = await fetch(`/api/collaboration/${encodeURIComponent(projectId)}/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': blob.type || 'application/octet-stream' }, body: blob, signal: AbortSignal.timeout(120000) });
  const result = await response.json(); if (!response.ok) throw new SharedError(result.statusMessage || 'Could not upload this media.', response.status);
  return result.url;
}
export type SharedRole = 'owner' | 'editor' | 'viewer';
export interface SharedMetadata { userId?: string | null; id: string; kind: 'image' | 'video' | 'board'; title: string; role: SharedRole; revision: number; epoch: number; /** The owner's own id for the source (owner only). */ sourceId?: string }
export function sharedNotice(state: string, message: string) {
  document.querySelectorAll<HTMLElement>('[data-collaboration-status]').forEach(el => { el.textContent = message; el.title = message; });
  window.parent.postMessage({ type: 'voidspace:collaboration-status', state, message }, location.origin);
  window.dispatchEvent(new CustomEvent('collaboration-status', { detail: { state, message } }));
}
export function parentToken(): Promise<string | null> {
  if (window.parent === window) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const listener = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'voidspace:collaboration-token' || event.data.requestId !== requestId) return;
      clearTimeout(timer); window.removeEventListener('message', listener); resolve(event.data.token || null);
    };
    const timer = setTimeout(() => { window.removeEventListener('message', listener); reject(new Error('The project page did not answer. Reload to reconnect.')); }, 10000);
    window.addEventListener('message', listener);
    window.parent.postMessage({ type: 'voidspace:collaboration-get-token', requestId }, location.origin);
  });
}
export class SharedError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function sharedRequest<T = any>(projectId: string, suffix = '', body?: unknown): Promise<T> {
  const token = await parentToken();
  const response = await fetch(`/api/collaboration/${encodeURIComponent(projectId)}${suffix}`, {
    method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.timeout(30000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new SharedError(result.statusMessage || result.message || 'Could not sync this project.', response.status);
  return result as T;
}
export interface JsonAdapter<T> {
  read(): T;
  apply(value: T, initial: boolean): void | Promise<void>;
  subscribe(listener: () => void): () => void;
  label(): string;
  boundary?(): void;
  historyChanged?(): void;
  normalize?(value: T): T;
  prepare?(): Promise<void>;
}
interface Saved<T> { base: T; local: T; revision: number; epoch: number; pending: any; pendingUndo?: { request: any; redo: boolean }; undo: number[]; redo: number[] }
// Recovery is scoped to this tab. IndexedDB supports large projects without
// putting media into the small synchronous localStorage quota.
async function recovery<T>(key: string, value?: Saved<T> | null): Promise<Saved<T> | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('voidspace-shared-recovery', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction('drafts', value === undefined ? 'readonly' : 'readwrite');
      const store = tx.objectStore('drafts'); const op = value === undefined ? store.get(key) : value === null ? store.delete(key) : store.put(value, key);
      tx.oncomplete = () => { db.close(); resolve(value === undefined ? op.result : undefined); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

/** One save queue, one remote cursor, and the editor's existing command labels.
 * The server checks each property's previous value and attributes every edit.
 * Native board Yjs synchronization lives in the board adapter instead.
 */
export class JsonSession<T> {
  metadata!: SharedMetadata;
  private base!: T;
  private revision = 0;
  private epoch = 0;
  private pending: any = null;
  private pendingUndo: Saved<T>['pendingUndo'];
  private persistQueue: Promise<void> = Promise.resolve();
  private undoStack: number[] = [];
  private redoStack: number[] = [];
  private dirty = false;
  private retryDelay = 1000;
  private applying = false;
  private halted = false;
  private closed = false;
  private busy: Promise<void> | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private activePointers = new Set<number>();
  private pointerDown = (event: PointerEvent) => { this.activePointers.add(event.pointerId); };
  private pointerUp = (event: PointerEvent) => { this.activePointers.delete(event.pointerId); };
  private pointerReset = () => { this.activePointers.clear(); };
  private session = sessionStorage.getItem('collaboration-session') || crypto.randomUUID();
  private key: string;
  constructor(readonly projectId: string, private adapter: JsonAdapter<T>) {
    sessionStorage.setItem('collaboration-session', this.session);
    this.key = `${projectId}:${this.session}`;
  }
  get editable() { return !!this.metadata && this.metadata.role !== 'viewer' && !this.halted; }
  get canUndo() { return this.editable && (this.undoStack.length > 0 || this.dirty); }
  get canRedo() { return this.editable && this.redoStack.length > 0; }
  async start() {
    this.metadata = await sharedRequest(this.projectId);
    if (this.closed) return this.metadata;
    this.key = `${this.projectId}:${this.metadata.userId || 'anonymous'}:${this.session}`;
    const version = new URLSearchParams(location.search).get('version');
    const head = await sharedRequest(this.projectId, `/document${version === null ? '' : `?revision=${encodeURIComponent(version)}`}`);
    head.document = this.adapter.normalize?.(head.document) ?? head.document;
    if (this.closed) return this.metadata;
    this.base = head.document; this.revision = head.revision; this.epoch = head.epoch;
    window.addEventListener('message', this.onMessage);
    if (version !== null) { this.metadata.role = 'viewer'; await this.apply(head.document, true); return this.metadata; }
    let saved = this.editable ? await recovery<T>(this.key) : undefined;
    if (this.closed) return this.metadata;
    if (saved && saved.epoch !== this.epoch && !saved.pending && !saved.pendingUndo && !changesBetween(saved.base, saved.local).length) {
      await recovery<T>(this.key, null); saved = undefined;
    }
    if (saved && saved.epoch === this.epoch) {
      this.base = saved.base; this.revision = saved.revision; this.pending = saved.pending;
      this.pendingUndo = saved.pendingUndo; this.dirty = true;
      this.undoStack = saved.undo; this.redoStack = saved.redo;
      await this.apply(saved.local, true);
    } else {
      if (saved) { this.halted = true; this.metadata.role = 'viewer'; sharedNotice('conflict', 'A version was restored while this tab had unsaved work. Download your local copy before reopening.'); await this.apply(saved.local, true); return this.metadata; }
      await this.apply(head.document, true);
      // Normalize fields supplied by the editor on load without publishing them.
      this.base = this.adapter.read();
    }
    if (this.closed) return this.metadata;
    this.unsubscribe = this.adapter.subscribe(() => {
      if (this.applying || !this.editable) return;
      this.dirty = true;
      sharedNotice('saving', 'Saving changes…');
      if (!this.persistTimer) this.persistTimer = setTimeout(() => {
        this.persistTimer = undefined; void this.persist().catch(error => this.fail(error));
      }, 300);
    });
    window.addEventListener('beforeunload', this.beforeUnload);
    window.addEventListener('pointerdown', this.pointerDown, true);
    window.addEventListener('pointerup', this.pointerUp, true);
    window.addEventListener('pointercancel', this.pointerUp, true);
    window.addEventListener('blur', this.pointerReset);
    this.schedule(0);
    return this.metadata;
  }
  private beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.pending || this.pendingUndo || this.halted || changesBetween(this.base, this.adapter.read()).length) { event.preventDefault(); event.returnValue = ''; }
  };
  private onMessage = async (event: MessageEvent) => {
    if (event.origin !== location.origin || event.source !== window.parent) return;
    if (event.data?.type === 'voidspace:collaboration-discard') {
      this.stop();
      await this.busy; await this.persistQueue.catch(() => {}); await recovery(this.key, null);
      window.parent.postMessage({ type: 'voidspace:collaboration-discarded', requestId: event.data.requestId }, location.origin);
      return;
    }
    if (event.data?.type === 'voidspace:collaboration-flush') {
      await this.flush();
      const saved = !this.halted && !this.pending && !this.pendingUndo && !changesBetween(this.base, this.adapter.read()).length;
      window.parent.postMessage({ type: 'voidspace:collaboration-flushed', requestId: event.data.requestId, saved, revision: this.revision, epoch: this.epoch }, location.origin);
      return;
    }
    if (event.data?.type !== 'voidspace:collaboration-download') return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.adapter.read())], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${this.metadata.title || 'project'}-local-copy.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  private async apply(value: T, initial = false) {
    if (this.closed) return;
    this.applying = true;
    try { await this.adapter.apply(value, initial); }
    finally { this.applying = false; }
  }
  private persist() {
    if (!this.editable) return Promise.resolve();
    const value = structuredClone({ base: this.base, local: this.adapter.read(), revision: this.revision, epoch: this.epoch,
      pending: this.pending, pendingUndo: this.pendingUndo, undo: this.undoStack, redo: this.redoStack });
    this.persistQueue = this.persistQueue.catch(() => {}).then(() => recovery<T>(this.key, value)).then(() => {});
    return this.persistQueue;
  }
  private schedule(delay = 1000) {
    if (!this.closed && !this.halted) this.timer = setTimeout(() => { void this.flush().finally(() => this.schedule(Math.max(this.retryDelay, document.hidden || !this.editable ? 5000 : 1000))); }, delay);
  }
  private fail(error: unknown) {
    if (this.closed) return;
    this.retryDelay = Math.min(30000, this.retryDelay * 2);
    if (error instanceof SharedError && [400, 401, 403, 404, 409, 413].includes(error.status)) this.halted = true;
    sharedNotice(this.halted ? 'conflict' : 'offline', error instanceof Error ? error.message : 'Connection lost. Changes remain on this device.');
    if (this.halted) window.dispatchEvent(new CustomEvent('collaboration-role', { detail: 'viewer' }));
  }
  async flush() {
    if (this.busy) return this.busy;
    if (this.closed || this.halted) return;
    this.busy = this.sync().catch(error => this.fail(error)).finally(() => { this.busy = null; });
    return this.busy;
  }
  private async sync() {
    // Native drags/slider gestures update the store on every move. Publishing
    // halfway through splits one gesture into several collaborative undo steps.
    // Keep the existing local draft persistence, and commit after pointer-up.
    if (this.editable && this.activePointers.size) return;
    let changed = false;
    if (this.pendingUndo) await this.finishUndo();
    if (this.closed) return;
    if (this.editable && !this.pending && this.dirty) {
      await this.adapter.prepare?.();
      if (this.closed || this.activePointers.size) return;
      const changes = changesBetween(this.base, this.adapter.read());
      this.dirty = changes.length > 0;
      if (changes.length) {
        this.adapter.boundary?.();
        this.pending = { requestId: crypto.randomUUID(), session: this.session, epoch: this.epoch, label: this.adapter.label(), changes };
        await this.persist();
      }
    }
    if (this.pending) {
      sharedNotice('saving', 'Saving changes…');
      const acknowledged = await sharedRequest(this.projectId, '/changes', this.pending);
      if (this.closed) return;
      this.base = applyChanges(this.base, this.pending.changes as Change[]);
      changed = true;
      this.undoStack.push(acknowledged.revision); this.redoStack = []; this.pending = null; this.adapter.historyChanged?.();
      await this.persist();
    }
    const remote = await sharedRequest(this.projectId, `/changes?after=${this.revision}`);
    if (this.closed) return;
    if (remote.userId !== undefined && remote.userId !== this.metadata.userId) throw new SharedError('The signed-in account changed. Reopen the project to continue with that account.', 409);
    this.metadata.role = remote.role;
    window.dispatchEvent(new CustomEvent('collaboration-role', { detail: remote.role }));
    if (remote.epoch !== this.epoch) {
      if (this.pending || this.pendingUndo || changesBetween(this.base, this.adapter.read()).length) throw new SharedError('An earlier version was restored. Your local copy is available to download before reopening.', 409);
      const restored = await sharedRequest(this.projectId, '/document');
      if (this.closed) return;
      restored.document = this.adapter.normalize?.(restored.document) ?? restored.document;
      await this.apply(restored.document); this.base = restored.document; this.epoch = restored.epoch; this.revision = restored.revision;
      this.undoStack = []; this.redoStack = []; this.adapter.historyChanged?.();
      await this.persist(); sharedNotice('saved', 'Restored version opened'); return;
    }
    if (remote.revision !== this.revision) {
      changed = true;
      // Fetch one authoritative snapshot after a batch, then retain any local
      // edits made while the save was in flight. Preconditions guard rebasing.
      const local = changesBetween(this.base, this.adapter.read());
      const head = await sharedRequest(this.projectId, '/document');
      if (this.closed) return;
      head.document = this.adapter.normalize?.(head.document) ?? head.document;
      if (head.epoch !== this.epoch) throw new SharedError('An earlier version was restored. Reload to continue.', 409);
      let merged: T;
      try { merged = applyChanges(head.document, local); }
      catch { throw new SharedError('Another editor changed the same part. Download your local copy, then reopen the latest version.', 409); }
      await this.apply(merged);
      this.base = head.document; this.revision = head.revision;
    }
    if (changed || this.dirty) { this.dirty = changesBetween(this.base, this.adapter.read()).length > 0; await this.persist(); }
    this.retryDelay = 1000;
    sharedNotice(this.dirty ? 'saving' : this.metadata.role === 'viewer' ? 'viewing' : 'saved', this.dirty ? 'Saving changes…' : this.metadata.role === 'viewer' ? 'View only' : 'All changes saved');
  }
  async undo(redo = false) {
    await this.flush();
    if (!this.editable || this.busy || this.pending || this.pendingUndo) return;
    const stack = redo ? this.redoStack : this.undoStack; const original = stack.at(-1); if (original === undefined) return;
    this.busy = (async () => {
      const local = changesBetween(this.base, this.adapter.read());
      if (local.length) throw new Error('Wait for your changes to finish saving, then try again.');
      this.pendingUndo = { request: { requestId: crypto.randomUUID(), session: this.session, epoch: this.epoch, undoOf: original }, redo };
      await this.persist();
      await this.finishUndo();
    })().catch(error => this.fail(error)).finally(() => { this.busy = null; });
    return this.busy;
  }
  private async finishUndo() {
      const pending = this.pendingUndo!;
      const result = await sharedRequest(this.projectId, '/changes', pending.request);
      const head = await sharedRequest(this.projectId, '/document');
      if (this.closed) return;
      if (head.epoch !== this.epoch) throw new SharedError('An earlier version was restored. Download your local copy before reopening.', 409);
      head.document = this.adapter.normalize?.(head.document) ?? head.document;
      // Preserve edits made while the undo request was in flight.
      const duringUndo = changesBetween(this.base, this.adapter.read());
      let merged: T;
      try { merged = applyChanges(head.document, duringUndo); }
      catch { throw new SharedError('A new local edit conflicts with undo. Download your local copy before reopening.', 409); }
      await this.apply(merged); this.base = head.document; this.revision = head.revision;
      (pending.redo ? this.redoStack : this.undoStack).pop();
      (pending.redo ? this.undoStack : this.redoStack).push(result.revision);
      this.pendingUndo = undefined; this.dirty = duringUndo.length > 0; this.adapter.historyChanged?.();
      await this.persist(); sharedNotice('saved', pending.redo ? 'Redone' : 'Undone');
      window.dispatchEvent(new Event('collaboration-history'));
  }
  stop() { this.closed = true; clearTimeout(this.timer); clearTimeout(this.persistTimer); this.unsubscribe?.(); window.removeEventListener('beforeunload', this.beforeUnload); window.removeEventListener('message', this.onMessage); window.removeEventListener('pointerdown', this.pointerDown, true); window.removeEventListener('pointerup', this.pointerUp, true); window.removeEventListener('pointercancel', this.pointerUp, true); window.removeEventListener('blur', this.pointerReset); this.activePointers.clear(); }
}
