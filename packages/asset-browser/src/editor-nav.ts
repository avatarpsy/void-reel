/**
 * editor-nav — how every editor leaves itself.
 *
 * ## Why this is here and not in each app
 *
 * Three editors, three different answers to the same click. The video editor's
 * toolbar assigned `window.top.location = '/studio/projects?tab=…'`. The image
 * editor had `services/navigate-top.ts`, which escaped the frame correctly but
 * still went to a fixed destination. The board's asset panel used a plain
 * `<a target="_top" href="/studio/projects?tab=boards">`. And the video editor's
 * WELCOME screen had the only good implementation — referrer-aware
 * `history.back()` — which none of the other four call sites could reach.
 *
 * So "Back" meant "the projects list" everywhere except one screen, and anyone
 * who arrived from the agent chat, a board, or a deep link was thrown out to a
 * list they were never on and had to navigate back from.
 *
 * It lives in @openreel/asset-browser for exactly the reason `panel-chrome`
 * does: that package is the only one all three apps depend on, and the board
 * needs this without React. Neither module is asset-specific.
 *
 * ## Two hard parts
 *
 * **The frame.** The editors run inside an iframe on /ai (editor left, agent
 * right). A plain link navigates the IFRAME, so "Back to Projects" rendered the
 * whole projects hub inside the left pane with the chat still beside it — a
 * page inside a page. Navigation has to address `window.top`.
 *
 * **The history.** Inside a frame, `history.back()` walks the IFRAME's history,
 * which is the editor's own view changes — pressing Back would step through the
 * editor rather than leave it. The top window is the one holding "where the
 * user came from", so that is the history to walk.
 */

/** True when we are running inside a frame we can actually reach. */
function embeddedTop(): Window | null {
  try {
    if (window.top && window.top !== window) {
      // Touch a property to prove it is same-origin; a cross-origin ancestor
      // throws here and we treat ourselves as standalone.
      void window.top.location.href;
      return window.top;
    }
  } catch {
    /* cross-origin ancestor — unreachable, behave as standalone */
  }
  return null;
}

/**
 * Navigate the TOP window, not this frame.
 *
 * `target="_top"` on an anchor does this too, but only for a plain click — this
 * is for handlers that must run other logic first (save, confirm, analytics).
 */
export function navigateTop(url: string): void {
  const top = embeddedTop();
  if (top) {
    top.location.href = url;
    return;
  }
  window.location.href = url;
}

/**
 * Is there a real previous page to go back to?
 *
 * `document.referrer` rather than `history.length`: length counts the whole tab
 * session including entries from before this document, so it over-reports on a
 * fresh tab and Back would do nothing. A SAME-ORIGIN referrer means we arrived
 * by a link from our own app, which is precisely when going back is meaningful
 * — and it also refuses to bounce the user out to another site.
 */
function canGoBack(w: Window): boolean {
  try {
    const ref = w.document.referrer;
    if (!ref) return false;
    if (new URL(ref).origin !== w.location.origin) return false;
    return w.history.length > 1;
  } catch {
    return false;
  }
}

/**
 * BACK MEANS WHERE YOU CAME FROM.
 *
 * Walks the top window's history when there is somewhere to go, and falls back
 * to `fallbackUrl` (the relevant projects tab) when there is not — a bookmark
 * opened cold, or a fresh tab.
 *
 * @param fallbackUrl where to land when there is no previous page.
 */
export function goBack(fallbackUrl: string): void {
  const target = embeddedTop() ?? window;
  if (canGoBack(target)) {
    target.history.back();
    return;
  }
  navigateTop(fallbackUrl);
}

/**
 * The projects tab that matches what is being edited, for use as the fallback.
 * One spelling of these query values, so the four call sites cannot disagree
 * about whether the music tab is `music`, `songs` or `audio`.
 */
export function projectsUrl(tab: 'videos' | 'music' | 'boards' | 'images'): string {
  return `/studio/projects?tab=${tab}`;
}

/**
 * The shape both handlers below need from a click.
 *
 * Typed structurally rather than against React's MouseEvent so the board, which
 * has no React, can use the same functions.
 *
 * Both are kept on REAL anchors rather than buttons so middle-click and
 * open-in-new-tab still work: those never fire a plain click, so the browser
 * uses the href as written.
 */
export interface ModifiedClick {
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  button: number;
  preventDefault(): void;
}

/**
 * Click handler for a REAL `<a>` that must escape the frame to a FIXED
 * destination — "My projects", a help page, anything that is not "back".
 *
 * Distinct from `onBackLinkClick`, which walks history instead. Using the back
 * handler for a fixed destination is a real bug: it sends the user wherever
 * they came from and only reaches the href when there is no history, so the
 * link does something different depending on how they arrived.
 */
export function onTopLinkClick(url: string) {
  return (e: ModifiedClick): void => {
    if (e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigateTop(url);
  };
}

/**
 * Click handler for a REAL `<a>` whose destination is WHERE YOU CAME FROM.
 *
 * The href stays the fallback (the relevant projects tab), which is what a
 * new-tab click lands on — the only sensible thing "open Back in a new tab"
 * can mean.
 */
export function onBackLinkClick(fallbackUrl: string) {
  return (e: ModifiedClick): void => {
    if (e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    goBack(fallbackUrl);
  };
}
