/**
 * Navigate the TOP window, not this frame.
 *
 * The editor runs inside an iframe on `/ai/image` (editor left, agent
 * right). A plain link there navigates the IFRAME, so "My Projects" would render
 * the whole projects hub in the left pane with the chat still sitting beside it —
 * a page inside a page. The video editor's toolbar already handles this by
 * assigning `window.top.location`; this is the same behaviour, shared so both
 * call sites in this app stay in step.
 *
 * `target="_top"` on the anchor would also work, but only for a click — this is
 * used by handlers that also need to run other logic first.
 */
export function navigateTop(url: string): void {
  try {
    if (window.top && window.top !== window) {
      window.top.location.href = url;
      return;
    }
  } catch {
    // Cross-origin ancestor — cannot reach top; fall through and navigate self.
  }
  window.location.href = url;
}

/**
 * Click handler for an `<a>` that must escape the frame.
 *
 * Kept as a handler on a REAL anchor (rather than a button) so middle-click and
 * open-in-new-tab still work: those never fire a plain click, so the browser's
 * own behaviour takes over and the href is used as-is.
 */
export function onTopLinkClick(url: string) {
  return (e: React.MouseEvent<HTMLAnchorElement>) => {
    // Let the browser handle modified clicks (new tab / new window / download).
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (window.top && window.top !== window) {
      e.preventDefault();
      navigateTop(url);
    }
  };
}
