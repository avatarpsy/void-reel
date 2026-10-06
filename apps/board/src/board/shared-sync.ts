import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { sharedRequest, sharedNotice, SharedError, type SharedMetadata } from '@openreel/asset-browser';
import type { CloudSync } from './cloud-sync';

const REMOTE = 'collaboration-remote';
const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));
const encode = (value: Uint8Array) => { let string = ''; for (let i = 0; i < value.length; i += 8192) string += String.fromCharCode(...value.subarray(i, i + 8192)); return btoa(string); };
export function installSharedSync(projectId: string, doc: Y.Doc): CloudSync & { metadata: SharedMetadata | null } {
  let stopped = false; let pulled = false; let revision = 0; let epoch = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  let persistence: IndexeddbPersistence | undefined; let busy: Promise<void> | null = null;
  let pending: any = null; let dirty = false; let retryDelay = 1000;
  const session = sessionStorage.getItem('collaboration-session') || crypto.randomUUID(); sessionStorage.setItem('collaboration-session', session);
  let key = `collaboration-board-pending:${projectId}:${session}`;
  const known = new Y.Doc();
  function editable() { return !stopped && api.metadata?.role !== 'viewer'; }
  function fail(error: unknown) {
    retryDelay = Math.min(30000, retryDelay * 2);
    if (error instanceof SharedError && [400, 401, 403, 404, 409, 413].includes(error.status)) stopped = true;
    sharedNotice(stopped ? 'conflict' : 'offline', error instanceof Error ? error.message : 'Connection lost. Changes remain on this device.');
    if (stopped) window.dispatchEvent(new CustomEvent('collaboration-role', { detail: 'viewer' }));
  }
  async function sync() {
    if (!pulled || stopped) return;
    if (editable() && dirty && !pending) {
      const update = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(known));
      if (update.length > 2) {
        pending = { requestId: crypto.randomUUID(), session, epoch, update: encode(update), label: 'Edited board' };
        sessionStorage.setItem(key, JSON.stringify(pending));
      }
      dirty = false;
    }
    if (pending) {
      sharedNotice('saving', 'Saving changes…');
      await sharedRequest(projectId, '/changes', pending);
      Y.applyUpdate(known, decode(pending.update)); pending = null; sessionStorage.removeItem(key);
    }
    const remote = await sharedRequest(projectId, `/changes?after=${revision}`);
    if (remote.epoch !== epoch) { if (!dirty && !pending) { stopped = true; location.reload(); return; } throw new SharedError('An earlier version was restored. Download your local copy before reopening.', 409); }
    if (remote.userId !== undefined && remote.userId !== api.metadata!.userId) throw new SharedError('The signed-in account changed. Reopen this project to continue.', 409);
    if (remote.role === 'viewer' && api.metadata!.role !== 'viewer' && !dirty && !pending) { stopped = true; location.reload(); return; }
    api.metadata!.role = remote.role;
    window.dispatchEvent(new CustomEvent('collaboration-role', { detail: remote.role }));
    if (remote.revision !== revision) {
      if (remote.reset || remote.role === 'viewer') {
        const head = await sharedRequest(projectId, '/document');
        if (head.epoch !== epoch) throw new SharedError('An earlier version was restored. Reopen the project.', 409);
        const update = decode(head.document); Y.applyUpdate(doc, update, REMOTE); Y.applyUpdate(known, update); revision = head.revision;
      } else {
        for (const change of remote.changes) {
          if (!change.update) throw new SharedError('An earlier version was restored. Reopen the project.', 409);
          const update = decode(change.update); Y.applyUpdate(doc, update, REMOTE); Y.applyUpdate(known, update);
        }
        revision = remote.revision;
      }
    }
    retryDelay = 1000;
    if (!dirty && !pending) sessionStorage.removeItem(`${key}:dirty`);
    sharedNotice(dirty ? 'saving' : api.metadata!.role === 'viewer' ? 'viewing' : 'saved', dirty ? 'Saving changes…' : api.metadata!.role === 'viewer' ? 'View only' : 'All changes saved');
  }
  function schedule() { if (!stopped) timer = setTimeout(() => { void api.flush().finally(schedule); }, Math.max(retryDelay, document.hidden || api.metadata?.role === 'viewer' ? 5000 : 1000)); }
  function update(_bytes: Uint8Array, origin: unknown) { if (pulled && editable() && origin !== REMOTE && origin !== persistence) { dirty = true; sessionStorage.setItem(`${key}:dirty`, '1'); sharedNotice('saving', 'Saving changes…'); } }
  async function download(event: MessageEvent) {
    if (event.origin !== location.origin || event.source !== window.parent) return;
    if (event.data?.type === 'voidspace:collaboration-discard') {
      stopped = true; clearTimeout(timer); await busy;
      sessionStorage.removeItem(key); sessionStorage.removeItem(`${key}:dirty`); sessionStorage.removeItem(`${key}:epoch`);
      await persistence?.clearData();
      window.parent.postMessage({ type: 'voidspace:collaboration-discarded', requestId: event.data.requestId }, location.origin);
      return;
    }
    if (event.data?.type === 'voidspace:collaboration-flush') {
      await api.flush();
      window.parent.postMessage({ type: 'voidspace:collaboration-flushed', requestId: event.data.requestId, saved: pulled && !stopped && !dirty && !pending, revision, epoch }, location.origin);
      return;
    }
    if (event.data?.type !== 'voidspace:collaboration-download') return;
    const url = URL.createObjectURL(new Blob([Y.encodeStateAsUpdate(doc) as BlobPart], { type: 'application/octet-stream' }));
    const link = document.createElement('a'); link.href = url; link.download = 'board-local-copy.ydoc'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function beforeUnload(event: BeforeUnloadEvent) { if (dirty || pending) { event.preventDefault(); event.returnValue = ''; } }
  const api: CloudSync & { metadata: SharedMetadata | null } = {
    metadata: null,
    async pull() {
      try {
        api.metadata = await sharedRequest(projectId);
        key = `collaboration-board-pending:${projectId}:${api.metadata!.userId || 'anonymous'}:${session}`;
        const version = new URLSearchParams(location.search).get('version');
        const head = await sharedRequest(projectId, `/document${version === null ? '' : `?revision=${encodeURIComponent(version)}`}`);
        revision = head.revision; epoch = head.epoch;
        const priorEpoch = sessionStorage.getItem(`${key}:epoch`);
        if (version === null && api.metadata!.role !== 'viewer' && priorEpoch !== null && Number(priorEpoch) !== epoch && (sessionStorage.getItem(`${key}:dirty`) || sessionStorage.getItem(key))) {
          persistence = new IndexeddbPersistence(`voidspace-shared-board:${projectId}:${api.metadata!.userId}:${priorEpoch}:${session}`, doc);
          await persistence.whenSynced;
          window.addEventListener('message', download);
          window.addEventListener('beforeunload', beforeUnload);
          dirty = true; pulled = true;
          fail(new SharedError('A version was restored while this tab had unsaved work. Download your local copy before reopening.', 409));
          return 'merged';
        }
        if (version === null) sessionStorage.setItem(`${key}:epoch`, String(epoch));
        const update = decode(head.document); Y.applyUpdate(known, update); Y.applyUpdate(doc, update, REMOTE);
        if (version !== null) api.metadata!.role = 'viewer';
        if (api.metadata!.role !== 'viewer') {
          persistence = new IndexeddbPersistence(`voidspace-shared-board:${projectId}:${api.metadata!.userId}:${epoch}:${session}`, doc);
          await persistence.whenSynced;
          const raw = sessionStorage.getItem(key); if (raw) { const saved = JSON.parse(raw); if (saved.epoch === epoch) pending = saved; else sessionStorage.removeItem(key); }
          dirty = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(known)).length > 2;
        }
        pulled = true; doc.on('update', updateListener);
        window.addEventListener('message', download); window.addEventListener('beforeunload', beforeUnload);
        if (version === null) schedule();
        return 'merged';
      } catch(error) { fail(error); return 'failed'; }
    },
    async flush() { if (busy) return busy; busy = sync().catch(fail).finally(() => { busy = null; }); return busy; },
    stop() { stopped = true; clearTimeout(timer); doc.off('update', updateListener); void persistence?.destroy(); known.destroy(); window.removeEventListener('message', download); window.removeEventListener('beforeunload', beforeUnload); },
  };
  const updateListener = update;
  return api;
}
