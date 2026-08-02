/**
 * BoardWorkspace — our production implementation of BlockSuite's `Workspace`.
 *
 * WHY THIS EXISTS AT ALL
 * BlockSuite ships `TestWorkspace`, and the playground uses it — but its own
 * doc-comment says "@internal / Test only / Do not use this in production".
 * `Workspace`, `Doc` and `WorkspaceMeta` are plain interfaces (~12 members
 * between them), so implementing them is both the supported path and a smaller
 * surface than depending on a `/test` entry point that upstream is free to
 * delete in any patch release.
 *
 * ONE BOARD = ONE DOC. AFFiNE is a multi-document workspace: a root Y.Doc holds
 * a `spaces` map of sub-docs, each lazily loaded. A Voidspace board is a single
 * canvas that is opened by id from a URL, so that indirection buys us nothing
 * and costs us the whole sub-doc loading dance (`subdocs` events, `loaded`
 * races) plus a second persistence target. Here `rootDoc === spaceDoc`: one
 * Y.Doc, one IndexedDB database, one snapshot blob in Storage. If a board ever
 * needs to embed another board, that is when the sub-doc model earns its keep.
 *
 * MEDIA ARE REFERENCES, AND THE BLOB SOURCE IS WHERE THAT IS ENFORCED.
 * An earlier build used `MemoryBlobSource`, on the theory that a board holds no
 * bytes. It holds no bytes DURABLY, which is not the same thing: AFFiNE's insert
 * helpers still handed it every dropped file, and a memory map does not survive a
 * refresh — so every image and video on a board came back as "not found" the
 * moment the page reloaded. `VoidspaceBlobSource` is the actual answer: a
 * `vsmedia:` key resolves against the Library on demand, and only genuinely local
 * blobs (a pasted screenshot) reach IndexedDB.
 */
import {
  AwarenessEngine,
  DocEngine,
  NoopDocSource,
} from '@blocksuite/sync';
import { NoopLogger } from '@blocksuite/global/utils';
import {
  AwarenessStore,
  StoreContainer,
  nanoid,
  type Doc,
  type DocMeta,
  type DocsPropertiesMeta,
  type GetStoreOptions,
  type IdGenerator,
  type RemoveStoreOptions,
  type Store,
  type Workspace,
  type WorkspaceMeta,
  type YBlock,
} from '@blocksuite/store';
import { Subject } from 'rxjs';
import { Awareness } from 'y-protocols/awareness.js';
import * as Y from 'yjs';

import { BoardBlobEngine, VoidspaceBlobSource } from './blob-source';

/** The Y.Map key the block tree lives under. Fixed by BlockSuite convention. */
const BLOCKS_KEY = 'blocks';

/**
 * Metadata for the single doc a board owns.
 *
 * Deliberately in-memory rather than mirrored into the Y.Doc: the durable board
 * index (title, thumbnail, status, compiledProjectId) lives in Firestore, which
 * is what the Boards tab queries. Writing a second copy of the title into the
 * CRDT would give us two places to rename a board from.
 */
class BoardMeta implements WorkspaceMeta {
  readonly docMetaAdded = new Subject<string>();
  readonly docMetaRemoved = new Subject<string>();
  readonly docMetaUpdated = new Subject<void>();

  private _metas: DocMeta[] = [];
  private _properties: DocsPropertiesMeta = {};

  get docMetas(): DocMeta[] {
    return this._metas;
  }

  /** BlockSuite's `docs` accessor — the raw list. Same array, different name. */
  get docs(): unknown[] | undefined {
    return this._metas;
  }

  get properties(): DocsPropertiesMeta {
    return this._properties;
  }

  addDocMeta(props: DocMeta, index?: number): void {
    if (index === undefined) this._metas.push(props);
    else this._metas.splice(index, 0, props);
    this.docMetaAdded.next(props.id);
    this.docMetaUpdated.next();
  }

  getDocMeta(id: string): DocMeta | undefined {
    return this._metas.find(m => m.id === id);
  }

  setDocMeta(id: string, props: Partial<DocMeta>): void {
    const meta = this.getDocMeta(id);
    if (!meta) return;
    Object.assign(meta, props);
    this.docMetaUpdated.next();
  }

  removeDocMeta(id: string): void {
    const i = this._metas.findIndex(m => m.id === id);
    if (i < 0) return;
    this._metas.splice(i, 1);
    this.docMetaRemoved.next(id);
    this.docMetaUpdated.next();
  }

  setProperties(meta: DocsPropertiesMeta): void {
    this._properties = meta;
    this.docMetaUpdated.next();
  }

  /** No-op: there is nothing to hydrate when metadata is not persisted here. */
  initialize(): void {}
}

/**
 * The single doc of a board.
 *
 * `rootDoc` and `spaceDoc` are the SAME Y.Doc (see the file header). `load()`
 * is synchronous and idempotent because there is no sub-doc to await — the
 * caller has already handed us a Y.Doc that y-indexeddb has hydrated.
 */
class BoardDoc implements Doc {
  readonly id: string;
  readonly rootDoc: Y.Doc;
  readonly awarenessStore: AwarenessStore;

  private readonly _workspace: BoardWorkspace;
  private readonly _yBlocks: Y.Map<YBlock>;
  private readonly _storeContainer: StoreContainer;
  private _ready = false;

  constructor(opts: {
    id: string;
    workspace: BoardWorkspace;
    doc: Y.Doc;
    awarenessStore: AwarenessStore;
  }) {
    this.id = opts.id;
    this.rootDoc = opts.doc;
    this.awarenessStore = opts.awarenessStore;
    this._workspace = opts.workspace;
    this._yBlocks = this.rootDoc.getMap<YBlock>(BLOCKS_KEY);
    this._storeContainer = new StoreContainer(this);
  }

  /** One doc, no sub-doc: the space IS the root. */
  get spaceDoc(): Y.Doc {
    return this.rootDoc;
  }

  get yBlocks(): Y.Map<YBlock> {
    return this._yBlocks;
  }

  get workspace(): Workspace {
    return this._workspace;
  }

  get meta(): DocMeta | undefined {
    return this._workspace.meta.getDocMeta(this.id);
  }

  /** Always true — the Y.Doc is hydrated before a BoardDoc is constructed. */
  get loaded(): boolean {
    return true;
  }

  /** Whether the block tree has been initialised (page/surface exist). */
  get ready(): boolean {
    return this._ready;
  }

  get getStore(): (options?: GetStoreOptions) => Store {
    return this._storeContainer.getStore;
  }

  get removeStore(): (options: RemoveStoreOptions) => void {
    return this._storeContainer.removeStore;
  }

  /**
   * Run `initFn` once, when the doc has no blocks yet.
   *
   * Idempotent by design: reopening a saved board must not re-seed a second
   * page/surface on top of the user's canvas. The emptiness of `yBlocks` is the
   * only honest signal here — a flag would be a second source of truth that a
   * fresh browser profile would get wrong.
   */
  load(initFn?: () => void): void {
    if (this._ready) return;
    if (this._yBlocks.size === 0 && initFn) initFn();
    this._ready = true;
  }

  clear(): void {
    this._yBlocks.clear();
  }

  remove(): void {
    this.clear();
    this._ready = false;
  }

  dispose(): void {
    if (this._ready) this._yBlocks.clear();
    this._ready = false;
  }
}

/**
 * A workspace holding exactly one board doc.
 *
 * `NoopDocSource` because sync is ours: y-indexeddb owns the local replica and
 * a debounced snapshot goes to Firebase Storage. Handing BlockSuite a DocSource
 * would create a second, competing sync path over the same Y.Doc.
 */
export class BoardWorkspace implements Workspace {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly meta: BoardMeta;
  readonly idGenerator: IdGenerator = nanoid;
  readonly blobSync: BoardBlobEngine;
  /** The reference-resolving source behind `blobSync`, exposed so the mount can
   *  hand it the viewport oracle once the editor exists. */
  readonly blobSource: VoidspaceBlobSource;
  readonly awarenessStore: AwarenessStore;
  readonly awarenessSync: AwarenessEngine;
  readonly docSync: DocEngine;
  readonly slots = { docListUpdated: new Subject<void>() };

  private readonly _docs = new Map<string, BoardDoc>();

  /** Extensions every Store in this workspace is built with (schemas). */
  storeExtensions: NonNullable<GetStoreOptions['extensions']> = [];

  constructor(opts: { id: string; ydoc?: Y.Doc }) {
    this.id = opts.id;
    // Accept a caller-supplied Y.Doc so y-indexeddb can hydrate it BEFORE the
    // workspace is built — otherwise the editor mounts against an empty tree and
    // the user watches their board pop in a frame later.
    this.doc = opts.ydoc ?? new Y.Doc({ guid: opts.id });
    this.meta = new BoardMeta();
    this.awarenessStore = new AwarenessStore(new Awareness(this.doc));

    const logger = new NoopLogger();
    this.awarenessSync = new AwarenessEngine(this.awarenessStore.awareness, []);
    this.docSync = new DocEngine(this.doc, new NoopDocSource(), [], logger);
    this.blobSource = new VoidspaceBlobSource({ boardId: opts.id });
    this.blobSync = new BoardBlobEngine(this.blobSource, [], logger);
  }

  get docs(): Map<string, BoardDoc> {
    return this._docs;
  }

  createDoc(docId?: string): Doc {
    const id = docId ?? this.idGenerator();
    const existing = this._docs.get(id);
    if (existing) return existing;

    const doc = new BoardDoc({
      id,
      workspace: this,
      doc: this.doc,
      awarenessStore: this.awarenessStore,
    });
    this._docs.set(id, doc);
    this.meta.addDocMeta({
      id,
      title: '',
      tags: [],
      createDate: Date.now(),
    });
    this.slots.docListUpdated.next();
    return doc;
  }

  getDoc(docId: string): Doc | null {
    return this._docs.get(docId) ?? null;
  }

  removeDoc(docId: string): void {
    const doc = this._docs.get(docId);
    if (!doc) return;
    this._docs.delete(docId);
    this.meta.removeDocMeta(docId);
    doc.remove();
    this.slots.docListUpdated.next();
  }

  dispose(): void {
    this._docs.forEach(d => d.dispose());
    this._docs.clear();
    this.awarenessStore.destroy();
    this.doc.destroy();
  }
}
