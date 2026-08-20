/**
 * Runs one composition in a live frame, and knows when it is ready.
 *
 * This is what the editor shows for the page you are working on: the real
 * document, animating, rendered by the browser — not a bitmap of it. Capture is
 * needed for thumbnails and export, never for editing, and that narrowing is
 * what keeps the one expensive operation off the interactive path.
 *
 * THREE THINGS HERE ARE NOT OPTIONAL, each learned the hard way:
 *
 *   1. THE LISTENER GOES ON BEFORE THE DOCUMENT DOES. A postMessage only reaches
 *      someone already listening. Measured in a browser: a listener attached one
 *      second late saw nothing while the frame behind it was fully settled.
 *
 *   2. RECOVERY IS A PING, NOT A READ. A same-origin host could read the latch
 *      off the document, but this frame is sandboxed with an opaque origin, so
 *      the only way back is to ask again.
 *
 *   3. MESSAGES ARE MATCHED BY SOURCE, NOT ORIGIN. A sandboxed frame's origin is
 *      the string "null", so an origin check is worthless — and every frame on
 *      the page would report the same one. Identity is `event.source`.
 *
 * SIZE: the document is created at its FRAME size and scaled with a transform.
 * Sizing the element to the box instead would re-run the block's layout at a
 * different width, and for a pixel-designed block that is a different design.
 */
import type { CompositionMessage } from './frame-runtime';

export type HostStatus = 'loading' | 'ready' | 'timeout' | 'error' | 'destroyed';

export interface HostState {
  status: HostStatus;
  /** What the frame said about itself when it settled. */
  detail?: { seeked?: number; brokenImages?: string[] } | null;
  /** When the frame settled, by its own clock. */
  atMs?: number;
}

export interface CompositionHostOptions {
  /** A prepared document — see `prepareComposition`. */
  html: string;
  /** The frame the document lays out in. */
  frameWidth: number;
  frameHeight: number;
  /** Give up waiting after this. Slightly longer than the in-document gate, so
   *  the frame gets to report its own timeout before the host declares one. */
  readyTimeoutMs?: number;
  /** Ask again if nothing has arrived by then. Covers the ordering slip the
   *  listener rule is meant to prevent, and any dropped message. */
  pingAfterMs?: number;
  /** Injectable for tests, which have no real iframe to load a document into. */
  createFrame?: () => HTMLIFrameElement;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_PING_AFTER_MS = 1_500;

/**
 * How much to shrink a frame to sit inside a box, never enlarging past 1.
 *
 * Capped because a composition scaled up is a blurry composition: the pixels
 * come from a document laid out at frame size, and stretching them past that
 * looks like a low-resolution asset rather than a design decision.
 */
export function fitScale(
  frame: { width: number; height: number },
  box: { width: number; height: number },
): number {
  if (!(frame.width > 0) || !(frame.height > 0)) return 1;
  if (!(box.width > 0) || !(box.height > 0)) return 1;
  return Math.min(1, box.width / frame.width, box.height / frame.height);
}

/** A live composition frame, and the protocol that tells you it is usable. */
export class CompositionHost {
  private frame: HTMLIFrameElement | null = null;
  private onMessage: ((e: MessageEvent) => void) | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private settle: ((s: HostState) => void) | null = null;
  private state: HostState = { status: 'loading' };

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: CompositionHostOptions,
  ) {}

  /** The frame element, once mounted. For sizing by the caller. */
  get element(): HTMLIFrameElement | null {
    return this.frame;
  }

  get status(): HostState {
    return this.state;
  }

  /**
   * Put the document in a frame and resolve when it has settled.
   *
   * Resolves rather than rejects on timeout: a composition that took too long is
   * still showable, and the caller decides whether a stale-looking frame is
   * worth showing. Only a genuinely broken mount is an error.
   */
  mount(): Promise<HostState> {
    const { html, frameWidth, frameHeight } = this.opts;
    const readyTimeoutMs = this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const pingAfterMs = this.opts.pingAfterMs ?? DEFAULT_PING_AFTER_MS;

    const frame = this.opts.createFrame ? this.opts.createFrame() : document.createElement('iframe');
    this.frame = frame;

    frame.width = String(frameWidth);
    frame.height = String(frameHeight);
    frame.style.border = '0';
    frame.style.display = 'block';
    frame.style.transformOrigin = '0 0';
    /**
     * `allow-scripts` and nothing else. The document is a block — from the
     * shipped library, from another user's published work, or authored by the
     * agent — and without a sandbox it would run in our origin with our session.
     * Deliberately NOT `allow-same-origin`: with both, a frame can remove its own
     * sandbox attribute, which is the same as having none.
     */
    frame.setAttribute('sandbox', 'allow-scripts');

    return new Promise<HostState>((resolve) => {
      this.settle = resolve;

      // ── 1. Listen BEFORE the document exists ──────────────────────────────
      this.onMessage = (e: MessageEvent) => {
        // Identity by source: an opaque origin is the string "null" for every
        // sandboxed frame on the page, so it distinguishes nothing.
        if (!this.frame || e.source !== this.frame.contentWindow) return;
        const d = e.data as CompositionMessage | undefined;
        if (!d || d.__composition !== 'ready') return;
        if (d.state === 'pending') return; // an answer, but not the one we wait for
        this.finish({
          status: d.state === 'ok' ? 'ready' : d.state === 'timeout' ? 'timeout' : 'error',
          detail: d.detail ?? null,
          atMs: d.atMs,
        });
      };
      window.addEventListener('message', this.onMessage);

      // ── 2. Then hand it the document ──────────────────────────────────────
      this.container.appendChild(frame);
      frame.srcdoc = html;

      // ── 3. Ask again if nothing arrives, and stop waiting eventually ──────
      this.timers.push(setTimeout(() => this.ping(), pingAfterMs));
      this.timers.push(setTimeout(() => {
        this.finish({ status: 'timeout', detail: null });
      }, readyTimeoutMs));
    });
  }

  /** Re-ask a frame that may have answered before anyone was listening. */
  ping(): void {
    try {
      this.frame?.contentWindow?.postMessage({ __composition: 'ping' }, '*');
    } catch {
      // A frame mid-navigation throws; the timeout still covers us.
    }
  }

  /** Scale the frame to sit inside a box, without re-laying-out the document. */
  fitInto(box: { width: number; height: number }): number {
    const scale = fitScale({ width: this.opts.frameWidth, height: this.opts.frameHeight }, box);
    if (this.frame) this.frame.style.transform = `scale(${scale})`;
    return scale;
  }

  destroy(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.onMessage) window.removeEventListener('message', this.onMessage);
    this.onMessage = null;
    this.frame?.parentNode?.removeChild(this.frame);
    this.frame = null;
    // A pending mount() must not hang forever on an unmounted host.
    this.finish({ status: 'destroyed' });
  }

  private finish(s: HostState): void {
    if (!this.settle) return;
    // Whichever arrives first wins; the rest are noise from timers already in
    // flight. Clearing them here keeps a destroyed host from firing later.
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.state = s;
    const settle = this.settle;
    this.settle = null;
    settle(s);
  }
}
