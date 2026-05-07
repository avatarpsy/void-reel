/**
 * RAM Preview frame cache — After Effects-style cached playback.
 *
 * Behaviour:
 *   1. First play decodes frames normally; each composited frame is
 *      captured as an ImageBitmap and stored keyed by frame number.
 *   2. Second play draws from cache — no decode, instant smooth playback.
 *   3. Any timeline edit bumps the version; stale frames are skipped on
 *      read and lazily evicted on the next write cycle.
 *
 * Eviction is distance-based: when memory is full, the frame furthest
 * from the current playhead is dropped first. This gives a sliding
 * window that tracks wherever the user is working — identical to After
 * Effects' green RAM bar that fills around the CTI.
 *
 * Memory limit is user-configurable via `setMaxMemory()`.
 */

export interface PreviewCacheStats {
  cachedFrames: number;
  memoryBytes: number;
  maxMemoryBytes: number;
  version: number;
  hitRate: number;
}

interface CachedFrame {
  bitmap: ImageBitmap;
  version: number;
  byteSize: number;
}

const BYTES_PER_PIXEL = 4;
const DEFAULT_MAX_MEMORY = 1024 * 1024 * 1024; // 1 GB
const MIN_MAX_MEMORY = 128 * 1024 * 1024; // 128 MB floor

export class PreviewFrameCache {
  private frames = new Map<number, CachedFrame>();
  private version = 0;
  private totalBytes = 0;
  private maxMemory = DEFAULT_MAX_MEMORY;
  private hits = 0;
  private misses = 0;
  private anchor = 0; // current playhead frame — eviction pivot

  /** Set the maximum RAM the cache may use (bytes). Clamped to ≥128 MB. */
  setMaxMemory(bytes: number): void {
    this.maxMemory = Math.max(MIN_MAX_MEMORY, bytes);
    this.evictUntilBudget();
  }

  getMaxMemory(): number {
    return this.maxMemory;
  }

  /** Tell the cache where the playhead is so eviction drops the
   *  furthest frames first (sliding window). Call on every frame. */
  setAnchor(frameNumber: number): void {
    this.anchor = frameNumber;
  }

  /** Bump version — all existing frames become stale and are freed. */
  invalidate(): void {
    this.version++;
    for (const [fn, entry] of this.frames) {
      if (entry.version !== this.version) {
        this.totalBytes -= entry.byteSize;
        try { entry.bitmap.close(); } catch {}
        this.frames.delete(fn);
      }
    }
  }

  /** Full clear — releases all bitmaps and resets stats. */
  clear(): void {
    for (const f of this.frames.values()) {
      try { f.bitmap.close(); } catch {}
    }
    this.frames.clear();
    this.totalBytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  /** Try to get a cached frame. Returns null on miss or stale version. */
  get(frameNumber: number): ImageBitmap | null {
    const entry = this.frames.get(frameNumber);
    if (!entry || entry.version !== this.version) {
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.bitmap;
  }

  /** Store a composited frame. Caller must NOT close the bitmap. */
  set(frameNumber: number, bitmap: ImageBitmap): void {
    const existing = this.frames.get(frameNumber);
    if (existing) {
      this.totalBytes -= existing.byteSize;
      try { existing.bitmap.close(); } catch {}
    }

    const byteSize = bitmap.width * bitmap.height * BYTES_PER_PIXEL;
    this.frames.set(frameNumber, { bitmap, version: this.version, byteSize });
    this.totalBytes += byteSize;
    this.evictUntilBudget();
  }

  /** Frame numbers cached for the current version (sorted). */
  getCachedRange(): number[] {
    const v = this.version;
    const out: number[] = [];
    for (const [fn, entry] of this.frames) {
      if (entry.version === v) out.push(fn);
    }
    return out.sort((a, b) => a - b);
  }

  get currentVersion(): number {
    return this.version;
  }

  getStats(): PreviewCacheStats {
    const total = this.hits + this.misses;
    return {
      cachedFrames: this.getCachedRange().length,
      memoryBytes: this.totalBytes,
      maxMemoryBytes: this.maxMemory,
      version: this.version,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  // ── Eviction ───────────────────────────────────────────────────────

  private evictUntilBudget(): void {
    while (this.totalBytes > this.maxMemory && this.frames.size > 0) {
      if (!this.evictFurthest()) break;
    }
  }

  /** Drop the frame furthest from the anchor (playhead). */
  private evictFurthest(): boolean {
    let worstKey = -1;
    let worstDist = -1;
    for (const fn of this.frames.keys()) {
      const dist = Math.abs(fn - this.anchor);
      if (dist > worstDist) {
        worstDist = dist;
        worstKey = fn;
      }
    }
    if (worstKey < 0) return false;
    const entry = this.frames.get(worstKey)!;
    this.totalBytes -= entry.byteSize;
    try { entry.bitmap.close(); } catch {}
    this.frames.delete(worstKey);
    return true;
  }
}
