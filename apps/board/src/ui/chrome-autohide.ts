/**
 * The board's chrome gets out of the way until you reach for it.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * A storyboard is a picture of a film, and the two toolbars sat on top of it
 * permanently: ours across the top, AFFiNE's drawing tools and zoom across the
 * bottom. On a canvas you are supposed to LOOK at, that is roughly 130px of
 * furniture over the work, at every zoom level, whether or not anyone is about
 * to draw. Every canvas tool people actually compose in — Figma presentation
 * mode, Blender fullscreen, Premiere's monitor — hides its furniture when the
 * work is what matters.
 *
 * ── HOW, AND WHY NOT CSS :hover ──────────────────────────────────────────────
 * The obvious implementation is a transparent hover strip per edge. It does not
 * work: a strip that can receive :hover also receives clicks, so it would eat
 * every canvas gesture in a 100px band along two edges of a drawing surface —
 * trading a visual obstruction for an interaction one, which is worse.
 *
 * So proximity is measured from a passive `pointermove` on the container and
 * published as attributes on :root. Nothing new sits over the canvas, and the
 * hidden bars are `pointer-events: none`, so the band they used to occupy
 * becomes ordinary canvas.
 *
 * ── WHAT KEEPS IT OPEN ───────────────────────────────────────────────────────
 * Proximity alone would snatch the toolbar away mid-gesture. It also stays while
 *
 *   • the pointer is inside a bar (the bands are generous enough to cover the
 *     popups the pen and shape pickers open ABOVE the toolbar);
 *   • anything inside one has keyboard focus, so Tab reaches the buttons at all;
 *   • a mouse button is down — you are using it;
 *   • the board is EMPTY, because a first-time user should not have to discover
 *     a hover to find the toolbar at all.
 *
 * ── AND WHERE IT DOES NOT APPLY ──────────────────────────────────────────────
 * Coarse pointers. "Reveal on hover" on a touch screen means "reveal never", so
 * a device without hover keeps the chrome exactly as it was.
 */

/** How close to the top edge counts as reaching for our bar. */
const TOP_BAND_PX = 116;
/**
 * The bottom band is deeper than the top one on purpose.
 *
 * AFFiNE's toolbar is 80px tall by itself, and its pen, shape and template
 * pickers open UPWARDS out of it. A band that only covered the toolbar would
 * hide it the moment the pointer moved up into the picker it had just opened.
 */
const BOTTOM_BAND_PX = 210;
/**
 * Grace before hiding again.
 *
 * Long enough to cross a gap between two controls without the bar flickering,
 * short enough that leaving feels like a decision rather than a wait.
 */
const HIDE_DELAY_MS = 260;

export interface ChromeAutohide {
  /** Hold the chrome open regardless of the pointer — the empty state uses it. */
  setPinned(on: boolean): void;
  /** Show both bars now, then resume normal behaviour. */
  reveal(): void;
  /** True when this instance is actually managing visibility. */
  readonly active: boolean;
  destroy(): void;
}

/** A pointer that cannot hover cannot reveal — see the header. */
function canHover(): boolean {
  try {
    return typeof matchMedia === 'function' ? matchMedia('(hover: hover)').matches : true;
  } catch {
    return true;
  }
}

export function installChromeAutohide(container: HTMLElement): ChromeAutohide {
  const root = document.documentElement;

  if (!canHover()) {
    return {
      setPinned() {}, reveal() {}, active: false, destroy() {},
    };
  }

  let pinned = false;
  let held = false;      // a mouse button is down
  let focusTop = false;
  let focusBottom = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  root.dataset.chrome = 'auto';

  const set = (edge: 'top' | 'bottom', on: boolean) => {
    const key = edge === 'top' ? 'chromeTop' : 'chromeBottom';
    const next = on ? 'on' : '';
    // Only write on a real change: this runs off pointermove, and touching a
    // data attribute every frame invalidates style for the whole subtree.
    if (root.dataset[key] === next) return;
    if (next) root.dataset[key] = next;
    else delete root.dataset[key];
  };

  const showBoth = () => { set('top', true); set('bottom', true); };

  const apply = (y: number | null, height: number) => {
    if (pinned || held) { showBoth(); return; }
    if (y === null) {
      set('top', focusTop);
      set('bottom', focusBottom);
      return;
    }
    set('top', focusTop || y <= TOP_BAND_PX);
    set('bottom', focusBottom || y >= height - BOTTOM_BAND_PX);
  };

  const clearHide = () => {
    if (hideTimer === null) return;
    clearTimeout(hideTimer);
    hideTimer = null;
  };

  const onMove = (e: PointerEvent) => {
    clearHide();
    const rect = container.getBoundingClientRect();
    apply(e.clientY - rect.top, rect.height);
  };

  const onLeave = () => {
    clearHide();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      apply(null, 0);
    }, HIDE_DELAY_MS);
  };

  const onDown = () => { held = true; };
  const onUp = () => {
    held = false;
    // Do not snap shut under the pointer that just finished a click — the next
    // move re-evaluates, and leaving starts the normal grace period.
    onLeave();
  };

  /**
   * Focus is tracked on the DOCUMENT, not the container.
   *
   * AFFiNE's toolbar renders into shadow roots and opens pickers that portal
   * elsewhere, so `container.contains(target)` is false for controls that are
   * visibly part of the bottom bar. `composedPath` crosses those boundaries and
   * answers the question actually being asked: is the thing with focus part of
   * one of these bars?
   */
  const edgeOf = (e: Event): 'top' | 'bottom' | null => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (const node of path) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.classList?.contains('vs-board-bar')) return 'top';
      const tag = node.tagName?.toLowerCase();
      if (tag === 'edgeless-toolbar-widget' || tag === 'affine-edgeless-zoom-toolbar-widget') {
        return 'bottom';
      }
    }
    return null;
  };

  const onFocusIn = (e: FocusEvent) => {
    const edge = edgeOf(e);
    focusTop = edge === 'top';
    focusBottom = edge === 'bottom';
    if (edge) { clearHide(); showBoth(); }
  };
  const onFocusOut = () => {
    focusTop = false;
    focusBottom = false;
  };

  container.addEventListener('pointermove', onMove, { passive: true });
  container.addEventListener('pointerleave', onLeave, { passive: true });
  container.addEventListener('pointerdown', onDown, { passive: true });
  window.addEventListener('pointerup', onUp, { passive: true });
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);

  return {
    setPinned(on: boolean) {
      pinned = on;
      if (on) { clearHide(); showBoth(); }
      else onLeave();
    },
    reveal() {
      clearHide();
      showBoth();
      onLeave();
    },
    active: true,
    destroy() {
      clearHide();
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerleave', onLeave);
      container.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      delete root.dataset.chrome;
      delete root.dataset.chromeTop;
      delete root.dataset.chromeBottom;
    },
  };
}

/**
 * Fullscreen — asked of the PARENT, not taken here.
 *
 * ── WHY NOT JUST FULLSCREEN OURSELVES ────────────────────────────────────────
 * Requesting on our own `documentElement` works and is one line: it fullscreens
 * the IFRAME ELEMENT in the host page. It is also wrong, because the agent chat
 * lives in the parent document, OUTSIDE this iframe — so fullscreening the
 * iframe takes the board's collaborator off the screen at exactly the moment the
 * user said they wanted to work. A focus mode you have to leave to ask a
 * question is not a focus mode.
 *
 * So the button asks the parent to fullscreen the whole workspace, which
 * contains both the board and the chat.
 *
 * ── WHY THAT IS ALLOWED, WHICH IS NOT OBVIOUS ────────────────────────────────
 * `requestFullscreen` needs transient user activation, and the click happens in
 * THIS document, not the parent's. It works anyway: an activation notification
 * propagates to every ancestor navigable, so the parent is transiently activated
 * by a click in here. Measured, because it is exactly the kind of thing that
 * sounds true and is not — with a host page and a real click, the parent
 * reported `navigator.userActivation.isActive === true` and its request
 * succeeded.
 *
 * The parent owns the state, because it owns the element that goes fullscreen;
 * it pushes `voidspace:board-focus-state` back so the button can show the way
 * out, including when the user leaves with Escape.
 *
 * ── STANDALONE STILL WORKS ───────────────────────────────────────────────────
 * Served on its own (`vite preview`, a headless probe) there is no parent to
 * ask, and fullscreening this document is then exactly right — there is no chat
 * to lose.
 */
export interface BoardFullscreen {
  toggle(): Promise<void>;
  isOn(): boolean;
  /** Called whenever the state changes, including Escape and F11. */
  onChange(fn: (on: boolean) => void): () => void;
  destroy(): void;
}

/** Ask the parent to fullscreen the workspace; the board is only a passenger. */
export const FOCUS_REQUEST = 'voidspace:board-focus';
/** The parent's answer, and its unsolicited updates when Escape is pressed. */
export const FOCUS_STATE = 'voidspace:board-focus-state';

function hasParent(): boolean {
  try {
    return !!window.parent && window.parent !== window;
  } catch {
    return false;
  }
}

export function installBoardFullscreen(): BoardFullscreen {
  const root = document.documentElement;
  const listeners = new Set<(on: boolean) => void>();
  const embedded = hasParent();

  // Embedded, the element that goes fullscreen is the parent's, so this
  // document is not `document.fullscreenElement` and we must be told instead.
  let parentOn = false;
  const isOn = () => (embedded ? parentOn : !!document.fullscreenElement);

  const sync = () => {
    const on = isOn();
    if (on) root.dataset.boardFullscreen = 'on';
    else delete root.dataset.boardFullscreen;
    for (const fn of [...listeners]) {
      try { fn(on); } catch { /* one bad listener must not stop the rest */ }
    }
  };

  const onState = (e: MessageEvent) => {
    const d = e.data as { type?: string; on?: boolean } | null;
    if (d?.type !== FOCUS_STATE) return;
    parentOn = d.on === true;
    sync();
  };

  document.addEventListener('fullscreenchange', sync);
  if (embedded) window.addEventListener('message', onState);

  return {
    async toggle() {
      if (embedded) {
        // Posted SYNCHRONOUSLY inside the click handler. The parent's transient
        // activation is inherited from this click and it does not last long —
        // awaiting anything first would spend it.
        window.parent.postMessage({ type: FOCUS_REQUEST, on: !isOn() }, '*');
        return;
      }
      try {
        if (isOn()) await document.exitFullscreen();
        else await root.requestFullscreen({ navigationUI: 'hide' });
      } catch {
        // Blocked by permissions policy, or the user dismissed it. Not worth a
        // toast: the button simply did not take, and the board is unchanged.
      }
    },
    isOn,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      document.removeEventListener('fullscreenchange', sync);
      if (embedded) window.removeEventListener('message', onState);
      listeners.clear();
      delete root.dataset.boardFullscreen;
    },
  };
}
