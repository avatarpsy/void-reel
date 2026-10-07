import type { IndexedDBBlobSource } from '@blocksuite/sync';
import * as Y from 'yjs';
import { uploadBlob } from './document-export';
import { sharedProjectId, uploadSharedMedia } from '@openreel/asset-browser';

/**
 * `upload` is the person's answer to the one question the board asks when they
 * drop or paste media: 'cloud' = upload it to their Voidspace, 'local' = keep it
 * in this browser only. Absent = not asked yet (boards from before 7 Oct 2026).
 * It travels with the board, so the question is never asked twice for a file.
 */
export interface NativeMediaRecord { name: string; mime: string; bytes: number; cloudUrl?: string; upload?: 'cloud' | 'local' }
export interface MediaSaveState { state: 'checking' | 'browser' | 'folder' | 'uploading' | 'cloud' | 'missing' | 'unsaved'; message: string }
type Directory = FileSystemDirectoryHandle & {
  queryPermission(opts: { mode: string }): Promise<string>;
  requestPermission(opts: { mode: string }): Promise<string>;
};

// Handles are local capabilities, never serialized into the cloud document.
async function folderSetting(value?: Directory): Promise<Directory | undefined> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('voidspace-board-folders', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('settings');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('settings', value ? 'readwrite' : 'readonly');
      const op = value ? tx.objectStore('settings').put(value, 'root') : tx.objectStore('settings').get('root');
      tx.oncomplete = () => { db.close(); resolve(value || op.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

/** What an agent or generator is told about a picture the person kept in this browser. */
export const BROWSER_ONLY_MESSAGE = 'This picture is kept in this browser only (the person chose not to upload it), '
  + 'so server tools cannot read it. Ask them to upload it: Files on the board, then "Upload to Voidspace".';

async function fileKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Native pasted/dropped files: commit original bytes locally before returning
 * their key, then mirror durably. The source key never becomes an expiring URL. */
/**
 * Dispatched when a new original lands that nobody has decided about yet; the
 * board UI asks "upload or keep in this browser?" for it. `detail` is the key.
 */
export const NEEDS_UPLOAD_CHOICE = 'needs-upload-choice';

export class NativeMediaStore extends EventTarget {
  readonly records: Y.Map<NativeMediaRecord>;
  readonly states = new Map<string, MediaSaveState>();
  private readonly mirrors = new Map<string, Promise<string | undefined>>();
  private readonly checked = new Set<string>();
  private folder: Directory | undefined;
  private folderLoaded: Promise<void>;
  private snapshotQueue = Promise.resolve();
  private backupTimer?: ReturnType<typeof setTimeout>;
  private queue = Promise.resolve();
  private retained = new Map<string, Blob>();
  private previews = new Map<string, string>();
  private previewing = new Set<string>();
  private providerCopies = new Map<string, { url: string; until: number }>();
  /** Why the last cloud backup of a key failed, in words fit for a person. */
  private mirrorErrors = new Map<string, string>();

  async previewUrl(key: string): Promise<string> {
    if (this.previews.has(key)) return this.previews.get(key)!;
    const blob = await this.get(key);
    if (!blob) throw new Error(this.status(key).message);
    const url = URL.createObjectURL(blob); this.previews.set(key, url); return url;
  }

  preview(key: string, ready: () => void): string {
    if (!this.previews.has(key) && !this.previewing.has(key)) {
      this.previewing.add(key);
      void this.get(key).then(blob => {
        if (blob) this.previews.set(key, URL.createObjectURL(blob));
        ready();
      }).catch(() => ready());
    }
    return this.previews.get(key) || '';
  }

  /** Only invoked for an explicitly requested generation/export. A temporary
   * provider copy is never persisted as the board's original or cloud backup. */
  async providerReference(key: string): Promise<string> {
    if (this.cloudUrl(key)) return this.cloudUrl(key)!;
    const cached = this.providerCopies.get(key);
    if (cached && cached.until > Date.now()) return cached.url;
    const blob = await this.get(key);
    if (!blob) throw new Error(this.status(key).message);
    const url = await uploadBlob(blob, this.records.get(key)?.name || 'board-reference', 'provider');
    this.providerCopies.set(key, { url, until: Date.now() + 30 * 60_000 });
    return url;
  }

  /**
   * The DURABLE cloud url for a key — the board's own backup, made once.
   *
   * For a caller that hands the url to the server (a generation reference).
   * Reuses the backup when it exists; otherwise runs the same `mirror` the drop
   * already started, so a key is uploaded at most once however many times it is
   * asked for (the url lands in `records`, which travels with the board).
   * Throws with the reason — storage full, signed out, original missing —
   * because "not media" is the wrong answer for a picture that is right there.
   */
  async durableUrl(key: string): Promise<string> {
    const saved = this.cloudUrl(key);
    if (saved) return saved;
    // The person said "keep it in this browser". An agent must not override
    // that by uploading behind their back; it says so, and they can change it.
    if (this.records.get(key)?.upload === 'local') throw new Error(BROWSER_ONLY_MESSAGE);
    const url = await this.mirror(key);
    if (url) return url;
    throw new Error(this.mirrorErrors.get(key) || this.status(key).message || 'Cloud backup failed.');
  }

  constructor(readonly boardId: string, private doc: Y.Doc, private local: () => IndexedDBBlobSource) {
    super();
    this.records = doc.getMap<NativeMediaRecord>('nativeMedia');
    this.folderLoaded = folderSetting().then(f => { this.folder = f; }).catch(() => {});
    doc.on('update', () => {
      clearTimeout(this.backupTimer);
      this.backupTimer = setTimeout(() => { void this.backupSnapshot().catch(() => {}); }, 1000);
    });
  }

  status(key: string): MediaSaveState {
    return this.states.get(key) || { state: 'checking', message: 'Checking original file…' };
  }
  private report(key: string, state: MediaSaveState['state'], message: string): void {
    this.states.set(key, { state, message });
    this.dispatchEvent(new Event('change'));
  }
  cloudUrl(key: string): string | undefined { return this.records.get(key)?.cloudUrl; }

  private async directory(create = false): Promise<FileSystemDirectoryHandle | undefined> {
    await this.folderLoaded;
    if (!this.folder) return;
    if (await this.folder.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      throw new Error('Folder permission expired. Choose your Voidspace folder again to resume backups.');
    }
    const boards = await this.folder.getDirectoryHandle('boards', { create });
    return boards.getDirectoryHandle(encodeURIComponent(this.boardId), { create });
  }
  private async diskWrite(key: string, blob: Blob): Promise<boolean> {
    const dir = await this.directory(true);
    if (!dir) return false;
    const files = await dir.getDirectoryHandle('media', { create: true });
    const handle = await files.getFileHandle(await fileKey(key), { create: true });
    const stream = await handle.createWritable();
    try { await stream.write(blob); await stream.close(); }
    catch (e) { await stream.abort().catch(() => {}); throw e; }
    return true;
  }
  private async diskRead(key: string): Promise<Blob | null> {
    try {
      const dir = await this.directory();
      if (!dir) return null;
      const files = await dir.getDirectoryHandle('media');
      const blob = await (await files.getFileHandle(await fileKey(key))).getFile();
      return new Blob([blob], { type: this.records.get(key)?.mime || blob.type });
    } catch { return null; }
  }

  async set(key: string, blob: Blob): Promise<string> {
    // Keep a rescue copy in memory if BOTH persistent destinations fail. The
    // UI can still offer Download original rather than losing the dropped file.
    this.retained.set(key, blob);
    let browser = false;
    let disk = false;
    let diskError = '';
    try { await this.local().set(key, blob); browser = true; } catch { /* try disk */ }
    try { disk = await this.diskWrite(key, blob); } catch { diskError = ' The folder backup failed; check disk space and permissions.'; }
    const previous = this.records.get(key);
    this.records.set(key, { ...previous, name: blob instanceof File ? blob.name : previous?.name || 'Dropped file', mime: blob.type, bytes: blob.size });
    if (!browser && !disk) {
      this.report(key, 'unsaved', 'Not saved: device storage is full or unavailable. Download the original before closing.');
      return key;
    }
    this.retained.delete(key);
    this.report(key, disk ? 'folder' : 'browser', disk ? 'Saved in your Voidspace folder.' : `Saved in this browser.${diskError}`);
    void navigator.storage?.persist?.().catch(() => false);
    // Upload only with the person's yes. Already answered (the same file again,
    // or a relink) → honour that answer; otherwise ask.
    const choice = this.records.get(key)?.upload;
    if (choice === 'cloud') void this.mirror(key, blob);
    else if (!choice && !this.cloudUrl(key)) this.dispatchEvent(new CustomEvent(NEEDS_UPLOAD_CHOICE, { detail: key }));
    return key;
  }

  async get(key: string): Promise<Blob | null> {
    if (this.retained.has(key)) return this.retained.get(key)!;
    let blob: Blob | null = null;
    try { blob = await this.local().get(key); } catch { /* folder and cloud remain usable */ }
    let disk = false;
    if (!blob) { blob = await this.diskRead(key); disk = !!blob; }
    if (blob) {
      if (!this.checked.has(key)) {
        this.checked.add(key);
        if (!this.records.has(key)) this.records.set(key, { name: 'Dropped file', mime: blob.type, bytes: blob.size });
        this.report(key, this.cloudUrl(key) ? 'cloud' : disk ? 'folder' : 'browser', this.cloudUrl(key) ? 'Backed up to cloud.' : disk ? 'Saved in your Voidspace folder.' : 'Saved in this browser.');
        // Finish an upload the person already said yes to (it was interrupted
        // or failed). Nothing else uploads without being asked.
        if (this.records.get(key)?.upload === 'cloud') void this.mirror(key, blob);
      }
      return blob;
    }
    const url = this.cloudUrl(key);
    if (url) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error('download failed');
        blob = await res.blob();
        if (!blob.size) throw new Error('empty original');
        await this.local().set(key, blob).catch(() => {});
        this.report(key, 'cloud', 'Backed up to cloud.');
        return blob;
      } catch {
        this.report(key, 'missing', 'Cloud copy could not be loaded. Check your connection and retry.');
        return null;
      }
    }
    this.report(key, 'missing', 'Original is not on this device and has no cloud backup. Open its saved folder or relink the original.');
    return null;
  }

  mirror(key: string, blob?: Blob): Promise<string | undefined> {
    const saved = this.cloudUrl(key);
    if (saved) return Promise.resolve(saved);
    const pending = this.mirrors.get(key);
    if (pending) return pending;
    const task = this.queue.then(async () => {
      const original = blob || await this.get(key);
      if (!original) { this.mirrorErrors.set(key, this.status(key).message); return; }
      const localState = this.status(key);
      this.report(key, 'uploading', 'Original kept on this device. Backing up to cloud…');
      try {
        const shared = sharedProjectId();
        const url = shared ? await uploadSharedMedia(shared, original) : await uploadBlob(original, this.records.get(key)?.name || 'board-media');
        const record = this.records.get(key)!;
        this.records.set(key, { ...record, cloudUrl: url, upload: 'cloud' });
        this.mirrorErrors.delete(key);
        this.report(key, 'cloud', 'Backed up to cloud.');
        return url;
      } catch (e) {
        const reason = e instanceof Error ? e.message : 'Cloud backup failed.';
        // A retry must not stack the previous failure's words onto this one.
        const prior = this.mirrorErrors.get(key);
        const base = prior ? localState.message.replace(prior, '').trim() : localState.message;
        this.mirrorErrors.set(key, reason);
        this.report(key, localState.state === 'unsaved' ? 'unsaved' : localState.state === 'folder' ? 'folder' : 'browser', `${base} ${reason}`);
      }
    }).finally(() => { this.mirrors.delete(key); });
    this.mirrors.set(key, task);
    this.queue = task.then(() => {}, () => {});
    return task;
  }

  /** The person's "Upload": remember the yes (so an interrupted upload resumes) and upload. */
  upload(key: string): Promise<string | undefined> {
    const record = this.records.get(key);
    if (record && record.upload !== 'cloud') this.records.set(key, { ...record, upload: 'cloud' });
    return this.mirror(key);
  }

  /** The person's "Keep in this browser only". */
  keepLocal(key: string): void {
    const record = this.records.get(key);
    if (record && !record.cloudUrl) this.records.set(key, { ...record, upload: 'local' });
    this.dispatchEvent(new Event('change'));
  }

  /** Whether this key's bytes exist only in this browser (or folder): no cloud copy. */
  isBrowserOnly(key: string): boolean {
    return !this.cloudUrl(key) && this.records.has(key);
  }

  /** Called only from a user gesture. Browser permission must never be faked. */
  async chooseFolder(): Promise<void> {
    const picker = (window as unknown as { showDirectoryPicker?: (o: object) => Promise<Directory> }).showDirectoryPicker;
    if (!picker) throw new Error('Folder access is not supported in this browser. Download originals or use a desktop browser with folder access.');
    const folder = await picker({ id: 'voidspace-media', mode: 'readwrite', startIn: 'documents' });
    if (await folder.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Folder access was not granted. Your browser copies are unchanged.');
    await folderSetting(folder);
    this.folder = folder;
    // Merge a same-board disk snapshot to restore its media directory index.
    try {
      const dir = await this.directory();
      if (dir) Y.applyUpdate(this.doc, new Uint8Array(await (await (await dir.getFileHandle('board.yjs')).getFile()).arrayBuffer()));
    } catch (e) { if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e; }
    for (const key of new Set([...this.records.keys(), ...this.retained.keys()])) {
      const blob = await this.get(key);
      if (!blob) continue;
      await this.diskWrite(key, blob);
      if (!this.cloudUrl(key)) this.report(key, 'folder', 'Saved in your Voidspace folder.');
      this.retained.delete(key);
    }
    await this.backupSnapshot();
    this.dispatchEvent(new Event('change'));
  }

  async backupSnapshot(): Promise<void> {
    this.snapshotQueue = this.snapshotQueue.catch(() => {}).then(async () => {
      const dir = await this.directory(true);
      if (!dir) return;
      const stream = await (await dir.getFileHandle('board.yjs', { create: true })).createWritable();
      await stream.write(new Blob([Y.encodeStateAsUpdate(this.doc) as BlobPart]));
      await stream.close();
    });
    return this.snapshotQueue.catch(() => {
      this.dispatchEvent(new CustomEvent('backup-error', { detail: 'Board folder backup failed. Check disk space and folder permissions.' }));
      throw new Error('Board folder backup failed. Check disk space and folder permissions.');
    });
  }

  async download(key: string): Promise<void> {
    const blob = await this.get(key);
    if (!blob) throw new Error(this.status(key).message);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = this.records.get(key)?.name || 'board-media'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
