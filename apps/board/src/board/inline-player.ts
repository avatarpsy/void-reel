/**
 * Playing a clip or a track WHERE IT SITS, without ever holding the file.
 *
 * ── THE RULE THIS BENDS, AND EXACTLY HOW FAR ─────────────────────────────────
 * `media-embed.ts` says a card on the canvas is a POSTER TILE, for three good
 * reasons: consistency, cost, and the fact that a 90px card is not where anyone
 * watches a video. All three still hold — and the second one is load-bearing:
 * twenty inline players is twenty media elements negotiating range requests
 * before the user has asked to watch anything, and the canvas judders while they
 * do.
 *
 * Every one of those reasons is about players that exist WITHOUT BEING ASKED
 * FOR. None of them is a reason that pressing play should open a modal.
 *
 * So the rule is sharpened rather than broken:
 *
 *   NOTHING STREAMS UNTIL SOMEBODY PRESSES PLAY, and at most one thing streams
 *   at a time.
 *
 * A board of fifty clips still costs fifty thumbnails. Pressing play on one
 * builds exactly one `<video>`, pointed at the 720p proxy, which streams over
 * range requests like any other web page. Pressing play on a second tears the
 * first one down. Scrolling the playing card off screen tears it down too — a
 * soundtrack playing from somewhere the user cannot see is the single most
 * disorienting thing a canvas can do.
 *
 * The full-screen inspector is still where a reference is JUDGED (it loads the
 * master for stills, and it owns the trim bar). This is for the other question,
 * the one asked far more often and previously answered by a modal: "what is this
 * clip, again?"
 */
import { withToken } from './parent-auth';

interface Live {
  el: HTMLMediaElement;
  host: HTMLElement;
  observer: IntersectionObserver | null;
  /** The card's "I am no longer playing" callback. Held here rather than in the
   *  card because the card is not what tears playback down — see below. */
  onStop?: () => void;
}

/**
 * THE ONE LIVE PLAYER. Module-level, because "at most one" is a property of the
 * BOARD and not of any card — a per-card flag would let two cards each believe
 * they were the only one.
 */
let live: Live | null = null;

/**
 * Tear down whatever is playing. Idempotent.
 *
 * ── AND TELL THE CARD, because it is drawing a PAUSE button ──────────────────
 * Playback is torn down from four directions: the user pressing the control
 * again, the clip ending, the card scrolling off screen, and — the one that
 * makes this necessary — SOMEBODY ELSE pressing play, since at most one thing
 * streams at a time. Only the first of those is something the card can see.
 *
 * Without the callback here, pressing play on a second clip left the first
 * card showing a pause button over silence, and pressing that button "resumed"
 * something that had already been destroyed. One function ends playback, so one
 * function reports it.
 */
export function stopInlinePlayback(): void {
  if (!live) return;
  const { el, observer, onStop } = live;
  live = null;

  observer?.disconnect();
  el.pause();
  // `removeAttribute` + `load()` and not just `pause()`: pausing leaves the
  // connection open and the buffer resident, so a board where the user has
  // sampled a dozen clips would still be holding a dozen streams.
  el.removeAttribute('src');
  el.load();
  el.remove();

  // LAST, and outside the teardown: a card repainting itself must not be able
  // to leave a half-dismantled player behind if it throws.
  onStop?.();
}

/** Is this host the one currently playing? Drives the button's own icon. */
export function isPlayingIn(host: HTMLElement): boolean {
  return !!live && live.host === host;
}

export interface InlinePlayOptions {
  /** The DISPLAY variant — a 720p proxy where one exists. Never the master: a
   *  card is a few hundred pixels and the master is what the render uses. */
  src: string;
  kind: 'video' | 'audio';
  /** Shown behind the transport for audio, which has no picture of its own. */
  poster?: string;
  /** Called when playback ends or is torn down, so the card can repaint. */
  onStop?: () => void;
}

/**
 * Start playing inside `host`, replacing whatever was playing elsewhere.
 *
 * The element is created here rather than rendered by Lit deliberately: the
 * attachment block re-renders on prop changes, and a `<video>` inside a Lit
 * template is destroyed and rebuilt by any of them — which restarts playback
 * from zero for reasons the user cannot see.
 */
export function playInline(host: HTMLElement, opts: InlinePlayOptions): void {
  stopInlinePlayback();

  const el = document.createElement(opts.kind === 'audio' ? 'audio' : 'video');
  el.src = withToken(opts.src);
  el.controls = true;
  el.autoplay = true;
  // MUTED IS WRONG HERE. Autoplay policy allows unmuted playback started by a
  // user gesture, and this always is one — muting a clip somebody pressed play
  // on to hear would be obeying the letter of a rule that does not apply.
  el.setAttribute('playsinline', '');
  // `metadata`, not `auto`: the browser fetches the header, then streams what it
  // needs. `auto` would pull the whole file for a five-second look.
  el.preload = 'metadata';
  Object.assign(el.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: opts.kind === 'audio' ? 'auto' : '100%',
    ...(opts.kind === 'audio' ? { top: 'auto', bottom: '0' } : {}),
    objectFit: 'contain',
    background: '#000',
    borderRadius: '6px',
    // The card itself is pointer-transparent so the canvas can drag the block.
    // The transport must not be, or the controls are decorative.
    pointerEvents: 'auto',
    zIndex: '2',
  } as Partial<CSSStyleDeclaration>);

  /**
   * ONE PATH OUT. `stopInlinePlayback` is what calls `onStop`, so this must not
   * call it as well — a clip that simply ended would otherwise report stopping
   * twice, and a card that toggles state on each report would end up showing a
   * pause button over nothing.
   *
   * The `else` covers the element having already been replaced by a later
   * `playInline`: this one is dead, its card still believes it is playing, and
   * nothing else is going to tell it.
   */
  const finish = () => {
    if (live?.el === el) stopInlinePlayback();
    else opts.onStop?.();
  };
  el.addEventListener('ended', finish, { once: true });
  // A dead library link is common enough that silence reads as a broken player.
  el.addEventListener('error', finish, { once: true });

  host.append(el);

  /**
   * OFF SCREEN MEANS OFF.
   *
   * The canvas culls by visibility but does not unmount, so a card panned out of
   * view keeps its DOM — and therefore would keep playing, audibly, from
   * somewhere the user cannot find. The observer is on the HOST rather than the
   * media element because the media element is what we are about to remove.
   */
  let observer: IntersectionObserver | null = null;
  try {
    observer = new IntersectionObserver(entries => {
      if (entries.some(e => !e.isIntersecting)) finish();
    }, { threshold: 0 });
    observer.observe(host);
  } catch {
    // No IntersectionObserver (older embedded webview). Playback still works;
    // it just does not auto-stop, which is the lesser failure.
  }

  live = { el, host, observer, onStop: opts.onStop };
  void el.play().catch(() => {
    // Blocked or unplayable — leave the transport up so the user can try, rather
    // than tearing the card back to a poster and looking like nothing happened.
  });
}
