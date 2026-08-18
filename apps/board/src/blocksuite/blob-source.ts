/**
 * VoidspaceBlobSource — the board's blob store, where media are REFERENCES.
 *
 * BlockSuite asks this object for the bytes behind a `sourceId`. For a normal
 * AFFiNE workspace those bytes live in IndexedDB; for a board they almost always
 * live in the user's Voidspace Library, and copying them would make the board's
 * local database grow with total media size (see `board/media-ref.ts` for why
 * that is the wrong shape). So:
 *
 *   • a `vsmedia:` key is RESOLVED — images are fetched once at display size and
 *     cached; video and audio return a stub, because their player streams from
 *     the URL and must never hold the file;
 *   • anything else is a genuinely local blob (a pasted screenshot, a file
 *     dragged off the desktop) and goes to IndexedDB, exactly as AFFiNE would.
 *
 * TWO PROPERTIES MATTER MORE THAN THE MECHANISM, and both are about big boards:
 *
 *  1. FETCHES ARE QUEUED AND VIEWPORT-FIRST. BlockSuite connects every gfx block
 *     in the document, not only the visible ones — `gfx-viewport` culls by
 *     VISIBILITY, so an off-screen image block still runs `connectedCallback` and
 *     still asks for its blob. Opening a 200-image board therefore fires 200
 *     requests at once unless something intervenes. The queue caps concurrency
 *     and serves whatever is on screen first, so a big board paints as fast as a
 *     small one and the rest fills in behind.
 *
 *  2. STATE IS REPORTED, SO A DEAD ASSET SAYS SO. `blobState$` drives the block's
 *     own loading spinner and error card. Without it a missing asset renders as
 *     an empty box that looks identical to a slow one — which is precisely how
 *     "adding media doesn't work" was diagnosed as a code bug when it was
 *     actually expired links in the library.
 */
import { BlobEngine, IndexedDBBlobSource, type BlobSource, type BlobState } from '@blocksuite/sync';
import { BehaviorSubject, Observable } from 'rxjs';

import { decodeMediaRef, isMediaRef, type MediaRef } from '../board/media-ref';
import { awaitParentToken, getParentToken } from '../board/parent-auth';

/** Parallel media fetches. Six matches what a browser gives one origin anyway. */
const CONCURRENCY = 6;
/** Images kept in memory. Bounded because a long session filters through many. */
const MEM_LIMIT = 240;
/**
 * How long a media fetch waits for a session that has not arrived yet.
 *
 * Long enough to cover the parent restoring Firebase from IndexedDB (the page's
 * own auth waits allow four seconds, and useAuth's stall recovery fires at
 * 2.5s), short enough that a genuinely signed-out board still settles while the
 * user is looking at it. Ends early the moment a token is pushed, so this is a
 * ceiling on the bad case rather than a cost on the normal one.
 */
const AUTH_WAIT_MS = 8_000;

/** On-device copy, so reopening a board is instant and works offline. */
const MEDIA_CACHE = 'voidspace-board-media-v1';

/**
 * What a streaming card gets instead of its file.
 *
 * The attachment block refuses to render its embed view without SOME blob url
 * (`attachment-block.ts:447`), and its resource controller treats a null blob as
 * an error. One byte with the right MIME satisfies both while leaving the actual
 * file where it belongs — on the server, streamed by the player over range
 * requests. `media-embed.ts` ignores the url this produces and builds its own.
 */
function stubFor(ref: MediaRef): Blob {
  return new Blob([new Uint8Array(1)], { type: ref.mime || 'application/octet-stream' });
}

const idle: BlobState = {
  uploading: false, downloading: false, overSize: false,
  needUpload: false, needDownload: false, errorMessage: null,
};

export interface VoidspaceBlobSourceOptions {
  /** Names the IndexedDB database for locally-owned blobs. */
  boardId: string;
}

interface Pending {
  key: string;
  ref: MediaRef;
  resolve(blob: Blob | null): void;
}

export class VoidspaceBlobSource implements BlobSource {
  readonly name = 'voidspace';
  readonly readonly = false;

  /**
   * Which reference keys are on screen right now.
   *
   * Assigned after mount, because it reads the gfx viewport and that does not
   * exist until the editor host is built. Absent, the queue is plain FIFO —
   * correct, just less clever about what the user is looking at.
   */
  visibleKeys: (() => Set<string>) | null = null;

  private readonly boardId: string;
  private _local: IndexedDBBlobSource | null = null;
  private readonly mem = new Map<string, Blob>();
  private readonly states = new Map<string, BehaviorSubject<BlobState>>();
  private readonly waiting: Pending[] = [];
  private readonly inflight = new Map<string, Promise<Blob | null>>();
  private running = 0;
  private scheduled = false;

  constructor(opts: VoidspaceBlobSourceOptions) {
    this.boardId = opts.boardId;
  }

  /**
   * The IndexedDB store for genuinely local blobs, opened on first use.
   *
   * Lazy on purpose. `idb-keyval` opens the database in its constructor, so an
   * eager field would create a second IndexedDB database for every board — even
   * the overwhelming majority that only ever hold Library references and never
   * store a byte locally.
   */
  private get local(): IndexedDBBlobSource {
    this._local ??= new IndexedDBBlobSource(`voidspace-board-${this.boardId}`);
    return this._local;
  }

  /** Reference keys that have not resolved yet — the queue's working set. */
  get pendingCount(): number {
    return this.waiting.length + this.running;
  }

  async get(key: string): Promise<Blob | null> {
    if (!isMediaRef(key)) return this.local.get(key);

    const ref = decodeMediaRef(key);
    if (!ref) return null;

    // Streaming kinds never hold bytes — see `stubFor`.
    if (ref.kind !== 'image') {
      this.state(key).next({ ...idle });
      return stubFor(ref);
    }

    const hot = this.mem.get(key);
    if (hot) {
      // Touch: re-inserting moves it to the end of the Map's iteration order,
      // which is what makes the eviction below an LRU rather than a FIFO.
      this.mem.delete(key);
      this.mem.set(key, hot);
      return hot;
    }

    const already = this.inflight.get(key);
    if (already) return already;

    const job = new Promise<Blob | null>(resolve => {
      this.state(key).next({ ...idle, downloading: true });
      this.waiting.push({ key, ref, resolve });
      this.schedule();
    }).finally(() => this.inflight.delete(key));

    this.inflight.set(key, job);
    return job;
  }

  async set(key: string, value: Blob): Promise<string> {
    if (!isMediaRef(key)) return this.local.set(key, value);

    const ref = decodeMediaRef(key);
    // A zero-length placeholder is what the streaming path hands us on insert;
    // caching it would mean the card renders one empty byte forever.
    if (ref?.kind === 'image' && value.size > 0) {
      this.remember(key, value);
      void this.persist(ref.src, value);
    }
    this.state(key).next({ ...idle });
    return key;
  }

  async delete(key: string): Promise<void> {
    if (isMediaRef(key)) {
      this.mem.delete(key);
      return;
    }
    await this.local.delete(key);
  }

  async list(): Promise<string[]> {
    const local = this._local ? await this._local.list() : [];
    return [...local, ...this.mem.keys()];
  }

  /**
   * Drives the block's own spinner / error card.
   *
   * Returning a live observable rather than null is what turns "an empty
   * rectangle" into "loading…" and then either the picture or a labelled
   * failure the user can retry from.
   *
   * THE FIRST EMISSION IS DEFERRED, and that is not a nicety. `ResourceController`
   * subscribes from inside a preact-signals `effect`, and its handler writes a
   * signal (`state$`). A `BehaviorSubject` replays its current value
   * SYNCHRONOUSLY on subscribe, so that write lands while the effect is still
   * running and signals aborts the whole effect with "Cycle detected" — once per
   * media block, and silently taking the loading and error states down with it.
   * A tick's delay puts the write after the effect has finished; the replay
   * still delivers, because the value is held rather than fired.
   */
  blobState$(key: string): Observable<BlobState> {
    const subject = this.state(key);
    return new Observable<BlobState>(subscriber => {
      let inner: { unsubscribe(): void } | null = null;
      const timer = setTimeout(() => { inner = subject.subscribe(subscriber); }, 0);
      return () => {
        clearTimeout(timer);
        inner?.unsubscribe();
      };
    });
  }

  private state(key: string): BehaviorSubject<BlobState> {
    let s = this.states.get(key);
    if (!s) {
      s = new BehaviorSubject<BlobState>({ ...idle });
      this.states.set(key, s);
    }
    return s;
  }

  private remember(key: string, blob: Blob): void {
    this.mem.set(key, blob);
    while (this.mem.size > MEM_LIMIT) {
      const oldest = this.mem.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.mem.delete(oldest);
    }
  }

  /** Cache API rather than IndexedDB: evictable storage for evictable data. */
  private async persist(url: string, blob: Blob): Promise<void> {
    try {
      const cache = await caches.open(MEDIA_CACHE);
      await cache.put(url, new Response(blob, { headers: { 'content-type': blob.type } }));
    } catch { /* insecure context or quota — the memory copy still works */ }
  }

  private async cached(url: string): Promise<Blob | null> {
    try {
      const cache = await caches.open(MEDIA_CACHE);
      const hit = await cache.match(url);
      return hit ? await hit.blob() : null;
    } catch {
      return null;
    }
  }

  /**
   * Let the whole burst arrive before deciding what to fetch first.
   *
   * BlockSuite connects a batch of blocks in one task, so every `get` for that
   * batch lands before any microtask runs. Pumping synchronously on the first
   * one would start six fetches while the queue still held one entry — first
   * come, first served, which on a restored board means whatever happens to be
   * earliest in the document rather than whatever the user is looking at.
   */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  /**
   * Start as many queued fetches as the concurrency budget allows, taking
   * whatever is on screen first.
   *
   * The visible set is recomputed per slot rather than per enqueue, because the
   * user pans while a board is still loading and the right answer is "whatever
   * they are looking at NOW", not "whatever they were looking at when the block
   * connected".
   */
  private pump(): void {
    while (this.running < CONCURRENCY && this.waiting.length) {
      const visible = this.visibleKeys?.() ?? null;
      let index = 0;
      if (visible && visible.size) {
        const found = this.waiting.findIndex(p => visible.has(p.key));
        if (found >= 0) index = found;
      }
      const next = this.waiting.splice(index, 1)[0];
      if (!next) return;
      this.running++;
      void this.run(next).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(job: Pending): Promise<void> {
    const { key, ref, resolve } = job;

    const fromCache = await this.cached(ref.src);
    if (fromCache) {
      this.remember(key, fromCache);
      this.state(key).next({ ...idle });
      resolve(fromCache);
      return;
    }

    const blob = await this.download(ref.src);
    if (!blob) {
      // NAMED, not silent. This string is what the block prints on its error
      // card, so it has to tell the user something they can act on: the board
      // placed the asset correctly and the LIBRARY link is dead.
      this.state(key).next({
        ...idle,
        errorMessage: 'This asset is no longer available in your library.',
      });
      resolve(null);
      return;
    }

    this.remember(key, blob);
    void this.persist(ref.src, blob);
    this.state(key).next({ ...idle });
    resolve(blob);
  }

  /**
   * Fetch with auth, once more once we can do better than the first attempt.
   *
   * TWO DIFFERENT FAILURES LOOK IDENTICAL HERE, and treating them the same is
   * what made images vanish from boards.
   *
   *  • WE HAVE A TOKEN AND IT IS STALE. A board open for an hour outlives its
   *    token, and the first thing to notice is a block scrolling into view.
   *    Force a refresh and try again.
   *
   *  • WE NEVER HAD ONE YET. The parent restores its Firebase session
   *    asynchronously, and `NO_TOKEN_TTL` then makes "no token" the answer given
   *    to every consumer for the next thirty seconds. Every image that connects
   *    in that window used to fetch unauthenticated, take a 401, and return null
   *    — which `ResourceController.blob()` renders as the permanent card reading
   *    "Image not found". The asset was fine, the link was fine, and the only
   *    way back was a gesture that re-asks: double-clicking the block runs
   *    `refreshUrlWith`, which calls `get` again, which by then succeeds. Hence
   *    "the images are gone, but they're there when I double-click".
   *
   *    So WAIT for the token instead of concluding there is none. The block
   *    shows its spinner meanwhile, which is the honest state — the picture is
   *    on its way — and a signed-out board still resolves because the wait is
   *    bounded.
   */
  private async download(url: string): Promise<Blob | null> {
    let token = await getParentToken().catch(() => null);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (res.ok) return await res.blob();
        // Not an auth problem: a 404 is a dead link and asking again with a
        // better token would only turn one honest failure into two.
        if (res.status !== 401 && res.status !== 403) return null;
      } catch {
        return null;
      }
      if (attempt > 0) break;
      token = token
        ? await getParentToken(true).catch(() => null)
        : await awaitParentToken(AUTH_WAIT_MS).catch(() => null);
      if (!token) return null;
    }
    return null;
  }
}

/**
 * A blob engine that lets a caller CHOOSE the key AFFiNE will store under.
 *
 * `BlobEngine.set(blob)` keys by content hash, and every native insert helper
 * (`addImages`, `addAttachments`, paste, the toolbar uploader) calls exactly
 * that. Without this, using those helpers — which we must, because every
 * hand-rolled substitute has been wrong in ways that only appear at runtime —
 * would mean the block's `sourceId` is a hash and the reference is lost.
 *
 * So the caller announces "the blob I am about to hand you is really this
 * reference", the helper runs untouched, and the block comes out pointing at the
 * Library. One WeakMap, no fork, and the native path stays the only path.
 */
export class BoardBlobEngine extends BlobEngine {
  private readonly hints = new WeakMap<Blob, string>();

  /** Announce the key for the next `set(blob)` carrying exactly this blob. */
  hint(blob: Blob, key: string): void {
    this.hints.set(blob, key);
  }

  override async set(value: Blob): Promise<string>;
  override async set(key: string, value: Blob): Promise<string>;
  override async set(valueOrKey: string | Blob, value?: Blob): Promise<string> {
    if (typeof valueOrKey !== 'string') {
      const hinted = this.hints.get(valueOrKey);
      if (hinted) return super.set(hinted, valueOrKey);
    }
    return typeof valueOrKey === 'string'
      ? super.set(valueOrKey, value as Blob)
      : super.set(valueOrKey);
  }
}
